import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isolatedCommit, startBaseline } from '../../src/commands/commit.js';
import { collectChecks } from '../../src/commands/doctor.js';
import * as stateModule from '../../src/commands/state.js';
import {
  abandonWorkitem,
  createWorkitem,
  restoreWorkitem,
  runWorkNew,
  summarizeWorkitems,
} from '../../src/commands/work.js';

describe('summarizeWorkitems (WI-D AC-02)', () => {
  it('현재 워크아이템 + 레지스트리를 하나의 목록으로 합친다', () => {
    const list = summarizeWorkitems({
      workitem: 'WI-D',
      workitemBranch: 'main',
      workitemCreatedAt: '2026-07-14T00:00:00.000Z',
      criteria: [
        { id: 'AC-01', status: 'passed' },
        { id: 'AC-02', status: 'pending' },
      ],
      workitems: {
        'WI-C': {
          status: 'paused',
          createdAt: '2026-07-13T00:00:00.000Z',
          branch: 'main',
          criteria: [
            { id: 'AC-01', status: 'passed' },
            { id: 'AC-02', status: 'passed' },
          ],
        },
        'WI-Z': {
          status: 'abandoned',
          createdAt: '2026-07-12T00:00:00.000Z',
          criteria: [{ id: 'AC-01', status: 'in_progress' }],
        },
      },
    });

    expect(list).toHaveLength(3);
    const wid = list.find((w) => w.id === 'WI-D');
    expect(wid).toEqual({
      id: 'WI-D',
      status: 'active',
      passed: 1,
      total: 2,
      current: true,
      branch: 'main',
      createdAt: '2026-07-14T00:00:00.000Z',
    });
    const wic = list.find((w) => w.id === 'WI-C');
    expect(wic).toMatchObject({ status: 'paused', passed: 2, total: 2, current: false });
    const wiz = list.find((w) => w.id === 'WI-Z');
    expect(wiz).toMatchObject({ status: 'abandoned', passed: 0, total: 1, current: false });
  });

  it('현재 워크아이템이 없으면(workitem 미설정) 레지스트리만 보여준다', () => {
    const list = summarizeWorkitems({
      workitems: { 'WI-A': { status: 'paused', createdAt: 't', criteria: [] } },
    });
    expect(list).toEqual([
      { id: 'WI-A', status: 'paused', passed: 0, total: 0, current: false, createdAt: 't' },
    ]);
  });

  it('레지스트리도 없으면(갓 init 된 프로젝트) 빈 목록', () => {
    expect(summarizeWorkitems({})).toEqual([]);
  });

  it('현재 워크아이템만 있고 레지스트리는 비어 있어도(일반적인 경우) 정상 동작', () => {
    const list = summarizeWorkitems({
      workitem: 'WI-D',
      criteria: [{ id: 'AC-01', status: 'pending' }],
      workitems: {},
    });
    expect(list).toEqual([{ id: 'WI-D', status: 'active', passed: 0, total: 1, current: true }]);
  });
});

