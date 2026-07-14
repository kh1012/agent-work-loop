import { describe, expect, it } from 'vitest';
import type { VerifyMap } from '../../src/commands/config.js';
import { runVerifyChecks } from '../../src/commands/verify.js';

const NODE = process.execPath;

function vmap(partial: Partial<VerifyMap>): VerifyMap {
  return { typecheck: null, lint: null, test: null, e2e: null, ...partial };
}

describe('runVerifyChecks', () => {
  it('null 항목을 건너뛰고, 순서대로 실행한다', async () => {
    const report = await runVerifyChecks(
      vmap({
        typecheck: { cmd: `${NODE} --version` },
        lint: null,
        test: { cmd: `${NODE} -e "process.exit(1)"` },
      }),
      process.cwd(),
      { bail: false },
    );
    // lint/e2e 는 null 이라 결과에 없다.
    expect(report.results.map((r) => r.name)).toEqual(['typecheck', 'test']);
    expect(report.results[0]?.exitCode).toBe(0);
    expect(report.results[1]?.exitCode).toBe(1);
    expect(report.passed).toBe(false);
  });

  it('결과는 유효한 JSON 으로 직렬화/파싱된다(스킬이 파싱함)', async () => {
    const report = await runVerifyChecks(
      vmap({ typecheck: { cmd: `${NODE} --version` } }),
      process.cwd(),
      { bail: false },
    );
    const json = JSON.stringify(report);
    const parsed = JSON.parse(json);
    expect(parsed.passed).toBe(true);
    expect(parsed.results[0].name).toBe('typecheck');
    expect(typeof parsed.results[0].durationMs).toBe('number');
  });

  it('명령이 없으면 command_not_found 로 구분한다', async () => {
    const report = await runVerifyChecks(
      vmap({ typecheck: { cmd: 'awl_no_such_tool_zzz .' } }),
      process.cwd(),
      { bail: false },
    );
    expect(report.results[0]?.error).toBe('command_not_found');
    expect(report.passed).toBe(false);
  });

  it('--bail 이면 첫 실패에서 멈춘다', async () => {
    const report = await runVerifyChecks(
      vmap({
        typecheck: { cmd: `${NODE} -e "process.exit(1)"` },
        lint: { cmd: `${NODE} --version` },
      }),
      process.cwd(),
      { bail: true },
    );
    expect(report.results).toHaveLength(1);
    expect(report.results[0]?.name).toBe('typecheck');
  });

  it('env 를 자식에 주입한다(문자열이 아니라 옵션으로)', async () => {
    const report = await runVerifyChecks(
      vmap({
        test: {
          cmd: `${NODE} -e "process.exit(process.env.AWL_V==='ok'?0:2)"`,
          env: { AWL_V: 'ok' },
        },
      }),
      process.cwd(),
      { bail: false },
    );
    expect(report.results[0]?.exitCode).toBe(0);
  });
});
