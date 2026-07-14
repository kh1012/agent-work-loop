import fs from 'node:fs';
import path from 'node:path';
import { run } from '../core/runner.js';
import { type Caps, caps, makeColors } from '../core/tty.js';
import { loadConfig, resolveProjectRoot } from './config.js';
import { gitBranch } from './doctor.js';
import { loadState, migrateState, writeState } from './state.js';
import { buildVerifyBaseline, runVerifyChecks, writeVerifyBaseline } from './verify.js';

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
  worktreePath?: string;
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
      worktreePath:
        typeof state.workitemWorktreePath === 'string' ? state.workitemWorktreePath : undefined,
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
      worktreePath: typeof entry.worktreePath === 'string' ? entry.worktreePath : undefined,
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
    let line = `  ${marker} ${w.id.padEnd(idWidth, ' ')}${w.status.padEnd(statusWidth, ' ')}${w.passed}/${w.total} 통과`;
    if (w.branch) {
      line += `  ${color.dim(w.branch)}`;
    }
    if (w.worktreePath) {
      line += `  ${color.dim(`(worktree: ${w.worktreePath})`)}`;
    }
    out.push(line);
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
  worktreePath?: string;
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
    ...(typeof migrated.workitemWorktreePath === 'string'
      ? { worktreePath: migrated.workitemWorktreePath }
      : {}),
  };
  const {
    workitem: _w,
    phase: _p,
    loop: _l,
    criteria: _c,
    workitemBranch: _b,
    workitemCreatedAt: _ca,
    workitemDescription: _d,
    // currentFocus/worktreePath 는 워크아이템별 상태다(리뷰 지적 AC-09, 같은 실수를
    // worktreePath 에서 반복하지 않는다) — rest 로 흘려보내면 다음(새) 워크아이템의
    // 최상위로 그대로 새어 들어간다. entry 스냅샷에만 담고 여기선 제거한다.
    currentFocus: _cf,
    workitemWorktreePath: _wtp,
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
  worktreePath?: string,
): WorkActionResult {
  const trimmed = id.trim();
  if (!trimmed) {
    return { state, error: '워크아이템 ID 를 입력하세요.' };
  }
  // ID 비교는 대소문자를 구분하지 않는다(리뷰 지적 AC-10) — 'WI-D' 와 'wi-d' 를
  // 사람 눈엔 같지만 시스템은 다른 워크아이템으로 갈라놓는 사고를 막는다. 에러
  // 메시지는 실제로 존재하는(원래 표기의) ID 를 보여준다.
  const currentId = typeof state.workitem === 'string' ? state.workitem : null;
  if (currentId && trimmed.toLowerCase() === currentId.toLowerCase()) {
    return { state, error: `이미 현재 워크아이템입니다: ${currentId}` };
  }
  const existingKey = Object.keys(registryOf(state)).find(
    (k) => k.toLowerCase() === trimmed.toLowerCase(),
  );
  if (existingKey) {
    return {
      state,
      error: `이미 존재하는 워크아이템입니다: ${existingKey} (awl work switch ${existingKey} 를 쓰세요)`,
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
      ...(worktreePath ? { workitemWorktreePath: worktreePath } : {}),
    },
  };
}

