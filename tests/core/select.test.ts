import { describe, expect, it } from 'vitest';
import { advanceSelect, initSelectState, renderSelectOptions } from '../../src/core/select.js';

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
