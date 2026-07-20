/**
 * 터미널 렌더링 모듈.
 *
 * 원칙: ASCII를 기본으로 두고, 유니코드는 확실히 감지될 때만 얹는다.
 * 유니코드 박스 문자는 구식 cmd.exe, CI 로그, 일부 SSH 세션에서 깨진다.
 * 상태 이모지는 유니코드 TTY에서만 쓴다. 파이프·CI·구식 터미널에서는 읽기
 * 쉬운 ASCII 표기로 폴백해 자동화 로그를 깨지 않는다.
 *
 * 테스트 가능성을 위해 감지 로직은 순수 함수(computeCaps)로 분리한다.
 * process.stdout.isTTY / process.env / process.platform 을 인자로 주입받으므로
 * 환경을 조작하지 않고도 폴백을 검증할 수 있다.
 */

export interface Caps {
  /** 유니코드 박스/기호를 쓸 수 있는가 */
  unicode: boolean;
  /** ANSI 색을 쓸 수 있는가 */
  color: boolean;
  /** 출력이 실제 터미널(TTY)인가 */
  tty: boolean;
}

/** 환경변수가 "켜짐"으로 볼 만한 값인가 (빈 값/false/0 은 꺼짐) */
function isTruthy(value: string | undefined): boolean {
  if (value === undefined) {
    return false;
  }
  const v = value.trim().toLowerCase();
  return v !== '' && v !== '0' && v !== 'false';
}

function detectColor(env: NodeJS.ProcessEnv, tty: boolean, ci: boolean): boolean {
  // 명세: CI면 무조건 색 없음.
  if (ci) {
    return false;
  }
  // no-color.org 표준: NO_COLOR 가 존재하고 빈 문자열이 아니면 색 끔.
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') {
    return false;
  }
  if (env.TERM === 'dumb') {
    return false;
  }
  // FORCE_COLOR 는 tty 감지를 덮어쓴다(문서 스크린샷·데모에서 파이프로도 색을 얻음).
  // 단 위의 NO_COLOR/CI/dumb 는 여전히 우선한다(로그·CI 안전).
  if (isTruthy(env.FORCE_COLOR)) {
    return true;
  }
  // 파이프로 리다이렉트되면(!isTTY) 색 없음.
  if (!tty) {
    return false;
  }
  return true;
}

function detectUnicode(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  tty: boolean,
  ci: boolean,
): boolean {
  // 명세: CI면 무조건 ASCII.
  if (ci) {
    return false;
  }
  if (env.TERM === 'dumb') {
    return false;
  }
  // 파이프 리다이렉트면 ASCII가 안전하다(로그 파일에 박스 문자가 깨져 남는 것 방지).
  if (!tty) {
    return false;
  }
  if (platform === 'win32') {
    // Windows Terminal 과 VS Code 통합 터미널은 유니코드를 제대로 렌더한다.
    // 그 외 구식 콘솔(conhost/cmd.exe)은 보수적으로 ASCII.
    if (isTruthy(env.WT_SESSION) || env.TERM_PROGRAM === 'vscode') {
      return true;
    }
    return false;
  }
  // POSIX: 로케일이 UTF-8 이면 유니코드로 본다.
  const locale = env.LC_ALL || env.LC_CTYPE || env.LANG || '';
  return /UTF-?8/i.test(locale);
}

/** 순수 감지 함수. process 값을 주입받는다. */
export function computeCaps(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  isTTY: boolean,
): Caps {
  const tty = isTTY === true;
  const ci = isTruthy(env.CI);
  return {
    tty,
    color: detectColor(env, tty, ci),
    unicode: detectUnicode(env, platform, tty, ci),
  };
}

/** 실제 프로세스 환경으로 능력을 감지한다. */
export function caps(): Caps {
  return computeCaps(process.env, process.platform, process.stdout.isTTY === true);
}

