import fs from 'node:fs';
import path from 'node:path';
import { protectedFilesMessage } from '../core/protected-files.js';
import { CommandNotFoundError, run } from '../core/runner.js';
import { type Caps, caps, card, makeColors, signal } from '../core/tty.js';
import { type AwlConfig, VERIFY_ORDER, type VerifyMap, requireConfig } from './config.js';
import { gitDirtyFiles } from './doctor.js';
import { applyVerificationAttempts, loadState, writeState } from './state.js';

/**
 * awl verify — config 의 검증 명령을 순서대로 실행한다.
 * 스킬이 결과 JSON 을 파싱하므로 출력 형식이 안정적이어야 한다.
 * null 인 항목은 건너뛴다(WI-4 에서 잡은 버그). env 는 runner 가 spawn 에 주입한다.
 *
 * WI-B: entry.cwd 가 있으면 그 디렉토리에서 실행한다(모노레포 지원). 상대경로는
 * projectRoot 기준으로 푼다. cross-spawn 은 cmd 안의 상대경로 실행파일도 이
 * cwd 기준으로 정확히 찾는다(스파이크로 실증 — docs/decisions.md 참고).
 */

export interface VerifyResult {
  name: string;
  exitCode: number | null;
  durationMs: number;
  output: string;
  error?: 'command_not_found' | 'cwd_not_found';
  timedOut?: boolean;
}

export interface VerifyReport {
  passed: boolean;
  results: VerifyResult[];
}

export async function runVerifyChecks(
  verify: VerifyMap,
  projectRoot: string,
  opts: { bail: boolean },
): Promise<VerifyReport> {
  const results: VerifyResult[] = [];
  let passed = true;

  for (const name of VERIFY_ORDER) {
    const entry = verify[name];
    if (!entry) {
      continue; // null 은 건너뛴다.
    }

    const cwd = entry.cwd
      ? path.isAbsolute(entry.cwd)
        ? entry.cwd
        : path.join(projectRoot, entry.cwd)
      : projectRoot;

    if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
      passed = false;
      results.push({
        name,
        exitCode: null,
        durationMs: 0,
        output: '',
        error: 'cwd_not_found',
      });
      if (opts.bail) {
        break;
      }
      continue;
    }

    try {
      const r = await run({
        cmd: entry.cmd,
        env: entry.env,
        cwd,
        timeoutMs: 600_000,
      });
      const result: VerifyResult = {
        name,
        exitCode: r.exitCode,
        durationMs: r.durationMs,
        output: `${r.stdout}${r.stderr}`.trim(),
        timedOut: r.timedOut,
      };
      const ok = isCheckPassed(result);
      if (!ok) {
        passed = false;
      }
      results.push(result);
      if (!ok && opts.bail) {
        break;
      }
    } catch (e) {
      passed = false;
      if (e instanceof CommandNotFoundError) {
        results.push({
          name,
          exitCode: null,
          durationMs: 0,
          output: '',
          error: 'command_not_found',
        });
      } else {
        results.push({ name, exitCode: null, durationMs: 0, output: String(e) });
      }
      if (opts.bail) {
        break;
      }
    }
  }

  return { passed, results };
}

function renderVerify(report: VerifyReport, c: Caps): string {
  const color = makeColors(c.color);
  const out: string[] = [];
  for (const r of report.results) {
    const mark =
      r.error === 'command_not_found'
        ? `${signal(c, 'error')} 명령 없음`
        : r.error === 'cwd_not_found'
          ? `${signal(c, 'error')} cwd 없음`
          : isCheckPassed(r)
            ? `${signal(c, 'ok')} 통과`
            : `${signal(c, 'error')} 실패`;
    const dur = r.error ? '' : color.dim(`${r.durationMs}ms`);
    out.push(`${r.name.padEnd(10, ' ')}${mark}  ${dur}`);
  }
  out.push('');
  out.push(
    report.passed
      ? `${signal(c, 'ok')} 전부 통과했습니다.`
      : `${signal(c, 'error')} 실패한 검증이 있습니다.`,
  );
  return card('검증 결과', out, c);
}

// ---------------------------------------------------------------------------
// --since-baseline (WI-G): 워크아이템 시작 시점의 체크별 pass/fail 을 저장해두고,
// 나중에 "새로 생긴 실패"와 "원래부터 있던 실패(사전 결함, 회귀 아님)"를 기계적으로
// 구분한다. 체크(typecheck/lint/test/e2e) 단위 비교만 한다 — 서브 테스트 단위까지는
// 안 본다(docs/decisions.md D-30, awl 은 검증 명령을 불투명한 셸 명령으로 다룬다).
// ---------------------------------------------------------------------------

