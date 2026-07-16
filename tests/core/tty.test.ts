import { describe, expect, it } from 'vitest';
import {
  box,
  card,
  charWidth,
  computeCaps,
  computeRawModeCapable,
  makeColors,
  makeSymbols,
  stringWidth,
  visibleWidth,
} from '../../src/core/tty.js';

// 테스트용 환경 객체를 만든다.
function env(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return overrides as NodeJS.ProcessEnv;
}

describe('computeCaps — 능력 감지와 폴백', () => {
  it('CI가 켜져 있으면 무조건 ASCII/색없음 (TTY여도)', () => {
    const c = computeCaps(env({ CI: 'true', LANG: 'en_US.UTF-8' }), 'darwin', true);
    expect(c.unicode).toBe(false);
    expect(c.color).toBe(false);
    expect(c.tty).toBe(true);
  });

  it('TERM=dumb 면 유니코드/색 없음', () => {
    const c = computeCaps(env({ TERM: 'dumb', LANG: 'ko_KR.UTF-8' }), 'darwin', true);
    expect(c.unicode).toBe(false);
    expect(c.color).toBe(false);
  });

  it('파이프 리다이렉트(!isTTY)면 색과 유니코드 없음', () => {
    const c = computeCaps(env({ LANG: 'ko_KR.UTF-8' }), 'darwin', false);
    expect(c.color).toBe(false);
    expect(c.unicode).toBe(false);
    expect(c.tty).toBe(false);
  });

  it('NO_COLOR가 있으면 색 없음(유니코드는 유지)', () => {
    const c = computeCaps(env({ NO_COLOR: '1', LANG: 'ko_KR.UTF-8' }), 'darwin', true);
    expect(c.color).toBe(false);
    expect(c.unicode).toBe(true);
  });

  it('POSIX + UTF-8 로케일 + TTY 면 유니코드/색 모두 켜짐', () => {
    const c = computeCaps(env({ LANG: 'ko_KR.UTF-8', TERM: 'xterm-256color' }), 'linux', true);
    expect(c.unicode).toBe(true);
    expect(c.color).toBe(true);
  });

  it('POSIX 인데 로케일이 UTF-8이 아니면 유니코드 없음', () => {
    const c = computeCaps(env({ LANG: 'C' }), 'linux', true);
    expect(c.unicode).toBe(false);
  });

  it('Windows 구식 콘솔(마커 없음)은 ASCII로 보수적 판단', () => {
    const c = computeCaps(env({}), 'win32', true);
    expect(c.unicode).toBe(false);
  });

  it('Windows Terminal(WT_SESSION)이면 유니코드 켜짐', () => {
    const c = computeCaps(env({ WT_SESSION: 'abc-123' }), 'win32', true);
    expect(c.unicode).toBe(true);
  });

  it('Windows + VS Code 통합 터미널이면 유니코드 켜짐', () => {
    const c = computeCaps(env({ TERM_PROGRAM: 'vscode' }), 'win32', true);
    expect(c.unicode).toBe(true);
  });
});

describe('stringWidth — 한글/CJK 폭 계산', () => {
  it('ASCII는 1칸', () => {
    expect(stringWidth('abc')).toBe(3);
    expect(charWidth('a'.codePointAt(0) ?? 0)).toBe(1);
  });

  it('한글 음절은 2칸', () => {
    expect(stringWidth('가')).toBe(2);
    expect(stringWidth('한글')).toBe(4);
  });

  it('한글+ASCII 혼합', () => {
    // '한글' 4 + ' abc' 4 = 8
    expect(stringWidth('한글 abc')).toBe(8);
  });

  it('제어문자는 폭 0', () => {
    expect(charWidth(0)).toBe(0);
    expect(charWidth(0x1b)).toBe(0);
  });
});

describe('makeSymbols — 유니코드/ASCII 폴백', () => {
  const uni = makeSymbols({ unicode: true, color: true, tty: true });
  const ascii = makeSymbols({ unicode: false, color: false, tty: false });

  it('유니코드 기호', () => {
    expect(uni.boxTL).toBe('┌');
    expect(uni.ok).toBe('✓');
    expect(uni.fail).toBe('✗');
    expect(uni.radioOn).toBe('●');
    expect(uni.checkOn).toBe('☑');
  });

  it('ASCII 폴백 기호', () => {
    expect(ascii.boxTL).toBe('+');
    expect(ascii.boxH).toBe('-');
    expect(ascii.boxV).toBe('|');
    expect(ascii.ok).toBe('[ok]');
    expect(ascii.fail).toBe('[!!]');
    expect(ascii.radioOn).toBe('(*)');
    expect(ascii.checkOn).toBe('[x]');
  });

  it('이모지를 쓰지 않는다', () => {
    const allSymbols = Object.values({ ...uni, ...ascii }).join('');
    // 이모지가 주로 사는 범위(U+1F000 이상)가 기호에 없어야 한다.
    for (const ch of allSymbols) {
      expect(ch.codePointAt(0) ?? 0).toBeLessThan(0x1f000);
    }
  });
});