/**
 * 방향키 raw-mode 선택이 가능한지 감지한다(WI-Y). Caps 와 별도 함수로 둔다 —
 * Caps 는 출력 렌더링 능력(stdout 기준)이고 이건 입력 처리 능력(stdin 기준)이라
 * 축이 다르다. CI 면 무조건 false(명세: 색/유니코드와 같은 원칙). stdin 이
 * TTY 가 아니면(파이프·리다이렉트) false — 이 경우 raw-mode 자체가 의미 없다.
 */
export function computeRawModeCapable(
  stdinIsTTY: boolean,
  hasSetRawMode: boolean,
  ci: boolean,
): boolean {
  if (ci) {
    return false;
  }
  return stdinIsTTY && hasSetRawMode;
}

/** 실제 프로세스로 raw-mode 능력을 감지한다. */
export function rawModeCapable(): boolean {
  return computeRawModeCapable(
    process.stdin.isTTY === true,
    typeof process.stdin.setRawMode === 'function',
    isTruthy(process.env.CI),
  );
}

// ---------------------------------------------------------------------------
// 표시 폭 계산 (한글/CJK는 2칸을 차지한다)
// ---------------------------------------------------------------------------

/** 코드포인트 하나가 차지하는 표시 폭 (0, 1, 2) */
export function charWidth(codePoint: number): number {
  // NUL 및 제어문자는 폭 0.
  if (codePoint === 0) {
    return 0;
  }
  if (codePoint < 0x20 || (codePoint >= 0x7f && codePoint < 0xa0)) {
    return 0;
  }
  // 결합용 기호(주요 범위)는 폭 0.
  if (
    (codePoint >= 0x0300 && codePoint <= 0x036f) || // Combining Diacritical Marks
    (codePoint >= 0x200b && codePoint <= 0x200f) || // Zero-width space 등
    (codePoint >= 0xfe00 && codePoint <= 0xfe0f) // Variation Selectors (VS16 = 이모지 표현)
  ) {
    return 0;
  }
  return isWide(codePoint) ? 2 : 1;
}

