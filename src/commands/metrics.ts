import fs from 'node:fs';
import path from 'node:path';
import { generationsDir } from '../core/paths.js';
import {
  type Caps,
  caps,
  makeColors,
  padEndDisplay,
  sectionBox,
  stringWidth,
} from '../core/tty.js';
import { requireConfig } from './config.js';

/**
 * awl metrics — 세대(워크아이템)별 프록시 지표 추세를 보여준다.
 *
 * awl 은 LLM 토큰을 측정할 수 없다. 시도 횟수/막힘 비율/리뷰 지적 수/절차 실수/
 * gotcha 적용·누락 같은 프록시 지표만 센다(evolve.ts 가 워크아이템을 닫을 때마다
 * 이미 ~/.awl/generations/<project>/<WI>.json 에 쌓아둔 것을 그대로 읽는다).
 */

export interface CoverageSnapshot {
  auditFindingsTotal: number;
  addressed: number;
  excluded: number;
  excludedApprovedByHuman: boolean;
}

export interface Generation {
  workitem: string;
  at: string;
  criteriaTotal: number;
  avgAttempts: number;
  blockedRatio: number;
  reviewRejects: number;
  proceduralErrors: number;
  gotchaApplied: number;
  gotchaMissed: number;
  /** 이 워크아이템 리팩토링 기록 수(loop-refactor-checkpoint). 없는 옛 스냅샷은 0. */
  refactorCount: number;
  coverage: CoverageSnapshot;
  /** 실험 케이스 메타(model/mode/taskType). 없으면 undefined(하위호환, experiment-harness). */
  experiment?: Record<string, unknown>;
  /** 던지기 시각(workitemCreatedAt). 없으면 undefined(옛 스냅샷). */
  startedAt?: string;
  /** 던지기~완료 소요 ms. 없으면 undefined. */
  durationMs?: number;
}

/**
 * 던지기(startedAt)~완료(closeAt) 소요 ms 를 잰다(순수, experiment-harness AC-03).
 * 어느 쪽이든 파싱 불가거나 음수(시계 역전)면 undefined — 신뢰 못 하는 값을 만들지 않는다.
 */
export function computeDurationMs(startedAt: unknown, closeAt: unknown): number | undefined {
  const s = Date.parse(String(startedAt));
  const e = Date.parse(String(closeAt));
  if (Number.isNaN(s) || Number.isNaN(e)) {
    return undefined;
  }
  const d = e - s;
  return d >= 0 ? d : undefined;
}

/** 워크아이템마다 난이도가 다르다는 경고 — 사람용/JSON 양쪽에 항상 포함한다. */
export function renderMetricsCaveat(): string {
  return '워크아이템마다 난이도가 다릅니다 — 세대 간 절대 비교보다는 경향(추세)만 참고하세요.';
}

/** coverage 가 없는 옛 스냅샷(WI-T 이전)도 0/false 로 채워 하위호환한다. */
function readCoverage(raw: unknown): CoverageSnapshot {
  const c = (raw ?? {}) as Record<string, unknown>;
  const num = (v: unknown): number => (typeof v === 'number' ? v : 0);
  return {
    auditFindingsTotal: num(c.auditFindingsTotal),
    addressed: num(c.addressed),
    excluded: num(c.excluded),
    excludedApprovedByHuman: c.excludedApprovedByHuman === true,
  };
}

/**
 * 프로젝트의 세대 스냅샷을 전부 읽어 시간순(at)으로 정렬한다.
 * gotchaApplied/gotchaMissed 가 없는 옛 스냅샷(WI-P 이전)도 0으로 채워 하위호환한다.
 */
