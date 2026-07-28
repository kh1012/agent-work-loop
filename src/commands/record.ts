import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseFrontmatter, serializeFrontmatter } from '../core/doc-frontmatter.js';
import { readGlobalAwlConfig } from '../core/global-config.js';
import { recordsDir, recordsSuffixPath, rulesDir } from '../core/paths.js';
import { redactAbsolutePaths } from '../core/redact.js';
import { run } from '../core/runner.js';
import {
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
  type SyncStreamState,
  writeSyncCursor,
} from '../core/sync.js';
import { type Caps, caps, makeColors, sectionBox, signal } from '../core/tty.js';
import { loadConfig, resolveProjectRoot } from './config.js';
import { type SkillSlot, loadProfile } from './profile.js';
import { getCriterion, loadState, writeState } from './state.js';

/**
 * awl record — 구조를 강제하는 기록.
 *
 * 줄글을 쓸 자리 자체를 없앤다. 사람이 못 읽는 기록은 기계(evolve)도 못 읽으므로,
 * 시인성은 미관이 아니라 evolve 가 동작하느냐의 문제다.
 * 기록은 append only. 수정/삭제하지 않는다(update 명령을 만들지 않는다).
 */

export type RecordType =
  | 'audit'
  | 'spike'
  | 'criteria'
  | 'attempt'
  | 'blocked'
  | 'review'
  | 'decision'
  | 'gotcha-applied'
  | 'gotcha-missed'
  | 'narrative'
  | 'gate'
  | 'clarify'
  | 'awl-feedback'
  | 'defer'
  | 'refactor';

/**
 * narrative.kind 로 허용되는 값 (WI-P AC-02).
 * tool-failed(WI-W): awl 자신의 도구가 오작동해(예: 자체 검증 통과를 보고하고도
 * 무관한 파일을 흡수) 실사고를 낸 순간 — 완료 조건/리뷰/스파이크가 아니라
 * 도구 자체의 결함이 원인일 때만 쓴다.
 */
export const NARRATIVE_KINDS = [
  'gate-caught',
  'reviewer-caught',
  'spike-prevented',
  'blocked-discarded',
  'tool-failed',
] as const;

/** gate:1 의 decision 으로 허용되는 값 (WI-Q AC-01). request 레이어 — 티켓(완료조건) 확정. */
export const GATE1_DECISIONS = ['approved', 'modified', 'rejected', 'split'] as const;
/** gate:2 의 decision 으로 허용되는 값 (WI-Q AC-01). 레거시 — workitem 완료. 뜻·값 안 바뀜. */
export const GATE2_DECISIONS = ['approved', 'more-work', 'abandoned'] as const;
/**
 * gate:3 의 decision (ADK stage 2a 신규, layer:'ticket' 전용) — 티켓 완료.
 * "이 단위가 끝났는가"라는 gate:2 와 같은 질문을 티켓 단위에 적용한 것뿐이라
 * 새 어휘를 만들지 않고 그대로 재사용한다.
 */
export const GATE3_DECISIONS = GATE2_DECISIONS;
/**
 * gate:4 의 decision (ADK stage 2a 신규, layer:'request' 전용) — 요청을 닫을 것인가 +
 * 마무리(병합) 방식. docs/0.8.0/adk-reference.md 9장의 게이트4 화면 문구를 값으로 옮겼다.
 */
export const GATE4_DECISIONS = ['merge', 'judge-only', 'hold'] as const;
/** gate 레코드의 layer 로 허용되는 값 (ADK stage 2a). */
export const GATE_LAYERS = ['request', 'ticket'] as const;

/**
 * gate 2/3(layer:'ticket') 승인 시 그 티켓의 다음 status(ADK stage 2b).
 * gate 4/1(request 레이어)이나 레거시 gate 1/2(layer 없음)는 이 표를 안 쓴다 —
 * 조건이 (gate===2||gate===3) && layer==='ticket' 일 때만 쓰인다.
 */
const TICKET_STATUS_TRANSITIONS: Record<number, Record<string, string>> = {
  2: { approved: 'implementing', 'more-work': 'pending', abandoned: 'blocked' },
  3: { approved: 'done', 'more-work': 'implementing', abandoned: 'blocked' },
};

/**
 * gate 1/4(layer:'request') 승인 시 그 스펙의 다음 status(ADK stage 3, adk-reference.md
 * 397-405행: draft→게이트1 통과→active, active→게이트4 통과→closed). gate:4 의 'hold' 는
 * 항목이 없다 — "일시정지는 상태가 아니라 별도 필드"(reference.md:407) 원칙이라 status
 * 전이가 없다(active 유지, 기존 lookup 결과 undefined 를 그대로 쓰는 아래 가드가 처리).
 */
const SPEC_STATUS_TRANSITIONS: Record<number, Record<string, string>> = {
  1: { approved: 'active', modified: 'active', rejected: 'draft', split: 'draft' },
  4: { merge: 'closed', 'judge-only': 'closed' },
};

/**
 * ticketId 로 `docs/tickets/*.md` 를 훑어 파일 경로를 찾는다. doc.ts/tickets.ts 도
 * 비슷한 조회를 하지만, record.ts 가 그쪽을 import 하면 doc.ts→record.ts(이미 있음:
 * BANNED_QUALITATIVE_WORDS)와 겹쳐 순환 참조가 생긴다 — 그래서 여기서 작게 다시 쓴다.
 */
function findTicketFileById(projectRoot: string, ticketId: string): string | null {
  const dir = path.join(projectRoot, 'docs', 'tickets');
  let entries: string[];
  try {
    entries = fs.readdirSync(dir).filter((f) => f.endsWith('.md'));
  } catch {
    return null;
  }
  for (const name of entries) {
    const filePath = path.join(dir, name);
    let parsed: ReturnType<typeof parseFrontmatter>;
    try {
      parsed = parseFrontmatter(fs.readFileSync(filePath, 'utf8'));
    } catch {
      continue;
    }
    if (parsed?.data.id === ticketId) {
      return filePath;
    }
  }
  return null;
}

/** 티켓 파일의 frontmatter status 만 바꿔 다시 쓴다. 본문은 그대로 보존한다.
 * serializeFrontmatter 는 이미 `\n` 로 끝나고, parseFrontmatter 가 돌려주는
 * body 는 원본에서 닫는 `---` 뒤에 있던 개행(들)을 그대로 포함한다 — 여기서
 * 또 `\n` 을 더하면 다시 쓸 때마다 빈 줄이 한 줄씩 누적된다(round-trip 불안정,
 * ADK stage 3 e2e 검증이 스펙 revision 이 매번 달라지는 것으로 발견). */
function writeTicketStatus(ticketPath: string, status: string): void {
  const parsed = parseFrontmatter(fs.readFileSync(ticketPath, 'utf8'));
  if (!parsed) {
    return;
  }
  const nextData = { ...parsed.data, status };
  fs.writeFileSync(ticketPath, `${serializeFrontmatter(nextData)}${parsed.body}`);
}

/**
 * specId 로 `docs/specs/*.md` 를 훑어 파일 경로를 찾는다. findTicketFileById 와 완전히
 * 같은 이유(순환 참조 회피)로 작게 다시 쓴다.
 */
function findSpecFileById(projectRoot: string, specId: string): string | null {
  const dir = path.join(projectRoot, 'docs', 'specs');
  let entries: string[];
  try {
    entries = fs.readdirSync(dir).filter((f) => f.endsWith('.md'));
  } catch {
    return null;
  }
  for (const name of entries) {
    const filePath = path.join(dir, name);
    let parsed: ReturnType<typeof parseFrontmatter>;
    try {
      parsed = parseFrontmatter(fs.readFileSync(filePath, 'utf8'));
    } catch {
      continue;
    }
    if (parsed?.data.id === specId) {
      return filePath;
    }
  }
  return null;
}

/** 스펙 파일의 frontmatter status 만 바꿔 다시 쓴다. 본문은 그대로 보존한다.
 * writeTicketStatus 와 같은 이유로 body 앞에 `\n` 을 더 안 붙인다(round-trip 안정성). */
/** doc.ts 의 bodySha256 과 동일 로직 — doc.ts 가 이미 record.ts 를 import 하므로(BANNED_QUALITATIVE_WORDS
 * 등) record.ts→doc.ts 임포트를 추가하면 순환이 된다. core/sync.ts 의 같은 이유의 중복과 동형이다. */
function specBodySha256(body: string): string {
  return crypto.createHash('sha256').update(body).digest('hex');
}

/** status 전이마다 revision(본문 sha256)도 다시 계산해 써넣는다(ADK stage 1, "스펙을
 * 저장하면 revision 이 본문 해시로 채워져야 한다") — 스펙은 사람이 직접 편집하므로
 * 모든 저장 시점을 가로챌 수 없지만, 게이트 전이는 awl 이 아는 유일한 "저장 이벤트"다. */
function writeSpecStatus(specPath: string, status: string): void {
  const parsed = parseFrontmatter(fs.readFileSync(specPath, 'utf8'));
  if (!parsed) {
    return;
  }
  const nextData = { ...parsed.data, status, revision: specBodySha256(parsed.body) };
  fs.writeFileSync(specPath, `${serializeFrontmatter(nextData)}${parsed.body}`);
}

/**
 * `.awl/lane-meta.json`(lane.ts 가 만든다, ADK stage 5)의 baseBranch 만 읽는다. lane.ts 가
 * `loadProjectName`(record.ts)을 이미 import 하므로, 여기서 lane.ts 를 import 하면
 * record.ts→lane.ts→record.ts 순환이 생긴다 — findSpecFileById 등과 같은 이유로 작게
 * 다시 둔다. 없거나 깨졌으면 null(단계5 이전 레인·레인이 아닌 곳 모두 이 경로다).
 */
function readLaneBaseBranch(projectRoot: string): string | null {
  try {
    const raw = JSON.parse(
      fs.readFileSync(path.join(projectRoot, '.awl', 'lane-meta.json'), 'utf8'),
    ) as Record<string, unknown>;
    return typeof raw.baseBranch === 'string' ? raw.baseBranch : null;
  } catch {
    return null;
  }
}

/** 게이트4 병합 제안(ADK stage 5, WI-D) — 실행은 안 한다, 명령만 보여준다("awl은
 * 판단하지 않는다"). 레인 안이 아니면(lane-meta.json 없음) 조용히 생략한다. */
