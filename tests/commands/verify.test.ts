import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { VerifyMap } from '../../src/commands/config.js';
import {
  type VerifyReport,
  buildVerifyBaseline,
  compareSinceBaseline,
  readVerifyBaseline,
  resolveSinceBaseline,
  runVerifyChecks,
  sinceBaselineFallbackMessage,
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
    const baseline = buildVerifyBaseline(report, '2026-07-15T00:00:00.000Z', 'WI-X');
    expect(baseline.capturedAt).toBe('2026-07-15T00:00:00.000Z');
    expect(baseline.workitem).toBe('WI-X');
    expect(baseline.results).toEqual([
      { name: 'typecheck', passed: true },
      { name: 'test', passed: false },
    ]);
    expect(JSON.stringify(baseline)).not.toContain('output');
  });

  it('command_not_found 인 체크도 실패로 잡는다', async () => {
    const report = await runVerifyChecks(
      vmap({ typecheck: { cmd: 'awl_no_such_tool_zzz .' } }),
      process.cwd(),
      { bail: false },
    );
    const baseline = buildVerifyBaseline(report, '2026-07-15T00:00:00.000Z', 'WI-X');
    expect(baseline.results).toEqual([{ name: 'typecheck', passed: false }]);
  });

  it('timedOut 인 체크도 실패로 잡는다 (AC-09, 리뷰 지적 — 이전엔 이름만 주장하고 실제로는 미검증)', () => {
    const report: VerifyReport = {
      passed: false,
      results: [{ name: 'e2e', exitCode: null, durationMs: 600_000, output: '', timedOut: true }],
    };
    const baseline = buildVerifyBaseline(report, '2026-07-15T00:00:00.000Z', 'WI-X');
    expect(baseline.results).toEqual([{ name: 'e2e', passed: false }]);
  });

  it('writeVerifyBaseline 으로 저장한 파일을 readVerifyBaseline 이 그대로 읽는다', () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'awl-baseline-')));
    fs.mkdirSync(path.join(root, '.awl'), { recursive: true });
    const baseline = {
      capturedAt: '2026-07-15T00:00:00.000Z',
      workitem: 'WI-X',
      results: [{ name: 'typecheck', passed: true }],
    };
    writeVerifyBaseline(root, baseline);
    expect(fs.existsSync(verifyBaselinePath(root))).toBe(true);
    expect(readVerifyBaseline(root)).toEqual(baseline);
  });

  it('writeVerifyBaseline 은 .gitignore 에 .awl/verify-baseline.json 을 추가한다', () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'awl-baseline-gi-')));
    fs.mkdirSync(path.join(root, '.awl'), { recursive: true });
    writeVerifyBaseline(root, {
      capturedAt: '2026-07-15T00:00:00.000Z',
      workitem: 'WI-X',
      results: [],
    });
    const gi = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
    expect(gi).toContain('.awl/verify-baseline.json');
  });

  it('베이스라인 파일이 없으면 readVerifyBaseline 은 null (크래시하지 않는다)', () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'awl-baseline-none-')));
    expect(readVerifyBaseline(root)).toBeNull();
  });
});

describe('compareSinceBaseline (WI-G AC-02/03) — 신규 실패 vs 사전 결함 구분', () => {
  function reportOf(entries: [string, boolean][]): VerifyReport {
    return {
      passed: entries.every(([, ok]) => ok),
      results: entries.map(([name, ok]) => ({
        name,
        exitCode: ok ? 0 : 1,
        durationMs: 1,
        output: '',
      })),
    };
  }

  function baselineOf(entries: [string, boolean][]) {
    return {
      capturedAt: '2026-07-15T00:00:00.000Z',
      workitem: 'WI-X',
      results: entries.map(([name, passed]) => ({ name, passed })),
    };
  }

  it('신규 실패(베이스라인 땐 통과) 가 있으면 회귀로 판정한다', () => {
    const baseline = baselineOf([
      ['typecheck', true],
      ['test', true],
    ]);
    const report = reportOf([
      ['typecheck', true],
      ['test', false],
    ]);
    const c = compareSinceBaseline(report, baseline);
    expect(c.newFailures).toEqual(['test']);
    expect(c.passed).toBe(false);
  });

  it('사전 결함(베이스라인 때도 실패) 은 회귀로 안 잡는다 — 신규 실패가 없으면 passed:true (AC-03)', () => {
    const baseline = baselineOf([
      ['typecheck', true],
      ['e2e', false],
    ]);
    const report = reportOf([
      ['typecheck', true],
      ['e2e', false],
    ]);
    const c = compareSinceBaseline(report, baseline);
    expect(c.preExistingFailures).toEqual(['e2e']);
    expect(c.newFailures).toEqual([]);
    expect(c.passed).toBe(true);
  });

  it('사전 결함이 해소되면 resolved 로 표시하고 passed 에 영향 없다', () => {
    const baseline = baselineOf([['test', false]]);
    const report = reportOf([['test', true]]);
    const c = compareSinceBaseline(report, baseline);
    expect(c.resolved).toEqual(['test']);
    expect(c.passed).toBe(true);
  });

  it('베이스라인에 없던 체크가 지금 실패하면 안전하게 신규 실패로 취급한다', () => {
    const baseline = baselineOf([['typecheck', true]]);
    const report = reportOf([
      ['typecheck', true],
      ['e2e', false],
    ]);
    const c = compareSinceBaseline(report, baseline);
    expect(c.newFailures).toEqual(['e2e']);
    expect(c.passed).toBe(false);
  });
});

