import { type Caps, makeColors, makeSymbols } from './tty.js';

/**
 * 방향키 선택의 순수 상태 전이 + 렌더 (WI-Y).
 *
 * 실제 키 입력(raw-mode, stdin 이벤트)은 별도 I/O 계층(runInteractiveSelect)의
 * 몫이다. 여기는 "이 키를 받으면 다음 상태가 뭔가"만 계산한다 — 실제 터미널
 * 없이도 테스트할 수 있다. 단일선택/다중선택을 같은 상태 타입으로 다룬다.
 */

export type SelectKey = 'up' | 'down' | 'enter' | 'space' | 'escape' | 'other';

export interface SelectState {
  index: number;
  checked: Set<number>;
  done: boolean;
  cancelled: boolean;
}

export function initSelectState(defaultIndex: number, defaultChecked: number[] = []): SelectState {
  return { index: defaultIndex, checked: new Set(defaultChecked), done: false, cancelled: false };
}

/** 키 하나를 받아 다음 상태를 계산한다. done 이후엔 어떤 키도 상태를 안 바꾼다. */
export function advanceSelect(
  state: SelectState,
  key: SelectKey,
  count: number,
  multi: boolean,
): SelectState {
  if (state.done) {
    return state;
  }
  switch (key) {
    case 'up':
      return { ...state, index: (state.index - 1 + count) % count };
    case 'down':
      return { ...state, index: (state.index + 1) % count };
    case 'space': {
      if (!multi) {
        return state;
      }
      const next = new Set(state.checked);
      if (next.has(state.index)) {
        next.delete(state.index);
      } else {
        next.add(state.index);
      }
      return { ...state, checked: next };
    }
    case 'enter':
      return { ...state, done: true };
    case 'escape':
      return { ...state, done: true, cancelled: true };
    default:
      return state;
  }
}

/** 현재 상태를 화면 텍스트로 렌더한다. 현재 선택 항목에 커서(>)를 표시한다. */
export function renderSelectOptions(
  options: string[],
  state: SelectState,
  multi: boolean,
  c: Caps,
): string {
  const sym = makeSymbols(c);
  const color = makeColors(c.color);
  const lines: string[] = [];
  for (let i = 0; i < options.length; i++) {
    const marker = multi
      ? state.checked.has(i)
        ? sym.checkOn
        : sym.checkOff
      : i === state.index
        ? sym.radioOn
        : sym.radioOff;
    const cursor = i === state.index ? '> ' : '  ';
    const line = `${cursor}${marker} ${options[i]}`;
    lines.push(i === state.index ? color.cyan(line) : line);
  }
  return lines.join('\n');
}