describe('createWorkitem (WI-D AC-03, awl work new)', () => {
  it('현재 워크아이템이 없으면 그냥 새로 만든다', () => {
    const result = createWorkitem({}, 'WI-E', '2026-07-14T00:00:00.000Z', 'main');
    expect(result.error).toBeUndefined();
    expect(result.state.workitem).toBe('WI-E');
    expect(result.state.phase).toBe('awaiting-gate1');
    expect(result.state.loop).toBeNull();
    expect(result.state.criteria).toEqual([]);
    expect(result.state.workitemCreatedAt).toBe('2026-07-14T00:00:00.000Z');
    expect(result.state.workitemBranch).toBe('main');
    expect(result.state.workitems).toEqual({});
  });

  it('현재 워크아이템이 있으면 레지스트리에 보관(status: paused)한 뒤 새로 전환한다', () => {
    const before = {
      workitem: 'WI-D',
      phase: 'loop',
      loop: null,
      workitemCreatedAt: '2026-07-13T00:00:00.000Z',
      workitemBranch: 'main',
      criteria: [{ id: 'AC-01', status: 'passed' }],
      workitems: {},
    };
    const result = createWorkitem(before, 'WI-E', '2026-07-14T00:00:00.000Z', 'main');
    expect(result.error).toBeUndefined();
    expect(result.state.workitem).toBe('WI-E');
    expect(result.state.criteria).toEqual([]);
    const registry = result.state.workitems as Record<string, unknown>;
    expect(registry['WI-D']).toEqual({
      status: 'paused',
      createdAt: '2026-07-13T00:00:00.000Z',
      branch: 'main',
      phase: 'loop',
      loop: null,
      criteria: [{ id: 'AC-01', status: 'passed' }],
    });
  });

  it('currentFocus 를 보관 스냅샷에 담고, 새 워크아이템의 최상위엔 새어들지 않는다 (AC-09, 리뷰 지적 — record.ts 의 blocked baseline 추론이 씀)', () => {
    const before = {
      workitem: 'WI-D',
      phase: 'loop',
      loop: null,
      currentFocus: 'AC-01',
      criteria: [{ id: 'AC-01', status: 'in_progress' }],
      workitems: {},
    };
    const result = createWorkitem(before, 'WI-E', '2026-07-14T00:00:00.000Z', null);
    expect(result.error).toBeUndefined();
    // 새 워크아이템은 옛 워크아이템의 포커스를 물려받지 않는다.
    expect(result.state.currentFocus).toBeUndefined();
    // 보관된 WI-D 는 나중에 switch 로 복원할 수 있게 currentFocus 를 담고 있다.
    const registry = result.state.workitems as Record<string, { currentFocus?: string }>;
    expect(registry['WI-D']?.currentFocus).toBe('AC-01');
  });

  it('이미 현재 워크아이템인 ID 로 다시 new 하면 거부한다', () => {
    const result = createWorkitem({ workitem: 'WI-D', criteria: [] }, 'WI-D', 't', null);
    expect(result.error).toContain('WI-D');
    expect(result.state.workitem).toBe('WI-D'); // 안 바뀜
  });

  it('레지스트리에 이미 있는 ID 로 new 하면 거부한다(switch 를 쓰라고 안내)', () => {
    const before = {
      workitem: 'WI-D',
      criteria: [],
      workitems: { 'WI-C': { status: 'paused', createdAt: 't', criteria: [] } },
    };
    const result = createWorkitem(before, 'WI-C', 't2', null);
    expect(result.error).toContain('switch');
  });

  it('현재 워크아이템과 대소문자만 다른 ID 로 new 하면 거부한다 (AC-10, 리뷰 지적)', () => {
    const result = createWorkitem({ workitem: 'WI-D', criteria: [] }, 'wi-d', 't', null);
    expect(result.error).toContain('WI-D');
    expect(result.state.workitem).toBe('WI-D');
  });

  it('레지스트리 항목과 대소문자만 다른 ID 로 new 하면 거부한다 (AC-10, 리뷰 지적)', () => {
    const before = {
      workitem: 'WI-D',
      criteria: [],
      workitems: { 'WI-C': { status: 'paused', createdAt: 't', criteria: [] } },
    };
    const result = createWorkitem(before, 'wi-c', 't2', null);
    expect(result.error).toContain('switch');
  });

  it('빈 ID 는 거부한다', () => {
    const result = createWorkitem({}, '   ', 't', null);
    expect(result.error).toBeDefined();
  });
});

