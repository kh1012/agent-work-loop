import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BACKOFF_SCHEDULE_MIN,
  GIVE_UP_MS,
  buildFeedbackEnvelope,
  buildRecordEnvelope,
  buildSpecEnvelope,
  giveUp,
  isBackedOff,
  postEnvelope,
  readSyncCursor,
  recordFailure,
  recordSuccess,
  shouldGiveUp,
  writeSyncCursor,
} from '../../src/core/sync.js';

const origHome = process.env.AWL_HOME;

afterEach(() => {
  if (origHome === undefined) {
    delete process.env.AWL_HOME;
  } else {
    process.env.AWL_HOME = origHome;
  }
});

function tmpHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'awl-sync-'));
  process.env.AWL_HOME = home;
  return home;
}

describe('buildSpecEnvelope — 스펙 봉투 (prototype.md:380-389)', () => {
  it('revision 을 본문 sha256 으로 매번 새로 계산한다(저장된 빈 값을 안 믿는다)', () => {
    const env = buildSpecEnvelope({
      id: 'spec-1',
      organization: 'acme',
      project: 'p',
      author: 'hong@midasit.com',
      frontmatter: { status: 'closed' },
      body: 'hello',
    });
    expect(env.kind).toBe('spec');
    expect(env.revision).toHaveLength(64); // sha256 hex
    expect(env.author).toBe('hong@midasit.com');
  });

  it('본문이 다르면 revision 도 달라진다', () => {
    const a = buildSpecEnvelope({
      id: 's',
      organization: 'o',
      project: 'p',
      frontmatter: {},
      body: 'aaa',
    });
    const b = buildSpecEnvelope({
      id: 's',
      organization: 'o',
      project: 'p',
      frontmatter: {},
      body: 'bbb',
    });
    expect(a.revision).not.toBe(b.revision);
  });
});

describe('buildRecordEnvelope — 레코드 봉투 (prototype.md:394 "records 는 author 필수")', () => {
  it('author 가 있으면 그대로 실어 보낸다', () => {
    const env = buildRecordEnvelope(
      { id: 'rec-1', project: 'p', author: 'hong@midasit.com', type: 'gate', gate: 1 },
      'acme',
    );
    expect(env.kind).toBe('record');
    expect(env.author).toBe('hong@midasit.com');
    expect(env.frontmatter).toEqual({ type: 'gate', gate: 1 });
  });

  it('레코드엔 revision 개념이 없다(id 로만 멱등 판정, prototype.md:376)', () => {
    const env = buildRecordEnvelope({ id: 'rec-1', project: 'p' }, 'acme');
    expect(env.revision).toBeUndefined();
  });
});

describe("buildFeedbackEnvelope — 피드백 봉투 (prototype.md:394 \"feedback 은 안 넣는다\")", () => {
  it('author 를 아예 안 넣는다', () => {
    const env = buildFeedbackEnvelope(
      { id: 'fb-1', project: 'p', author: 'hong@midasit.com', area: 'cli' },
      'acme',
    );
    expect(env.kind).toBe('feedback');
    expect(env.author).toBeUndefined();
    expect(env.frontmatter).toEqual({ area: 'cli' });
  });
});

describe('sync 커서 — 원자적 읽기/쓰기', () => {
  it('커서 파일이 없으면 빈 객체를 돌려준다(크래시 없음)', () => {
    tmpHome();
    expect(readSyncCursor()).toEqual({});
  });

  it('쓴 커서를 그대로 읽어온다', () => {
    const home = tmpHome();
    writeSyncCursor({ records: { lastSentId: 'rec-9' } });
    expect(readSyncCursor()).toEqual({ records: { lastSentId: 'rec-9' } });
    expect(fs.existsSync(path.join(home, 'sync-cursor.json'))).toBe(true);
  });

  it('쓰기는 원자적이다 — .tmp 잔재가 안 남는다', () => {
    const home = tmpHome();
    writeSyncCursor({ specs: { lastSentAt: '2026-01-01T00:00:00.000Z' } });
    const leftoverTmp = fs.readdirSync(home).filter((f) => f.includes('.tmp'));
    expect(leftoverTmp).toEqual([]);
  });

  it('커서 파일이 깨져있어도(JSON 아님) 크래시 없이 빈 객체', () => {
    const home = tmpHome();
    fs.writeFileSync(path.join(home, 'sync-cursor.json'), 'not json{{{');
    expect(readSyncCursor()).toEqual({});
  });
});