async function suggestGate4Merge(projectRoot: string): Promise<void> {
  const baseBranch = readLaneBaseBranch(projectRoot);
  if (!baseBranch) {
    return;
  }
  const r = await run({
    cmd: 'git',
    args: ['rev-parse', '--abbrev-ref', 'HEAD'],
    cwd: projectRoot,
    timeoutMs: 10_000,
  });
  const laneBranch = r.exitCode === 0 ? r.stdout.trim() : null;
  if (!laneBranch || laneBranch === baseBranch) {
    return; // 판정 불가하거나(브랜치 못 읽음) 이미 같은 브랜치 — 제안할 게 없다.
  }
  process.stdout.write(
    `\n  병합 제안: git merge ${laneBranch} → ${baseBranch}\n` +
      '  (awl 은 실행하지 않습니다 — 레인을 열 때 서 있던 브랜치로 되돌리는 게 목적이면 사람/스킬이 직접 실행하세요.)\n',
  );
}

// ---------------------------------------------------------------------------
// 중앙 저장소 전송 (ADK stage 3) — 세 지점(스펙 closed·티켓 done·awl-feedback)에서만
// 부른다. endpoint 가 없으면 core/sync.ts 의 함수들이 자체적으로 no-op 이므로 여기선
// 그냥 부르기만 하면 된다. 실패해도 절대 throw 하지 않는다(postEnvelope 계약) — 이
// 계층은 그 실패를 커서에 기록하고 조용히 리턴한다("서버가 죽어도 루프는 돈다").
// ---------------------------------------------------------------------------

/** git remote 로 organization(owner)을 추정한다. doc.ts 의 deriveOrganizationFromGitRemote
 * 와 완전히 같은 로직 — record.ts 가 doc.ts 를 import 하면 순환 참조가 생기므로
 * (findTicketFileById 등과 같은 이유) 여기서 작게 다시 둔다. */
async function deriveOrganizationForSync(projectRoot: string): Promise<string> {
  try {
    const result = await run({
      cmd: 'git',
      args: ['config', '--get', 'remote.origin.url'],
      cwd: projectRoot,
    });
    if (result.exitCode !== 0) {
      return '';
    }
    const s = result.stdout.trim().replace(/\.git$/, '');
    let m = s.match(/^[\w.-]+@[^:/]+:(.+)$/);
    if (!m) {
      m = s.match(/^ssh:\/\/[^/]+\/(.+)$/);
    }
    if (!m) {
      m = s.match(/^https?:\/\/[^/]+\/(.+)$/);
    }
    return m?.[1]?.split('/')[0] ?? '';
  } catch {
    return '';
  }
}

/** endpoint 가 없거나 이미 7일 넘게 실패 중이면 즉시 포기·no-op, 아니면 한 번 시도한다.
 * 커서를 어디서 읽고 어디에 쓰는지는 호출부가 결정한다(writeBack) — records 스트림은
 * 프로젝트별로 나뉘어 있어(SyncCursor.records) 최상위 키 하나로는 못 가리킨다. */
async function attemptSend(
  streamLabel: string,
  currentStream: SyncStreamState | undefined,
  writeBack: (next: SyncStreamState) => void,
  envelopeId: string,
  send: () => Promise<{ ok: boolean; reason?: string }>,
  now: () => number = () => Date.now(),
): Promise<boolean> {
  if (shouldGiveUp(currentStream, now)) {
    process.stderr.write(
      `  [-] sync(${streamLabel}) 7일 넘게 실패해 포기합니다 — 미전송 ${currentStream?.pendingCount ?? 0}건은 로컬에만 남습니다.\n`,
    );
    writeBack(giveUp(envelopeId, now));
    return false;
  }
  if (isBackedOff(currentStream, now)) {
    return false; // 다음 재시도 시각 전 — 조용히 건너뛴다.
  }
  const result = await send();
  const nextStream = result.ok
    ? recordSuccess(envelopeId, now)
    : recordFailure(currentStream, now, result.reason);
  writeBack(nextStream);
  return result.ok;
}

/** 스펙이 closed 로 전이된 직후 그 스펙 하나를 전송한다(prototype.md:401 "closed 가 될 때만"). */
async function syncClosedSpec(specPath: string): Promise<void> {
  const cfg = readGlobalAwlConfig();
  const endpoint = cfg?.sync?.records?.endpoint;
  if (!endpoint) {
    return; // 전송 기능이 꺼진 상태 — 커서를 절대 안 만든다(소급 전송 없음).
  }
  const parsed = parseFrontmatter(fs.readFileSync(specPath, 'utf8'));
  if (!parsed) {
    return;
  }
  const envelope = buildSpecEnvelope({
    id: String(parsed.data.id ?? ''),
    organization: String(parsed.data.organization ?? ''),
    project: String(parsed.data.project ?? ''),
    author: cfg?.author,
    frontmatter: parsed.data,
    body: parsed.body,
  });
  const cursor = readSyncCursor();
  await attemptSend(
    'specs',
    cursor.specs,
    (next) => writeSyncCursor({ ...cursor, specs: next }),
    envelope.id,
    () => postEnvelope(endpoint as string, '/specs', envelope, cfg?.sync?.records?.token),
  );
}

/**
 * 티켓이 done 으로 전이된 직후(prototype.md:402 "기록은 워크아이템이 끝날 때") 이
 * 프로젝트의 records 커서 이후 전부를 훑어 순서대로 전송한다 — 이 티켓의 기록만이
 * 아니다. records 커서가 프로젝트별로 나뉘어 있으므로(SyncCursor.records), 이전에
 * 실패해 밀린 다른 티켓의 기록도 이번에 같이 훑인다 — "서버를 다시 켜면 밀린 기록이
 * 함께 전송되어야 한다"(prototype.md:438)가 여기서 성립한다. 하나라도 실패하면 그
 * 자리에서 멈춘다 — 커서가 정확히 "여기까지 보냈다"를 가리키게 하기 위함.
 *
 * author 없는 기록은(전역 config 가 아직 없던 시절에 쓰인 옛 기록 등, "기록에 author 가
 * 안 붙되 진행은 된다"의 결과물) 전송하지 않고 조용히 건너뛴다 — records 봉투엔 author
 * 가 필수이므로(prototype.md:394) 채울 수 없는 값을 억지로 만들어내지 않는다. 건너뛴
 * 기록의 위치에선 커서가 안 움직이지만, 그 뒤에 author 있는 기록이 성공 전송되면
 * 커서가 그 기록으로 넘어가 건너뛴 기록은 다시 안 훑인다(자연 소멸, 재시도 없음).
 */
async function syncProjectRecords(projectRoot: string, projectName: string): Promise<void> {
  const cfg = readGlobalAwlConfig();
  const endpoint = cfg?.sync?.records?.endpoint;
  if (!endpoint) {
    return;
  }
  const organization = await deriveOrganizationForSync(projectRoot);
  let cursor = readSyncCursor();
  let stream = cursor.records?.[projectName];
  // readRecords() 는 최신순(내림차순)이다 — allDesc[0] 이 가장 최근 기록, 끝이 가장 오래됨.
  const allDesc = readRecords(projectRoot).filter((r) => r.project === projectName);

  if (!stream) {
    // 이 프로젝트의 records 스트림을 처음 추적하는 순간이다 — endpoint 가 방금 켜졌을
    // 수 있으므로, 지금까지 쌓인 기록을 소급 전송하지 않는다(prototype.md:435 "그
    // 시점부터 시작한다. 소급 전송 없음"). 커서를 "지금까지는 이미 다룬 것으로" 시드해
    // 다음 트리거부터 새로 생기는 기록만 나가게 한다. 가장 최근 기록(allDesc[0])을
    // lastSentId 로 삼는다 — 그보다 새 기록만 다음부터 "새 기록"으로 잡힌다.
    const newest = allDesc[0];
    if (newest) {
      cursor = {
        ...cursor,
        records: { ...cursor.records, [projectName]: { lastSentId: String(newest.id) } },
      };
      writeSyncCursor(cursor);
    }
    return;
  }

  const lastSentId = stream.lastSentId;
  const cutIdx = lastSentId ? allDesc.findIndex((r) => r.id === lastSentId) : -1;
  // lastSentId 보다 최근인 기록은 내림차순 배열에서 그 앞쪽(인덱스가 더 작은 쪽)에
  // 있다. 오래된 것부터 순서대로 보내야 하므로 뒤집는다.
  const newerDesc = cutIdx === -1 ? allDesc : allDesc.slice(0, cutIdx);
  const toSend = [...newerDesc].reverse();
  for (const record of toSend) {
    if (typeof record.author !== 'string' || record.author.trim() === '') {
      continue; // author 없는 기록은 건너뛴다 — 커서를 안 움직인다(위 주석 참고).
    }
    const envelope = buildRecordEnvelope(record, organization);
    const ok = await attemptSend(
      `records:${projectName}`,
      stream,
      (next) => {
        stream = next;
      },
      envelope.id,
      () => postEnvelope(endpoint as string, '/records', envelope, cfg?.sync?.records?.token),
    );
    cursor = { ...cursor, records: { ...cursor.records, [projectName]: stream as SyncStreamState } };
    writeSyncCursor(cursor);
    if (!ok) {
      break;
    }
  }
}

/** awl-feedback 레코드가 기록되는 즉시 전송한다(prototype.md:403 "피드백은 발생할 때").
 * sync.feedback.endpoint 는 records 와 달리 전체 경로를 이미 포함한다
 * (prototype.md:105 "http://localhost:9999/feedback") — 그래서 urlPath 를 안 붙인다.
 * export: core/auto-feedback.ts(ADK stage 6, CLI 미처리 예외 자동기록)도 재사용한다. */
export async function syncFeedback(projectRoot: string, record: Record<string, unknown>): Promise<void> {
  const cfg = readGlobalAwlConfig();
  const endpoint = cfg?.sync?.feedback?.endpoint;
  if (!endpoint) {
    return;
  }
  const organization = await deriveOrganizationForSync(projectRoot);
  const envelope = buildFeedbackEnvelope(record, organization);
  const cursor = readSyncCursor();
  await attemptSend(
    'feedback',
    cursor.feedback,
    (next) => writeSyncCursor({ ...cursor, feedback: next }),
    envelope.id,
    () => postEnvelope(endpoint as string, '', envelope),
  );
}

