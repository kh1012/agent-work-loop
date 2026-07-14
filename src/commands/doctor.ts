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

/**
 * 현재 브랜치명. git 저장소가 아니거나(예: .awl 만 있는 프로젝트), git 명령이
 * 없거나, 커밋 하나 없는 unborn 상태 등 어떤 이유로도 못 가져오면 null 이다
 * (WI-C: findProjectRoot 는 .git 또는 .awl 둘 중 하나만 있어도 루트로 인정하므로
 * git 이 아닌 프로젝트가 정상적으로 존재한다 — 크래시도, missing/fail 판정도
 * 하지 않는다).
 */
export async function gitBranch(projectRoot: string): Promise<string | null> {
  try {
    const r = await run({
      cmd: 'git',
      args: ['symbolic-ref', '--short', 'HEAD'],
      cwd: projectRoot,
      timeoutMs: 5000,
    });
    if (r.exitCode !== 0) {
      return null;
    }
    const branch = r.stdout.trim();
    return branch || null;
  } catch {
    return null;
  }
}

/**
 * 워킹트리의 미커밋 변경 파일 목록. `git status --porcelain` 을 awl 이 직접
 * 실행한다(WI-F — 환경/에이전트가 준 git 상태 요약을 못 믿는다. 실사고: 다른
 * 세션의 미커밋 변경 20개 파일이 있는 걸 몰랐다가 나중에 그 커밋에 섞여
 * 들어갔다). git 저장소가 아니거나 명령이 없으면 null(크래시하지 않는다 —
 * gitBranch 와 같은 원칙).
 */
export async function gitDirtyFiles(projectRoot: string): Promise<string[] | null> {
  try {
    const r = await run({
      cmd: 'git',
      args: ['status', '--porcelain', '-z'],
      cwd: projectRoot,
      timeoutMs: 5000,
    });
    if (r.exitCode !== 0) {
      return null;
    }
    // -z(NUL 구분)로 읽어 core.quotePath 설정과 무관하게 한글 등 비ASCII 경로가
    // 그대로 나온다(commit.ts 의 namesZ 와 같은 이유, 리뷰 지적 AC-07). rename/copy
    // 레코드는 "XY new\0orig\0" 두 토큰이라 orig 토큰을 소비해 건너뛴다.
    const tokens = r.stdout.split('\0').filter((t) => t !== '');
    const files: string[] = [];
    let skipNext = false;
    for (const token of tokens) {
      if (skipNext) {
        skipNext = false; // rename/copy 의 원래 경로 — 파일 목록에 안 넣는다.
        continue;
      }
      const status = token.slice(0, 2);
      files.push(token.slice(3));
      skipNext = status.includes('R') || status.includes('C');
    }
    return files;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 네이밍 컨벤션 감지 (WI-I AC-01) — 세어서 감지만 한다. 강제/거부는 하지 않는다
// (lint 중복 금지 — 이미 존재하는 이름을 검사/거부하는 건 biome/eslint 의 몫이다).
// ---------------------------------------------------------------------------

export type NamingConvention = 'kebab-case' | 'camelCase' | 'snake_case' | 'PascalCase';

const MIN_DECISIVE_FILES = 3;
const MAJORITY_THRESHOLD = 0.8;

function classifyBasename(nameNoExt: string): NamingConvention | 'ambiguous' {
  if (nameNoExt.includes('-')) {
    return 'kebab-case';
  }
  if (nameNoExt.includes('_')) {
    return 'snake_case';
  }
  if (/^[A-Z]/.test(nameNoExt)) {
    return 'PascalCase';
  }
  if (/[A-Z]/.test(nameNoExt)) {
    return 'camelCase';
  }
  // 구분자도 대문자도 없는 단일 소문자 단어 — 모든 컨벤션과 호환돼 판단 근거가 안 된다.
  return 'ambiguous';
}

export interface NamingConventionResult {
  convention: NamingConvention | null;
  reason: 'detected' | 'mixed' | 'insufficient_data';
  counts: Record<string, number>;
  decisiveTotal: number;
}

const CODE_EXTENSIONS = new Set([
  'ts',
  'tsx',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'py',
  'go',
  'rs',
  'java',
  'rb',
  'php',
  'c',
  'cpp',
  'h',
  'hpp',
  'cs',
  'kt',
  'swift',
]);

const IGNORE_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.awl',
  '.awl-worktrees',
  '.awl-verify',
  'coverage',
]);

