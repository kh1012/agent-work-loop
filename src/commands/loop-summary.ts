import {
  type Caps,
  type Colors,
  caps,
  makeColors,
  padEndDisplay,
  sectionBox,
} from '../core/tty.js';
import { type CostSnapshot, computeCostDelta, readCostSnapshot } from '../core/usage.js';
import { requireConfig } from './config.js';
import { type Generation, computeDurationMs, fmtDuration, loadGenerations } from './metrics.js';
import { collectDeferred, readRecords } from './record.js';
import { loadState } from './state.js';

/**
 * awl loop-summary — 루프/파이프라인 배치 완료 요약을 4렌즈로 낸다(loop-completion-stats).
 *
 * "얼마나 무인으로·잘·싸게 됐고 뭘 남겼나"를 한눈에(북극성 ②). 지표는 전부 이 워크아이템의
 * 기존 record/state 필드에서 산출한다 — 없는 필드로 지표를 만들지 않는다(발명 금지). 헤드라인은
 * 개입 지표다: "던지고 판단만"이 실제 몇 번의 사람 판단으로 돌았는지 제일 먼저 보게 한다.
 *
 * metrics.ts(세대 스냅샷=워크아이템 간 추세)와 다르다 — 이건 한 루프의 완료 스냅샷이라
 * raw record 를 읽는다. 공용 로더(readRecords)·defer 파서(collectDeferred)·소요 계산
 * (computeDurationMs)·소요 포맷(fmtDuration)은 재사용한다.
 */

type Rec = Record<string, unknown>;

/** ① 개입(헤드라인) — 사람 판단이 몇 번 끼었나 vs 자율로 몇 번 넘어갔나. */
export interface InterventionLens {
  /** gate auto:true. */
  autonomous: number;
  /** 사람 개입 = auto 가 명시적 true 가 아닌 gate + defer(표면화). */
  humanInterventions: number;
  /** 그중 gate 몫(auto:false 또는 auto 부재). */
  humanGateCount: number;
  /** 그중 defer 몫(사람에게 최종 문의로 표면화). */
  deferCount: number;
  /** 무인율(%) = 자율 / (자율+사람 개입). 판단 지점이 하나도 없으면 undefined. */
  unmannedRate: number | undefined;
}

/** ② 품질 — 반려·막힘·재시도·실패원인. */
export interface QualityLens {
  reviewCount: number;
  /** findings 가 비어있지 않은 리뷰(실제 반려). */
  reviewRejects: number;
  blocked: number;
  avgAttempts: number;
  /** 구현 실패(재시도) = criteria.attempts 합. */
  implementationFailures: number;
  /** 절차 실수 = criteria.proceduralErrors 합. (환경 실패는 미기록이라 생략) */
  proceduralErrors: number;
}

/** ③ 효율 — 소요시간·비용 델타. */
export interface EfficiencyLens {
  /** gate1~마지막 record 간격(ms). 못 재면 undefined. */
  durationMs: number | undefined;
  /** 루프 경계 cost 차이($). 소스 부재면 undefined(생략). */
  costDelta: number | undefined;
}

/** ④ 산출/학습 — 완료·커밋·gotcha·범위 드리프트. */
export interface OutputLens {
  passedCriteria: number;
  totalCriteria: number;
  /** distinct criteria.commit 해시 수(= 격리커밋된 AC 수). 한 AC 를 여러 번 커밋하면 최신 1개만 센다 — raw git 커밋 수가 아니다. */
  commits: number;
  gotchaApplied: number;
  gotchaMissed: number;
  /** gate1 presentedExclusions 수(중도 배제 = 범위 드리프트). */
  exclusions: number;
}

export interface LoopSummary {
  workitem: string | null;
  /** record 가 하나라도 있나. 없으면 0-통계로 오도하지 않고 안내만 한다(AC-04). */
  hasRecords: boolean;
  intervention: InterventionLens;
  quality: QualityLens;
  efficiency: EfficiencyLens;
  output: OutputLens;
}

/** gate record 의 auto 를 boolean 으로만 읽는다(status.ts buildGateStatus 와 같은 규약). */
function gateAuto(rec: Rec): boolean | undefined {
  return typeof rec.auto === 'boolean' ? rec.auto : undefined;
}

/**
 * ① 개입(순수). 자율=gate auto:true. 사람 개입=auto 가 명시적 true 가 아닌 gate + defer 수.
 * auto 가 부재/false 면 자율로 세지 않는다 — 모르는 걸 자율로 쳐 무인율을 부풀리지 않는다.
 */
