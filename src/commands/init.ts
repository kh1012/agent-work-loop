import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { installedEngineVersion } from '../core/engine.js';
import { engineDir, globalRoot, projectsFile } from '../core/paths.js';
import { runInteractiveSelect } from '../core/select.js';
import {
  type Caps,
  type Colors,
  caps,
  card,
  makeColors,
  padEndDisplay,
  rawModeCapable,
  signal,
  stringWidth,
} from '../core/tty.js';

/**
 * awl init — 사용자가 처음 만나는 화면이자 유일한 튜토리얼.
 *
 * 감지·산출물 생성·파일 조작은 순수 함수로 분리해 테스트한다.
 * 대화형 껍데기(readline)는 얇게 두고, 실제 화면은 수동으로 시연한다.
 *
 * WI-2의 paths/tty 를 쓴다. 새 기반 코드는 만들지 않는다.
 */

// ---------------------------------------------------------------------------
// 타입
// ---------------------------------------------------------------------------

export type VerifyEntry = { cmd: string; cwd?: string; env?: Record<string, string> } | null;

export interface VerifyMap {
  typecheck: VerifyEntry;
  lint: VerifyEntry;
  test: VerifyEntry;
  e2e: VerifyEntry;
}

export interface InitInputs {
  project: string;
  mainLanguage: string;
  character: string;
  verify: VerifyMap;
  skills: { claude: boolean; codex: boolean };
}

export interface AwlConfig {
  project: string;
  mainLanguage: string;
  character: string;
  engineVersion: string;
  verify: VerifyMap;
  protectedFiles?: string[];
}

// ---------------------------------------------------------------------------
// 작은 파일 헬퍼 (크래시하지 않는다)
// ---------------------------------------------------------------------------

function exists(p: string): boolean {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

function readJson(p: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function writeFileEnsuringDir(p: string, content: string): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

// ---------------------------------------------------------------------------
// 자동 감지
// ---------------------------------------------------------------------------

/** 주 언어를 감지한다. 못 하면 null(=직접 입력). */
/** package.json 의 dependencies/devDependencies 에 typescript 가 있는가. */
function hasTypescriptDependency(pkg: unknown): boolean {
  if (typeof pkg !== 'object' || pkg === null) {
    return false;
  }
  const o = pkg as Record<string, unknown>;
  for (const field of ['dependencies', 'devDependencies']) {
    const deps = o[field];
    if (deps && typeof deps === 'object' && 'typescript' in deps) {
      return true;
    }
  }
  return false;
}

/**
 * YAML 줄에서 따옴표 밖의 `#` 이후를 주석으로 보고 잘라낸다. 리뷰에서 지적된
 * 결함: 예전엔 `#` 을 캡처 그룹에서 아예 제외해서, 인라인 주석이 붙은 줄
 * (`- 'packages/*'  # comment`)이 `$` 앵커 매치에 실패해 통째로 유실됐다.
 */
function stripYamlComment(line: string): string {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === quote) {
        quote = null;
      }
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === '#') {
      return line.slice(0, i);
    }
  }
  return line;
}

/**
 * pnpm-workspace.yaml 에서 워크스페이스 글롭을 뽑는다. YAML 파서 없이 흔한 두
 * 형태만 인식한다: block-style 리스트(`packages:\n  - 'a'`)와 flow-style
 * 배열(`packages: ['a']`). 풀 YAML 문법은 지원하지 않는다.
 */
function pnpmWorkspaceGlobs(cwd: string): string[] {
  const p = path.join(cwd, 'pnpm-workspace.yaml');
  if (!exists(p)) {
    return [];
  }
  const globs: string[] = [];
  try {
    const text = fs.readFileSync(p, 'utf8');
    for (const rawLine of text.split('\n')) {
      const line = stripYamlComment(rawLine);
      const flow = /^\s*packages\s*:\s*\[([^\]]*)\]\s*$/.exec(line);
      if (flow) {
        for (const item of (flow[1] ?? '').split(',')) {
          const v = item.trim().replace(/^['"]|['"]$/g, '');
          if (v) {
            globs.push(v);
          }
        }
        continue;
      }
      const bullet = /^\s*-\s*['"]?([^'"]+?)['"]?\s*$/.exec(line);
      if (bullet?.[1]) {
        globs.push(bullet[1].trim());
      }
    }
  } catch {
    // 못 읽으면 워크스페이스 없는 것으로 취급.
  }
  return globs;
}

/** package.json 의 workspaces 필드 또는 pnpm-workspace.yaml 에서 워크스페이스 글롭을 모은다. */
function workspaceGlobs(cwd: string, pkg: unknown): string[] {
  const globs: string[] = [];
  if (pkg && typeof pkg === 'object') {
    const w = (pkg as Record<string, unknown>).workspaces;
    if (Array.isArray(w)) {
      globs.push(...w.filter((x): x is string => typeof x === 'string'));
    } else if (w && typeof w === 'object') {
      const packages = (w as Record<string, unknown>).packages;
      if (Array.isArray(packages)) {
        globs.push(...packages.filter((x): x is string => typeof x === 'string'));
      }
    }
  }
  globs.push(...pnpmWorkspaceGlobs(cwd));
  return globs;
}

const MAX_GLOB_DEPTH = 6;

/** dirs 각각의 디렉토리 자식들(숨김·node_modules 제외)을 모은다. */
function listSubdirs(dirs: string[]): string[] {
  const next: string[] = [];
  for (const d of dirs) {
    try {
      for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
        if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
          next.push(path.join(d, entry.name));
        }
      }
    } catch {
      // 디렉토리가 없으면 건너뛴다.
    }
  }
  return next;
}

/** dirs 자신 + 그 아래 모든 깊이의 하위 디렉토리(최대 MAX_GLOB_DEPTH 단계). */
function listSelfAndDescendants(dirs: string[]): string[] {
  const all = [...dirs];
  let frontier = dirs;
  for (let depth = 0; depth < MAX_GLOB_DEPTH && frontier.length > 0; depth++) {
    frontier = listSubdirs(frontier);
    all.push(...frontier);
  }
  return all;
}

const GIT_SCAN_MAX_DEPTH = 3;
const GIT_SCAN_LIMIT = 20;

export interface GitProjectCandidate {
  path: string;
  name: string;
  mtimeMs: number;
}

/**
 * cwd 하위(자신 제외)에서 `.git` 을 가진 git 프로젝트 디렉토리를 스캔한다(init-project-picker).
 * maxDepth 단계까지만, node_modules·숨김 디렉토리 내부는 순회 제외, git 프로젝트를 만나면
 * 그 안으로는 더 안 들어간다(서브모듈 무시). 최근 수정(mtime) 내림차순, 최대 GIT_SCAN_LIMIT 개.
 * 순수(부작용 없음).
 */
export function scanGitProjects(
  root: string,
  maxDepth = GIT_SCAN_MAX_DEPTH,
): GitProjectCandidate[] {
  const found: GitProjectCandidate[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > maxDepth) {
      return;
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    // depth>0 인 디렉토리가 .git 을 가지면 후보다(cwd 자신은 AC-01 이 따로 처리).
    if (depth > 0 && entries.some((e) => e.name === '.git')) {
      let mtimeMs = 0;
      try {
        mtimeMs = fs.statSync(dir).mtimeMs;
      } catch {
        // stat 실패 시 0(맨 뒤로 정렬).
      }
      found.push({ path: dir, name: path.basename(dir), mtimeMs });
      return; // 프로젝트 안(서브모듈 등)으로는 더 안 들어간다.
    }
    for (const e of entries) {
      if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules') {
        walk(path.join(dir, e.name), depth + 1);
      }
    }
  };
  walk(root, 0);
  found.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return found.slice(0, GIT_SCAN_LIMIT);
}