describe('recordFailure/isBackedOff/shouldGiveUp — 지수 백오프 (prototype.md:415-416)', () => {
  it('처음 실패하면 1분 뒤로 백오프한다', () => {
    const now = () => 0;
    const s = recordFailure(undefined, now);
    expect(s.backoffIndex).toBe(0);
    expect(s.nextAttemptAt).toBe(new Date(BACKOFF_SCHEDULE_MIN[0] * 60 * 1000).toISOString());
    expect(s.firstFailureAt).toBe(new Date(0).toISOString());
  });

  it('연속 실패마다 스케줄을 따라 전진한다: 1→5→30→120→360→1440분', () => {
    let now = 0;
    let s = undefined as ReturnType<typeof recordFailure> | undefined;
    const seenIndexes: number[] = [];
    for (let i = 0; i < BACKOFF_SCHEDULE_MIN.length; i++) {
      s = recordFailure(s, () => now);
      seenIndexes.push(s.backoffIndex ?? -1);
      now = new Date(s.nextAttemptAt as string).getTime(); // 백오프 지난 시점으로 이동
    }
    expect(seenIndexes).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('스케줄 마지막 인덱스를 넘어가면 더 안 늘고 하루에서 멈춘다', () => {
    let now = 0;
    let s = undefined as ReturnType<typeof recordFailure> | undefined;
    for (let i = 0; i < BACKOFF_SCHEDULE_MIN.length + 3; i++) {
      s = recordFailure(s, () => now);
      now = new Date(s.nextAttemptAt as string).getTime();
    }
    expect(s?.backoffIndex).toBe(BACKOFF_SCHEDULE_MIN.length - 1);
  });

  it('firstFailureAt 은 연속 실패 구간에서 안 바뀐다(맨 처음 실패 시각 유지)', () => {
    const s1 = recordFailure(undefined, () => 1000);
    const s2 = recordFailure(s1, () => 5000);
    expect(s2.firstFailureAt).toBe(s1.firstFailureAt);
  });

  it('pendingCount 는 실패할 때마다 늘어난다', () => {
    const s1 = recordFailure(undefined, () => 0);
    const s2 = recordFailure(s1, () => 1);
    expect(s1.pendingCount).toBe(1);
    expect(s2.pendingCount).toBe(2);
  });

  it('isBackedOff — nextAttemptAt 이전이면 true, 지나면 false', () => {
    const s = recordFailure(undefined, () => 0);
    expect(isBackedOff(s, () => 0)).toBe(true);
    expect(isBackedOff(s, () => BACKOFF_SCHEDULE_MIN[0] * 60 * 1000 + 1)).toBe(false);
  });

  it('isBackedOff — 스트림이 없거나 nextAttemptAt 이 없으면 false(백오프 아님)', () => {
    expect(isBackedOff(undefined, () => 0)).toBe(false);
    expect(isBackedOff({}, () => 0)).toBe(false);
  });

  it('shouldGiveUp — 7일 미만이면 false, 7일 이상이면 true', () => {
    const s = { firstFailureAt: new Date(0).toISOString() };
    expect(shouldGiveUp(s, () => GIVE_UP_MS - 1)).toBe(false);
    expect(shouldGiveUp(s, () => GIVE_UP_MS)).toBe(true);
  });

  it('recordSuccess — 백오프 상태를 전부 지운다', () => {
    const s = recordSuccess('rec-5', () => 12345);
    expect(s).toEqual({ lastSentId: 'rec-5', lastSentAt: new Date(12345).toISOString() });
    expect(s.backoffIndex).toBeUndefined();
    expect(s.firstFailureAt).toBeUndefined();
    expect(s.pendingCount).toBeUndefined();
  });

  it('giveUp — 커서를 전진시키고 재시도 예약(nextAttemptAt) 없이 끝낸다', () => {
    const s = giveUp('rec-9', () => 999);
    expect(s.lastSentId).toBe('rec-9');
    expect(s.nextAttemptAt).toBeUndefined();
    expect(s.backoffIndex).toBeUndefined();
  });
});

function okFetch(): typeof fetch {
  return vi.fn(async () => new Response('{}', { status: 200 })) as unknown as typeof fetch;
}

function httpErrorFetch(status: number): typeof fetch {
  return vi.fn(async () => new Response('nope', { status })) as unknown as typeof fetch;
}

function failFetch(): typeof fetch {
  return vi.fn(async () => {
    throw new Error('network unreachable');
  }) as unknown as typeof fetch;
}

describe('postEnvelope — 전송 (실패해도 절대 throw 하지 않는다)', () => {
  const envelope = buildRecordEnvelope({ id: 'r1', project: 'p' }, 'acme');

  it('성공하면 ok:true', async () => {
    const fetchImpl = okFetch();
    const r = await postEnvelope('http://localhost:9999', '/records', envelope, undefined, fetchImpl);
    expect(r.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(url).toBe('http://localhost:9999/records');
    expect(init.method).toBe('POST');
  });

  it('token 이 있으면 Authorization 헤더로 실어 보낸다', async () => {
    const fetchImpl = okFetch();
    await postEnvelope('http://localhost:9999', '/records', envelope, 'secret-tok', fetchImpl);
    const [, init] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer secret-tok');
  });

  it('HTTP 에러 응답이면 ok:false 와 사유를 돌려준다(throw 안 함)', async () => {
    const r = await postEnvelope(
      'http://localhost:9999',
      '/records',
      envelope,
      undefined,
      httpErrorFetch(500),
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('500');
  });

  it('네트워크 실패면 ok:false(throw 안 함)', async () => {
    const r = await postEnvelope(
      'http://localhost:9999',
      '/records',
      envelope,
      undefined,
      failFetch(),
    );
    expect(r.ok).toBe(false);
  });

  it('타임아웃(abort)이어도 ok:false(throw 안 함)', async () => {
    const timeoutFetch = vi.fn((_url: string, init?: { signal?: AbortSignal }) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    }) as unknown as typeof fetch;
    const r = await postEnvelope('http://localhost:9999', '/records', envelope, undefined, timeoutFetch);
    expect(r.ok).toBe(false);
  });
});