export function loadGenerations(project: string): Generation[] {
  const dir = generationsDir(project);
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const num = (v: unknown): number => (typeof v === 'number' ? v : 0);
  const generations: Generation[] = [];
  for (const f of files) {
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as Record<string, unknown>;
    } catch {
      continue; // 깨진 파일은 건너뛴다.
    }
    generations.push({
      workitem: typeof raw.workitem === 'string' ? raw.workitem : f.replace(/\.json$/, ''),
      at: typeof raw.at === 'string' ? raw.at : '',
      criteriaTotal: num(raw.criteriaTotal),
      avgAttempts: num(raw.avgAttempts),
      blockedRatio: num(raw.blockedRatio),
      reviewRejects: num(raw.reviewRejects),
      proceduralErrors: num(raw.proceduralErrors),
      gotchaApplied: num(raw.gotchaApplied),
      gotchaMissed: num(raw.gotchaMissed),
      refactorCount: num(raw.refactorCount),
      coverage: readCoverage(raw.coverage),
      // 배열은 experiment 로 인정하지 않는다 — 쓰기 경로(program.ts)가 Array.isArray 로
      // 거부하는 것과 대칭. 손상/수기편집된 스냅샷의 배열이 유사 케이스로 오염되는 걸 막는다.
      ...(raw.experiment !== null &&
      typeof raw.experiment === 'object' &&
      !Array.isArray(raw.experiment)
        ? { experiment: raw.experiment as Record<string, unknown> }
        : {}),
      ...(typeof raw.startedAt === 'string' ? { startedAt: raw.startedAt } : {}),
      ...(typeof raw.durationMs === 'number' ? { durationMs: raw.durationMs } : {}),
    });
  }
  generations.sort((a, b) => a.at.localeCompare(b.at));
  return generations;
}

/** 사람용 세대 표 렌더링. export 해 리뷰/테스트가 직접 볼 수 있게 한다 (WI-P 리뷰 지적). */
export function renderMetrics(generations: Generation[], c: Caps): string {
  const color = makeColors(c.color);
  const caveat = color.dim(renderMetricsCaveat());
  if (generations.length === 0) {
    return sectionBox('세대 지표', ['세대 기록이 없습니다.', '', caveat], c);
  }
  const idWidth = Math.max(...generations.map((g) => g.workitem.length), 9) + 2;
  const out: string[] = [];
  out.push(
    `${padEndDisplay('워크아이템', idWidth)}완료조건  시도평균  막힘비율  리뷰지적  절차실수  gotcha적용  gotcha누락  리팩토링  커버리지`,
  );
  for (const g of generations) {
    const coverage = `${g.coverage.addressed}/${g.coverage.auditFindingsTotal}`;
    out.push(
      `${padEndDisplay(g.workitem, idWidth)}${padEndDisplay(String(g.criteriaTotal), 10)}${padEndDisplay(String(g.avgAttempts), 10)}${padEndDisplay(String(g.blockedRatio), 10)}${padEndDisplay(String(g.reviewRejects), 10)}${padEndDisplay(String(g.proceduralErrors), 10)}${padEndDisplay(String(g.gotchaApplied), 12)}${padEndDisplay(String(g.gotchaMissed), 12)}${padEndDisplay(String(g.refactorCount), 10)}${coverage}`,
    );
  }
  out.push('');
  out.push(caveat);
  return sectionBox(`세대 ${generations.length}개 · 시간순`, out, c);
}

/** 케이스(experiment model/mode/taskType) 단위로 집계한 비교 행(experiment-harness AC-02). */
export interface CaseGroup {
  key: string;
  model: string;
  mode: string;
  taskType: string;
  count: number;
  avgAttempts: number;
  blockedRatio: number;
  reviewRejects: number;
  avgDurationMs?: number;
  workitems: string[];
}

const str = (v: unknown): string => (typeof v === 'string' && v !== '' ? v : '?');
const round2 = (n: number): number => Math.round(n * 100) / 100;

/** experiment 로 케이스 키를 만든다(model/mode/taskType). 순수. */
export function experimentKey(exp: Record<string, unknown> | undefined): string {
  return `${str(exp?.model)}/${str(exp?.mode)}/${str(exp?.taskType)}`;
}

/**
 * experiment 가 있는 세대를 케이스 키로 묶어 지표를 집계한다(순수).
 * experiment 없는 세대는 케이스가 아니라 제외한다(비교 대상 아님).
 * avgAttempts/blockedRatio 는 세대 평균, reviewRejects 는 합, duration 은 있는 것만 평균.
 */