export interface VerifyBaseline {
  capturedAt: string;
  /** 캡처 당시 워크아이템 ID. work switch 로 다른 워크아이템의 낡은 베이스라인이
   * 남아있는 걸 무음으로 잘못 비교하지 않기 위한 태그다(AC-06, 리뷰 지적 — D-28 과
   * 같은 클래스의 버그: 워크아이템별로 네임스페이스 안 된 자원이 전환 시 새는 문제). */
  workitem: string | null;
  results: { name: string; passed: boolean }[];
}

/**
 * 체크(typecheck/lint/test/e2e) 하나가 통과했는지 판정한다. (WI-H AC-05, 스파이크
 * 지적) 이 판정 로직이 runVerifyChecks/renderVerify/runWorkNew 세 곳에 각자
 * 재구현돼 있었다 — 하나로 통합해 재사용한다.
 */
export function isCheckPassed(r: VerifyResult): boolean {
  return !r.error && !r.timedOut && r.exitCode === 0;
}

/** VerifyReport 를 baseline 저장 형식으로 줄인다 — output 은 안 담는다(체크 단위만). */
export function buildVerifyBaseline(
  report: VerifyReport,
  capturedAt: string,
  workitem: string | null,
): VerifyBaseline {
  return {
    capturedAt,
    workitem,
    results: report.results.map((r) => ({ name: r.name, passed: isCheckPassed(r) })),
  };
}

export function verifyBaselinePath(projectRoot: string): string {
  return path.join(projectRoot, '.awl', 'verify-baseline.json');
}

/** .gitignore 에 .awl/verify-baseline.json 을 추가한다(없으면). init.ts 의 ensureGitignore, work.ts 의 ensureWorktreesGitignored 와 같은 패턴. */
function ensureVerifyBaselineGitignored(projectRoot: string): void {
  const gi = path.join(projectRoot, '.gitignore');
  const target = '.awl/verify-baseline.json';
  const content = fs.existsSync(gi) ? fs.readFileSync(gi, 'utf8') : '';
  if (content.split(/\r?\n/).some((line) => line.trim() === target)) {
    return;
  }
  const prefix = content.length > 0 && !content.endsWith('\n') ? '\n' : '';
  fs.writeFileSync(gi, `${content}${prefix}${target}\n`);
}

export function writeVerifyBaseline(projectRoot: string, baseline: VerifyBaseline): void {
  const p = verifyBaselinePath(projectRoot);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, `${JSON.stringify(baseline, null, 2)}\n`);
  ensureVerifyBaselineGitignored(projectRoot);
}

export function readVerifyBaseline(projectRoot: string): VerifyBaseline | null {
  try {
    const raw = JSON.parse(fs.readFileSync(verifyBaselinePath(projectRoot), 'utf8'));
    if (!raw || !Array.isArray(raw.results)) {
      return null;
    }
    return raw as VerifyBaseline;
  } catch {
    return null;
  }
}

export interface SinceBaselineComparison {
  /** 새로 생긴 실패가 없으면 true — 사전 결함이 남아있어도 true 다(AC-03). */
  passed: boolean;
  newFailures: string[];
  preExistingFailures: string[];
  resolved: string[];
}

/**
 * 현재 검증 결과를 베이스라인과 비교한다(AC-02/03). 체크 단위 비교만 한다.
 * 베이스라인에 없던 체크(나중에 추가된 체크 등)가 지금 실패하면, 비교 기준이
 * 없으므로 안전한 쪽(신규 실패로 취급)으로 판정한다.
 */
export function compareSinceBaseline(
  report: VerifyReport,
  baseline: VerifyBaseline,
): SinceBaselineComparison {
  const baselineMap = new Map(baseline.results.map((r) => [r.name, r.passed]));
  const newFailures: string[] = [];
  const preExistingFailures: string[] = [];
  const resolved: string[] = [];

  for (const r of report.results) {
    const nowPassed = isCheckPassed(r);
    const wasPassed = baselineMap.get(r.name);
    if (nowPassed) {
      if (wasPassed === false) {
        resolved.push(r.name);
      }
      continue;
    }
    if (wasPassed === false) {
      preExistingFailures.push(r.name);
    } else {
      // wasPassed 가 true 거나(회귀) undefined(베이스라인에 없던 체크) 다.
      newFailures.push(r.name);
    }
  }

  return { passed: newFailures.length === 0, newFailures, preExistingFailures, resolved };
}

