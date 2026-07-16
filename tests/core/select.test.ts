import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  advanceSelect,
  initSelectState,
  renderSelectOptions,
  runInteractiveSelect,
} from '../../src/core/select.js';

const ASCII = { unicode: false, color: false, tty: false };

describe('advanceSelect — 순수 상태 전이 (WI-Y AC-02)', () => {
  it('아래로 이동한다', () => {
    const s = initSelectState(0);
    const next = advanceSelect(s, 'down', 3, false);
    expect(next.index).toBe(1);
  });

  it('위로 이동한다', () => {
    const s = initSelectState(1);
    const next = advanceSelect(s, 'up', 3, false);
    expect(next.index).toBe(0);
  });

  it('맨 아래에서 아래로 가면 맨 위로 순환한다', () => {
    const s = initSelectState(2);
    const next = advanceSelect(s, 'down', 3, false);
    expect(next.index).toBe(0);
  });

  it('맨 위에서 위로 가면 맨 아래로 순환한다', () => {
    const s = initSelectState(0);
    const next = advanceSelect(s, 'up', 3, false);
    expect(next.index).toBe(2);
  });

  it('Home/End 는 각각 처음/마지막 항목으로 이동한다', () => {
    expect(advanceSelect(initSelectState(1), 'home', 3, false).index).toBe(0);
    expect(advanceSelect(initSelectState(1), 'end', 3, false).index).toBe(2);
  });

  it('옵션이 1개면 위/아래를 눌러도 그대로다', () => {
    const s = initSelectState(0);
    expect(advanceSelect(s, 'down', 1, false).index).toBe(0);
    expect(advanceSelect(s, 'up', 1, false).index).toBe(0);
  });

  it('다중선택에서 space 는 현재 위치를 토글한다', () => {
    const s = initSelectState(1);
    const checked = advanceSelect(s, 'space', 3, true);
    expect(checked.checked.has(1)).toBe(true);
    const unchecked = advanceSelect(checked, 'space', 3, true);
    expect(unchecked.checked.has(1)).toBe(false);
  });

  it('단일선택에서 space 는 아무 변화도 없다', () => {
    const s = initSelectState(0);
    const next = advanceSelect(s, 'space', 3, false);
    expect(next).toEqual(s);
  });

  it('enter 는 done 을 true 로 만들고 선택/체크는 그대로 둔다', () => {
    const s = advanceSelect(initSelectState(1), 'down', 3, false);
    const next = advanceSelect(s, 'enter', 3, false);
    expect(next.done).toBe(true);
    expect(next.cancelled).toBe(false);
    expect(next.index).toBe(s.index);
  });

  it('escape 는 done 과 cancelled 를 둘 다 true 로 만든다', () => {
    const next = advanceSelect(initSelectState(0), 'escape', 3, false);
    expect(next.done).toBe(true);
    expect(next.cancelled).toBe(true);
  });

  it('done 이후엔 어떤 키를 눌러도 상태가 안 바뀐다', () => {
    const done = advanceSelect(initSelectState(0), 'enter', 3, false);
    const after = advanceSelect(done, 'down', 3, false);
    expect(after).toEqual(done);
  });

  it('알 수 없는 키(other)는 아무 변화도 없다', () => {
    const s = initSelectState(1);
    expect(advanceSelect(s, 'other', 3, false)).toEqual(s);
  });

  it('initSelectState 에 기본 체크값을 넣을 수 있다', () => {
    const s = initSelectState(0, [1, 2]);
    expect(s.checked.has(1)).toBe(true);
    expect(s.checked.has(2)).toBe(true);
    expect(s.checked.has(0)).toBe(false);
  });
});

describe('renderSelectOptions — 순수 렌더 (WI-Y AC-02)', () => {
  it('현재 선택된 항목에 커서(>)를 표시한다', () => {
    const s = initSelectState(1);
    const text = renderSelectOptions(['a', 'b', 'c'], s, false, ASCII);
    const lines = text.split('\n');
    expect(lines[1]).toContain('>');
    expect(lines[0]).not.toContain('>');
    expect(lines[2]).not.toContain('>');
  });

  it('단일선택은 라디오 마커, 다중선택은 체크박스 마커를 쓴다', () => {
    const s = initSelectState(0);
    const radio = renderSelectOptions(['a'], s, false, ASCII);
    const checkbox = renderSelectOptions(['a'], s, true, ASCII);
    expect(radio).toContain('(*)');
    expect(checkbox).not.toContain('(*)');
  });

  it('다중선택은 체크된 항목을 체크마커로 보여준다', () => {
    const s = initSelectState(0, [1]);
    const text = renderSelectOptions(['a', 'b'], s, true, ASCII);
    const lines = text.split('\n');
    expect(lines[1]).toContain('[x]');
    expect(lines[0]).toContain('[ ]');
  });

  it('옵션 텍스트를 그대로 포함한다', () => {
    const text = renderSelectOptions(['TypeScript', 'Python'], initSelectState(0), false, ASCII);
    expect(text).toContain('TypeScript');
    expect(text).toContain('Python');
  });
});

