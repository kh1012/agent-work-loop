import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { findProjectRoot } from '../core/paths.js';
import { CommandNotFoundError, run } from '../core/runner.js';
import { type Caps, caps, makeColors, makeSymbols, sectionBox, signal } from '../core/tty.js';
import { LANG_OPTIONS, LANG_VALUES, ask, buildScreens, promptNumber } from './init.js';

/**
 * config 로드/검증 — 여러 명령이 공유하는 기반.
 *
 * 모든 스킬용/사람용 명령은 시작 시 config 스키마를 검증한다. 깨져 있으면
 * 그 자리에서 멈추고 무엇이 문제인지 알려준다. WI-2의 paths/runner/tty 를 쓴다.
 */

/** cwd 는 프로젝트 루트 기준 상대 경로다(절대 경로도 허용하되 config set 이 경고한다). */
export type VerifyEntry = { cmd: string; cwd?: string; env?: Record<string, string> } | null;

export interface VerifyMap {
  typecheck: VerifyEntry;
  lint: VerifyEntry;
  test: VerifyEntry;
  e2e: VerifyEntry;
}

export interface AwlConfig {
  project: string;
  mainLanguage: string;
  character: string;
  engineVersion: string;
  verify: VerifyMap;
  /** doctor 가 세어서 감지한 파일명 컨벤션(WI-I AC-01) — 정보성, 강제 아님. */
  namingConvention?: string;
  /** awl verify --related 가 쓸 명령 템플릿(WI-I AC-04). {files} 는 변경 파일 목록으로 치환된다. */
  relatedCmd?: string;
  protectedFiles?: string[];
}

export interface ConfigResult {
  config: AwlConfig | null;
  errors: string[];
  path: string;
}

/** 검증 명령의 순서. 이 순서로 실행/표시한다. */
export const VERIFY_ORDER: (keyof VerifyMap)[] = ['typecheck', 'lint', 'test', 'e2e'];

/** 프로젝트 루트를 해석한다(.git/.awl 을 위로 탐색). 못 찾으면 null. */
export function resolveProjectRoot(cwd: string = process.cwd()): string | null {
  try {
    return findProjectRoot(cwd);
  } catch {
    return null;
  }
}

function isVerifyEntry(v: unknown): v is VerifyEntry {
  if (v === null) {
    return true;
  }
  if (typeof v !== 'object') {
    return false;
  }
  const o = v as Record<string, unknown>;
  if (typeof o.cmd !== 'string') {
    return false;
  }
  if ('cwd' in o && o.cwd !== undefined && typeof o.cwd !== 'string') {
    return false;
  }
  if ('env' in o && o.env !== undefined && (typeof o.env !== 'object' || o.env === null)) {
    return false;
  }
  return true;
}

/** config 객체의 스키마를 검증한다. 문제 목록을 반환한다(빈 배열이면 통과). */
export function validateConfig(obj: unknown): string[] {
  const errors: string[] = [];
  if (typeof obj !== 'object' || obj === null) {
    errors.push('config 가 객체가 아닙니다');
    return errors;
  }
  const o = obj as Record<string, unknown>;
  if (typeof o.project !== 'string' || o.project.trim() === '') {
    errors.push('project 가 없습니다 (문자열 필수)');
  }
  if (typeof o.engineVersion !== 'string') {
    errors.push('engineVersion 이 없습니다 (문자열 필수)');
  }
  if (typeof o.verify !== 'object' || o.verify === null) {
    errors.push('verify 가 없습니다 (객체 필수)');
  } else {
    const v = o.verify as Record<string, unknown>;
    for (const k of VERIFY_ORDER) {
      if (k in v && !isVerifyEntry(v[k])) {
        errors.push(`verify.${k} 형식 오류 (null 또는 { "cmd": "..." })`);
      }
    }
  }
  if (
    'protectedFiles' in o &&
    (!Array.isArray(o.protectedFiles) || !o.protectedFiles.every((p) => typeof p === 'string'))
  ) {
    errors.push('protectedFiles 형식 오류 (문자열 배열)');
  }
  return errors;
}

/** JSON 파싱 오류 메시지에 대략적인 줄 번호를 붙인다. */
function jsonErrorLocation(text: string, err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  const m = /position (\d+)/.exec(msg);
  if (m?.[1]) {
    const line = text.slice(0, Number(m[1])).split('\n').length;
    return `${msg} (약 ${line}번째 줄)`;
  }
  return msg;
}