/** awl work switch <id> — 현재를 보관하고 지정 워크아이템을 복원한다. */
export function restoreWorkitem(
  state: Record<string, unknown>,
  id: string,
  now: string,
  branch: string | null,
): WorkActionResult {
  const trimmed = id.trim();
  const migrated = migrateState(state);
  const registry = registryOf(migrated);
  const key = Object.keys(registry).find((k) => k.toLowerCase() === trimmed.toLowerCase());

  const currentId = typeof migrated.workitem === 'string' ? migrated.workitem : null;
  if (currentId && trimmed.toLowerCase() === currentId.toLowerCase()) {
    return { state, error: `이미 현재 워크아이템입니다: ${currentId}` };
  }
  if (!key) {
    return {
      state,
      error: `그런 워크아이템이 없습니다: ${trimmed} (awl work new ${trimmed} 로 새로 만드세요)`,
    };
  }

  const entry = registry[key] as WorkitemEntry;
  const archived = archiveCurrent(migrated, 'paused', now);
  const remainingRegistry = { ...registryOf(archived) };
  delete remainingRegistry[key];

  const nextState: Record<string, unknown> = {
    ...archived,
    workitem: key,
    phase: entry.phase ?? null,
    loop: entry.loop ?? null,
    criteria: entry.criteria,
    workitemCreatedAt: entry.createdAt,
    ...(entry.branch ? { workitemBranch: entry.branch } : {}),
    ...(entry.description ? { workitemDescription: entry.description } : {}),
    ...(entry.currentFocus ? { currentFocus: entry.currentFocus } : {}),
    ...(entry.worktreePath ? { workitemWorktreePath: entry.worktreePath } : {}),
    workitems: remainingRegistry,
  };

  // 삭제가 아니므로 abandoned 워크아이템으로도 switch 할 수 있게 허용한다(리뷰
  // 지적 AC-11) — 다만 의도치 않게 되살리는 걸 막기 위해 경고는 한다.
  const warnings: string[] = [];
  if (entry.branch && branch && entry.branch !== branch) {
    warnings.push(
      `경고: ${key} 는 브랜치 ${entry.branch} 에서 만들어졌는데 지금은 ${branch} 브랜치입니다.`,
    );
  }
  if (entry.status === 'abandoned') {
    warnings.push(`경고: ${key} 는 중단(abandoned) 처리된 워크아이템입니다.`);
  }

  return { state: nextState, warning: warnings.length > 0 ? warnings.join(' ') : undefined };
}

/**
 * awl work abandon <id> — 삭제하지 않는다, status 만 abandoned 로 바꾼다(기록은
 * 남는다). 현재 워크아이템을 abandon 하면 최상위를 비운다(다음에 new/switch 필요).
 */
