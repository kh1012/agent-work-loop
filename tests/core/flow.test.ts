import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/core/select.js', () => ({
  runInteractiveSelect: vi.fn(),
}));

import { activeSelect, closeFlow, openFlow, selectStep, step } from '../../src/core/flow.js';
import { runInteractiveSelect } from '../../src/core/select.js';

const ASCII = { unicode: false, color: false, tty: false };

function mockStdout(): { write: ReturnType<typeof vi.fn> } {
  const write = vi.fn().mockReturnValue(true);
  vi.spyOn(process.stdout, 'write').mockImplementation(write as typeof process.stdout.write);
  return { write };
}

function writtenText(write: ReturnType<typeof vi.fn>): string {
  return write.mock.calls.map((c) => c[0]).join('');
}

describe('flow — clack 스타일 스파인 세션 (I/O 계층)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('openFlow: 세션 시작(┌) 한 줄을 찍고 세션 상태를 돌려준다', () => {
    const { write } = mockStdout();
    const session = openFlow('awl init', ASCII);
    expect(session.c).toBe(ASCII);
    expect(writtenText(write)).toBe('+  awl init\n');
  });

  it('step: 연결줄(│)을 먼저 찍고 정보 스텝(◇) 한 줄을 커밋한다', () => {
    const { write } = mockStdout();
    step({ c: ASCII }, '주 언어: TypeScript');
    expect(writtenText(write)).toBe('|\no  주 언어: TypeScript\n');
  });

  it('selectStep: 연결줄을 먼저 찍고 "사용자가 고름" 한 줄(●)을 커밋한다', () => {
    const { write } = mockStdout();
    selectStep({ c: ASCII }, '설치: 모두 설치');
    expect(writtenText(write)).toBe('|\n*  설치: 모두 설치\n');
  });

  it('closeFlow: 세션 종료(└) 한 줄만 찍는다', () => {
    const { write } = mockStdout();
    closeFlow({ c: ASCII });
    expect(writtenText(write)).toBe('+\n');
  });

  it('activeSelect: 연결줄을 먼저 찍고 runInteractiveSelect 에 그대로 위임한다', async () => {
    const { write } = mockStdout();
    vi.mocked(runInteractiveSelect).mockResolvedValue({ index: 1, checked: [1] });

    const result = await activeSelect({ c: ASCII }, ['a', 'b'], 0, true, [], { title: '스킬' });

    expect(runInteractiveSelect).toHaveBeenCalledWith(['a', 'b'], 0, true, ASCII, [], {
      title: '스킬',
    });
    expect(result).toEqual({ index: 1, checked: [1] });
    // 연결줄을 먼저 찍고(위임 전), 끝난 뒤 그 연결줄 한 줄을 마저 지운다(1줄 위로+지우기).
    const calls = write.mock.calls.map((c) => c[0]);
    expect(calls[0]).toBe('|\n');
    expect(calls[calls.length - 1]).toBe('\x1b[1A\x1b[0J');
  });

  it('activeSelect: 취소(null)도 그대로 반환한다', async () => {
    mockStdout();
    vi.mocked(runInteractiveSelect).mockResolvedValue(null);
    const result = await activeSelect({ c: ASCII }, ['a'], 0, false);
    expect(result).toBeNull();
  });

  it('한 세션의 전체 흐름을 이어붙이면 ┌...└ 사이가 연결줄로 이어진다', () => {
    const { write } = mockStdout();
    const session = openFlow('설정 수정', ASCII);
    step(session, '검증 명령어 설정됨');
    selectStep(session, '주 언어: TypeScript');
    closeFlow(session);
    expect(writtenText(write)).toBe(
      ['+  설정 수정', '|', 'o  검증 명령어 설정됨', '|', '*  주 언어: TypeScript', '+', ''].join(
        '\n',
      ),
    );
  });
});
