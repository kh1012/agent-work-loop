import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fetchLatestVersion,
  getLatestVersionCached,
  readCachedLatestVersion,
} from '../../src/core/npm-registry.js';

const origHome = process.env.AWL_HOME;

afterEach(() => {
  if (origHome === undefined) {
    delete process.env.AWL_HOME;
  } else {
    process.env.AWL_HOME = origHome;
  }
});

function tmpHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'awl-npm-'));
  process.env.AWL_HOME = home;
  return home;
}

function okFetch(version: string): typeof fetch {
  return vi.fn(async () => {
    return new Response(JSON.stringify({ version }), { status: 200 });
  }) as unknown as typeof fetch;
}

function failFetch(): typeof fetch {
  return vi.fn(async () => {
    throw new Error('network unreachable');
  }) as unknown as typeof fetch;
}

function timeoutFetch(): typeof fetch {
  // AbortController.abort() 가 fetch 에 전달한 signal 을 트리거하면 그 자체가
  // reject 사유가 된다 — 실제 타임아웃처럼 signal 이 abort 되면 즉시 reject.
  return vi.fn((_url: string, init?: { signal?: AbortSignal }) => {
    return new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('The operation was aborted')));
    });
  }) as unknown as typeof fetch;
}

describe('fetchLatestVersion — npm 레지스트리 조회 (AC-01)', () => {
  it('성공하면 최신 버전 문자열을 돌려준다', async () => {
    const v = await fetchLatestVersion('agent-work-loop', okFetch('9.9.9'));
    expect(v).toBe('9.9.9');
  });

  it('네트워크 실패(reject)면 null 을 돌려준다 — throw 하지 않는다', async () => {
    await expect(fetchLatestVersion('agent-work-loop', failFetch())).resolves.toBeNull();
  });

  it('타임아웃(2초 이내 abort)이면 null 을 돌려준다 — throw 하지 않는다', async () => {
    const v = await fetchLatestVersion('agent-work-loop', timeoutFetch());
    expect(v).toBeNull();
  });

  it('레지스트리가 200이 아니면(HTTP 에러) null 을 돌려준다', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('not found', { status: 404 }),
    ) as unknown as typeof fetch;
    await expect(fetchLatestVersion('agent-work-loop', fetchImpl)).resolves.toBeNull();
  });

  it('응답 바디에 version 필드가 없으면 null 을 돌려준다(크래시 없음)', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ notVersion: '1.0.0' }), { status: 200 }),
    ) as unknown as typeof fetch;
    await expect(fetchLatestVersion('agent-work-loop', fetchImpl)).resolves.toBeNull();
  });

  it('타임아웃 신호는 2초 이내로 걸린다(AbortController 사용)', async () => {
    const fetchImpl = vi.fn((_url: string, init?: { signal?: AbortSignal }) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    }) as unknown as typeof fetch;
    const start = Date.now();
    await fetchLatestVersion('agent-work-loop', fetchImpl);
    expect(Date.now() - start).toBeLessThan(2500);
  });
});

