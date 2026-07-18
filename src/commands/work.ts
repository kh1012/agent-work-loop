import fs from 'node:fs';
import path from 'node:path';
import { run } from '../core/runner.js';
import {
  type Caps,
  caps,
  card,
  feedback,
  makeColors,
  makeSymbols,
  makeTokens,
  signal,
} from '../core/tty.js';
import { DEFAULT_USAGE_PATH, readCostSnapshot } from '../core/usage.js';
import { loadConfig, resolveProjectRoot } from './config.js';
import { gitBranch } from './doctor.js';
import { installClaudeSkill } from './init.js';
import { mergeIsolatedHome, writeParentMarker } from './learning-merge.js';
import { loadState, migrateState, writeState } from './state.js';
import {
  buildVerifyBaseline,
  isCheckPassed,
  runVerifyChecks,
  writeVerifyBaseline,
} from './verify.js';

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

/** 워크아이템 상태값 색코딩(status.ts 패턴): 진행/완료=green, 보류=warning, 중단=muted. */
function statusColored(t: ReturnType<typeof makeTokens>, status: string): string {
  if (status === 'active' || status === 'done') {
    return t.success(status);
  }
  if (status === 'paused') {
    return t.warning(status);
  }
  if (status === 'abandoned') {
    return t.muted(status);
  }
  return status;
}

export function renderWorkList(list: WorkSummary[], c: Caps): string {
  const color = makeColors(c.color);
  const t = makeTokens(c);
  const s = makeSymbols(c);
  if (list.length === 0) {
    return card(
      '워크아이템',
      [
        `${signal(c, 'info')} 등록된 워크아이템이 없습니다.`,
        '',
        `${s.lastBranch} ${color.dim('awl work new <ID> 로 시작하세요.')}`,
      ],
      c,
    );
  }
  const idWidth = Math.max(...list.map((w) => w.id.length), 2) + 2;
  const statusWidth = Math.max(...list.map((w) => w.status.length), 6) + 2;
  const out: string[] = [];
  for (const w of list) {
    const marker = w.current ? color.green('*') : ' ';
    // 상태값은 색코딩, passed/total 은 emphasis(핵심 값 강조) — status.ts 패턴(F-04/F-05).
    const statusPad = ' '.repeat(Math.max(0, statusWidth - w.status.length));
    let line = `${marker} ${w.id.padEnd(idWidth, ' ')}${statusColored(t, w.status)}${statusPad}${t.emphasis(`${w.passed}/${w.total}`)} 통과`;
    if (w.branch) {
      line += `  ${color.dim(w.branch)}`;
    }
    out.push(line);
    if (w.worktreePath) {
      out.push(`  ${s.lastBranch} ${color.dim(`worktree: ${w.worktreePath}`)}`);
    }
  }
  return card('워크아이템', out, c);
}