/** .awl/config.json 을 읽고 검증한다. */
export function loadConfig(projectRoot: string): ConfigResult {
  const p = path.join(projectRoot, '.awl', 'config.json');
  if (!fs.existsSync(p)) {
    return { config: null, errors: ['config.json 이 없습니다. awl init 을 실행하세요.'], path: p };
  }
  let text: string;
  try {
    text = fs.readFileSync(p, 'utf8');
  } catch (e) {
    return { config: null, errors: [`config.json 을 읽지 못했습니다: ${String(e)}`], path: p };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return {
      config: null,
      errors: [`config.json JSON 파싱 오류: ${jsonErrorLocation(text, e)}`],
      path: p,
    };
  }
  const errors = validateConfig(parsed);
  if (errors.length > 0) {
    return { config: null, errors, path: p };
  }
  const raw = parsed as Record<string, unknown>;
  const rv = raw.verify as Record<string, unknown>;
  const config: AwlConfig = {
    project: raw.project as string,
    mainLanguage: typeof raw.mainLanguage === 'string' ? raw.mainLanguage : '',
    character: typeof raw.character === 'string' ? raw.character : '',
    engineVersion: raw.engineVersion as string,
    ...(typeof raw.namingConvention === 'string' ? { namingConvention: raw.namingConvention } : {}),
    ...(typeof raw.relatedCmd === 'string' ? { relatedCmd: raw.relatedCmd } : {}),
    ...(Array.isArray(raw.protectedFiles)
      ? { protectedFiles: raw.protectedFiles as string[] }
      : {}),
    verify: {
      typecheck: (rv.typecheck ?? null) as VerifyEntry,
      lint: (rv.lint ?? null) as VerifyEntry,
      test: (rv.test ?? null) as VerifyEntry,
      e2e: (rv.e2e ?? null) as VerifyEntry,
    },
  };
  return { config, errors: [], path: p };
}

/**
 * 프로젝트 루트를 찾고 config 를 로드한다. 실패 시 표준 에러 출력 후 프로세스 종료.
 * 스킬용/사람용 명령이 공통으로 쓰는 진입 가드.
 */
export function requireConfig(): { projectRoot: string; config: AwlConfig } {
  const projectRoot = resolveProjectRoot();
  if (!projectRoot) {
    process.stderr.write(
      `\n  ${signal(caps(), 'error')} 프로젝트 루트를 찾을 수 없습니다(.git/.awl 없음). awl init 을 실행하세요.\n`,
    );
    process.exit(1);
  }
  const loaded = loadConfig(projectRoot);
  if (!loaded.config) {
    process.stderr.write(`\n  ${signal(caps(), 'error')} config 를 읽을 수 없습니다:\n`);
    for (const e of loaded.errors) {
      process.stderr.write(`    - ${e}\n`);
    }
    process.exit(1);
  }
  return { projectRoot, config: loaded.config };
}

// ---------------------------------------------------------------------------
// config 명령 (사람용)
// ---------------------------------------------------------------------------

/** verify.<name> 형태의 값을 파싱한다. 'null'/'none'/'-' 이면 null. */
export function parseVerifyValue(value: string): VerifyEntry {
  const trimmed = value.trim();
  if (trimmed === '' || trimmed.toLowerCase() === 'null' || trimmed === 'none' || trimmed === '-') {
    return null;
  }
  const env: Record<string, string> = {};
  let rest = trimmed;
  const re = /^(\w+)=(\S+)\s+/;
  let m = re.exec(rest);
  while (m !== null) {
    env[m[1] as string] = m[2] as string;
    rest = rest.slice(m[0].length);
    m = re.exec(rest);
  }
  return Object.keys(env).length > 0 ? { cmd: rest, env } : { cmd: rest };
}

// ---------------------------------------------------------------------------
// 설정 가능한 키 (config set 이 다루는 전부)
// ---------------------------------------------------------------------------

export type ConfigKeyKind =
  | 'project'
  | 'mainLanguage'
  | 'character'
  | 'namingConvention'
  | 'relatedCmd'
  | 'protectedFiles'
  | 'verify.cmd'
  | 'verify.cwd'
  | 'verify.env';

export interface ParsedConfigKey {
  kind: ConfigKeyKind;
  verifyName?: keyof VerifyMap;
}