describe('runInteractiveSelect — I/O 루프를 stdin 모킹으로 검증 (WI-Y AC-03)', () => {
  // 이 테스트 환경(vitest)의 process.stdin 은 TTY 가 아니라 setRawMode 자체가
  // 없을 수 있다(실제로 이 저장소 환경에서 undefined 로 확인됨) — vi.spyOn 은
  // 이미 존재하는 메서드에만 걸 수 있으므로, setRawMode 는 직접 대입/복원한다.
  const originalSetRawMode = process.stdin.setRawMode;

  afterEach(() => {
    process.stdin.setRawMode = originalSetRawMode;
    vi.restoreAllMocks();
    // WI-Y AC-07 리뷰 지적 — mockStdin() 이 실제 EventEmitter 에 리스너를 등록만
    // 하고 한 번도 발화 안 시키면 'data' 리스너가 테스트마다 누적된다.
    expect(process.stdin.listenerCount('data')).toBe(0);
  });

  function mockStdin() {
    const setRawMode = vi.fn().mockReturnValue(process.stdin);
    process.stdin.setRawMode = setRawMode as typeof process.stdin.setRawMode;
    vi.spyOn(process.stdin, 'resume').mockReturnValue(process.stdin);
    vi.spyOn(process.stdin, 'pause').mockReturnValue(process.stdin);
    // WI-Y AC-07 리뷰 지적 — mockImplementation 없이 콜스루하면 실제
    // EventEmitter 에 'data' 리스너가 등록되고, emit() 을 안 쓰고 콜백을
    // 직접 호출하는 이 테스트 구조상 once() 의 자동 해제가 안 일어나 리스너가
    // 테스트마다 누적된다. 아예 실제 등록을 막고 호출 인자만 기록한다.
    const onceSpy = vi.spyOn(process.stdin, 'once').mockImplementation(() => process.stdin);
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    return { setRawMode, onceSpy };
  }

  // vi.spyOn(process.stdin, 'once') 의 반환 타입은 process.stdin 의 once 오버로드
  // 전체와 얽혀 있어 그대로 쓰면 타입이 지나치게 복잡해진다 — 여기서 실제로
  // 쓰는 건 mock.calls 뿐이므로 그 구조만 받는 최소 타입으로 좁힌다.
  interface OnceSpy {
    mock: { calls: unknown[][] };
  }

  function lastDataListener(onceSpy: OnceSpy): (buf: Buffer) => void {
    const calls = onceSpy.mock.calls.filter((c) => c[0] === 'data');
    const last = calls[calls.length - 1];
    if (!last) {
      throw new Error('data 리스너가 등록되지 않았습니다');
    }
    return last[1] as (buf: Buffer) => void;
  }

  async function pressKey(onceSpy: OnceSpy, bytes: string): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
    lastDataListener(onceSpy)(Buffer.from(bytes));
  }

  it('아래-아래-enter 로 2번 인덱스를 선택한다', async () => {
    const { onceSpy } = mockStdin();
    const promise = runInteractiveSelect(['a', 'b', 'c'], 0, false, ASCII);
    await pressKey(onceSpy, '\x1b[B');
    await pressKey(onceSpy, '\x1b[B');
    await pressKey(onceSpy, '\r');
    const result = await promise;
    expect(result?.index).toBe(2);
  });

  it('escape 를 누르면 null 을 돌려준다(취소)', async () => {
    const { onceSpy } = mockStdin();
    const promise = runInteractiveSelect(['a', 'b'], 0, false, ASCII);
    await pressKey(onceSpy, '\x1b');
    const result = await promise;
    expect(result).toBeNull();
  });

  it('Ctrl+C 도 취소로 다룬다', async () => {
    const { onceSpy } = mockStdin();
    const promise = runInteractiveSelect(['a', 'b'], 0, false, ASCII);
    await pressKey(onceSpy, '\x03');
    const result = await promise;
    expect(result).toBeNull();
  });

  it('다중선택은 space 로 토글한 뒤 enter 로 확정한다', async () => {
    const { onceSpy } = mockStdin();
    const promise = runInteractiveSelect(['a', 'b'], 0, true, ASCII);
    await pressKey(onceSpy, ' '); // index 0 토글
    await pressKey(onceSpy, '\x1b[B'); // index 1 로 이동
    await pressKey(onceSpy, ' '); // index 1 토글
    await pressKey(onceSpy, '\r');
    const result = await promise;
    expect(result?.checked.sort()).toEqual([0, 1]);
  });

  it('끝나면(성공이든 취소든) raw-mode 를 반드시 되돌린다', async () => {
    const { onceSpy, setRawMode } = mockStdin();
    const promise = runInteractiveSelect(['a'], 0, false, ASCII);
    await pressKey(onceSpy, '\r');
    await promise;
    expect(setRawMode).toHaveBeenCalledWith(true);
    expect(setRawMode).toHaveBeenCalledWith(false);
    // 마지막 호출이 false(원복)여야 한다.
    expect(setRawMode.mock.calls[setRawMode.mock.calls.length - 1]?.[0]).toBe(false);
  });
});
