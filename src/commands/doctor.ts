import fs from 'node:fs';
import path from 'node:path';
import { installedEngineVersion } from '../core/engine.js';
import { findProjectRoot, globalRoot, projectsFile, rulesDir } from '../core/paths.js';
import { CommandNotFoundError, run, tokenize } from '../core/runner.js';
import { type Caps, caps, makeColors, stringWidth } from '../core/tty.js';

/**
 * awl doctor — 설치와 환경을 점검한다.
 *
 * doctor는 아무것도 고치지 않는다. 점검하고 알려줄 뿐이다.
 * checks 수집(collectChecks)은 렌더링과 분리해 테스트할 수 있게 한다.
 */

export type CheckStatus = 'ok' | 'missing' | 'fail' | 'warn' | 'info';

export interface Check {
  group: string;
  name: string;
  status: CheckStatus;
  value?: string;
  hint?: string;
}

export interface DoctorReport {
  ok: boolean;
  checks: Check[];
}

// ---------------------------------------------------------------------------
// 안전한 파일/JSON 헬퍼 (절대 크래시하지 않는다)
// ---------------------------------------------------------------------------

function exists(p: string): boolean {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

/** 존재하고 디렉토리인가(verify.ts/config.ts 와 판정 기준을 맞춘다 — WI-B 리뷰 지적). */
function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
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

/** 디렉토리 안의 파일 개수. 없으면 0. 숨김 파일 제외. */
function countEntries(dir: string): number {
  try {
    return fs.readdirSync(dir).filter((f) => !f.startsWith('.')).length;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// config 스키마
// ---------------------------------------------------------------------------

interface VerifySpec {
  cmd: string;
  cwd?: string;
  env?: Record<string, string>;
}

interface AwlConfig {
  engineVersion: string;
  // 설정하지 않은 검증은 null 로 저장된다(예: e2e: null).
  verify?: Record<string, VerifySpec | null>;
}

function isAwlConfig(c: unknown): c is AwlConfig {
  if (typeof c !== 'object' || c === null) {
    return false;
  }
  const o = c as Record<string, unknown>;
  if (typeof o.engineVersion !== 'string') {
    return false;
  }
  if (o.verify !== undefined && (typeof o.verify !== 'object' || o.verify === null)) {
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// 점검 항목 수집
// ---------------------------------------------------------------------------

const INIT_HINT = 'awl init 을 실행하세요';

/** 1. 환경 */
function collectEnv(checks: Check[]): void {
  const major = Number(process.versions.node.split('.')[0]);
  checks.push({
    group: '환경',
    name: 'Node',
    status: major >= 18 ? 'ok' : 'fail',
    value: `v${process.versions.node}`,
    hint: major >= 18 ? undefined : 'Node 18 이상이 필요합니다',
  });
  checks.push({
    group: '환경',
    name: '플랫폼',
    status: 'ok',
    value: `${process.platform} ${process.arch}`,
  });
  const c = caps();
  checks.push({
    group: '환경',
    name: '터미널',
    status: 'ok',
    value: `유니코드 ${c.unicode ? '지원' : '미지원'}, 색 ${c.color ? '지원' : '미지원'}`,
  });
}

/** 2. 전역 설치 (~/.awl) */
function collectGlobal(checks: Check[]): void {
  const root = globalRoot();
  if (!exists(root)) {
    checks.push({
      group: '전역 설치',
      name: '~/.awl',
      status: 'missing',
      value: '없음',
      hint: INIT_HINT,
    });
    return;
  }
  checks.push({ group: '전역 설치', name: '~/.awl', status: 'ok', value: '있음' });

  // 쓰기 권한: 임시 파일을 실제로 써보고 지운다.
  const probe = path.join(root, `.doctor-write-${process.pid}`);
  try {
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    checks.push({ group: '전역 설치', name: '쓰기 권한', status: 'ok', value: '가능' });
  } catch {
    checks.push({
      group: '전역 설치',
      name: '쓰기 권한',
      status: 'fail',
      value: '불가',
      hint: '~/.awl 에 쓸 수 없습니다. 권한을 확인하세요',
    });
  }

  // 엔진 버전
  const engineVer = installedEngineVersion();
  checks.push({
    group: '전역 설치',
    name: '엔진 버전',
    status: engineVer ? 'ok' : 'missing',
    value: engineVer ?? '없음',
    hint: engineVer ? undefined : INIT_HINT,
  });

  // 규칙 / 교훈 / 프로젝트 수 (없으면 0, 크래시하지 않는다)
  // 규칙은 rules/active 안의 파일을 센다(rules/ 직속의 index.json·graduated.md 는 메타).
  // 교훈 저장 위치는 아직 확정되지 않았다(다음 워크아이템). ~/.awl/lessons 로 가정한다.
  const lessonsDir = path.join(root, 'lessons');
  checks.push({
    group: '전역 설치',
    name: '규칙',
    status: 'info',
    value: `${countEntries(path.join(rulesDir(), 'active'))}개`,
  });
  checks.push({
    group: '전역 설치',
    name: '교훈',
    status: 'info',
    value: `${countEntries(lessonsDir)}개`,
  });

  let projectCount = 0;
  const projects = readJson(projectsFile());
  if (Array.isArray(projects)) {
    projectCount = projects.length;
  } else if (projects && typeof projects === 'object') {
    projectCount = Object.keys(projects).length;
  }
  checks.push({ group: '전역 설치', name: '프로젝트', status: 'info', value: `${projectCount}개` });
}

/** 3. 이 프로젝트 (<project>/.awl) */
async function collectProject(checks: Check[], projectRoot: string | null): Promise<void> {
  if (!projectRoot) {
    checks.push({
      group: '이 프로젝트',
      name: '프로젝트 루트',
      status: 'info',
      value: '아님 (.git/.awl 없음)',
    });
    return;
  }

  // WI-C: 프로젝트를 찾았을 때도 그 경로를 보여준다(예전엔 못 찾았을 때만 보였다).
  checks.push({
    group: '이 프로젝트',
    name: '프로젝트 루트',
    status: 'info',
    value: projectRoot,
  });

  const configPath = path.join(projectRoot, '.awl', 'config.json');
  if (!exists(configPath)) {
    checks.push({
      group: '이 프로젝트',
      name: 'config.json',
      status: 'missing',
      value: '없음',
      hint: INIT_HINT,
    });
    return;
  }

  const raw = readJson(configPath);
  if (!isAwlConfig(raw)) {
    checks.push({
      group: '이 프로젝트',
      name: 'config.json',
      status: 'fail',
      value: '형식 오류',
      hint: 'config.json 형식을 확인하세요',
    });
    return;
  }
  checks.push({ group: '이 프로젝트', name: 'config.json', status: 'ok', value: '있음' });

  // 엔진 버전 일치
  const installed = installedEngineVersion();
  if (installed !== null) {
    const match = installed === raw.engineVersion;
    checks.push({
      group: '이 프로젝트',
      name: '엔진 버전 일치',
      status: match ? 'ok' : 'warn',
      value: match ? raw.engineVersion : `config ${raw.engineVersion} / 설치 ${installed}`,
      hint: match ? undefined : '엔진 버전이 다릅니다',
    });
  }

  // 검증 명령 존재 확인: --version 으로 존재만 확인한다. 전체 실행은 하지 않는다(빨라야 함).
  for (const [vname, spec] of Object.entries(raw.verify ?? {})) {
    // 설정하지 않은 검증(e2e: null 등)은 건너뛴다.
    if (!spec || typeof spec.cmd !== 'string') {
      continue;
    }
    const first = tokenize(spec.cmd)[0] ?? '';
    if (!first) {
      checks.push({
        group: '이 프로젝트',
        name: `검증: ${vname}`,
        status: 'warn',
        value: '명령 비어 있음',
      });
      continue;
    }

    // WI-B: cwd 가 지정됐으면 그 디렉토리가 실제로 있는지 먼저 확인한다.
    const cwd = spec.cwd
      ? path.isAbsolute(spec.cwd)
        ? spec.cwd
        : path.join(projectRoot, spec.cwd)
      : undefined;
    if (cwd && !isDirectory(cwd)) {
      checks.push({
        group: '이 프로젝트',
        name: `검증: ${vname}`,
        status: 'missing',
        value: 'cwd 없음',
        hint: `cwd 디렉토리가 없습니다: ${spec.cwd}`,
      });
      continue;
    }

    try {
      await run({ cmd: first, args: ['--version'], cwd, timeoutMs: 3000 });
      // exitCode 가 0이 아니어도 실행은 됐으므로 "존재함"으로 본다(--version 미지원 도구 대비).
      checks.push({
        group: '이 프로젝트',
        name: `검증: ${vname}`,
        status: 'ok',
        value: `${first} 실행 가능`,
      });
    } catch (e) {
      if (e instanceof CommandNotFoundError) {
        checks.push({
          group: '이 프로젝트',
          name: `검증: ${vname}`,
          status: 'missing',
          value: '명령 없음',
          hint: `명령을 찾을 수 없습니다: ${e.command}`,
        });
      } else {
        checks.push({
          group: '이 프로젝트',
          name: `검증: ${vname}`,
          status: 'warn',
          value: '확인 실패',
          hint: '검증 명령을 확인하지 못했습니다',
        });
      }
    }
  }

  // state.json 존재 여부와 루프 위치
  const statePath = path.join(projectRoot, '.awl', 'state.json');
  if (!exists(statePath)) {
    checks.push({
      group: '이 프로젝트',
      name: 'state.json',
      status: 'info',
      value: '없음 (아직 시작 전)',
    });
  } else {
    const st = readJson(statePath);
    if (st && typeof st === 'object') {
      const o = st as Record<string, unknown>;
      const pos =
        (typeof o.phase === 'string' && o.phase) ||
        (typeof o.step === 'string' && o.step) ||
        (typeof o.position === 'string' && o.position) ||
        '있음';
      checks.push({ group: '이 프로젝트', name: 'state.json', status: 'ok', value: String(pos) });
    } else {
      checks.push({ group: '이 프로젝트', name: 'state.json', status: 'warn', value: '형식 오류' });
    }
  }
}

/** 4. 에이전트 */
function collectAgents(checks: Check[], base: string): void {
  const claudeDir = path.join(base, '.claude');
  checks.push({
    group: '에이전트',
    name: 'Claude Code',
    status: 'info',
    value: exists(claudeDir) ? '감지됨 (.claude/ 있음)' : '없음',
  });

  const agentsMd = path.join(base, 'AGENTS.md');
  checks.push({
    group: '에이전트',
    name: 'Codex',
    status: 'info',
    value: exists(agentsMd) ? '감지됨 (AGENTS.md 있음)' : '없음',
  });

  const skillDir = path.join(base, '.claude', 'skills', 'awl-loop');
  const installed = exists(skillDir);
  checks.push({
    group: '에이전트',
    name: 'awl 스킬',
    status: installed ? 'ok' : 'warn',
    value: installed ? '설치됨' : '설치 안 됨',
    hint: installed ? undefined : 'awl init 에서 설치할 수 있습니다',
  });
}

/** 모든 점검을 수집한다. 결정적이고, 어떤 항목도 크래시하지 않는다. */
export async function collectChecks(): Promise<DoctorReport> {
  const checks: Check[] = [];

  let projectRoot: string | null = null;
  try {
    projectRoot = findProjectRoot();
  } catch {
    projectRoot = null;
  }

  collectEnv(checks);
  collectGlobal(checks);
  await collectProject(checks, projectRoot);
  collectAgents(checks, projectRoot ?? process.cwd());

  const problems = checks.filter((c) => c.status === 'missing' || c.status === 'fail');
  return { ok: problems.length === 0, checks };
}

// ---------------------------------------------------------------------------
// 렌더링
// ---------------------------------------------------------------------------

/** 표시 폭 기준으로 오른쪽을 공백으로 채운다(한글이 섞여도 정렬됨). */
function pad(text: string, width: number): string {
  return text + ' '.repeat(Math.max(0, width - stringWidth(text)));
}

/** 사람이 읽는 텍스트로 렌더링한다. ASCII 환경에서도 정렬이 깨지지 않는다. */
export function renderText(report: DoctorReport, c: Caps): string {
  const color = makeColors(c.color);
  const { checks } = report;

  const nameWidth = checks.reduce((m, ch) => Math.max(m, stringWidth(ch.name)), 0);
  const valueWidth = checks.reduce((m, ch) => Math.max(m, stringWidth(ch.value ?? '')), 0);

  const statusText = (ch: Check): string => {
    switch (ch.status) {
      case 'ok':
        return color.green('ok');
      case 'missing':
      case 'fail':
        return color.red(`-> ${ch.hint ?? ''}`);
      case 'warn':
        return color.yellow(`-> ${ch.hint ?? ''}`);
      default:
        return '';
    }
  };

  const lines: string[] = ['', `  ${color.bold('Agent Work Loop')}  진단`, ''];

  const groups = [...new Set(checks.map((ch) => ch.group))];
  for (const group of groups) {
    lines.push(`  ${color.bold(group)}`);
    for (const ch of checks.filter((x) => x.group === group)) {
      const status = statusText(ch);
      let line = `    ${pad(ch.name, nameWidth)}  ${pad(ch.value ?? '', valueWidth)}`;
      if (status) {
        line += `  ${status}`;
      }
      lines.push(line.replace(/\s+$/, ''));
    }
    lines.push('');
  }

  const problems = report.checks.filter((ch) => ch.status === 'missing' || ch.status === 'fail');
  if (problems.length === 0) {
    lines.push(`  ${color.green('모두 정상입니다.')}`);
  } else {
    const action = problems.some((p) => (p.hint ?? '').includes('init'))
      ? 'awl init 을 실행하세요.'
      : '위 안내를 확인하세요.';
    lines.push(`  ${color.red(`문제 ${problems.length}개.`)} ${action}`);
  }

  return lines.join('\n');
}

/** doctor 명령의 실제 실행. 렌더 후 종료 코드를 설정한다. */
export async function runDoctor(opts: { json: boolean }): Promise<void> {
  const report = await collectChecks();
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(`${renderText(report, caps())}\n`);
  }
  process.exit(report.ok ? 0 : 1);
}
