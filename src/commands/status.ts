import fs from 'node:fs';
import path from 'node:path';
import { type FrontmatterData, parseFrontmatter } from '../core/doc-frontmatter.js';
import { WORKTREES_DIR } from '../core/paths.js';
import { run } from '../core/runner.js';
import {
  type Caps,
  type PipelineStatus,
  caps,
  makeColors,
  makeSymbols,
  makeTokens,
  padEndDisplay,
  sectionBox,
  signal,
  statusBadge,
  stringWidth,
} from '../core/tty.js';
import { multiProjectFooter, resolveProjectScope } from './config.js';
import { listDocFiles } from './doc.js';
import { readRecords } from './record.js';
import { loadState } from './state.js';

/**
 * awl status — 지금 어디까지 왔는지 한눈에 보여준다.
 *
 * doctor 는 환경·설치 점검이고, status 는 진행 상황이다.
 * verify 는 느려서 실행하지 않는다(status 는 빠른 요약이어야 한다).
 * 마지막 검증 상태는 최근 attempt 기록의 result 로 대체 표시한다.
 * 기존 loadState/readRecords 를 조합할 뿐, 새 저장소를 만들지 않는다.
 */

/** dependsOn 이 아직 안 끝난(passed 아닌) 완료 조건. 순수 계산이지 판단이 아니다(WI-E). */
export interface BlockedByDeps {
  id: string;
  waitingOn: string[];
}

/** 게이트에 제시된 완료조건 하나 — state.criteria 에서 찾은 status 를 곁들인다(못 찾으면 undefined, 실패로 단정하지 않는다). */
export interface GateCriterionEntry {
  id: string;
  status?: string;
}

/**
 * 게이트 1~4 의 기록 상태 (WI-Q AC-03, ADK stage 2a 로 3/4 확장, WI-G19 로 접기/펼치기
 * 판정용 원본 배열 + folded 로 확장). recorded:false 면 나머지 필드는 없다.
 *
 * 접기/펼치기(adk-prototype.md:249-258, adk-reference.md:1393-1464) — "승인을 바꿀 수
 * 있는 것만 펼친다": presentedExclusions(범위 밖)·reviewFindings(리뷰 지적)는 있으면
 * 무조건 펼치고, presentedCriteria 는 전부 passed(또는 상태를 모름)면 접는다.
 */
export interface GateStatus {
  gate: 1 | 2 | 3 | 4;
  recorded: boolean;
  decision?: string;
  at?: string;
  presentedCriteria?: GateCriterionEntry[];
  presentedExclusions?: unknown[];
  /** 이 게이트가 다룬 완료조건을 지목한 review 기록의 findings (있으면 항상 펼친다). */
  reviewFindings?: Record<string, unknown>[];
  /** true = 한 줄로 접힘("N개 통과 ▸"), false = 항목별로 펼침. */
  folded?: boolean;
  auto?: boolean;
  /** 게이트4 가 auto:true 로 기록됐을 때만 채운다(WI-H4, "auto 모드는 게이트4 에서 펼친 요약만 낸다"). */
  requestSummary?: RequestSummary;
}

/** 게이트4(요청 닫기)가 auto 로 기록됐을 때 펼치는 요청 전체 요약(WI-H4). */
export interface RequestSummary {
  totalTickets: number;
  completedTickets: number;
  conditionsTotal: number;
  /** 이 스펙에 속한 티켓들(+게이트4 자신)의 게이트 기록 중 auto:true 인 것의 수. */
  autoApprovalCount: number;
}

/**
 * specId 에 속한 티켓들(docs/tickets/*.md 의 spec 필드로 연결)을 모아 완료/조건/
 * 자동승인 집계를 낸다. 순수 조회 — 판단하지 않는다(개수만 센다).
 */