function renderSinceBaseline(c: SinceBaselineComparison, caps: Caps): string {
  const color = makeColors(caps.color);
  const out: string[] = ['', '  베이스라인 대비'];
  if (c.newFailures.length > 0) {
    out.push(`    ${color.red('신규 실패')}: ${c.newFailures.join(', ')}`);
  }
  if (c.preExistingFailures.length > 0) {
    out.push(`    ${color.dim('사전 결함(변화 없음)')}: ${c.preExistingFailures.join(', ')}`);
  }
  if (c.resolved.length > 0) {
    out.push(`    ${color.green('해소됨')}: ${c.resolved.join(', ')}`);
  }
  if (c.newFailures.length === 0 && c.preExistingFailures.length === 0 && c.resolved.length === 0) {
    out.push(`    ${color.dim('변화 없음')}`);
  }
  out.push('');
  out.push(c.passed ? `  ${color.green('회귀 없음.')}` : `  ${color.red('회귀가 있습니다.')}`);
  return out.join('\n');
}

export type SinceBaselineResolution =
  | { available: true; comparison: SinceBaselineComparison }
  | { available: false; reason: 'no_baseline' | 'workitem_mismatch' };

/**
 * 베이스라인을 실제로 쓸 수 있는지 판정한다(AC-06/AC-07, 리뷰 지적).
 * - 베이스라인이 없으면 no_baseline.
 * - 베이스라인의 workitem 이 현재 workitem 과 다르면 workitem_mismatch — work switch
 *   로 다른 워크아이템의 낡은 베이스라인이 남아있는 걸 무음으로 잘못 비교하지 않는다.
 * 두 경우 다 "베이스라인 없음"과 똑같이 취급해 안전하게 폴백한다.
 */
export function resolveSinceBaseline(
  report: VerifyReport,
  baseline: VerifyBaseline | null,
  currentWorkitem: string | null,
): SinceBaselineResolution {
  if (!baseline) {
    return { available: false, reason: 'no_baseline' };
  }
  if (baseline.workitem !== currentWorkitem) {
    return { available: false, reason: 'workitem_mismatch' };
  }
  return { available: true, comparison: compareSinceBaseline(report, baseline) };
}

export function sinceBaselineFallbackMessage(reason: 'no_baseline' | 'workitem_mismatch'): string {
  if (reason === 'workitem_mismatch') {
    return (
      '\n  검증 베이스라인이 다른 워크아이템 것입니다 — --since-baseline 을 못 씁니다. 전체 검증 결과로 폴백합니다.\n' +
      // (WI-H AC-04, 스파이크 지적) "awl work new 로 다시 시작하라"는 예전 안내는
      // 실행하면 항상 실패했다 — createWorkitem 이 이미 존재하는 ID 를 무조건
      // 거부하기 때문이다(work switch 를 쓰라고 안내할 뿐). 현재 이 워크아이템의
      // 베이스라인을 다시 캡처하는 수단은 없다 — 없는 척하지 않고 정직하게 알린다.
      '  (이 워크아이템의 베이스라인을 다시 캡처하는 기능은 아직 없습니다 — 지금은 위 전체 검증 결과로 판단하세요.)\n'
    );
  }
  return (
    '\n  검증 베이스라인이 없습니다 — --since-baseline 을 못 씁니다. 전체 검증 결과로 폴백합니다.\n' +
    '  (awl work new 로 워크아이템을 시작하면 베이스라인이 자동으로 잡힙니다.)\n'
  );
}

// ---------------------------------------------------------------------------
// --related (WI-I AC-04): 변경된 파일에 관련된 테스트만 실행한다. relatedCmd
// 가 없으면 무음으로 건너뛰지 않고 전체 test 체크로 폴백한다(안전한 쪽).
// ---------------------------------------------------------------------------

/**
 * relatedCmd 템플릿의 {files} 를 변경 파일 목록으로 치환한다. 각 경로를
 * 큰따옴표로 감싼다 — run() 이 shell:false + tokenize() 로 실행하는데(runner.ts),
 * tokenize 는 따옴표 없는 공백을 그대로 토큰 분리해서 공백 포함 경로가 여러
 * 인자로 쪼개졌었다(2차 리뷰 지적, AC-07). tokenize 는 "..."/'...' 를 이미
 * 한 토큰으로 파싱하므로 이 방식이 안전하다.
 */
export function substituteRelatedCmd(template: string, changedFiles: string[]): string {
  const quoted = changedFiles.map((f) => `"${f}"`).join(' ');
  return template.replaceAll('{files}', quoted);
}

export interface RelatedTestOutcome {
  usedRelatedCmd: boolean;
  changedFiles: string[];
  result: VerifyResult;
}

async function runOneCommand(
  name: string,
  cmd: string,
  env: Record<string, string> | undefined,
  cwd: string,
): Promise<VerifyResult> {
  try {
    const r = await run({ cmd, env, cwd, timeoutMs: 600_000 });
    return {
      name,
      exitCode: r.exitCode,
      durationMs: r.durationMs,
      output: `${r.stdout}${r.stderr}`.trim(),
      timedOut: r.timedOut,
    };
  } catch (e) {
    return {
      name,
      exitCode: null,
      durationMs: 0,
      output: '',
      error: e instanceof CommandNotFoundError ? 'command_not_found' : undefined,
    };
  }
}