/**
 * `<dir>/*` 와 `<dir>/**` 형태의 글롭을 펼친다(브레이스 확장 등 풀 글롭 문법은
 * 지원하지 않는다 — 워크스페이스 멤버 디렉토리를 찾는 용도로 이 정도면 충분하다).
 * `*` 는 한 단계, `**` 는 그 지점 자신을 포함해 모든 깊이의 하위 디렉토리를 뜻한다
 * (리뷰에서 지적된 결함: 예전엔 `**` 를 `*` 와 똑같이 한 단계만 확장해서 2단계
 * 이상 중첩된 워크스페이스 멤버를 조용히 놓쳤다).
 */
function expandSimpleGlob(cwd: string, glob: string): string[] {
  const parts = glob.split('/').filter(Boolean);
  let dirs = [cwd];
  for (const part of parts) {
    if (part === '**') {
      dirs = listSelfAndDescendants(dirs);
    } else if (part === '*') {
      dirs = listSubdirs(dirs);
    } else {
      dirs = dirs.map((d) => path.join(d, part)).filter((d) => exists(d));
    }
  }
  return [...new Set(dirs)];
}

/** 워크스페이스 멤버 중 하나라도 tsconfig.json 을 가졌는가. */
function anyWorkspaceMemberHasTsconfig(cwd: string, pkg: unknown): boolean {
  for (const glob of workspaceGlobs(cwd, pkg)) {
    for (const dir of expandSimpleGlob(cwd, glob)) {
      if (exists(path.join(dir, 'tsconfig.json'))) {
        return true;
      }
    }
  }
  return false;
}

/**
 * 주 언어를 감지한다. 못 하면 null(=직접 입력, buildScreens 가 index 0(typescript)을
 * 기본 선택으로 둔다 — "애매하면 TypeScript" 요구사항은 이 null 경로가 이미 만족한다).
 *
 * TypeScript 판정 신호는 세 가지다: 루트 tsconfig.json, package.json 의
 * dependencies/devDependencies 의 typescript, 워크스페이스 멤버의 tsconfig.json.
 * 모노레포에서 루트에 tsconfig 가 없어도(워크스페이스 멤버에만 있는 구성) TS 로
 * 오판되지 않게 하기 위해서다(WI-A).
 */
export function detectLanguage(cwd: string): string | null {
  if (exists(path.join(cwd, 'tsconfig.json'))) {
    return 'typescript';
  }
  const pkgPath = path.join(cwd, 'package.json');
  if (exists(pkgPath)) {
    const pkg = readJson(pkgPath);
    if (hasTypescriptDependency(pkg) || anyWorkspaceMemberHasTsconfig(cwd, pkg)) {
      return 'typescript';
    }
    return 'javascript';
  }
  if (
    exists(path.join(cwd, 'pyproject.toml')) ||
    exists(path.join(cwd, 'setup.py')) ||
    exists(path.join(cwd, 'requirements.txt'))
  ) {
    return 'python';
  }
  return null;
}

/**
 * 명령 문자열 앞의 인라인 환경변수(KEY=VAL ...)를 분리한다.
 * "NODE_ENV=test vitest run" -> { cmd: "vitest run", env: { NODE_ENV: "test" } }
 * env는 명령 문자열에 넣지 않는다(WI-2 runner 계약)는 원칙을 감지 단계에서 지킨다.
 */
export function splitEnv(script: string): { cmd: string; env?: Record<string, string> } {
  const env: Record<string, string> = {};
  let rest = script.trim();
  const re = /^(\w+)=(\S+)\s+/;
  let m = re.exec(rest);
  while (m !== null) {
    env[m[1] as string] = m[2] as string;
    rest = rest.slice(m[0].length);
    m = re.exec(rest);
  }
  return Object.keys(env).length > 0 ? { cmd: rest, env } : { cmd: rest };
}

/** package.json scripts 와 설정 파일에서 검증 명령을 감지한다. */
export function detectVerify(cwd: string): VerifyMap {
  const pkg = readJson(path.join(cwd, 'package.json'));
  const scripts: Record<string, unknown> =
    pkg && typeof pkg === 'object' && typeof (pkg as Record<string, unknown>).scripts === 'object'
      ? ((pkg as Record<string, Record<string, unknown>>).scripts ?? {})
      : {};

  const pick = (names: string[]): VerifyEntry => {
    for (const n of names) {
      const v = scripts[n];
      if (typeof v === 'string' && v.trim() !== '') {
        return splitEnv(v);
      }
    }
    return null;
  };

  const hasTsconfig = exists(path.join(cwd, 'tsconfig.json'));

  return {
    typecheck:
      pick(['typecheck', 'type-check', 'tsc']) ?? (hasTsconfig ? { cmd: 'tsc --noEmit' } : null),
    lint: pick(['lint']),
    test: pick(['test']),
    e2e: pick(['e2e', 'test:e2e']),
  };
}

/**
 * 워크스페이스 멤버 디렉토리 목록(프로젝트 루트 기준 상대경로, package.json 있는
 * 것만). 모노레포가 아니면 빈 배열. WI-A 의 workspaceGlobs/expandSimpleGlob 을
 * 재사용한다(언어 감지에 쓰던 것을 검증 명령 위치 찾기에도 그대로 쓴다).
 */
export function detectWorkspacePackages(cwd: string): string[] {
  const pkgPath = path.join(cwd, 'package.json');
  if (!exists(pkgPath)) {
    return [];
  }
  const pkg = readJson(pkgPath);
  const dirs = new Set<string>();
  for (const glob of workspaceGlobs(cwd, pkg)) {
    for (const dir of expandSimpleGlob(cwd, glob)) {
      if (exists(path.join(dir, 'package.json'))) {
        dirs.add(path.relative(cwd, dir));
      }
    }
  }
  return [...dirs].sort();
}

/** 4개 검증 항목이 전부 비어있는가(루트에서 아무 신호도 못 찾음 — 판단이 애매한 경우). */
function isVerifyEmpty(v: VerifyMap): boolean {
  return !v.typecheck && !v.lint && !v.test && !v.e2e;
}

// ---------------------------------------------------------------------------
// 산출물 빌드 (순수)
// ---------------------------------------------------------------------------

/** 입력으로부터 .awl/config.json 객체를 만든다. */
export function buildConfig(inputs: InitInputs, engineVersion: string): AwlConfig {
  return {
    project: inputs.project,
    mainLanguage: inputs.mainLanguage,
    character: inputs.character,
    engineVersion,
    verify: {
      typecheck: inputs.verify.typecheck,
      lint: inputs.verify.lint,
      test: inputs.verify.test,
      e2e: inputs.verify.e2e,
    },
  };
}

// ---------------------------------------------------------------------------
// 전역 설치 (~/.awl)
// ---------------------------------------------------------------------------

/** 패키지에 담긴 engine/ 디렉토리의 실제 위치. dev(src)와 prod(dist) 모두 대응. */
export function packageEngineDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const up of ['..', '../..']) {
    const candidate = path.join(here, up, 'engine');
    if (exists(path.join(candidate, 'version.json'))) {
      return candidate;
    }
  }
  return path.join(here, '..', 'engine');
}

