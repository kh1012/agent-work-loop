import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ConflictingModeFlags,
  laneNamesFor,
  openRequest,
  resolveLoopMode,
} from '../../src/commands/run.js';

describe('resolveLoopMode — 순수 함수', () => {
  it('--strict 는 strict', () => {
    expect(resolveLoopMode({ strict: true })).toBe('strict');
  });

  it('--auto 는 auto', () => {
    expect(resolveLoopMode({ auto: true })).toBe('auto');
  });

  it('아무 플래그도 없으면 undefined — 기본값 semi-auto 는 필드를 안 만들어 표현한다(D-21)', () => {
    expect(resolveLoopMode({})).toBeUndefined();
    expect(resolveLoopMode({ review: true })).toBeUndefined();
  });

  it('--strict 와 --auto 를 함께 주면 거부한다 (상호배타)', () => {
    expect(() => resolveLoopMode({ strict: true, auto: true })).toThrow(ConflictingModeFlags);
  });
});

describe('laneNamesFor — 순수 함수', () => {
  it('목표 개수만큼 lane-N 을 만든다', () => {
    expect(laneNamesFor(['a', 'b', 'c'])).toEqual(['lane-1', 'lane-2', 'lane-3']);
  });

  it('목표 서술에서 이름을 뽑지 않는다 — 이름 짓기는 판단이라 awl 이 하지 않는다', () => {
    expect(laneNamesFor(['키보드 조작', '인증 리프레시'])).toEqual(['lane-1', 'lane-2']);
  });

  it('목표가 없으면 빈 배열', () => {
    expect(laneNamesFor([])).toEqual([]);
  });

  it('이미 있는 레인 번호를 건너뛴다 — 두 번째 실행이 lane-1 충돌로 멈추면 안 된다', () => {
    expect(laneNamesFor(['a', 'b'], ['lane-1', 'lane-2'])).toEqual(['lane-3', 'lane-4']);
  });

  it('중간에 빈 번호가 있으면 그 자리를 채운다', () => {
    expect(laneNamesFor(['a', 'b'], ['lane-1', 'lane-3'])).toEqual(['lane-2', 'lane-4']);
  });

  it('사람이 지은 이름(레인명이 lane-N 이 아닌 것)은 번호 할당에 영향을 주지 않는다', () => {
    expect(laneNamesFor(['a'], ['keyboard', 'auth'])).toEqual(['lane-1']);
  });
});

describe('openRequest — 요청·모드를 state 에 쓴다', () => {
  let root: string;
  const cwd = process.cwd();

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'awl-run-')));
    fs.mkdirSync(path.join(root, '.awl'), { recursive: true });
  });

  afterEach(() => {
    process.chdir(cwd);
    vi.restoreAllMocks();
  });

  function readState(): Record<string, unknown> {
    return JSON.parse(fs.readFileSync(path.join(root, '.awl', 'state.json'), 'utf8'));
  }

  it('목표 원문을 request 에 그대로 쓴다 (awl 은 해석하지 않는다)', () => {
    openRequest(root, '레이어 패널을 키보드로 조작하고 싶다', undefined, false);
    expect(readState().request).toBe('레이어 패널을 키보드로 조작하고 싶다');
  });

  it('모드를 주면 loopMode 로 쓴다', () => {
    openRequest(root, '목표', 'strict', false);
    expect(readState().loopMode).toBe('strict');
  });

  it('모드가 없으면 loopMode 필드를 아예 안 만든다 (D-21)', () => {
    openRequest(root, '목표', undefined, false);
    expect(readState()).not.toHaveProperty('loopMode');
  });

  it('--review 일 때만 review:true 를 남긴다', () => {
    openRequest(root, '목표', undefined, true);
    expect(readState().review).toBe(true);
  });

  it('--review 가 아니면 review 필드를 안 만든다 (D-21)', () => {
    openRequest(root, '목표', undefined, false);
    expect(readState()).not.toHaveProperty('review');
  });

  it('기존 state 의 다른 필드를 지우지 않는다', () => {
    fs.writeFileSync(
      path.join(root, '.awl', 'state.json'),
      JSON.stringify({ workitem: 'WI-1', phase: 'loop' }),
    );
    openRequest(root, '새 목표', 'auto', false);
    const s = readState();
    expect(s.workitem).toBe('WI-1');
    expect(s.phase).toBe('loop');
    expect(s.request).toBe('새 목표');
    expect(s.loopMode).toBe('auto');
  });

  it('다시 열면 요청과 모드가 갱신된다 (같은 레인을 재사용하는 경우)', () => {
    openRequest(root, '첫 목표', 'strict', true);
    openRequest(root, '둘째 목표', 'auto', false);
    const s = readState();
    expect(s.request).toBe('둘째 목표');
    expect(s.loopMode).toBe('auto');
    // review 는 껐다고 지우지 않는다 — 끄려면 명시적으로 state 를 고친다.
    expect(s.review).toBe(true);
  });
});