export function computeInterventionLens(records: Rec[]): InterventionLens {
  const gates = records.filter((r) => r.type === 'gate');
  const autonomous = gates.filter((r) => gateAuto(r) === true).length;
  const humanGateCount = gates.length - autonomous;
  const deferCount = collectDeferred(records).length;
  const humanInterventions = humanGateCount + deferCount;
  const total = autonomous + humanInterventions;
  const unmannedRate = total > 0 ? Math.round((autonomous / total) * 100) : undefined;
  return { autonomous, humanInterventions, humanGateCount, deferCount, unmannedRate };
}

/**
 * ② 품질(순수). 반려=findings 비어있지 않은 리뷰. 구현 실패=criteria.attempts 합,
 * 절차 실수=criteria.proceduralErrors 합. attempt record 에 cause 가 없어 환경 실패는 못 센다(생략).
 */
export function computeQualityLens(records: Rec[], criteria: Rec[]): QualityLens {
  const reviews = records.filter((r) => r.type === 'review');
  const reviewRejects = reviews.filter(
    (r) => Array.isArray(r.findings) && (r.findings as unknown[]).length > 0,
  ).length;
  const blocked = records.filter((r) => r.type === 'blocked').length;
  const num = (v: unknown): number => (typeof v === 'number' ? v : 0);
  const total = criteria.length;
  const implementationFailures = criteria.reduce((s, c) => s + num(c.attempts), 0);
  const proceduralErrors = criteria.reduce((s, c) => s + num(c.proceduralErrors), 0);
  const avgAttempts = total > 0 ? Math.round((implementationFailures / total) * 100) / 100 : 0;
  return {
    reviewCount: reviews.length,
    reviewRejects,
    blocked,
    avgAttempts,
    implementationFailures,
    proceduralErrors,
  };
}

/**
 * ③ 효율(순수). 소요=gate1 at(없으면 최이른 record)~최근 record 간격. costDelta 는 주입받는다
 * (루프 경계 스냅샷은 부작용이라 호출부가 읽어 넘긴다). 못 재는 값은 undefined 로 남겨 생략한다.
 */
export function computeEfficiencyLens(
  records: Rec[],
  costDelta: number | undefined,
): EfficiencyLens {
  const ats = records
    .map((r) => (typeof r.at === 'string' ? r.at : ''))
    .filter((s) => s !== '')
    .sort();
  const gate1 = records.find((r) => r.type === 'gate' && r.gate === 1);
  const start = gate1 && typeof gate1.at === 'string' ? gate1.at : ats[0];
  const end = ats.length > 0 ? ats[ats.length - 1] : undefined;
  const durationMs =
    start !== undefined && end !== undefined ? computeDurationMs(start, end) : undefined;
  return { durationMs, costDelta };
}

/**
 * ④ 산출/학습(순수). 완료 AC/전체, distinct 커밋 해시, gotcha 적용/누락, gate1 배제 수(범위 드리프트).
 */
export function computeOutputLens(records: Rec[], criteria: Rec[]): OutputLens {
  const passedCriteria = criteria.filter((c) => c.status === 'passed').length;
  const commitHashes = new Set(
    criteria.map((c) => c.commit).filter((h): h is string => typeof h === 'string' && h.length > 0),
  );
  const gotchaApplied = records.filter((r) => r.type === 'gotcha-applied').length;
  const gotchaMissed = records.filter((r) => r.type === 'gotcha-missed').length;
  const gate1 = records.find((r) => r.type === 'gate' && r.gate === 1);
  const exclusions =
    gate1 && Array.isArray(gate1.presentedExclusions)
      ? (gate1.presentedExclusions as unknown[]).length
      : 0;
  return {
    passedCriteria,
    totalCriteria: criteria.length,
    commits: commitHashes.size,
    gotchaApplied,
    gotchaMissed,
    exclusions,
  };
}

/** 4렌즈를 조립한다(순수). costDelta 는 호출부가 스냅샷을 읽어 넘긴다. */
export function assembleLoopSummary(
  workitem: string | null,
  records: Rec[],
  criteria: Rec[],
  costDelta: number | undefined,
): LoopSummary {
  return {
    workitem,
    hasRecords: records.length > 0,
    intervention: computeInterventionLens(records),
    quality: computeQualityLens(records, criteria),
    efficiency: computeEfficiencyLens(records, costDelta),
    output: computeOutputLens(records, criteria),
  };
}

