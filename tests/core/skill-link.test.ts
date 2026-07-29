import { describe, expect, it, vi } from 'vitest';
import { checkReachable, checkReachableAll } from '../../src/core/skill-link.js';

const res = (status: number): Response =>
  ({ status, ok: status >= 200 && status < 300 }) as Response;

describe('checkReachable — 절대 throw 하지 않는다', () => {
  it('200 이면 reachable', async () => {
    expect(await checkReachable('https://x/y', async () => res(200))).toBe('reachable');
  });

  it('404 는 not-found — 링크가 실제로 죽은 것', async () => {
    expect(await checkReachable('https://x/y', async () => res(404))).toBe('not-found');
  });

  it('410 도 not-found', async () => {
    expect(await checkReachable('https://x/y', async () => res(410))).toBe('not-found');
  });

  it('HEAD 를 막으면(405) GET 으로 다시 본다 — GitHub 이 경로에 따라 그렇다', async () => {
    const calls: string[] = [];
    const r = await checkReachable('https://x/y', async (_u, init) => {
      calls.push(String(init?.method));
      return res(init?.method === 'HEAD' ? 405 : 200);
    });
    expect(calls).toEqual(['HEAD', 'GET']);
    expect(r).toBe('reachable');
  });

  it('네트워크가 죽으면 unknown — "링크가 죽었다"고 단정하지 않는다', async () => {
    const r = await checkReachable('https://x/y', async () => {
      throw new Error('offline');
    });
    expect(r).toBe('unknown');
  });

  it('두 방법 다 안 되면 unknown', async () => {
    expect(await checkReachable('https://x/y', async () => res(403))).toBe('unknown');
  });
});

describe('checkReachableAll — 하나가 실패해도 나머지에 영향이 없다', () => {
  it('섞인 결과를 각각 돌려준다', async () => {
    const m = await checkReachableAll(['https://a', 'https://b'], async (u) => {
      if (u === 'https://a') throw new Error('offline');
      return res(200);
    });
    expect(m.get('https://a')).toBe('unknown');
    expect(m.get('https://b')).toBe('reachable');
  });

  it('빈 목록도 크래시하지 않는다', async () => {
    expect((await checkReachableAll([], vi.fn())).size).toBe(0);
  });
});