/**
 * src/ (없으면 projectRoot) 아래 소스 코드 파일의 절대 경로를 재귀적으로 모은다.
 * 네이밍 컨벤션 감지(AC-01)와 복잡도 프록시(AC-02) 가 같은 파일 목록을 재사용한다.
 */
function listSourceFiles(projectRoot: string): string[] {
  const root = fs.existsSync(path.join(projectRoot, 'src'))
    ? path.join(projectRoot, 'src')
    : projectRoot;
  const out: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 8) {
      return;
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (!IGNORE_DIRS.has(e.name)) {
          walk(path.join(dir, e.name), depth + 1);
        }
      } else if (e.isFile()) {
        const ext = e.name.split('.').pop() ?? '';
        if (CODE_EXTENSIONS.has(ext)) {
          out.push(path.join(dir, e.name));
        }
      }
    }
  };
  walk(root, 0);
  return out;
}

/** 파일명(확장자 포함, 경로 없이)을 세어 뚜렷한 다수 컨벤션이 있는지 판정한다. */
export function detectNamingConvention(filenames: string[]): NamingConventionResult {
  const counts: Record<string, number> = {};
  let decisiveTotal = 0;
  for (const raw of filenames) {
    const nameNoExt = raw.replace(/\.[^./]+$/, '');
    const cls = classifyBasename(nameNoExt);
    if (cls === 'ambiguous') {
      continue;
    }
    counts[cls] = (counts[cls] ?? 0) + 1;
    decisiveTotal += 1;
  }
  if (decisiveTotal < MIN_DECISIVE_FILES) {
    return { convention: null, reason: 'insufficient_data', counts, decisiveTotal };
  }
  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  const top = sorted[0];
  if (top && top[1] / decisiveTotal >= MAJORITY_THRESHOLD) {
    return {
      convention: top[0] as NamingConvention,
      reason: 'detected',
      counts,
      decisiveTotal,
    };
  }
  return { convention: null, reason: 'mixed', counts, decisiveTotal };
}

// ---------------------------------------------------------------------------
// 복잡도 프록시: 파일당 줄 수 (WI-I AC-02) — warn only, 임계값은 하드코딩하지
// 않고 그 프로젝트의 실제 분포(IQR: Q3 + 1.5*IQR, Tukey's fences)에서 실행
// 시점에 계산한다(2차 리뷰 지적 — 최초엔 90th percentile 인덱스 방식으로
// 설계했다가 최댓값 자신이 임계값이 돼버리는 결함을 실측으로 발견해 교체했다).
// AST 기반 순환복잡도는 언어마다 파서가 달라 크로스 언어 목표와 안 맞아 기각
// (D-30 과 같은 이유 — 특정 러너/파서에 종속되지 않는다).
// ---------------------------------------------------------------------------

const MIN_FILES_FOR_THRESHOLD = 5;
/** Tukey's fences 의 표준 배수. IQR 기반이라 균일한 분포에선 자연히 outlier 가 0 이 된다
 * (단순 percentile 인덱스 방식은 최댓값 자신이 임계값이 돼버려 항상 outlier 를 못 잡는
 * 문제가 있었다 — 실측 테스트로 발견, IQR 로 교체). */
const IQR_MULTIPLIER = 1.5;

export interface FileLineCount {
  path: string;
  lines: number;
}

export interface FileSizeReport {
  threshold: number | null;
  outliers: FileLineCount[];
}

/** 정렬된 배열에서 선형보간 percentile 을 계산한다(0<=p<=1). */
function percentile(sorted: number[], p: number): number {
  const pos = p * (sorted.length - 1);
  const lower = Math.floor(pos);
  const upper = Math.ceil(pos);
  const weight = pos - lower;
  const lowerVal = sorted[lower] as number;
  if (upper >= sorted.length) {
    return lowerVal;
  }
  const upperVal = sorted[upper] as number;
  return lowerVal + (upperVal - lowerVal) * weight;
}

/**
 * 파일 크기 분포에서 이상치를 찾는다(Tukey's fences: Q3 + 1.5*IQR). 하드코딩된
 * 줄 수 매직넘버 대신, 그 프로젝트의 실제 분포에서 실행 시점에 계산한다.
 */
export function computeFileSizeOutliers(files: FileLineCount[]): FileSizeReport {
  if (files.length < MIN_FILES_FOR_THRESHOLD) {
    return { threshold: null, outliers: [] };
  }
  const sortedLines = [...files].map((f) => f.lines).sort((a, b) => a - b);
  const q1 = percentile(sortedLines, 0.25);
  const q3 = percentile(sortedLines, 0.75);
  const iqr = q3 - q1;
  const threshold = q3 + IQR_MULTIPLIER * iqr;
  const outliers = files.filter((f) => f.lines > threshold);
  return { threshold, outliers };
}