const LABEL_WIDTH = 7;

/**
 * 요약을 사람용 텍스트 줄로 만든다(순수, 색 없음). 첫 줄이 개입 헤드라인이다(AC-02).
 * record 가 없으면 안내만 낸다 — 0-통계 렌즈를 내지 않는다(AC-04).
 */
export function buildSummaryLines(summary: LoopSummary): string[] {
  if (!summary.hasRecords) {
    return ['기록 없음 — record-trail-guard 참조', '빈 0 통계로 오도하지 않습니다.'];
  }
  const iv = summary.intervention;
  const rate = iv.unmannedRate !== undefined ? ` (무인율 ${iv.unmannedRate}%)` : '';
  const lines: string[] = [`사람 개입 ${iv.humanInterventions} · 자율 ${iv.autonomous}${rate}`];
  lines.push(`  게이트 자율 ${iv.autonomous} · 사람 ${iv.humanGateCount} · defer ${iv.deferCount}`);
  lines.push('');

  const q = summary.quality;
  lines.push(
    `${padEndDisplay('품질', LABEL_WIDTH)}리뷰 ${q.reviewCount}(반려 ${q.reviewRejects}) · blocked ${q.blocked} · 평균시도/AC ${q.avgAttempts}`,
  );
  lines.push(
    `${padEndDisplay('', LABEL_WIDTH)}실패 원인  구현 ${q.implementationFailures} · 절차 ${q.proceduralErrors} (환경 미기록)`,
  );

  const e = summary.efficiency;
  const eff: string[] = [];
  if (e.durationMs !== undefined) {
    eff.push(`소요 ${fmtDuration(e.durationMs)}`);
  }
  if (e.costDelta !== undefined) {
    eff.push(`비용 ~$${e.costDelta}`);
  }
  lines.push(
    `${padEndDisplay('효율', LABEL_WIDTH)}${eff.length > 0 ? eff.join(' · ') : '시간·비용 소스 부재로 생략'}`,
  );

  const o = summary.output;
  lines.push(
    `${padEndDisplay('산출', LABEL_WIDTH)}완료 AC ${o.passedCriteria}/${o.totalCriteria} · 격리커밋 ${o.commits} · gotcha 적용 ${o.gotchaApplied}/누락 ${o.gotchaMissed} · 범위배제 ${o.exclusions}`,
  );
  return lines;
}

/** 사람용 카드 렌더. 헤드라인은 굵게, 개입 세부는 흐리게. */
export function renderLoopSummary(summary: LoopSummary, c: Caps): string {
  const color: Colors = makeColors(c.color);
  const lines = buildSummaryLines(summary);
  const styled = lines.map((ln, i) => {
    if (i === 0) {
      return color.bold(ln);
    }
    if (ln.startsWith('  ')) {
      return color.dim(ln);
    }
    return ln;
  });
  const title = summary.workitem ? `작업 완료 요약 · ${summary.workitem}` : '작업 완료 요약';
  return sectionBox(title, styled, c);
}

