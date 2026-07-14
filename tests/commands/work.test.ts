import { describe, expect, it } from 'vitest';
import { summarizeWorkitems } from '../../src/commands/work.js';

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