/**
 * awl-feedback.area 로 허용되는 값 (0.6.x). awl 도구의 어느 기능이 아팠나 —
 * 이게 모으기(awl feedback-log)의 묶는 키가 된다. gotcha 와 달리 작업 대상 코드가
 * 아니라 awl 도구 자체에 대한 피드백이다.
 */
export const AWL_FEEDBACK_AREAS = [
  'commit',
  'review',
  'gate',
  'verify',
  'state',
  'init',
  'cli',
  '기타',
] as const;
/** awl-feedback.severity 로 허용되는 값 (0.6.x). */
export const AWL_FEEDBACK_SEVERITIES = ['high', 'medium', 'low'] as const;

/**
 * refactor.kind 로 허용되는 값 (loop-refactor-checkpoint). 리팩토링의 성격 —
 * metrics/evolve 가 "어떤 리팩토링이 실제로 일어났나"를 이 종류로 센다. awl 은
 * 종류가 유효한지 구조만 보고, 무엇을 split/dedup 으로 볼지는 판단하지 않는다.
 */
export const REFACTOR_KINDS = [
  'split',
  'dedup',
  'abstraction',
  'rename',
  'inline',
  '기타',
] as const;

/**
 * severity 척도 — 심각도 내림차순(index 0='high' 가 가장 중요). 보류(defer)
 * 레코드 severity 검증과 shouldDefer 임계 비교의 단일 출처(skip-gate-defer).
 */
export const DEFER_SEVERITIES = ['high', 'medium', 'low'] as const;

/**
 * 이 severity 를 사람에게 defer(보류)할지 판정한다(순수, skip-gate-defer AC-03).
 *
 * 판정 기준: severity 가 임계 이상으로 "중요"하면 defer(사람 최종 문의), 아니면 스킬이
 * "권장 통과"한다. threshold 'high'(기본)=high 만, 'medium'=high+medium, 'low'=전부 defer.
 * "중요"의 뜻은 severity 를 남기는 쪽(스킬)이 정한다 — 통상 파괴적·스펙 이탈·부정행위 의심·
 * 되돌리기 어려움을 high 로 본다. severity 가 알 수 없는 값이면 fail-safe 로 defer(true) —
 * 판단 못 하는 건 자율 통과시키지 않고 사람에게 넘긴다. 잘못된 threshold 는 기본 high 로 취급.
 *
 * awl 은 이 술어만 제공한다 — 실제 자율통과/보류 실행(게이트를 권장으로 넘김)은 스킬 몫이다.
 */
export function shouldDefer(severity: string, threshold = 'high'): boolean {
  const levels = DEFER_SEVERITIES as readonly string[];
  const sevRank = levels.indexOf(severity);
  if (sevRank === -1) {
    return true; // 알 수 없는 severity → 안전하게 defer(사람에게)
  }
  const thrRank = levels.indexOf(threshold);
  const effectiveThr = thrRank === -1 ? 0 : thrRank; // 잘못된 threshold → 기본 high(0)
  return sevRank <= effectiveThr;
}

interface Schema {
  required: string[];
  /** 비어있지 않은 배열이어야 하는 필드 */
  arrays?: string[];
  /** 배열이어야 하지만 비어있어도 되는 필드 (지적/부정행위 없음도 정당한 결과인 경우) */
  arraysAllowEmpty?: string[];
}

/**
 * 타입별 필수 구조. 자유 텍스트 필드 하나로 퉁치지 않는다.
 * (audit/spike/criteria/review/decision 의 구조는 가정 — docs/decisions.md D-15)
 */
export const SCHEMAS: Record<RecordType, Schema> = {
  audit: { required: ['scope', 'findings'], arrays: ['findings'] },
  spike: { required: ['question', 'found'] },
  criteria: { required: ['items'], arrays: ['items'] },
  // WI-U: why/how/alternatives 는 diff 크기(diffTier)에 따라 조건부로 요구된다
  // (buildRecord 의 attempt 전용 분기가 처리). what/result 만 무조건 필수.
  // result:'verified' 는 코드 변경 없이 확인만 한 가드/검증형 완료조건 — 직전 커밋을
  // 재지 않고 why/how 를 면제한다(what 만으로 통과, 피드백 F-3).
  attempt: { required: ['what', 'result'] },
  blocked: { required: ['what', 'why', 'tried', 'lesson'], arrays: ['tried'] },
  // WI-S: target/verdict(이분법) 를 reviewId/criteria/findings/cheatingDetected/
  // verifyPassedBefore 로 전면 교체 — target≈criteria, verdict≈findings.length 로
  // 정보 손실 없이 표현되므로 예전 필드는 없앤다(과거 기록은 append-only 로 그대로
  // 유효하게 남는다, D-33 원칙). criteria 만 비어있지 않은 배열을 강제한다 —
  // findings/cheatingDetected 는 존재는 필수지만 빈 배열(지적/부정행위 없음)도
  // 정당한 결과라 비어있어도 통과한다.
  review: {
    required: ['reviewId', 'criteria', 'findings', 'cheatingDetected', 'verifyPassedBefore'],
    arrays: ['criteria'],
    arraysAllowEmpty: ['findings', 'cheatingDetected'],
  },
  decision: { required: ['question', 'decision', 'rationale'] },
  'gotcha-applied': { required: ['gotchaId', 'what'] },
  'gotcha-missed': { required: ['gotchaId', 'what', 'why'] },
  narrative: { required: ['kind', 'counterfactual'] },
  gate: { required: ['gate', 'decision', 'presentedCriteria'], arrays: ['presentedCriteria'] },
  clarify: { required: ['questions'], arrays: ['questions'] },
  // awl-feedback(0.6.x): awl 도구 자체가 아팠던 점. gotcha(작업 코드 교훈)와 다른
  // 종류다 — records/ 에 쌓이고 gotcha 로 승격되지 않는다. area 가 모으기의 키.
  // suggestion 은 선택(개선 아이디어, 강제 아님 — 번역은 사람 몫).
  'awl-feedback': { required: ['area', 'what', 'impact', 'severity'] },
  // 자율 통과를 보류하고 사람에게 최종 문의할 중요 항목(보류 큐).
  // recommendation(자율로 택했을 권장 결정)/gate(어느 게이트)/addresses 는 선택(D-15).
  defer: { required: ['severity', 'what', 'why'] },
  // 반복 루프 리팩토링 체크포인트에서 실제 리팩토링이 일어났을 때 남긴다
  // (loop-refactor-checkpoint). kind 가 성격, what 이 무엇을 정리했나.
  refactor: { required: ['what', 'kind'] },
};

export const RECORD_TYPES = Object.keys(SCHEMAS) as RecordType[];

/**
 * 완료 조건에 남으면 재해석 여지가 생기는 질적 표현 (WI-T). "저위험 건 수정" 같은
 * 표현은 구현 도중 "무엇을 저위험으로 볼지"가 순수한 판단이 되어 재분류가
 * 일어난다 — awl verify 가 그 판단 자체를 검증하지 못한다. 열거 가능하거나
 * 수치화 가능한 표현으로 다시 쓰게 한다.
 */
export const BANNED_QUALITATIVE_WORDS = [
  '저위험',
  '주요한',
  '적절한',
  '가능한 만큼',
  '필요시',
] as const;

function isHangulSyllable(ch: string): boolean {
  const code = ch.codePointAt(0) ?? 0;
  return code >= 0xac00 && code <= 0xd7a3;
}

/**
 * text 안에 word 가 "독립된" 형태로 있는지 본다(WI-T AC-07, 리뷰 지적) — 단순
 * 부분 문자열 매칭은 "부적절한"⊃"적절한", "필요시간"⊃"필요시" 처럼 더 큰 한글
 * 단어에 낀 경우까지 오탐한다. 매칭 앞/뒤 글자가 한글 음절이면 더 큰 단어의
 * 일부로 보고 건너뛰고, 앞/뒤가 한글이 아니면(공백·문장부호·문자열 시작/끝)
 * 독립된 표현으로 보고 거부 대상으로 삼는다.
 */
export function includesBannedWord(text: string, word: string): boolean {
  let idx = text.indexOf(word);
  while (idx !== -1) {
    const before = idx > 0 ? text[idx - 1] : undefined;
    const after = idx + word.length < text.length ? text[idx + word.length] : undefined;
    const attachedToHangul =
      (before !== undefined && isHangulSyllable(before)) ||
      (after !== undefined && isHangulSyllable(after));
    if (!attachedToHangul) {
      return true;
    }
    idx = text.indexOf(word, idx + 1);
  }
  return false;
}

export interface RecordDefaults {
  project?: string;
  workitem?: string;
  id: string;
  at: string;
  /** 전역 config(~/.awl/config.json)의 author (ADK stage 1). 없으면 필드 자체를 생략한다 — 필수 아님. */
  author?: string;
}

export interface BuildResult {
  record?: Record<string, unknown>;
  missing: string[];
}

/** 새 레코드 id 를 만든다. */
export function newRecordId(): string {
  return `rec_${crypto.randomBytes(9).toString('hex')}`;
}

/**
 * 입력 데이터를 검증해 레코드를 만든다. 필수 필드가 없으면 무엇이 빠졌는지 돌려준다.
 * 이것이 구조를 강제하는 방법이다.
 *
 * 인식하는 선택 필드(records-verify-tag) — 스키마에 넣지 않아도 spread 로 그대로 보존된다
 * (D-15: 항목 내부 구조를 강제하지 않는다). `awl record attempt` 등에 붙일 수 있다:
 *   - `manualVerify: boolean` — 기계검증(awl verify)으로 못 잡고 사람이 눈으로/브라우저로
 *     직접 재확인해야 하는 항목인가.
 *   - `verifyHow: string` — 그 방법(딥링크·화면·절차). manualVerify 가 true 일 때 의미 있다.
 * 둘 다 선택이라 없으면 무시된다(하위호환). **awl brief(별도 일감)는 이 필드를 "직접 볼
 * 검증 항목(verifyItems)"의 1차 소스로 읽고, 없을 때만 UI 파일 휴리스틱으로 폴백한다** —
 * brief 가 휴리스틱에만 의존하지 않게 하는 계약. 완료조건(criteria)도 같은 필드를 담을 수
 * 있다(setCriterion 얕은 병합이 보존 — state.ts).
 */