/** East Asian Wide/Fullwidth 범위인가 */
function isWide(cp: number): boolean {
  return (
    // emoji-presentation-default 라 VS16 없이도 2칸으로 렌더되는 것만 명시한다.
    // ⚠️ ℹ️ ▶️ ™️ 처럼 기저문자가 좁은 것은 stringWidth 가 VS16(0xFE0F) 유무로 판정한다.
    // (0.6.1 에서 0x2600–0x27bf 전체를 폭2로 넣었더니 텍스트-표현 기호와 awl 자체
    //  글리프 ❯(U+276F 커서)·☑/☐ 체크박스까지 과대계산해 테두리가 어긋났다 — 적대검증.)
    cp === 0x2705 || // ✅
    cp === 0x274c || // ❌
    (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
    (cp >= 0x2e80 && cp <= 0x303e) || // CJK Radicals ~ CJK Symbols
    (cp >= 0x3041 && cp <= 0x33ff) || // Hiragana ~ CJK Compatibility
    (cp >= 0x3400 && cp <= 0x4dbf) || // CJK Ext A
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK Unified Ideographs
    (cp >= 0xa000 && cp <= 0xa4cf) || // Yi
    (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul Syllables
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK Compatibility Ideographs
    (cp >= 0xfe30 && cp <= 0xfe4f) || // CJK Compatibility Forms
    (cp >= 0xff00 && cp <= 0xff60) || // Fullwidth Forms
    (cp >= 0xffe0 && cp <= 0xffe6) || // Fullwidth signs
    (cp >= 0x1f300 && cp <= 0x1faff) || // 넓은 기호(대비용; 이모지는 우리가 안 씀)
    (cp >= 0x20000 && cp <= 0x3fffd) // CJK Ext B 이상
  );
}

/** 문자열의 표시 폭. for..of 로 코드포인트 단위 순회(서로게이트 안전). */
export function stringWidth(str: string): number {
  let width = 0;
  let prevWidth = 0;
  for (const ch of str) {
    const cp = ch.codePointAt(0) ?? 0;
    // VS16(0xFE0F)은 직전 문자를 이모지 표현(폭2)으로 승격한다. 직전이 폭1이면
    // +1 해 2칸으로 만들고(⚠️ ℹ️ ▶️ ™️), 이미 폭2면 가산하지 않는다(✅❌ 등).
    if (cp === 0xfe0f) {
      if (prevWidth === 1) {
        width += 1;
        prevWidth = 2;
      }
      continue;
    }
    const w = charWidth(cp);
    width += w;
    prevWidth = w;
  }
  return width;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape sequence를 폭 계산에서 제외한다.
const ANSI_SGR = /\x1b\[[0-9;]*m/g;

/** ANSI SGR 색상 코드는 화면 폭을 차지하지 않는다. 카드 안에 색을 넣어도 테두리가
 * 흔들리지 않도록, 렌더러는 이 함수를 기준으로 여백을 계산한다. */
export function visibleWidth(str: string): number {
  return stringWidth(str.replace(ANSI_SGR, ''));
}

/**
 * 표시 폭 기준으로 한 줄을 width 칸 이내로 접는다(ANSI 색 인지). 공백 경계를
 * 우선하되, 한 단어가 width 를 넘으면 강제로 자른다. 색이 걸린 줄도 시퀀스를
 * 끊지 않고 줄마다 열린 색을 닫았다가 다시 여는 방식으로 안전하게 접는다.
 * card 본문이 뷰포트를 넘겨 박스가 화면 밖까지 늘어나는 것을 막는 데 쓴다.
 */
/**
 * 선행 들여쓰기(공백 + 선택적 트리/불릿 마커)의 표시폭을 잰다(cli-design-tokens AC-03).
 * 색(ANSI)이 걸린 줄은 마커 폭 계산이 어긋날 수 있어, 호출부가 "순수 텍스트 프리픽스"일
 * 때만 이 값을 쓴다. 반환 문자열은 실제 프리픽스(연속줄 정렬용 공백폭 계산에 씀).
 */
function leadingIndentPrefix(text: string): string {
  // 선행 공백 + (있으면) 트리 글리프(├└│─) 또는 불릿(-*•●○▪‣) 하나 + 뒤 공백.
  const m = /^(\s*(?:[├└│][─│\s]*|[-*•●○▪‣])?\s*)/.exec(text);
  return m?.[0] ?? '';
}

export function wrapToWidth(text: string, width: number, opts?: { hanging?: boolean }): string[] {
  if (width <= 0 || visibleWidth(text) <= width) {
    return [text];
  }
  // hanging indent: 넘친 줄이 원줄의 들여쓰기(트리/불릿 오프셋)를 유지한다(F-03).
  // 선행 프리픽스가 순수 텍스트(색 없음)로 원문 시작과 정확히 일치할 때만 적용 —
  // 색이 걸린 줄은 안전하게 일반 워드랩으로 떨어진다.
  if (opts?.hanging) {
    const prefix = leadingIndentPrefix(text);
    const hangW = stringWidth(prefix);
    if (hangW > 0 && hangW < width && text.startsWith(prefix)) {
      const rest = text.slice(prefix.length);
      const wrapped = wrapToWidth(rest, width - hangW); // 내용만(마커 제외) 좁은 폭으로
      const pad = ' '.repeat(hangW);
      return wrapped.map((line, i) => (i === 0 ? prefix + line : pad + line));
    }
  }
  // 1) 문자 단위로 (활성 스타일, 글자, 폭) 분해. SGR 은 폭 0, 스타일만 바꾼다.
  const cells: { style: string; ch: string; w: number }[] = [];
  let style = '';
  let i = 0;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI SGR 시퀀스를 스타일 경계로 인식한다.
  const sgr = /^\x1b\[[0-9;]*m/;
  while (i < text.length) {
    const seq = sgr.exec(text.slice(i))?.[0];
    if (seq) {
      style = seq === RESET ? '' : style + seq;
      i += seq.length;
      continue;
    }
    const cp = text.codePointAt(i) ?? 0;
    const ch = String.fromCodePoint(cp);
    cells.push({ style, ch, w: charWidth(cp) });
    i += ch.length;
  }

  // 2) 줄을 렌더할 때 열린 색을 최소 시퀀스로 다시 감싼다.
  const render = (arr: { style: string; ch: string }[]): string => {
    let out = '';
    let open = '';
    for (const cell of arr) {
      if (cell.style !== open) {
        if (open) out += RESET;
        out += cell.style;
        open = cell.style;
      }
      out += cell.ch;
    }
    return open ? out + RESET : out;
  };

  // 3) 표시 폭 기준 그리디 워드랩.
  const lines: string[] = [];
  let cur: { style: string; ch: string; w: number }[] = [];
  let curW = 0;
  const flush = (): void => {
    let end = cur.length;
    while (end > 0 && cur[end - 1]?.ch === ' ') end--;
    lines.push(render(cur.slice(0, end)));
    cur = [];
    curW = 0;
  };
  for (const cell of cells) {
    if (curW + cell.w > width && curW > 0) {
      let br = -1;
      for (let k = cur.length - 1; k >= 0; k--) {
        if (cur[k]?.ch === ' ') {
          br = k;
          break;
        }
      }
      if (br > 0) {
        const carry = cur.slice(br + 1);
        cur = cur.slice(0, br);
        flush();
        cur = carry;
        curW = carry.reduce((s, x) => s + x.w, 0);
      } else {
        flush();
      }
    }
    cur.push(cell);
    curW += cell.w;
  }
  if (cur.length) flush();
  return lines.length ? lines : [''];
}

/** 한 줄을 width 칸으로 자르고 넘치면 … 를 붙인다. 제목 등 평문에 쓴다. */
export function truncateToWidth(text: string, width: number): string {
  if (width <= 0) {
    return '';
  }
  const plain = text.replace(ANSI_SGR, '');
  if (stringWidth(plain) <= width) {
    return plain;
  }
  let out = '';
  let w = 0;
  for (const ch of plain) {
    const cw = charWidth(ch.codePointAt(0) ?? 0);
    if (w + cw + 1 > width) break; // … 자리 확보
    out += ch;
    w += cw;
  }
  return `${out}…`;
}

/**
 * 색(ANSI SGR)을 보존하며 표시 폭 기준으로 자르고 넘치면 … 를 붙인다(cli-visual-consistency AC-07).
 * truncateToWidth 는 색을 벗겨 평문 제목에 쓰지만, 이건 카드 안의 색 있는 값(doctor 등)을 자를 때
 * 쓴다 — SGR 시퀀스를 중간에 끊지 않고, 잘린 끝에서 열린 색을 닫아 뒤 출력이 오염되지 않게 한다.
 */
export function clipToWidth(text: string, width: number): string {
  if (width <= 0) {
    return '';
  }
  if (visibleWidth(text) <= width) {
    return text;
  }
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI SGR 시퀀스를 경계로 인식한다.
  const sgr = /^\x1b\[[0-9;]*m/;
  let out = '';
  let w = 0;
  let open = '';
  let i = 0;
  while (i < text.length) {
    const seq = sgr.exec(text.slice(i))?.[0];
    if (seq) {
      out += seq;
      open = seq === RESET ? '' : open + seq;
      i += seq.length;
      continue;
    }
    const cp = text.codePointAt(i) ?? 0;
    const ch = String.fromCodePoint(cp);
    const cw = charWidth(cp);
    if (w + cw + 1 > width) {
      break; // … 자리 확보
    }
    out += ch;
    w += cw;
    i += ch.length;
  }
  return `${out}…${open ? RESET : ''}`;
}

/**
 * 표시 폭(stringWidth) 기준으로 오른쪽을 공백으로 채운다(cli-design-tokens F-05).
 * String.padEnd 는 UTF-16 코드유닛을 세어 한글(음절 1유닛·표시 2칸)이 섞이면 열이
 * 어긋난다. 표 정렬은 이걸 써서 한글 헤더와 ASCII 값이 같은 열에 맞게 한다.
 */
export function padEndDisplay(text: string, width: number): string {
  return text + ' '.repeat(Math.max(0, width - stringWidth(text)));
}

// ---------------------------------------------------------------------------
// 기호 세트
// ---------------------------------------------------------------------------

export interface Symbols {
  boxTL: string;
  boxTR: string;
  boxBL: string;
  boxBR: string;
  boxH: string;
  boxV: string;
  midL: string;
  midR: string;
  /** 트리 중간 가지 (├──) */
  branch: string;
  /** 트리 마지막 가지 (╰──) */
  lastBranch: string;
  /** 트리 세로 가이드 (│) */
  vGuide: string;
  radioOn: string;
  radioOff: string;
  checkOn: string;
  checkOff: string;
  /** 스파인 세션 시작 — 세션당 정확히 한 번, 맨 위. */
  flowStart: string;
  /** 완료된 정보 스텝(한 줄 요약). */
  flowStep: string;
  /** 완료된 "사용자가 고름" 스텝(한 줄 요약, 정보와 시각적으로 구분). */
  flowSelect: string;
  /** 지금 진행 중인 활성/확장 노드. */
  flowActive: string;
  /** 좌측 거터 세로선 — 빈 연결줄과 활성 노드 본문 각 줄의 앞머리. */
  flowLine: string;
  /** 스파인 세션 종료 — 세션당 정확히 한 번, 맨 아래, 뒤에 아무 것도 안 붙는다. */
  flowEnd: string;
}

const UNICODE_SYMBOLS: Symbols = {
  boxTL: '╭',
  boxTR: '╮',
  boxBL: '╰',
  boxBR: '╯',
  boxH: '─',
  boxV: '│',
  midL: '├',
  midR: '┤',
  branch: '├──',
  // 트리 연결자는 사각으로 둔다 — 박스 모서리(둥근 ╭╮╰╯)와 역할이 다르고,
  // 코드베이스 전반이 이미 사각 └── 를 쓰므로 한 벌로 일관되게 맞춘다.
  lastBranch: '└──',
  vGuide: '│',
  radioOn: '●',
  radioOff: '○',
  checkOn: '☑',
  checkOff: '☐',
  flowStart: '┌',
  flowStep: '◇',
  // radioOn 과 같은 문자(●)를 재사용한다 — "사용자가 고름"이라는 의미가 실제로
  // 같고(체크된 라디오), ASCII 대체는 폭이 달라(radioOn 은 3칸 "(*)") 별도 필드로 둔다.
  flowSelect: '●',
  flowActive: '◆',
  flowLine: '│',
  flowEnd: '└',
};

const ASCII_SYMBOLS: Symbols = {
  boxTL: '+',
  boxTR: '+',
  boxBL: '+',
  boxBR: '+',
  boxH: '-',
  boxV: '|',
  midL: '+',
  midR: '+',
  branch: '|--',
  lastBranch: '`--',
  vGuide: '|',
  radioOn: '(*)',
  radioOff: '( )',
  checkOn: '[x]',
  checkOff: '[ ]',
  flowStart: '+',
  flowStep: 'o',
  flowSelect: '*',
  flowActive: '>',
  flowLine: '|',
  flowEnd: '+',
};

/** 능력에 맞는 기호 세트를 고른다. */
export function makeSymbols(c: Caps): Symbols {
  return c.unicode ? UNICODE_SYMBOLS : ASCII_SYMBOLS;
}

/** 현재 프로세스 능력 기준 기호 세트. */
export const sym: Symbols = makeSymbols(caps());

// ---------------------------------------------------------------------------
// 박스 그리기
// ---------------------------------------------------------------------------

// 구형 box()·card() 는 순서대로 폐기했다(cli-design-tokens F-02, 이어서 clack 스타일
// 트랜스크립트 재설계) — 둘 다 호출처가 0건인 죽은 코드가 됐다. 지금은 사람용 박스를
// 전부 이 아래 flow* 계열 순수 함수로 그린다: 세션 하나가 시작(┌)부터 끝(└)까지
// 좌측 세로선(│)으로 이어지는 clack-prompts 스타일 트랜스크립트다. sectionBox 는
// "노드가 하나뿐인 세션"의 얇은 래퍼일 뿐이라, 기존 17개+ 호출부는 시그니처 변경
// 없이 새 글리프를 그대로 받는다.

/** 카드/구분선의 절대 상한 폭. 아주 넓은 터미널에서도 가독선을 유지한다. */
const HARD_MAX_WIDTH = 100;

/**
 * 뷰포트(터미널) 폭. 실제 TTY 면 stdout.columns, 아니면 COLUMNS 환경변수(셸 관례),
 * 둘 다 없으면 하드맥스로 폴백한다. 파이프·리다이렉트에서 박스가 최장 줄까지
 * 무한정 늘어나던 문제를 이 상한이 막는다.
 */
function viewportWidth(): number {
  const envCols = Number(process.env.COLUMNS);
  if (process.stdout.columns && process.stdout.columns > 0) {
    return process.stdout.columns;
  }
  if (Number.isFinite(envCols) && envCols > 0) {
    return envCols;
  }
  return HARD_MAX_WIDTH;
}

/** flow* 계열 전체가 공유하는 좌우 여백(호흡). */
const FLOW_PAD = 2;

/** 본문 폭 상한(뷰포트 기반, minInnerWidth 는 하한) — flowOpen/flowActiveNode/flowBodyRows 공용. */
function flowMaxInner(minInnerWidth: number): number {
  return Math.max(minInnerWidth, Math.min(HARD_MAX_WIDTH, viewportWidth() - (2 + FLOW_PAD * 2)));
}

/**
 * 본문 줄들을 폭에 맞춰 접고 좌측 거터(│)를 붙인다. sectionBox 와 flowActiveNode 가
 * 공유하는 유일한 wrap/prefix 구현 — 중복 금지.
 */
function flowBodyRows(lines: string[], c: Caps, minInnerWidth: number): string[] {
  const s = makeSymbols(c);
  const t = makeTokens(c);
  const maxInner = flowMaxInner(minInnerWidth);
  const wrapped = lines.flatMap((line) => wrapToWidth(line, maxInner, { hanging: true }));
  return wrapped.map((text) => `${t.frame(s.flowLine)}${' '.repeat(FLOW_PAD)}${text}`);
}

/** 스파인 세션을 연다 — 세션당 정확히 한 번, 맨 위. 헤더 한 줄만 낸다(본문 없음). */
export function flowOpen(title: string, c: Caps = caps(), minInnerWidth = 0): string {
  const s = makeSymbols(c);
  const t = makeTokens(c);
  const safeTitle = truncateToWidth(title, flowMaxInner(minInnerWidth));
  return `${t.frame(s.flowStart)}${' '.repeat(FLOW_PAD)}${t.emphasis(t.accent(safeTitle))}`;
}

/** 완료된 정보 스텝 한 줄(◇). */
export function flowStepLine(title: string, c: Caps = caps()): string {
  const s = makeSymbols(c);
  return `${makeTokens(c).frame(s.flowStep)}${' '.repeat(FLOW_PAD)}${title}`;
}

/** 완료된 "사용자가 고름" 스텝 한 줄(●) — 정보(◇)와 시각적으로 구분한다. */
export function flowSelectLine(title: string, c: Caps = caps()): string {
  const s = makeSymbols(c);
  return `${makeTokens(c).frame(s.flowSelect)}${' '.repeat(FLOW_PAD)}${title}`;
}

/** 빈 연결줄 — 완료된 노드 사이에 하나씩 둔다. */
export function flowConnector(c: Caps = caps()): string {
  return makeTokens(c).frame(makeSymbols(c).flowLine);
}

/** 스파인 세션을 닫는다 — 세션당 정확히 한 번, 맨 아래, 뒤에 아무 것도 안 붙는다. */
export function flowClose(c: Caps = caps()): string {
  return makeTokens(c).frame(makeSymbols(c).flowEnd);
}

/**
 * 지금 진행 중인 활성 노드(◆) — 헤더 한 줄 + 거터 프리픽스된 본문 여러 줄. 자체
 * 열기/닫기 모서리는 안 그린다(세션의 ┌/└ 는 flowOpen/flowClose 몫) — select.ts 의
 * renderInteractiveSelect 가 이 함수로 기존 sectionBox 호출을 대체한다.
 */
export function flowActiveNode(
  title: string,
  lines: string[],
  c: Caps = caps(),
  minInnerWidth = 0,
): string {
  const s = makeSymbols(c);
  const t = makeTokens(c);
  const safeTitle = truncateToWidth(title, flowMaxInner(minInnerWidth));
  const header = `${t.frame(s.flowActive)}${' '.repeat(FLOW_PAD)}${t.emphasis(t.accent(safeTitle))}`;
  return [header, ...flowBodyRows(lines, c, minInnerWidth)].join('\n');
}

/**
 * 단발성 카드 — 노드가 하나뿐인 스파인 세션(flowOpen + 본문 + flowClose)이다.
 * status/doctor/lane 등 비대화형 명령이 전부 이 함수 하나로 카드를 찍는다.
 * 시그니처는 이전(열린 ㄷ자 박스이던 시절)과 동일하게 유지한다 — 호출부 17개+ 를
 * 하나도 안 고치고 새 글리프를 그대로 받게 하는 핵심 장치다.
 */
export function sectionBox(
  title: string,
  lines: string[],
  c: Caps = caps(),
  minInnerWidth = 0,
): string {
  return [
    flowOpen(title, c, minInnerWidth),
    ...flowBodyRows(lines, c, minInnerWidth),
    flowClose(c),
  ].join('\n');
}

// ---------------------------------------------------------------------------
// 색
// ---------------------------------------------------------------------------

const RESET = '\x1b[0m';

function ansi(code: number, str: string, enabled: boolean): string {
  return enabled ? `\x1b[${code}m${str}${RESET}` : str;
}

export interface Colors {
  bold: (s: string) => string;
  dim: (s: string) => string;
  red: (s: string) => string;
  green: (s: string) => string;
  yellow: (s: string) => string;
  cyan: (s: string) => string;
  blue: (s: string) => string;
  gray: (s: string) => string;
}

/**
 * 역할 기반 의미 토큰(cli-design-tokens). 명령이 외형 색 이름(cyan/red…)이 아니라
 * "무엇을 위한 색인가"(accent/danger…)로 쓰게 해, 팔레트를 한 곳에서 바꿀 수 있고
 * 의미 충돌(info 와 카드 제목이 둘 다 cyan 이던 것)을 막는다. makeColors 위의 얇은 층이다.
 */
export interface Tokens {
  /** 강조(가장 중요한 값) */
  emphasis: (s: string) => string;
  /** 부가·설명(뒤로 물러남) */
  muted: (s: string) => string;
  /** 위험·오류 */
  danger: (s: string) => string;
  /** 경고 */
  warning: (s: string) => string;
  /** 성공 */
  success: (s: string) => string;
  /** 액센트(카드 제목 등) */
  accent: (s: string) => string;
  /** 정보(accent 와 분리된 색) */
  info: (s: string) => string;
  /** 테두리·프레임 */
  frame: (s: string) => string;
}

export function makeTokens(c: Caps): Tokens {
  const col = makeColors(c.color);
  return {
    emphasis: col.bold,
    muted: col.dim,
    danger: col.red,
    warning: col.yellow,
    success: col.green,
    accent: col.cyan,
    info: col.blue,
    frame: col.gray,
  };
}

/** 사람용 상태 신호. 모든 명령이 같은 성공·경고·오류 어휘를 쓰게 한다.
 * 유니코드 여부와 무관하게 항상 텍스트 마커를 쓴다 — 이모지(✅⚠️❌ℹ️)는 터미널·
 * 폰트마다 렌더 폭이 들쭉날쭉해 정렬이 깨지고, 색맹 등 색만으로 구분 못 하는
 * 환경에서 접근성도 떨어진다는 지적(사용자 피드백)에 따라 색+텍스트로 통일했다. */
export function signal(c: Caps, kind: 'ok' | 'warn' | 'error' | 'info'): string {
  const color = makeColors(c.color);
  const raw = { ok: '[ok]', warn: '[!]', error: '[x]', info: '[i]' }[kind];
  if (kind === 'ok') {
    return color.green(raw);
  }
  if (kind === 'warn') {
    return color.yellow(raw);
  }
  if (kind === 'error') {
    return color.red(raw);
  }
  // info 는 blue — 카드 제목의 accent(cyan)와 색을 분리한다(cli-design-tokens F-01).
  return color.blue(raw);
}

/** 파이프라인 레인 상태 키워드(pipeline-status-tracking F-01). */
export type PipelineStatus = 'pending' | 'executing' | 'reviewing' | 'complete' | 'blocked';

/**
 * 파이프라인 workitem 상태 배지(pipeline-status-tracking AC-01). signal 과 같은 패턴 —
 * 색 토큰 + 유니코드 글리프(폭1)/ASCII 폴백. 상태 어휘를 한 곳에서 관리한다.
 */
export function statusBadge(c: Caps, status: PipelineStatus): string {
  const t = makeTokens(c);
  const glyph = c.unicode
    ? { pending: '○', executing: '▶', reviewing: '◐', complete: '●', blocked: '✗' }[status]
    : { pending: '[.]', executing: '[>]', reviewing: '[~]', complete: '[ok]', blocked: '[x]' }[
        status
      ];
  const paint = {
    pending: t.muted,
    executing: t.accent,
    reviewing: t.warning,
    complete: t.success,
    blocked: t.danger,
  }[status];
  return paint(glyph);
}

// ---------------------------------------------------------------------------
// 경량 레이아웃 (박스 없이 색·여백으로 — 액션 결과용)
// ---------------------------------------------------------------------------

/**
 * 액션 결과 한 줄: `  {신호} {제목}` + 선택적 dim 상세(둘째 줄). work new/switch
 * 같은 짧은 피드백을 박스 없이 일관된 어휘로 보여준다.
 */
export function feedback(
  c: Caps,
  kind: 'ok' | 'warn' | 'error' | 'info',
  title: string,
  detail?: string,
): string {
  const color = makeColors(c.color);
  const head = `  ${signal(c, kind)} ${title}`;
  return detail ? `${head}\n    ${color.dim(detail)}` : head;
}

/** 색 함수 묶음. enabled=false 면 입력을 그대로 통과시킨다. */
export function makeColors(enabled: boolean): Colors {
  return {
    bold: (s) => ansi(1, s, enabled),
    dim: (s) => ansi(2, s, enabled),
    red: (s) => ansi(31, s, enabled),
    green: (s) => ansi(32, s, enabled),
    yellow: (s) => ansi(33, s, enabled),
    cyan: (s) => ansi(36, s, enabled),
    blue: (s) => ansi(34, s, enabled),
    gray: (s) => ansi(90, s, enabled),
  };
}

/** ANSI 256색 큐브에서 고른 무지개 순서(빨·주·노·초·청·파·보). */
const RAINBOW = [196, 208, 226, 46, 51, 33, 129];

/** 여러 줄 워드마크에 쓰는 좌→우 무지개 그라데이션. 열(문자 위치) 기준이라, 로고 전체의
 * 가로 폭을 기준으로 매 문자가 같은 열에서는(행이 달라도) 같은 색을 쓴다 — 그래서
 * 세로로 봤을 때도 색이 갈라지지 않고 좌우로 흐르는 것처럼 보인다. */
export function gradient(lines: string[], c: Caps): string[] {
  if (!c.color) {
    return lines;
  }
  const maxWidth = Math.max(...lines.map((l) => [...l].length), 1);
  return lines.map((line) => {
    const chars = [...line];
    return chars
      .map((ch, col) => {
        if (ch === ' ') return ch; // 공백은 색을 안 입혀도 무방(불필요한 ANSI 코드 방지)
        const ratio = maxWidth <= 1 ? 0 : col / (maxWidth - 1);
        const idx = RAINBOW[Math.min(RAINBOW.length - 1, Math.floor(ratio * RAINBOW.length))];
        return `\x1b[38;5;${idx}m${ch}${RESET}`;
      })
      .join('');
  });
}

/** 현재 프로세스 능력 기준 색 함수. */
export const color: Colors = makeColors(caps().color);