export function abandonWorkitem(
  state: Record<string, unknown>,
  id: string,
  now: string,
): WorkActionResult {
  const trimmed = id.trim();
  const migrated = migrateState(state);
  const currentId = typeof migrated.workitem === 'string' ? migrated.workitem : null;

  if (currentId && trimmed.toLowerCase() === currentId.toLowerCase()) {
    return { state: archiveCurrent(migrated, 'abandoned', now) };
  }

  const registry = registryOf(migrated);
  const key = Object.keys(registry).find((k) => k.toLowerCase() === trimmed.toLowerCase());
  if (!key) {
    return { state, error: `그런 워크아이템이 없습니다: ${trimmed}` };
  }
  const entry = registry[key] as WorkitemEntry;
  return {
    state: {
      ...migrated,
      workitems: { ...registry, [key]: { ...entry, status: 'abandoned' } },
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

/** git ref/디렉토리 이름에 안전한 문자만 남긴다(commit.ts 의 sanitizeRefComponent 와 같은 이유 — 공백 등 잘못된 문자를 _ 로). */
function sanitizeForGit(s: string): string {
  return s
    .trim()
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .replace(/\.{2,}/g, '_');
}

/**
 * git worktree add 로 격리 디렉토리를 만든다(WI-F). 같은 브랜치를 두 워크트리에서
 * 동시에 체크아웃할 수 없어 새 브랜치가 필요하다(스파이크로 실증, D-29).
 * 실패해도 크래시하지 않는다 — 호출자가 이유를 보여주고 중단할지 정한다.
 */
async function createGitWorktree(
  root: string,
  targetPath: string,
  branchName: string,
): Promise<{ ok: boolean; error?: string }> {
  const r = await run({
    cmd: 'git',
    args: ['worktree', 'add', targetPath, '-b', branchName],
    cwd: root,
    timeoutMs: 30_000,
  });
  if (r.exitCode !== 0) {
    return { ok: false, error: (r.stderr || r.stdout).trim() };
  }
  return { ok: true };
}

/**
 * createGitWorktree 로 만든 워크트리/브랜치를 되돌린다(WI-F AC-09, 2차 리뷰 지적).
 * precheck 통과 후 실제 createWorkitem 호출 사이(동시 awl 프로세스가 state.json 을
 * 바꾸는 좁은 레이스 창)에 검증이 실패하면 이미 만든 git 자원이 orphan 으로 남는다 —
 * 이걸 되돌린다. 정리 자체가 실패해도 무음으로 삼키지 않는다(D-26 의 교훈과 같은 원칙).
 */
async function removeGitWorktree(
  root: string,
  targetPath: string,
  branchName: string,
): Promise<{ ok: boolean; error?: string }> {
  const rm = await run({
    cmd: 'git',
    args: ['worktree', 'remove', '--force', targetPath],
    cwd: root,
    timeoutMs: 30_000,
  });
  if (rm.exitCode !== 0) {
    return { ok: false, error: (rm.stderr || rm.stdout).trim() };
  }
  const br = await run({
    cmd: 'git',
    args: ['branch', '-D', branchName],
    cwd: root,
    timeoutMs: 10_000,
  });
  if (br.exitCode !== 0) {
    return { ok: false, error: (br.stderr || br.stdout).trim() };
  }
  return { ok: true };
}

/** .awl-worktrees/ 를 .gitignore 에 추가한다(없으면). init.ts 의 ensureGitignore 와 같은 패턴. */
function ensureWorktreesGitignored(root: string): void {
  const gi = path.join(root, '.gitignore');
  const target = '.awl-worktrees/';
  const content = fs.existsSync(gi) ? fs.readFileSync(gi, 'utf8') : '';
  if (content.split(/\r?\n/).some((line) => line.trim() === target)) {
    return;
  }
  const prefix = content.length > 0 && !content.endsWith('\n') ? '\n' : '';
  fs.writeFileSync(gi, `${content}${prefix}${target}\n`);
}

export async function runWorkNew(
  id: string,
  description: string | undefined,
  opts: { worktree?: string | boolean; skipBaseline?: boolean } = {},
): Promise<void> {
  const root = requireRoot();
  const now = new Date().toISOString();
  const branch = await gitBranch(root);

  // 먼저 검증한다(리뷰 지적 AC-06 — 실제 버그였다). git worktree/브랜치를 실제로
  // 만들기 전에 ID 가 유효한지(중복 아님 등) 확인해야, 검증에 실패했을 때
  // orphan 워크트리/브랜치가 안 남는다. createWorkitem 은 순수 함수라 이 사전
  // 검증 호출은 아무 부작용도 없다.
  const precheck = createWorkitem(loadState(root), id, now, branch, description);
  if (precheck.error) {
    process.stderr.write(`\n  ${precheck.error}\n`);
    process.exit(1);
  }

  let worktreePath: string | undefined;
  let branchName: string | undefined;
  if (opts.worktree) {
    branchName = typeof opts.worktree === 'string' ? opts.worktree : `work/${sanitizeForGit(id)}`;
    worktreePath = path.join(root, '.awl-worktrees', sanitizeForGit(id));
    const created = await createGitWorktree(root, worktreePath, branchName);
    if (!created.ok) {
      process.stderr.write(`\n  워크트리를 만들지 못했습니다: ${created.error}\n`);
      process.exit(1);
    }
    ensureWorktreesGitignored(root);
  }

  const result = createWorkitem(loadState(root), id, now, branch, description, worktreePath);
  if (result.error) {
    // precheck 를 이미 통과했으므로 여기서 다시 에러가 나는 건 예외적인 경우(예:
    // precheck 와 이 호출 사이에 다른 awl 프로세스가 state.json 을 바꿈)뿐이지만,
    // 그 좁은 창에서 이미 만든 git worktree/브랜치가 orphan 으로 남을 수 있다
    // (AC-09, 2차 리뷰 지적) — 정리한다.
    if (worktreePath && branchName) {
      const cleaned = await removeGitWorktree(root, worktreePath, branchName);
      if (!cleaned.ok) {
        process.stderr.write(
          `\n  워크트리 정리에도 실패했습니다 — 수동으로 확인하세요: ${cleaned.error}\n`,
        );
      }
    }
    process.stderr.write(`\n  ${result.error}\n`);
    process.exit(1);
  }
  writeState(root, result.state);
  process.stdout.write(`\n  워크아이템을 만들었습니다: ${id}\n`);
  if (worktreePath) {
    process.stdout.write(`  워크트리: ${worktreePath}\n`);
  }

  // 검증 베이스라인 캡처(WI-G AC-01) — 이 워크아이템을 시작하는 시점의 체크별
  // pass/fail 을 저장해두면, 나중에 `awl verify --since-baseline` 이 "새로 생긴
  // 실패"와 "원래부터 있던 실패(사전 결함)"를 기계적으로 구분할 수 있다.
  // --worktree 를 썼으면 실제 작업이 일어날 그 워크트리 기준으로 캡처한다(원래
  // 루트에 캡처하면 새 워크트리에서 나중에 못 찾는다 — verify-baseline.json 은
  // gitignore 대상이라 워크트리 체크아웃에 따라오지 않는다).
  const verifyRoot = worktreePath ?? root;
  if (opts.skipBaseline) {
    process.stdout.write(
      '  --skip-baseline: 검증 베이스라인을 건너뛰었습니다. 나중에 awl verify --since-baseline 을 못 씁니다.\n',
    );
  } else {
    const loaded = loadConfig(verifyRoot);
    if (loaded.config) {
      const report = await runVerifyChecks(loaded.config.verify, verifyRoot, { bail: false });
      try {
        // id.trim() — createWorkitem 이 state.workitem 에 저장하는 값(trimmed)과
        // 정확히 일치해야 나중에 resolveSinceBaseline 의 workitem 비교가 맞는다.
        writeVerifyBaseline(verifyRoot, buildVerifyBaseline(report, now, id.trim()));
        process.stdout.write(
          `  검증 베이스라인을 저장했습니다 (${report.results.map((r) => `${r.name}:${r.exitCode === 0 && !r.error && !r.timedOut ? '통과' : '실패'}`).join(', ')}).\n`,
        );
      } catch (e) {
        // 베이스라인은 부가 기능이다 — 저장이 실패해도(디스크/권한 등) 워크아이템
        // 생성 자체는 이미 끝났으니 크래시시키지 않는다(WI-H 스파이크 지적, AC-03).
        process.stderr.write(
          `\n  검증 베이스라인 저장에 실패했습니다: ${String(e)}\n  나중에 awl verify --since-baseline 을 못 씁니다.\n`,
        );
      }
    } else {
      process.stdout.write(
        '  config 를 못 읽어 검증 베이스라인을 건너뛰었습니다. 나중에 awl verify --since-baseline 을 못 씁니다.\n',
      );
    }
  }

  if (worktreePath) {
    process.stdout.write(`  cd ${worktreePath} 로 이동해 거기서 awl-loop 를 시작하세요.\n`);
  } else {
    process.stdout.write('  awl-loop 를 시작하세요.\n');
  }
}

export async function runWorkSwitch(id: string): Promise<void> {
  const root = requireRoot();
  const now = new Date().toISOString();
  const branch = await gitBranch(root);
  const result = restoreWorkitem(loadState(root), id, now, branch);
  if (result.error) {
    process.stderr.write(`\n  ${result.error}\n`);
    process.exit(1);
  }
  writeState(root, result.state);
  process.stdout.write(`\n  전환했습니다: ${id}\n`);
  if (result.warning) {
    process.stderr.write(`  ${result.warning}\n`);
  }
}

export function runWorkAbandon(id: string): void {
  const root = requireRoot();
  const now = new Date().toISOString();
  const result = abandonWorkitem(loadState(root), id, now);
  if (result.error) {
    process.stderr.write(`\n  ${result.error}\n`);
    process.exit(1);
  }
  writeState(root, result.state);
  process.stdout.write(`\n  중단 처리했습니다: ${id}\n`);
  process.stdout.write('  기록은 남아 있습니다(삭제되지 않습니다).\n');
}