function buildRequestSummary(projectRoot: string, specId: string): RequestSummary {
  const ticketDocs = listDocFiles(projectRoot)
    .filter((f) => f.type === 'ticket')
    .map((f) => {
      try {
        return parseFrontmatter(fs.readFileSync(f.path, 'utf8'))?.data;
      } catch {
        return undefined;
      }
    })
    .filter((d): d is FrontmatterData => d !== undefined)
    .filter((d) => d.spec === specId);

  const totalTickets = ticketDocs.length;
  const completedTickets = ticketDocs.filter((t) => t.status === 'done').length;
  const conditionsTotal = ticketDocs.reduce(
    (sum, t) => sum + (Array.isArray(t.conditions) ? t.conditions.length : 0),
    0,
  );
  const ticketIds = new Set(ticketDocs.map((t) => String(t.id)));
  const autoApprovalCount = readRecords(projectRoot, { type: 'gate' }).filter(
    (r) =>
      r.auto === true &&
      (r.spec === specId || (typeof r.ticket === 'string' && ticketIds.has(r.ticket))),
  ).length;

  return { totalTickets, completedTickets, conditionsTotal, autoApprovalCount };
}

/**
 * 완료조건 커밋이 지금 HEAD 에 없다는 "사실"(wi8-F3). awl 은 어느 계보가 맞다고
 * 판단하지 않는다 — diverged(커밋은 있으나 HEAD 조상 아님, 다른 계보)와
 * not-found(커밋 객체가 이 클론에 없음)만 구분해 표시한다.
 */
export interface MissingAcCommit {
  id: string;
  commit: string;
  reason: 'diverged' | 'not-found';
}

export interface StatusReport {
  generation: number;
  phase: string | null;
  workitem: string | null;
  criteria: {
    total: number;
    passed: number;
    blocked: number;
    inProgress: number;
    pending: number;
    blockedByDeps: BlockedByDeps[];
  };
  records: { total: number; byType: Record<string, number> };
  lastAttempt: string | null;
  gates: GateStatus[];
  // 커밋 SHA 대조는 git 을 써야 해서 동기 buildStatus 밖(checkMissingAcCommits)에서
  // 채운다. 옵션 필드라 buildStatus 만 부르는 기존 경로/테스트는 영향 없다.
  missingAcCommits?: MissingAcCommit[];
}

/**
 * 현재 워크아이템의 게이트 1~4 기록을 찾는다. readRecords 는 최근순이라
 * 같은 게이트 번호가 여러 번 기록됐어도(재승인 등) 첫 번째로 만나는 게 최신이다.
 * gate 레코드가 없어도(대기중) 항상 네 항목(1~4)을 돌려준다 — 계산만 한다.
 *
 * criteriaStatus 는 state.criteria 의 id→status 맵(WI-G19) — 게이트가 제시한 완료조건이
 * 지금 실제로 passed 인지 대조해 접기/펼치기를 판정한다. reviewRecords 는 review 타입
 * 기록 중 이 게이트가 제시한 완료조건을 하나라도 지목한 것 — findings 를 모아 항상 펼친다.
 * projectRoot 는 게이트4 가 auto 로 기록됐을 때만 requestSummary 를 계산하려고 받는다
 * (WI-H4) — 나머지 게이트/워크아이템은 이 조회를 안 탄다.
 */