describe('getLatestVersionCached — TTL 캐시 (AC-01)', () => {
  it('캐시가 없으면 네트워크를 호출하고 결과를 캐시에 저장한다', async () => {
    tmpHome();
    const fetchImpl = okFetch('1.2.3');
    const v = await getLatestVersionCached('agent-work-loop', { fetchImpl });
    expect(v).toBe('1.2.3');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('TTL(24시간) 안에 재호출하면 캐시만 읽고 네트워크를 다시 안 친다', async () => {
    const home = tmpHome();
    const fetchImpl = okFetch('1.2.3');
    await getLatestVersionCached('agent-work-loop', { fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const second = okFetch('9.9.9'); // 호출되면 안 되므로 값이 달라도 무시돼야 함
    const v = await getLatestVersionCached('agent-work-loop', { fetchImpl: second });
    expect(v).toBe('1.2.3'); // 캐시된 값 그대로
    expect(second).not.toHaveBeenCalled();

    // 캐시 파일이 실제로 ~/.awl 전역(AWL_HOME)에 저장됐는지 확인
    const cachePath = path.join(home, 'npm-latest-cache.json');
    expect(fs.existsSync(cachePath)).toBe(true);
    const raw = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    expect(raw.latestVersion).toBe('1.2.3');
    expect(typeof raw.checkedAt).toBe('string');
  });

  it('TTL 이 지나면 다시 네트워크를 호출한다', async () => {
    tmpHome();
    const first = okFetch('1.0.0');
    await getLatestVersionCached('agent-work-loop', { fetchImpl: first, ttlMs: 1000 });
    expect(first).toHaveBeenCalledTimes(1);

    const second = okFetch('2.0.0');
    const later = () => Date.now() + 2000; // TTL(1000ms) 지난 시점
    const v = await getLatestVersionCached('agent-work-loop', {
      fetchImpl: second,
      ttlMs: 1000,
      now: later,
    });
    expect(second).toHaveBeenCalledTimes(1);
    expect(v).toBe('2.0.0');
  });

  it('오프라인(fetch mock 실패)이어도 null 을 돌려주고 크래시하지 않는다', async () => {
    tmpHome();
    await expect(
      getLatestVersionCached('agent-work-loop', { fetchImpl: failFetch() }),
    ).resolves.toBeNull();
  });

  it('오프라인 결과도 캐시에 남아 TTL 안에는 재호출 없이 null 을 돌려준다', async () => {
    tmpHome();
    const first = failFetch();
    await getLatestVersionCached('agent-work-loop', { fetchImpl: first });
    expect(first).toHaveBeenCalledTimes(1);

    const second = okFetch('3.0.0');
    const v = await getLatestVersionCached('agent-work-loop', { fetchImpl: second });
    expect(v).toBeNull();
    expect(second).not.toHaveBeenCalled();
  });

  it('캐시 파일이 깨져있어도(JSON 아님) 크래시 없이 새로 조회한다', async () => {
    const home = tmpHome();
    fs.writeFileSync(path.join(home, 'npm-latest-cache.json'), 'not json{{{');
    const fetchImpl = okFetch('5.5.5');
    const v = await getLatestVersionCached('agent-work-loop', { fetchImpl });
    expect(v).toBe('5.5.5');
  });

  it('캐시 쓰기는 원자적이다(pid 임시파일+rename) — 쓰기 후 .tmp 잔재가 남지 않는다 (AC-06, 리뷰 rev_d604dc2986b58b8a6c #1)', async () => {
    const home = tmpHome();
    await getLatestVersionCached('agent-work-loop', { fetchImpl: okFetch('6.6.6') });
    const leftoverTmp = fs.readdirSync(home).filter((f) => f.includes('.tmp'));
    expect(leftoverTmp).toEqual([]);
    // 최종 파일은 정상 캐시 파일 하나뿐.
    expect(fs.readdirSync(home)).toEqual(['npm-latest-cache.json']);
  });
});

describe('readCachedLatestVersion — 동기 캐시 읽기 (AC-03 이 쓰는 경로, 네트워크 없음)', () => {
  it('캐시가 없으면 null(크래시 없음)', () => {
    tmpHome();
    expect(readCachedLatestVersion()).toBeNull();
  });

  it('캐시가 있으면 latestVersion 을 동기로 돌려준다', async () => {
    tmpHome();
    await getLatestVersionCached('agent-work-loop', { fetchImpl: okFetch('4.4.4') });
    expect(readCachedLatestVersion()).toBe('4.4.4');
  });

  it('캐시 파일이 깨져있어도 크래시 없이 null', () => {
    const home = tmpHome();
    fs.writeFileSync(path.join(home, 'npm-latest-cache.json'), '{{{broken');
    expect(readCachedLatestVersion()).toBeNull();
  });
});