describe('restoreWorkitem (WI-D AC-04, awl work switch)', () => {
  it('왕복 무손실: A -> new B -> switch A 하면 A 의 criteria/phase/currentFocus 가 그대로 복원된다', () => {
    const start = {
      workitem: 'WI-A',
      phase: 'loop',
      loop: null,
      currentFocus: 'AC-02',
      workitemCreatedAt: '2026-07-13T00:00:00.000Z',
      workitemBranch: 'main',
      criteria: [
        { id: 'AC-01', status: 'passed' },
        { id: 'AC-02', status: 'in_progress' },
      ],
      workitems: {},
    };
    const afterNew = createWorkitem(start, 'WI-B', '2026-07-14T00:00:00.000Z', 'main');
    expect(afterNew.error).toBeUndefined();

    const afterSwitch = restoreWorkitem(afterNew.state, 'WI-A', '2026-07-14T01:00:00.000Z', 'main');
    expect(afterSwitch.error).toBeUndefined();
    expect(afterSwitch.state.workitem).toBe('WI-A');
    expect(afterSwitch.state.phase).toBe('loop');
    expect(afterSwitch.state.currentFocus).toBe('AC-02');
    expect(afterSwitch.state.criteria).toEqual(start.criteria);
    // WI-B 는 이제 레지스트리에 보관돼 있고(paused), WI-A 는 레지스트리에서 빠졌다(현재이므로).
    const registry = afterSwitch.state.workitems as Record<string, { status: string }>;
    expect(registry['WI-B']?.status).toBe('paused');
    expect(registry['WI-A']).toBeUndefined();
  });

  it('없는 ID 로 switch 하면 거부하고 new 를 안내한다', () => {
    const result = restoreWorkitem(
      { workitem: 'WI-D', criteria: [], workitems: {} },
      'WI-Z',
      't',
      null,
    );
    expect(result.error).toContain('new');
  });

  it('이미 현재 워크아이템인 ID 로 switch 하면 거부한다', () => {
    const result = restoreWorkitem({ workitem: 'WI-D', criteria: [] }, 'WI-D', 't', null);
    expect(result.error).toContain('WI-D');
  });

  it('저장된 브랜치와 지금 브랜치가 다르면 경고하되 전환은 막지 않는다', () => {
    const before = {
      workitem: 'WI-D',
      criteria: [],
      workitems: {
        'WI-C': { status: 'paused', createdAt: 't', branch: 'feature/x', criteria: [] },
      },
    };
    const result = restoreWorkitem(before, 'WI-C', 't2', 'main');
    expect(result.error).toBeUndefined();
    expect(result.state.workitem).toBe('WI-C');
    expect(result.warning).toContain('feature/x');
    expect(result.warning).toContain('main');
  });

  it('브랜치가 같으면(또는 기록이 없으면) 경고하지 않는다', () => {
    const before = {
      workitem: 'WI-D',
      criteria: [],
      workitems: { 'WI-C': { status: 'paused', createdAt: 't', branch: 'main', criteria: [] } },
    };
    const result = restoreWorkitem(before, 'WI-C', 't2', 'main');
    expect(result.warning).toBeUndefined();
  });

  it('abandoned 워크아이템으로 switch 하면 부활은 허용하되 경고한다 (AC-11, 리뷰 지적 — 사양 공백)', () => {
    const before = {
      workitem: 'WI-D',
      criteria: [],
      workitems: {
        'WI-C': { status: 'abandoned', createdAt: 't', criteria: [{ id: 'AC-01' }] },
      },
    };
    const result = restoreWorkitem(before, 'WI-C', 't2', null);
    expect(result.error).toBeUndefined(); // 삭제가 아니므로 막지 않는다.
    expect(result.state.workitem).toBe('WI-C');
    expect(result.warning).toContain('중단');
  });

  it('paused 워크아이템으로 switch 하면 경고하지 않는다(정상 경로)', () => {
    const before = {
      workitem: 'WI-D',
      criteria: [],
      workitems: { 'WI-C': { status: 'paused', createdAt: 't', criteria: [] } },
    };
    const result = restoreWorkitem(before, 'WI-C', 't2', null);
    expect(result.warning).toBeUndefined();
  });
});

describe('abandonWorkitem (WI-D AC-05, awl work abandon)', () => {
  it('현재 워크아이템을 abandon 하면 최상위를 비우고 레지스트리에 abandoned 로 보관한다', () => {
    const before = {
      workitem: 'WI-D',
      phase: 'loop',
      loop: null,
      currentFocus: 'AC-01',
      criteria: [{ id: 'AC-01', status: 'in_progress' }],
      workitems: {},
    };
    const result = abandonWorkitem(before, 'WI-D', '2026-07-14T00:00:00.000Z');
    expect(result.error).toBeUndefined();
    expect(result.state.workitem).toBeNull();
    expect(result.state.currentFocus).toBeUndefined();
    const registry = result.state.workitems as Record<
      string,
      { status: string; criteria: unknown[] }
    >;
    expect(registry['WI-D']?.status).toBe('abandoned');
    expect(registry['WI-D']?.criteria).toEqual([{ id: 'AC-01', status: 'in_progress' }]);
  });

  it('현재가 아닌(레지스트리) 워크아이템을 abandon 하면 그 항목만 abandoned 로 바뀐다', () => {
    const before = {
      workitem: 'WI-D',
      criteria: [{ id: 'AC-01', status: 'passed' }],
      workitems: {
        'WI-C': { status: 'paused', createdAt: 't', criteria: [{ id: 'AC-01', status: 'passed' }] },
      },
    };
    const result = abandonWorkitem(before, 'WI-C', 't2');
    expect(result.error).toBeUndefined();
    // 현재 워크아이템은 그대로 유지된다.
    expect(result.state.workitem).toBe('WI-D');
    const registry = result.state.workitems as Record<string, { status: string }>;
    expect(registry['WI-C']?.status).toBe('abandoned');
  });

  it('없는 ID 를 abandon 하면 거부한다', () => {
    const result = abandonWorkitem({ workitem: 'WI-D', criteria: [], workitems: {} }, 'WI-Z', 't');
    expect(result.error).toContain('WI-Z');
  });

  it('대소문자만 다른 현재 워크아이템 ID 도 abandon 된다', () => {
    const result = abandonWorkitem({ workitem: 'WI-D', criteria: [] }, 'wi-d', 't');
    expect(result.error).toBeUndefined();
    expect(result.state.workitem).toBeNull();
  });
});