describe('WI-G AC-05 통합: 베이스라인 캡처 -> 새 실패 발생 -> --since-baseline 비교', () => {
  function tmpProject(): string {
    return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'awl-since-baseline-')));
  }

  /** flag 파일 내용이 'fail' 이면 exit 1, 아니면 exit 0 인 가짜 검증 스크립트. */
  function makeToggleCheck(root: string, name: string, initial: 'pass' | 'fail'): string {
    const flagPath = path.join(root, `${name}.flag`);
    fs.writeFileSync(flagPath, initial);
    const scriptPath = path.join(root, `${name}.js`);
    fs.writeFileSync(
      scriptPath,
      `const fs=require('fs');process.exit(fs.readFileSync(${JSON.stringify(flagPath)},'utf8').trim()==='fail'?1:0);`,
    );
    return flagPath;
  }

  it('사전 결함은 계속 사전 결함으로, 나중에 새로 생긴 실패만 회귀로 잡는다', async () => {
    const root = tmpProject();
    // typecheck: 항상 통과. test: 처음엔 통과(나중에 회귀). e2e: 처음부터 실패(사전 결함, 안 고쳐짐).
    const testFlag = makeToggleCheck(root, 'test', 'pass');
    makeToggleCheck(root, 'e2e', 'fail');
    const verify = vmap({
      typecheck: { cmd: `${NODE} --version` },
      test: { cmd: `${NODE} ${path.join(root, 'test.js')}` },
      e2e: { cmd: `${NODE} ${path.join(root, 'e2e.js')}` },
    });

    // 1. 워크아이템 시작 시점 베이스라인 캡처.
    const baselineReport = await runVerifyChecks(verify, root, { bail: false });
    writeVerifyBaseline(
      root,
      buildVerifyBaseline(baselineReport, '2026-07-15T00:00:00.000Z', 'WI-X'),
    );

    // 2. 작업 중 test 에 회귀가 생긴다(baseline 땐 통과, 지금은 실패). e2e 는 그대로 실패.
    fs.writeFileSync(testFlag, 'fail');

    // 3. --since-baseline 비교.
    const nowReport = await runVerifyChecks(verify, root, { bail: false });
    const baseline = readVerifyBaseline(root);
    expect(baseline).not.toBeNull();
    const comparison = compareSinceBaseline(nowReport, baseline as NonNullable<typeof baseline>);

    expect(comparison.newFailures).toEqual(['test']); // 새로 생긴 회귀만.
    expect(comparison.preExistingFailures).toEqual(['e2e']); // 원래부터 있던 결함, 회귀 아님.
    expect(comparison.resolved).toEqual([]);
    expect(comparison.passed).toBe(false); // 신규 실패가 있으므로.

    // 4. e2e 사전 결함을 나중에 고치면 resolved 로 잡힌다(AC-03: 신규 실패만 없으면 passed).
    //    test 는 baseline 때 이미 통과였으니, 회귀를 되돌려도 "해소"가 아니라
    //    그냥 원상복구다(resolved 는 baseline 때 실패였던 것만 해당).
    fs.writeFileSync(testFlag, 'pass'); // test 회귀도 고쳤다고 가정.
    const e2eFlag = path.join(root, 'e2e.flag');
    fs.writeFileSync(e2eFlag, 'pass');
    const fixedReport = await runVerifyChecks(verify, root, { bail: false });
    const fixedComparison = compareSinceBaseline(
      fixedReport,
      baseline as NonNullable<typeof baseline>,
    );
    expect(fixedComparison.resolved).toEqual(['e2e']);
    expect(fixedComparison.newFailures).toEqual([]);
    expect(fixedComparison.passed).toBe(true);
  });

  it('베이스라인이 없으면(캡처를 안 했거나 --skip-baseline) readVerifyBaseline 이 null 이라 폴백해야 함을 알 수 있다', async () => {
    const root = tmpProject();
    const verify = vmap({ typecheck: { cmd: `${NODE} --version` } });
    await runVerifyChecks(verify, root, { bail: false }); // 베이스라인을 캡처하지 않음.
    expect(readVerifyBaseline(root)).toBeNull();
  });
});