export function buildRecord(
  type: RecordType,
  data: Record<string, unknown>,
  defaults: RecordDefaults,
): BuildResult {
  const missing: string[] = [];

  // project 는 필수다. 데이터에 없으면 config 의 project 를 쓴다.
  const project =
    (typeof data.project === 'string' && data.project.trim() !== '' && data.project) ||
    defaults.project;
  if (!project) {
    missing.push('project');
  }

  // workitem 은 필수가 아니다(work new 이전 시점의 기록도 있을 수 있다).
  // 데이터에 명시가 없으면 state.json 의 현재 워크아이템을 자동으로 태깅한다
  // — 스킬이 매번 workitem 을 직접 적어 넣어야 했던 부담을 없앤다(evolve 의
  // 워크아이템별 집계가 이 태그에 의존하므로, 빠지면 evolve --collect 가 조용히
  // 기록을 놓친다).
  const workitem =
    (typeof data.workitem === 'string' && data.workitem.trim() !== '' && data.workitem) ||
    defaults.workitem;

  const schema = SCHEMAS[type];
  for (const field of schema.required) {
    const v = data[field];
    if (v === undefined || v === null || v === '') {
      missing.push(field);
    } else if (schema.arrays?.includes(field) && (!Array.isArray(v) || v.length === 0)) {
      missing.push(`${field} (비어있지 않은 배열이어야 함)`);
    } else if (schema.arraysAllowEmpty?.includes(field) && !Array.isArray(v)) {
      missing.push(`${field} (배열이어야 함)`);
    }
  }

  // 질적 표현 금지 (WI-T AC-01): criteria 의 각 항목을 통째로 문자열화해 금지어를
  // 찾는다. 특정 필드 이름(조건/범위)에 의존하지 않는다 — 이 코드베이스는 항목
  // 내부 구조를 강제하지 않으므로(D-15), 어느 필드에 질적 표현이 남아도 잡는다.
  if (type === 'criteria' && Array.isArray(data.items)) {
    for (const item of data.items as Record<string, unknown>[]) {
      const text = JSON.stringify(item);
      for (const word of BANNED_QUALITATIVE_WORDS) {
        if (includesBannedWord(text, word)) {
          missing.push(
            `items(${String(item?.id ?? '?')}) 에 금지된 질적 표현 "${word}" — 열거 가능하거나 수치화 가능하게 다시 쓰세요`,
          );
        }
      }
    }
  }

  // 기록 상세도를 diff 크기에 맞춘다 (WI-U): why/how 는 result:failed 이거나
  // diffTier 가 minimal 이 아니면(brief/detailed/미측정) 필수다 — 실패한 시도는
  // gotcha 추출의 재료라 diff 크기와 무관하게 항상 전체 상세를 요구한다(정보
  // 손실 방지). diffTier 가 없는 경우(git 측정 실패 등)도 안전하게 전체 상세를
  // 요구한다. alternatives 는 diffTier 가 detailed 일 때만 필수다.
  if (type === 'attempt') {
    const tier = typeof data.diffTier === 'string' ? data.diffTier : undefined;
    const isFailed = data.result === 'failed';
    // result:'verified' — 코드 변경이 없는 가드/검증형 완료조건. 잴 diff 가 없으니
    // 직전 커밋 크기에 발목잡히지 않고 what 만으로 통과시킨다(피드백 F-3).
    const isVerified = data.result === 'verified';
    const requiresFullDetail = isFailed || (!isVerified && tier !== 'minimal');
    if (requiresFullDetail) {
      for (const field of ['why', 'how']) {
        const v = data[field];
        if (v === undefined || v === null || v === '') {
          missing.push(field);
        }
      }
    }
    if (tier === 'detailed') {
      const alt = data.alternatives;
      if (!Array.isArray(alt) || alt.length === 0) {
        missing.push(
          'alternatives (비어있지 않은 배열이어야 함 — diff 가 크면 설계 대안을 남겨야 합니다)',
        );
      }
    }
  }

  // 성능 재검토(WI-I AC-05): performanceSensitive:true 인 decision 은 alternatives
  // (비어있지 않은 배열)를 필수로 요구한다 — 성능 트레이드오프가 걸린 결정은 대안을
  // 최소 하나는 검토했다는 근거를 남긴다. performanceSensitive 가 없거나 false 면
  // 기존과 동일(하위호환).
  if (type === 'decision' && data.performanceSensitive === true) {
    const alt = data.alternatives;
    if (!Array.isArray(alt) || alt.length === 0) {
      missing.push(
        'alternatives (비어있지 않은 배열이어야 함 — performanceSensitive:true 인 결정은 대안을 남겨야 합니다)',
      );
    }
  }

  // narrative.kind 는 정해진 4값 중 하나여야 한다 (WI-P AC-02). 값이 아예 없는
  // 경우는 위 required 루프가 이미 'kind' 로 missing 처리하므로 여기선 건너뛴다.
  // 문자열 타입만 검사하면 숫자 등 다른 타입의 truthy 값이 두 체크를 모두
  // 통과해버리므로(리뷰 지적, WI-P 리뷰), 값이 있으면 타입 불문 enum 에 있는지 본다.
  if (type === 'narrative') {
    const kindMissing = data.kind === undefined || data.kind === null || data.kind === '';
    if (!kindMissing && !(NARRATIVE_KINDS as readonly unknown[]).includes(data.kind)) {
      missing.push(`kind (다음 중 하나여야 함: ${NARRATIVE_KINDS.join(', ')})`);
    }
  }

  // gate.gate 는 1~4여야 하고, decision 은 그 게이트에서만 허용되는 값이어야
  // 한다(WI-Q AC-01, ADK stage 2a 로 3/4 추가) — 게이트마다 서로 다른 의미의
  // 결정을 갖기 때문이다(예: 게이트 1엔 "split"이 있지만 게이트 2엔 없다).
  // narrative.kind 와 같은 특수 분기 패턴을 재사용한다(D-35).
  //
  // 게이트 1/2 는 레거시다 — layer 없이 불러도(기존 awl-loop 스킬이 그렇게 부른다)
  // 검증·동작이 예전과 100% 동일하다. layer 를 같이 줘도(정보성 태그) decision
  // 검증 목록은 안 바뀐다. 게이트 3/4 는 ADK stage 2a 신규라 레거시 호출자가
  // 없으므로, 처음부터 각각 layer:'ticket'/'request' 를 명시하도록 강제한다.
  if (type === 'gate') {
    const gateMissing = data.gate === undefined || data.gate === null || data.gate === '';
    const gate = data.gate;
    const validGate = gate === 1 || gate === 2 || gate === 3 || gate === 4;
    if (!gateMissing && !validGate) {
      missing.push('gate (1, 2, 3, 4 중 하나여야 함)');
    }

    const layer = data.layer;
    const layerMissing = layer === undefined || layer === null || layer === '';
    if (!layerMissing && !(GATE_LAYERS as readonly unknown[]).includes(layer)) {
      missing.push(`layer (${GATE_LAYERS.join(' 또는 ')} 여야 함)`);
    }
    if (!gateMissing && gate === 3 && layer !== 'ticket') {
      missing.push("layer ('ticket' 이어야 함 — gate 3 은 티켓 완료 게이트)");
    }
    if (!gateMissing && gate === 4 && layer !== 'request') {
      missing.push("layer ('request' 이어야 함 — gate 4 는 요청 닫기 게이트)");
    }

    // gate 2/3 을 layer:'ticket' 으로 기록하면(ADK stage 2b) 어느 티켓의 status 를
    // 전이시킬지 알아야 한다 — ticket(그 티켓의 id)이 필수다.
    if (!gateMissing && (gate === 2 || gate === 3) && layer === 'ticket') {
      const ticketMissing = data.ticket === undefined || data.ticket === null || data.ticket === '';
      if (ticketMissing) {
        missing.push("ticket (gate 2/3 을 layer:'ticket' 으로 기록하려면 필수)");
      }
    }

    // gate 1/4 를 layer:'request' 로 기록하면(ADK stage 3) 어느 스펙의 status 를
    // 전이시킬지 알아야 한다 — spec(그 스펙의 id)이 필수다. 레거시 gate 1(layer 없이
    // 부르는 기존 awl-loop 스킬 호출)은 이 조건에 안 걸린다 — layer==='request' 일
    // 때만 요구한다(ticket 필드와 동일한 조건부 구조).
    if (!gateMissing && (gate === 1 || gate === 4) && layer === 'request') {
      const specMissing = data.spec === undefined || data.spec === null || data.spec === '';
      if (specMissing) {
        missing.push("spec (gate 1/4 를 layer:'request' 로 기록하려면 필수)");
      }
    }

    const decisionMissing =
      data.decision === undefined || data.decision === null || data.decision === '';
    if (!decisionMissing && validGate) {
      const allowed =
        gate === 1
          ? GATE1_DECISIONS
          : gate === 2
            ? GATE2_DECISIONS
            : gate === 3
              ? GATE3_DECISIONS
              : GATE4_DECISIONS;
      if (!(allowed as readonly unknown[]).includes(data.decision)) {
        missing.push(`decision (gate ${gate} 에서는 다음 중 하나여야 함: ${allowed.join(', ')})`);
      }
    }
  }

  // awl-feedback.area/severity 는 정해진 값 중 하나여야 한다(narrative.kind 와 같은
  // 특수 분기, D-35). 값이 아예 없는 경우는 위 required 루프가 이미 missing 처리한다.
  if (type === 'awl-feedback') {
    const areaMissing = data.area === undefined || data.area === null || data.area === '';
    if (!areaMissing && !(AWL_FEEDBACK_AREAS as readonly unknown[]).includes(data.area)) {
      missing.push(`area (다음 중 하나여야 함: ${AWL_FEEDBACK_AREAS.join(', ')})`);
    }
    const sevMissing =
      data.severity === undefined || data.severity === null || data.severity === '';
    if (!sevMissing && !(AWL_FEEDBACK_SEVERITIES as readonly unknown[]).includes(data.severity)) {
      missing.push(`severity (다음 중 하나여야 함: ${AWL_FEEDBACK_SEVERITIES.join(', ')})`);
    }
  }

  // defer.severity 도 정해진 값 중 하나여야 한다(awl-feedback 과 같은 특수 분기).
  if (type === 'defer') {
    const sevMissing =
      data.severity === undefined || data.severity === null || data.severity === '';
    if (!sevMissing && !(DEFER_SEVERITIES as readonly unknown[]).includes(data.severity)) {
      missing.push(`severity (다음 중 하나여야 함: ${DEFER_SEVERITIES.join(', ')})`);
    }
  }

  // review.findings 의 각 항목은 어느 제약(rule)을 지목했는지 표현해야 한다(ADK
  // stage 6, EARS: "리뷰어가 제약을 지목하지 않으면 '없음'을 명시해야 한다"). D-15
  // (중첩 구조 비강제)의 의도적이고 좁은 예외다 — findings 항목 전체가 아니라
  // ruleId 딱 한 키만 요구한다. 값은 실재하는 rule id 이거나 리터럴 '없음'.
  // rules.ts 를 정적으로 import 하지 않는다 — rules.ts → evolve.ts → record.ts 로
  // 이미 순환 고리가 있어(evolve.ts 가 record.ts 의 readRecords/computeCoverage 를
  // 쓴다), activeRulesDir() 의 경로 계산만 rulesDir(paths.js, 순환 없음)로 직접
  // 재현한다(established: 작은 조회는 로컬로 복제, lane.ts/doc.ts 순환 회피와 동일 원칙).
  if (type === 'review' && Array.isArray(data.findings)) {
    for (const finding of data.findings as Record<string, unknown>[]) {
      const ruleId = (finding as Record<string, unknown> | null)?.ruleId;
      if (typeof ruleId !== 'string' || ruleId.trim() === '') {
        missing.push(
          `findings(${String((finding as Record<string, unknown> | null)?.id ?? '?')}) 에 ruleId 가 없습니다 — 어느 제약을 지목하는지, 없으면 '없음'을 적으세요`,
        );
        continue;
      }
      if (ruleId !== '없음' && !fs.existsSync(path.join(rulesDir(), 'active', `${ruleId}.md`))) {
        missing.push(`findings 의 ruleId "${ruleId}" 에 해당하는 규칙을 찾을 수 없습니다`);
      }
    }
  }

  // refactor.kind 도 정해진 값 중 하나여야 한다(narrative.kind 와 같은 특수 분기).
  if (type === 'refactor') {
    const kindMissing = data.kind === undefined || data.kind === null || data.kind === '';
    if (!kindMissing && !(REFACTOR_KINDS as readonly unknown[]).includes(data.kind)) {
      missing.push(`kind (다음 중 하나여야 함: ${REFACTOR_KINDS.join(', ')})`);
    }
  }

  if (missing.length > 0) {
    return { missing };
  }

  // workitem 은 spread(...data)로 새어 들어올 수 있으니 먼저 떼어내고,
  // 계산된 workitem 이 있을 때만 다시 붙인다(delete 대신 — lint/performance/noDelete).
  const { workitem: _dataWorkitem, ...dataWithoutWorkitem } = data;
  const record: Record<string, unknown> = {
    id: defaults.id,
    at: defaults.at,
    project,
    type,
    ...dataWithoutWorkitem,
  };
  record.project = project;
  record.type = type;
  record.id = defaults.id;
  record.at = defaults.at;
  if (workitem) {
    record.workitem = workitem;
  }
  if (defaults.author) {
    record.author = defaults.author;
  }
  return { record, missing: [] };
}

