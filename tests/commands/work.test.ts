import { describe, expect, it } from 'vitest';
import { createWorkitem, summarizeWorkitems } from '../../src/commands/work.js';

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
