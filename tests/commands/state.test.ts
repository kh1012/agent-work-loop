import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadState, mergeState, writeState } from '../../src/commands/state.js';

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

  it('배열/객체는 통째로 대체한다', () => {
    const merged = mergeState(
      { criteria: [{ id: 'AC-01', status: 'passed' }] },
      { criteria: [{ id: 'AC-02', status: 'blocked' }] },
    );
    expect(merged.criteria).toEqual([{ id: 'AC-02', status: 'blocked' }]);
  });
});

describe('loadState / writeState 왕복', () => {
  it('쓰고 읽으면 같다. 없으면 빈 객체', () => {
    const root = tmp();
    expect(loadState(root)).toEqual({});
    writeState(root, { phase: 'loop', workitem: 'WI-5' });
    expect(loadState(root)).toEqual({ phase: 'loop', workitem: 'WI-5' });
    // 이어서 부분 갱신 병합
    const merged = mergeState(loadState(root), { currentFocus: 'AC-01' });
    writeState(root, merged);
    expect(loadState(root)).toEqual({ phase: 'loop', workitem: 'WI-5', currentFocus: 'AC-01' });
  });
});
