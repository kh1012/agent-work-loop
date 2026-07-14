import { describe, expect, it } from 'vitest';
import { CommandNotFoundError, run, tokenize } from '../../src/core/runner.js';

// node 실행 파일 절대경로. 어느 플랫폼에서도 PATH 탐색 없이 실행된다.
const NODE = process.execPath;

describe('tokenize', () => {
  it('공백으로 나눈다', () => {
    expect(tokenize('vitest run')).toEqual(['vitest', 'run']);
  });

  it('따옴표 안의 공백은 보존한다', () => {
    expect(tokenize('echo "a b" c')).toEqual(['echo', 'a b', 'c']);
    expect(tokenize("echo 'x y'")).toEqual(['echo', 'x y']);
  });

  it('빈 문자열은 빈 배열', () => {
    expect(tokenize('   ')).toEqual([]);
  });
});

describe('run — 성공/실패', () => {
  it('성공 시 exitCode 0 과 stdout 을 반환한다', async () => {
    const r = await run({
      cmd: NODE,
      args: ['-e', 'process.stdout.write("hello")'],
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe('hello');
    expect(r.stderr).toBe('');
    expect(r.timedOut).toBe(false);
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('실패 시 exitCode 를 그대로 주고 stderr 를 캡처한다', async () => {
    const r = await run({
      cmd: NODE,
      args: ['-e', 'process.stderr.write("boom"); process.exit(3)'],
    });
    expect(r.exitCode).toBe(3);
    expect(r.stderr).toBe('boom');
  });
});

describe('run — 존재하지 않는 명령', () => {
  it('ENOENT 는 CommandNotFoundError 로 구분된다', async () => {
    await expect(run({ cmd: 'awl_definitely_no_such_command_zzz' })).rejects.toBeInstanceOf(
      CommandNotFoundError,
    );
  });

  it('에러에 명령 이름이 담긴다', async () => {
    try {
      await run({ cmd: 'awl_definitely_no_such_command_zzz' });
      throw new Error('여기 오면 안 됨');
    } catch (e) {
      expect(e).toBeInstanceOf(CommandNotFoundError);
      expect((e as CommandNotFoundError).command).toBe('awl_definitely_no_such_command_zzz');
    }
  });
});

describe('run — 타임아웃', () => {
  it('타임아웃되면 timedOut=true 로 반환한다', async () => {
    const r = await run({
      cmd: NODE,
      args: ['-e', 'setTimeout(() => {}, 10000)'],
      timeoutMs: 250,
    });
    expect(r.timedOut).toBe(true);
    // SIGTERM 으로 죽으면 exitCode 는 0 이 아니다(보통 null).
    expect(r.exitCode).not.toBe(0);
  });
});

describe('run — env 주입', () => {
  it('spec.env 가 자식 프로세스에 실제로 전달된다', async () => {
    const r = await run({
      cmd: NODE,
      args: ['-e', 'process.stdout.write(process.env.AWL_TEST_VAR || "MISSING")'],
      env: { AWL_TEST_VAR: 'injected-value' },
    });
    expect(r.stdout).toBe('injected-value');
  });

  it('명령 문자열에 env 를 넣지 않아도 된다 (분리 주입)', async () => {
    // "NODE_ENV=test ..." 같은 인라인 문법 없이 env 만으로 전달됨을 확인.
    const r = await run({
      cmd: NODE,
      args: ['-e', 'process.stdout.write(process.env.NODE_ENV || "none")'],
      env: { NODE_ENV: 'test' },
    });
    expect(r.stdout).toBe('test');
  });
});

describe('run — AbortSignal 취소', () => {
  it('abort 하면 예외를 던진다', async () => {
    const controller = new AbortController();
    const promise = run({
      cmd: NODE,
      args: ['-e', 'setTimeout(() => {}, 10000)'],
      signal: controller.signal,
    });
    controller.abort();
    await expect(promise).rejects.toBeDefined();
  });
});