/** mainLanguage 로 알려진 값. 자유값도 허용하되 이 목록에 없으면 경고한다. */
export const KNOWN_LANGUAGES = ['typescript', 'javascript', 'python'];

/** namingConvention 으로 알려진 값(doctor 가 감지하는 값과 일치). 자유값도 허용. */
export const KNOWN_NAMING_CONVENTIONS = ['kebab-case', 'camelCase', 'snake_case', 'PascalCase'];

/** 사람이 보는 전체 설정 가능 키 목록(순서 고정). */
export const SETTABLE_KEYS: string[] = [
  'project',
  'mainLanguage',
  'character',
  'namingConvention',
  'relatedCmd',
  'protectedFiles',
  ...VERIFY_ORDER.flatMap((n) => [`verify.${n}.cmd`, `verify.${n}.cwd`, `verify.${n}.env`]),
];

/** config set 의 키 문자열을 해석한다. `verify.<name>`(접미사 없음)은 `.cmd` 로 취급한다(하위 호환). */
export function parseConfigKey(key: string): ParsedConfigKey | null {
  if (key === 'project') {
    return { kind: 'project' };
  }
  if (key === 'mainLanguage') {
    return { kind: 'mainLanguage' };
  }
  if (key === 'character') {
    return { kind: 'character' };
  }
  if (key === 'namingConvention') {
    return { kind: 'namingConvention' };
  }
  if (key === 'relatedCmd') {
    return { kind: 'relatedCmd' };
  }
  if (key === 'protectedFiles') return { kind: 'protectedFiles' };
  const names = VERIFY_ORDER.join('|');
  const cmdMatch = new RegExp(`^verify\\.(${names})(?:\\.cmd)?$`).exec(key);
  if (cmdMatch?.[1]) {
    return { kind: 'verify.cmd', verifyName: cmdMatch[1] as keyof VerifyMap };
  }
  const cwdMatch = new RegExp(`^verify\\.(${names})\\.cwd$`).exec(key);
  if (cwdMatch?.[1]) {
    return { kind: 'verify.cwd', verifyName: cwdMatch[1] as keyof VerifyMap };
  }
  const envMatch = new RegExp(`^verify\\.(${names})\\.env$`).exec(key);
  if (envMatch?.[1]) {
    return { kind: 'verify.env', verifyName: envMatch[1] as keyof VerifyMap };
  }
  return null;
}

/** 명령이 실제로 존재하고 기동하는지 확인한다(--version 으로, 짧게). */
/**
 * cwd 를 반영해 명령을 확인한다(WI-B 리뷰 지적: 예전엔 cwd 를 아예 안 써서, 이미
 * cwd 가 설정된 상대경로 명령 — 예: ../../node_modules/.bin/tsc — 이 거짓으로
 * "명령을 찾을 수 없습니다"가 됐다). cwd 는 이미 resolve 된 절대/상대경로다.
 */
async function verifyCommandExists(
  entry: { cmd: string; env?: Record<string, string> },
  cwd?: string,
): Promise<{ ok: boolean; note: string }> {
  const first = entry.cmd.split(/\s+/)[0] ?? '';
  try {
    const r = await run({ cmd: first, args: ['--version'], env: entry.env, cwd, timeoutMs: 5000 });
    return { ok: true, note: `종료 코드 ${r.exitCode}` };
  } catch (e) {
    return {
      ok: false,
      note:
        e instanceof CommandNotFoundError
          ? `명령을 찾을 수 없습니다: ${first}`
          : `실행 오류: ${String(e)}`,
    };
  }
}

/** cwd 를 projectRoot 기준으로 resolve 한다(상대경로는 join, 절대경로는 그대로). */
function resolveCwd(projectRoot: string, cwd: string | undefined): string | undefined {
  if (!cwd) {
    return undefined;
  }
  return path.isAbsolute(cwd) ? cwd : path.join(projectRoot, cwd);
}

export interface ApplyKeyOutcome {
  ok: boolean;
  message: string;
}

/**
 * config 의 한 키를 갱신한다(메모리 상의 config 객체를 직접 수정한다. 저장은 호출자 몫).
 * 키마다 검증 규칙이 다르다: cmd 는 실제로 실행해보고, cwd 는 디렉토리 존재를 확인하고,
 * mainLanguage 는 알려진 값인지 경고만 하고, character 는 검증하지 않는다.
 */
