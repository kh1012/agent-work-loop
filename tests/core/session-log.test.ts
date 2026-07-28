import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mangleProjectPath, readSessionUsageEvents, sessionLogDir } from '../../src/core/session-log.js';

describe('mangleProjectPath — 순수 함수', () => {
  it('슬래시를 전부 대시로 바꾼다', () => {
    expect(mangleProjectPath('/Users/kh1012/MIDAS/Research/agent-work-loop')).toBe(
      '-Users-kh1012-MIDAS-Research-agent-work-loop',
    );
  });

  it('슬래시가 없으면 그대로다', () => {
    expect(mangleProjectPath('nope')).toBe('nope');
  });
});

describe('readSessionUsageEvents', () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'awl-session-log-test-'));
    vi.spyOn(os, 'homedir').mockReturnValue(tmpHome);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  function projectDir(): string {
    return path.join(tmpHome, 'project');
  }

  function writeSessionFile(name: string, lines: string[]): void {
    const dir = sessionLogDir(projectDir());
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, name), lines.join('\n'));
  }

  it('디렉토리가 없으면 크래시 없이 빈 배열을 준다', () => {
    expect(readSessionUsageEvents(projectDir())).toEqual([]);
  });

  it('assistant+usage 줄만 뽑고, user/summary 타입은 거른다', () => {
    const assistantLine = JSON.stringify({
      type: 'assistant',
      timestamp: '2026-07-17T04:23:40.008Z',
      message: {
        usage: {
          input_tokens: 13978,
          cache_creation_input_tokens: 32673,
          cache_read_input_tokens: 0,
          output_tokens: 346,
          server_tool_use: { ignored: true },
        },
      },
    });
    const userLine = JSON.stringify({
      type: 'user',
      timestamp: '2026-07-17T04:23:41.000Z',
      message: { content: 'hi' },
    });
    const summaryLine = JSON.stringify({ type: 'summary', summary: 'blah' });
    const assistantNoUsageLine = JSON.stringify({
      type: 'assistant',
      timestamp: '2026-07-17T04:23:42.000Z',
      message: { text: 'no usage field here' },
    });

    writeSessionFile('sess1.jsonl', [assistantLine, userLine, summaryLine, assistantNoUsageLine]);

    const events = readSessionUsageEvents(projectDir());
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      timestamp: '2026-07-17T04:23:40.008Z',
      inputTokens: 13978,
      outputTokens: 346,
      cacheCreationTokens: 32673,
      cacheReadTokens: 0,
    });
  });

  it('손상된 줄·비-JSON 줄은 그 줄만 건너뛰고 나머지는 계속 읽는다', () => {
    const goodLine = JSON.stringify({
      type: 'assistant',
      timestamp: '2026-07-17T04:00:00.000Z',
      message: { usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
    });
    writeSessionFile('sess2.jsonl', ['{not valid json', goodLine, '', '   ']);

    const events = readSessionUsageEvents(projectDir());
    expect(events).toHaveLength(1);
    expect(events[0]?.inputTokens).toBe(10);
  });

  it('읽을 수 없는 파일은 건너뛰고 나머지 파일은 계속 읽는다', () => {
    const dir = sessionLogDir(projectDir());
    fs.mkdirSync(dir, { recursive: true });
    // 디렉토리를 .jsonl 로 만들어 readFileSync 가 실패하게 만든다(EISDIR).
    fs.mkdirSync(path.join(dir, 'broken.jsonl'));
    const goodLine = JSON.stringify({
      type: 'assistant',
      timestamp: '2026-07-17T05:00:00.000Z',
      message: { usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
    });
    fs.writeFileSync(path.join(dir, 'ok.jsonl'), goodLine);

    const events = readSessionUsageEvents(projectDir());
    expect(events).toHaveLength(1);
    expect(events[0]?.timestamp).toBe('2026-07-17T05:00:00.000Z');
  });

  it('비-숫자 usage 필드는 방어적으로 0으로 취급한다', () => {
    const line = JSON.stringify({
      type: 'assistant',
      timestamp: '2026-07-17T06:00:00.000Z',
      message: { usage: { input_tokens: 'oops', output_tokens: null, cache_creation_input_tokens: 5, cache_read_input_tokens: undefined } },
    });
    writeSessionFile('sess3.jsonl', [line]);

    const events = readSessionUsageEvents(projectDir());
    expect(events).toEqual([
      {
        timestamp: '2026-07-17T06:00:00.000Z',
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 5,
        cacheReadTokens: 0,
      },
    ]);
  });

  it('여러 파일에서 모은 이벤트를 시각순으로 정렬해 돌려준다', () => {
    const later = JSON.stringify({
      type: 'assistant',
      timestamp: '2026-07-17T09:00:00.000Z',
      message: { usage: { input_tokens: 2, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
    });
    const earlier = JSON.stringify({
      type: 'assistant',
      timestamp: '2026-07-17T08:00:00.000Z',
      message: { usage: { input_tokens: 1, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
    });
    writeSessionFile('b.jsonl', [later]);
    writeSessionFile('a.jsonl', [earlier]);

    const events = readSessionUsageEvents(projectDir());
    expect(events.map((e) => e.timestamp)).toEqual([
      '2026-07-17T08:00:00.000Z',
      '2026-07-17T09:00:00.000Z',
    ]);
  });
});
