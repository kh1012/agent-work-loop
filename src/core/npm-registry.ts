import fs from 'node:fs';
import path from 'node:path';
import { npmVersionCachePath } from './paths.js';

/**
 * npm 레지스트리 최신 배포 버전 조회 (WI-npm-update-notice AC-01).
 *
 * 네트워크 I/O 를 이 모듈 하나에 격리한다 — 다른 곳(version-check, --version)은
 * 이 모듈이 돌려주는 값(string | null)만 쓰고 fetch 를 직접 하지 않는다.
 *
 * 규칙:
 * - 타임아웃 2초(AbortController). 느린 네트워크가 CLI 를 눈에 띄게 지연시키지 않는다.
 * - 실패(오프라인·타임아웃·비정상 응답·파싱 불가)는 전부 null. 절대 throw 하지 않는다.
 * - 조회 결과(성공/실패 모두)를 전역 캐시(~/.awl/npm-latest-cache.json)에 남기고,
 *   TTL(기본 24시간) 안에는 캐시만 읽는다 — 매 실행마다 레지스트리를 치지 않는다.
 */

const REGISTRY_URL = 'https://registry.npmjs.org';
const FETCH_TIMEOUT_MS = 2000;
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

export interface NpmVersionCache {
  checkedAt: string;
  latestVersion: string | null;
}

type FetchFn = typeof fetch;

/** 레지스트리에 실제로 접속해 최신 버전을 조회한다(I/O). 실패하면 항상 null. */
export async function fetchLatestVersion(
  packageName: string,
  fetchImpl: FetchFn = fetch,
): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetchImpl(`${REGISTRY_URL}/${packageName}/latest`, {
      signal: controller.signal,
    });
    if (!res.ok) {
      return null;
    }
    const body = (await res.json()) as unknown;
    if (body && typeof body === 'object') {
      const v = (body as Record<string, unknown>).version;
      if (typeof v === 'string') {
        return v;
      }
    }
    return null;
  } catch {
    // 오프라인·타임아웃(abort)·JSON 파싱 실패 — 전부 조용히 무시.
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function readCache(): NpmVersionCache | null {
  try {
    const raw = JSON.parse(fs.readFileSync(npmVersionCachePath(), 'utf8')) as unknown;
    if (raw && typeof raw === 'object') {
      const checkedAt = (raw as Record<string, unknown>).checkedAt;
      const latestVersion = (raw as Record<string, unknown>).latestVersion;
      if (
        typeof checkedAt === 'string' &&
        (typeof latestVersion === 'string' || latestVersion === null)
      ) {
        return { checkedAt, latestVersion };
      }
    }
  } catch {
    // 캐시 없음 또는 깨짐 — 없는 것으로 취급.
  }
  return null;
}

function writeCache(cache: NpmVersionCache): void {
  try {
    fs.mkdirSync(path.dirname(npmVersionCachePath()), { recursive: true });
    fs.writeFileSync(npmVersionCachePath(), JSON.stringify(cache));
  } catch {
    // 캐시 쓰기 실패는 무시한다 — 다음 실행이 다시 시도한다.
  }
}

/**
 * TTL 안이면 캐시된 값을 네트워크 없이 돌려준다. TTL 이 지났거나 캐시가 없으면
 * 조회하고, 성공/실패 결과를 그대로 캐시에 남긴다(실패도 캐시해야 오프라인일 때
 * 매 실행마다 2초씩 재시도하지 않는다).
 */
export async function getLatestVersionCached(
  packageName: string,
  opts: { fetchImpl?: FetchFn; now?: () => number; ttlMs?: number } = {},
): Promise<string | null> {
  const now = opts.now ?? (() => Date.now());
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  const cached = readCache();
  if (cached && now() - new Date(cached.checkedAt).getTime() < ttlMs) {
    return cached.latestVersion;
  }
  const latestVersion = await fetchLatestVersion(packageName, opts.fetchImpl ?? fetch);
  writeCache({ checkedAt: new Date(now()).toISOString(), latestVersion });
  return latestVersion;
}

/**
 * 캐시를 동기로만 읽는다 — 네트워크를 절대 치지 않는다(program.ts 의 versionString()
 * 처럼 모든 명령 실행마다 도는 경로에서 지연 없이 쓰기 위함). 캐시가 없거나
 * 깨졌으면 null.
 */
export function readCachedLatestVersion(): string | null {
  return readCache()?.latestVersion ?? null;
}