describe('box — 정렬 (한글이 섞여도 깨지지 않는다)', () => {
  const asciiSym = makeSymbols({ unicode: false, color: false, tty: false });
  const uniSym = makeSymbols({ unicode: true, color: true, tty: true });

  it('ASCII 모드: 한글이 섞인 모든 줄의 표시 폭이 동일하다', () => {
    const rendered = box(
      '검증 결과',
      ['test 통과', '한글 abc 섞인 줄', 'short', '조금 더 긴 한글 줄입니다'],
      asciiSym,
    );
    const rows = rendered.split('\n');
    const widths = rows.map(stringWidth);
    // 모든 줄의 표시 폭이 하나로 같아야 박스가 안 깨진다.
    expect(new Set(widths).size).toBe(1);
  });

  it('유니코드 모드도 동일하게 정렬된다', () => {
    const rendered = box('제목', ['한글 줄', 'x'], uniSym);
    const widths = rendered.split('\n').map(stringWidth);
    expect(new Set(widths).size).toBe(1);
  });

  it('제목이 빈 문자열이면 제목 행/구분선을 생략한다', () => {
    const rendered = box('', ['한 줄', '두 줄'], asciiSym);
    const rows = rendered.split('\n');
    // 상단 + 본문 2줄 + 하단 = 4줄 (제목/구분선 없음)
    expect(rows.length).toBe(4);
    const widths = rows.map(stringWidth);
    expect(new Set(widths).size).toBe(1);
  });

  it('가장 긴 줄이 한글이어도 폭 기준이 맞는다', () => {
    const longKo = '아주 긴 한글 제목 줄';
    const rendered = box(longKo, ['x'], asciiSym);
    const rows = rendered.split('\n');
    const widths = rows.map(stringWidth);
    expect(new Set(widths).size).toBe(1);
    // 내부 폭은 최소한 가장 긴 한글 줄의 폭 + 좌우 여백/테두리를 담아야 한다.
    expect(widths[0]).toBeGreaterThanOrEqual(stringWidth(longKo));
  });
});

describe('card — 색이 있어도 폭이 흔들리지 않는 사람용 출력', () => {
  it('ANSI 색상과 한글을 섞어도 모든 카드 줄의 표시 폭이 같다', () => {
    const c = { unicode: true, color: true, tty: true };
    const color = makeColors(true);
    const rendered = card('설정 완료', [color.green('통과'), '한글 설명'], c, 24);
    const widths = rendered.split('\n').map(visibleWidth);
    expect(new Set(widths).size).toBe(1);
  });
});

describe('makeColors — 색 미지원이면 통과', () => {
  it('enabled=true 면 ANSI 코드로 감싼다', () => {
    const c = makeColors(true);
    expect(c.red('x')).toBe('\x1b[31mx\x1b[0m');
    expect(c.bold('x')).toBe('\x1b[1mx\x1b[0m');
  });

  it('enabled=false 면 입력을 그대로 통과시킨다', () => {
    const c = makeColors(false);
    expect(c.red('x')).toBe('x');
    expect(c.green('한글')).toBe('한글');
  });
});

describe('computeRawModeCapable — 방향키 선택 능력 감지 (WI-Y AC-01)', () => {
  it('stdin 이 TTY 이고 setRawMode 가 있고 CI 가 아니면 true', () => {
    expect(computeRawModeCapable(true, true, false)).toBe(true);
  });

  it('CI 면 나머지와 무관하게 false', () => {
    expect(computeRawModeCapable(true, true, true)).toBe(false);
  });

  it('stdin 이 TTY 아니면(파이프) false', () => {
    expect(computeRawModeCapable(false, true, false)).toBe(false);
  });

  it('setRawMode 가 없으면(예: 일부 환경) false', () => {
    expect(computeRawModeCapable(true, false, false)).toBe(false);
  });
});