function buildGateStatus(
  projectRoot: string,
  records: Record<string, unknown>[],
  criteriaStatus: Map<string, string>,
): GateStatus[] {
  const gateRecords = records.filter((r) => r.type === 'gate');
  const reviewRecords = records.filter((r) => r.type === 'review');
  return ([1, 2, 3, 4] as const).map((gate) => {
    const rec = gateRecords.find((r) => r.gate === gate);
    if (!rec) {
      return { gate, recorded: false };
    }
    const presentedCriteriaIds = (
      Array.isArray(rec.presentedCriteria) ? rec.presentedCriteria : []
    ).map((id) => String(id));
    const presentedCriteria: GateCriterionEntry[] = presentedCriteriaIds.map((id) => ({
      id,
      status: criteriaStatus.get(id),
    }));
    const presentedExclusions = Array.isArray(rec.presentedExclusions)
      ? rec.presentedExclusions
      : [];
    const reviewFindings = reviewRecords
      .filter(
        (r) =>
          Array.isArray(r.criteria) &&
          (r.criteria as unknown[]).some((id) => presentedCriteriaIds.includes(String(id))),
      )
      .flatMap((r) => (Array.isArray(r.findings) ? (r.findings as Record<string, unknown>[]) : []));
    const hasUnresolved = presentedCriteria.some(
      (item) => item.status !== undefined && item.status !== 'passed',
    );
    const folded =
      presentedExclusions.length === 0 && reviewFindings.length === 0 && !hasUnresolved;
    const auto = typeof rec.auto === 'boolean' ? rec.auto : undefined;
    const requestSummary =
      gate === 4 && auto === true && typeof rec.spec === 'string'
        ? buildRequestSummary(projectRoot, rec.spec)
        : undefined;
    return {
      gate,
      recorded: true,
      decision: typeof rec.decision === 'string' ? rec.decision : undefined,
      at: typeof rec.at === 'string' ? rec.at : undefined,
      presentedCriteria,
      presentedExclusions,
      reviewFindings,
      folded,
      auto,
      requestSummary,
    };
  });
}

/**
 * dependsOn 그래프를 순회해 아직 안 끝난 선행 완료조건이 있는 것만 뽑는다.
 * 이미 passed 인 완료조건은(dependsOn 이 나중에 붙었더라도) 블록으로 안 본다 —
 * 이미 끝난 일을 다시 막을 이유가 없다. 어느 걸 먼저 할지 정하는 건 여전히
 * 스킬(에이전트) 몫이다 — 여기선 계산만 한다.
 *
 * 순환/오타 감지는 하지 않는다(리뷰 지적 AC-04 — 의도적 단순화). dependsOn 이
 * 자기 자신을 가리키거나(A → A) 존재하지 않는 ID 를 가리키면 그 완료조건은
 * 영구적으로 블록됨으로 표시된다 — 크래시나 무한루프는 없지만, 이게 진짜
 * 순환/의존 대기인지 오타인지는 표시만으로 구분 못 한다. 이 표시 자체가
 * "뭔가 이상하다"는 신호이므로 스킬(에이전트)이 보고 판단한다.
 */
function computeBlockedByDeps(criteria: Record<string, unknown>[]): BlockedByDeps[] {
  const passedIds = new Set(criteria.filter((c) => c.status === 'passed').map((c) => String(c.id)));
  const blocked: BlockedByDeps[] = [];
  for (const c of criteria) {
    if (c.status === 'passed') {
      continue;
    }
    const dependsOn = Array.isArray(c.dependsOn) ? (c.dependsOn as unknown[]) : [];
    const waitingOn = dependsOn.map(String).filter((d) => !passedIds.has(d));
    if (waitingOn.length > 0) {
      blocked.push({ id: String(c.id), waitingOn });
    }
  }
  return blocked;
}

export function buildStatus(projectRoot: string): StatusReport {
  const state = loadState(projectRoot);
  const criteria = Array.isArray(state.criteria)
    ? (state.criteria as Record<string, unknown>[])
    : [];
  const count = (s: string): number => criteria.filter((c) => c.status === s).length;

  const records = readRecords(projectRoot);
  const byType: Record<string, number> = {};
  for (const r of records) {
    const t = String(r.type);
    byType[t] = (byType[t] ?? 0) + 1;
  }
  // readRecords 는 at 기준 내림차순이므로 첫 번째 attempt 가 가장 최근이다.
  const latestAttempt = records.find((r) => r.type === 'attempt');
  const lastAttempt =
    latestAttempt && typeof latestAttempt.result === 'string' ? latestAttempt.result : null;

  // 게이트 이력은 현재 워크아이템 것만 본다(다른 워크아이템 게이트가 섞이면 안 됨).
  const workitem = typeof state.workitem === 'string' ? state.workitem : null;
  const criteriaStatus = new Map<string, string>();
  for (const cr of criteria) {
    if (typeof cr.id === 'string' && typeof cr.status === 'string') {
      criteriaStatus.set(cr.id, cr.status);
    }
  }
  const gates = buildGateStatus(
    projectRoot,
    records.filter((r) => r.workitem === workitem),
    criteriaStatus,
  );

  return {
    generation: typeof state.generation === 'number' ? state.generation : 1,
    phase: typeof state.phase === 'string' ? state.phase : null,
    workitem,
    gates,
    criteria: {
      total: criteria.length,
      passed: count('passed'),
      blocked: count('blocked'),
      inProgress: count('in_progress'),
      pending: count('pending'),
      blockedByDeps: computeBlockedByDeps(criteria),
    },
    records: { total: records.length, byType },
    lastAttempt,
  };
}

