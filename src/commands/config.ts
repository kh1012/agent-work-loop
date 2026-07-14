import fs from 'node:fs';
import path from 'node:path';
import { findProjectRoot } from '../core/paths.js';
import { CommandNotFoundError, run } from '../core/runner.js';
import { type Caps, caps, makeColors } from '../core/tty.js';

/**
 * config 로드/검증 — 여러 명령이 공유하는 기반.
 *
 * 모든 스킬용/사람용 명령은 시작 시 config 스키마를 검증한다. 깨져 있으면
 * 그 자리에서 멈추고 무엇이 문제인지 알려준다. WI-2의 paths/runner/tty 를 쓴다.
 */

export type VerifyEntry = { cmd: string; env?: Record<string, string> } | null;

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
  return typeof (v as Record<string, unknown>).cmd === 'string';
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
      '\n  프로젝트 루트를 찾을 수 없습니다(.git/.awl 없음). awl init 을 실행하세요.\n',
    );
    process.exit(1);
  }
  const loaded = loadConfig(projectRoot);
  if (!loaded.config) {
    process.stderr.write('\n  config 를 읽을 수 없습니다:\n');
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

function renderConfig(config: AwlConfig, c: Caps): string {
  const color = makeColors(c.color);
  const out: string[] = ['', `  ${color.bold(config.project)}  설정`, ''];
  out.push(`    주 언어    ${config.mainLanguage || '(없음)'}`);
  out.push(`    성격       ${config.character || '(없음)'}`);
  out.push(`    엔진       ${config.engineVersion}`);
  out.push('');
  for (const k of VERIFY_ORDER) {
    const entry = config.verify[k];
    out.push(`    ${k.padEnd(10, ' ')}${entry ? entry.cmd : '(없음)'}`);
  }
  out.push('');
  out.push(`  ${color.dim('명령을 바꾸려면: awl config set verify.lint "biome check ."')}`);
  out.push(`  ${color.dim('직접 편집도 됩니다: .awl/config.json')}`);
  return out.join('\n');
}

/** awl config — 현재 설정을 표로 보여준다. */
export function runConfig(): void {
  const projectRoot = resolveProjectRoot();
  if (!projectRoot) {
    process.stderr.write('\n  프로젝트 루트를 찾을 수 없습니다. awl init 을 실행하세요.\n');
    process.exit(1);
  }
  const loaded = loadConfig(projectRoot);
  if (!loaded.config) {
    process.stderr.write('\n  config.json 에 문제가 있습니다:\n');
    for (const e of loaded.errors) {
      process.stderr.write(`    - ${e}\n`);
    }
    process.exit(1);
  }
  process.stdout.write(`${renderConfig(loaded.config, caps())}\n`);
}

/**
 * awl config set <key> <value> — 저장 전에 검증 명령을 실제로 실행해본다.
 * 파일 편집으로는 못 하는 검증이 이 명령의 존재 이유다.
 */
export async function runConfigSet(
  key: string,
  value: string,
  opts: { force: boolean },
): Promise<void> {
  const projectRoot = resolveProjectRoot();
  if (!projectRoot) {
    process.stderr.write('\n  프로젝트 루트를 찾을 수 없습니다. awl init 을 실행하세요.\n');
    process.exit(1);
  }
  const loaded = loadConfig(projectRoot);
  if (!loaded.config) {
    process.stderr.write('\n  config.json 에 문제가 있어 수정할 수 없습니다:\n');
    for (const e of loaded.errors) {
      process.stderr.write(`    - ${e}\n`);
    }
    process.exit(1);
  }
  const config = loaded.config;

  const m = /^verify\.(typecheck|lint|test|e2e)$/.exec(key);
  if (!m) {
    process.stderr.write(
      `\n  지원하지 않는 키입니다: ${key}\n  지금은 verify.typecheck / verify.lint / verify.test / verify.e2e 만 설정할 수 있습니다.\n`,
    );
    process.exit(1);
  }
  const vkey = m[1] as keyof VerifyMap;
  const entry = parseVerifyValue(value);

  // 저장 전에 실제로 실행해본다(존재 + 기동 확인).
  if (entry) {
    const first = entry.cmd.split(/\s+/)[0] ?? '';
    process.stdout.write(`\n  '${entry.cmd}' 을 확인하는 중...\n`);
    let ok = true;
    let note = '';
    try {
      const r = await run({ cmd: first, args: ['--version'], env: entry.env, timeoutMs: 5000 });
      note = `종료 코드 ${r.exitCode}`;
    } catch (e) {
      ok = false;
      note =
        e instanceof CommandNotFoundError
          ? `명령을 찾을 수 없습니다: ${first}`
          : `실행 오류: ${String(e)}`;
    }
    if (!ok && !opts.force) {
      process.stderr.write(`  경고: ${note}\n`);
      process.stderr.write('  그래도 저장하려면 --force 를 붙이세요.\n');
      process.exit(1);
    }
    process.stdout.write(`  ${ok ? '확인됨' : '확인 실패(강제 저장)'} (${note})\n`);
  }

  config.verify[vkey] = entry;
  const p = path.join(projectRoot, '.awl', 'config.json');
  fs.writeFileSync(p, `${JSON.stringify(config, null, 2)}\n`);
  process.stdout.write(`  저장했습니다: verify.${vkey} = ${entry ? entry.cmd : 'null'}\n`);
}