export function isGlobalInstalled(): boolean {
  return exists(globalRoot());
}

/**
 * ~/.awl 골격을 만들고, 패키지에 든 최신 engine 템플릿을 복사한다.
 * `awl init` 재실행은 프로젝트 설정을 선택적으로 유지하면서도 홈 템플릿은
 * 갱신한다. 그래서 --version 이 안내하는 복구 경로가 실제 동작과 일치한다.
 */
export function scaffoldGlobal(): { created: boolean; engineVersion: string } {
  const root = globalRoot();
  const created = !exists(root);

  for (const dir of [
    'records',
    'gotchas',
    'rules',
    path.join('rules', 'active'),
    'templates',
    'generations',
  ]) {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
  }
  if (!exists(path.join(root, 'rules', 'index.json'))) {
    writeFileEnsuringDir(path.join(root, 'rules', 'index.json'), '[]\n');
  }
  if (!exists(path.join(root, 'rules', 'graduated.md'))) {
    writeFileEnsuringDir(path.join(root, 'rules', 'graduated.md'), '');
  }
  if (!exists(projectsFile())) {
    writeFileEnsuringDir(projectsFile(), '[]\n');
  }

  // engine 복사: 패키지의 engine/ -> ~/.awl/engine (init 재실행 시에도 최신화)
  fs.cpSync(packageEngineDir(), engineDir(), { recursive: true });

  return { created, engineVersion: installedEngineVersion() ?? 'unknown' };
}

// ---------------------------------------------------------------------------
// 프로젝트 산출물
// ---------------------------------------------------------------------------

export function writeConfig(projectRoot: string, config: AwlConfig): string {
  const p = path.join(projectRoot, '.awl', 'config.json');
  writeFileEnsuringDir(p, `${JSON.stringify(config, null, 2)}\n`);
  return p;
}

export function writeState(projectRoot: string, now: string): string {
  const p = path.join(projectRoot, '.awl', 'state.json');
  const state = { generation: 1, createdAt: now, loop: null };
  writeFileEnsuringDir(p, `${JSON.stringify(state, null, 2)}\n`);
  return p;
}

/**
 * .gitignore 에 awl 이 관리하는 항목을 추가한다. 이미 있는 항목은 건너뛴다.
 *  - `.awl/state.json`: 로컬 루프 상태(팀과 공유하지 않는다).
 *  - `.awl/verify-baseline.json`: work new 가 잡는 검증 베이스라인(로컬 전용). init 이
 *    미리 안 넣으면 나중에 verify 가 추가하면서 .gitignore 를 미커밋으로 남기고, 첫
 *    `awl commit` 이 그 변경을 "남의 것"으로 오인해 제외한다 — 그래서 init 이 한 번에 넣는다.
 *  - `.awl-worktrees/`: awl 이 `work new --worktree` 로 만드는 워크트리. gitignore 하지 않으면
 *    그 안의 파일들이 `commit --start` 의 untracked 스냅샷에 박혀 state.json 을 폭증시킨다
 *    (피드백 F-1 근원 차단 — commit.ts 의 코드 레벨 필터와 이중 방어).
 *  - `.awl-home/`: awl 이 `work new --isolated` 로 만드는 워크아이템 전용 records home.
 *    `.awl-worktrees/` 와 같은 이유로 이중 방어한다(commit self-filter + gitignore).
 * 하나라도 새로 추가하면 'added', 전부 이미 있으면 'exists' 를 돌려준다.
 */
export function ensureGitignore(projectRoot: string): 'added' | 'exists' {
  const gi = path.join(projectRoot, '.gitignore');
  const targets = [
    '.awl/state.json',
    '.awl/verify-baseline.json',
    '.awl/state.lock',
    '.awl-worktrees/',
    '.awl-home/',
  ];
  let content = exists(gi) ? fs.readFileSync(gi, 'utf8') : '';
  const has = (t: string): boolean => content.split(/\r?\n/).some((line) => line.trim() === t);
  const missing = targets.filter((t) => !has(t));
  if (missing.length === 0) {
    return 'exists';
  }
  for (const target of missing) {
    const prefix = content.length > 0 && !content.endsWith('\n') ? '\n' : '';
    content = `${content}${prefix}${target}\n`;
  }
  fs.writeFileSync(gi, content);
  return 'added';
}

/** 정적 템플릿을 설치한다. 기존 사용자 훅은 덮어쓰지 않고 경고만 돌린다. */
export function installSafetyHook(projectRoot: string): { installed: boolean; warning?: string } {
  try {
    const hook = path.join(projectRoot, '.git', 'hooks', 'pre-push');
    if (exists(hook))
      return { installed: false, warning: '기존 pre-push 훅이 있어 awl 훅을 덮어쓰지 않았습니다.' };
    const template = path.join(packageEngineDir(), 'templates', 'pre-push.sample');
    fs.mkdirSync(path.dirname(hook), { recursive: true });
    fs.cpSync(template, hook);
    fs.chmodSync(hook, 0o755);
    return { installed: true };
  } catch (error) {
    return { installed: false, warning: `push 차단 훅을 설치하지 못했습니다: ${String(error)}` };
  }
}

/** ~/.awl/projects.json 에 이 프로젝트를 등록한다. 같은 경로면 갱신한다. */
export function registerProject(entry: {
  name: string;
  path: string;
  mainLanguage: string;
  character: string;
  registeredAt: string;
}): number {
  const raw = readJson(projectsFile());
  const list: Record<string, unknown>[] = Array.isArray(raw)
    ? (raw as Record<string, unknown>[])
    : [];
  const idx = list.findIndex((p) => p.path === entry.path);
  if (idx >= 0) {
    list[idx] = { ...list[idx], ...entry };
  } else {
    list.push(entry);
  }
  writeFileEnsuringDir(projectsFile(), `${JSON.stringify(list, null, 2)}\n`);
  return list.length;
}

// ---------------------------------------------------------------------------
// 스킬 설치
// ---------------------------------------------------------------------------

/** Claude Code 스킬을 .claude/skills/awl-loop/ 에 설치한다. */
export function installClaudeSkill(projectRoot: string): boolean {
  const src = path.join(engineDir(), 'skills', 'claude', 'awl-loop');
  if (!exists(src)) {
    return false;
  }
  const dest = path.join(projectRoot, '.claude', 'skills', 'awl-loop');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(src, dest, { recursive: true });
  return true;
}

/** Codex 지침을 AGENTS.md 에 추가한다. 마커로 중복을 막는다. */
export function installCodexSkill(projectRoot: string): boolean {
  const src = path.join(engineDir(), 'skills', 'codex', 'AGENTS.awl.md');
  if (!exists(src)) {
    return false;
  }
  const snippet = fs.readFileSync(src, 'utf8');
  const agents = path.join(projectRoot, 'AGENTS.md');
  const current = exists(agents) ? fs.readFileSync(agents, 'utf8') : '';
  if (current.includes('awl-loop:start')) {
    return true; // 이미 추가됨
  }
  const prefix = current.length > 0 && !current.endsWith('\n') ? '\n' : '';
  fs.writeFileSync(agents, `${current}${prefix}${current.length > 0 ? '\n' : ''}${snippet}`);
  return true;
}

/** <project>/.awl/skills-version.json — 설치된 스킬(Claude/Codex)의 설치 시점 엔진 버전 (WI-X). */
export function skillsVersionPath(projectRoot: string): string {
  return path.join(projectRoot, '.awl', 'skills-version.json');
}