/**
 * blocked 기록에 붙일 baseline(커밋 SHA)을 찾는다. 순수 함수(테스트 가능).
 * data.criterion 이 명시되면 그걸 쓰고, 없으면 state.currentFocus 로 추론한다.
 * 그 완료 조건에 baseline 이 없으면(예: commit --start 를 안 한 경우) undefined.
 */
export function resolveBlockedBaseline(
  data: Record<string, unknown>,
  state: Record<string, unknown>,
): string | undefined {
  const focus =
    (typeof data.criterion === 'string' && data.criterion) ||
    (typeof state.currentFocus === 'string' ? state.currentFocus : undefined);
  if (!focus) {
    return undefined;
  }
  const crit = getCriterion(state, focus);
  return crit && typeof crit.baseline === 'string' ? crit.baseline : undefined;
}

export interface DiffSize {
  files: number;
  lines: number;
}

export type AttemptDetailTier = 'minimal' | 'brief' | 'detailed';

/**
 * diff 크기로 attempt 기록에 필요한 상세도를 정한다(WI-U). 순수 함수.
 * 파일 3개 이상이거나 줄 50개 이상이면 detailed, 파일 1개 이하고 줄 10개
 * 미만이면 minimal, 나머지는 brief.
 */
export function detailTierFor(size: DiffSize): AttemptDetailTier {
  if (size.files >= 3 || size.lines >= 50) {
    return 'detailed';
  }
  if (size.files <= 1 && size.lines < 10) {
    return 'minimal';
  }
  return 'brief';
}

/**
 * git 명령을 돌려 numstat 출력(파일당 "추가\t삭제\t파일명")에서 파일 수와
 * 변경 줄 수 합을 잰다(WI-U). 명령이 실패하면(ref 없음 등) null — 호출부가
 * diffTier 를 안 넣고 안전하게 넘어간다.
 */
export async function measureDiffSize(cwd: string, args: string[]): Promise<DiffSize | null> {
  const r = await run({ cmd: 'git', args, cwd, timeoutMs: 10000 });
  if (r.exitCode !== 0) {
    return null;
  }
  const rows = r.stdout.split('\n').filter((l) => l.trim() !== '');
  let lines = 0;
  for (const row of rows) {
    const [add, del] = row.split('\t');
    lines += (Number(add) || 0) + (Number(del) || 0);
  }
  return { files: rows.length, lines };
}

export interface CoverageResult {
  auditFindingIds: string[];
  addressedIds: string[];
  excludedIds: string[];
}

/**
 * audit 기록의 findings 와 완료 조건의 addresses 를 대조해 커버리지를 계산한다
 * (WI-T AC-02/AC-04). 순수 함수(테스트 가능). id 가 없거나 문자열이 아닌 finding/
 * addresses 항목은 조용히 건너뛴다 — 이 코드베이스는 중첩 배열 항목의 내부 구조를
 * 강제하지 않으므로(D-15), 이 관례 이전에 쓰인 audit 기록도 죽지 않고 읽힌다.
 *
 * criteriaRecords(선택, awl record criteria 의 append-only 이력)는 state.criteria
 * 에 addresses 가 없는 완료조건만 보완한다(WI-T AC-06, 리뷰 지적 high) — 스킬이
 * `awl state set` 을 예시 그대로(addresses 없이) 쳐도 방금 `awl record criteria`
 * 로 남긴 addresses 가 배제 판정에서 빠지지 않는다. state.criteria 에 addresses
 * 가 이미 있으면(빈 배열이라도) 그게 최신이므로 우선한다.
 */
export function computeCoverage(
  auditRecords: Record<string, unknown>[],
  criteria: Record<string, unknown>[],
  criteriaRecords: Record<string, unknown>[] = [],
): CoverageResult {
  const findingIds = new Set<string>();
  for (const r of auditRecords) {
    const findings = Array.isArray(r.findings) ? r.findings : [];
    for (const f of findings) {
      if (f && typeof f === 'object' && typeof (f as Record<string, unknown>).id === 'string') {
        findingIds.add((f as Record<string, unknown>).id as string);
      }
    }
  }

  const addressedRefs = new Set<string>();
  const stateHasAddresses = new Set<string>();
  for (const c of criteria) {
    if (Array.isArray(c.addresses)) {
      stateHasAddresses.add(String(c.id));
      for (const a of c.addresses) {
        if (typeof a === 'string') {
          addressedRefs.add(a);
        }
      }
    }
  }
  for (const rec of criteriaRecords) {
    const items = Array.isArray(rec.items) ? rec.items : [];
    for (const item of items) {
      const id =
        item && typeof item === 'object' ? (item as Record<string, unknown>).id : undefined;
      if (typeof id !== 'string' || stateHasAddresses.has(id)) {
        continue;
      }
      const addresses = (item as Record<string, unknown>).addresses;
      if (Array.isArray(addresses)) {
        for (const a of addresses) {
          if (typeof a === 'string') {
            addressedRefs.add(a);
          }
        }
      }
    }
  }

  const auditFindingIds = [...findingIds];
  const addressedIds = auditFindingIds.filter((id) => addressedRefs.has(id));
  const excludedIds = auditFindingIds.filter((id) => !addressedRefs.has(id));
  return { auditFindingIds, addressedIds, excludedIds };
}

/** records-suffix.json 이 있으면 그 접미사를, 없으면(메인) undefined 를 돌려준다. */
function readRecordsSuffix(projectRoot: string): string | undefined {
  try {
    const raw = JSON.parse(fs.readFileSync(recordsSuffixPath(projectRoot), 'utf8')) as unknown;
    const suffix =
      raw && typeof raw === 'object' ? (raw as Record<string, unknown>).suffix : undefined;
    return typeof suffix === 'string' && suffix.trim() !== '' ? suffix : undefined;
  } catch {
    return undefined;
  }
}

/**
 * at(ISO) 에서 YYYY-MM 월 파일 이름을 만든다. records-suffix.json 이 있으면(레인
 * 워크트리·격리 세션) `YYYY-MM.<접미사>.jsonl` — 같은 디렉토리 안에서 파일명으로만
 * 나뉘어 쓰기 경합이 없다(레인과 토큰, adk-reference.md:576-591).
 */
export function monthFile(at: string, projectRoot: string): string {
  const month = at.slice(0, 7); // YYYY-MM
  const suffix = readRecordsSuffix(projectRoot);
  const name = suffix ? `${month}.${suffix}.jsonl` : `${month}.jsonl`;
  return path.join(recordsDir(projectRoot), name);
}