/**
 * git merge-base --is-ancestor <commit> HEAD 의 exit code 를 사실로 분류한다.
 *   0   = HEAD 조상(포함됨)                   → present
 *   1   = 조상 아님(커밋은 있으나 다른 계보)   → diverged
 *   128 = 커밋 객체가 이 클론에 없음           → not-found
 *   그 외(null=타임아웃/시그널, 기타 에러)     → unknown (판정 불가)
 * unknown 을 not-found 로 뭉뚱그리면 git 이 판정도 못 했는데 "커밋 없음"이라는
 * 거짓 사실을 표시하게 된다 — awl 은 확실한 사실만 표시한다(리뷰 지적).
 */
export function classifyAncestorExit(
  exitCode: number | null,
): 'present' | 'diverged' | 'not-found' | 'unknown' {
  if (exitCode === 0) {
    return 'present';
  }
  if (exitCode === 1) {
    return 'diverged';
  }
  if (exitCode === 128) {
    return 'not-found';
  }
  return 'unknown';
}

/**
 * 완료조건 커밋(criterion.commit) 중 지금 HEAD 조상이 아닌 것을 사실로 수집한다(wi8-F3).
 * commit 필드가 있는 완료조건만 본다. git 저장소가 아님/HEAD 없음/git 미설치면 빈 배열
 * (status 는 절대 크래시하지 않는다 — gitBranch 와 같은 원칙). 확실히 판정된 것
 * (diverged/not-found)만 보고하고 unknown(판정 불가)은 지어내지 않고 건너뛴다.
 */
