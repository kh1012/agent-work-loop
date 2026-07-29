import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  acquireVerifyLockBlocking,
  releaseVerifyLock,
  tryAcquireVerifyLock,
  verifyLockFile,
} from '../../src/core/verify-lock.js';

const origHome = process.env.AWL_HOME;

afterEach(() => {
  if (origHome === undefined) {
    delete process.env.AWL_HOME;
  } else {
    process.env.AWL_HOME = origHome;
  }
});

function tmpHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'awl-verify-lock-'));
  process.env.AWL_HOME = home;
  return home;
}

describe('tryAcquireVerifyLock / releaseVerifyLock — 원자적 배타 락(state.ts 패턴 재사용)', () => {
  it('처음 시도하면 잡힌다', () => {
    tmpHome();
    expect(tryAcquireVerifyLock('e2e', 'tok-1')).toBe(true);
    expect(fs.existsSync(verifyLockFile('e2e'))).toBe(true);
  });

  it('이미 살아있는 프로세스(자기 자신)가 잡고 있으면 두 번째 시도는 실패한다', () => {
    tmpHome();
    expect(tryAcquireVerifyLock('e2e', 'tok-1')).toBe(true);
    // 두 번째 acquire — 같은 프로세스(자기 pid)라 isProcessAlive 가 true, stale 아님.
    expect(tryAcquireVerifyLock('e2e', 'tok-2')).toBe(false);
  });

  it('release 후에는 다시 잡을 수 있다', () => {
    tmpHome();
    tryAcquireVerifyLock('e2e', 'tok-1');
    releaseVerifyLock('e2e', 'tok-1');
    expect(fs.existsSync(verifyLockFile('e2e'))).toBe(false);
    expect(tryAcquireVerifyLock('e2e', 'tok-2')).toBe(true);
  });

  it('내 토큰이 아니면 release 가 아무것도 안 지운다(소유권 검증)', () => {
    tmpHome();
    tryAcquireVerifyLock('e2e', 'tok-owner');
    releaseVerifyLock('e2e', 'tok-someone-else');
    expect(fs.existsSync(verifyLockFile('e2e'))).toBe(true);
  });

  it('죽은 프로세스(pid)가 남긴 락은 즉시 stale 로 보고 훔친다(age 와 무관)', () => {
    const home = tmpHome();
    const p = verifyLockFile('e2e');
    fs.mkdirSync(path.dirname(p), { recursive: true });
    // 존재할 리 없는 매우 큰 pid — isProcessAlive 가 false 를 돌려야 한다.
    fs.writeFileSync(
      p,
      JSON.stringify({ token: 'dead-owner', pid: 999999, at: new Date().toISOString() }),
    );
    expect(tryAcquireVerifyLock('e2e', 'tok-new')).toBe(true);
    const content = JSON.parse(fs.readFileSync(verifyLockFile('e2e'), 'utf8'));
    expect(content.token).toBe('tok-new');
    void home;
  });

  it('이름마다 독립된 락 파일이다(다른 검증끼리는 안 막는다)', () => {
    tmpHome();
    expect(tryAcquireVerifyLock('e2e', 'tok-1')).toBe(true);
    expect(tryAcquireVerifyLock('a11y', 'tok-2')).toBe(true);
  });

  it('이름을 파일시스템에 안전한 문자로만 정규화한다', () => {
    tmpHome();
    tryAcquireVerifyLock('my e2e/suite', 'tok-1');
    expect(fs.existsSync(verifyLockFile('my e2e/suite'))).toBe(true);
    expect(path.basename(verifyLockFile('my e2e/suite'))).not.toContain('/');
  });
});

describe('acquireVerifyLockBlocking — 폴링 대기', () => {
  it('바로 안 잡히면 짧게 기다렸다가 풀리면 잡는다', async () => {
    tmpHome();
    tryAcquireVerifyLock('e2e', 'holder');
    const waiterPromise = acquireVerifyLockBlocking('e2e', 'waiter', {
      pollMs: 20,
      timeoutMs: 2000,
    });
    await new Promise((r) => setTimeout(r, 60));
    releaseVerifyLock('e2e', 'holder');
    expect(await waiterPromise).toBe(true);
  });

  it('상한 안에 안 풀리면 false(타임아웃)', async () => {
    tmpHome();
    tryAcquireVerifyLock('e2e', 'holder');
    const acquired = await acquireVerifyLockBlocking('e2e', 'waiter', {
      pollMs: 20,
      timeoutMs: 100,
    });
    expect(acquired).toBe(false);
  });
});
