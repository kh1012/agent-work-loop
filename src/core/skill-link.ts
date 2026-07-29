/**
 * 스킬 링크 도달성 확인 (awl doctor --links).
 *
 * npm-registry.ts·sync.ts 와 같은 규약을 따른다 — **절대 throw 하지 않는다.** 네트워크가
 * 없거나 느리면 "확인 못 함"으로 낮아질 뿐 doctor 가 죽지 않는다. doctor 는 아무것도
 * 고치지 않고 점검만 하는 명령이라, 점검 자체가 실패의 원인이 되면 안 된다.
 */

const FETCH_TIMEOUT_MS = 3000;

export type Reachability = 'reachable' | 'not-found' | 'unknown';

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * URL 하나의 도달성. HEAD 로 묻고, 막히면(405 등) GET 으로 한 번 더 본다 — GitHub 은
 * 경로에 따라 HEAD 를 안 받는 경우가 있다.
 */
export async function checkReachable(
  url: string,
  fetchImpl: FetchFn = fetch,
): Promise<Reachability> {
  for (const method of ['HEAD', 'GET'] as const) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetchImpl(url, { method, signal: controller.signal });
      if (res.status === 404 || res.status === 410) {
        return 'not-found';
      }
      if (res.ok) {
        return 'reachable';
      }
      // 405/403 등은 HEAD 를 안 받는 것일 수 있어 GET 으로 한 번 더 본다.
    } catch {
      return 'unknown'; // 타임아웃·오프라인·DNS 실패 — 링크가 죽었다는 증거가 아니다.
    } finally {
      clearTimeout(timer);
    }
  }
  return 'unknown';
}

/** 여러 URL 을 동시에 확인한다. 하나가 실패해도 나머지에 영향이 없다. */
export async function checkReachableAll(
  urls: readonly string[],
  fetchImpl: FetchFn = fetch,
): Promise<Map<string, Reachability>> {
  const results = await Promise.all(
    urls.map(async (u) => [u, await checkReachable(u, fetchImpl)] as const),
  );
  return new Map(results);
}