/** 레코드를 월별 JSONL 에 append 한다. 절대 수정하지 않는다. */
export function appendRecord(record: Record<string, unknown>, projectRoot: string): string {
  const file = monthFile(String(record.at), projectRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(record)}\n`);
  return file;
}

/** git diff 를 캡처해 patch 파일로 저장하고 상대경로를 돌려준다. */
export async function captureDiff(id: string, at: string, cwd: string): Promise<string | null> {
  const r = await run({ cmd: 'git', args: ['diff', 'HEAD'], cwd, timeoutMs: 10000 });
  if (r.exitCode !== 0 && r.stdout.trim() === '') {
    return null;
  }
  const diffsDir = path.join(recordsDir(cwd), 'diffs');
  fs.mkdirSync(diffsDir, { recursive: true });
  const name = `${at.slice(0, 10)}-${id}.patch`;
  fs.writeFileSync(path.join(diffsDir, name), r.stdout);
  return path.join('diffs', name);
}

// ---------------------------------------------------------------------------
// 조회
// ---------------------------------------------------------------------------

export interface RecordFilter {
  type?: string;
  workitem?: string;
  /** 읽을 월 파일(YYYY-MM). 지정하면 이 월만 읽는다(하위호환: 없으면 전량). */
  months?: string[];
  /** 기간 시작(YYYY-MM, 포함). from/to 는 months 가 없을 때만 쓰인다. */
  from?: string;
  /** 기간 끝(YYYY-MM, 포함). */
  to?: string;
}

/**
 * 월 파일명 배열에서 filter 의 기간에 드는 것만 고른다(순수, I/O 없음).
 *
 * 쓰기는 monthFile 이 YYYY-MM.jsonl 로 분할하는데 읽기가 전 파일을 순회하던 걸 끊는다.
 * months(명시 목록)가 우선, 없으면 from/to(YYYY-MM 문자열 비교로 포함 범위), 둘 다 없으면
 * 전량(.jsonl 만) — 기존 호출부는 그대로 전량을 받는다(하위호환).
 *
 * months 가 배열이면 길이와 무관하게 "월로 거른다"는 뜻이다 — 빈 배열([])은 전량 폴백이
 * 아니라 매치 0개(명시적 빈 필터)다. "월로 안 거른다(전량)"는 months 를 아예 주지 않는 것
 * (undefined)으로 표현한다. 월목록을 계산해 넘기는 호출부가 빈 결과를 기대하다 전량 로드로
 * 역행하는 함정을 막는다(리뷰 지적, AC-04).
 */
export function selectMonthFiles(files: string[], filter: RecordFilter = {}): string[] {
  const jsonl = files.filter((f) => f.endsWith('.jsonl'));
  const monthOf = (f: string): string => f.slice(0, 7); // 'YYYY-MM.jsonl' → 'YYYY-MM'
  if (Array.isArray(filter.months)) {
    const set = new Set(filter.months);
    return jsonl.filter((f) => set.has(monthOf(f)));
  }
  if (filter.from !== undefined || filter.to !== undefined) {
    const from = filter.from ?? '0000-00';
    const to = filter.to ?? '9999-99';
    return jsonl.filter((f) => {
      const m = monthOf(f);
      return m >= from && m <= to;
    });
  }
  return jsonl;
}

/**
 * 월별 JSONL 을 읽어 레코드 배열을 돌려준다(파싱 실패 줄은 건너뜀).
 * filter 에 months/from/to 가 있으면 그 월 파일만 읽는다(selectMonthFiles) — 전량 로드 회피.
 * projectRoot 의 records/ 디렉토리 전체를 훑는다 — 레인 접미사가 붙은 파일도
 * `.jsonl` 로 끝나기만 하면 자연히 걸린다(별도 매칭 로직 불필요, monthOf 의
 * slice(0,7) 도 접미사 유무와 무관하게 YYYY-MM 을 정확히 뽑는다).
 */
export function readRecords(
  projectRoot: string,
  filter: RecordFilter = {},
): Record<string, unknown>[] {
  const dir = recordsDir(projectRoot);
  let files: string[];
  try {
    files = selectMonthFiles(fs.readdirSync(dir), filter);
  } catch {
    return [];
  }
  const records: Record<string, unknown>[] = [];
  for (const f of files.sort()) {
    let text: string;
    try {
      text = fs.readFileSync(path.join(dir, f), 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      if (line.trim() === '') {
        continue;
      }
      try {
        records.push(JSON.parse(line) as Record<string, unknown>);
      } catch {
        // 깨진 줄은 건너뛴다.
      }
    }
  }
  const filtered = records.filter((r) => {
    if (filter.type && r.type !== filter.type) {
      return false;
    }
    if (filter.workitem && r.workitem !== filter.workitem) {
      return false;
    }
    return true;
  });
  // 최근이 위로.
  filtered.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  return filtered;
}

/** 사람에게 최종 문의할 보류 항목(보류 큐, skip-gate-defer AC-02). */
export interface DeferItem {
  severity: string;
  what: string;
  why: string;
  recommendation?: string;
  gate?: unknown;
  /** 어느 audit finding 을 보류하는가(선택). 문서화된 defer 선택 필드라 요약에도 싣는다. */
  addresses?: unknown;
  at: string;
}

/**
 * defer 기록을 severity 높은 순(같으면 최근 순)으로 수집한다(순수).
 * defer 아닌 기록은 버린다. 알 수 없는 severity 는 맨 뒤로 민다.
 */
export function collectDeferred(records: Record<string, unknown>[]): DeferItem[] {
  const levels = DEFER_SEVERITIES as readonly string[];
  const rank = (s: string): number => {
    const i = levels.indexOf(s);
    return i === -1 ? levels.length : i;
  };
  return records
    .filter((r) => r.type === 'defer')
    .map((r) => ({
      severity: String(r.severity ?? ''),
      what: String(r.what ?? ''),
      why: String(r.why ?? ''),
      recommendation: typeof r.recommendation === 'string' ? r.recommendation : undefined,
      gate: r.gate,
      addresses: r.addresses,
      at: String(r.at ?? ''),
    }))
    .sort((a, b) => {
      const d = rank(a.severity) - rank(b.severity);
      return d !== 0 ? d : b.at.localeCompare(a.at);
    });
}

/** defer 큐를 사람용으로 렌더한다(최종 요약). 가이드가 아니라 목록이다. */
export function renderDeferSummary(items: DeferItem[]): string {
  if (items.length === 0) {
    return '보류 큐가 비어있습니다(사람 확인이 필요한 중요 항목 없음).';
  }
  const lines = [`보류 ${items.length}건 — 사람 최종 확인 필요:`];
  for (const it of items) {
    lines.push(`  [${it.severity}] ${it.what}`);
    lines.push(`      왜 중요: ${it.why}`);
    if (it.recommendation !== undefined) {
      lines.push(`      권장(자율 시): ${it.recommendation}`);
    }
  }
  return lines.join('\n');
}

/**
 * awl defer-summary — 보류 큐(사람 최종 확인 항목)를 최종 요약한다.
 * workitem 미지정이면 state 의 현재 워크아이템. awl 은 요약만 낸다 — 판단은 사람.
 */
export function runDeferSummary(opts: { json?: boolean; workitem?: string }): void {
  const projectRoot = resolveProjectRoot();
  let workitem = opts.workitem;
  if (workitem === undefined && projectRoot) {
    const state = loadState(projectRoot);
    workitem =
      typeof state.workitem === 'string' && state.workitem.trim() !== ''
        ? state.workitem
        : undefined;
  }
  const items = collectDeferred(
    projectRoot ? readRecords(projectRoot, { type: 'defer', workitem }) : [],
  );
  if (opts.json === true) {
    process.stdout.write(`${JSON.stringify({ workitem, count: items.length, items }, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${renderDeferSummary(items)}\n`);
}

/**
 * 이 워크아이템에 "승인된" 게이트1 레코드가 있는가 (0.6.3, 적대검증 발견 수정).
 *
 * 게이트 통과 판정을 가변 phase 문자열이 아니라 append-only gate 레코드로 한다.
 * phase 는 스킬이 `awl state set` 으로 바꿀 수 있어(hidden 명령), 사람이 REJECT 한
 * 계획이나 임의 조작한 phase 로 루프 진입/게이트 전 커밋을 우회할 수 있었다.
 * decision==='approved' 만 인정한다 — `record gate` 의 loop 자동전이 조건과 일관.
 * workitem 이 falsy 면 확인할 게이트 레코드가 없다는 뜻이므로 fail-closed(false).
 * projectRoot 가 null 이어도(프로젝트를 못 찾음) 마찬가지로 fail-closed.
 */
export function hasApprovedGate1(
  workitem: string | undefined,
  projectRoot: string | null,
): boolean {
  if (typeof workitem !== 'string' || workitem === '' || !projectRoot) {
    return false;
  }
  return readRecords(projectRoot, { type: 'gate', workitem }).some(
    (r) => r.gate === 1 && r.decision === 'approved',
  );
}

/**
 * 한 줄 요약(what/scope/question 등 대표 필드). 줄글을 쏟지 않는다.
 *
 * review 타입은 WI-S 부터 target/verdict 대신 reviewId/findings 를 쓴다(리뷰 지적,
 * WI-S AC-06) — 마이그레이션 이전 기록(target 만 있는)은 reviewId 가 없으므로
 * 아래 fallback 체인이 그대로 target 을 집어 하위호환을 지킨다.
 */
function summaryOf(r: Record<string, unknown>): string {
  if (r.type === 'review' && typeof r.reviewId === 'string') {
    const findings = Array.isArray(r.findings) ? r.findings.length : 0;
    const cheating = Array.isArray(r.cheatingDetected) ? r.cheatingDetected.length : 0;
    const cheatingNote = cheating > 0 ? `, 부정행위 ${cheating}건` : '';
    return `${r.reviewId} — findings ${findings}건${cheatingNote}`;
  }
  const cand = r.what ?? r.scope ?? r.question ?? r.target ?? r.decision ?? '(요약 없음)';
  return String(cand);
}

/** 사람이 읽는 목록. what 만 보여주고 상세는 요청 시 펼친다. */
export function renderRecords(records: Record<string, unknown>[], c: Caps): string {
  const color = makeColors(c.color);
  if (records.length === 0) {
    return sectionBox('기록', ['기록이 없습니다.'], c);
  }
  const out: string[] = [];
  for (const r of records) {
    const type = String(r.type).padEnd(9, ' ');
    const wi = r.workitem ? `${String(r.workitem)} ` : '';
    const date = String(r.at).slice(0, 10);
    out.push(`${color.dim(date)}  ${color.bold(type)} ${color.dim(wi)}${summaryOf(r)}`);
  }
  out.push('');
  out.push(color.dim('상세는 awl records --json 또는 ~/.awl/records/ 를 보세요.'));
  return sectionBox(`기록 ${records.length}개 · 최근순`, out, c);
}

// ---------------------------------------------------------------------------
// 명령 진입점
// ---------------------------------------------------------------------------

export interface RecordCliOpts {
  json?: string;
  file?: string;
  diff?: boolean;
  workitem?: string;
}

/** awl record <type> — 스킬이 치는 명령. */
export async function runRecord(type: string, opts: RecordCliOpts): Promise<void> {
  if (!RECORD_TYPES.includes(type as RecordType)) {
    process.stderr.write(
      `\n  ${signal(caps(), 'error')} 알 수 없는 기록 타입: ${type}\n  가능: ${RECORD_TYPES.join(', ')}\n`,
    );
    process.exit(1);
  }

  let data: Record<string, unknown> = {};
  try {
    if (opts.file) {
      data = JSON.parse(fs.readFileSync(opts.file, 'utf8'));
    } else if (opts.json) {
      data = JSON.parse(opts.json);
    }
  } catch (e) {
    process.stderr.write(
      `\n  ${signal(caps(), 'error')} 데이터 JSON 을 읽지 못했습니다: ${String(e)}\n`,
    );
    process.exit(1);
  }
  if (typeof data !== 'object' || data === null) {
    process.stderr.write(`\n  ${signal(caps(), 'error')} 데이터는 JSON 객체여야 합니다.\n`);
    process.exit(1);
  }

  const projectRoot = resolveProjectRoot();
  let projectFromConfig: string | undefined;
  let currentWorkitem: string | undefined;
  let state: Record<string, unknown> = {};
  if (projectRoot) {
    projectFromConfig = loadProjectName(projectRoot);
    state = loadState(projectRoot);
    currentWorkitem =
      typeof state.workitem === 'string' && state.workitem.trim() !== ''
        ? state.workitem
        : undefined;
  }
  // 활성 워크아이템 강제 (WI-R AC-01) — 데이터(JSON)에 명시된 workitem, --workitem
  // 플래그, state.json 의 현재 워크아이템 중 무엇도 없으면 거부한다. 우선순위는
  // buildRecord 의 우선순위(데이터 > defaults)와 일치시킨다: 여기서는 defaults 로
  // 넘길 값(cliWorkitem ?? currentWorkitem)만 고르고, data.workitem 우선은
  // buildRecord 안에서 그대로 처리된다.
  const dataWorkitem =
    typeof data.workitem === 'string' && data.workitem.trim() !== '' ? data.workitem : undefined;
  const cliWorkitem =
    typeof opts.workitem === 'string' && opts.workitem.trim() !== '' ? opts.workitem : undefined;
  const defaultWorkitem = cliWorkitem ?? currentWorkitem;
  if (!dataWorkitem && !defaultWorkitem) {
    // 리뷰 지적(WI-R): projectRoot 자체를 못 찾은 경우(state.json 을 아예 못 읽음)엔
    // "활성 워크아이템이 없다"는 말이 진짜 원인(프로젝트 미초기화)을 안 알려준다.
    const hint = projectRoot
      ? ''
      : ' (프로젝트 루트를 찾지 못했습니다 — awl init 을 실행했는지 확인하세요.)';
    process.stderr.write(
      `\n  ${signal(caps(), 'error')} 활성 워크아이템이 없습니다.${hint} awl work new <id> [설명] 으로 시작하세요.\n  (이 기록 하나만 다른 워크아이템으로 남기려면 --workitem <id> 를 쓰세요)\n`,
    );
    process.exit(1);
  }
  // records 가 project-local(.awl/records/) 이라(WI-G17a) data.workitem 만 주고
  // 프로젝트를 못 찾으면 쓸 곳이 없다 — 위 워크아이템 가드는 이 조합을 통과시키므로
  // (dataWorkitem 만으로도 만족) 여기서 별도로 막는다.
  if (!projectRoot) {
    process.stderr.write(
      `\n  ${signal(caps(), 'error')} 프로젝트 루트를 찾을 수 없어 기록을 남길 곳이 없습니다. awl init 을 실행했는지 확인하세요.\n`,
    );
    process.exit(1);
    return;
  }

  const id = newRecordId();
  const at = new Date().toISOString();

  // blocked --diff: git diff 를 캡처해 첨부한다.
  if (opts.diff && type === 'blocked' && projectRoot && data.diff === undefined) {
    const rel = await captureDiff(id, at, projectRoot);
    if (rel) {
      data.diff = rel;
    }
  }

  // 게이트 기록에 로컬 스킬 오버라이드를 자동 첨부한다(ADK stage 4,
  // prototype.md:519-524 "스킬을 바꾸는 건 정보다"). profile.local.json 이 어떤
  // 슬롯을 바꿨는지는 doctor 에만 표시되고 기록엔 안 남았다 — 게이트 순간의
  // 스킬 출처를 놓치면 나중에 "그때 왜 이 방식으로 했나"를 못 되짚는다. 없으면
  // 필드를 안 만든다(D-21).
  if (type === 'gate' && projectRoot && data.localSkills === undefined) {
    const loadedProfile = loadProfile(projectRoot);
    if (loadedProfile.profile) {
      const localSlots = (Object.keys(loadedProfile.sources) as SkillSlot[]).filter(
        (slot) => loadedProfile.sources[slot] === 'local',
      );
      if (localSlots.length > 0) {
        data.localSkills = localSlots;
      }
    }
  }

  // blocked 에만 baseline SHA 를 붙인다(막힌 코드를 버리므로 출발점 복원에 필요).
  // 나머지 타입에는 넣지 않는다 — 안 쓰는 필드를 만들지 않는다(WI-7 D-21).
  if (type === 'blocked' && projectRoot && data.baseline === undefined) {
    const baseline = resolveBlockedBaseline(data, state);
    if (baseline) {
      data.baseline = baseline;
    }
  }

  // attempt 의 diffTier 를 diff 크기로 잰다 (WI-U). result:passed 는 awl commit
  // 이 방금 만든 커밋(스킬 흐름상 이 직전 명령)을, result:failed 는 아직
  // 커밋 안 된 작업트리를 잰다 — state.currentFocus 같은 별도 상태에 기대지
  // 않는다(그 필드는 스킬이 채우도록 지시된 적이 없어 실사용에서 항상 비어
  // 있다). 측정에 실패하면(커밋 이력 없음 등) diffTier 를 안 넣는다 —
  // buildRecord 가 diffTier 없이도 안전하게(전체 상세 요구) 처리한다.
  // result:'verified'(무변경 가드/검증형)는 잴 변경이 없으므로 직전 커밋을 재지 않는다(F-3).
  if (
    type === 'attempt' &&
    projectRoot &&
    data.diffTier === undefined &&
    data.result !== 'verified'
  ) {
    const diffArgs =
      data.result === 'failed'
        ? ['diff', '--numstat', 'HEAD']
        : ['show', '--numstat', '--format=', 'HEAD'];
    const size = await measureDiffSize(projectRoot, diffArgs);
    if (size) {
      const tier = detailTierFor(size);
      data.diffTier = tier;
      const guidance =
        tier === 'minimal'
          ? 'what 만 있으면 됩니다.'
          : tier === 'detailed'
            ? 'what/why/how 와 alternatives(설계 대안)를 채우세요.'
            : 'what/why/how 를 채우세요.';
      process.stderr.write(`\n  이 변경은 ${size.lines}줄/${size.files}파일입니다. ${guidance}\n`);
    }
  }

  // 사람이 손으로 남기는 awl-feedback 도 자동수집(core/auto-feedback.ts)과 같은
  // 방어를 받는다 — 절대경로는 사람이 직접 쓸 때도 새어나갈 수 있다.
  if (type === 'awl-feedback') {
    if (typeof data.what === 'string') {
      data.what = redactAbsolutePaths(data.what, os.homedir(), projectRoot);
    }
    if (typeof data.impact === 'string') {
      data.impact = redactAbsolutePaths(data.impact, os.homedir(), projectRoot);
    }
  }

  const { record, missing } = buildRecord(type as RecordType, data, {
    project: projectFromConfig,
    workitem: defaultWorkitem,
    id,
    at,
    author: resolveEffectiveAuthor(projectRoot),
  });
  if (!record) {
    process.stderr.write(
      `\n  ${signal(caps(), 'error')} 기록을 거부했습니다. 빠진 필수 필드: ${missing.join(', ')}\n`,
    );
    process.stderr.write(
      `  ${type} 에 필요한 필드: ${SCHEMAS[type as RecordType].required.join(', ')}\n`,
    );
    process.exit(1);
  }

  // 게이트 1 배제 목록 강제 (WI-T AC-02, 핵심) — audit findings 중 어떤 완료
  // 조건의 addresses 도 안 가리키는 게 있는데 presentedExclusions 로 명시 제시하지
  // 않으면 거부한다(파일에 안 쓴다). "배제는 판단이다. 판단은 게이트를 거쳐야
  // 한다"는 스펙 원문 그대로 — 사후 경고로는 이 구멍을 못 막는다. G-020 과 같은
  // fail-open 을 피하려고 workitem 이 string 일 때만 계산한다.
  if (type === 'gate' && data.gate === 1) {
    const workitemForCheck = typeof record.workitem === 'string' ? record.workitem : undefined;
    if (workitemForCheck && projectRoot) {
      const criteria = Array.isArray(state.criteria)
        ? (state.criteria as Record<string, unknown>[])
        : [];
      const auditRecords = readRecords(projectRoot, { type: 'audit', workitem: workitemForCheck });
      const criteriaRecords = readRecords(projectRoot, {
        type: 'criteria',
        workitem: workitemForCheck,
      });
      const coverage = computeCoverage(auditRecords, criteria, criteriaRecords);
      if (coverage.excludedIds.length > 0) {
        const presented = Array.isArray(data.presentedExclusions) ? data.presentedExclusions : [];
        const presentedIds = new Set(
          presented
            .map((p) => (typeof p === 'string' ? p : (p as Record<string, unknown>)?.id))
            .filter((id): id is string => typeof id === 'string'),
        );
        const uncovered = coverage.excludedIds.filter((id) => !presentedIds.has(id));
        if (uncovered.length > 0) {
          process.stderr.write(
            `\n  ${signal(caps(), 'error')} 게이트 1 기록을 거부했습니다. 다음 발견이 완료 조건의 addresses 에도, presentedExclusions 에도 없습니다: ${uncovered.join(', ')}\n  완료 조건에 addresses 로 연결하거나, presentedExclusions 에 담아 사람에게 제시하세요.\n`,
          );
          process.exit(1);
        }
      }
    }
  }

  // gate 2/3 을 layer:'ticket' 으로 기록하면(ADK stage 2b) 가리키는 티켓이 실제로
  // 있어야 한다 — 없는 티켓을 가리키는 게이트 기록이 남는 걸 기록 전에 막는다.
  let ticketPathForTransition: string | null = null;
  if (
    projectRoot &&
    type === 'gate' &&
    (data.gate === 2 || data.gate === 3) &&
    data.layer === 'ticket'
  ) {
    const ticketId = typeof data.ticket === 'string' ? data.ticket : '';
    ticketPathForTransition = ticketId ? findTicketFileById(projectRoot, ticketId) : null;
    if (!ticketPathForTransition) {
      process.stderr.write(
        `\n  ${signal(caps(), 'error')} 티켓을 찾을 수 없습니다: ${ticketId || '(비어있음)'}\n`,
      );
      process.exit(1);
    }
  }

  // gate 1/4 를 layer:'request' 로 기록하면(ADK stage 3) 가리키는 스펙이 실제로
  // 있어야 한다 — ticketPathForTransition 과 완전히 같은 이유·구조.
  let specPathForTransition: string | null = null;
  if (
    projectRoot &&
    type === 'gate' &&
    (data.gate === 1 || data.gate === 4) &&
    data.layer === 'request'
  ) {
    const specId = typeof data.spec === 'string' ? data.spec : '';
    specPathForTransition = specId ? findSpecFileById(projectRoot, specId) : null;
    if (!specPathForTransition) {
      process.stderr.write(
        `\n  ${signal(caps(), 'error')} 스펙을 찾을 수 없습니다: ${specId || '(비어있음)'}\n`,
      );
      process.exit(1);
    }
  }

  const file = appendRecord(record, projectRoot);

  // 승인 기록 자체가 Gate 1 대기 상태를 해제한다. state set을 별도로 허용하면
  // 계획 승인 없이 phase만 바꾸는 우회 경로가 생기므로 여기서만 전이한다.
  if (projectRoot && type === 'gate' && data.gate === 1 && data.decision === 'approved') {
    writeState(projectRoot, { ...state, phase: 'loop', loop: 'loop' });
  }

  // gate 2/3(layer:'ticket') 이 그 티켓의 status 를 전이시킨다(ADK stage 2b).
  // gate 1/4(request 레이어)·레거시 gate 1/2(layer 없음)는 이 표 자체를 안 탄다.
  if (
    ticketPathForTransition &&
    typeof data.gate === 'number' &&
    typeof data.decision === 'string'
  ) {
    const nextStatus = TICKET_STATUS_TRANSITIONS[data.gate]?.[data.decision];
    if (nextStatus) {
      writeTicketStatus(ticketPathForTransition, nextStatus);
      // 티켓이 done 이 된 순간 이 프로젝트의 밀린 기록을 전송한다(ADK stage 3, prototype.md:402).
      if (nextStatus === 'done' && projectRoot && projectFromConfig) {
        await syncProjectRecords(projectRoot, projectFromConfig);
      }
    }
  }

  // gate 1/4(layer:'request') 가 그 스펙의 status 를 전이시킨다(ADK stage 3).
  // gate:4 의 'hold' 는 SPEC_STATUS_TRANSITIONS 에 항목이 없어 nextStatus 가
  // undefined 이므로 아래 가드에서 자연히 전이가 안 일어난다(active 유지).
  if (
    specPathForTransition &&
    typeof data.gate === 'number' &&
    typeof data.decision === 'string'
  ) {
    const nextStatus = SPEC_STATUS_TRANSITIONS[data.gate]?.[data.decision];
    if (nextStatus) {
      writeSpecStatus(specPathForTransition, nextStatus);
      // 스펙이 closed 가 된 순간 전송한다(prototype.md:401 "closed 가 될 때만").
      if (nextStatus === 'closed') {
        await syncClosedSpec(specPathForTransition);
      }
    }
  }

  // awl-feedback 은 발생 즉시 전송한다(ADK stage 3, prototype.md:403).
  if (type === 'awl-feedback' && projectRoot) {
    await syncFeedback(projectRoot, record);
  }

  // 게이트4 병합 제안(ADK stage 5, WI-D) — merge 결정일 때만(judge-only/hold 는 병합
  // 의사가 없다). lane-meta.json 이 없으면(레인이 아닌 곳) suggestGate4Merge 가 조용히
  // 생략한다.
  if (type === 'gate' && data.gate === 4 && data.decision === 'merge' && projectRoot) {
    await suggestGate4Merge(projectRoot);
  }

  // review findings 가 실재 규칙을 지목하면 그 규칙의 hits 를 자동으로 늘린다(ADK
  // stage 6 — "리뷰어가 잡는 경우"의 hits 카운팅. "검사기가 잡는 경우"는
  // awl rules hit 로 별도 충족한다). buildRecord 가 이미 존재를 검증했다. 동적
  // import — rules.ts 를 정적으로 물면 rules.ts → evolve.ts → record.ts 순환이 된다.
  if (type === 'review' && Array.isArray(data.findings)) {
    const { incrementRuleHits } = await import('./rules.js');
    for (const finding of data.findings as Record<string, unknown>[]) {
      const ruleId = finding?.ruleId;
      if (typeof ruleId === 'string' && ruleId !== '없음') {
        try {
          incrementRuleHits(ruleId);
        } catch {
          // 저장 자체는 막지 않는다 — 방어적 무시(buildRecord 가 이미 존재를 검증했다).
        }
      }
    }
  }

  // gate:2 리뷰 누락 경고 (WI-S AC-03) — 거부하지 않는다, 안내만 한다.
  if (type === 'gate' && data.gate === 2) {
    const passedCount = Array.isArray(state.criteria)
      ? (state.criteria as Record<string, unknown>[]).filter((c) => c.status === 'passed').length
      : 0;
    // record.workitem 이 없으면(이론상 WI-R 강제로 항상 있어야 하지만) 판단을
    // 보류한다 — readRecords 에 workitem: undefined 를 넘기면 필터가 아예
    // 안 걸려 다른 워크아이템의 review 로도 "있음" 판정될 수 있다(G-020, 같은
    // 실수를 WI-Q 에서 이미 한 번 했다). 판단 불가능하면 경고도 안 준다(소프트
    // 체크라 거부는 원래 안 하므로, 잘못된 안심을 주는 것보다 조용한 게 낫다).
    const workitemForCheck = typeof record.workitem === 'string' ? record.workitem : undefined;
    if (passedCount >= 3 && workitemForCheck && projectRoot) {
      const hasReview =
        readRecords(projectRoot, { type: 'review', workitem: workitemForCheck }).length > 0;
      if (!hasReview) {
        process.stderr.write(
          `\n  ${signal(caps(), 'warn')} 완료 조건 ${passedCount}개가 통과했으나 리뷰 기록이 없습니다.\n  리뷰를 건너뛰었습니까?\n`,
        );
      }
    }

    // "너무 쉬웠나" 안내 (WI-T AC-03) — 강제가 아니라 질문이다. 완료 조건이
    // 하나 이상이고 전부 status:passed && attempts:0(1차 통과)이면(막힘이
    // 하나라도 있으면 그 항목은 passed 가 아니므로 이 조건 자체가 자연히 걸러진다)
    // 커버리지 수치와 함께 물어본다. 거부하지 않는다.
    const criteria = Array.isArray(state.criteria)
      ? (state.criteria as Record<string, unknown>[])
      : [];
    const allPassedFirstTry =
      criteria.length > 0 &&
      criteria.every((c) => c.status === 'passed' && (Number(c.attempts) || 0) === 0);
    if (allPassedFirstTry) {
      const auditRecords =
        workitemForCheck && projectRoot
          ? readRecords(projectRoot, { type: 'audit', workitem: workitemForCheck })
          : [];
      const criteriaRecords =
        workitemForCheck && projectRoot
          ? readRecords(projectRoot, { type: 'criteria', workitem: workitemForCheck })
          : [];
      const coverage = computeCoverage(auditRecords, criteria, criteriaRecords);
      process.stderr.write(
        `\n  완료 조건 ${criteria.length}개 전부 1차 통과. 막힘 0건.\n  조사에서 발견한 ${coverage.auditFindingIds.length}건 중 ${coverage.addressedIds.length}건을 다뤘습니다.\n  완료 조건이 충분히 야심찼습니까?\n`,
      );
    }
  }

  process.stdout.write(`${JSON.stringify({ id, at, file })}\n`);
}

/** 검증된 effective config에서 project 이름을 읽는다. */
export function loadProjectName(projectRoot: string): string | undefined {
  return loadConfig(projectRoot).config?.project;
}

/**
 * 기록에 붙는 author — 전역 → 저장소 → local 순으로 덮는다(adk-prototype.md:117
 * "저장소가 덮으려면 .awl/config.json 이나 config.local.json 에 쓰면 된다"). 저장소가
 * author 를 안 정했으면 전역(~/.awl/config.json) 값으로 폴백한다.
 */
export function resolveEffectiveAuthor(projectRoot: string | null): string | undefined {
  if (projectRoot) {
    const projectAuthor = loadConfig(projectRoot).config?.author;
    if (projectAuthor) {
      return projectAuthor;
    }
  }
  return readGlobalAwlConfig()?.author;
}

/** awl records — 사람이 읽는 조회. */
export function runRecords(opts: { type?: string; workitem?: string; json?: boolean }): void {
  const projectRoot = resolveProjectRoot();
  if (!projectRoot) {
    process.stderr.write(
      `\n  ${signal(caps(), 'error')} 프로젝트 루트를 찾을 수 없습니다. awl init 을 실행하세요.\n`,
    );
    process.exit(1);
    return;
  }
  const records = readRecords(projectRoot, { type: opts.type, workitem: opts.workitem });
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(records, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${renderRecords(records, caps())}\n`);
}