export function groupByExperiment(generations: Generation[]): CaseGroup[] {
  const buckets = new Map<string, Generation[]>();
  for (const g of generations) {
    if (g.experiment === undefined) {
      continue;
    }
    const key = experimentKey(g.experiment);
    const arr = buckets.get(key) ?? [];
    arr.push(g);
    buckets.set(key, arr);
  }
  const groups: CaseGroup[] = [];
  for (const [key, gens] of buckets) {
    const n = gens.length;
    const exp = gens[0]?.experiment ?? {};
    const durs = gens.map((g) => g.durationMs).filter((d): d is number => typeof d === 'number');
    groups.push({
      key,
      model: str(exp.model),
      mode: str(exp.mode),
      taskType: str(exp.taskType),
      count: n,
      avgAttempts: round2(gens.reduce((s, g) => s + g.avgAttempts, 0) / n),
      blockedRatio: round2(gens.reduce((s, g) => s + g.blockedRatio, 0) / n),
      reviewRejects: gens.reduce((s, g) => s + g.reviewRejects, 0),
      ...(durs.length > 0
        ? { avgDurationMs: Math.round(durs.reduce((s, d) => s + d, 0) / durs.length) }
        : {}),
      workitems: gens.map((g) => g.workitem),
    });
  }
  groups.sort((a, b) => a.key.localeCompare(b.key));
  return groups;
}

/** ms 를 사람이 읽는 소요(예: 1h 23m)로. undefined 면 '-'. (loop-summary 재사용) */
export function fmtDuration(ms: number | undefined): string {
  if (ms === undefined) {
    return '-';
  }
  const min = Math.round(ms / 60_000);
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/** 케이스 비교 표(사람용). */
export function renderCompare(groups: CaseGroup[], untagged: number, c: Caps): string {
  const color = makeColors(c.color);
  const caveat = color.dim(renderMetricsCaveat());
  if (groups.length === 0) {
    return sectionBox(
      '케이스 비교',
      [`experiment 태그가 있는 세대가 없습니다(태그 없는 세대 ${untagged}개).`, '', caveat],
      c,
    );
  }
  const keyWidth =
    Math.max(stringWidth('케이스(model/mode/task)'), ...groups.map((g) => stringWidth(g.key))) + 2;
  const out: string[] = [
    `${padEndDisplay('케이스(model/mode/task)', keyWidth)}n   시도평균  막힘비율  리뷰지적  소요평균`,
  ];
  for (const g of groups) {
    out.push(
      `${padEndDisplay(g.key, keyWidth)}${padEndDisplay(String(g.count), 4)}${padEndDisplay(String(g.avgAttempts), 10)}${padEndDisplay(String(g.blockedRatio), 10)}${padEndDisplay(String(g.reviewRejects), 10)}${fmtDuration(g.avgDurationMs)}`,
    );
  }
  if (untagged > 0) {
    out.push('');
    out.push(color.dim(`(태그 없는 세대 ${untagged}개는 비교에서 제외)`));
  }
  out.push('');
  out.push(caveat);
  return sectionBox(`케이스 ${groups.length}개 비교`, out, c);
}

/** awl metrics [--compare] */
export function runMetrics(opts: { json?: boolean; compare?: boolean }): void {
  const { config } = requireConfig();
  const generations = loadGenerations(config.project);
  if (opts.compare === true) {
    const groups = groupByExperiment(generations);
    const untagged = generations.filter((g) => g.experiment === undefined).length;
    if (opts.json) {
      process.stdout.write(
        `${JSON.stringify({ cases: groups, untagged, caveat: renderMetricsCaveat() }, null, 2)}\n`,
      );
      return;
    }
    process.stdout.write(`${renderCompare(groups, untagged, caps())}\n`);
    return;
  }
  if (opts.json) {
    process.stdout.write(
      `${JSON.stringify({ generations, caveat: renderMetricsCaveat() }, null, 2)}\n`,
    );
    return;
  }
  process.stdout.write(`${renderMetrics(generations, caps())}\n`);
}
