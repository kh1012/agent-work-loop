import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isolatedCommit, startBaseline } from '../../src/commands/commit.js';
import { collectChecks } from '../../src/commands/doctor.js';
import * as initModule from '../../src/commands/init.js';
import * as stateModule from '../../src/commands/state.js';
import * as verifyModule from '../../src/commands/verify.js';
import { readVerifyBaseline } from '../../src/commands/verify.js';
import {
  DEFAULT_GIT_WORKTREE_TIMEOUT_MS,
  abandonWorkitem,
  buildWorktreeError,
  createWorkitem,
  formatWorktreeReport,
  markWorkitemDone,
  readDiskAvailable,
  renderWorkList,
  resolveGitWorktreeTimeoutMs,
  restoreWorkitem,
  runWorkDone,
  runWorkList,
  runWorkNew,
  runWorkSwitch,
  summarizeWorkitems,
} from '../../src/commands/work.js';
import { visibleWidth } from '../../src/core/tty.js';

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

  it('experiment 케이스 메타를 workitemExperiment 로 보존한다 (experiment-harness AC-01)', () => {
    const exp = { model: 'lite', mode: 'loop', taskType: 'ui' };
    const withExp = createWorkitem({}, 'WI-E', 't', 'main', undefined, undefined, exp);
    expect(withExp.state.workitemExperiment).toEqual(exp);
    // 없으면 필드가 아예 없다(하위호환)
    const without = createWorkitem({}, 'WI-F', 't', 'main');
    expect('workitemExperiment' in without.state).toBe(false);
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

describe('markWorkitemDone (awl work done, 피드백 F-5)', () => {
  it('현재 워크아이템을 done 하면 레지스트리에 done 으로 보관하고 criteria 스냅샷을 비운다', () => {
    const before = {
      workitem: 'WI-D',
      phase: 'loop',
      criteria: [
        {
          id: 'AC-01',
          status: 'passed',
          baseline: 'abc123',
          snapshot: 'def456',
          untrackedAtStart: ['a.ts', 'b.ts'],
        },
      ],
      workitemWorktreePath: '/repo/.awl-worktrees/WI-D',
      workitems: {},
    };
    const result = markWorkitemDone(before, 'WI-D', '2026-07-16T00:00:00.000Z');
    expect(result.error).toBeUndefined();
    expect(result.state.workitem).toBeNull();
    const registry = result.state.workitems as Record<
      string,
      { status: string; criteria: Record<string, unknown>[] }
    >;
    expect(registry['WI-D']?.status).toBe('done');
    // 스냅샷 필드(untrackedAtStart/snapshot)는 비우고 baseline·status 는 남긴다.
    expect(registry['WI-D']?.criteria[0]).toEqual({
      id: 'AC-01',
      status: 'passed',
      baseline: 'abc123',
    });
    // 워크트리 경로는 핸들러가 제거하도록 돌려준다.
    expect(result.worktree?.path).toBe('/repo/.awl-worktrees/WI-D');
  });

  it('레지스트리 워크아이템을 done 하면 그 항목만 done 으로 바뀌고 스냅샷을 비운다', () => {
    const before = {
      workitem: 'WI-D',
      criteria: [],
      workitems: {
        'WI-C': {
          status: 'paused',
          createdAt: 't',
          criteria: [{ id: 'AC-01', status: 'passed', snapshot: 'x', untrackedAtStart: ['y'] }],
          worktreePath: '/repo/.awl-worktrees/WI-C',
        },
      },
    };
    const result = markWorkitemDone(before, 'WI-C', 't2');
    expect(result.error).toBeUndefined();
    expect(result.state.workitem).toBe('WI-D'); // 현재는 그대로 유지
    const registry = result.state.workitems as Record<
      string,
      { status: string; criteria: Record<string, unknown>[] }
    >;
    expect(registry['WI-C']?.status).toBe('done');
    expect(registry['WI-C']?.criteria[0]).toEqual({ id: 'AC-01', status: 'passed' });
    expect(result.worktree?.path).toBe('/repo/.awl-worktrees/WI-C');
  });

  it('없는 ID 를 done 하면 거부한다', () => {
    const result = markWorkitemDone({ workitem: 'WI-D', criteria: [], workitems: {} }, 'WI-Z', 't');
    expect(result.error).toContain('WI-Z');
  });

  it('워크트리 없는 워크아이템은 worktree 를 돌려주지 않는다', () => {
    const result = markWorkitemDone({ workitem: 'WI-D', criteria: [] }, 'WI-D', 't');
    expect(result.error).toBeUndefined();
    expect(result.worktree).toBeUndefined();
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

describe('resolveGitWorktreeTimeoutMs (D-46, 대형 리포 타임아웃 오버라이드)', () => {
  it('env 미설정이면 기본값(180000)을 돌려준다', () => {
    expect(resolveGitWorktreeTimeoutMs({})).toBe(DEFAULT_GIT_WORKTREE_TIMEOUT_MS);
    expect(DEFAULT_GIT_WORKTREE_TIMEOUT_MS).toBe(180_000);
  });

  it('빈 문자열도 기본값으로 폴백한다', () => {
    expect(resolveGitWorktreeTimeoutMs({ AWL_GIT_WORKTREE_TIMEOUT_MS: '' })).toBe(
      DEFAULT_GIT_WORKTREE_TIMEOUT_MS,
    );
  });

  it('유효한 숫자 문자열은 그대로 파싱한다', () => {
    expect(resolveGitWorktreeTimeoutMs({ AWL_GIT_WORKTREE_TIMEOUT_MS: '300000' })).toBe(300_000);
  });

  it('0 이하나 비숫자는 기본값으로 폴백한다(타임아웃을 사실상 꺼버리는 사고 방지)', () => {
    expect(resolveGitWorktreeTimeoutMs({ AWL_GIT_WORKTREE_TIMEOUT_MS: '0' })).toBe(
      DEFAULT_GIT_WORKTREE_TIMEOUT_MS,
    );
    expect(resolveGitWorktreeTimeoutMs({ AWL_GIT_WORKTREE_TIMEOUT_MS: '-5' })).toBe(
      DEFAULT_GIT_WORKTREE_TIMEOUT_MS,
    );
    expect(resolveGitWorktreeTimeoutMs({ AWL_GIT_WORKTREE_TIMEOUT_MS: 'abc' })).toBe(
      DEFAULT_GIT_WORKTREE_TIMEOUT_MS,
    );
  });
});

describe('buildWorktreeError (D-46, 타임아웃 원인을 명확한 문구로)', () => {
  it('타임아웃이 아니면 raw 메시지를 그대로 돌려준다(힌트 없음)', () => {
    expect(buildWorktreeError('fatal: xyz', false, 180_000)).toBe('fatal: xyz');
  });

  it('타임아웃이면 실제 재현 문자열 뒤에 초 수와 환경변수 안내를 덧붙인다 (버그 회귀 고정)', () => {
    const msg = buildWorktreeError('fatal: Could not write new index file.', true, 180_000);
    expect(msg).toContain('fatal: Could not write new index file.');
    expect(msg).toContain('180초');
    expect(msg).toContain('AWL_GIT_WORKTREE_TIMEOUT_MS');
  });

  it('raw 가 비어 있어도 힌트만 깔끔하게 돌려준다', () => {
    const msg = buildWorktreeError('', true, 60_000);
    expect(msg).toContain('60초');
    expect(msg.startsWith('\n')).toBe(false);
  });
});

describe('readDiskAvailable (D-46, 디스크 여유공간 best-effort 측정)', () => {
  it('실제 존재하는 경로는 양수 바이트를 돌려준다', () => {
    const bytes = readDiskAvailable(os.tmpdir());
    expect(bytes).not.toBeNull();
    expect(bytes as number).toBeGreaterThan(0);
  });

  it('존재하지 않는 경로는 예외 없이 null 을 돌려준다', () => {
    expect(readDiskAvailable('/definitely/not/a/real/path/xyz')).toBeNull();
  });
});

describe('formatWorktreeReport (D-46, 소요시간 + 디스크 델타 한 줄 리포트)', () => {
  it('디스크 델타를 부호와 함께 GB 단위로 포맷한다', () => {
    const line = formatWorktreeReport({
      durationMs: 40_177,
      diskBeforeBytes: 88_200_000_000,
      diskAfterBytes: 86_100_000_000,
    });
    expect(line).toContain('40.2초');
    expect(line).toContain('86.1GB');
    expect(line).toContain('Δ -2.1GB');
  });

  it('디스크 사용량이 늘어난 경우(드묾) + 부호를 붙인다', () => {
    const line = formatWorktreeReport({
      durationMs: 1000,
      diskBeforeBytes: 1_000_000_000,
      diskAfterBytes: 1_500_000_000,
    });
    expect(line).toContain('Δ +0.5GB');
  });

  it('디스크 측정이 불가능하면(null) 소요시간만 보여준다', () => {
    const line = formatWorktreeReport({
      durationMs: 5000,
      diskBeforeBytes: null,
      diskAfterBytes: null,
    });
    expect(line).toContain('5.0초');
    expect(line).toContain('측정 불가');
    expect(line).not.toContain('GB');
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

  it('워크트리 생성 성공 시 소요시간·디스크 리포트를 stdout 에 찍는다 (D-46)', async () => {
    realGitProject();
    const writes: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((s: unknown) => {
      writes.push(String(s));
      return true;
    });
    try {
      await runWorkNew('WI-REPORT', undefined, { worktree: true });
    } finally {
      spy.mockRestore();
    }
    const out = writes.join('');
    expect(out).toContain('소요시간');
    // 플랫폼/권한에 따라 디스크 측정이 안 될 수도 있어 둘 중 하나만 요구한다.
    expect(out).toMatch(/디스크 여유공간|측정 불가/);
  });

  it('opts.experiment 를 state.workitemExperiment 로 전달한다 (experiment-harness AC-06 passthrough, 리뷰)', async () => {
    const proj = realGitProject();
    await runWorkNew('WI-EXP', undefined, {
      experiment: { model: 'lite', mode: 'loop', taskType: 'ui' },
    });
    const state = JSON.parse(fs.readFileSync(path.join(proj, '.awl', 'state.json'), 'utf8'));
    // runWorkNew → createWorkitem passthrough 가 끊기면 이 필드가 사라진다(회귀 킬).
    expect(state.workitemExperiment).toEqual({ model: 'lite', mode: 'loop', taskType: 'ui' });
  });

  it('--worktree 출력에 병렬 세션 hint(AWL_HOME 분리)를 붙이고, --worktree 없으면 안 붙인다 (concurrency-1 AC-01)', async () => {
    const capture = (): { writes: string[]; restore: () => void } => {
      const writes: string[] = [];
      const spy = vi.spyOn(process.stdout, 'write').mockImplementation((s: unknown) => {
        writes.push(String(s));
        return true;
      });
      return { writes, restore: () => spy.mockRestore() };
    };

    const proj = realGitProject();
    const withWt = capture();
    try {
      await runWorkNew('WI-HINT', undefined, { worktree: true });
    } finally {
      withWt.restore();
    }
    const out = withWt.writes.join('');
    // records(~/.awl)가 전역 공유임을 알리고 AWL_HOME 분리를 안내한다.
    expect(out).toContain('AWL_HOME');
    expect(out).toMatch(/전역|병렬/);

    // --worktree 없는 실행에는 이 hint 가 뜨지 않는다.
    const noWt = capture();
    try {
      await runWorkNew('WI-NOHINT', undefined, {});
    } finally {
      noWt.restore();
    }
    expect(noWt.writes.join('')).not.toContain('AWL_HOME');
  });

  it('--isolated 는 전용 .awl/home 을 만들고 export AWL_HOME 안내를 출력한다 (concurrency-2 AC-02)', async () => {
    const proj = realGitProject();
    const writes: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((s: unknown) => {
      writes.push(String(s));
      return true;
    });
    try {
      await runWorkNew('WI-ISO', undefined, { isolated: true });
    } finally {
      spy.mockRestore();
    }
    // --worktree 없으면 전용 home 은 root 아래 .awl/home.
    const homeDir = path.join(proj, '.awl', 'home');
    expect(fs.existsSync(homeDir)).toBe(true);
    const out = writes.join('');
    expect(out).toContain('export AWL_HOME=');
    expect(out).toContain(homeDir);
    // 이중 방어(AC-04): self-filter 뿐 아니라 gitignore 에도 넣어 표준 git 조작 오염 차단.
    expect(fs.readFileSync(path.join(proj, '.gitignore'), 'utf8')).toContain('.awl/home/');
  });

  it('--isolated 없이는 .awl/home 을 만들지 않는다 (concurrency-2 AC-02 회귀)', async () => {
    const proj = realGitProject();
    await runWorkNew('WI-NOISO', undefined, {});
    expect(fs.existsSync(path.join(proj, '.awl', 'home'))).toBe(false);
  });

  it('runWorkDone — 실제 워크트리를 제거하고 state 를 done 으로 기록한다 (F-5)', async () => {
    const proj = realGitProject();
    await runWorkNew('WI-DONE', undefined, { worktree: true });
    const wtPath = path.join(proj, '.awl-worktrees', 'WI-DONE');
    expect(fs.existsSync(wtPath)).toBe(true);

    await runWorkDone('WI-DONE', {});

    // 워크트리 디렉토리는 제거된다.
    expect(fs.existsSync(wtPath)).toBe(false);
    // git 워크트리 등록도 해제된다.
    const worktrees = execFileSync('git', ['worktree', 'list'], { cwd: proj, encoding: 'utf8' });
    expect(worktrees).not.toContain('WI-DONE');
    // 브랜치는 남긴다(미푸시 커밋 유실 방지, F-5).
    const branches = execFileSync('git', ['branch', '--list'], { cwd: proj, encoding: 'utf8' });
    expect(branches).toContain('work/WI-DONE');
    // state: 현재를 비우고 레지스트리에 done 으로 기록.
    const state = JSON.parse(fs.readFileSync(path.join(proj, '.awl', 'state.json'), 'utf8'));
    expect(state.workitem).toBeNull();
    expect(state.workitems['WI-DONE'].status).toBe('done');
  });

  it('runWorkDone — tracked 미커밋 변경이 있으면 거부하고 워크트리를 보존한다 (F-5 파괴 방지)', async () => {
    const proj = realGitProject();
    await runWorkNew('WI-DIRTY', undefined, { worktree: true });
    const wtPath = path.join(proj, '.awl-worktrees', 'WI-DIRTY');
    // 워크트리 안에서 tracked 파일을 고쳐 미커밋 상태로 둔다.
    fs.writeFileSync(path.join(wtPath, 'f.txt'), '고침\n');

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('exit');
    }) as unknown as typeof process.exit);
    await expect(runWorkDone('WI-DIRTY', {})).rejects.toThrow('exit');
    exitSpy.mockRestore();
    stderrSpy.mockRestore();

    // 거부됐으니 워크트리는 그대로 남는다(파괴 방지).
    expect(fs.existsSync(wtPath)).toBe(true);
    // state 도 done 으로 바뀌지 않는다(원자성 — 워크트리 못 지우면 저장 안 함).
    const state = JSON.parse(fs.readFileSync(path.join(proj, '.awl', 'state.json'), 'utf8'));
    expect(state.workitem).toBe('WI-DIRTY');
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

  // engine 스킬 원본을 이 테스트의 AWL_HOME 아래에 시드한다(realGitProject 의 fresh home 엔 없다).
  function seedEngineSkill(name: string): void {
    const dir = path.join(process.env.AWL_HOME as string, 'engine', 'skills', 'claude', name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), `# ${name}\n`);
  }

  it('--worktree 가 워크트리 생성 직후 engine Claude 스킬을 워크트리 루트에 재설치한다 (pipeline-lane-skill-reinstall AC-01)', async () => {
    const proj = realGitProject();
    seedEngineSkill('awl-loop');
    seedEngineSkill('awl-pipeline-plan');

    await runWorkNew('WI-SKILL', undefined, { worktree: true });

    // .claude 는 gitignore 라 worktree 체크아웃에 안 따라온다 — 재설치가 채워야 존재한다.
    const wtRoot = path.join(proj, '.awl-worktrees', 'WI-SKILL');
    expect(fs.existsSync(path.join(wtRoot, '.claude', 'skills', 'awl-loop', 'SKILL.md'))).toBe(
      true,
    );
    // multi-installer 일반화 덕에 awl-pipeline-* 도 함께 깔린다(전 스킬 순회).
    expect(
      fs.existsSync(path.join(wtRoot, '.claude', 'skills', 'awl-pipeline-plan', 'SKILL.md')),
    ).toBe(true);
  });

  it('engine 스킬 원본이 없어도 재설치 실패가 워크트리·workitem 생성을 중단하지 않는다 — best-effort 경고만 (AC-02)', async () => {
    const proj = realGitProject(); // fresh AWL_HOME: engine 스킬 없음(원본 부재 재현).
    const warns: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((s: unknown) => {
      warns.push(String(s));
      return true;
    });
    try {
      await runWorkNew('WI-NOSKILL', undefined, { worktree: true });
    } finally {
      spy.mockRestore();
    }
    // 워크트리는 생성 완료(롤백/중단 없음).
    expect(fs.existsSync(path.join(proj, '.awl-worktrees', 'WI-NOSKILL'))).toBe(true);
    // workitem 도 state 에 기록됨(중단되지 않았다).
    const state = JSON.parse(fs.readFileSync(path.join(proj, '.awl', 'state.json'), 'utf8'));
    expect(state.workitem).toBe('WI-NOSKILL');
    // best-effort 경고 1줄만 — 스킬 재설치가 안 됐음을 알린다.
    expect(warns.join('')).toMatch(/스킬/);
  });

  it('--worktree 없는 work new 는 스킬 재설치를 하지 않는다 (AC-03 회귀 — engine 시드돼 있어도)', async () => {
    const proj = realGitProject();
    seedEngineSkill('awl-loop'); // 시드돼 있어도 비-worktree 경로는 재설치 경로를 타지 않아야 한다.

    await runWorkNew('WI-NOWT', undefined, {});

    // 비-worktree 실행은 cwd 프로젝트에 .claude/skills 를 새로 깔지 않는다.
    expect(fs.existsSync(path.join(proj, '.claude', 'skills', 'awl-loop'))).toBe(false);
  });

  it('installClaudeSkill 이 throw 해도 catch 가 워크트리·workitem 을 유지하고 경고만 낸다 (AC-04, 리뷰 지적 rev finding#1)', async () => {
    const proj = realGitProject();
    // false-return 이 아니라 진짜 예외(cpSync EACCES 등)를 강제해 catch 분기를 락한다.
    const skillSpy = vi.spyOn(initModule, 'installClaudeSkill').mockImplementation(() => {
      throw new Error('boom');
    });
    const warns: string[] = [];
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation((s: unknown) => {
      warns.push(String(s));
      return true;
    });
    try {
      // 예외를 삼키지 못하면 runWorkNew 가 reject 된다 — 이 await 자체가 catch 를 검증한다.
      await runWorkNew('WI-THROW', undefined, { worktree: true });
    } finally {
      errSpy.mockRestore();
      skillSpy.mockRestore();
    }
    // 워크트리·workitem 은 유지된다(예외가 롤백/중단시키지 않는다).
    expect(fs.existsSync(path.join(proj, '.awl-worktrees', 'WI-THROW'))).toBe(true);
    const state = JSON.parse(fs.readFileSync(path.join(proj, '.awl', 'state.json'), 'utf8'));
    expect(state.workitem).toBe('WI-THROW');
    // "재설치 실패" 경고는 catch 분기에서만 나온다 — installClaudeSkill 이 throw 했고
    // 그 예외를 삼켰다는 증거다. try/catch 를 제거하면 runWorkNew 가 reject 돼 위 await 가 던진다.
    expect(warns.join('')).toMatch(/스킬 재설치 실패/);
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

describe('runWorkNew — 검증 베이스라인 캡처 (WI-G AC-01)', () => {
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

  function realGitProjectWithConfig(verify: Record<string, unknown>): string {
    const proj = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'awl-baseline-proj-')));
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: proj });
    execFileSync('git', ['config', 'user.email', 't@t.com'], { cwd: proj });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: proj });
    fs.mkdirSync(path.join(proj, '.awl'), { recursive: true });
    fs.writeFileSync(
      path.join(proj, '.awl', 'config.json'),
      JSON.stringify({
        project: 'p',
        mainLanguage: 'typescript',
        character: '',
        engineVersion: '0.0.0',
        verify,
      }),
    );
    execFileSync('git', ['add', '-A'], { cwd: proj });
    execFileSync('git', ['commit', '-q', '-m', 'base'], { cwd: proj });
    process.chdir(proj);
    process.env.AWL_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'awl-home-'));
    return proj;
  }

  it('config.verify 로 실제 검증을 돌려 .awl/verify-baseline.json 에 체크별 pass/fail 을 저장한다', async () => {
    const proj = realGitProjectWithConfig({
      typecheck: { cmd: `${process.execPath} --version` },
      lint: null,
      test: { cmd: `${process.execPath} -e "process.exit(1)"` },
      e2e: null,
    });

    await runWorkNew('WI-BASE', undefined, {});

    const baselinePath = path.join(proj, '.awl', 'verify-baseline.json');
    expect(fs.existsSync(baselinePath)).toBe(true);
    const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
    expect(baseline.results).toEqual([
      { name: 'typecheck', passed: true },
      { name: 'test', passed: false },
    ]);
  });

  it('--worktree 사용 시 config 가 새 워크트리에서 실제로 로드되고 그 워크트리 루트에 베이스라인이 저장된다 (AC-08, 리뷰 지적 — 성공 경로 커버리지 0 이었음)', async () => {
    const proj = realGitProjectWithConfig({
      typecheck: { cmd: `${process.execPath} --version` },
      lint: null,
      test: { cmd: `${process.execPath} -e "process.exit(1)"` },
      e2e: null,
    });

    await runWorkNew('WI-WT-BASE', undefined, { worktree: true });

    const wtPath = path.join(proj, '.awl-worktrees', 'WI-WT-BASE');
    expect(fs.existsSync(wtPath)).toBe(true);
    // config.json 이 git-tracked 라 워크트리 체크아웃에 실제로 따라온다.
    expect(fs.existsSync(path.join(wtPath, '.awl', 'config.json'))).toBe(true);

    // 베이스라인은 원래 루트가 아니라 새 워크트리 루트에 저장돼야 한다(원래 루트에
    // 저장하면 gitignore 대상이라 이 워크트리에 안 따라온다).
    const wtBaselinePath = path.join(wtPath, '.awl', 'verify-baseline.json');
    expect(fs.existsSync(wtBaselinePath)).toBe(true);
    expect(fs.existsSync(path.join(proj, '.awl', 'verify-baseline.json'))).toBe(false);

    const baseline = JSON.parse(fs.readFileSync(wtBaselinePath, 'utf8'));
    expect(baseline.workitem).toBe('WI-WT-BASE');
    expect(baseline.results).toEqual([
      { name: 'typecheck', passed: true },
      { name: 'test', passed: false },
    ]);
  });

  it('--skip-baseline 이면 verify-baseline.json 을 안 만들고 나중에 못 쓴다고 알린다', async () => {
    const proj = realGitProjectWithConfig({
      typecheck: { cmd: `${process.execPath} --version` },
      lint: null,
      test: null,
      e2e: null,
    });
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await runWorkNew('WI-SKIP', undefined, { skipBaseline: true });

    const written = stdoutSpy.mock.calls.map((c) => String(c[0])).join('');
    stdoutSpy.mockRestore();

    expect(fs.existsSync(path.join(proj, '.awl', 'verify-baseline.json'))).toBe(false);
    expect(written).toContain('--since-baseline 을 못 씁니다');
  });

  it('writeVerifyBaseline 이 실패해도(디스크/권한 등) 워크아이템 생성 자체는 크래시하지 않는다 (AC-03, WI-H 스파이크 지적)', async () => {
    realGitProjectWithConfig({
      typecheck: { cmd: `${process.execPath} --version` },
      lint: null,
      test: null,
      e2e: null,
    });
    const writeSpy = vi.spyOn(verifyModule, 'writeVerifyBaseline').mockImplementation(() => {
      throw new Error('ENOSPC: no space left on device');
    });
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    await expect(runWorkNew('WI-DISKFULL', undefined, {})).resolves.not.toThrow();

    const state = JSON.parse(
      fs.readFileSync(path.join(process.cwd(), '.awl', 'state.json'), 'utf8'),
    );
    expect(state.workitem).toBe('WI-DISKFULL'); // 워크아이템 생성은 성공.
    const warned = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(warned).toContain('베이스라인');

    writeSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  it('config 가 없으면(레거시/미설정 프로젝트) 크래시 없이 베이스라인을 건너뛴다', async () => {
    const proj = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'awl-baseline-noconf-')));
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: proj });
    execFileSync('git', ['config', 'user.email', 't@t.com'], { cwd: proj });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: proj });
    fs.mkdirSync(path.join(proj, '.awl'), { recursive: true });
    execFileSync('git', ['add', '-A'], { cwd: proj });
    execFileSync('git', ['commit', '-q', '-m', 'base', '--allow-empty'], { cwd: proj });
    process.chdir(proj);
    process.env.AWL_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'awl-home-'));

    await expect(runWorkNew('WI-NOCONF', undefined, {})).resolves.not.toThrow();
    expect(fs.existsSync(path.join(proj, '.awl', 'verify-baseline.json'))).toBe(false);
  });

  it('work switch 로 다른 워크아이템을 거쳐도, 원래 워크아이템으로 돌아오면 케이스까지 그대로 복원돼 베이스라인이 다시 유효해진다 (AC-10, 2차 리뷰 지적 — switch 왕복 회귀 방지)', async () => {
    const verify = {
      typecheck: { cmd: `${process.execPath} --version` },
      lint: null,
      test: null,
      e2e: null,
    };
    realGitProjectWithConfig(verify);

    await runWorkNew('WI-Orig', undefined, {}); // 베이스라인: workitem:'WI-Orig'.
    await runWorkNew('WI-Other', undefined, {}); // 같은 파일을 workitem:'WI-Other' 로 덮어씀(현재 알려진 한계).

    const root = process.cwd();
    const afterOther = readVerifyBaseline(root);
    expect(afterOther?.workitem).toBe('WI-Other');

    await runWorkSwitch('WI-Orig'); // 원래 워크아이템으로 복귀 — 대소문자까지 원래 표기 그대로.
    const state = JSON.parse(fs.readFileSync(path.join(root, '.awl', 'state.json'), 'utf8'));
    expect(state.workitem).toBe('WI-Orig'); // restoreWorkitem 이 원래 케이스를 복원.

    // 베이스라인 파일은 여전히 WI-Other 것이라(work switch 가 재캡처하지 않음),
    // resolveSinceBaseline 은 이걸 안전하게 감지해 폴백해야 한다 — 무음 오판 없음.
    const stillOthers = readVerifyBaseline(root);
    expect(stillOthers?.workitem).toBe('WI-Other');
    expect(stillOthers?.workitem).not.toBe(state.workitem);
  });
});