/**
 * 방금 설치한 스킬들의 설치 시점 엔진 버전을 기록한다(WI-X) — doctor/version-check 가
 * "설치된 스킬 vs 엔진" 쌍을 계산할 유일한 근거다. 기존 스탬프에 없던 스킬만 덮어쓴다
 * (예: claude 만 다시 설치해도 codex 의 기존 스탬프는 보존).
 */
export function writeSkillsVersionStamp(
  projectRoot: string,
  installed: { claude: boolean; codex: boolean },
  engineVersion: string,
): void {
  if (!installed.claude && !installed.codex) {
    return;
  }
  const p = skillsVersionPath(projectRoot);
  let current: Record<string, unknown> = {};
  try {
    current = JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown>;
  } catch {
    // 없거나 깨졌으면 새로 만든다.
  }
  const next = { ...current };
  if (installed.claude) {
    next.claude = engineVersion;
  }
  if (installed.codex) {
    next.codex = engineVersion;
  }
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, `${JSON.stringify(next, null, 2)}\n`);
}

/**
 * 이미 설정된 프로젝트를 재실행(그대로 쓰기)할 때 버전 마커를 설치된 엔진에 맞춰
 * 동기화한다(피드백 F-2). `config.engineVersion` 과 이미 설치된 스킬의
 * `skills-version.json` 을 갱신하고, 스킬 파일 자체도 재설치해 "마커만 올리고 내용은
 * 옛날" 인 거짓 동기화를 피한다. 설치 안 된 스킬은 새로 깔지 않는다(재실행이 멋대로
 * 스킬을 추가하지 않게 한다). 반환값은 무엇을 동기화했는지 — 로그용.
 */
export function syncExistingInstall(
  projectRoot: string,
  engineVersion: string,
): { configUpdated: boolean; skills: string[] } {
  // 1) config.engineVersion 만 엔진에 맞춘다(나머지 필드는 팀 설정이므로 보존).
  let configUpdated = false;
  const configPath = path.join(projectRoot, '.awl', 'config.json');
  const raw = readJson(configPath) as Record<string, unknown> | null;
  if (raw && raw.engineVersion !== engineVersion) {
    writeFileEnsuringDir(configPath, `${JSON.stringify({ ...raw, engineVersion }, null, 2)}\n`);
    configUpdated = true;
  }

  // 2) 이미 설치된 스킬만 재설치(내용 갱신)하고 마커를 동기화한다.
  const skills: string[] = [];
  const claudeSkillDir = path.join(projectRoot, '.claude', 'skills', 'awl-loop');
  if (exists(claudeSkillDir) && installClaudeSkill(projectRoot)) {
    skills.push('claude');
  }
  const agentsMd = path.join(projectRoot, 'AGENTS.md');
  const codexInstalled =
    exists(agentsMd) && fs.readFileSync(agentsMd, 'utf8').includes('awl-loop:start');
  if (codexInstalled && installCodexSkill(projectRoot)) {
    skills.push('codex');
  }
  writeSkillsVersionStamp(
    projectRoot,
    { claude: skills.includes('claude'), codex: skills.includes('codex') },
    engineVersion,
  );

  return { configUpdated, skills };
}

function countEntries(dir: string): number {
  try {
    return fs.readdirSync(dir).filter((f) => !f.startsWith('.')).length;
  } catch {
    return 0;
  }
}

/** 설치된 에이전트를 감지한다(.claude/, AGENTS.md). */
export function detectAgents(projectRoot: string): { claude: boolean; codex: boolean } {
  return {
    claude: exists(path.join(projectRoot, '.claude')),
    codex: exists(path.join(projectRoot, 'AGENTS.md')),
  };
}

/** --yes(비대화형)에서 쓸 입력. 자동 감지 기본값, 성격은 빈 문자열. */
export function nonInteractiveInputs(projectRoot: string): InitInputs {
  const detected = detectAgents(projectRoot);
  // --yes 는 자동 셋업이다. 아무 에이전트도 감지 안 되면(빈 프로젝트) 주 대상인
  // Claude 스킬을 기본 설치해 곧바로 /awl-loop 를 쓸 수 있게 한다 — 예전엔 감지된
  // 것만 깔아, 신규 프로젝트는 스킬 없이 셋업돼 "다음 단계: init 재실행" 으로 끊겼다.
  // .claude/ 는 gitignore 대상이라 로컬 설치로 안전하다. 감지되면 그대로 존중한다.
  const skills = detected.claude || detected.codex ? detected : { claude: true, codex: false };
  return {
    project: path.basename(projectRoot),
    mainLanguage: detectLanguage(projectRoot) ?? '',
    character: '',
    verify: detectVerify(projectRoot),
    skills,
  };
}

// ---------------------------------------------------------------------------
// 오케스트레이션 (모든 산출물 쓰기)
// ---------------------------------------------------------------------------

export interface InitResult {
  globalCreated: boolean;
  engineVersion: string;
  configPath: string;
  statePath: string;
  gitignore: 'added' | 'exists';
  skills: string[];
  projectCount: number;
  ruleCount: number;
  lessonCount: number;
  safetyHook: { installed: boolean; warning?: string };
}

export function applyInit(projectRoot: string, inputs: InitInputs, now: string): InitResult {
  const g = scaffoldGlobal();
  const config = buildConfig(inputs, g.engineVersion);
  const configPath = writeConfig(projectRoot, config);
  const statePath = writeState(projectRoot, now);
  const gitignore = ensureGitignore(projectRoot);
  const safetyHook = installSafetyHook(projectRoot);
  const projectCount = registerProject({
    name: inputs.project,
    path: projectRoot,
    mainLanguage: inputs.mainLanguage,
    character: inputs.character,
    registeredAt: now,
  });

  const skills: string[] = [];
  const claudeInstalled = inputs.skills.claude && installClaudeSkill(projectRoot);
  if (claudeInstalled) {
    skills.push('claude');
  }
  const codexInstalled = inputs.skills.codex && installCodexSkill(projectRoot);
  if (codexInstalled) {
    skills.push('codex');
  }
  writeSkillsVersionStamp(
    projectRoot,
    { claude: claudeInstalled, codex: codexInstalled },
    g.engineVersion,
  );

  return {
    globalCreated: g.created,
    engineVersion: g.engineVersion,
    configPath,
    statePath,
    gitignore,
    skills,
    projectCount,
    ruleCount: countEntries(path.join(globalRoot(), 'rules', 'active')),
    lessonCount: countEntries(path.join(globalRoot(), 'lessons')),
    safetyHook,
  };
}

// ---------------------------------------------------------------------------
// 렌더링 (tty 폴백 사용, ASCII 기본, 이모지 없음)
// ---------------------------------------------------------------------------

const WIDTH = 64;

/** 모든 init 화면을 같은 카드로 렌더한다. 고정 폭은 넓은 명령행도 정돈해 보이게
 * 하고, 내용이 더 길면 자연스럽게 확장한다. */
function stepBox(step: string, title: string, lines: string[], c: Caps): string {
  return card(`${step}${c.unicode ? ' · ' : ' - '}${title}`, lines, c, WIDTH - 4);
}

const VERIFY_LABELS: Record<keyof VerifyMap, string> = {
  typecheck: '타입체크',
  lint: '린트',
  test: '테스트',
  e2e: 'E2E',
};