export async function applyConfigValue(
  config: AwlConfig,
  projectRoot: string,
  parsed: ParsedConfigKey,
  rawValue: string,
  opts: { force: boolean },
): Promise<ApplyKeyOutcome> {
  if (parsed.kind === 'project') {
    const v = rawValue.trim();
    if (v === '') {
      return { ok: false, message: 'project 는 비울 수 없습니다.' };
    }
    config.project = v;
    return { ok: true, message: `project = ${v}` };
  }

  if (parsed.kind === 'mainLanguage') {
    const v = rawValue.trim();
    if (v === '') {
      return { ok: false, message: 'mainLanguage 는 비울 수 없습니다.' };
    }
    config.mainLanguage = v;
    if (!KNOWN_LANGUAGES.includes(v)) {
      return {
        ok: true,
        message: `mainLanguage = ${v}  (경고: 알려진 값이 아닙니다 — ${KNOWN_LANGUAGES.join('/')})`,
      };
    }
    return { ok: true, message: `mainLanguage = ${v}` };
  }

  if (parsed.kind === 'character') {
    config.character = rawValue;
    return { ok: true, message: `character = ${rawValue || '(비움)'}` };
  }

  if (parsed.kind === 'namingConvention') {
    const v = rawValue.trim();
    if (v === '') {
      config.namingConvention = undefined;
      return { ok: true, message: 'namingConvention = (비움)' };
    }
    config.namingConvention = v;
    if (!KNOWN_NAMING_CONVENTIONS.includes(v)) {
      return {
        ok: true,
        message: `namingConvention = ${v}  (경고: 알려진 값이 아닙니다 — ${KNOWN_NAMING_CONVENTIONS.join('/')})`,
      };
    }
    return { ok: true, message: `namingConvention = ${v}` };
  }

  if (parsed.kind === 'relatedCmd') {
    const v = rawValue.trim();
    if (v === '') {
      config.relatedCmd = undefined;
      return { ok: true, message: 'relatedCmd = (비움)' };
    }
    if (!v.includes('{files}')) {
      return {
        ok: false,
        message:
          'relatedCmd 에는 {files} 자리표시자가 있어야 합니다(변경 파일 목록으로 치환됩니다).',
      };
    }
    config.relatedCmd = v;
    return { ok: true, message: `relatedCmd = ${v}` };
  }

  if (parsed.kind === 'protectedFiles') {
    let files: unknown;
    try {
      files = JSON.parse(rawValue);
    } catch {
      return { ok: false, message: 'protectedFiles 는 JSON 문자열 배열이어야 합니다.' };
    }
    if (
      !Array.isArray(files) ||
      !files.every((file) => typeof file === 'string' && file.trim() !== '')
    ) {
      return { ok: false, message: 'protectedFiles 는 비어 있지 않은 문자열 배열이어야 합니다.' };
    }
    config.protectedFiles = files;
    return { ok: true, message: `protectedFiles = ${files.join(', ') || '(비움)'}` };
  }

  const name = parsed.verifyName as keyof VerifyMap;

  if (parsed.kind === 'verify.cmd') {
    const entry = parseVerifyValue(rawValue);
    // cmd 만 바꿀 때는 이미 설정된 cwd 를 보존한다 — 그리고 존재 확인도 그 cwd 로 한다.
    const prevCwd = config.verify[name]?.cwd;
    if (entry) {
      const check = await verifyCommandExists(entry, resolveCwd(projectRoot, prevCwd));
      if (!check.ok && !opts.force) {
        return {
          ok: false,
          message: `'${entry.cmd}' 확인 실패: ${check.note}\n그래도 저장하려면 --force 를 붙이세요.`,
        };
      }
    }
    config.verify[name] = entry ? { ...entry, ...(prevCwd ? { cwd: prevCwd } : {}) } : null;
    return { ok: true, message: `verify.${name}.cmd = ${entry ? entry.cmd : 'null'}` };
  }

  const existing = config.verify[name];
  if (!existing) {
    return {
      ok: false,
      message: `verify.${name} 이 설정되어 있지 않습니다. 먼저 cmd 를 설정하세요: awl config set verify.${name}.cmd "..."`,
    };
  }

  if (parsed.kind === 'verify.cwd') {
    const v = rawValue.trim();
    if (v === '' || v.toLowerCase() === 'null' || v === '-') {
      existing.cwd = undefined;
      return { ok: true, message: `verify.${name}.cwd = (없음)` };
    }
    const abs = resolveCwd(projectRoot, v) as string;
    const dirExists = fs.existsSync(abs) && fs.statSync(abs).isDirectory();
    let warn = '';
    if (path.isAbsolute(v)) {
      warn += '\n경고: 절대 경로입니다. 다른 사람의 머신에서는 다른 위치를 가리킬 수 있습니다.';
    }
    if (!dirExists) {
      if (!opts.force) {
        return {
          ok: false,
          message: `디렉토리가 없습니다: ${abs}\n그래도 저장하려면 --force 를 붙이세요.`,
        };
      }
      warn += `\n경고: 디렉토리가 없습니다: ${abs} (강제 저장)`;
    }
    existing.cwd = v;
    return { ok: true, message: `verify.${name}.cwd = ${v}${warn}` };
  }

  // parsed.kind === 'verify.env'
  const v = rawValue.trim();
  if (v === '' || v.toLowerCase() === 'null' || v === '-') {
    existing.env = undefined;
    return { ok: true, message: `verify.${name}.env = (없음)` };
  }
  let parsedEnv: unknown;
  try {
    parsedEnv = JSON.parse(v);
  } catch (e) {
    return { ok: false, message: `env 는 JSON 객체여야 합니다: ${String(e)}` };
  }
  if (typeof parsedEnv !== 'object' || parsedEnv === null || Array.isArray(parsedEnv)) {
    return { ok: false, message: 'env 는 JSON 객체여야 합니다 (예: {"NODE_ENV":"test"})' };
  }
  existing.env = parsedEnv as Record<string, string>;
  return { ok: true, message: `verify.${name}.env = ${v}` };
}

