import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { syncCursorPath } from './paths.js';

/**
 * 중앙 저장소 전송(ADK stage 3, docs/0.8.0/adk-prototype.md:356-443).
 *
 * 로컬 우선: 이 모듈의 모든 전송 함수는 절대 throw 하지 않는다(npm-registry.ts 와 같은
 * 원칙) — 서버가 죽어도 `awl record`/`awl commit` 등 호출부의 루프를 막지 않는다.
 *
 * 큐가 아니라 커서: 기록/피드백은 이미 로컬 jsonl 파일이 원본이므로 보낼 것을 따로
 * 복사해 쌓지 않는다 — "어디까지 보냈다"만 ~/.awl/sync-cursor.json 에 남긴다. 스펙은
 * 파일이 하나씩이라 커서 위치 개념이 없다 — status:'closed' 인 것을 매번 다시 훑고
 * revision 멱등성(서버가 같은 revision 을 무시)에 기대 중복 전송을 걸러낸다.
 */

/** 봉투의 kind — 무엇을 보내는지(prototype.md:381 "kind": "spec" 등). */
export type SyncKind = 'spec' | 'record' | 'feedback';

/**
 * 전송 봉투(prototype.md:380-389 그대로). `author`는 kind 마다 다르게 다룬다
 * (prototype.md:394 "records 는 필수, 문서는 생성자, feedback 은 안 넣는다") — 이 모듈은
 * 강제하지 않고 호출부(buildXxxEnvelope)가 kind 별로 채우거나 비운다.
 */
export interface SyncEnvelope {
  kind: SyncKind;
  id: string;
  /** 스펙만 의미 있다(본문 sha256). 레코드/피드백은 id 로만 멱등 판정한다(revision 없음). */
  revision?: string;
  organization: string;
  project: string;
  author?: string;
  frontmatter: Record<string, unknown>;
  body: string;
}

/** 본문의 sha256 — doc.ts 의 bodySha256 과 동일 로직. doc.ts→record.ts 순환 참조를 피하려고
 * (core/sync.ts 를 record.ts 가 부르게 되면 doc.ts 를 또 거쳐올 수 없다) 작게 다시 둔다. */
function bodySha256(body: string): string {
  return createHash('sha256').update(body).digest('hex');
}

/** 스펙 봉투(prototype.md 예시 그대로) — revision 은 저장된 빈 값을 안 믿고 매번 새로 계산한다. */
export function buildSpecEnvelope(opts: {
  id: string;
  organization: string;
  project: string;
  author?: string;
  frontmatter: Record<string, unknown>;
  body: string;
}): SyncEnvelope {
  return {
    kind: 'spec',
    id: opts.id,
    revision: bodySha256(opts.body),
    organization: opts.organization,
    project: opts.project,
    author: opts.author,
    frontmatter: opts.frontmatter,
    body: opts.body,
  };
}

/** 레코드 봉투 — author 가 필수(prototype.md:394). id/project/author 를 골라내고 나머지는 frontmatter 로. */
export function buildRecordEnvelope(
  record: Record<string, unknown>,
  organization: string,
): SyncEnvelope {
  const { id, project, author, ...rest } = record;
  return {
    kind: 'record',
    id: String(id ?? ''),
    organization,
    project: String(project ?? ''),
    author: typeof author === 'string' ? author : undefined,
    frontmatter: rest,
    body: '',
  };
}

/** 피드백 봉투 — author 를 아예 안 넣는다(prototype.md:394 "feedback 은 안 넣는다"). */
export function buildFeedbackEnvelope(
  record: Record<string, unknown>,
  organization: string,
): SyncEnvelope {
  const { id, project, author: _author, ...rest } = record;
  return {
    kind: 'feedback',
    id: String(id ?? ''),
    organization,
    project: String(project ?? ''),
    frontmatter: rest,
    body: '',
  };
}

/** 실패마다 다음 인덱스로: 1분→5분→30분→2시간→6시간→하루(prototype.md:415). */
export const BACKOFF_SCHEDULE_MIN = [1, 5, 30, 120, 360, 1440] as const;
/** 7일 지나면 재시도를 포기하고 커서를 전진시킨다(prototype.md:416, reference.md:1790-1795). */
export const GIVE_UP_MS = 7 * 24 * 60 * 60 * 1000;

export interface SyncStreamState {
  /** 마지막으로 성공 전송한 레코드 id(records/feedback 재개 위치). 스펙은 안 씀. */
  lastSentId?: string;
  lastSentAt?: string;
  /** BACKOFF_SCHEDULE_MIN 의 인덱스. 없거나 0 이면 정상(백오프 중 아님). */
  backoffIndex?: number;
  /** 이 시각 이전엔 재시도하지 않는다. */
  nextAttemptAt?: string;
  /** 연속 실패가 시작된 시각 — 7일 포기 판정 기준. 성공하면 지운다. */
  firstFailureAt?: string;
  /** doctor 표시용 — 아직 못 보낸 것으로 추정되는 건수. */
  pendingCount?: number;
}