export async function checkMissingAcCommits(projectRoot: string): Promise<MissingAcCommit[]> {
  const state = loadState(projectRoot);
  const criteria = Array.isArray(state.criteria)
    ? (state.criteria as Record<string, unknown>[])
    : [];
  const withCommit = criteria.filter(
    (c): c is Record<string, unknown> & { commit: string } =>
      typeof c.commit === 'string' && c.commit.length > 0,
  );
  if (withCommit.length === 0) {
    return [];
  }
  try {
    const head = await run({
      cmd: 'git',
      args: ['rev-parse', '--verify', '--quiet', 'HEAD'],
      cwd: projectRoot,
      timeoutMs: 10_000,
    });
    if (head.exitCode !== 0) {
      return [];
    }
    const out: MissingAcCommit[] = [];
    for (const c of withCommit) {
      const r = await run({
        cmd: 'git',
        args: ['merge-base', '--is-ancestor', c.commit, 'HEAD'],
        cwd: projectRoot,
        timeoutMs: 10_000,
      });
      const kind = classifyAncestorExit(r.exitCode);
      // present(포함) 또는 unknown(판정 불가)이면 사실을 표시하지 않는다.
      if (kind === 'diverged' || kind === 'not-found') {
        out.push({ id: String(c.id), commit: c.commit, reason: kind });
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** 게이트 decision 상태값 색코딩(F-05): 승인=green, 거부/중단=danger, 수정/추가작업=warning. */
function decisionColored(t: ReturnType<typeof makeTokens>, decision: string): string {
  if (decision === 'approved') {
    return t.success(decision);
  }
  if (decision === 'rejected' || decision === 'abandoned') {
    return t.danger(decision);
  }
  if (decision === 'modified' || decision === 'more-work' || decision === 'split') {
    return t.warning(decision);
  }
  return decision;
}

export function renderStatus(report: StatusReport, c: Caps): string {
  const color = makeColors(c.color);
  const t = makeTokens(c);
  const s = makeSymbols(c);

  // 아직 시작 전: 상태도 기록도 없다.
  if (report.phase === null && report.criteria.total === 0 && report.records.total === 0) {
    return sectionBox(
      '진행 상황',
      [
        `${signal(c, 'info')} 아직 시작 전입니다.`,
        `${s.lastBranch} 목표를 주고 awl-loop 를 실행하세요.`,
      ],
      c,
    );
  }

  const cr = report.criteria;
  const typeSummary = Object.entries(report.records.byType)
    .map(([t, n]) => `${t} ${n}`)
    .join(' · ');

  const out: string[] = [];
  out.push(
    `단계  ${report.phase ?? '(없음)'}${report.workitem ? `  ${color.dim(report.workitem)}` : ''}`,
  );
  out.push(
    `${s.branch} 완료 조건  ${color.bold(`${cr.passed}/${cr.total}`)} 통과  ${color.dim(`(막힘 ${cr.blocked}, 진행 ${cr.inProgress}, 대기 ${cr.pending})`)}`,
  );
  for (const b of cr.blockedByDeps) {
    out.push(
      `${s.vGuide}   ${s.lastBranch} ${signal(c, 'warn')} ${color.yellow(b.id)} 블록됨  ${color.dim(`(대기: ${b.waitingOn.join(', ')})`)}`,
    );
  }
  // 캐노니컬 HEAD 검증(wi8-F3): 완료조건 커밋이 지금 HEAD 에 없다는 사실만 표시한다.
  for (const m of report.missingAcCommits ?? []) {
    const why = m.reason === 'diverged' ? '다른 계보' : '커밋 없음';
    out.push(
      `${s.vGuide}   ${s.lastBranch} ${signal(c, 'warn')} ${color.yellow(m.id)} 커밋이 HEAD에 없음  ${color.dim(`(${m.commit.slice(0, 10)}, ${why})`)}`,
    );
  }
  out.push(
    `${s.branch} 기록       ${report.records.total}개  ${color.dim(typeSummary ? `(${typeSummary})` : '')}`,
  );
  out.push(`${s.lastBranch} 최근 검증  ${report.lastAttempt ?? color.dim('(없음)')}`);
  for (const g of report.gates) {
    if (!g.recorded) {
      out.push(`    ${s.lastBranch} ${signal(c, 'info')} 게이트 ${g.gate}  ${color.dim('대기중')}`);
      continue;
    }
    const when = g.at ? g.at.slice(0, 16).replace('T', ' ') : '';
    const criteria = g.presentedCriteria ?? [];
    const exclusions = g.presentedExclusions ?? [];
    const findings = g.reviewFindings ?? [];
    const autoTag = g.auto ? color.dim(' (자동)') : '';
    // 접힘: 완료조건 개수만 한 줄로("N개 통과 ▸") — 범위 밖/리뷰 지적이 없고 전부
    // passed(또는 상태 불명)일 때만. 펼침: 항목별로 나열해 "실패나 지적"이 보이게 한다.
    const foldSummary = g.folded
      ? `완료조건 ${criteria.length}개 ${s.fold}`
      : `완료조건 ${criteria.length}개, 제외 ${exclusions.length}건, 리뷰지적 ${findings.length}건`;
    out.push(
      `    ${s.lastBranch} 게이트 ${g.gate}  ${decisionColored(t, g.decision ?? '')}${autoTag}   ${when}   ${color.dim(foldSummary)}`,
    );
    if (!g.folded) {
      for (const item of criteria) {
        const marker = item.status === 'passed' ? signal(c, 'ok') : signal(c, 'warn');
        out.push(
          `        ${s.vGuide}   ${s.lastBranch} ${marker} ${item.id}${item.status ? color.dim(` (${item.status})`) : ''}`,
        );
      }
      for (const ex of exclusions) {
        const exObj = ex && typeof ex === 'object' ? (ex as Record<string, unknown>) : null;
        const id = exObj && typeof exObj.id === 'string' ? exObj.id : String(ex);
        const reason =
          exObj && typeof exObj.reason === 'string' ? `  ${color.dim(exObj.reason)}` : '';
        out.push(
          `        ${s.vGuide}   ${s.lastBranch} ${signal(c, 'warn')} 범위 밖: ${id}${reason}`,
        );
      }
      for (const f of findings) {
        const what = typeof f.what === 'string' ? f.what : JSON.stringify(f);
        const evidence = typeof f.evidence === 'string' ? `  ${color.dim(f.evidence)}` : '';
        out.push(
          `        ${s.vGuide}   ${s.lastBranch} ${signal(c, 'warn')} 리뷰: ${what}${evidence}`,
        );
      }
    }
    // auto 모드가 게이트4 에서 펼치는 요청 전체 요약(WI-H4, adk-prototype.md:365
    // "auto 전부 자동. 게이트 4 에서 펼친 요약만 낸다") — folded 여부와 무관하게 항상 보인다.
    if (g.requestSummary) {
      const rs = g.requestSummary;
      out.push(
        `        ${s.vGuide}   ${s.lastBranch} ${color.dim(`완료 티켓 ${rs.completedTickets}/${rs.totalTickets}개 · 조건 ${rs.conditionsTotal}개 · 자동승인 ${rs.autoApprovalCount}회`)}`,
      );
    }
  }
  return sectionBox(`진행 상황 · ${report.generation}세대`, out, c);
}

export async function runStatus(opts: { json: boolean }): Promise<void> {
  const scope = resolveProjectScope();
  if (scope.mode === 'multi' && scope.projects) {
    const cc = caps();
    const color = makeColors(cc.color);
    if (opts.json) {
      const projects = await Promise.all(
        scope.projects.map(async (p) => {
          const report: StatusReport = {
            ...buildStatus(p.path),
            missingAcCommits: await checkMissingAcCommits(p.path),
          };
          return { name: p.name, path: p.path, ...report };
        }),
      );
      process.stdout.write(`${JSON.stringify({ multiProject: true, projects }, null, 2)}\n`);
      return;
    }
    const blocks: string[] = [];
    for (const p of scope.projects) {
      blocks.push(color.bold(`프로젝트: ${p.name}  (${p.path})`));
      const report: StatusReport = {
        ...buildStatus(p.path),
        missingAcCommits: await checkMissingAcCommits(p.path),
      };
      blocks.push(renderStatus(report, cc));
    }
    process.stdout.write(`${blocks.join('\n\n')}\n`);
    process.stdout.write(`${multiProjectFooter(scope.projects, 'awl status', cc)}\n`);
    return;
  }
  if (scope.mode === 'none') {
    const cc = caps();
    process.stderr.write(
      `\n  ${signal(cc, 'error')} 프로젝트 루트를 찾을 수 없습니다.\n      ${makeSymbols(cc).lastBranch} awl init 을 실행하세요.\n`,
    );
    process.exit(1);
  }
  const root = scope.projectRoot as string;
  // buildStatus 는 동기 유지(기존 호출/테스트 보존). 커밋 SHA 대조는 git 이 필요해
  // 여기서 async 로 덧붙인다 — 없으면 빈 배열이라 렌더/JSON 모두 영향 없다.
  const report: StatusReport = {
    ...buildStatus(root),
    missingAcCommits: await checkMissingAcCommits(root),
  };
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(`${renderStatus(report, caps())}\n`);
  }
}
