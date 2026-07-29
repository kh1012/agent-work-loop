import fs from 'node:fs';
import path from 'node:path';
import { installationRoot } from './paths.js';
import { isProcessAlive } from './port-lease.js';

/**
 * 검증 배타(exclusive) 락 — 여러 레인이 동시에 같은 이름의 exclusive 검증을 돌리면
 * 직렬화한다(ADK stage 5). `state.ts`의 `acquireStateLock`과 완전히 같은 원자적 패턴
 * (tmp에 완전한 내용을 먼저 쓰고 `linkSync`로 배타 연결 — `openSync('wx')`의 "빈 파일
 * 창"을 없앤 패턴, 과거 stress 테스트가 그 창의 double-acquire 버그를 잡았다)을
 * 재사용한다 — 이미 검증된 패턴을 새로 짜지 않는다.
 *
 * state.lock과 다른 점: 이건 프로젝트가 아니라 **검증 이름**으로 전역(`~/.awl/leases/
 * verify/<name>.lock`) 범위다 — 서로 다른 레인(다른 워크트리)이 "같은 이름"의 검증을
 * 동시에 돌리는 걸 막아야 하므로 프로젝트 경계를 넘어야 한다. staleness 판정도
 * age-only가 아니라 보유 PID 가 살아있는지(`isProcessAlive`, port-lease.ts 재사용)를
 * 먼저 본다 — 검증은 수 분씩 걸릴 수 있어(최대 600초, verify.ts) 순수 age 임계값만으론
 * 정상 실행 중인 락을 훔칠 위험이 크다.
 */

/** age 판정 폴백 임계값 — PID 를 못 읽을 때만 쓴다. 검증은 오래 걸릴 수 있어 넉넉히 잡는다. */
const VERIFY_LOCK_STALE_MS = 15 * 60 * 1000;

function sanitizeLockName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_.-]/g, '_');
}

export function verifyLockFile(name: string): string {
  return path.join(installationRoot(), 'leases', 'verify', `${sanitizeLockName(name)}.lock`);
}

interface LockContent {
  token: string;
  pid: number;
  at: string;
}

function readLockContent(p: string): LockContent | null {
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown>;
    if (
      typeof raw.token === 'string' &&
      typeof raw.pid === 'number' &&
      typeof raw.at === 'string'
    ) {
      return { token: raw.token, pid: raw.pid, at: raw.at };
    }
    return null;
  } catch {
    return null;
  }
}

function lockAgeMs(p: string, content: LockContent | null): number {
  if (content) {
    const at = Date.parse(content.at);
    if (!Number.isNaN(at)) {
      return Date.now() - at;
    }
  }
  try {
    return Date.now() - fs.statSync(p).mtimeMs;
  } catch {
    return 0; // 이미 없으면 '방금'으로 취급(stale 아님 → steal 안 함).
  }
}

/** 락이 stale(죽은 프로세스가 방치했거나 오래됐다)인지 본다. */
function isStale(p: string): boolean {
  const content = readLockContent(p);
  if (content && !isProcessAlive(content.pid)) {
    return true; // 보유 프로세스가 죽었다 — age 와 무관하게 즉시 stale.
  }
  return lockAgeMs(p, content) > VERIFY_LOCK_STALE_MS;
}

/** 락을 한 번 시도한다(non-blocking). 이미 잡혀 있고 stale 이 아니면 false. */
export function tryAcquireVerifyLock(name: string, token: string): boolean {
  const p = verifyLockFile(name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tryCreate = (): boolean => {
    const tmp = `${p}.${process.pid}.acq`;
    try {
      fs.writeFileSync(
        tmp,
        JSON.stringify({ token, pid: process.pid, at: new Date().toISOString() }),
      );
      fs.linkSync(tmp, p);
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') {
        return false;
      }
      throw e;
    } finally {
      try {
        fs.unlinkSync(tmp);
      } catch {
        // temp 정리 실패는 무시.
      }
    }
  };
  if (tryCreate()) {
    return true;
  }
  if (isStale(p)) {
    // rename 으로 먼저 "차지"한다 — 동시에 여러 프로세스가 steal 을 시도해도 rename 은
    // 하나만 성공한다(state.ts 와 동일한 TOCTOU 회피).
    const claimed = `${p}.${process.pid}.steal`;
    try {
      fs.renameSync(p, claimed);
    } catch {
      return false;
    }
    try {
      fs.unlinkSync(claimed);
    } catch {
      // 이미 없으면 무시.
    }
    return tryCreate();
  }
  return false;
}

export function releaseVerifyLock(name: string, token?: string): void {
  const p = verifyLockFile(name);
  if (token !== undefined) {
    const held = readLockContent(p);
    if (held !== null && held.token !== token) {
      return; // 내 락이 아니다 — 건드리지 않는다(steal 당한 뒤 후임 락을 지우는 사고 방지).
    }
  }
  try {
    fs.unlinkSync(p);
  } catch {
    // 이미 없으면 무시.
  }
}

/**
 * 락을 얻을 때까지 짧게 폴링하며 기다린다("한 번에 하나만 돌아야 한다"는 즉시 거부가
 * 아니라 직렬화다). 상한을 넘으면 false — 호출부가 명확한 타임아웃 에러로 알린다.
 */
export async function acquireVerifyLockBlocking(
  name: string,
  token: string,
  opts: { pollMs?: number; timeoutMs?: number } = {},
): Promise<boolean> {
  const pollMs = opts.pollMs ?? 500;
  const timeoutMs = opts.timeoutMs ?? 10 * 60 * 1000; // 검증 자체가 최대 10분(verify.ts) 걸릴 수 있다.
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (tryAcquireVerifyLock(name, token)) {
      return true;
    }
    if (Date.now() >= deadline) {
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}