describe('resolveSinceBaseline (WI-G AC-06/AC-07, 리뷰 지적)', () => {
  const report: VerifyReport = {
    passed: true,
    results: [{ name: 'typecheck', exitCode: 0, durationMs: 1, output: '' }],
  };
  const baselineForA = {
    capturedAt: '2026-07-15T00:00:00.000Z',
    workitem: 'WI-A',
    results: [{ name: 'typecheck', passed: true }],
  };

  it('베이스라인이 없으면 available:false, reason:no_baseline', () => {
    const r = resolveSinceBaseline(report, null, 'WI-A');
    expect(r).toEqual({ available: false, reason: 'no_baseline' });
  });

  it('베이스라인의 워크아이템이 현재 워크아이템과 다르면(work switch 로 남은 낡은 베이스라인) available:false, reason:workitem_mismatch — 무음으로 잘못 비교하지 않는다 (AC-06, 리뷰 지적)', () => {
    const r = resolveSinceBaseline(report, baselineForA, 'WI-B');
    expect(r).toEqual({ available: false, reason: 'workitem_mismatch' });
  });

  it('워크아이템이 일치하면 정상적으로 비교한다', () => {
    const r = resolveSinceBaseline(report, baselineForA, 'WI-A');
    expect(r.available).toBe(true);
    if (r.available) {
      expect(r.comparison.passed).toBe(true);
    }
  });

  it('현재 워크아이템이 null(레거시 state 등) 이어도 베이스라인도 workitem:null 이면 일치로 본다', () => {
    const legacyBaseline = { ...baselineForA, workitem: null };
    const r = resolveSinceBaseline(report, legacyBaseline, null);
    expect(r.available).toBe(true);
  });

  it('workitem 필드가 아예 없는 진짜 레거시 verify-baseline.json 을 읽어도 크래시 없이 안전하게 폴백한다 (AC-10, 2차 리뷰 지적 — 객체 리터럴이 아니라 실제 파일로)', () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'awl-baseline-legacy-')));
    fs.mkdirSync(path.join(root, '.awl'), { recursive: true });
    // workitem 필드를 추가하기 전(WI-G AC-06 이전) 버전의 실제 저장 형식을 흉내낸다.
    fs.writeFileSync(
      verifyBaselinePath(root),
      `${JSON.stringify({
        capturedAt: '2026-01-01T00:00:00.000Z',
        results: [{ name: 'typecheck', passed: true }],
      })}\n`,
    );

    const legacyBaseline = readVerifyBaseline(root);
    expect(legacyBaseline).not.toBeNull();
    const r = resolveSinceBaseline(report, legacyBaseline, 'WI-A');
    expect(r).toEqual({ available: false, reason: 'workitem_mismatch' });
  });
});

describe('sinceBaselineFallbackMessage (WI-H AC-04, 스파이크 지적 — 실행 불가능한 조치 안내)', () => {
  it('workitem_mismatch 메시지는 awl work new 재실행을 권하지 않는다 — 그 명령은 이미 존재하는 워크아이템 ID 에 대해 항상 실패한다', () => {
    const msg = sinceBaselineFallbackMessage('workitem_mismatch');
    expect(msg).not.toContain('awl work new');
  });

  it('no_baseline 메시지는 여전히 awl work new 를 정확하게 안내한다(이 경우엔 실제로 유효한 조치다)', () => {
    const msg = sinceBaselineFallbackMessage('no_baseline');
    expect(msg).toContain('awl work new');
  });
});
