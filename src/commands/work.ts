import { type Caps, caps, makeColors } from '../core/tty.js';
import { resolveProjectRoot } from './config.js';
import { gitBranch } from './doctor.js';
import { loadState, migrateState, writeState } from './state.js';

/**
 * awl work — 워크아이템 여러 개를 오간다 (WI-D).
 *
 * state.json 최상위 workitem/phase/loop/criteria 는 "현재 워크아이템의 실시간
 * 뷰"다. workitems 레지스트리는 현재가 아닌(paused/abandoned) 워크아이템들을
 * 담는다. list/new/switch/abandon 모두 이 불변식을 유지한다 — 그래서
 * status.ts/commit.ts/review.ts/evolve.ts/record.ts 는 한 줄도 안 바뀐다.
 */

export interface WorkSummary {
  id: string;
  status: string;
  passed: number;
  total: number;
  current: boolean;
  branch?: string;
  createdAt?: string;
}

function countCriteria(criteria: unknown): { passed: number; total: number } {
  const arr = Array.isArray(criteria) ? (criteria as Record<string, unknown>[]) : [];
  return { passed: arr.filter((c) => c.status === 'passed').length, total: arr.length };
}

/** 현재(top-level) 워크아이템 + workitems 레지스트리를 하나의 목록으로 합친다. */
export function summarizeWorkitems(state: Record<string, unknown>): WorkSummary[] {
  const out: WorkSummary[] = [];

  const currentId = typeof state.workitem === 'string' ? state.workitem : null;
  if (currentId) {
    const { passed, total } = countCriteria(state.criteria);
    out.push({
      id: currentId,
      status: 'active',
      passed,
      total,
      current: true,
      branch: typeof state.workitemBranch === 'string' ? state.workitemBranch : undefined,
      createdAt: typeof state.workitemCreatedAt === 'string' ? state.workitemCreatedAt : undefined,
    });
  }

  const registry =
    state.workitems && typeof state.workitems === 'object'
      ? (state.workitems as Record<string, unknown>)
      : {};
  for (const [id, raw] of Object.entries(registry)) {
    if (!raw || typeof raw !== 'object') {
      continue;
    }
    const entry = raw as Record<string, unknown>;
    const { passed, total } = countCriteria(entry.criteria);
    out.push({
      id,
      status: typeof entry.status === 'string' ? entry.status : 'paused',
      passed,
      total,
      current: false,
      branch: typeof entry.branch === 'string' ? entry.branch : undefined,
      createdAt: typeof entry.createdAt === 'string' ? entry.createdAt : undefined,
    });
  }

  return out;
}

function renderWorkList(list: WorkSummary[], c: Caps): string {
  const color = makeColors(c.color);
  if (list.length === 0) {
    return [
      '',
      '  등록된 워크아이템이 없습니다.',
      '',
      `  ${color.dim('awl work new <ID> 로 시작하세요.')}`,
    ].join('\n');
  }
  const idWidth = Math.max(...list.map((w) => w.id.length), 2) + 2;
  const statusWidth = Math.max(...list.map((w) => w.status.length), 6) + 2;
  const out: string[] = ['', `  ${color.bold('워크아이템')}`, ''];
  for (const w of list) {
    const marker = w.current ? color.green('*') : ' ';
    const line = `  ${marker} ${w.id.padEnd(idWidth, ' ')}${w.status.padEnd(statusWidth, ' ')}${w.passed}/${w.total} 통과`;
    out.push(w.branch ? `${line}  ${color.dim(w.branch)}` : line);
  }
  return out.join('\n');
}

export interface WorkitemEntry {
  status: string;
  createdAt: string;
  branch?: string;
  description?: string;
  phase?: unknown;
  loop?: unknown;
  criteria: Record<string, unknown>[];
  currentFocus?: string;
}

function registryOf(state: Record<string, unknown>): Record<string, WorkitemEntry> {
  return state.workitems && typeof state.workitems === 'object'
    ? (state.workitems as Record<string, WorkitemEntry>)
    : {};
}

/**
 * 현재(top-level) 워크아이템이 있으면 workitems 레지스트리에 보관하고 최상위를
 * 비운다. 현재 워크아이템이 없으면 그대로 돌려준다(archive 할 게 없다).
 */
