import { type Caps, makeColors, makeSymbols, sectionBox } from './tty.js';

/**
 * 방향키 선택의 순수 상태 전이 + 렌더 (WI-Y).
 *
 * 실제 키 입력(raw-mode, stdin 이벤트)은 별도 I/O 계층(runInteractiveSelect)의
 * 몫이다. 여기는 "이 키를 받으면 다음 상태가 뭔가"만 계산한다 — 실제 터미널
 * 없이도 테스트할 수 있다. 단일선택/다중선택을 같은 상태 타입으로 다룬다.
 */

export type SelectKey = 'up' | 'down' | 'enter' | 'space' | 'escape' | 'home' | 'end' | 'other';

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
  selectAllIndex?: number,
): SelectState {
  if (state.done) {
    return state;
  }
  switch (key) {
    case 'up':
      return { ...state, index: (state.index - 1 + count) % count };
    case 'down':
      return { ...state, index: (state.index + 1) % count };
    case 'home':
      return { ...state, index: 0 };
    case 'end':
      return { ...state, index: count - 1 };
    case 'space': {
      if (!multi) {
        return state;
      }
      const next = new Set(state.checked);
      // "모두 선택"은 일반 항목 하나가 아니라 목록 전체를 토글하는 특수 항목이다.
      // 개별 항목을 건드리면 이 표시는 해제해, 현재 체크 상태가 실제 선택을 정확히
      // 나타내도록 한다.
      if (state.index === selectAllIndex) {
        if (next.has(selectAllIndex)) {
          return { ...state, checked: new Set() };
        }
        return { ...state, checked: new Set(Array.from({ length: count }, (_, i) => i)) };
      }
      if (selectAllIndex !== undefined) {
        next.delete(selectAllIndex);
      }
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
    // 유니코드 TTY에서는 Gemini처럼 시선이 바로 걸리는 포인터를 쓴다. 파이프·구식
    // 터미널은 기존 ASCII `>`로 폴백해 복사한 로그도 읽기 쉽다.
    const cursor = i === state.index ? (c.unicode ? '❯ ' : '> ') : '  ';
    const line = `${cursor}${marker} ${options[i]}`;
    lines.push(i === state.index ? color.cyan(line) : line);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// I/O 계층 — raw-mode 로 실시간 키 입력을 받는다 (WI-Y AC-03).
// 여기부터는 실제 터미널이 필요해 단위테스트 범위 밖이다(수동 시연). 호출부는
// rawModeCapable() 이 true 일 때만 이 경로를 타야 한다 — CI/파이프에서 이
// 함수를 부르면 stdin 이 raw-mode 를 지원 안 해 예측 못 할 동작이 날 수 있다.
// ---------------------------------------------------------------------------

/** 키 입력 하나를 기다린다. Esc 와 Ctrl+C 를 둘 다 취소로 다룬다. */
export function readKey(): Promise<SelectKey> {
  return new Promise((resolve) => {
    process.stdin.once('data', (buf: Buffer) => {
      const s = buf.toString('utf8');
      if (s === '\r' || s === '\n') {
        resolve('enter');
      } else if (s === ' ') {
        resolve('space');
      } else if (s === '\x1b[A' || s === 'k') {
        resolve('up');
      } else if (s === '\x1b[B' || s === 'j') {
        resolve('down');
      } else if (s === '\x1b[H' || s === '\x1bOH' || s === 'g') {
        resolve('home');
      } else if (s === '\x1b[F' || s === '\x1bOF' || s === 'G') {
        resolve('end');
      } else if (s === '\x1b' || s === '\x03') {
        resolve('escape');
      } else {
        resolve('other');
      }
    });
  });
}

function moveCursorUp(n: number): string {
  return n > 0 ? `\x1b[${n}A` : '';
}

export interface InteractiveSelectResult {
  index: number;
  checked: number[];
}

/** 선택 목록 위·아래에 붙는 작은 안내. 호출부는 화면의 맥락만 주고, 키 처리와
 * 다시 그리기는 이 모듈이 맡는다. */
export interface InteractiveSelectPresentation {
  title?: string;
  hint?: string;
  /** Space 로 전체 항목을 함께 토글할 다중선택의 특수 항목 인덱스. */
  selectAllIndex?: number;
}

function renderInteractiveSelect(
  options: string[],
  state: SelectState,
  multi: boolean,
  c: Caps,
  presentation: InteractiveSelectPresentation,
): { text: string; lineCount: number } {
  const color = makeColors(c.color);
  const lines = renderSelectOptions(options, state, multi, c).split('\n');
  if (presentation.hint) {
    lines.push('');
    lines.push(color.dim(presentation.hint));
  }
  const text = sectionBox(presentation.title ?? '선택', lines, c);
  return { text, lineCount: text.split('\n').length };
}

/**
 * raw-mode 를 켜고 방향키 선택 화면을 그 자리에서 갱신한다. Esc/Ctrl+C 로
 * 취소하면 null. 끝나면(성공이든 취소든) raw-mode 를 반드시 되돌린다.
 */
export async function runInteractiveSelect(
  options: string[],
  defaultIndex: number,
  multi: boolean,
  c: Caps,
  defaultChecked: number[] = [],
  presentation: InteractiveSelectPresentation = {},
): Promise<InteractiveSelectResult | null> {
  let state = initSelectState(defaultIndex, defaultChecked);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  let rendered = renderInteractiveSelect(options, state, multi, c, presentation);
  process.stdout.write(`${rendered.text}\n`);
  try {
    while (!state.done) {
      const key = await readKey();
      state = advanceSelect(state, key, options.length, multi, presentation.selectAllIndex);
      rendered = renderInteractiveSelect(options, state, multi, c, presentation);
      process.stdout.write(`${moveCursorUp(rendered.lineCount)}${rendered.text}\n`);
    }
  } finally {
    process.stdin.setRawMode(false);
    process.stdin.pause();
  }
  return state.cancelled ? null : { index: state.index, checked: [...state.checked] };
}
