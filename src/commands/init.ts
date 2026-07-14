import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { installedEngineVersion } from '../core/engine.js';
import { engineDir, globalRoot, projectsFile } from '../core/paths.js';
import {
  type Caps,
  type Colors,
  type Symbols,
  caps,
  makeColors,
  makeSymbols,
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
 * ~/.awl 골격을 만들고 engine을 복사한다.
 * 이미 있으면 아무것도 하지 않는다(engine 갱신은 update 의 몫).
 */
export function scaffoldGlobal(): { created: boolean; engineVersion: string } {
  const root = globalRoot();
  if (exists(root)) {
    return { created: false, engineVersion: installedEngineVersion() ?? 'unknown' };
  }

  for (const dir of [
    'records',
    'deltas',
    'rules',
    path.join('rules', 'active'),
    'templates',
    'generations',
  ]) {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
  }
  writeFileEnsuringDir(path.join(root, 'rules', 'index.json'), '[]\n');
  writeFileEnsuringDir(path.join(root, 'rules', 'graduated.md'), '');
  if (!exists(projectsFile())) {
    writeFileEnsuringDir(projectsFile(), '[]\n');
  }

  // engine 복사: 패키지의 engine/ -> ~/.awl/engine
  fs.cpSync(packageEngineDir(), engineDir(), { recursive: true });

  return { created: true, engineVersion: installedEngineVersion() ?? 'unknown' };
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

/** .gitignore 에 .awl/state.json 을 추가한다. 이미 있으면 중복 추가하지 않는다. */
export function ensureGitignore(projectRoot: string): 'added' | 'exists' {
  const gi = path.join(projectRoot, '.gitignore');
  const target = '.awl/state.json';
  const content = exists(gi) ? fs.readFileSync(gi, 'utf8') : '';
  const already = content.split(/\r?\n/).some((line) => line.trim() === target);
  if (already) {
    return 'exists';
  }
  const prefix = content.length > 0 && !content.endsWith('\n') ? '\n' : '';
  fs.writeFileSync(gi, `${content}${prefix}${target}\n`);
  return 'added';
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
  return {
    project: path.basename(projectRoot),
    mainLanguage: detectLanguage(projectRoot) ?? '',
    character: '',
    verify: detectVerify(projectRoot),
    skills: detectAgents(projectRoot),
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
}

export function applyInit(projectRoot: string, inputs: InitInputs, now: string): InitResult {
  const g = scaffoldGlobal();
  const config = buildConfig(inputs, g.engineVersion);
  const configPath = writeConfig(projectRoot, config);
  const statePath = writeState(projectRoot, now);
  const gitignore = ensureGitignore(projectRoot);
  const projectCount = registerProject({
    name: inputs.project,
    path: projectRoot,
    mainLanguage: inputs.mainLanguage,
    character: inputs.character,
    registeredAt: now,
  });

  const skills: string[] = [];
  if (inputs.skills.claude && installClaudeSkill(projectRoot)) {
    skills.push('claude');
  }
  if (inputs.skills.codex && installCodexSkill(projectRoot)) {
    skills.push('codex');
  }

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
  };
}

// ---------------------------------------------------------------------------
// 렌더링 (tty 폴백 사용, ASCII 기본, 이모지 없음)
// ---------------------------------------------------------------------------

const WIDTH = 64;

/** 오른쪽이 열린 L자 박스. 제목은 상단 테두리에 얹는다. 한글 폭을 고려한다. */
function stepBox(step: string, title: string, lines: string[], sym: Symbols): string {
  const left = `${sym.boxTL}${sym.boxH} ${step} `;
  const right = ` ${title}`;
  const dashes = Math.max(1, WIDTH - stringWidth(left) - stringWidth(right));
  const out: string[] = [left + sym.boxH.repeat(dashes) + right, sym.boxV];
  for (const line of lines) {
    out.push(line ? `${sym.boxV}  ${line}` : sym.boxV);
  }
  return out.join('\n');
}

const VERIFY_LABELS: Record<keyof VerifyMap, string> = {
  typecheck: '타입체크',
  lint: '린트',
  test: '테스트',
  e2e: 'E2E',
};

/** 표시 폭(한글=2) 기준으로 오른쪽을 공백으로 채운다. */
function padDisplay(text: string, width: number): string {
  return text + ' '.repeat(Math.max(0, width - stringWidth(text)));
}

function verifyLines(v: VerifyMap): string[] {
  const keys = Object.keys(VERIFY_LABELS) as (keyof VerifyMap)[];
  const labelWidth = Math.max(...keys.map((k) => stringWidth(VERIFY_LABELS[k]))) + 2;
  return keys.map((k) => {
    const entry = v[k];
    return `  ${padDisplay(VERIFY_LABELS[k], labelWidth)}${entry ? entry.cmd : '(없음)'}`;
  });
}

/**
 * "[2/4] 검증 명령어" 화면의 본문 줄들. buildScreens(루트 기준)와 interactiveInputs
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
  const sym = makeSymbols(c);
  const color = makeColors(c.color);
  const line = (name: string, value: string, note = ''): string =>
    `  ${name.padEnd(20, ' ')}${value}${note ? `    ${color.dim(note)}` : ''}`;

  const out: string[] = [''];
  out.push(line('~/.awl', result.globalCreated ? '생성됨' : '이미 있음'));
  out.push(line('~/.awl/engine', result.engineVersion));
  out.push(line('.awl/config.json', '생성됨', '<- 커밋하세요. 팀원은 이 파일을 씁니다'));
  out.push(
    line(
      '.awl/state.json',
      result.gitignore === 'added' ? 'gitignore 에 추가함' : '이미 gitignore 에 있음',
    ),
  );
  out.push(
    `  ${color.dim(
      `규칙 ${result.ruleCount}개 · 교훈 ${result.lessonCount}개 · 등록된 프로젝트 ${result.projectCount}개 · 1세대`,
    )}`,
  );
  out.push('');
  out.push(`  ${sym.boxH.repeat(WIDTH - 2)}`);
  out.push('');

  if (inputs.skills.claude) {
    out.push('  Claude Code 를 열고 이렇게 말하세요.');
    out.push('');
    out.push(`    ${color.bold('/awl-loop')}  페이지 편집기에 여백 시스템을 넣고 싶어`);
  } else if (inputs.skills.codex) {
    out.push('  Codex 에게 이렇게 말하세요.');
    out.push('');
    out.push(`    ${color.bold('/awl-loop')}  페이지 편집기에 여백 시스템을 넣고 싶어`);
  } else {
    out.push('  나중에 스킬을 설치하려면 awl init 을 다시 실행하세요.');
  }
  out.push('');
  out.push(`  ${sym.boxH.repeat(WIDTH - 2)}`);
  return out.join('\n');
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
  rules: string;
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
  const sym = makeSymbols(c);
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

  const langLines = ['자동 감지했습니다. 맞으면 Enter.', ''];
  for (let i = 0; i < LANG_OPTIONS.length; i++) {
    const marker = i === defLang ? sym.radioOn : sym.radioOff;
    langLines.push(`${marker} ${i + 1}  ${LANG_OPTIONS[i]}`);
  }

  return {
    welcome,
    lang: stepBox('1/4', '주 언어', langLines, sym),
    verify: stepBox('2/4', '검증 명령어', verifyStepLines(verify), sym),
    rules: stepBox(
      '3/4',
      '규칙이란',
      [
        '작업하다 같은 실패를 두 번 하면, awl 이 그걸 규칙으로 만듭니다.',
        '예: "여백은 토큰 값만. 자유 px 금지"',
        '',
        '규칙은 당신에게 쌓입니다. 다음 프로젝트에도 따라옵니다.',
        '그래서 문제가 하나 생깁니다.',
        '',
        '  이 프로젝트의 규칙이, 저 프로젝트에서도 맞을까?',
        '',
        '그걸 판단하려면 이 프로젝트가 어떤 곳인지 알아야 합니다.',
      ],
      sym,
    ),
    character: stepBox(
      '4/4',
      '이 프로젝트는 어떤 곳입니까',
      [
        '한 줄이면 됩니다. 나중에 규칙이 생겼을 때,',
        '그 규칙을 여기에 적용할지 판단하는 근거가 됩니다.',
        '',
        '비워둬도 됩니다. 다만 적어두면, 다른 프로젝트의 규칙이',
        '여기로 잘못 끌려오지 않습니다.',
      ],
      sym,
    ),
    skills: stepBox(
      '스킬',
      '스킬 설치',
      [
        'awl 은 판단하지 않습니다. 파일과 상태만 관리합니다.',
        '판단은 이미 쓰고 계신 에이전트가 합니다.',
        '',
        `${agents.claude ? sym.checkOn : sym.checkOff} 1  Claude Code   .claude/skills/awl-loop/ 에 설치`,
        `${agents.codex ? sym.checkOn : sym.checkOff} 2  Codex         AGENTS.md 에 추가`,
      ],
      sym,
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
 * 없었다. 순수 함수로 뽑아 직접 테스트한다.)
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
  rl: readline.Interface,
  projectRoot: string,
  hasGlobal: boolean,
  c: Caps,
): Promise<InitInputs> {
  const screens = buildScreens(projectRoot, hasGlobal, c);
  const project = path.basename(projectRoot);

  // 1. 프로젝트 등록 안내
  if (screens.welcome) {
    process.stdout.write(`${screens.welcome}\n`);
  }

  // 2. [1/4] 주 언어
  process.stdout.write(`\n${screens.lang}\n`);
  const langIdx = await promptNumber(rl, langDefaultIndex(projectRoot), LANG_OPTIONS.length);
  let mainLanguage = LANG_VALUES[langIdx] ?? '';
  if (langIdx === LANG_OPTIONS.length - 1) {
    mainLanguage = (await ask(rl, '  주 언어를 입력하세요: ')).trim();
  }

  // 3. [2/4] 검증 명령어 (WI-B: 모노레포면 워크스페이스 패키지를 물어볼 수 있다)
  const rootVerify = detectVerify(projectRoot);
  const located = await promptVerifyLocation(rl, projectRoot, rootVerify, makeColors(c.color));
  const verify = located.verify;
  if (located.cwd) {
    // 패키지를 새로 골랐으면 그 패키지에서 감지한 값으로 화면도 다시 그린다
    // (buildScreens 가 만든 screens.verify 는 루트 기준이라 여기선 쓰지 않는다).
    process.stdout.write(
      `\n${stepBox('2/4', '검증 명령어', verifyStepLines(verify), makeSymbols(c))}\n`,
    );
  } else {
    process.stdout.write(`\n${screens.verify}\n`);
  }
  for (const k of Object.keys(VERIFY_LABELS) as (keyof VerifyMap)[]) {
    const cur = verify[k];
    const shown = cur ? cur.cmd : '(없음)';
    const answer = (await ask(rl, `  ${VERIFY_LABELS[k]} [${shown}]: `)).trim();
    if (answer !== '') {
      verify[k] = answer.toLowerCase() === '없음' || answer === '-' ? null : splitEnv(answer);
    }
  }
  applyVerifyCwd(verify, located.cwd);

  // 4. [3/4] 규칙이란 (설명 화면)
  process.stdout.write(`\n${screens.rules}\n`);
  await ask(rl, '  Enter 로 계속: ');

  // 5. [4/4] 이 프로젝트는 어떤 곳입니까
  process.stdout.write(`\n${screens.character}\n`);
  const character = (await ask(rl, '  > ')).trim();

  // 6. 스킬 설치
  process.stdout.write(`\n${screens.skills}\n`);
  const agents = detectAgents(projectRoot);
  const def = [agents.claude ? '1' : '', agents.codex ? '2' : ''].filter(Boolean).join(',');
  const answer = (await ask(rl, `  포함할 번호를 쉼표로 (기본 ${def || '없음'}): `)).trim();
  const chosen = (answer === '' ? def : answer)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const skills = { claude: chosen.includes('1'), codex: chosen.includes('2') };

  return { project, mainLanguage, character, verify, skills };
}

/** 이미 config가 있을 때의 짧은 확인 흐름. */
async function handleExistingConfig(
  rl: readline.Interface,
  projectRoot: string,
  c: Caps,
  now: string,
): Promise<void> {
  const sym = makeSymbols(c);
  const raw = readJson(path.join(projectRoot, '.awl', 'config.json'));
  const config = raw as Partial<AwlConfig> | null;
  const installedVer = installedEngineVersion();

  process.stdout.write('\n  .awl/config.json 이 이미 있습니다. 팀원이 설정해두었군요.\n\n');
  process.stdout.write(`    프로젝트   ${config?.project ?? '(없음)'}\n`);
  process.stdout.write(`    주 언어    ${config?.mainLanguage ?? '(없음)'}\n`);
  process.stdout.write(`    성격       ${config?.character || '(없음)'}\n`);
  const engineNote =
    installedVer && config?.engineVersion
      ? installedVer === config.engineVersion
        ? `(설치됨: ${installedVer}  일치)`
        : `(설치됨: ${installedVer}  불일치 -> awl update 를 실행하세요)`
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
    `  ${sym.radioOn} 1  ${options[0]}      ${sym.radioOff} 2  ${options[1]}      ${sym.radioOff} 3  ${options[2]}\n`,
  );
  const choice = await promptNumber(rl, 0, options.length);

  process.stdout.write(
    `\n  ${makeColors(c.color).dim('규칙과 교훈은 공유되지 않습니다. 저 설정만 팀원과 같고, 쌓이는 것은 당신 것입니다.')}\n`,
  );

  if (choice === 0) {
    process.stdout.write('\n  설정을 그대로 씁니다. 바뀐 것은 없습니다.\n');
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
  const inputs = await interactiveInputs(rl, projectRoot, isGlobalInstalled(), c);
  const result = applyInit(projectRoot, inputs, now);
  process.stdout.write(`\n${renderResult(result, inputs, c)}\n`);
}

// ---------------------------------------------------------------------------
// 진입점
// ---------------------------------------------------------------------------

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
      process.stdout.write('\n  .awl/config.json 이 이미 있습니다. 그대로 씁니다.\n');
      return;
    }
    const inputs = nonInteractiveInputs(projectRoot);
    const result = applyInit(projectRoot, inputs, now);
    process.stdout.write(`${renderResult(result, inputs, c)}\n`);
    return;
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    if (configExists) {
      await handleExistingConfig(rl, projectRoot, c, now);
    } else {
      const hasGlobal = isGlobalInstalled();
      const inputs = await interactiveInputs(rl, projectRoot, hasGlobal, c);
      const result = applyInit(projectRoot, inputs, now);
      process.stdout.write(`\n${renderResult(result, inputs, c)}\n`);
    }
  } finally {
    rl.close();
  }
}