/** JSON 출력. record 가 없으면 0-렌즈를 싣지 않고 안내만 낸다(AC-04). */
export function summaryToJson(summary: LoopSummary): Record<string, unknown> {
  if (!summary.hasRecords) {
    return {
      workitem: summary.workitem,
      hasRecords: false,
      note: '기록 없음 — record-trail-guard 참조',
    };
  }
  return summary as unknown as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// 배치 모드 (pipeline-cycle-summary) — 사이클 하나에 완료된 여러 워크아이템을
// 묶어 항목별 + 전체집계로 낸다. 엔진은 workitem별 4렌즈 계산과 그 집계만 한다
// (F-03) — 에이전트 수·사이클 wall-clock 은 오케스트레이터 스킬 몫이라 여기서
// 만들지 않는다. aggregateLoopSummaries 의 durationMs/costDelta 는 "있는 값만
// 평균"이지 wall-clock 이 아니다(F-05) — 오케스트레이터가 실측한 값과 절대
// 섞지 않는다.
// ---------------------------------------------------------------------------

/** 여러 LoopSummary 를 하나로 묶은 결과(AC-02). LoopSummary 와 같은 4렌즈 모양을 유지한다. */
export interface AggregateLoopSummary {
  /** 집계에 들어간 LoopSummary 개수(= 그 사이클의 루프 수). */
  count: number;
  intervention: {
    autonomous: number;
    humanInterventions: number;
    humanGateCount: number;
    deferCount: number;
    /** 비율계 = 평균(있는 값만). 판단 지점이 하나도 없던 워크아이템은 평균에서 뺀다. */
    unmannedRate: number | undefined;
  };
  quality: {
    reviewCount: number;
    reviewRejects: number;
    blocked: number;
    /** 비율계 = 평균 (metrics.ts:172 groupByExperiment 의 avgAttempts 와 동일 패턴). */
    avgAttempts: number;
    implementationFailures: number;
    proceduralErrors: number;
  };
  efficiency: {
    /** 시간/비용 = 있는 값만 평균(F-02). 오케스트레이터의 wall-clock 이 아니다(F-05, 참고용). */
    durationMs: number | undefined;
    costDelta: number | undefined;
  };
  output: {
    passedCriteria: number;
    totalCriteria: number;
    commits: number;
    gotchaApplied: number;
    gotchaMissed: number;
    exclusions: number;
  };
}

const round2 = (n: number): number => Math.round(n * 100) / 100;
const round0 = (n: number): number => Math.round(n);

/**
 * 있는 값만 평균(순수). 하나도 없으면 undefined — metrics.ts:172 groupByExperiment 의
 * avgDurationMs(durs.length>0 조건부 평균)와 같은 규약. round 는 필드별 정밀도(정수/소수2)를 고른다.
 */
function avgDefined(
  values: (number | undefined)[],
  round: (n: number) => number,
): number | undefined {
  const defined = values.filter((v): v is number => typeof v === 'number');
  return defined.length > 0
    ? round(defined.reduce((s, v) => s + v, 0) / defined.length)
    : undefined;
}

/**
 * 여러 LoopSummary 를 F-02 규약대로 묶는다(순수) — metrics.ts:172 groupByExperiment 와 동일 패턴:
 * 비율계(무인율·평균시도/AC)=평균, 카운트계(완료AC·격리커밋·gotcha·범위배제 등)=합,
 * 시간/비용(durationMs/costDelta)=있는 값만 평균. 빈 배열이면 전부 0/undefined.
 */
export function aggregateLoopSummaries(summaries: LoopSummary[]): AggregateLoopSummary {
  const n = summaries.length;
  const sum = (f: (s: LoopSummary) => number): number => summaries.reduce((s, x) => s + f(x), 0);
  const avg = (f: (s: LoopSummary) => number): number => (n > 0 ? round2(sum(f) / n) : 0);

  return {
    count: n,
    intervention: {
      autonomous: sum((s) => s.intervention.autonomous),
      humanInterventions: sum((s) => s.intervention.humanInterventions),
      humanGateCount: sum((s) => s.intervention.humanGateCount),
      deferCount: sum((s) => s.intervention.deferCount),
      unmannedRate: avgDefined(
        summaries.map((s) => s.intervention.unmannedRate),
        round0,
      ),
    },
    quality: {
      reviewCount: sum((s) => s.quality.reviewCount),
      reviewRejects: sum((s) => s.quality.reviewRejects),
      blocked: sum((s) => s.quality.blocked),
      avgAttempts: avg((s) => s.quality.avgAttempts),
      implementationFailures: sum((s) => s.quality.implementationFailures),
      proceduralErrors: sum((s) => s.quality.proceduralErrors),
    },
    efficiency: {
      durationMs: avgDefined(
        summaries.map((s) => s.efficiency.durationMs),
        round0,
      ),
      costDelta: avgDefined(
        summaries.map((s) => s.efficiency.costDelta),
        round2,
      ),
    },
    output: {
      passedCriteria: sum((s) => s.output.passedCriteria),
      totalCriteria: sum((s) => s.output.totalCriteria),
      commits: sum((s) => s.output.commits),
      gotchaApplied: sum((s) => s.output.gotchaApplied),
      gotchaMissed: sum((s) => s.output.gotchaMissed),
      exclusions: sum((s) => s.output.exclusions),
    },
  };
}

/** 집계를 사람용 텍스트 줄로 만든다(순수, buildSummaryLines 와 같은 모양·라벨 폭). */
export function buildAggregateLines(agg: AggregateLoopSummary): string[] {
  const iv = agg.intervention;
  const rate = iv.unmannedRate !== undefined ? ` (무인율 평균 ${iv.unmannedRate}%)` : '';
  const lines: string[] = [
    `사람 개입 합 ${iv.humanInterventions} · 자율 합 ${iv.autonomous}${rate}`,
  ];
  lines.push(`  게이트 자율 ${iv.autonomous} · 사람 ${iv.humanGateCount} · defer ${iv.deferCount}`);
  lines.push('');

  const q = agg.quality;
  lines.push(
    `${padEndDisplay('품질', LABEL_WIDTH)}리뷰 ${q.reviewCount}(반려 ${q.reviewRejects}) · blocked ${q.blocked} · 평균시도/AC 평균 ${q.avgAttempts}`,
  );
  lines.push(
    `${padEndDisplay('', LABEL_WIDTH)}실패 원인 합  구현 ${q.implementationFailures} · 절차 ${q.proceduralErrors}`,
  );

  const e = agg.efficiency;
  const eff: string[] = [];
  if (e.durationMs !== undefined) {
    eff.push(`소요 평균 ${fmtDuration(e.durationMs)}`);
  }
  if (e.costDelta !== undefined) {
    eff.push(`비용 평균 ~$${e.costDelta}`);
  }
  lines.push(
    `${padEndDisplay('효율', LABEL_WIDTH)}${eff.length > 0 ? eff.join(' · ') : '시간·비용 소스 부재로 생략'} (참고용 — wall-clock 아님)`,
  );

  const o = agg.output;
  lines.push(
    `${padEndDisplay('산출', LABEL_WIDTH)}완료 AC 합 ${o.passedCriteria}/${o.totalCriteria} · 격리커밋 합 ${o.commits} · gotcha 적용 합 ${o.gotchaApplied}/누락 합 ${o.gotchaMissed} · 범위배제 합 ${o.exclusions}`,
  );
  return lines;
}

/** 집계 카드 렌더(사람용). renderLoopSummary 와 같은 스타일(첫 줄 굵게, 들여쓴 줄 흐리게). */
export function renderAggregateLoopSummary(agg: AggregateLoopSummary, c: Caps): string {
  const color: Colors = makeColors(c.color);
  const lines = buildAggregateLines(agg);
  const styled = lines.map((ln, i) => {
    if (i === 0) {
      return color.bold(ln);
    }
    if (ln.startsWith('  ')) {
      return color.dim(ln);
    }
    return ln;
  });
  return sectionBox(`전체 집계 · 워크아이템 ${agg.count}개`, styled, c);
}

/**
 * 배치 대상 workitem id 목록을 정한다(순수, AC-01). 명시 목록(--workitems)이 우선,
 * 없으면 --since(그 시각 이후 완료). 완료 시각은 evolve.ts:441 writeGeneration 이
 * 쓰는 세대 스냅샷의 at 을 재사용한다(F-04) — 새 완료-시각 소스를 발명하지 않는다.
 * generations 는 loadGenerations(project) 로 이미 시간순 정렬돼 들어온다.
 */
export function resolveBatchWorkitems(
  opts: { workitems?: string[]; since?: string },
  generations: Generation[],
): string[] {
  if (opts.workitems && opts.workitems.length > 0) {
    return opts.workitems;
  }
  if (opts.since !== undefined) {
    const sinceMs = Date.parse(opts.since);
    if (Number.isNaN(sinceMs)) {
      return [];
    }
    return generations
      .filter((g) => {
        const t = Date.parse(g.at);
        return !Number.isNaN(t) && t >= sinceMs;
      })
      .map((g) => g.workitem);
  }
  return [];
}

/** state.criteria(현재 워크아이템) 또는 레지스트리 엔트리에서 완료조건을 읽는다. */
function criteriaFor(state: Rec, workitem: string | null, current: string | null): Rec[] {
  if (workitem !== null && workitem === current && Array.isArray(state.criteria)) {
    return state.criteria as Rec[];
  }
  const reg =
    state.workitems && typeof state.workitems === 'object' && !Array.isArray(state.workitems)
      ? (state.workitems as Record<string, Rec>)
      : {};
  const entry = workitem !== null ? reg[workitem] : undefined;
  if (entry && Array.isArray(entry.criteria)) {
    return entry.criteria as Rec[];
  }
  return [];
}

/** 현재 워크아이템의 루프시작 cost 스냅샷(work new 가 남긴 state.costAtStart). */
function startCostOf(
  state: Rec,
  workitem: string | null,
  current: string | null,
): CostSnapshot | undefined {
  if (workitem === null || workitem !== current) {
    return undefined; // 과거 워크아이템의 costAtStart 는 state 에 없다 — 비용 생략(graceful).
  }
  const c = state.costAtStart;
  return c && typeof c === 'object' && !Array.isArray(c) ? (c as CostSnapshot) : undefined;
}

/**
 * 배치 모드(AC-01/AC-03): ids 각각을 assembleLoopSummary 로 개별 요약하고, 전체를
 * aggregateLoopSummaries(AC-02)로 묶는다. 항목별 요약은 단일모드와 같은 criteriaFor/
 * startCostOf 규약을 그대로 쓴다 — 배치라고 다른 규약을 새로 만들지 않는다.
 */
function buildBatchSummaries(
  ids: string[],
  state: Rec,
  current: string | null,
  usagePath: string | undefined,
): LoopSummary[] {
  const nowSnapshot = readCostSnapshot(usagePath);
  return ids.map((id) => {
    const records = readRecords({ workitem: id });
    const criteria = criteriaFor(state, id, current);
    const costDelta = computeCostDelta(startCostOf(state, id, current), nowSnapshot);
    return assembleLoopSummary(id, records, criteria, costDelta);
  });
}

/** awl loop-summary --workitems <id1,id2,...> | --since <ISO> [--json] (AC-01/03) */
function runLoopSummaryBatch(opts: {
  workitems?: string[];
  since?: string;
  json?: boolean;
  usagePath?: string;
}): void {
  const { config, projectRoot } = requireConfig();
  const state = loadState(projectRoot);
  const current = typeof state.workitem === 'string' ? state.workitem : null;
  // --since 만 있을 때만 세대 스냅샷을 읽는다 — --workitems 명시 목록이면 불필요한 I/O.
  const generations = opts.since !== undefined ? loadGenerations(config.project) : [];
  const ids = resolveBatchWorkitems({ workitems: opts.workitems, since: opts.since }, generations);

  const summaries = buildBatchSummaries(ids, state, current, opts.usagePath);
  const aggregate = aggregateLoopSummaries(summaries);

  if (opts.json) {
    process.stdout.write(
      `${JSON.stringify({ summaries: summaries.map(summaryToJson), aggregate }, null, 2)}\n`,
    );
    return;
  }
  if (summaries.length === 0) {
    process.stdout.write(
      '배치 대상 워크아이템이 없습니다 — --workitems 또는 --since 를 확인하세요.\n',
    );
    return;
  }
  const c = caps();
  const blocks = summaries.map((s) => renderLoopSummary(s, c)).join('\n');
  process.stdout.write(`${blocks}\n${renderAggregateLoopSummary(aggregate, c)}\n`);
}

/** awl loop-summary [--workitem <id>] [--json] (단일모드, AC-05 불변) | --workitems/--since (배치모드, AC-01) */
export function runLoopSummary(opts: {
  workitem?: string;
  workitems?: string[];
  since?: string;
  json?: boolean;
  usagePath?: string;
}): void {
  // 배치모드 분기 — --workitems(비지 않은 목록) 또는 --since 가 있으면 배치, 없으면 기존 단일모드.
  // 기존 단일모드 코드 경로는 이 분기 아래 한 글자도 안 바뀐다(AC-05).
  if ((opts.workitems && opts.workitems.length > 0) || opts.since !== undefined) {
    runLoopSummaryBatch(opts);
    return;
  }

  const { projectRoot } = requireConfig();
  const state = loadState(projectRoot);
  const current = typeof state.workitem === 'string' ? state.workitem : null;
  const workitem = opts.workitem ?? current;
  const records = workitem ? readRecords({ workitem }) : [];
  const criteria = criteriaFor(state, workitem, current);
  // usagePath 미주입이면 readCostSnapshot 기본값(DEFAULT_USAGE_PATH) — 프로덕션 동작 불변.
  // 주입은 테스트 전용(now 스냅샷을 고정해 write→read cost 계약을 hermetic 하게 잠근다).
  const costDelta = computeCostDelta(
    startCostOf(state, workitem, current),
    readCostSnapshot(opts.usagePath),
  );
  const summary = assembleLoopSummary(workitem, records, criteria, costDelta);
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(summaryToJson(summary), null, 2)}\n`);
    return;
  }
  process.stdout.write(`${renderLoopSummary(summary, caps())}\n`);
}
