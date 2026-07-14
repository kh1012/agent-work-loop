import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadState, mergeState, migrateState, writeState } from '../../src/commands/state.js';

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'awl-state-'));
}

describe('mergeState — 부분 갱신 병합', () => {
  it('top-level 키를 병합/교체한다', () => {
    const merged = mergeState(
      { phase: 'audit', workitem: 'WI-3' },
      { phase: 'loop', currentFocus: 'AC-03' },
    );
    expect(merged).toEqual({ phase: 'loop', workitem: 'WI-3', currentFocus: 'AC-03' });
  });

  it('criteria 이외의 배열/객체는 통째로 대체한다', () => {
    const merged = mergeState({ tags: ['a', 'b'] }, { tags: ['c'] });
    expect(merged.tags).toEqual(['c']);
  });

  it('criteria 는 id 기준으로 병합하고 기존 필드(baseline)를 보존한다 (WI-7 버그 수정)', () => {
    const merged = mergeState(
      {
        criteria: [
          { id: 'AC-01', status: 'in_progress', baseline: 'abc1234', snapshot: 'snap1' },
          { id: 'AC-02', status: 'pending' },
        ],
      },
      {
        criteria: [
          { id: 'AC-01', status: 'passed' },
          { id: 'AC-03', status: 'pending' },
        ],
      },
    );
    const c = merged.criteria as Record<string, unknown>[];
    // AC-01: status 갱신, baseline/snapshot 보존
    expect(c.find((x) => x.id === 'AC-01')).toEqual({
      id: 'AC-01',
      status: 'passed',
      baseline: 'abc1234',
      snapshot: 'snap1',
    });
    // AC-02: 손대지 않았으므로 그대로
    expect(c.find((x) => x.id === 'AC-02')).toEqual({ id: 'AC-02', status: 'pending' });
    // AC-03: 새로 추가
    expect(c.find((x) => x.id === 'AC-03')).toEqual({ id: 'AC-03', status: 'pending' });
  });
});

describe('loadState / writeState 왕복', () => {
  it('쓰고 읽으면 같다(단, loadState 는 항상 workitems 레지스트리를 붙인다 — WI-D). 없으면 빈 객체', () => {
    const root = tmp();
    expect(loadState(root)).toEqual({});
    writeState(root, { phase: 'loop', workitem: 'WI-5' });
    expect(loadState(root)).toEqual({ phase: 'loop', workitem: 'WI-5', workitems: {} });
    // 이어서 부분 갱신 병합
    const merged = mergeState(loadState(root), { currentFocus: 'AC-01' });
    writeState(root, merged);
    expect(loadState(root)).toEqual({
      phase: 'loop',
      workitem: 'WI-5',
      currentFocus: 'AC-01',
      workitems: {},
    });
  });
});

describe('migrateState — 워크아이템 레지스트리 편입 (WI-D, 순수 함수)', () => {
  it('workitems 필드가 없으면 빈 객체로 추가한다', () => {
    expect(migrateState({ phase: 'loop', workitem: 'WI-5' })).toEqual({
      phase: 'loop',
      workitem: 'WI-5',
      workitems: {},
    });
  });

  it('이미 workitems 필드가 있으면 그대로 둔다 (멱등)', () => {
    const state = {
      workitem: 'WI-5',
      workitems: { 'WI-3': { status: 'done', createdAt: 't1', criteria: [{ id: 'AC-01' }] } },
    };
    expect(migrateState(state)).toEqual(state);
  });

  it('workitem/criteria 필드가 아예 없는 갓 init 된 state 도 크래시 없이 처리한다', () => {
    expect(migrateState({ generation: 1, createdAt: 't0', loop: null })).toEqual({
      generation: 1,
      createdAt: 't0',
      loop: null,
      workitems: {},
    });
  });

  it('두 번 적용해도 결과가 같다 (멱등성 직접 확인)', () => {
    const once = migrateState({ phase: 'loop', workitem: 'WI-5' });
    const twice = migrateState(once);
    expect(twice).toEqual(once);
  });
});
