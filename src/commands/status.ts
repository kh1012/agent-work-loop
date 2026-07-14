import { type Caps, caps, makeColors } from '../core/tty.js';
import { resolveProjectRoot } from './config.js';
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
}

/**
 * dependsOn 그래프를 순회해 아직 안 끝난 선행 완료조건이 있는 것만 뽑는다.
 * 이미 passed 인 완료조건은(dependsOn 이 나중에 붙었더라도) 블록으로 안 본다 —
 * 이미 끝난 일을 다시 막을 이유가 없다. 어느 걸 먼저 할지 정하는 건 여전히
 * 스킬(에이전트) 몫이다 — 여기선 계산만 한다.
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

  const records = readRecords();
  const byType: Record<string, number> = {};
  for (const r of records) {
    const t = String(r.type);
    byType[t] = (byType[t] ?? 0) + 1;
  }
  // readRecords 는 at 기준 내림차순이므로 첫 번째 attempt 가 가장 최근이다.
  const latestAttempt = records.find((r) => r.type === 'attempt');
  const lastAttempt =
    latestAttempt && typeof latestAttempt.result === 'string' ? latestAttempt.result : null;

  return {
    generation: typeof state.generation === 'number' ? state.generation : 1,
    phase: typeof state.phase === 'string' ? state.phase : null,
    workitem: typeof state.workitem === 'string' ? state.workitem : null,
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

export function renderStatus(report: StatusReport, c: Caps): string {
  const color = makeColors(c.color);

  // 아직 시작 전: 상태도 기록도 없다.
  if (report.phase === null && report.criteria.total === 0 && report.records.total === 0) {
    return [
      '',
      `  ${color.bold('진행 상황')}`,
      '',
      '  아직 시작 전입니다. 목표를 주고 awl-loop 를 실행하세요.',
    ].join('\n');
  }

  const cr = report.criteria;
  const typeSummary = Object.entries(report.records.byType)
    .map(([t, n]) => `${t} ${n}`)
    .join(' · ');

  const out: string[] = ['', `  ${color.bold('진행 상황')}  ${report.generation}세대`, ''];
  out.push(
    `  단계        ${report.phase ?? '(없음)'}${report.workitem ? `  ${color.dim(report.workitem)}` : ''}`,
  );
  out.push(
    `  완료 조건   ${color.bold(`${cr.passed}/${cr.total}`)} 통과  ${color.dim(`(막힘 ${cr.blocked}, 진행 ${cr.inProgress}, 대기 ${cr.pending})`)}`,
  );
  for (const b of cr.blockedByDeps) {
    out.push(
      `    ${color.yellow(b.id)}  블록됨  ${color.dim(`(대기: ${b.waitingOn.join(', ')})`)}`,
    );
  }
  out.push(
    `  기록        ${report.records.total}개  ${color.dim(typeSummary ? `(${typeSummary})` : '')}`,
  );
  out.push(`  최근 검증   ${report.lastAttempt ?? color.dim('(없음)')}`);
  return out.join('\n');
}

export function runStatus(opts: { json: boolean }): void {
  const root = resolveProjectRoot();
  if (!root) {
    process.stderr.write('\n  프로젝트 루트를 찾을 수 없습니다. awl init 을 실행하세요.\n');
    process.exit(1);
  }
  const report = buildStatus(root);
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(`${renderStatus(report, caps())}\n`);
  }
}
