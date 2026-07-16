import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runCommit } from '../../src/commands/commit.js';
import { runRecord } from '../../src/commands/record.js';
import { loadState, runStateSet } from '../../src/commands/state.js';
import { runWorkNew } from '../../src/commands/work.js';

/**
 * P0 회귀 가드.
 *
 * awaiting-gate1 은 `awl work new` 가 세팅하는 "조사~완료조건" 전 구간이다(스킬
 * 절대규칙 11: 조사 전에 반드시 work new). 이 구간에서 record audit/criteria 와
 * state set 을 막으면, 정작 게이트 1 에서 승인할 계획 자체를 세울 수 없는 데드락이
 * 된다(0.6.0 실사고 — 유일하게 통과하는 record gate 로 "빈 계획"을 승인하게 됨).
 * 이 테스트는 그 파이프라인이 막히지 않는지, 그리고 코드 수정성 명령인 commit 만은
 * 게이트 전에 여전히 막히는지 검증한다.
 */
describe('게이트 1 흐름 — awaiting-gate1 파이프라인 데드락 방지 (P0)', () => {
  const origCwd = process.cwd();
  const origHome = process.env.AWL_HOME;

  afterEach(() => {
    process.chdir(origCwd);
    if (origHome === undefined) {
      delete process.env.AWL_HOME;
    } else {
      process.env.AWL_HOME = origHome;
    }
  });

  function realProject(): string {
    const proj = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'awl-gate-')));
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: proj });
    execFileSync('git', ['config', 'user.email', 't@t.com'], { cwd: proj });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: proj });
    fs.writeFileSync(path.join(proj, 'f.txt'), 'base\n');
    fs.mkdirSync(path.join(proj, '.awl'), { recursive: true });
    fs.writeFileSync(
      path.join(proj, '.awl', 'config.json'),
      JSON.stringify({
        project: 'gateflow',
        mainLanguage: 'typescript',
        character: 't',
        engineVersion: '0.6.0',
        verify: { typecheck: null, lint: null, test: null, e2e: null },
      }),
    );
    execFileSync('git', ['add', '-A'], { cwd: proj });
    execFileSync('git', ['commit', '-q', '-m', 'base'], { cwd: proj });
    process.chdir(proj);
    process.env.AWL_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'awl-gate-home-'));
    return proj;
  }

  it('work new 직후 awaiting-gate1 에서 record audit/criteria 와 state set 이 안 막히고, record gate 승인이 phase 를 loop 로 전이하며 criteria 를 보존한다', async () => {
    const proj = realProject();
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    // exit 이 불리면(=차단되면) throw 해서, 파이프라인이 막히는 회귀를 즉시 실패로 잡는다.
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('exit');
    }) as unknown as typeof process.exit);

    try {
      await runWorkNew('WI-01', '게이트 흐름 검증', {});
      expect(loadState(proj).phase).toBe('awaiting-gate1');

      // [조사] → [완료조건] → state set: 어느 것도 차단(exit)되면 안 된다.
      await runRecord('audit', {
        json: '{"scope":"src","findings":[{"id":"F-01","what":"x","severity":"high"}]}',
      });
      await runRecord('criteria', {
        json: '{"items":[{"id":"AC-01","조건":"c","범위":"src","검증":"awl verify","addresses":["F-01"]}]}',
      });
      runStateSet(
        '{"phase":"awaiting-gate1","criteria":[{"id":"AC-01","status":"pending","attempts":0,"addresses":["F-01"]}]}',
      );

      expect(exitSpy).not.toHaveBeenCalled();
      const afterSet = loadState(proj);
      expect(afterSet.phase).toBe('awaiting-gate1');
      expect(Array.isArray(afterSet.criteria)).toBe(true);
      expect((afterSet.criteria as unknown[]).length).toBe(1);

      // 게이트 1 승인 → phase 가 loop 로 전이되고 criteria 는 보존된다.
      await runRecord('gate', {
        json: '{"gate":1,"decision":"approved","presentedCriteria":["AC-01"],"presentedExclusions":[]}',
      });
      const afterGate = loadState(proj);
      expect(afterGate.phase).toBe('loop');
      const gateCriteria = afterGate.criteria as Record<string, unknown>[];
      expect(gateCriteria[0]?.id).toBe('AC-01');
      expect(exitSpy).not.toHaveBeenCalled();
    } finally {
      exitSpy.mockRestore();
      stderrSpy.mockRestore();
      stdoutSpy.mockRestore();
    }
  });

  it('awaiting-gate1 에서 commit 은 여전히 차단된다 (item [5] 의도 — 코드 수정성 명령)', async () => {
    const proj = realProject();
    await runWorkNew('WI-02', undefined, {});
    expect(loadState(proj).phase).toBe('awaiting-gate1');

    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('exit');
    }) as unknown as typeof process.exit);

    await expect(runCommit('AC-01', { start: true })).rejects.toThrow('exit');
    expect(exitSpy).toHaveBeenCalledWith(1);

    exitSpy.mockRestore();
    stderrSpy.mockRestore();
    stdoutSpy.mockRestore();
  });
});
