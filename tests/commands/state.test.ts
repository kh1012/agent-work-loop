import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getCriterion,
  loadState,
  mergeState,
  migrateState,
  runStateSet,
  setCriterion,
  writeState,
} from '../../src/commands/state.js';

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

describe('runStateSet — phase:loop 전환에 게이트 1 기록 요구 (WI-Q AC-02)', () => {
  const origCwd = process.cwd();

  afterEach(() => {
    process.chdir(origCwd);
  });

  function project(): string {
    const root = fs.realpathSync(tmp());
    fs.mkdirSync(path.join(root, '.awl'), { recursive: true });
    writeState(root, { workitem: 'WI-Q' });
    process.chdir(root);
    return root;
  }

  it('requireGateForLoop 콜백이 false 면 phase:loop 전환을 거부한다', () => {
    const root = project();
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    expect(() => runStateSet('{"phase":"loop"}', { requireGateForLoop: () => false })).toThrow(
      'exit:1',
    );
    expect(stderrSpy.mock.calls.some((c) => String(c[0]).includes('게이트 1'))).toBe(true);
    // 실제로 phase 가 안 바뀌었어야 한다.
    expect(loadState(root).phase).toBeUndefined();

    exitSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  it('requireGateForLoop 콜백이 true 면 정상적으로 phase:loop 로 바뀐다', () => {
    const root = project();
    runStateSet('{"phase":"loop"}', { requireGateForLoop: () => true });
    expect(loadState(root).phase).toBe('loop');
  });

  it('phase 가 loop 가 아니면 requireGateForLoop 을 아예 안 부른다', () => {
    const root = project();
    const cb = vi.fn(() => false);
    runStateSet('{"phase":"awaiting-gate1"}', { requireGateForLoop: cb });
    expect(cb).not.toHaveBeenCalled();
    expect(loadState(root).phase).toBe('awaiting-gate1');
  });

  it('requireGateForLoop 을 안 주면(옵션 생략) 기존처럼 체크 없이 진행한다(호출부 하위호환)', () => {
    const root = project();
    runStateSet('{"phase":"loop"}');
    expect(loadState(root).phase).toBe('loop');
  });

  it('현재 워크아이템을 콜백에 그대로 넘긴다', () => {
    const root = project();
    const cb = vi.fn(() => true);
    runStateSet('{"phase":"loop"}', { requireGateForLoop: cb });
    expect(cb).toHaveBeenCalledWith('WI-Q');
    void root;
  });
});

describe('setCriterion — commit 필드 보존 불변식 (wi8-F3 AC-01)', () => {
  it('--start 모사 패치(baseline 만, commit 없음)를 재적용해도 기존 commit 을 보존한다', () => {
    // 성공 격리 커밋이 commit SHA 를 심었다고 가정.
    let state = setCriterion({}, 'AC-01', {
      status: 'passed',
      baseline: 'sha_final',
      commit: 'sha_final',
    });
    // 이후 --start 를 다시 부르면 baseline 만 HEAD 로 리셋되고 patch 에 commit 은 없다.
    state = setCriterion(state, 'AC-01', {
      status: 'in_progress',
      baseline: 'head_sha',
      snapshot: 'snap',
      untrackedAtStart: [],
    });
    const c = getCriterion(state, 'AC-01');
    expect(c?.commit).toBe('sha_final'); // 얕은 병합이라 commit 은 살아남는다.
    expect(c?.baseline).toBe('head_sha'); // baseline 은 리셋됨(다른 목적).
  });
});
