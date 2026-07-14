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
  };
  records: { total: number; byType: Record<string, number> };
  lastAttempt: string | null;
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
  const firstAttempt = records.find((r) => r.type === 'attempt');
  const lastAttempt =
    firstAttempt && typeof firstAttempt.result === 'string' ? firstAttempt.result : null;

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