export interface SyncCursor {
  records?: SyncStreamState;
  specs?: SyncStreamState;
  feedback?: SyncStreamState;
}

/** endpoint 가 없으면(전송 기능이 꺼진 상태) 커서 파일 자체를 절대 만들지 않는다 —
 * 호출부가 이 함수를 부르기 전에 endpoint 유무를 먼저 걸러야 한다(no-op 강제는 호출부 책임). */
export function readSyncCursor(): SyncCursor {
  try {
    const raw = JSON.parse(fs.readFileSync(syncCursorPath(), 'utf8')) as unknown;
    if (raw && typeof raw === 'object') {
      return raw as SyncCursor;
    }
    return {};
  } catch {
    return {};
  }
}

/** 원자적 쓰기(npm-registry.ts 의 writeCache() 와 같은 패턴, tmp→rename). */
export function writeSyncCursor(cursor: SyncCursor): void {
  const p = syncCursorPath();
  const tmp = `${p}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(cursor, null, 2));
    fs.renameSync(tmp, p);
  } catch {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // temp 파일이 애초에 안 생겼으면 unlink 도 무시.
    }
  }
}

/** 지금이 백오프 대기 시간 안이면 true — 재시도하면 안 된다. */
export function isBackedOff(stream: SyncStreamState | undefined, now: () => number): boolean {
  if (!stream?.nextAttemptAt) {
    return false;
  }
  return now() < new Date(stream.nextAttemptAt).getTime();
}

/** firstFailureAt 로부터 7일이 지났으면 true — 포기하고 커서를 전진시킬 시점. */
export function shouldGiveUp(stream: SyncStreamState | undefined, now: () => number): boolean {
  if (!stream?.firstFailureAt) {
    return false;
  }
  return now() - new Date(stream.firstFailureAt).getTime() >= GIVE_UP_MS;
}

/** 실패 처리 — 백오프 인덱스를 한 칸 전진(마지막 인덱스에서 멈춤), firstFailureAt 은 이미
 * 있으면 안 건드리고(연속 실패 구간의 시작을 유지), 없으면 지금으로 채운다. */
export function recordFailure(
  stream: SyncStreamState | undefined,
  now: () => number,
): SyncStreamState {
  const prevIndex = stream?.backoffIndex ?? -1;
  const nextIndex = Math.min(prevIndex + 1, BACKOFF_SCHEDULE_MIN.length - 1);
  const delayMs = (BACKOFF_SCHEDULE_MIN[nextIndex] ?? 1440) * 60 * 1000;
  return {
    ...stream,
    backoffIndex: nextIndex,
    nextAttemptAt: new Date(now() + delayMs).toISOString(),
    firstFailureAt: stream?.firstFailureAt ?? new Date(now()).toISOString(),
    pendingCount: (stream?.pendingCount ?? 0) + 1,
  };
}

/** 성공 처리 — 백오프 상태를 전부 지우고 lastSentId/lastSentAt 만 남긴다. */
export function recordSuccess(lastSentId: string | undefined, now: () => number): SyncStreamState {
  return {
    lastSentId,
    lastSentAt: new Date(now()).toISOString(),
  };
}

/** 포기 처리 — 커서를 전진(호출부가 lastSentId 를 정해 넘긴다)시키고 백오프를 지운다.
 * 재시도는 하지 않는다(prototype.md:416) — 호출부가 이 반환값을 로그 한 줄로 남긴다. */
export function giveUp(lastSentId: string | undefined, now: () => number): SyncStreamState {
  return {
    lastSentId,
    lastSentAt: new Date(now()).toISOString(),
  };
}

const FETCH_TIMEOUT_MS = 2000;

type FetchFn = typeof fetch;

/**
 * 봉투 하나를 실제로 전송한다(I/O, npm-registry.ts 의 fetchLatestVersion 과 같은 형태:
 * AbortController 타임아웃, 실패는 절대 throw 하지 않고 사유만 돌려준다).
 */
export async function postEnvelope(
  endpoint: string,
  urlPath: string,
  envelope: SyncEnvelope,
  token?: string,
  fetchImpl: FetchFn = fetch,
): Promise<{ ok: boolean; reason?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (token) {
      headers.authorization = `Bearer ${token}`;
    }
    const res = await fetchImpl(`${endpoint.replace(/\/$/, '')}${urlPath}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(envelope),
      signal: controller.signal,
    });
    if (!res.ok) {
      return { ok: false, reason: `http ${res.status}` };
    }
    return { ok: true };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { ok: false, reason };
  } finally {
    clearTimeout(timer);
  }
}