describe('renderWorkList — 상태 색코딩 + 값 강조 + 정렬 (cli-visual-consistency AC-08, 리뷰)', () => {
  const CC = { unicode: true, color: true, tty: true };
  const ws = (id: string, status: string, passed = 1, total = 2, current = false) => ({
    id,
    status,
    passed,
    total,
    current,
  });

  it('상태값을 색코딩한다 — done/active=green, paused=yellow, abandoned=muted(dim)', () => {
    const out = renderWorkList(
      [
        ws('WI-A', 'done'),
        ws('WI-B', 'paused'),
        ws('WI-C', 'abandoned'),
        ws('WI-D', 'active', 0, 0, true),
      ],
      CC,
    );
    expect(out).toContain('\x1b[32mdone'); // green
    expect(out).toContain('\x1b[33mpaused'); // yellow
    expect(out).toContain('\x1b[2mabandoned'); // muted(dim)
    expect(out).toContain('\x1b[32mactive'); // green
  });

  it('passed/total 을 emphasis(bold)로 강조한다', () => {
    const out = renderWorkList([ws('WI-A', 'active', 3, 5)], CC);
    expect(out).toContain('\x1b[1m3/5\x1b[0m'); // bold
  });

  it('색코딩·강조를 넣어도 passed/total 정렬 기준이 균일하다(statusPad가 plain 기준)', () => {
    // sectionBox(열린 ㄷ자)로 바뀌며 줄 끝 패딩이 없어져 전체 표시폭 비교는 더는 못 쓴다
    // (remove/update/verify/version-check/work/program card→sectionBox 전환). 대신
    // emphasis(passed/total) 시작 직전까지의 표시폭이 행마다 같은지로 정렬을 확인한다 —
    // id/status 길이가 달라도 statusPad 가 ANSI 코드를 안 세고 plain 폭 기준으로 맞춘다는
    // 원래 의도(리뷰 지적)는 그대로 검증된다.
    const out = renderWorkList([ws('WI-longname', 'done', 2, 2), ws('WI-x', 'paused', 0, 1)], CC);
    const rows = out.split('\n').filter((l) => l.includes('통과'));
    const prefixWidths = rows.map((l) => visibleWidth(l.slice(0, l.indexOf('\x1b[1m'))));
    expect(new Set(prefixWidths).size).toBe(1); // 색이 padEnd 폭을 안 깬다
  });
});