/** 표시 폭(한글=2) 기준으로 오른쪽을 공백으로 채운다. */
function verifyLines(v: VerifyMap): string[] {
  const keys = Object.keys(VERIFY_LABELS) as (keyof VerifyMap)[];
  const labelWidth = Math.max(...keys.map((k) => stringWidth(VERIFY_LABELS[k]))) + 2;
  return keys.map((k) => {
    const entry = v[k];
    return `  ${padEndDisplay(VERIFY_LABELS[k], labelWidth)}${entry ? entry.cmd : '(없음)'}`;
  });
}

/**
 * "[2/3] 검증 명령어" 화면의 본문 줄들. buildScreens(루트 기준)와 interactiveInputs
 * 가 모노레포에서 패키지를 다시 골랐을 때(화면 재구성) 둘 다 이 함수로 만든다
 * (리뷰 지적 AC-09: 예전엔 리터럴 배열이 두 곳에 복사돼 있어 고치면 한쪽만 바뀌었다).
 */
export function verifyStepLines(v: VerifyMap): string[] {
  return [
    'package.json 등에서 찾았습니다. 맞으면 Enter, 고치려면 새로 입력.',
    '',
    ...verifyLines(v),
    '',
    '이 명령어들이 유일한 심판입니다.',
    'AI 가 "다 했습니다"라고 말할 수 없게 만드는 장치입니다.',
  ];
}

/** TTY 가 아닌데 --yes 없이 실행했을 때의 안내. */
export function renderNonTtyNotice(): string {
  return [
    '',
    '  awl init 은 화면에서 몇 가지를 물어봅니다.',
    '  지금은 대화형 화면을 띄울 수 없는 환경입니다(파이프/CI).',
    '',
    '  자동으로 진행하려면 --yes 를 붙이세요. 감지된 값으로 설정합니다.',
    '',
    '    awl init --yes',
    '',
  ].join('\n');
}

/** 마지막 결과 화면. 다음 행동 하나만 가리킨다. */
export function renderResult(result: InitResult, inputs: InitInputs, c: Caps): string {
  const color = makeColors(c.color);
  const line = (name: string, value: string, note = ''): string =>
    `  ${padEndDisplay(name, 20)}${value}${note ? `    ${color.dim(note)}` : ''}`;

  const setupLines: string[] = [];
  setupLines.push(line('~/.awl', result.globalCreated ? '생성됨' : '이미 있음'));
  setupLines.push(line('~/.awl/engine', result.engineVersion));
  setupLines.push(line('.awl/config.json', '생성됨', '<- 커밋하세요. 팀원은 이 파일을 씁니다'));
  setupLines.push(
    line(
      '.awl/state.json',
      result.gitignore === 'added' ? 'gitignore 에 추가함' : '이미 gitignore 에 있음',
      result.safetyHook.warning
        ? `${signal(c, 'warn')} ${result.safetyHook.warning}`
        : result.safetyHook.installed
          ? `${signal(c, 'ok')} git push 차단 훅 설치`
          : 'git push 차단 훅 이미 설치됨',
    ),
  );
  setupLines.push(
    color.dim(
      `규칙 ${result.ruleCount}개 · 교훈 ${result.lessonCount}개 · 등록된 프로젝트 ${result.projectCount}개 · 1세대`,
    ),
  );

  const nextLines: string[] = [];

  if (inputs.skills.claude) {
    nextLines.push('Claude Code 를 열고 이렇게 말하세요.');
    nextLines.push('');
    nextLines.push(`${color.bold('/awl-loop')}  페이지 편집기에 여백 시스템을 넣고 싶어`);
  } else if (inputs.skills.codex) {
    nextLines.push('Codex 에게 이렇게 말하세요.');
    nextLines.push('');
    nextLines.push(`${color.bold('/awl-loop')}  페이지 편집기에 여백 시스템을 넣고 싶어`);
  } else {
    nextLines.push('나중에 스킬을 설치하려면 awl init 을 다시 실행하세요.');
  }
  return [
    '',
    card('설정 완료', setupLines, c, WIDTH - 4),
    '',
    card('다음 단계', nextLines, c, WIDTH - 4),
  ].join('\n');
}

// ---------------------------------------------------------------------------
// 대화형 (readline). 화살표 raw-mode 대신 번호 입력을 쓴다(결정적·크로스 환경).
// ---------------------------------------------------------------------------

export const LANG_OPTIONS = ['TypeScript', 'JavaScript', 'Python', '직접 입력'];
export const LANG_VALUES = ['typescript', 'javascript', 'python', ''];

export interface InteractiveScreens {
  welcome: string | null;
  lang: string;
  verify: string;
  character: string;
  skills: string;
}

function langDefaultIndex(projectRoot: string): number {
  const detected = detectLanguage(projectRoot);
  const idx = detected ? LANG_VALUES.indexOf(detected) : 0;
  return idx < 0 ? 0 : idx;
}

/**
 * 대화형 각 화면을 렌더한다. 입력과 무관하게 결정적이므로, 실제 대화형과
 * 데모/보고가 똑같은 화면을 쓴다(화면이 코드와 따로 놀지 않게).
 */
export function buildScreens(projectRoot: string, hasGlobal: boolean, c: Caps): InteractiveScreens {
  const project = path.basename(projectRoot);
  const defLang = langDefaultIndex(projectRoot);
  const verify = detectVerify(projectRoot);
  const agents = detectAgents(projectRoot);

  const welcome = hasGlobal
    ? null
    : [
        '',
        '  ~/.awl 이 없습니다. 처음 오셨군요.',
        '',
        '  여러 프로젝트를 등록해서 Agent Work Loop 를 돌릴 수 있습니다.',
        '  이 프로젝트를 첫 번째로 등록합니다.',
        '',
        `    ${project}`,
        `    ${projectRoot}`,
        '',
        '  다른 프로젝트에서도 awl init 을 실행하면 그때 등록됩니다.',
        '  규칙과 교훈은 프로젝트가 아니라 당신에게 쌓이고,',
        '  등록된 모든 프로젝트에서 함께 쓰입니다.',
      ].join('\n');

  const langLines = [
    `자동 감지: ${LANG_OPTIONS[defLang] ?? 'TypeScript'}`,
    '',
    '바로 아래의 선택기에서 고릅니다.',
    '화살표 또는 j/k 로 이동하고 Enter 로 확정하세요.',
    '키 입력을 지원하지 않는 터미널에서는 번호를 입력할 수 있습니다.',
  ];

  return {
    welcome,
    lang: stepBox('1/3', '주 언어', langLines, c),
    verify: stepBox('2/3', '검증 명령어', verifyStepLines(verify), c),
    character: stepBox(
      '3/3',
      '규칙과 이 프로젝트의 성격',
      [
        '같은 실패가 쌓이면 규칙이 되고, 다음 프로젝트에도 전파됩니다.',
        '프로젝트의 성격은 그 규칙을 여기에도 적용할지 판단하는 근거입니다.',
        '',
        '이 프로젝트는 어떤 곳입니까?',
        '(예시: "React + TailwindCSS 웹 프론트엔드", "Python Fast API 분석 서버",',
        '       "TypeScript 라이브러리 패키지")',
      ],
      c,
    ),
    skills: stepBox(
      '스킬',
      '스킬 설치',
      [
        'awl 은 판단하지 않습니다. 파일과 상태만 관리합니다.',
        '판단은 이미 쓰고 계신 에이전트가 합니다.',
        '',
        '바로 아래에서 설치할 에이전트를 고릅니다.',
        '첫 번째 “모두 설치”를 고르거나, Space 로 필요한 항목만 고를 수 있습니다.',
        `감지됨: Claude Code ${agents.claude ? '있음' : '없음'} · Codex ${agents.codex ? '있음' : '없음'}`,
      ],
      c,
    ),
  };
}