describe('worktreePath 가 archive/restore 를 오가도 새지 않는다 (WI-F AC-03, D-006 교훈 적용)', () => {
  it('createWorkitem 에 worktreePath 를 넘기면 최상위 상태에 담긴다', () => {
    const result = createWorkitem({}, 'WI-F', 't', 'main', undefined, '/repo/.awl-worktrees/WI-F');
    expect(result.error).toBeUndefined();
    expect(result.state.workitemWorktreePath).toBe('/repo/.awl-worktrees/WI-F');
  });

  it('worktreePath 없이 new 하면 그 필드 자체가 안 생긴다(불필요한 null 오염 없음)', () => {
    const result = createWorkitem({}, 'WI-G', 't', 'main');
    expect(result.state.workitemWorktreePath).toBeUndefined();
  });

  it('왕복 무손실: worktree 로 만든 워크아이템을 new 로 다른 것에 넘겼다가 switch 로 되돌리면 worktreePath 가 그대로 복원된다', () => {
    const start = createWorkitem(
      {},
      'WI-F',
      't0',
      'main',
      undefined,
      '/repo/.awl-worktrees/WI-F',
    ).state;
    const afterNew = createWorkitem(start, 'WI-G', 't1', 'main');
    expect(afterNew.error).toBeUndefined();
    // 새 워크아이템(WI-G)은 WI-F 의 worktreePath 를 물려받지 않는다.
    expect(afterNew.state.workitemWorktreePath).toBeUndefined();

    const afterSwitch = restoreWorkitem(afterNew.state, 'WI-F', 't2', 'main');
    expect(afterSwitch.error).toBeUndefined();
    expect(afterSwitch.state.workitemWorktreePath).toBe('/repo/.awl-worktrees/WI-F');
  });

  it('summarizeWorkitems 가 worktreePath 를 포함해 목록에 보여준다', () => {
    const list = summarizeWorkitems({
      workitem: 'WI-F',
      workitemWorktreePath: '/repo/.awl-worktrees/WI-F',
      criteria: [],
      workitems: {},
    });
    expect(list[0]?.worktreePath).toBe('/repo/.awl-worktrees/WI-F');
  });
});

