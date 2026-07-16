import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  acquireStateLock,
  getCriterion,
  loadState,
  mergeState,
  migrateState,
  readStateLock,
  releaseStateLock,
  runStateSet,
  sessionToken,
  setCriterion,
  stateLockFile,
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

  it('쓰기 후 state.lock 을 남기지 않는다 (concurrency-3 AC-02)', () => {
    const root = project();
    runStateSet('{"phase":"awaiting-gate1"}');
    expect(fs.existsSync(stateLockFile(root))).toBe(false);
  });

  it('다른 세션이 락을 잡고 있으면(fresh) 거부하고 상태를 안 바꾼다 (concurrency-3 AC-02)', () => {
    const root = project();
    acquireStateLock(root, 'other'); // 다른 세션이 잡음
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    expect(() => runStateSet('{"phase":"awaiting-gate1"}')).toThrow('exit:1');
    expect(stderrSpy.mock.calls.some((c) => String(c[0]).includes('다른 세션'))).toBe(true);
    expect(loadState(root).phase).toBeUndefined(); // 안 바뀜

    exitSpy.mockRestore();
    stderrSpy.mockRestore();
    releaseStateLock(root);
  });

  it('게이트 거부(process.exit)로 끝나도 락을 남기지 않는다 — 누수 방지 (concurrency-3 AC-02)', () => {
    const root = project();
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    expect(() => runStateSet('{"phase":"loop"}', { requireGateForLoop: () => false })).toThrow(
      'exit:1',
    );
    // 게이트 실패로 exit 했어도 락이 남지 않아야 다음 실행이 안 막힌다.
    expect(fs.existsSync(stateLockFile(root))).toBe(false);

    exitSpy.mockRestore();
    stderrSpy.mockRestore();
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

describe('writeState — 원자적 쓰기 (concurrency-3 AC-01)', () => {
  // 원자성(temp+rename) 자체는 크래시를 시뮬레이션해야 검증되고 fs 는 esbuild interop 상
  // spy 로 가로챌 수 없어(코드베이스에 fs spy 패턴 부재), 여기서는 관찰 가능한 계약을
  // 가드한다: 산출물이 유효 JSON 이고 중간 temp 가 잔존하지 않는다. rename 의 원자성은
  // POSIX 보장 + 코드 리뷰로 확인한다.
  it('유효 JSON 을 남기고 중간 temp 를 잔존시키지 않는다(덮어쓰기 포함)', () => {
    const root = tmp();
    writeState(root, { phase: 'awaiting-gate1' });
    writeState(root, { phase: 'loop', x: 1 }); // 덮어쓰기도 온전해야 한다.
    expect(loadState(root)).toMatchObject({ phase: 'loop', x: 1 });
    const files = fs.readdirSync(path.join(root, '.awl'));
    expect(files.filter((f) => f.includes('.tmp'))).toEqual([]);
    expect(files).toContain('state.json');
  });
});

describe('acquireStateLock / releaseStateLock — 프로젝트 락 헬퍼 (concurrency-3 AC-02)', () => {
  it('락이 없으면 획득하고, fresh 하게 잡혀 있으면 실패한다', () => {
    const root = tmp();
    fs.mkdirSync(path.join(root, '.awl'), { recursive: true });
    expect(acquireStateLock(root, 'tok-a')).toBe(true);
    expect(acquireStateLock(root, 'tok-b')).toBe(false); // tok-a 가 잡고 있음
    releaseStateLock(root);
    expect(acquireStateLock(root, 'tok-c')).toBe(true); // 해제 후 재획득
    releaseStateLock(root);
  });

  it('stale(오래된) 락은 뺏는다', () => {
    const root = tmp();
    fs.mkdirSync(path.join(root, '.awl'), { recursive: true });
    fs.writeFileSync(
      stateLockFile(root),
      JSON.stringify({ token: 'old', at: '2000-01-01T00:00:00.000Z' }),
    );
    expect(acquireStateLock(root, 'new')).toBe(true); // stale → steal
    releaseStateLock(root);
  });

  it('sessionToken 은 proc- 접두어를 가진다', () => {
    expect(sessionToken()).toMatch(/^proc-\d+$/);
  });

  it('readStateLock 은 live 락의 토큰을 돌려주고 stale/부재면 null (concurrency-3 AC-03)', () => {
    const root = tmp();
    fs.mkdirSync(path.join(root, '.awl'), { recursive: true });
    expect(readStateLock(root)).toBeNull(); // 락 없음
    acquireStateLock(root, 'proc-123');
    expect(readStateLock(root)).toMatchObject({ token: 'proc-123' }); // live
    releaseStateLock(root);
    expect(readStateLock(root)).toBeNull(); // 해제 후
    // stale 락은 없는 것과 같이 null.
    fs.writeFileSync(
      stateLockFile(root),
      JSON.stringify({ token: 'old', at: '2000-01-01T00:00:00.000Z' }),
    );
    expect(readStateLock(root)).toBeNull();
    releaseStateLock(root);
  });

  it('releaseStateLock 은 내 토큰의 락만 해제한다 — 남의 stolen 락은 안 지운다 (concurrency-3 AC-04)', () => {
    const root = tmp();
    fs.mkdirSync(path.join(root, '.awl'), { recursive: true });
    acquireStateLock(root, 'holder');
    releaseStateLock(root, 'other'); // 남의 토큰으로는 안 지운다(소유권 검증)
    expect(readStateLock(root)).toMatchObject({ token: 'holder' }); // 여전히 잡혀 있음
    releaseStateLock(root, 'holder'); // 내 토큰이면 지운다
    expect(readStateLock(root)).toBeNull();
  });
});
