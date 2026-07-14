import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { VerifyMap } from '../../src/commands/config.js';
import {
  buildVerifyBaseline,
  readVerifyBaseline,
  runVerifyChecks,
  verifyBaselinePath,
  writeVerifyBaseline,
} from '../../src/commands/verify.js';

const NODE = process.execPath;

function tmpProjectWithSubdir(): { root: string; sub: string } {
  // macOS 는 /tmp 가 /private/tmp 의 심볼릭 링크다. 자식 프로세스의 process.cwd() 는
  // 늘 실제 경로(/private/...)를 보고하므로, 비교 기준도 realpath 로 맞춘다.
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'awl-verify-cwd-')));
  const sub = path.join(root, 'packages', 'app');
  fs.mkdirSync(sub, { recursive: true });
  return { root, sub };
}

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

  // WI-B: config 의 verify.<name>.cwd 를 실제로 spawn 의 cwd 로 쓴다.
  describe('cwd 배선 (WI-B, 모노레포 지원)', () => {
    it('entry.cwd(상대경로) 로 실제 spawn 되는지 확인한다 (AC-01)', async () => {
      const { root, sub } = tmpProjectWithSubdir();
      const report = await runVerifyChecks(
        vmap({ typecheck: { cmd: `${NODE} -p process.cwd()`, cwd: 'packages/app' } }),
        root,
        { bail: false },
      );
      expect(report.results[0]?.exitCode).toBe(0);
      expect(report.results[0]?.output.trim()).toBe(sub);
    });

    it('entry.cwd 안의 상대경로 실행파일이 그 cwd 기준으로 풀린다 (maxflow 재현, AC-01)', async () => {
      const { root, sub } = tmpProjectWithSubdir();
      fs.mkdirSync(path.join(root, 'node_modules', '.bin'), { recursive: true });
      const toolPath = path.join(root, 'node_modules', '.bin', 'fake-tool');
      fs.writeFileSync(toolPath, `#!/usr/bin/env node\nprocess.stdout.write('ok');\n`);
      fs.chmodSync(toolPath, 0o755);

      const report = await runVerifyChecks(
        vmap({ typecheck: { cmd: '../../node_modules/.bin/fake-tool', cwd: 'packages/app' } }),
        root,
        { bail: false },
      );
      expect(report.results[0]?.exitCode).toBe(0);
      expect(report.results[0]?.output).toBe('ok');
      void sub;
    });

    it('entry.cwd 가 절대경로여도 그대로 쓴다', async () => {
      const { root, sub } = tmpProjectWithSubdir();
      const report = await runVerifyChecks(
        vmap({ typecheck: { cmd: `${NODE} -p process.cwd()`, cwd: sub } }),
        root,
        { bail: false },
      );
      expect(report.results[0]?.output.trim()).toBe(sub);
    });

    it('entry.cwd 가 없으면 기존처럼 projectRoot 를 쓴다(회귀)', async () => {
      const { root } = tmpProjectWithSubdir();
      const report = await runVerifyChecks(
        vmap({ typecheck: { cmd: `${NODE} -p process.cwd()` } }),
        root,
        { bail: false },
      );
      expect(report.results[0]?.output.trim()).toBe(root);
    });

    it('entry.cwd 디렉토리가 없으면 실행을 시도하지 않고 cwd_not_found 로 표시한다 (AC-02)', async () => {
      const { root } = tmpProjectWithSubdir();
      const report = await runVerifyChecks(
        vmap({ typecheck: { cmd: `${NODE} --version`, cwd: 'no/such/dir' } }),
        root,
        { bail: false },
      );
      expect(report.results[0]?.error).toBe('cwd_not_found');
      expect(report.passed).toBe(false);
    });
  });
});

describe('검증 베이스라인 (WI-G AC-01, --since-baseline 의 기반)', () => {
  it('buildVerifyBaseline 은 체크별 pass/fail 만 담는다 — output 은 안 담는다(체크 단위 비교, D-30)', async () => {
    const report = await runVerifyChecks(
      vmap({
        typecheck: { cmd: `${NODE} --version` },
        test: { cmd: `${NODE} -e "process.exit(1)"` },
      }),
      process.cwd(),
      { bail: false },
    );
    const baseline = buildVerifyBaseline(report, '2026-07-15T00:00:00.000Z');
    expect(baseline.capturedAt).toBe('2026-07-15T00:00:00.000Z');
    expect(baseline.results).toEqual([
      { name: 'typecheck', passed: true },
      { name: 'test', passed: false },
    ]);
    expect(JSON.stringify(baseline)).not.toContain('output');
  });

  it('command_not_found/timedOut 인 체크도 실패로 잡는다', async () => {
    const report = await runVerifyChecks(
      vmap({ typecheck: { cmd: 'awl_no_such_tool_zzz .' } }),
      process.cwd(),
      { bail: false },
    );
    const baseline = buildVerifyBaseline(report, '2026-07-15T00:00:00.000Z');
    expect(baseline.results).toEqual([{ name: 'typecheck', passed: false }]);
  });

  it('writeVerifyBaseline 으로 저장한 파일을 readVerifyBaseline 이 그대로 읽는다', () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'awl-baseline-')));
    fs.mkdirSync(path.join(root, '.awl'), { recursive: true });
    const baseline = {
      capturedAt: '2026-07-15T00:00:00.000Z',
      results: [{ name: 'typecheck', passed: true }],
    };
    writeVerifyBaseline(root, baseline);
    expect(fs.existsSync(verifyBaselinePath(root))).toBe(true);
    expect(readVerifyBaseline(root)).toEqual(baseline);
  });

  it('writeVerifyBaseline 은 .gitignore 에 .awl/verify-baseline.json 을 추가한다', () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'awl-baseline-gi-')));
    fs.mkdirSync(path.join(root, '.awl'), { recursive: true });
    writeVerifyBaseline(root, { capturedAt: '2026-07-15T00:00:00.000Z', results: [] });
    const gi = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
    expect(gi).toContain('.awl/verify-baseline.json');
  });

  it('베이스라인 파일이 없으면 readVerifyBaseline 은 null (크래시하지 않는다)', () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'awl-baseline-none-')));
    expect(readVerifyBaseline(root)).toBeNull();
  });
});
