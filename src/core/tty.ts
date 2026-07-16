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
export function wrapToWidth(text: string, width: number): string[] {
  if (width <= 0 || visibleWidth(text) <= width) {
    return [text];
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

// 구형 box() 는 폐기했다(cli-design-tokens F-02) — 호출처가 0건인 죽은 코드였고,
// 무채색·사각·제목별행이라 신형 card()(컬러·둥근·제목 인레이)와 이질적이었다.
// 사람용 박스는 card() 하나로 통일한다.

/**
 * 사람용 출력을 위한 공통 카드. JSON 모드는 호출하지 않아 자동화 출력이 섞이지
 * 않는다. 색을 쓸 수 있는 TTY에서는 프레임·제목만 은은하게 강조하고, 파이프와
 * 구식 터미널에서는 같은 구조를 ASCII로 그대로 보여준다.
 */
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

export function card(title: string, lines: string[], c: Caps = caps(), minInnerWidth = 0): string {
  const s = makeSymbols(c);
  const t = makeTokens(c); // 의미 토큰: frame(테두리)·accent(제목)·emphasis(강조)
  const pad = 2; // 좌우 여백(호흡)

  // 폭 상한: 뷰포트에서 프레임(2)+여백(pad*2)을 뺀 값. minInnerWidth 는 하한(init 화면).
  const maxInner = Math.max(
    minInnerWidth,
    Math.min(HARD_MAX_WIDTH, viewportWidth() - (2 + pad * 2)),
  );

  // 본문을 폭에 맞게 접는다(표시폭 기준, 색 인지) — 박스가 화면 밖까지 늘어나는 것 방지.
  const wrapped = lines.flatMap((line) => wrapToWidth(line, maxInner));
  const inner = Math.min(
    maxInner,
    Math.max(minInnerWidth, visibleWidth(title), ...wrapped.map(visibleWidth), 0),
  );

  const frame = (text: string): string => t.frame(text); // 테두리는 은은히 뒤로
  const row = (text: string): string => {
    const gap = Math.max(0, inner - visibleWidth(text));
    return `${frame(s.boxV)}${' '.repeat(pad)}${text}${' '.repeat(gap + pad)}${frame(s.boxV)}`;
  };

  // 상단 테두리에 제목을 심는다: ╭─ 제목 ─────╮ (제목은 accent+emphasis 로 강조)
  const safeTitle = truncateToWidth(title, inner);
  const tvis = visibleWidth(safeTitle);
  const dash = Math.max(1, inner + pad * 2 - 3 - tvis);
  const top =
    frame(`${s.boxTL}${s.boxH} `) +
    t.emphasis(t.accent(safeTitle)) +
    frame(` ${s.boxH.repeat(dash)}${s.boxTR}`);
  const bottom = frame(`${s.boxBL}${s.boxH.repeat(inner + pad * 2)}${s.boxBR}`);

  return [top, ...wrapped.map(row), bottom].join('\n');
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

/** 사람용 상태 신호. 모든 명령이 같은 성공·경고·오류 어휘를 쓰게 한다. */
export function signal(c: Caps, kind: 'ok' | 'warn' | 'error' | 'info'): string {
  const color = makeColors(c.color);
  const raw = c.unicode
    ? { ok: '✅', warn: '⚠️', error: '❌', info: 'ℹ️' }[kind]
    : { ok: '[ok]', warn: '[!]', error: '[x]', info: '[i]' }[kind];
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

/** 여러 줄 워드마크에만 쓰는 절제된 청록→보라 세로 그라데이션. */
export function gradient(lines: string[], c: Caps): string[] {
  if (!c.color) {
    return lines;
  }
  const palette = [51, 45, 39, 135];
  return lines.map((line, index) => `\x1b[38;5;${palette[index % palette.length]}m${line}${RESET}`);
}

/** 현재 프로세스 능력 기준 색 함수. */
export const color: Colors = makeColors(caps().color);