/** readline 질문 하나를 Promise 로 감싼다. config 등 다른 명령의 대화형 편집도 재사용한다. */
export function ask(rl: readline.Interface, q: string): Promise<string> {
  return new Promise((resolve) => rl.question(q, (a) => resolve(a)));
}

/** 번호 입력을 받아 0-based 인덱스로 돌려준다. 빈 입력은 기본값. */
export async function promptNumber(
  rl: readline.Interface,
  defaultIndex: number,
  count: number,
): Promise<number> {
  const answer = (await ask(rl, `  번호 선택 (기본 ${defaultIndex + 1}): `)).trim();
  if (answer === '') {
    return defaultIndex;
  }
  const n = Number(answer);
  return Number.isInteger(n) && n >= 1 && n <= count ? n - 1 : defaultIndex;
}

/**
 * 단일선택 하나를 받는다(WI-Y) — useRawMode 면 방향키 실시간 선택, 아니면
 * 기존 번호 입력(promptNumber)으로 폴백한다. useRawMode 는 호출부가
 * rawModeCapable() 로 실제 감지해 넘긴다(이 함수는 주입받은 값만 본다 —
 * 테스트가 실제 터미널 없이도 두 경로를 다 검증할 수 있게).
 */
export async function selectSingle(
  rl: readline.Interface,
  options: string[],
  defaultIndex: number,
  c: Caps,
  useRawMode: boolean,
  title = '선택',
): Promise<number> {
  if (useRawMode) {
    const result = await runInteractiveSelect(options, defaultIndex, false, c, [], {
      title,
      hint: '↑↓ 또는 j/k 이동 · Enter 선택 · Esc 기본값 유지',
    });
    return result?.index ?? defaultIndex;
  }
  for (let i = 0; i < options.length; i++) {
    process.stdout.write(`    ${i + 1}. ${options[i]}${i === defaultIndex ? ' (기본)' : ''}\n`);
  }
  return promptNumber(rl, defaultIndex, options.length);
}

/**
 * 다중선택을 받는다(WI-Y) — useRawMode 면 방향키+Space 토글 실시간 선택,
 * 아니면 기존 쉼표 구분 번호 입력으로 폴백한다.
 */
export async function selectMulti(
  rl: readline.Interface,
  options: string[],
  defaultChecked: number[],
  c: Caps,
  useRawMode: boolean,
  title = '선택',
  selectAllIndex?: number,
): Promise<number[]> {
  if (useRawMode) {
    const result = await runInteractiveSelect(options, 0, true, c, defaultChecked, {
      title,
      hint: '↑↓ 또는 j/k 이동 · Space 선택 · Enter 확정 · Esc 기본값 유지',
      selectAllIndex,
    });
    return result?.checked ?? defaultChecked;
  }
  for (let i = 0; i < options.length; i++) {
    process.stdout.write(
      `    ${i + 1}. ${options[i]}${defaultChecked.includes(i) ? ' (기본 선택)' : ''}\n`,
    );
  }
  const def = defaultChecked
    .slice()
    .sort((a, b) => a - b)
    .map((i) => String(i + 1))
    .join(',');
  const answer = (await ask(rl, `  포함할 번호를 쉼표로 (기본 ${def || '없음'}): `)).trim();
  const chosen = (answer === '' ? def : answer)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => Number(s) - 1)
    .filter((n) => Number.isInteger(n) && n >= 0 && n < options.length);
  return chosen;
}

export interface VerifyLocationResult {
  verify: VerifyMap;
  /** 패키지를 골랐으면 그 상대경로. verify 각 항목의 cwd 로 쓴다. */
  cwd?: string;
}

/**
 * 모노레포면 워크스페이스 패키지를 보여주고 검증 위치를 물어본다(WI-B).
 * 판단이 어려우면(루트에서 신호를 하나도 못 찾았으면) 묻는다. 판단이 쉬우면
 * (루트에 이미 검증 명령이 있으면) 묻지 않고 안내만 하고 루트 기준을 유지한다.
 */
export async function promptVerifyLocation(
  rl: readline.Interface,
  projectRoot: string,
  rootVerify: VerifyMap,
  color: Colors,
): Promise<VerifyLocationResult> {
  const packages = detectWorkspacePackages(projectRoot);
  if (packages.length === 0) {
    return { verify: rootVerify };
  }
  if (!isVerifyEmpty(rootVerify)) {
    process.stdout.write(
      `\n  ${color.dim(`모노레포입니다(${packages.length}개 패키지). 특정 패키지만 검증하려면 나중에 awl config set verify.*.cwd 로 지정하세요.`)}\n`,
    );
    return { verify: rootVerify };
  }
  process.stdout.write(
    '\n  모노레포로 보이는데 루트에서 검증 명령을 못 찾았습니다. 어느 패키지를 검증할까요?\n\n',
  );
  const options = ['루트(전체, 검증 명령 없이 둠)', ...packages];
  for (let i = 0; i < options.length; i++) {
    process.stdout.write(`    ${i + 1}  ${options[i]}\n`);
  }
  const idx = await promptNumber(rl, 0, options.length);
  if (idx === 0) {
    return { verify: rootVerify };
  }
  const chosen = packages[idx - 1] as string;
  return { verify: detectVerify(path.join(projectRoot, chosen)), cwd: chosen };
}

/**
 * cwd 가 있으면 verify 의 null 아닌 모든 항목에 적용한다(그 자리에서 수정하고
 * 그대로 돌려준다). 사용자가 각 항목의 명령을 새로 입력해 바꾼 뒤에 호출해도
 * 안전하다 — 순서와 무관하게 그 시점의 verify 스냅샷 전체에 적용되기 때문이다.
 * (리뷰 지적: 예전엔 interactiveInputs 안에 인라인으로만 있어 테스트가 전혀
 * 없었다. 별도 함수로 뽑아 직접 테스트한다 — 인자를 mutate 하므로 순수 함수는
 * 아니다. 반환값은 편의상 같은 참조다.)
 */
export function applyVerifyCwd(verify: VerifyMap, cwd: string | undefined): VerifyMap {
  if (!cwd) {
    return verify;
  }
  for (const k of Object.keys(verify) as (keyof VerifyMap)[]) {
    const entry = verify[k];
    if (entry) {
      entry.cwd = cwd;
    }
  }
  return verify;
}

