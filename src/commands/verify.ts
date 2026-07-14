import fs from 'node:fs';
import path from 'node:path';
import { CommandNotFoundError, run } from '../core/runner.js';
import { type Caps, caps, makeColors } from '../core/tty.js';
import { VERIFY_ORDER, type VerifyMap, requireConfig } from './config.js';

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
      const ok = r.exitCode === 0 && !r.timedOut;
      if (!ok) {
        passed = false;
      }
      results.push({
        name,
        exitCode: r.exitCode,
        durationMs: r.durationMs,
        output: `${r.stdout}${r.stderr}`.trim(),
        timedOut: r.timedOut,
      });
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
  const out: string[] = ['', '  검증 결과', ''];
  for (const r of report.results) {
    const mark =
      r.error === 'command_not_found'
        ? color.red('명령 없음')
        : r.error === 'cwd_not_found'
          ? color.red('cwd 없음')
          : r.exitCode === 0 && !r.timedOut
            ? color.green('통과')
            : color.red('실패');
    const dur = r.error ? '' : color.dim(`${r.durationMs}ms`);
    out.push(`    ${r.name.padEnd(10, ' ')}${mark}  ${dur}`);
  }
  out.push('');
  out.push(
    report.passed
      ? `  ${color.green('전부 통과했습니다.')}`
      : `  ${color.red('실패한 검증이 있습니다.')}`,
  );
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// --since-baseline (WI-G): 워크아이템 시작 시점의 체크별 pass/fail 을 저장해두고,
// 나중에 "새로 생긴 실패"와 "원래부터 있던 실패(사전 결함, 회귀 아님)"를 기계적으로
// 구분한다. 체크(typecheck/lint/test/e2e) 단위 비교만 한다 — 서브 테스트 단위까지는
// 안 본다(docs/decisions.md D-30, awl 은 검증 명령을 불투명한 셸 명령으로 다룬다).
// ---------------------------------------------------------------------------

export interface VerifyBaseline {
  capturedAt: string;
  results: { name: string; passed: boolean }[];
}

function isCheckPassed(r: VerifyResult): boolean {
  return !r.error && !r.timedOut && r.exitCode === 0;
}

/** VerifyReport 를 baseline 저장 형식으로 줄인다 — output 은 안 담는다(체크 단위만). */
export function buildVerifyBaseline(report: VerifyReport, capturedAt: string): VerifyBaseline {
  return {
    capturedAt,
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

export async function runVerify(opts: { json: boolean; bail: boolean }): Promise<void> {
  const { projectRoot, config } = requireConfig();
  const report = await runVerifyChecks(config.verify, projectRoot, { bail: opts.bail });
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(`${renderVerify(report, caps())}\n`);
  }
  process.exit(report.passed ? 0 : 1);
}
