/**
 * 터미널 렌더링 모듈.
 *
 * 원칙: ASCII를 기본으로 두고, 유니코드는 확실히 감지될 때만 얹는다.
 * 유니코드 박스 문자는 구식 cmd.exe, CI 로그, 일부 SSH 세션에서 깨진다.
 * 이모지는 어디에도 쓰지 않는다. 예외 없다.
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
    (codePoint >= 0x200b && codePoint <= 0x200f) // Zero-width space 등
  ) {
    return 0;
  }
  return isWide(codePoint) ? 2 : 1;
}

/** East Asian Wide/Fullwidth 범위인가 */
function isWide(cp: number): boolean {
  return (
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
  for (const ch of str) {
    width += charWidth(ch.codePointAt(0) ?? 0);
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
  ok: string;
  fail: string;
  radioOn: string;
  radioOff: string;
  checkOn: string;
  checkOff: string;
}

const UNICODE_SYMBOLS: Symbols = {
  boxTL: '┌',
  boxTR: '┐',
  boxBL: '└',
  boxBR: '┘',
  boxH: '─',
  boxV: '│',
  midL: '├',
  midR: '┤',
  ok: '✓',
  fail: '✗',
  radioOn: '●',
  radioOff: '○',
  checkOn: '☑',
  checkOff: '☐',
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
  ok: '[ok]',
  fail: '[!!]',
  radioOn: '(*)',
  radioOff: '( )',
  checkOn: '[x]',
  checkOff: '[ ]',
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

/**
 * 박스를 그린다. 한글/CJK가 섞여도 표시 폭으로 정렬한다.
 *
 * @param title 상단 제목. 빈 문자열이면 제목 행과 구분선을 생략한다.
 * @param lines 본문 줄들.
 * @param symbols 기호 세트. 생략하면 현재 능력 기준으로 고른다.
 */
export function box(title: string, lines: string[], symbols: Symbols = sym): string {
  const s = symbols;
  const contentLines = title ? [title, ...lines] : [...lines];
  const inner = contentLines.reduce((max, line) => Math.max(max, stringWidth(line)), 0);
  const padding = 1; // 좌우 여백 한 칸씩

  const horizontal = (left: string, right: string): string =>
    left + s.boxH.repeat(inner + padding * 2) + right;

  const rowOf = (text: string): string => {
    const gap = inner - stringWidth(text);
    return `${s.boxV}${' '.repeat(padding)}${text}${' '.repeat(gap)}${' '.repeat(padding)}${s.boxV}`;
  };

  const out: string[] = [horizontal(s.boxTL, s.boxTR)];
  if (title) {
    out.push(rowOf(title));
    out.push(horizontal(s.midL, s.midR));
  }
  for (const line of lines) {
    out.push(rowOf(line));
  }
  out.push(horizontal(s.boxBL, s.boxBR));
  return out.join('\n');
}

/**
 * 사람용 출력을 위한 공통 카드. JSON 모드는 호출하지 않아 자동화 출력이 섞이지
 * 않는다. 색을 쓸 수 있는 TTY에서는 프레임·제목만 은은하게 강조하고, 파이프와
 * 구식 터미널에서는 같은 구조를 ASCII로 그대로 보여준다.
 */
export function card(title: string, lines: string[], c: Caps = caps(), minInnerWidth = 0): string {
  const s = makeSymbols(c);
  const color = makeColors(c.color);
  const inner = Math.max(minInnerWidth, visibleWidth(title), ...lines.map(visibleWidth));
  const frame = (text: string): string => color.cyan(text);
  const row = (text: string, emphasize = false): string => {
    const gap = inner - visibleWidth(text);
    const content = emphasize ? color.bold(text) : text;
    return `${frame(s.boxV)} ${content}${' '.repeat(gap + 1)}${frame(s.boxV)}`;
  };
  const horizontal = (left: string, right: string): string =>
    frame(`${left}${s.boxH.repeat(inner + 2)}${right}`);

  return [
    horizontal(s.boxTL, s.boxTR),
    row(title, true),
    horizontal(s.midL, s.midR),
    ...lines.map((line) => row(line)),
    horizontal(s.boxBL, s.boxBR),
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
  gray: (s: string) => string;
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
    gray: (s) => ansi(90, s, enabled),
  };
}

/** 현재 프로세스 능력 기준 색 함수. */
export const color: Colors = makeColors(caps().color);
