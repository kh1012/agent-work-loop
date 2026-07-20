import { describe, expect, it } from 'vitest';
import {
  card,
  charWidth,
  clipToWidth,
  computeCaps,
  computeRawModeCapable,
  makeColors,
  makeSymbols,
  makeTokens,
  padEndDisplay,
  signal,
  statusBadge,
  stringWidth,
  visibleWidth,
  wrapToWidth,
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

  it('FORCE_COLOR 는 파이프(!isTTY)여도 색을 켠다', () => {
    const c = computeCaps(env({ FORCE_COLOR: '1' }), 'darwin', false);
    expect(c.color).toBe(true);
  });

  it('FORCE_COLOR 가 있어도 NO_COLOR/CI 는 여전히 우선한다', () => {
    expect(computeCaps(env({ FORCE_COLOR: '1', NO_COLOR: '1' }), 'darwin', true).color).toBe(false);
    expect(computeCaps(env({ FORCE_COLOR: '1', CI: 'true' }), 'darwin', true).color).toBe(false);
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

  it('emoji-presentation-default(✅❌)는 2칸, VS16(선택자)은 폭0', () => {
    expect(charWidth('✅'.codePointAt(0) ?? 0)).toBe(2);
    expect(charWidth('❌'.codePointAt(0) ?? 0)).toBe(2);
    expect(charWidth(0xfe0f)).toBe(0);
  });

  it('기저문자+VS16 이모지는 2칸(문맥 판정) — 기저문자 단독은 그 표시폭 그대로', () => {
    // ⚠(26A0)·ℹ(2139)·▶(25B6)·™(2122) 은 단독이면 좁지만 VS16 이 붙으면 2칸으로 렌더된다.
    expect(stringWidth('⚠️')).toBe(2);
    expect(stringWidth('ℹ️')).toBe(2);
    expect(stringWidth('▶️')).toBe(2);
    expect(stringWidth('™️')).toBe(2);
  });

  it('텍스트-표현 기호와 awl 자체 글리프는 폭1로 센다 (0.6.1 과대계산 회귀 수정)', () => {
    // 적대검증: 0x2600–0x27bf 전체를 폭2로 넣어 이것들을 과대계산해 테두리가 어긋났다.
    expect(charWidth('❯'.codePointAt(0) ?? 0)).toBe(1); // U+276F 셀렉터 커서(select.ts)
    expect(charWidth('☑'.codePointAt(0) ?? 0)).toBe(1); // 체크박스 on
    expect(charWidth('☐'.codePointAt(0) ?? 0)).toBe(1); // 체크박스 off
    expect(charWidth('☀'.codePointAt(0) ?? 0)).toBe(1); // 텍스트-표현 기호
    expect(charWidth('★'.codePointAt(0) ?? 0)).toBe(1);
  });

  it('card 에 ❯ 를 섞어도 모든 줄의 표시폭이 동일하다 (테두리 정렬)', () => {
    const c = { unicode: true, color: false, tty: true };
    const rendered = card('제목', ['❯ 항목 하나', '평범한 줄'], c, 24);
    const widths = rendered.split('\n').map(visibleWidth);
    expect(new Set(widths).size).toBe(1);
  });
});

describe('makeSymbols — 유니코드/ASCII 폴백', () => {
  const uni = makeSymbols({ unicode: true, color: true, tty: true });
  const ascii = makeSymbols({ unicode: false, color: false, tty: false });

  it('유니코드 기호(둥근 모서리·트리 글리프)', () => {
    expect(uni.boxTL).toBe('╭');
    expect(uni.boxBR).toBe('╯');
    expect(uni.branch).toBe('├──');
    expect(uni.lastBranch).toBe('└──');
    expect(uni.radioOn).toBe('●');
    expect(uni.checkOn).toBe('☑');
  });

  it('ASCII 폴백 기호', () => {
    expect(ascii.boxTL).toBe('+');
    expect(ascii.boxH).toBe('-');
    expect(ascii.boxV).toBe('|');
    expect(ascii.branch).toBe('|--');
    expect(ascii.lastBranch).toBe('`--');
    expect(ascii.radioOn).toBe('(*)');
    expect(ascii.checkOn).toBe('[x]');
  });

  it('상태 신호는 유니코드 여부와 무관하게 텍스트 마커를 쓴다(이모지 폐지)', () => {
    expect(signal({ unicode: true, color: false, tty: true }, 'warn')).toBe('[!]');
    expect(signal({ unicode: false, color: false, tty: false }, 'warn')).toBe('[!]');
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

describe('wrapToWidth — 표시폭 기준 색 인지 워드랩', () => {
  it('폭 이내면 그대로 한 줄', () => {
    expect(wrapToWidth('짧은 줄', 40)).toEqual(['짧은 줄']);
  });

  it('공백 경계에서 접고 각 줄이 폭을 넘지 않는다', () => {
    const lines = wrapToWidth('aaaa bbbb cccc dddd', 9);
    expect(lines.length).toBeGreaterThan(1);
    for (const l of lines) {
      expect(visibleWidth(l)).toBeLessThanOrEqual(9);
    }
  });

  it('한 단어가 폭보다 길면 강제로 자른다(무한루프 없음)', () => {
    const lines = wrapToWidth('aaaaaaaaaaaaaaaaaa', 5);
    expect(lines.length).toBeGreaterThan(1);
    for (const l of lines) {
      expect(visibleWidth(l)).toBeLessThanOrEqual(5);
    }
  });

  it('색이 걸린 줄도 시퀀스를 끊지 않고 접는다(각 줄 폭 유지)', () => {
    const dim = makeColors(true).dim;
    const lines = wrapToWidth(dim('가나다라마바사아'), 8); // CJK 2칸 × 8 = 16폭
    expect(lines.length).toBe(2);
    for (const l of lines) {
      expect(visibleWidth(l)).toBeLessThanOrEqual(8);
      // 색이 열렸으면 리셋으로 닫혀 있어야 다음 출력이 오염되지 않는다.
      if (l.includes('\x1b[2m')) {
        expect(l.endsWith('\x1b[0m')).toBe(true);
      }
    }
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

describe('makeTokens — 역할 의미 토큰(cli-design-tokens AC-01)', () => {
  const cc = { unicode: true, color: true, tty: true };
  it('토큰이 외형 색으로 매핑된다(accent=cyan, info=blue, danger=red…)', () => {
    const t = makeTokens(cc);
    const col = makeColors(true);
    expect(t.accent('x')).toBe(col.cyan('x'));
    expect(t.info('x')).toBe(col.blue('x'));
    expect(t.danger('x')).toBe(col.red('x'));
    expect(t.emphasis('x')).toBe(col.bold('x'));
    expect(t.frame('x')).toBe(col.gray('x'));
  });
  it('info 와 accent 는 색이 다르다(cyan 충돌 분리)', () => {
    const t = makeTokens(cc);
    expect(t.info('x')).not.toBe(t.accent('x'));
  });
  it('color:false 면 통과', () => {
    expect(makeTokens({ unicode: true, color: false, tty: true }).accent('x')).toBe('x');
  });
});

describe('signal info — accent(cyan)와 색 분리(cli-design-tokens AC-01)', () => {
  const cc = { unicode: true, color: true, tty: true };
  it('info 는 blue(34), cyan(36) 아님', () => {
    const s = signal(cc, 'info');
    expect(s).toContain('\x1b[34m'); // blue
    expect(s).not.toContain('\x1b[36m'); // cyan 아님
  });
});

describe('padEndDisplay — 표시폭 기준 패딩(cli-design-tokens AC-04)', () => {
  it('한글(폭2)을 표시폭 기준으로 채운다 — 코드유닛 아님', () => {
    // '가'는 표시폭 2 → 5칸 채우면 공백 3개(표시폭 5). String.padEnd(5)면 공백 4개(표시폭 6)로 어긋남.
    expect(visibleWidth(padEndDisplay('가', 5))).toBe(5);
    expect(visibleWidth(padEndDisplay('워크아이템', 15))).toBe(15);
    expect(visibleWidth(padEndDisplay('WI-1', 15))).toBe(15);
  });
  it('한글 헤더와 ASCII 값이 같은 표시폭으로 맞는다(열 정렬)', () => {
    expect(visibleWidth(padEndDisplay('워크아이템', 20))).toBe(
      visibleWidth(padEndDisplay('WI-1', 20)),
    );
  });
  it('폭보다 길면 그대로(음수 패딩 없음)', () => {
    expect(padEndDisplay('toolong', 3)).toBe('toolong');
  });
});

describe('wrapToWidth — hanging indent(cli-design-tokens AC-03)', () => {
  it('hanging on: 넘친 줄이 선행 공백 들여쓰기를 유지한다', () => {
    const lines = wrapToWidth('  항목 아주아주 긴 설명 텍스트가 넘칩니다', 12, { hanging: true });
    expect(lines.length).toBeGreaterThan(1);
    expect(lines[0]?.startsWith('  ')).toBe(true);
    // 연속줄이 왼쪽에 붙지 않고 같은 2칸 들여쓰기를 유지한다
    for (const l of lines.slice(1)) {
      expect(l.startsWith('  ')).toBe(true);
    }
    for (const l of lines) {
      expect(visibleWidth(l)).toBeLessThanOrEqual(12);
    }
  });

  it('hanging on: 트리 마커(├──) 뒤로 연속줄을 정렬한다', () => {
    const lines = wrapToWidth('├── 트리 항목 아주 긴 텍스트 설명입니다', 14, { hanging: true });
    expect(lines.length).toBeGreaterThan(1);
    // '├── ' 는 표시폭 4 → 연속줄은 4칸 공백으로 시작(마커 자리 비움)
    for (const l of lines.slice(1)) {
      expect(l.startsWith('    ')).toBe(true);
      expect(l.trimStart().startsWith('├')).toBe(false); // 마커를 반복하지 않는다
    }
  });

  it('hanging off(기본): 연속줄에 들여쓰기를 넣지 않는다(하위호환)', () => {
    const plain = wrapToWidth('  항목 아주아주 긴 설명 텍스트가 넘칩니다', 12);
    // 기본 워드랩은 연속줄 앞 공백을 트림한다 — 둘째 줄이 공백 2개로 시작하지 않는다
    expect(plain[1]?.startsWith('  ')).toBe(false);
  });

  it('색이 걸린 선행 프리픽스는 안전하게 일반 워드랩으로 떨어진다(크래시 없음)', () => {
    const dim = makeColors(true).dim;
    const lines = wrapToWidth(`${dim('  ')}항목 아주아주 긴 텍스트 설명입니다`, 12, {
      hanging: true,
    });
    expect(lines.length).toBeGreaterThan(1);
    for (const l of lines) {
      expect(visibleWidth(l)).toBeLessThanOrEqual(12);
    }
  });
});

describe('signal error 폴백(cli-visual-consistency AC-01)', () => {
  it('유니코드·ASCII(CI/파이프) 모두 [x] — raw 이모지 없음', () => {
    expect(signal({ unicode: true, color: false, tty: true }, 'error')).toBe('[x]');
    expect(signal({ unicode: false, color: false, tty: false }, 'error')).toBe('[x]');
  });
});

describe('statusBadge — 파이프라인 상태 배지(pipeline-status-tracking AC-01)', () => {
  const CC = { unicode: true, color: true, tty: true };
  const ASCII = { unicode: false, color: false, tty: false };
  it('상태별 색 토큰 — complete=green, blocked=red, executing=cyan, reviewing=yellow, pending=gray', () => {
    expect(statusBadge(CC, 'complete')).toBe('\x1b[32m●\x1b[0m'); // green
    expect(statusBadge(CC, 'blocked')).toBe('\x1b[31m✗\x1b[0m'); // red(danger)
    expect(statusBadge(CC, 'executing')).toBe('\x1b[36m▶\x1b[0m'); // cyan(accent)
    expect(statusBadge(CC, 'reviewing')).toBe('\x1b[33m◐\x1b[0m'); // yellow(warning)
    expect(statusBadge(CC, 'pending')).toBe('\x1b[2m○\x1b[0m'); // dim(muted) — 대기는 subdued
  });
  it('ASCII 폴백 — 색·유니코드 없이 토큰만', () => {
    expect(statusBadge(ASCII, 'complete')).toBe('[ok]');
    expect(statusBadge(ASCII, 'blocked')).toBe('[x]');
    expect(statusBadge(ASCII, 'pending')).toBe('[.]');
    expect(statusBadge(ASCII, 'executing')).toBe('[>]');
    expect(statusBadge(ASCII, 'reviewing')).toBe('[~]');
  });
  it('유니코드 글리프는 표시폭 1(정렬 안정)', () => {
    for (const s of ['pending', 'executing', 'reviewing', 'complete', 'blocked'] as const) {
      expect(visibleWidth(statusBadge(CC, s))).toBe(1);
    }
  });
});

describe('clipToWidth — 색 보존 표시폭 절단(cli-visual-consistency AC-07)', () => {
  it('폭 이내면 그대로', () => {
    expect(clipToWidth('짧은', 10)).toBe('짧은');
  });
  it('넘치면 …로 자르고 표시폭을 넘지 않는다', () => {
    const out = clipToWidth('가나다라마바사', 8); // 각 2폭
    expect(visibleWidth(out)).toBeLessThanOrEqual(8);
    expect(out.endsWith('…')).toBe(true);
  });
  it('색(ANSI)을 벗기지 않고 보존하며, 잘린 끝에서 열린 색을 닫는다', () => {
    const bold = makeColors(true).bold;
    const out = clipToWidth(bold('가나다라마바사아자차'), 6);
    expect(out).toContain('\x1b[1m'); // bold 시작 보존
    expect(out.endsWith('\x1b[0m')).toBe(true); // 잘린 끝에서 색 닫힘(오염 방지)
    expect(visibleWidth(out)).toBeLessThanOrEqual(6);
  });
});
