import { CommandNotFoundError, run } from '../core/runner.js';
import { type Caps, caps, makeColors } from '../core/tty.js';
import { VERIFY_ORDER, type VerifyMap, requireConfig } from './config.js';

/**
 * awl verify — config 의 검증 명령을 순서대로 실행한다.
 * 스킬이 결과 JSON 을 파싱하므로 출력 형식이 안정적이어야 한다.
 * null 인 항목은 건너뛴다(WI-4 에서 잡은 버그). env 는 runner 가 spawn 에 주입한다.
 */

export interface VerifyResult {
  name: string;
  exitCode: number | null;
  durationMs: number;
  output: string;
  error?: 'command_not_found';
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
    try {
      const r = await run({
        cmd: entry.cmd,
        env: entry.env,
        cwd: projectRoot,
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