function renderConfig(config: AwlConfig, c: Caps): string {
  const color = makeColors(c.color);
  const s = makeSymbols(c);
  const out: string[] = [];
  out.push(`${s.branch} 주 언어  ${config.mainLanguage || '(없음)'}`);
  out.push(`${s.branch} 성격     ${config.character || '(없음)'}`);
  out.push(`${s.branch} 엔진     ${config.engineVersion}`);
  out.push('');
  for (const k of VERIFY_ORDER) {
    const entry = config.verify[k];
    out.push(`${s.branch} ${k.padEnd(10, ' ')}${entry ? entry.cmd : '(없음)'}`);
    if (entry?.cwd) {
      out.push(`${s.vGuide}   ${s.lastBranch} cwd: ${entry.cwd}`);
    }
    if (entry?.env && Object.keys(entry.env).length > 0) {
      out.push(`${s.vGuide}   ${s.lastBranch} env: ${JSON.stringify(entry.env)}`);
    }
  }
  out.push('');
  out.push(
    `${s.lastBranch} ${color.dim('명령을 바꾸려면: awl config set verify.lint.cmd "biome check ."')}`,
  );
  out.push(`    ${color.dim('직접 편집도 됩니다: .awl/config.json')}`);
  return sectionBox(`${config.project} 설정`, out, c);
}

function writeConfigFile(projectRoot: string, config: AwlConfig): void {
  const p = path.join(projectRoot, '.awl', 'config.json');
  fs.writeFileSync(p, `${JSON.stringify(config, null, 2)}\n`);
}

// ---------------------------------------------------------------------------
// awl config — 조회 + (TTY 면) 인터랙티브 수정
// ---------------------------------------------------------------------------

const EDIT_MENU = ['그대로 둔다', '주 언어', '검증 명령어', '성격', '프로젝트 이름'];

/** buildScreens 의 검증 명령어 설명 화면을 보여준 뒤, 현재 값을 기본값 삼아 하나씩 고친다. */
async function editVerifyCommands(
  rl: readline.Interface,
  config: AwlConfig,
  projectRoot: string,
  c: Caps,
): Promise<void> {
  const screens = buildScreens(projectRoot, true, c);
  process.stdout.write(`\n${screens.verify}\n`);
  for (const name of VERIFY_ORDER) {
    const cur = config.verify[name];
    const shown = cur ? cur.cmd : '(없음)';
    const answer = (await ask(rl, `  ${name} [${shown}]: `)).trim();
    if (answer === '') {
      continue; // 비우면 그대로 둔다(init 의 관행과 동일).
    }
    const outcome = await applyConfigValue(
      config,
      projectRoot,
      { kind: 'verify.cmd', verifyName: name },
      answer,
      { force: false },
    );
    process.stdout.write(`  ${outcome.message}\n`);
  }
}