async function interactiveInputs(
  projectRoot: string,
  hasGlobal: boolean,
  c: Caps,
): Promise<InitInputs> {
  const screens = buildScreens(projectRoot, hasGlobal, c);
  const project = path.basename(projectRoot);
  const useRawMode = rawModeCapable();
  const session: { rl: readline.Interface | null } = { rl: null };
  const prompt = (): readline.Interface => {
    if (!session.rl) {
      session.rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    }
    return session.rl;
  };

  try {
    // 1. 프로젝트 등록 안내
    if (screens.welcome) {
      process.stdout.write(`${screens.welcome}\n`);
    }

    // readline은 raw-mode 키 입력을 동시에 읽어 화면을 망가뜨린다. 따라서 첫
    // 선택기는 readline을 만들기 전에 실행하고, 이후 텍스트 질문 때만 만든다.
    process.stdout.write(`\n${screens.lang}\n`);
    const rawLanguage = useRawMode
      ? await runInteractiveSelect(LANG_OPTIONS, langDefaultIndex(projectRoot), false, c, [], {
          title: '주 언어',
          hint: '↑↓ 또는 j/k 이동 · Enter 선택 · Esc 기본값 유지',
        })
      : null;
    const langIdx =
      rawLanguage?.index ??
      (useRawMode
        ? langDefaultIndex(projectRoot)
        : await selectSingle(
            prompt(),
            LANG_OPTIONS,
            langDefaultIndex(projectRoot),
            c,
            false,
            '주 언어',
          ));
    let mainLanguage = LANG_VALUES[langIdx] ?? '';
    if (langIdx === LANG_OPTIONS.length - 1) {
      mainLanguage = (await ask(prompt(), '  주 언어를 입력하세요: ')).trim();
    }

    // 3. [2/3] 검증 명령어 (WI-B: 모노레포면 워크스페이스 패키지를 물어볼 수 있다)
    const rootVerify = detectVerify(projectRoot);
    const located = await promptVerifyLocation(
      prompt(),
      projectRoot,
      rootVerify,
      makeColors(c.color),
    );
    const verify = located.verify;
    if (located.cwd) {
      // 패키지를 새로 골랐으면 그 패키지에서 감지한 값으로 화면도 다시 그린다.
      process.stdout.write(`\n${stepBox('2/3', '검증 명령어', verifyStepLines(verify), c)}\n`);
    } else {
      process.stdout.write(`\n${screens.verify}\n`);
    }
    for (const k of Object.keys(VERIFY_LABELS) as (keyof VerifyMap)[]) {
      const cur = verify[k];
      const shown = cur ? cur.cmd : '(없음)';
      const answer = (await ask(prompt(), `  ${VERIFY_LABELS[k]} [${shown}]: `)).trim();
      if (answer !== '') {
        verify[k] = answer.toLowerCase() === '없음' || answer === '-' ? null : splitEnv(answer);
      }
    }
    applyVerifyCwd(verify, located.cwd);

    // 3. [3/3] 규칙과 프로젝트 성격
    process.stdout.write(`\n${screens.character}\n`);
    const character = (await ask(prompt(), '  > ')).trim();

    // 6. 마지막 선택기만 다시 raw-mode를 쓸 수 있다. readline을 먼저 완전히 닫아
    // stdin의 유일한 소비자가 선택기라는 것을 보장한다.
    process.stdout.write(`\n${screens.skills}\n`);
    const agents = detectAgents(projectRoot);
    const skillOptions = [
      '모두 설치 (Claude Code + Codex)',
      'Claude Code (.claude/skills/awl-loop/ 에 설치)',
      'Codex (AGENTS.md 에 추가)',
    ];
    const defaultChecked =
      agents.claude && agents.codex
        ? [0, 1, 2]
        : [agents.claude ? 1 : -1, agents.codex ? 2 : -1].filter((i) => i >= 0);
    if (useRawMode && session.rl) {
      session.rl.close();
      session.rl = null;
    }
    const rawSkills = useRawMode
      ? await runInteractiveSelect(skillOptions, 0, true, c, defaultChecked, {
          title: '설치할 에이전트 스킬',
          hint: '↑↓ 또는 j/k 이동 · Space 선택 · Enter 확정 · Esc 기본값 유지',
          selectAllIndex: 0,
        })
      : null;
    const checked =
      rawSkills?.checked ??
      (useRawMode
        ? defaultChecked
        : await selectMulti(
            prompt(),
            skillOptions,
            defaultChecked,
            c,
            false,
            '설치할 에이전트 스킬',
            0,
          ));
    const installAll = checked.includes(0);
    const skills = {
      claude: installAll || checked.includes(1),
      codex: installAll || checked.includes(2),
    };

    return { project, mainLanguage, character, verify, skills };
  } finally {
    session.rl?.close();
  }
}

/** 이미 config가 있을 때의 짧은 확인 흐름. */
async function handleExistingConfig(
  rl: readline.Interface,
  projectRoot: string,
  c: Caps,
  now: string,
): Promise<void> {
  const raw = readJson(path.join(projectRoot, '.awl', 'config.json'));
  const config = raw as Partial<AwlConfig> | null;
  scaffoldGlobal();
  const installedVer = installedEngineVersion();

  process.stdout.write('\n  .awl/config.json 이 이미 있습니다. 팀원이 설정해두었군요.\n\n');
  process.stdout.write(`    프로젝트   ${config?.project ?? '(없음)'}\n`);
  process.stdout.write(`    주 언어    ${config?.mainLanguage ?? '(없음)'}\n`);
  process.stdout.write(`    성격       ${config?.character || '(없음)'}\n`);
  const engineNote =
    installedVer && config?.engineVersion
      ? installedVer === config.engineVersion
        ? `(설치됨: ${installedVer}  일치)`
        : `(설치됨: ${installedVer}  불일치 -> '그대로 쓴다'를 고르면 동기화됩니다)`
      : '';
  process.stdout.write(`    엔진       ${config?.engineVersion ?? '(없음)'}   ${engineNote}\n\n`);
  if (config?.verify) {
    for (const line of verifyLines(config.verify as VerifyMap)) {
      process.stdout.write(`    검증  ${line.trim()}\n`);
    }
    process.stdout.write('\n');
  }
  process.stdout.write('  이 설정을 그대로 쓰시겠습니까?\n\n');

  const options = ['그대로 쓴다', '검증 명령어만 고친다', '처음부터 다시'];
  process.stdout.write(
    `${card(
      '기존 설정',
      options.map((option, i) => `${i + 1}. ${option}`),
      c,
    )}\n`,
  );
  const choice = await promptNumber(rl, 0, options.length);

  process.stdout.write(
    `\n  ${makeColors(c.color).dim('규칙과 교훈은 공유되지 않습니다. 저 설정만 팀원과 같고, 쌓이는 것은 당신 것입니다.')}\n`,
  );

  if (choice === 0) {
    const synced = syncExistingInstall(projectRoot, installedVer ?? 'unknown');
    if (synced.configUpdated || synced.skills.length > 0) {
      process.stdout.write(
        `\n  설정을 그대로 씁니다. 버전 마커를 ${installedVer ?? '엔진'} 로 동기화했습니다${synced.skills.length ? ` (스킬: ${synced.skills.join(', ')})` : ''}.\n`,
      );
    } else {
      process.stdout.write('\n  설정을 그대로 씁니다. 이미 최신입니다.\n');
    }
    return;
  }
  if (choice === 1) {
    const verify = (config?.verify as VerifyMap) ?? detectVerify(projectRoot);
    for (const k of Object.keys(VERIFY_LABELS) as (keyof VerifyMap)[]) {
      const cur = verify[k];
      const shown = cur ? cur.cmd : '(없음)';
      const answer = (await ask(rl, `  ${VERIFY_LABELS[k]} [${shown}]: `)).trim();
      if (answer !== '') {
        verify[k] = answer.toLowerCase() === '없음' || answer === '-' ? null : splitEnv(answer);
      }
    }
    const merged: InitInputs = {
      project: config?.project ?? path.basename(projectRoot),
      mainLanguage: config?.mainLanguage ?? '',
      character: config?.character ?? '',
      verify,
      skills: { claude: false, codex: false },
    };
    writeConfig(projectRoot, buildConfig(merged, installedVer ?? 'unknown'));
    process.stdout.write('\n  검증 명령어를 갱신했습니다.\n');
    return;
  }
  // 처음부터 다시
  // raw-mode 선택기와 readline이 경쟁하지 않게 기존 인터페이스를 닫는다.
  rl.close();
  const inputs = await interactiveInputs(projectRoot, isGlobalInstalled(), c);
  const result = applyInit(projectRoot, inputs, now);
  process.stdout.write(`\n${renderResult(result, inputs, c)}\n`);
}