function archiveCurrent(
  state: Record<string, unknown>,
  status: 'paused' | 'abandoned',
  now: string,
): Record<string, unknown> {
  const migrated = migrateState(state);
  const currentId = typeof migrated.workitem === 'string' ? migrated.workitem : null;
  if (!currentId) {
    return migrated;
  }
  const entry: WorkitemEntry = {
    status,
    createdAt: typeof migrated.workitemCreatedAt === 'string' ? migrated.workitemCreatedAt : now,
    ...(typeof migrated.workitemBranch === 'string' ? { branch: migrated.workitemBranch } : {}),
    ...(typeof migrated.workitemDescription === 'string'
      ? { description: migrated.workitemDescription }
      : {}),
    phase: migrated.phase ?? null,
    loop: migrated.loop ?? null,
    criteria: Array.isArray(migrated.criteria)
      ? (migrated.criteria as Record<string, unknown>[])
      : [],
    ...(typeof migrated.currentFocus === 'string' ? { currentFocus: migrated.currentFocus } : {}),
  };
  const {
    workitem: _w,
    phase: _p,
    loop: _l,
    criteria: _c,
    workitemBranch: _b,
    workitemCreatedAt: _ca,
    workitemDescription: _d,
    // currentFocus 는 워크아이템별 상태다(리뷰 지적 AC-09) — rest 로 흘려보내면
    // 다음(새) 워크아이템의 최상위로 그대로 새어 들어가 record blocked 의 baseline
    // 추론이 엉뚱한 AC 를 가리킬 수 있다. entry 스냅샷에만 담고 여기선 제거한다.
    currentFocus: _cf,
    ...rest
  } = migrated;
  return {
    ...rest,
    workitem: null,
    phase: null,
    loop: null,
    criteria: [],
    workitems: { ...registryOf(migrated), [currentId]: entry },
  };
}

export interface WorkActionResult {
  state: Record<string, unknown>;
  error?: string;
  warning?: string;
}

/** awl work new <id> — 현재를 보관하고 새 워크아이템으로 전환한다. */
export function createWorkitem(
  state: Record<string, unknown>,
  id: string,
  now: string,
  branch: string | null,
  description?: string,
): WorkActionResult {
  const trimmed = id.trim();
  if (!trimmed) {
    return { state, error: '워크아이템 ID 를 입력하세요.' };
  }
  const currentId = typeof state.workitem === 'string' ? state.workitem : null;
  if (trimmed === currentId) {
    return { state, error: `이미 현재 워크아이템입니다: ${trimmed}` };
  }
  if (trimmed in registryOf(state)) {
    return {
      state,
      error: `이미 존재하는 워크아이템입니다: ${trimmed} (awl work switch ${trimmed} 를 쓰세요)`,
    };
  }

  const archived = archiveCurrent(state, 'paused', now);
  return {
    state: {
      ...archived,
      workitem: trimmed,
      phase: 'awaiting-gate1',
      loop: null,
      criteria: [],
      workitemCreatedAt: now,
      ...(branch ? { workitemBranch: branch } : {}),
      ...(description ? { workitemDescription: description } : {}),
    },
  };
}

function requireRoot(): string {
  const root = resolveProjectRoot();
  if (!root) {
    process.stderr.write('\n  프로젝트 루트를 찾을 수 없습니다. awl init 을 실행하세요.\n');
    process.exit(1);
  }
  return root;
}

export function runWorkList(opts: { json: boolean }): void {
  const root = requireRoot();
  const list = summarizeWorkitems(loadState(root));
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(list, null, 2)}\n`);
  } else {
    process.stdout.write(`${renderWorkList(list, caps())}\n`);
  }
}

export async function runWorkNew(id: string, description: string | undefined): Promise<void> {
  const root = requireRoot();
  const now = new Date().toISOString();
  const branch = await gitBranch(root);
  const result = createWorkitem(loadState(root), id, now, branch, description);
  if (result.error) {
    process.stderr.write(`\n  ${result.error}\n`);
    process.exit(1);
  }
  writeState(root, result.state);
  process.stdout.write(`\n  워크아이템을 만들었습니다: ${id}\n`);
  process.stdout.write('  awl-loop 를 시작하세요.\n');
}