describe('runWorkNew --worktree (WI-F AC-03, 실제 git 저장소로 통합 확인)', () => {
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

  function realGitProject(): string {
    const proj = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'awl-wt-')));
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: proj });
    execFileSync('git', ['config', 'user.email', 't@t.com'], { cwd: proj });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: proj });
    fs.writeFileSync(path.join(proj, 'f.txt'), 'base\n');
    fs.mkdirSync(path.join(proj, '.awl'), { recursive: true });
    execFileSync('git', ['add', '-A'], { cwd: proj });
    execFileSync('git', ['commit', '-q', '-m', 'base'], { cwd: proj });
    process.chdir(proj);
    process.env.AWL_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'awl-home-'));
    return proj;
  }

  it('--worktree 로 실제 git worktree 를 만들고 workitemWorktreePath 를 state.json 에 기록한다', async () => {
    const proj = realGitProject();

    await runWorkNew('WI-TEST', undefined, { worktree: true });

    const wtPath = path.join(proj, '.awl-worktrees', 'WI-TEST');
    expect(fs.existsSync(wtPath)).toBe(true);
    expect(fs.existsSync(path.join(wtPath, 'f.txt'))).toBe(true); // 기존 파일이 그 워크트리에도 체크아웃됨

    const branches = execFileSync('git', ['branch', '--list'], { cwd: proj, encoding: 'utf8' });
    expect(branches).toContain('work/WI-TEST');

    const state = JSON.parse(fs.readFileSync(path.join(proj, '.awl', 'state.json'), 'utf8'));
    expect(state.workitemWorktreePath).toBe(wtPath);
    expect(fs.readFileSync(path.join(proj, '.gitignore'), 'utf8')).toContain('.awl-worktrees/');
  });

  it('--worktree <브랜치명> 을 명시하면 그 이름을 그대로 쓴다', async () => {
    realGitProject();

    await runWorkNew('WI-TEST2', undefined, { worktree: 'feature/custom' });

    const branches = execFileSync('git', ['branch', '--list'], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });
    expect(branches).toContain('feature/custom');
  });

  it('--worktree 없이 new 하면 워크트리를 안 만든다(회귀 없음)', async () => {
    const proj = realGitProject();

    await runWorkNew('WI-TEST3', undefined, {});

    expect(fs.existsSync(path.join(proj, '.awl-worktrees'))).toBe(false);
    const state = JSON.parse(fs.readFileSync(path.join(proj, '.awl', 'state.json'), 'utf8'));
    expect(state.workitemWorktreePath).toBeUndefined();
  });

  it('중복 ID 로 --worktree 시도가 실패하면 orphan worktree/브랜치를 안 남긴다 (AC-06, 리뷰 지적 — 실제 버그 재현)', async () => {
    const proj = realGitProject();
    await runWorkNew('WI-DUP', undefined, {}); // 워크트리 없이 먼저 현재 워크아이템으로 만든다.

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('exit');
    }) as unknown as typeof process.exit);

    await expect(runWorkNew('WI-DUP', undefined, { worktree: true })).rejects.toThrow('exit');

    exitSpy.mockRestore();
    stderrSpy.mockRestore();

    // 실패했으니 git worktree/브랜치가 전혀 안 만들어져야 한다(orphan 없음).
    expect(fs.existsSync(path.join(proj, '.awl-worktrees', 'WI-DUP'))).toBe(false);
    const worktrees = execFileSync('git', ['worktree', 'list'], { cwd: proj, encoding: 'utf8' });
    expect(worktrees).not.toContain('WI-DUP');
    const branches = execFileSync('git', ['branch', '--list'], { cwd: proj, encoding: 'utf8' });
    expect(branches).not.toContain('work/WI-DUP');
  });

  it('워크아이템 ID 에 공백/슬래시가 있어도 git worktree/브랜치 이름이 안전하게 만들어진다 (AC-06, 리뷰 지적 — 테스트 공백)', async () => {
    const proj = realGitProject();

    await runWorkNew('WI TEST/danger', undefined, { worktree: true });

    const wtPath = path.join(proj, '.awl-worktrees', 'WI_TEST_danger');
    expect(fs.existsSync(wtPath)).toBe(true); // 경로 자체가 sanitize 된 이름으로 만들어짐
    const branches = execFileSync('git', ['branch', '--list'], { cwd: proj, encoding: 'utf8' });
    expect(branches).toContain('work/WI_TEST_danger');
  });

  it('precheck 이후 레이스로 최종 createWorkitem 이 실패하면 이미 만든 워크트리/브랜치를 정리한다 (AC-09, 2차 리뷰 지적)', async () => {
    const proj = realGitProject();
    const realLoadState = stateModule.loadState;
    let calls = 0;
    const loadStateSpy = vi.spyOn(stateModule, 'loadState').mockImplementation((root) => {
      calls += 1;
      if (calls === 2) {
        // precheck 는 통과했지만, 실제 worktree 를 만든 뒤(느린 비동기 구간) 다른
        // awl 프로세스가 같은 ID 로 워크아이템을 먼저 만든 것처럼 상태를 바꾼다.
        const statePath = path.join(root, '.awl', 'state.json');
        fs.mkdirSync(path.dirname(statePath), { recursive: true });
        fs.writeFileSync(
          statePath,
          JSON.stringify({ generation: 1, workitem: 'WI-RACE', criteria: [], workitems: {} }),
        );
      }
      return realLoadState(root);
    });

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('exit');
    }) as unknown as typeof process.exit);

    await expect(runWorkNew('WI-RACE', undefined, { worktree: true })).rejects.toThrow('exit');

    loadStateSpy.mockRestore();
    exitSpy.mockRestore();
    stderrSpy.mockRestore();

    // 레이스로 최종 검증은 실패했지만, 이미 만든 git worktree/브랜치는 정리돼야 한다.
    expect(fs.existsSync(path.join(proj, '.awl-worktrees', 'WI-RACE'))).toBe(false);
    const worktrees = execFileSync('git', ['worktree', 'list'], { cwd: proj, encoding: 'utf8' });
    expect(worktrees).not.toContain('WI-RACE');
    const branches = execFileSync('git', ['branch', '--list'], { cwd: proj, encoding: 'utf8' });
    expect(branches).not.toContain('work/WI-RACE');
  });
});