/** listSourceFiles 가 찾은 파일들의 줄 수를 센다. 못 읽는 파일은 건너뛴다. */
function countFileLines(projectRoot: string): FileLineCount[] {
  const out: FileLineCount[] = [];
  for (const abs of listSourceFiles(projectRoot)) {
    try {
      const lines = fs.readFileSync(abs, 'utf8').split('\n').length;
      out.push({ path: path.relative(projectRoot, abs), lines });
    } catch {
      // 읽지 못하면 그 파일만 건너뛴다(크래시하지 않는다).
    }
  }
  return out;
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
  namingConvention?: string;
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

  const branch = await gitBranch(projectRoot);
  checks.push({
    group: '이 프로젝트',
    name: '브랜치',
    status: 'info',
    value: branch ?? '알 수 없음 (확인 실패)',
  });

  const dirtyFiles = await gitDirtyFiles(projectRoot);
  if (dirtyFiles === null) {
    checks.push({
      group: '이 프로젝트',
      name: '워킹트리',
      status: 'info',
      value: '확인 안 됨 (git 저장소가 아니거나 확인 실패)',
    });
  } else if (dirtyFiles.length === 0) {
    checks.push({ group: '이 프로젝트', name: '워킹트리', status: 'ok', value: '클린' });
  } else {
    checks.push({
      group: '이 프로젝트',
      name: '워킹트리',
      status: 'warn',
      value: `미커밋 변경 ${dirtyFiles.length}개`,
      hint: `${dirtyFiles.slice(0, 5).join(', ')}${dirtyFiles.length > 5 ? ' 등' : ''} — 새 워크아이템을 시작하기 전에 awl work new --worktree 로 격리하는 걸 고려하세요.`,
    });
  }

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

  // 네이밍 컨벤션 감지(WI-I AC-01) — 세기만 한다, 강제하지 않는다. doctor 는
  // 아무것도 고치지 않으므로 config.json 기록은 여기서 안 하고 hint 로 명령만
  // 안내한다(awl config set 이 실제 기록을 담당).
  const recordedNaming =
    typeof raw.namingConvention === 'string' ? raw.namingConvention : undefined;
  if (recordedNaming) {
    checks.push({
      group: '이 프로젝트',
      name: '네이밍 컨벤션',
      status: 'info',
      value: recordedNaming,
    });
  } else {
    const naming = detectNamingConvention(
      listSourceFiles(projectRoot).map((p) => path.basename(p)),
    );
    if (naming.reason === 'detected' && naming.convention) {
      checks.push({
        group: '이 프로젝트',
        name: '네이밍 컨벤션',
        status: 'info',
        value: `${naming.convention} (${naming.counts[naming.convention]}/${naming.decisiveTotal} 파일, 미기록)`,
        hint: `config.json 에 기록하려면: awl config set namingConvention ${naming.convention}`,
      });
    } else if (naming.reason === 'mixed') {
      checks.push({ group: '이 프로젝트', name: '네이밍 컨벤션', status: 'info', value: '혼재' });
    } else {
      checks.push({
        group: '이 프로젝트',
        name: '네이밍 컨벤션',
        status: 'info',
        value: '판단 보류 (파일 부족)',
      });
    }
  }

  // 복잡도 프록시: 파일 크기 이상치(WI-I AC-02) — warn only, 절대 fail 시키지 않는다.
  const sizeReport = computeFileSizeOutliers(countFileLines(projectRoot));
  if (sizeReport.threshold === null) {
    checks.push({
      group: '이 프로젝트',
      name: '파일 크기',
      status: 'info',
      value: '판단 보류 (파일 부족)',
    });
  } else if (sizeReport.outliers.length === 0) {
    checks.push({ group: '이 프로젝트', name: '파일 크기', status: 'ok', value: '이상치 없음' });
  } else {
    checks.push({
      group: '이 프로젝트',
      name: '파일 크기',
      status: 'warn',
      value: `이상치 ${sizeReport.outliers.length}개 (임계값 ${Math.round(sizeReport.threshold)}줄)`,
      hint: `${sizeReport.outliers
        .slice(0, 5)
        .map((o) => `${o.path}(${o.lines}줄)`)
        .join(
          ', ',
        )}${sizeReport.outliers.length > 5 ? ' 등' : ''} — 리팩터 후보로 고려해볼 만합니다(강제 아님).`,
    });
  }

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