/**
 * relatedCmd 가 설정돼 있으면 변경 파일로 치환해 실행한다. 없으면 전체 test
 * 체크로 폴백한다(관련 테스트만 실행하는 게 목적이라도, 아무것도 안 도는 것보다
 * 전체를 도는 게 안전하다 — 무음 스킵 금지).
 */
export async function runRelatedTests(
  config: AwlConfig,
  projectRoot: string,
  changedFiles: string[],
): Promise<RelatedTestOutcome> {
  if (config.relatedCmd) {
    const cmd = substituteRelatedCmd(config.relatedCmd, changedFiles);
    return {
      usedRelatedCmd: true,
      changedFiles,
      result: await runOneCommand('related', cmd, undefined, projectRoot),
    };
  }

  const testEntry = config.verify.test;
  if (!testEntry) {
    return {
      usedRelatedCmd: false,
      changedFiles,
      result: {
        name: 'test',
        exitCode: null,
        durationMs: 0,
        output: '',
        error: 'command_not_found',
      },
    };
  }
  return {
    usedRelatedCmd: false,
    changedFiles,
    result: await runOneCommand('test', testEntry.cmd, testEntry.env, projectRoot),
  };
}

export async function runVerify(opts: {
  json: boolean;
  bail: boolean;
  sinceBaseline?: boolean;
  related?: boolean;
  force?: boolean;
}): Promise<void> {
  const { projectRoot, config } = requireConfig();
  if (!opts.force) {
    const protection = await protectedFilesMessage(projectRoot, config.protectedFiles);
    if (protection) {
      process.stderr.write(`\n  ${signal(caps(), 'error')} ${protection}\n`);
      process.exit(1);
    }
  }

  if (opts.related) {
    // 전체 검증을 다시 돌지 않는다 — --related 의 목적 자체가 빠른 부분 실행이다.
    const changedFiles = (await gitDirtyFiles(projectRoot)) ?? [];
    const outcome = await runRelatedTests(config, projectRoot, changedFiles);
    persistVerificationAttempts(projectRoot, isCheckPassed(outcome.result));
    if (opts.json) {
      process.stdout.write(`${JSON.stringify(outcome, null, 2)}\n`);
    } else {
      if (!outcome.usedRelatedCmd) {
        process.stdout.write(
          '\n  relatedCmd 가 설정돼 있지 않습니다 — 전체 테스트로 폴백합니다.\n' +
            '  (config.json 에 relatedCmd 를 설정하면 변경 파일에 관련된 테스트만 실행합니다. 예시: engine/templates/related-cmd-examples.md)\n',
        );
      }
      process.stdout.write(
        `${renderVerify({ passed: isCheckPassed(outcome.result), results: [outcome.result] }, caps())}\n`,
      );
    }
    process.exit(isCheckPassed(outcome.result) ? 0 : 1);
  }

  const report = await runVerifyChecks(config.verify, projectRoot, { bail: opts.bail });
  persistVerificationAttempts(projectRoot, report.passed);

  if (opts.sinceBaseline) {
    const baseline = readVerifyBaseline(projectRoot);
    const state = loadState(projectRoot);
    const currentWorkitem = typeof state.workitem === 'string' ? state.workitem : null;
    const resolution = resolveSinceBaseline(report, baseline, currentWorkitem);

    if (opts.json) {
      process.stdout.write(
        `${JSON.stringify({ ...report, sinceBaseline: resolution }, null, 2)}\n`,
      );
    } else {
      process.stdout.write(`${renderVerify(report, caps())}\n`);
      if (resolution.available) {
        process.stdout.write(`${renderSinceBaseline(resolution.comparison, caps())}\n`);
      } else {
        process.stdout.write(sinceBaselineFallbackMessage(resolution.reason));
      }
    }
    process.exit((resolution.available ? resolution.comparison.passed : report.passed) ? 0 : 1);
  }

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(`${renderVerify(report, caps())}\n`);
  }
  process.exit(report.passed ? 0 : 1);
}

function persistVerificationAttempts(projectRoot: string, passed: boolean): void {
  const attempted = applyVerificationAttempts(loadState(projectRoot), passed);
  writeState(projectRoot, attempted.state);
  if (attempted.blocked.length > 0) {
    process.stderr.write(
      `\n  ${signal(caps(), 'warn')} 검증 3회 실패: ${attempted.blocked.join(', ')} 을(를) 자동 차단했습니다. (autoBlocked)\n`,
    );
  }
}