describe('WI-F 통합: 더러운 워크트리 -> doctor 경고 -> work new --worktree 격리 -> 그 안에서 commit -> 원래 워크트리의 남의 변경 보존', () => {
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

  it('실사고 재현: 남의 미커밋 변경이 있는 워크트리에서 격리 워크트리로 옮기면 원래 변경이 그대로 남는다', async () => {
    // 1. 남의(다른 세션의) 미커밋 변경이 있는 더러운 워크트리를 만든다.
    const proj = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'awl-e2e-')));
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: proj });
    execFileSync('git', ['config', 'user.email', 't@t.com'], { cwd: proj });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: proj });
    fs.writeFileSync(path.join(proj, 'shared.txt'), 'base\n');
    fs.mkdirSync(path.join(proj, '.awl'), { recursive: true });
    execFileSync('git', ['add', '-A'], { cwd: proj });
    execFileSync('git', ['commit', '-q', '-m', 'base'], { cwd: proj });
    // 남의 미커밋 변경(다른 세션이 작업하다 만 것이라고 가정).
    fs.appendFileSync(path.join(proj, 'shared.txt'), '다른 세션의 변경\n');
    fs.writeFileSync(path.join(proj, 'their-new-file.txt'), '다른 세션의 새 파일\n');

    process.chdir(proj);
    process.env.AWL_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'awl-e2e-home-'));

    // 2. doctor 가 더러움을 경고한다(awl 이 직접 git status 를 쳐서 — AC-01).
    const report = await collectChecks();
    const dirtyCheck = report.checks.find((c) => c.name === '워킹트리');
    expect(dirtyCheck?.status).toBe('warn');
    expect(dirtyCheck?.value).toContain('2');

    // 3. 격리 워크트리를 만든다(AC-03) — 더러운 원래 워크트리는 건드리지 않는다.
    await runWorkNew('WI-RESCUE', undefined, { worktree: true });
    const wtPath = path.join(proj, '.awl-worktrees', 'WI-RESCUE');
    expect(fs.existsSync(wtPath)).toBe(true);

    // 4. 원래 워크트리의 남의 변경은 그대로다 — work new --worktree 는 원래
    //    워크트리를 전혀 건드리지 않는다(git worktree add 는 새 디렉토리만 만든다).
    expect(fs.readFileSync(path.join(proj, 'shared.txt'), 'utf8')).toContain('다른 세션의 변경');
    expect(fs.existsSync(path.join(proj, 'their-new-file.txt'))).toBe(true);
    const stillDirty = execFileSync('git', ['status', '--porcelain'], {
      cwd: proj,
      encoding: 'utf8',
    });
    expect(stillDirty.trim()).not.toBe('');

    // 5. 격리된 새 워크트리 안에서는 클린한 상태로 시작해서 awl commit 이 정상 동작한다.
    fs.writeFileSync(path.join(wtPath, 'my-work.txt'), 'my change\n');
    const { snapshot } = await startBaseline(wtPath, 'AC-RESCUE');
    fs.appendFileSync(path.join(wtPath, 'my-work.txt'), 'more\n');
    const outcome = await isolatedCommit(wtPath, 'AC-RESCUE', 'rescue worktree work', snapshot);
    expect(outcome.committed).toBe(true);
    expect(outcome.stagedFiles).toContain('my-work.txt');

    // 6. 격리 워크트리에서의 작업이 원래(더러운) 워크트리에는 전혀 안 보인다.
    expect(fs.existsSync(path.join(proj, 'my-work.txt'))).toBe(false);
  });
});