// ---------------------------------------------------------------------------
// 진입점
// ---------------------------------------------------------------------------

export type ProjectChoice = { kind: 'path'; path: string } | { kind: 'type' } | { kind: 'cancel' };

/**
 * 프로젝트 선정 셀렉터의 인덱스를 후보 목록에 대해 해석한다(순수 — 오프바이원 방지).
 * 0..n-1 = 후보, n = 직접 경로 입력, 그 외 = 취소.
 */
export function resolveProjectChoice(
  idx: number,
  candidates: GitProjectCandidate[],
): ProjectChoice {
  if (idx >= 0 && idx < candidates.length) {
    return { kind: 'path', path: candidates[idx]?.path ?? '' };
  }
  if (idx === candidates.length) {
    return { kind: 'type' };
  }
  return { kind: 'cancel' };
}

/**
 * interactive init 첫 단계: 어느 프로젝트에 awl 을 붙일지 고른다(init-project-picker).
 * cwd 가 git 프로젝트면 "이 프로젝트/다른 곳/취소", 아니거나 원하면 하위 git 프로젝트를
 * 최근 수정순 객관식으로 제시한다(끝에 직접 경로 입력·취소). 취소면 null.
 *
 * stdin 단일 소유(init.ts 의 interactiveInputs 와 같은 불변식): raw 셀렉터는 열린 readline
 * 없이 runInteractiveSelect 를 직접 돌린다 — 열린 readline 과 raw 셀렉터가 stdin 을 동시에
 * 소비하면 화면이 망가진다. 텍스트 프롬프트용 readline 은 lazy 로 만들되 셀렉터 전에 닫는다.
 */
async function pickProjectRoot(cwd: string, c: Caps): Promise<string | null> {
  const raw = rawModeCapable();
  const session: { rl: readline.Interface | null } = { rl: null };
  const prompt = (): readline.Interface => {
    if (!session.rl) {
      session.rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    }
    return session.rl;
  };
  const select = async (options: string[], title: string): Promise<number> => {
    if (raw) {
      // stdin 유일 소비자가 셀렉터가 되도록 열린 readline 을 먼저 닫는다.
      if (session.rl) {
        session.rl.close();
        session.rl = null;
      }
      const r = await runInteractiveSelect(options, 0, false, c, [], {
        title,
        hint: '↑↓ 또는 j/k 이동 · Enter 선택 · Esc 기본값 유지',
      });
      return r?.index ?? 0;
    }
    return selectSingle(prompt(), options, 0, c, false, title);
  };
  try {
    if (exists(path.join(cwd, '.git'))) {
      const idx = await select(
        [`이 프로젝트로 진행  (${cwd})`, '다른 프로젝트 고르기', '취소'],
        '어느 프로젝트에 awl 을 붙일까요?',
      );
      if (idx === 0) {
        return cwd;
      }
      if (idx !== 1) {
        return null; // 취소.
      }
      // idx === 1 → 하위 스캔으로 내려간다.
    }
    const candidates = scanGitProjects(cwd);
    const labels = [...candidates.map((p) => `${p.name}  (${p.path})`), '직접 경로 입력', '취소'];
    const title =
      candidates.length > 0
        ? '프로젝트를 고르세요 (최근 수정순, 최대 20)'
        : '하위에 git 프로젝트가 없습니다 — 직접 입력하거나 취소';
    const choice = resolveProjectChoice(await select(labels, title), candidates);
    if (choice.kind === 'path') {
      return choice.path;
    }
    if (choice.kind === 'cancel') {
      return null;
    }
    // 직접 경로 입력 — 존재하는 경로만 받는다(오타로 엉뚱한 곳에 스캐폴딩 방지).
    const typed = (await ask(prompt(), '  프로젝트 경로를 입력하세요: ')).trim();
    if (!typed) {
      return null;
    }
    const resolved = path.resolve(typed);
    if (!exists(resolved)) {
      process.stdout.write(`\n  그 경로가 없습니다: ${resolved}\n`);
      return null;
    }
    return resolved;
  } finally {
    if (session.rl) {
      session.rl.close();
    }
  }
}

export async function runInit(opts: { yes: boolean }): Promise<void> {
  const projectRoot = process.cwd();
  const interactive = process.stdin.isTTY === true && process.stdout.isTTY === true;

  if (!opts.yes && !interactive) {
    process.stderr.write(renderNonTtyNotice());
    process.exit(1);
  }

  const c = caps();
  const now = new Date().toISOString();
  const configExists = exists(path.join(projectRoot, '.awl', 'config.json'));

  if (opts.yes) {
    if (configExists) {
      const engine = scaffoldGlobal();
      const hook = installSafetyHook(projectRoot);
      const synced = syncExistingInstall(projectRoot, engine.engineVersion);
      const syncNote =
        synced.configUpdated || synced.skills.length > 0
          ? `\n  ${signal(c, 'ok')} 버전 마커를 ${engine.engineVersion} 로 동기화했습니다${synced.skills.length ? ` (스킬: ${synced.skills.join(', ')})` : ''}.`
          : '';
      process.stdout.write(
        `\n  .awl/config.json 이 이미 있습니다. 그대로 씁니다.\n  ${signal(c, 'ok')} 엔진 템플릿을 ${engine.created ? '설치했습니다.' : '갱신했습니다.'}${syncNote}${hook.warning ? `\n  ${signal(c, 'warn')} ${hook.warning}` : hook.installed ? `\n  ${signal(c, 'ok')} git push 차단 훅 설치` : ''}\n`,
      );
      return;
    }
    const inputs = nonInteractiveInputs(projectRoot);
    const result = applyInit(projectRoot, inputs, now);
    process.stdout.write(`${renderResult(result, inputs, c)}\n`);
    return;
  }

  if (configExists) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      await handleExistingConfig(rl, projectRoot, c, now);
    } finally {
      rl.close();
    }
    return;
  }

  // 프로젝트 선정(init-project-picker): cwd 에 config 가 없는 interactive 첫 실행에서만
  // 어느 프로젝트에 붙일지 고른다. --yes 와 cwd config 존재는 위에서 이미 분기(회귀).
  const chosenRoot = await pickProjectRoot(projectRoot, c);
  if (chosenRoot === null) {
    process.stdout.write('\n  취소했습니다.\n');
    return;
  }
  // 고른 프로젝트에 이미 config 가 있으면 기존 설정 흐름으로 잇는다.
  if (exists(path.join(chosenRoot, '.awl', 'config.json'))) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      await handleExistingConfig(rl, chosenRoot, c, now);
    } finally {
      rl.close();
    }
    return;
  }
  const inputs = await interactiveInputs(chosenRoot, isGlobalInstalled(), c);
  const result = applyInit(chosenRoot, inputs, now);
  process.stdout.write(`\n${renderResult(result, inputs, c)}\n`);
}