describe('runWorkList — cwd 밖(config-anywhere-fallback)', () => {
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

  /** .awl/config.json + state.json 을 갖춘 프로젝트를 만들고 ~/.awl/projects.json 에 등록한다. */
  function registeredProject(home: string, name: string, workitem: string): string {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `awl-worklist-${name}-`)));
    fs.mkdirSync(path.join(root, '.awl'), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.awl', 'config.json'),
      JSON.stringify({ project: name, engineVersion: '0.0.0', verify: {} }),
    );
    fs.writeFileSync(
      path.join(root, '.awl', 'state.json'),
      JSON.stringify({ workitem, criteria: [{ id: 'AC-01', status: 'passed' }] }),
    );
    const file = path.join(home, 'projects.json');
    const existing = fs.existsSync(file)
      ? (JSON.parse(fs.readFileSync(file, 'utf8')) as unknown[])
      : [];
    fs.writeFileSync(
      file,
      JSON.stringify([...existing, { name, path: root, registeredAt: '2026-01-01T00:00:00.000Z' }]),
    );
    return root;
  }

  it('cwd 밖이면 등록된 프로젝트마다 workitem 목록을 프로젝트별로 --json 에 담는다', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'awl-worklist-home-'));
    process.env.AWL_HOME = home;
    registeredProject(home, 'work-a', 'WI-A');
    registeredProject(home, 'work-b', 'WI-B');
    process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'awl-worklist-lonely-')));

    let buf = '';
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => {
      buf += String(c);
      return true;
    });
    try {
      runWorkList({ json: true });
    } finally {
      spy.mockRestore();
    }
    const j = JSON.parse(buf) as {
      multiProject: boolean;
      projects: { name: string; list: { id: string }[] }[];
    };
    expect(j.multiProject).toBe(true);
    const byName = Object.fromEntries(j.projects.map((p) => [p.name, p.list.map((w) => w.id)]));
    expect(byName['work-a']).toEqual(['WI-A']);
    expect(byName['work-b']).toEqual(['WI-B']);
  });
});