/** buildScreens 의 주 언어 화면을 보여주되, 기본 선택은 auto-detect 가 아니라 현재 설정값이다. */
async function editMainLanguage(
  rl: readline.Interface,
  config: AwlConfig,
  projectRoot: string,
  c: Caps,
): Promise<void> {
  const screens = buildScreens(projectRoot, true, c);
  process.stdout.write(`\n  현재 설정: ${config.mainLanguage || '(없음)'}\n`);
  process.stdout.write(`${screens.lang}\n`);
  const curIdx = LANG_VALUES.indexOf(config.mainLanguage);
  const idx = await promptNumber(rl, curIdx >= 0 ? curIdx : 0, LANG_OPTIONS.length);
  let value = LANG_VALUES[idx] ?? '';
  if (idx === LANG_OPTIONS.length - 1) {
    value = (await ask(rl, '  주 언어를 입력하세요: ')).trim();
  }
  const outcome = await applyConfigValue(config, projectRoot, { kind: 'mainLanguage' }, value, {
    force: false,
  });
  process.stdout.write(`  ${outcome.message}\n`);
}

async function editCharacter(
  rl: readline.Interface,
  config: AwlConfig,
  projectRoot: string,
  c: Caps,
): Promise<void> {
  const screens = buildScreens(projectRoot, true, c);
  process.stdout.write(`\n${screens.character}\n`);
  process.stdout.write(`  현재: ${config.character || '(비움)'}\n`);
  const answer = await ask(rl, '  > ');
  const outcome = await applyConfigValue(config, projectRoot, { kind: 'character' }, answer, {
    force: false,
  });
  process.stdout.write(`  ${outcome.message}\n`);
}

async function editProjectName(
  rl: readline.Interface,
  config: AwlConfig,
  projectRoot: string,
): Promise<void> {
  const answer = (await ask(rl, `  프로젝트 이름 [${config.project}]: `)).trim();
  if (answer === '') {
    return;
  }
  const outcome = await applyConfigValue(config, projectRoot, { kind: 'project' }, answer, {
    force: false,
  });
  process.stdout.write(`  ${outcome.message}\n`);
}

/** 인터랙티브 수정 메뉴. 테스트에서 in-memory readline 으로 직접 구동한다. */
export async function interactiveEditMenu(
  rl: readline.Interface,
  config: AwlConfig,
  projectRoot: string,
  c: Caps,
): Promise<boolean> {
  process.stdout.write('\n  수정할 항목을 고르세요.\n\n');
  for (let i = 0; i < EDIT_MENU.length; i++) {
    process.stdout.write(`    ${i + 1}  ${EDIT_MENU[i]}\n`);
  }
  const idx = await promptNumber(rl, 0, EDIT_MENU.length);
  if (idx === 0) {
    return false;
  }
  if (idx === 1) {
    await editMainLanguage(rl, config, projectRoot, c);
  } else if (idx === 2) {
    await editVerifyCommands(rl, config, projectRoot, c);
  } else if (idx === 3) {
    await editCharacter(rl, config, projectRoot, c);
  } else if (idx === 4) {
    await editProjectName(rl, config, projectRoot);
  }
  return true;
}

/**
 * awl config — 현재 설정을 표로 보여준다. TTY 면 항목을 골라 수정할 수 있다
 * (init 의 buildScreens 를 재사용한다. 화면을 새로 만들지 않는다).
 * TTY 가 아니면(파이프/CI) 조회만 하고 끝낸다.
 */