export interface WorkitemEntry {
  status: string;
  createdAt: string;
  branch?: string;
  description?: string;
  raw_request?: string;
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
  status: 'paused' | 'abandoned' | 'done',
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
    ...(typeof migrated.raw_request === 'string' ? { raw_request: migrated.raw_request } : {}),
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
    raw_request: _rr,
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
  experiment?: Record<string, unknown>,
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
      raw_request: description ?? '',
      ...(worktreePath ? { workitemWorktreePath: worktreePath } : {}),
      // 실험 케이스 메타(model/mode/taskType). D-15 자유 필드로 보존 —
      // evolve 가 세대 스냅샷에 실어 metrics --compare 가 케이스별로 비교한다.
      ...(experiment ? { workitemExperiment: experiment } : {}),
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
    ...(typeof entry.raw_request === 'string' ? { raw_request: entry.raw_request } : {}),
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

/**
 * 완료된 워크아이템의 criteria 에서 비대·불필요해진 스냅샷 필드를 비운다(F-1/F-5).
 * untrackedAtStart(워크트리 파일 목록)와 snapshot(stash 커밋 SHA)은 격리 커밋 중에만
 * 쓰이므로 완료 후엔 필요 없다 — state.json 비대분을 회수한다. baseline(SHA)은 작고
 * 이력이라 남긴다.
 */
function stripCriteriaSnapshots(criteria: Record<string, unknown>[]): Record<string, unknown>[] {
  return criteria.map((c) => {
    const { untrackedAtStart: _u, snapshot: _s, ...rest } = c;
    return rest;
  });
}

export interface WorkDoneResult extends WorkActionResult {
  /** 정리할 워크트리 경로(있으면). 실제 디렉토리 제거는 부작용이라 핸들러 몫이다. */
  worktree?: { path: string };
}

/**
 * awl work done <id> — 완료된 워크아이템을 정리한다(피드백 F-5). status 를 done 으로
 * 바꾸고, criteria 의 비대 스냅샷(untrackedAtStart/snapshot)을 비워 state.json 을
 * 회수하며, 워크트리 경로를 돌려준다. 삭제가 아니라 완료 표시라 기록은 레지스트리에
 * 남는다(abandon 과 같은 원칙). 현재/레지스트리 워크아이템 모두 대상이 된다.
 */
export function markWorkitemDone(
  state: Record<string, unknown>,
  id: string,
  now: string,
): WorkDoneResult {
  const trimmed = id.trim();
  const migrated = migrateState(state);
  const currentId = typeof migrated.workitem === 'string' ? migrated.workitem : null;

  // 대상이 현재(top-level) 워크아이템 — 레지스트리에 done 으로 보관하고 최상위를 비운다.
  if (currentId && trimmed.toLowerCase() === currentId.toLowerCase()) {
    const wtPath =
      typeof migrated.workitemWorktreePath === 'string' ? migrated.workitemWorktreePath : undefined;
    const archived = archiveCurrent(migrated, 'done', now);
    const reg = registryOf(archived);
    const entry = reg[currentId] as WorkitemEntry;
    const next = {
      ...archived,
      workitems: {
        ...reg,
        [currentId]: { ...entry, criteria: stripCriteriaSnapshots(entry.criteria ?? []) },
      },
    };
    return { state: next, ...(wtPath ? { worktree: { path: wtPath } } : {}) };
  }

  // 대상이 레지스트리(paused/abandoned) 워크아이템.
  const registry = registryOf(migrated);
  const key = Object.keys(registry).find((k) => k.toLowerCase() === trimmed.toLowerCase());
  if (!key) {
    return { state, error: `그런 워크아이템이 없습니다: ${trimmed}` };
  }
  const entry = registry[key] as WorkitemEntry;
  const wtPath = typeof entry.worktreePath === 'string' ? entry.worktreePath : undefined;
  const next = {
    ...migrated,
    workitems: {
      ...registry,
      [key]: { ...entry, status: 'done', criteria: stripCriteriaSnapshots(entry.criteria ?? []) },
    },
  };
  return { state: next, ...(wtPath ? { worktree: { path: wtPath } } : {}) };
}

/**
 * root state 에서 지정 id(들)의 워크아이템을 제거한다(lane rm 의 유령 정리, F-02). 대소문자
 * 무시. 현재(top-level) 워크아이템이 대상이면 최상위를 비우고(workitem/phase/loop/criteria
 * 및 workitem* 스냅샷 필드 제거), 레지스트리 항목이면 그 키를 지운다. work done 과 달리
 * 기록을 남기지 않는다 — 레인의 실제 기록·state 는 삭제된 worktree(.awl/home)에 있었고,
 * root 의 이 항목은 삭제된 워크트리를 가리키는 유령이라 done 으로 보존할 이유가 없다.
 * 순수 함수. 바뀐 게 없으면 removed:false.
 */
export function removeWorkitemFromState(
  state: Record<string, unknown>,
  ids: string[],
): { state: Record<string, unknown>; removed: boolean } {
  const migrated = migrateState(state);
  const wanted = new Set(ids.map((s) => s.trim().toLowerCase()).filter(Boolean));
  if (wanted.size === 0) {
    return { state: migrated, removed: false };
  }
  let next = migrated;
  let removed = false;

  // 최상위(현재) 워크아이템이 대상이면 비운다(archive 아님 — 유령은 보존하지 않는다).
  const currentId = typeof migrated.workitem === 'string' ? migrated.workitem : null;
  if (currentId && wanted.has(currentId.toLowerCase())) {
    const {
      workitem: _w,
      phase: _p,
      loop: _l,
      criteria: _c,
      workitemBranch: _b,
      workitemCreatedAt: _ca,
      workitemDescription: _d,
      raw_request: _rr,
      currentFocus: _cf,
      workitemWorktreePath: _wtp,
      workitemExperiment: _we,
      ...rest
    } = next;
    next = { ...rest, workitem: null, phase: null, loop: null, criteria: [] };
    removed = true;
  }

  // 레지스트리 항목이 대상이면 지운다(무관한 다른 워크아이템은 보존).
  const registry = registryOf(next);
  const hitKeys = Object.keys(registry).filter((k) => wanted.has(k.toLowerCase()));
  if (hitKeys.length > 0) {
    const nextRegistry = { ...registry };
    for (const k of hitKeys) {
      delete nextRegistry[k];
    }
    next = { ...next, workitems: nextRegistry };
    removed = true;
  }

  return { state: next, removed };
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
export function sanitizeForGit(s: string): string {
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
export async function removeGitWorktree(
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

/** target 을 .gitignore 에 추가한다(없으면). init.ts 의 ensureGitignore 와 같은 패턴. */
function ensureGitignored(root: string, target: string): void {
  const gi = path.join(root, '.gitignore');
  const content = fs.existsSync(gi) ? fs.readFileSync(gi, 'utf8') : '';
  if (content.split(/\r?\n/).some((line) => line.trim() === target)) {
    return;
  }
  const prefix = content.length > 0 && !content.endsWith('\n') ? '\n' : '';
  fs.writeFileSync(gi, `${content}${prefix}${target}\n`);
}

/**
 * 루프 시작 비용 스냅샷을 state 에 병합한다(loop-completion-stats AC-03). cc-usage.json 이
 * 없으면(statusline 미설치) state 를 그대로 둔다(graceful — 요약이 비용 줄 생략). usagePath
 * 기본값은 DEFAULT_USAGE_PATH — 테스트만 override 한다(프로덕션 동작 불변). loop-summary 의
 * startCostOf 가 이 costAtStart 를 읽어 computeCostDelta 를 낸다(write↔read 계약, G-051).
 */
export function withCostAtStart(
  state: Record<string, unknown>,
  usagePath: string = DEFAULT_USAGE_PATH,
): Record<string, unknown> {
  const costAtStart = readCostSnapshot(usagePath);
  return costAtStart ? { ...state, costAtStart } : state;
}

export async function runWorkNew(
  id: string,
  description: string | undefined,
  opts: {
    worktree?: string | boolean;
    skipBaseline?: boolean;
    isolated?: boolean;
    experiment?: Record<string, unknown>;
  } = {},
): Promise<void> {
  const root = requireRoot();
  const now = new Date().toISOString();
  const branch = await gitBranch(root);

  // worktree 경로/브랜치를 먼저 계산한다 — precheck 이 어느 state 를 볼지(root vs 레인
  // worktree)가 worktreePath 에 달렸다. 실제 git worktree 생성은 precheck 뒤로 미룬다.
  let worktreePath: string | undefined;
  let branchName: string | undefined;
  if (opts.worktree) {
    branchName = typeof opts.worktree === 'string' ? opts.worktree : `work/${sanitizeForGit(id)}`;
    worktreePath = path.join(root, '.awl-worktrees', sanitizeForGit(id));
  }

  // 격리 레인(worktree+isolated)의 state 는 그 워크트리에 둔다(F-02/F-03). 레인은
  // findProjectRoot 가 자기 자신을 root 로 해석하는 독립 워크트리라, root state 를
  // 건드리면 root 의 현재 워크아이템이 조용히 pause 되고(F-03) 삭제 후 유령이 남는다
  // (F-02). isolated 레인만 해당 — 일반 --worktree(비isolated)·비worktree 는 root
  // state 그대로다(회귀 없음: work new --worktree 는 여전히 root 의 현재를 전환한다).
  const stateRoot = opts.isolated && worktreePath ? worktreePath : root;

  // 먼저 검증한다(리뷰 지적 AC-06 — 실제 버그였다). git worktree/브랜치를 실제로
  // 만들기 전에 ID 가 유효한지(중복 아님 등) 확인해야, 검증에 실패했을 때
  // orphan 워크트리/브랜치가 안 남는다. createWorkitem 은 순수 함수라 이 사전
  // 검증 호출은 아무 부작용도 없다. 레인이면 아직 없는 worktree state(=빈 state)를 본다.
  const precheck = createWorkitem(loadState(stateRoot), id, now, branch, description);
  if (precheck.error) {
    process.stderr.write(`\n  ${precheck.error}\n`);
    process.exit(1);
  }

  if (opts.worktree && worktreePath && branchName) {
    const created = await createGitWorktree(root, worktreePath, branchName);
    if (!created.ok) {
      process.stderr.write(`\n  워크트리를 만들지 못했습니다: ${created.error}\n`);
      process.exit(1);
    }
    ensureGitignored(root, '.awl-worktrees/');
  }

  // --isolated(concurrency-2): 이 워크아이템 전용 AWL_HOME 을 만든다. records(~/.awl)는
  // AWL_HOME 파생이라, worktree(state 격리) + 이 전용 home(records 격리)이 합쳐지면
  // 병렬 루프가 완전히 나뉜다. 미래 셸 env 는 못 바꾸므로 경로만 만들고 export 를
  // 안내한다(실제 격리는 세션이 그 export 를 적용할 때 발생). --worktree 와 함께 쓰면
  // 워크트리별 경로라 두 세션이 같은 home 을 공유하지 않는다.
  let isolatedHome: string | undefined;
  if (opts.isolated) {
    isolatedHome = path.join(worktreePath ?? root, '.awl', 'home');
    fs.mkdirSync(isolatedHome, { recursive: true });
    // 생성 시점(AWL_HOME 오버라이드 전)의 부모 전역을 마커로 남긴다 — teardown 이 이 값을
    // 목적지로 읽어 격리 학습을 전역으로 병합한다(teardown 시점 env 에 의존하지 않음).
    writeParentMarker(isolatedHome);
    // .awl-worktrees/ 와 같은 이중 방어: gitignore(여기) + commit self-filter(commit.ts).
    // 패턴 .awl/home/ 은 root/.awl/home 과 워크트리 하위 .awl/home 을 모두 무시해,
    // awl 밖 표준 git 조작(git add -A/status)에도 records 가 안 새게 한다.
    ensureGitignored(root, '.awl/home/');
  }

  const result = createWorkitem(
    loadState(stateRoot),
    id,
    now,
    branch,
    description,
    worktreePath,
    opts.experiment,
  );
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
  // 루프 시작 비용 스냅샷(loop-completion-stats AC-03) — 완료 요약이 루프 경계
  // cost diff 를 낼 수 있게 던지기 시점 cost 를 state 에 남긴다. 던지기 경계는
  // workitemCreatedAt 과 같다(evolve 가 durationMs 시작점으로 쓰는 것과 같은 경계).
  const stateToWrite = withCostAtStart(result.state);
  writeState(stateRoot, stateToWrite);
  const c = caps();
  const color = makeColors(c.color);
  process.stdout.write(`\n${feedback(c, 'ok', `워크아이템 생성  ${color.bold(id)}`)}\n`);
  if (worktreePath) {
    process.stdout.write(`    ${color.dim(`워크트리  ${worktreePath}`)}\n`);
    // 워크트리에 engine Claude 스킬을 재설치한다(pipeline-lane-skill-reinstall AC-01).
    // .claude/ 는 gitignore(.gitignore) 라 worktree 체크아웃에 안 따라온다 —
    // 이 워크트리 세션이 awl-loop 등 파이프라인 스킬을 로드하려면 루트에 직접 깔아야 한다.
    // installClaudeSkill 은 이미 projectRoot 파라미터화+engine 전 스킬 순회라 호출만 하면 된다.
    // best-effort(AC-02): 재설치 실패가 워크트리·workitem 생성을 롤백/중단시키지 않는다.
    // engine 원본 부재는 throw 가 아니라 false 반환이라(claudeSkillNames 가 readdir 에러를
    // 삼킨다), false 와 예외 양쪽 모두 경고 1줄로 처리한다 — 워크트리는 이미 생성 완료다.
    try {
      if (installClaudeSkill(worktreePath)) {
        process.stdout.write(`    ${color.dim('스킬 재설치  .claude/skills/ (engine)')}\n`);
      } else {
        process.stderr.write(
          `\n${feedback(c, 'warn', '워크트리 스킬 재설치 생략', 'engine 스킬 원본을 찾지 못했습니다 — 이 워크트리에서 awl init 로 수동 설치하세요')}\n`,
        );
      }
    } catch (e) {
      process.stderr.write(
        `\n${feedback(c, 'warn', '워크트리 스킬 재설치 실패', `${String(e)} — 이 워크트리에서 awl init 로 수동 설치하세요`)}\n`,
      );
    }
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
      `    ${color.dim('--skip-baseline: 검증 베이스라인 생략 (나중에 awl verify --since-baseline 을 못 씁니다)')}\n`,
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
          `    ${color.dim(`검증 베이스라인 저장  ${report.results.map((r) => `${r.name}:${isCheckPassed(r) ? '통과' : '실패'}`).join(', ')}`)}\n`,
        );
      } catch (e) {
        // 베이스라인은 부가 기능이다 — 저장이 실패해도(디스크/권한 등) 워크아이템
        // 생성 자체는 이미 끝났으니 크래시시키지 않는다(WI-H 스파이크 지적, AC-03).
        process.stderr.write(
          `\n${feedback(c, 'warn', '검증 베이스라인 저장 실패', `${String(e)} — 나중에 awl verify --since-baseline 을 못 씁니다`)}\n`,
        );
      }
    } else {
      process.stdout.write(
        `    ${color.dim('config 없음 — 검증 베이스라인 생략 (나중에 awl verify --since-baseline 을 못 씁니다)')}\n`,
      );
    }
  }

  process.stdout.write(
    `    ${color.dim(worktreePath ? `다음 → cd ${worktreePath} 후 awl-loop 시작` : '다음 → awl-loop 시작')}\n`,
  );
  if (isolatedHome) {
    // --isolated: records 격리용 전용 home. 셸 env 는 못 바꾸므로 export 를 안내한다.
    process.stdout.write(`    ${color.dim(`export AWL_HOME=${isolatedHome}`)}\n`);
    process.stdout.write(
      `    ${color.dim('(records 를 이 워크아이템 전용으로 격리 — 실제 격리는 이 export 를 적용해야 발생합니다)')}\n`,
    );
  } else if (worktreePath) {
    // 병렬 세션 방어(concurrency-1): worktree 는 git(워킹트리+state)만 격리한다.
    // records(~/.awl)는 AWL_HOME 파생이라 전역 공유로 남는다 — 병렬 세션이 같은
    // 프로젝트를 돌리면 records 가 뒤섞인다. AWL_HOME 분리나 --isolated 로 나뉜다.
    process.stdout.write(
      `    ${color.dim('참고 → worktree 는 git 만 격리합니다. records(~/.awl)는 전역 공유이니, 병렬 세션이면 AWL_HOME 을 따로 두거나 --isolated 를 쓰세요.')}\n`,
    );
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
  const c = caps();
  process.stdout.write(`\n${feedback(c, 'ok', `전환  ${id}`)}\n`);
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
  const c = caps();
  process.stdout.write(
    `\n${feedback(c, 'ok', `중단 처리  ${id}`, '기록은 남아 있습니다 (삭제되지 않습니다)')}\n`,
  );
}

/**
 * 워크트리 디렉토리를 제거한다(work done). 두 가지가 removeGitWorktree 와 다르다(F-5):
 *  - 브랜치는 지우지 않는다 — 미푸시 커밋이 있어도 유실되지 않게 한다.
 *  - untracked 산출물(.venv·빌드물 등)은 완료된 워크트리에 정상적으로 쌓이므로, force
 *    없이도 tracked 미커밋 변경만 검사해 없으면 제거한다(untracked 까지 지우려면 git 이
 *    --force 를 요구하므로 실제 remove 는 --force 로 한다). tracked 미커밋 변경이 있으면
 *    거부하고 호출부가 --force 를 안내한다 — force=true 면 그 검사도 건너뛴다.
 */
/**
 * 워크트리의 tracked 미커밋 변경을 조사한다(untracked 산출물은 무시). work done
 * 과 lane rm 이 "더러운 트리는 force 없이 제거하지 않는다"를 같은 기준으로 판정하려
 * 공유한다(F-04) — 중복 로직을 두 곳에 두지 않는다.
 */
export async function worktreeDirtyTracked(
  root: string,
  targetPath: string,
): Promise<{ dirty: boolean; count: number; first?: string }> {
  const status = await run({
    cmd: 'git',
    args: ['-C', targetPath, 'status', '--porcelain', '--untracked-files=no'],
    cwd: root,
    timeoutMs: 10_000,
  });
  const lines = status.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  return { dirty: lines.length > 0, count: lines.length, first: lines[0] };
}

async function removeWorktreeDir(
  root: string,
  targetPath: string,
  force: boolean,
): Promise<{ ok: boolean; error?: string }> {
  if (!force) {
    // tracked 미커밋 변경만 본다(untracked 산출물은 완료 워크트리에 정상이라 무시).
    const d = await worktreeDirtyTracked(root, targetPath);
    if (d.dirty) {
      return { ok: false, error: `커밋되지 않은 변경 ${d.count}건 (예: ${d.first})` };
    }
  }
  // untracked 산출물까지 정리하려면 --force 가 필요하다(git worktree remove 는 untracked 도 거부).
  const r = await run({
    cmd: 'git',
    args: ['worktree', 'remove', '--force', targetPath],
    cwd: root,
    timeoutMs: 30_000,
  });
  if (r.exitCode !== 0) {
    return { ok: false, error: (r.stderr || r.stdout).trim() };
  }
  return { ok: true };
}

/**
 * awl work done <id> — 완료된 워크아이템을 정리한다(피드백 editor F-5). 완료 표시 +
 * state 스냅샷 회수(markWorkitemDone) 후, 워크트리가 있으면 제거를 먼저 시도하고
 * 성공해야 state 를 저장한다(워크트리는 못 지웠는데 done 으로 기록되는 불일치 방지).
 */
export async function runWorkDone(id: string, opts: { force?: boolean } = {}): Promise<void> {
  const root = requireRoot();
  const now = new Date().toISOString();
  const result = markWorkitemDone(loadState(root), id, now);
  if (result.error) {
    process.stderr.write(`\n  ${result.error}\n`);
    process.exit(1);
  }

  const c = caps();
  const color = makeColors(c.color);

  // 격리(.awl/home) 학습을 전역으로 병합한다 — 워크트리/홈 삭제·완료 전에. --isolated 는
  // worktree 유무로 홈 위치가 갈린다(work new): 워크트리 wi 는 worktree/.awl/home, 비워크트리
  // 격리 wi 는 root/.awl/home. 격리가 아니면(.awl/home 부재) no-op. 멱등이라 --force 재시도에도
  // 중복되지 않는다. 병합이 실패하면(전역 쓰기 오류 등) 깔끔히 중단해 학습을 보존한다 —
  // 삭제 전이라 재시도로 복구된다.
  let worktreeNote: string | null = null;
  let mergeNote: string | null = null;
  const isolatedHome = result.worktree
    ? path.join(result.worktree.path, '.awl', 'home')
    : path.join(root, '.awl', 'home');
  try {
    const merged = mergeIsolatedHome(isolatedHome);
    if (
      merged &&
      (merged.gotchasAdded > 0 || merged.rulesAdded > 0 || merged.generationsAdded > 0)
    ) {
      mergeNote = `학습 전역 병합  gotcha ${merged.gotchasAdded} · rule ${merged.rulesAdded} · generation ${merged.generationsAdded}`;
    }
  } catch (e) {
    process.stderr.write(
      `\n${feedback(c, 'error', '격리 학습 전역 병합 실패 — 완료를 중단합니다', e instanceof Error ? e.message : String(e))}\n`,
    );
    process.exit(1);
  }

  // 워크트리가 있으면 제거를 시도한다 — 성공해야 state 를 저장한다.
  if (result.worktree && fs.existsSync(result.worktree.path)) {
    const removed = await removeWorktreeDir(root, result.worktree.path, opts.force ?? false);
    if (!removed.ok) {
      process.stderr.write(
        `\n${feedback(c, 'warn', '워크트리를 정리하지 못했습니다', removed.error)}\n  정리되지 않은 변경을 확인하거나 awl work done ${id} --force 로 다시 시도하세요.\n  (브랜치는 지우지 않으므로 커밋된 작업은 안전합니다.)\n`,
      );
      process.exit(1);
    }
    worktreeNote = `워크트리 제거  ${result.worktree.path}`;
  }

  writeState(root, result.state);
  process.stdout.write(
    `\n${feedback(c, 'ok', `완료 처리  ${color.bold(id)}`, '상태 스냅샷을 회수했습니다 (기록은 남습니다)')}\n`,
  );
  if (worktreeNote) {
    process.stdout.write(`    ${color.dim(worktreeNote)}\n`);
  }
  if (mergeNote) {
    process.stdout.write(`    ${color.dim(mergeNote)}\n`);
  }
}