export async function runConfig(): Promise<void> {
  const projectRoot = resolveProjectRoot();
  if (!projectRoot) {
    process.stderr.write(
      `\n  ${signal(caps(), 'error')} 프로젝트 루트를 찾을 수 없습니다. awl init 을 실행하세요.\n`,
    );
    process.exit(1);
  }
  const loaded = loadConfig(projectRoot);
  if (!loaded.config) {
    process.stderr.write(`\n  ${signal(caps(), 'error')} config.json 에 문제가 있습니다:\n`);
    for (const e of loaded.errors) {
      process.stderr.write(`    - ${e}\n`);
    }
    process.exit(1);
  }
  const config = loaded.config;
  const c = caps();
  process.stdout.write(`${renderConfig(config, c)}\n`);

  const interactive = process.stdin.isTTY === true && process.stdout.isTTY === true;
  if (!interactive) {
    return;
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const changed = await interactiveEditMenu(rl, config, projectRoot, c);
    if (changed) {
      writeConfigFile(projectRoot, config);
      process.stdout.write('\n  저장했습니다.\n');
    } else {
      process.stdout.write('\n  바뀐 것이 없습니다.\n');
    }
  } finally {
    rl.close();
  }
}

/** 설정 가능한 키와 현재 값을 보여준다(awl config set 을 인자 없이 호출했을 때). */
function renderSettableKeys(config: AwlConfig, c: Caps): string {
  const color = makeColors(c.color);
  const currentOf = (key: string): string => {
    if (key === 'project') return config.project;
    if (key === 'mainLanguage') return config.mainLanguage || '(없음)';
    if (key === 'character') return config.character || '(없음)';
    const m = /^verify\.(typecheck|lint|test|e2e)\.(cmd|cwd|env)$/.exec(key);
    if (!m?.[1] || !m[2]) return '';
    const entry = config.verify[m[1] as keyof VerifyMap];
    if (!entry) return '(없음)';
    if (m[2] === 'cmd') return entry.cmd;
    if (m[2] === 'cwd') return entry.cwd ?? '(없음)';
    return entry.env ? JSON.stringify(entry.env) : '(없음)';
  };
  const keyWidth = Math.max(...SETTABLE_KEYS.map((k) => k.length)) + 2;
  const out: string[] = ['', '  설정 가능한 키', ''];
  for (const key of SETTABLE_KEYS) {
    out.push(`    ${key.padEnd(keyWidth, ' ')}${color.dim(currentOf(key))}`);
  }
  out.push('');
  out.push(`  ${color.dim('예: awl config set verify.lint.cmd "biome check ."')}`);
  return out.join('\n');
}

/**
 * awl config set [key] [value] — 저장 전에 키에 맞는 검증을 한다.
 * 파일 편집으로는 못 하는 검증(cmd 실제 실행, cwd 존재 확인)이 이 명령의 존재 이유다.
 * key 를 생략하면 설정 가능한 키 목록과 현재 값을 보여준다.
 */
export async function runConfigSet(
  key: string | undefined,
  value: string | undefined,
  opts: { force: boolean },
): Promise<void> {
  const projectRoot = resolveProjectRoot();
  if (!projectRoot) {
    process.stderr.write(
      `\n  ${signal(caps(), 'error')} 프로젝트 루트를 찾을 수 없습니다. awl init 을 실행하세요.\n`,
    );
    process.exit(1);
  }
  const loaded = loadConfig(projectRoot);
  if (!loaded.config) {
    process.stderr.write(
      `\n  ${signal(caps(), 'error')} config.json 에 문제가 있어 수정할 수 없습니다:\n`,
    );
    for (const e of loaded.errors) {
      process.stderr.write(`    - ${e}\n`);
    }
    process.exit(1);
  }
  const config = loaded.config;

  if (!key) {
    process.stdout.write(`${renderSettableKeys(config, caps())}\n`);
    return;
  }

  const parsed = parseConfigKey(key);
  if (!parsed) {
    process.stderr.write(
      `\n  ${signal(caps(), 'error')} 지원하지 않는 키입니다: ${key}\n\n  설정 가능한 키:\n`,
    );
    for (const k of SETTABLE_KEYS) {
      process.stderr.write(`    ${k}\n`);
    }
    process.exit(1);
  }

  if (value === undefined) {
    process.stdout.write(`${renderSettableKeys(config, caps())}\n`);
    process.stdout.write(`\n  값을 주세요: awl config set ${key} <값>\n`);
    return;
  }

  const outcome = await applyConfigValue(config, projectRoot, parsed, value, {
    force: opts.force,
  });
  if (!outcome.ok) {
    process.stderr.write(`\n  ${signal(caps(), 'error')} ${outcome.message}\n`);
    process.exit(1);
  }
  writeConfigFile(projectRoot, config);
  process.stdout.write(`  저장했습니다: ${outcome.message}\n`);
}
