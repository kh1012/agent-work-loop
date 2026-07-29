import fs from 'node:fs';
import path from 'node:path';
import { type FrontmatterData, parseFrontmatter } from '../core/doc-frontmatter.js';
import { findProjectRoot } from '../core/paths.js';
import { run } from '../core/runner.js';
import { type Caps, caps, makeColors, makeSymbols, signal } from '../core/tty.js';
import {
  type DocType,
  extractConditionBlocks,
  extractConstraintBlocks,
  listDocFiles,
} from './doc.js';
import { type SkillSlot, loadProfile, skillRefLabel } from './profile.js';
import { readRecords } from './record.js';
import { type LoopMode, effectiveLoopMode, loadState } from './state.js';

/**
 * `awl next [ticket-id]` — 지금 이 티켓에 대해 이미 아는 것(스펙 조건·제약·게이트
 * 이력·같은 스펙의 다른 티켓이 조사에서 남긴 finding)과 다음에 뭘 해야 하는지를
 * 조립해 보여준다(ADK stage 2c, 읽기 전용). 얇은 오케스트레이션 스킬(WI-H2, 별도)이
 * "출력에 다음에 할 일과 그 방법이 있다. 그대로 따른다"고만 지시하고, 실제 지시는
 * 이 명령이 만든다(adk-prototype.md:335 "지시는 CLI 가 만든다").
 *
 * 아무것도 안 쓰고 판단도 안 한다 — 있는 걸 조립할 뿐이다. ticket-id 를 생략하면
 * "지금" 티켓을 자동판정한다(resolveCurrentTicketId).
 */

interface ParsedDoc {
  path: string;
  data: FrontmatterData;
  body: string;
}

function findDocById(projectRoot: string, type: DocType, id: string): ParsedDoc | null {
  for (const file of listDocFiles(projectRoot)) {
    if (file.type !== type) {
      continue;
    }
    const parsed = parseFrontmatter(fs.readFileSync(file.path, 'utf8'));
    if (parsed?.data.id === id) {
      return { path: file.path, data: parsed.data, body: parsed.body };
    }
  }
  return null;
}

/**
 * ticket-id 를 안 주면 "지금" 티켓을 고른다(WI-H1). 파일명이 `YYYYMMDD-HHMMSS-...`
 * 라 정렬하면 만들어진 순서다. 우선순위: 1) status:'implementing'(구현 중)인 것 —
 * 가장 먼저 만들어진 하나. 2) 없으면 status:'pending' 이면서 dependencies 가 전부
 * 'done'인(막히지 않은) 것 — 가장 먼저 만들어진 하나. 3) 그것도 없으면 null(에러는
 * 호출부가 낸다 — 이 함수는 판단하지 않고 조회만 한다).
 */
export function resolveCurrentTicketId(projectRoot: string): string | null {
  const parsed = listDocFiles(projectRoot)
    .filter((f) => f.type === 'ticket')
    .sort((a, b) => path.basename(a.path).localeCompare(path.basename(b.path)))
    .map((f) => parseFrontmatter(fs.readFileSync(f.path, 'utf8'))?.data)
    .filter((d): d is FrontmatterData => d !== undefined);

  const implementing = parsed.find((t) => t.status === 'implementing');
  if (implementing && typeof implementing.id === 'string') {
    return implementing.id;
  }

  const doneIds = new Set(parsed.filter((t) => t.status === 'done').map((t) => String(t.id)));
  const unblockedPending = parsed.find((t) => {
    if (t.status !== 'pending') {
      return false;
    }
    const deps = Array.isArray(t.dependencies) ? t.dependencies : [];
    return deps.every((d) => doneIds.has(String(d)));
  });
  if (unblockedPending && typeof unblockedPending.id === 'string') {
    return unblockedPending.id;
  }

  return null;
}

export interface GateChecklistItem {
  name: string;
  desc: string;
}

export interface GateChecklist {
  gate: number;
  label: string;
  items: GateChecklistItem[];
}

/**
 * 게이트 2/3 에 도달하려면 뭐가 있어야 하는지(adk-reference.md:998-1006). 티켓마다
 * 달라지지 않는 고정 계약이라(설계 예시 그대로) 정적 상수다 — "단계를 하나씩
 * 지시하지 않고 계약을 통째로 준다": 순서는 자유고, 도달 시점에 이 형식만 맞으면
 * 된다. 진행률을 계산해 체크하지 않는다(awl 은 판단하지 않는다).
 */
export const GATE_CHECKLISTS: GateChecklist[] = [
  {
    gate: 2,
    label: '착수',
    items: [
      { name: 'finding', desc: '새로 알게 된 것. file:line 포함' },
      { name: 'clarification', desc: '물어서 정한 것. 없으면 "없음"' },
      { name: 'verification', desc: 'given/when/then' },
    ],
  },
  {
    gate: 3,
    label: '완료',
    items: [{ name: '커밋', desc: '검증이 통과하는 상태' }],
  },
];

/**
 * 모드가 정하는 건 "얼마나 자동 승인하느냐"만이 아니다. 사람이 실제로 손을 대는 두 자리 —
 * 게이트 1 앞의 캐묻기(grill)와 게이트 4의 마감 설명 — 의 강도도 같이 정해진다.
 *
 * 왜 여기서 계약으로 내보내나: awl 은 캐묻지도 설명하지도 않는다(판단하지 않는다).
 * 무엇이 요구되는지만 매번 같은 형식으로 내주고, 실행은 스킬이 한다. 이 값이 출력에
 * 안 보이면 스킬마다 다르게 해석하고, 그게 0.8.x 까지 grill 이 아무 데도 안 붙어 있던
 * 이유였다(프로파일 슬롯에 자리는 있는데 아무도 안 가리켰다).
 */
export interface ModeContract {
  mode: LoopMode;
  /** 게이트 1 앞에서 얼마나 캐물을 것인가. */
  grill: string;
  /** 게이트 4에서 사람에게 무엇을 남길 것인가. */
  close: string;
}

export function modeContract(mode: LoopMode): ModeContract {
  if (mode === 'strict') {
    return {
      mode,
      grill: '미해결 질문이 0건이 될 때까지 캐묻는다. 남은 게 있으면 게이트 1로 가지 않는다',
      close: '무엇을 왜 바꿨는지 사람이 읽을 형태로 남긴다. 이해를 확인하는 질문까지',
    };
  }
  if (mode === 'auto') {
    return {
      mode,
      grill: '건너뛴다. 사람 손을 빼는 모드에서 캐묻는 건 모순이다',
      close: '펼친 요약만. 완료 티켓·조건·검증·자동승인 횟수',
    };
  }
  return {
    mode,
    grill: '한 번 캐묻고, 남은 것은 clarification 으로 기록한 뒤 진행한다',
    close: '무엇을 왜 바꿨는지 사람이 읽을 형태로 남긴다',
  };
}

export interface GateHistoryEntry {
  gate: number;
  decision: string;
  at: string;
  /** 이 게이트에 대해 재작업(재기록)된 횟수 — 전체 기록 수 - 1. 0 이면 한 번에 끝남(WI-I1). */
  retries: number;
}

/**
 * finding·constraint 를 이 개수까지만 본문으로 보여주고 나머지는 개수만 요약한다
 * (WI-I1, 토큰 스트레스 테스트로 확정 — 상한 지점은 실측 성장률 스윕 기준
 * "정상→주의" 문턱을 살짝 넘는 지점). 관련성으로 거르지 않고 "가장 최근 N개"를
 * 남긴다 — readRecords 가 이미 at 내림차순이라 자연히 최신순이다.
 */
export const MAX_SHOWN_FINDINGS = 25;
export const MAX_SHOWN_CONSTRAINTS = 15;

/**
 * 같은 스펙의 audit 기록에서 모은 finding(WI-G21, "이미 아는 것을 먼저 준다").
 *
 * 스펙을 가리키는 필드 이름은 **`spec`** 이다. status.ts 도 `r.spec` 을 읽고 record 는
 * `spec` 을 소유자로 검증한다. 초안은 여기서만 `specId` 라는 자유 필드를 쓰라고 했는데
 * (audit 이 workitem 단위였던 시절의 우회), 그 결과 record 가 쓰는 이름과 여기가 읽는
 * 이름이 달라 이 패널이 구조적으로 늘 비어 있었다(dogfood-20260730 리뷰 지적 3).
 * 옛 기록 호환으로 `specId` 도 계속 읽는다.
 *
 * ticket 으로만 남긴 기록도 그 티켓의 spec 을 따라 여기 들어온다 — 조사는 티켓에 붙이고
 * 읽기는 스펙 단위로 하는 게 "다음 티켓이 앞선 조사를 물려받는다"의 뜻이다.
 */
export interface KnownFinding {
  id: string;
  what: string;
  where?: string;
  source?: string;
  /** 이 finding 을 남긴 audit 기록의 at — checkFindingsFreshness 가 비교 기준으로 쓴다. */
  recordedAt?: string;
  /** where 가 가리키는 파일이 recordedAt 이후 커밋됐으면 true("확인 필요"). */
  needsRecheck?: boolean;
}

const STATUS_HINTS: Record<string, string> = {
  pending: '게이트 2(착수) 승인이 필요합니다.',
  implementing: '구현 중입니다. 끝나면 게이트 3(완료) 승인을 받으세요.',
  reviewing: '리뷰 중입니다.',
  done: '완료됐습니다.',
  blocked: '막혔습니다 — 재개하려면 다시 게이트를 통과해야 합니다.',
};

function hintForStatus(status: string): string {
  return STATUS_HINTS[status] ?? `알 수 없는 status: ${status}`;
}

/** 티켓 status → profile.skills 슬롯. done/blocked 는 특정 단계를 안 가리키므로 없다. */
const STATUS_TO_SKILL_SLOT: Partial<Record<string, SkillSlot>> = {
  pending: 'investigation',
  implementing: 'implement',
  reviewing: 'review',
};

export interface ConstraintRef {
  id: string;
  text: string;
}

export interface NextView {
  ticketId: string;
  ticketPath: string;
  status: string;
  specId: string;
  specTitle: string | null;
  conditionId: string | null;
  conditionText: string | null;
  /** 스펙의 `## Constraints` 전체(티켓 하나가 아니라 스펙 전체에 걸린다, adk-reference.md:995) —
   * MAX_SHOWN_CONSTRAINTS 까지만. */
  constraints: ConstraintRef[];
  /** constraints 에서 잘려나간 개수(WI-I1). 0 이면 안 잘림. */
  constraintsTruncated: number;
  gateHistory: GateHistoryEntry[];
  /** MAX_SHOWN_FINDINGS 까지만(WI-I1, 최신순). */
  knownFindings: KnownFinding[];
  /** knownFindings 에서 잘려나간 개수. 0 이면 안 잘림. */
  findingsTruncated: number;
  /** 지금 status 에 해당하는 profile.skills 슬롯 라벨. 매칭 슬롯이 없거나 profile 이 없으면 null. */
  skill: string | null;
  hint: string;
  /** 게이트 2/3 도달 계약(정적, WI-H1). */
  gateChecklists: GateChecklist[];
  /** 지금 모드가 게이트 1·4 에 요구하는 것. */
  modeContract: ModeContract;
}

/** 아직 티켓이 하나도 안 도출된 스펙. */
export interface PendingSpec {
  id: string;
  title: string;
}

/**
 * 왜 진행할 티켓이 없는가. resolveCurrentTicketId 가 null 을 내는 이유는 셋인데,
 * 셋의 다음 행동이 전부 다르다 — 이걸 뭉뚱그려 "티켓 없음"이라 말하면 뷰가 거짓이 된다.
 *
 * 리뷰가 잡은 실제 사고(dogfood-20260730): 티켓 4개가 done 이고 게이트 4 만 남은
 * 상태에서 "아직 티켓 없음 / 스펙 (없음) / 새 스펙을 만드세요"가 나왔다. 스킬이 그대로
 * 따르면 끝난 요청을 안 닫고 새 요청을 판다.
 */
export type NoTicketReason =
  /** 티켓 문서가 하나도 없다 — 스펙부터 만들거나 derive 한다. */
  | 'no-tickets'
  /** 티켓은 있고 전부 done. */
  | 'all-done'
  /** done 도 아니고 고를 수도 없는 티켓이 있다(리뷰 중·막힘·의존 미충족). */
  | 'stalled';

/**
 * done 도 아닌데 resolveCurrentTicketId 가 고르지도 않는 티켓. **"막힘"과 동의어가
 * 아니다** — 리뷰 중이거나 abandoned 로 blocked 가 된 것도 여기 온다. 초판은 이걸
 * 전부 "진행이 막힌 티켓"이라 부르고 "선행 티켓을 먼저 끝내세요"라고 했는데, 선행이
 * 아예 없는 티켓에도 그 말이 나갔다(리뷰 지적 6).
 */
export interface StalledTicket {
  id: string;
  status: string;
  /** 아직 done 이 아닌 선행 티켓들. 의존이 원인이 아니면 빈 배열. */
  waitingOn: string[];
  /** 이 티켓이 왜 안 골라졌고 무엇을 하면 되는지. */
  why: string;
}

function stallReason(status: string, waitingOn: string[]): string {
  if (waitingOn.length > 0) {
    return `선행 티켓이 아직 done 이 아닙니다: ${waitingOn.join(', ')}`;
  }
  if (status === 'reviewing') {
    return '리뷰 중입니다 — 끝나면 게이트 3(완료)을 기록하세요.';
  }
  if (status === 'blocked') {
    return '막혔습니다 — 재개하려면 게이트 2(착수)를 다시 기록하세요.';
  }
  return `자동판정이 고르지 않는 status 입니다: ${status}`;
}

/**
 * 진행할 티켓이 없을 때 내는 뷰. 티켓 뷰와 필드가 겹치지 않으므로 kind 로 구분한다.
 *
 * 왜 필요한가: 스킬은 "스펙을 쓰기 전에 awl next 의 모드 절을 보고 그 강도대로
 * 캐물으라"고 지시하는데, 티켓이 없는 그 시점에 next 가 실패로 끝나면 캐물어야 할
 * 바로 그 순간에 지침이 0이 된다. 자리는 만들어두고 아무도 안 가리키던 0.8.x 의
 * grill 과 같은 구멍이라, 실사용(dogfood-20260730)에서 첫 명령에 바로 걸렸다.
 */
export interface SpecStageView {
  kind: 'spec-stage';
  reason: NoTicketReason;
  /**
   * 아직 티켓이 안 도출된 스펙들. **reason 과 무관하게 늘 채운다** — 초판은
   * else-if 체인이라 all-done/blocked 일 때 이 목록을 그릴 자리가 없어서, 티켓 없는
   * 스펙이 출력에서 통째로 사라졌다(리뷰 지적 4).
   */
  pendingSpecs: PendingSpec[];
  /** 게이트 4 를 실제로 기다리는 스펙 — 도출됐고 closed 아니고 제 티켓이 전부 done. */
  gate4Specs: PendingSpec[];
  /** done 도 아니고 고를 수도 없는 티켓들과 그 이유. */
  stalledTickets: StalledTicket[];
  /** 이 단계에서 사람이 쓰는 두 자리 — spec(스펙 캐묻기)·clarification(명료화). */
  skills: { slot: SkillSlot; label: string }[];
  /** profile 을 못 읽은 이유. skills 가 비었을 때 왜인지 말해준다. */
  skillErrors: string[];
  modeContract: ModeContract;
}

/** 스펙 단계에서 가리키는 슬롯. 순서가 곧 사람이 지나가는 순서다. */
const SPEC_STAGE_SLOTS: SkillSlot[] = ['spec', 'clarification'];

function readDocData(filePath: string): FrontmatterData | undefined {
  return parseFrontmatter(fs.readFileSync(filePath, 'utf8'))?.data;
}

/** 진행할 티켓이 없을 때의 뷰. throw 하지 않는다 — 이 단계 자체가 정상 상태다. */
export function computeSpecStageView(projectRoot: string): SpecStageView {
  const files = listDocFiles(projectRoot);
  const tickets = files
    .filter((f) => f.type === 'ticket')
    .map((f) => readDocData(f.path))
    .filter((d): d is FrontmatterData => d !== undefined);
  const derivedSpecIds = new Set(
    tickets.map((d) => (typeof d.spec === 'string' ? d.spec : null)).filter((s) => s !== null),
  );

  // resolveCurrentTicketId 와 **같은 규칙**으로 되짚는다 — 두 곳이 규칙을 각자
  // 구현하면 갈라진다(리뷰 지적 6/R7). 고를 수 있는 티켓의 정의는 한 곳에 둔다.
  const doneIds = new Set(
    tickets.filter((t) => t.status === 'done').map((t) => String(t.id ?? '')),
  );
  const isSelectable = (t: FrontmatterData): boolean => {
    if (t.status === 'implementing') {
      return true;
    }
    if (t.status !== 'pending') {
      return false;
    }
    const deps = Array.isArray(t.dependencies) ? t.dependencies : [];
    return deps.every((d) => doneIds.has(String(d)));
  };

  const stalledTickets: StalledTicket[] = tickets
    .filter((t) => t.status !== 'done' && !isSelectable(t))
    .map((t) => {
      const status = typeof t.status === 'string' ? t.status : 'pending';
      const waitingOn = (Array.isArray(t.dependencies) ? t.dependencies : [])
        .map(String)
        .filter((d) => !doneIds.has(d));
      return {
        // 빈 문자열도 없는 것으로 본다 — `id:` 만 남은 프론트매터가 실제로 있고,
        // String(undefined) 를 화면에 내보내면 사람이 복사할 수 없는 값이 나간다.
        id: typeof t.id === 'string' && t.id.trim() !== '' ? t.id : '(id 없음)',
        status,
        waitingOn,
        why: stallReason(status, waitingOn),
      };
    });

  // 스펙별로 티켓이 전부 done 인지 따로 본다 — 스펙이 여럿이면 하나가 끝나도
  // 다른 스펙은 안 끝났을 수 있다.
  const ticketsBySpec = new Map<string, FrontmatterData[]>();
  for (const t of tickets) {
    if (typeof t.spec !== 'string') {
      continue;
    }
    ticketsBySpec.set(t.spec, [...(ticketsBySpec.get(t.spec) ?? []), t]);
  }

  const pendingSpecs: PendingSpec[] = [];
  const gate4Specs: PendingSpec[] = [];
  for (const f of files.filter((x) => x.type === 'spec')) {
    const data = readDocData(f.path);
    const id = typeof data?.id === 'string' ? data.id : null;
    if (!id) {
      continue;
    }
    const entry = { id, title: typeof data?.title === 'string' ? data.title : '(제목 없음)' };
    if (!derivedSpecIds.has(id)) {
      pendingSpecs.push(entry);
      continue;
    }
    // 이미 닫힌 요청은 게이트 4 대상이 아니다 — 여기서 거르지 않으면 닫은 뒤에도
    // next 가 계속 "게이트 4 를 기록하세요"를 반복한다(리뷰 지적 1).
    if (data?.status === 'closed') {
      continue;
    }
    const mine = ticketsBySpec.get(id) ?? [];
    if (mine.length > 0 && mine.every((t) => t.status === 'done')) {
      gate4Specs.push(entry);
    }
  }

  let reason: NoTicketReason = 'no-tickets';
  if (tickets.length > 0) {
    reason = stalledTickets.length > 0 ? 'stalled' : 'all-done';
  }

  const loaded = loadProfile(projectRoot);
  const skills = loaded.profile
    ? SPEC_STAGE_SLOTS.map((slot) => ({
        slot,
        label: skillRefLabel(loaded.profile?.skills[slot] ?? null),
      }))
    : [];

  return {
    kind: 'spec-stage',
    reason,
    pendingSpecs,
    gate4Specs,
    stalledTickets,
    skills,
    skillErrors: loaded.errors,
    modeContract: modeContract(effectiveLoopMode(loadState(projectRoot))),
  };
}

/** ticketId 를 생략하면 resolveCurrentTicketId 로 "지금" 티켓을 고른다(WI-H1). */
export function computeNextView(projectRoot: string, ticketId?: string): NextView {
  const resolvedTicketId = ticketId ?? resolveCurrentTicketId(projectRoot);
  if (!resolvedTicketId) {
    throw new Error(
      '진행할 티켓을 찾지 못했습니다 — awl tickets derive 로 티켓을 만들거나 ticket-id 를 직접 주세요.',
    );
  }
  const ticket = findDocById(projectRoot, 'ticket', resolvedTicketId);
  if (!ticket) {
    throw new Error(`티켓을 찾을 수 없습니다: ${resolvedTicketId}`);
  }

  const specId = typeof ticket.data.spec === 'string' ? ticket.data.spec : '';
  const spec = specId ? findDocById(projectRoot, 'spec', specId) : null;

  const conditions = Array.isArray(ticket.data.conditions) ? ticket.data.conditions : [];
  const conditionId = conditions.length > 0 ? (conditions[0] ?? null) : null;
  let conditionText: string | null = null;
  if (spec && conditionId) {
    const block = extractConditionBlocks(spec.body).find((b) => b.heading === conditionId);
    conditionText = block?.text ?? null;
  }

  const allConstraints: ConstraintRef[] = spec
    ? extractConstraintBlocks(spec.body).map((b) => ({ id: b.heading, text: b.text }))
    : [];
  const constraints = allConstraints.slice(0, MAX_SHOWN_CONSTRAINTS);
  const constraintsTruncated = Math.max(0, allConstraints.length - MAX_SHOWN_CONSTRAINTS);

  // 게이트 이력: status.ts 의 buildGateStatus 와 같은 원칙(WI-I1) — 게이트당 최신
  // 기록 1건만 남긴다. readRecords 는 at 내림차순이라 필터링 후 첫 번째가 최신이다.
  // 재작업(재기록)된 횟수는 카운트만 세서 retries 로 곁들인다 — 몇 번을 다시
  // 승인/판정해도 출력은 게이트당 한 줄로 고정된다.
  const ticketGateRecords = readRecords(projectRoot, { type: 'gate' }).filter(
    (r) => r.ticket === resolvedTicketId,
  );
  const gateHistory: GateHistoryEntry[] = [];
  for (const gate of [1, 2, 3, 4] as const) {
    const recs = ticketGateRecords.filter((r) => r.gate === gate);
    if (recs.length === 0) {
      continue;
    }
    const latest = recs[0];
    gateHistory.push({
      gate,
      decision: typeof latest?.decision === 'string' ? latest.decision : '',
      at: typeof latest?.at === 'string' ? latest.at : '',
      retries: recs.length - 1,
    });
  }

  const status = typeof ticket.data.status === 'string' ? ticket.data.status : 'pending';

  // 이 스펙에 속한 티켓 전부 — ticket 으로만 남긴 조사도 스펙 단위로 모으기 위해.
  const siblingTicketIds = new Set(
    listDocFiles(projectRoot)
      .filter((f) => f.type === 'ticket')
      .map((f) => readDocData(f.path))
      .filter((d) => d !== undefined && d.spec === specId)
      .map((d) => String(d?.id)),
  );

  const allFindings: KnownFinding[] = [];
  if (specId) {
    for (const r of readRecords(projectRoot, { type: 'audit' })) {
      const ownedBySpec = r.spec === specId || r.specId === specId;
      const ownedByTicket = typeof r.ticket === 'string' && siblingTicketIds.has(r.ticket);
      if (!ownedBySpec && !ownedByTicket) {
        continue;
      }
      const recordedAt = typeof r.at === 'string' ? r.at : undefined;
      const findings = Array.isArray(r.findings) ? r.findings : [];
      for (const f of findings) {
        if (!f || typeof f !== 'object') {
          continue;
        }
        const item = f as Record<string, unknown>;
        if (typeof item.id !== 'string' || typeof item.what !== 'string') {
          continue;
        }
        allFindings.push({
          id: item.id,
          what: item.what,
          where: typeof item.where === 'string' ? item.where : undefined,
          source: typeof item.source === 'string' ? item.source : undefined,
          recordedAt,
        });
      }
    }
  }
  const knownFindings = allFindings.slice(0, MAX_SHOWN_FINDINGS);
  const findingsTruncated = Math.max(0, allFindings.length - MAX_SHOWN_FINDINGS);

  const slot = STATUS_TO_SKILL_SLOT[status];
  const profile = slot ? loadProfile(projectRoot).profile : null;
  const skill = profile ? `${slot}: ${skillRefLabel(profile.skills[slot as SkillSlot])}` : null;

  return {
    modeContract: modeContract(effectiveLoopMode(loadState(projectRoot))),
    ticketId: resolvedTicketId,
    ticketPath: ticket.path,
    status,
    specId,
    specTitle: typeof spec?.data.title === 'string' ? spec.data.title : null,
    conditionId,
    conditionText,
    constraints,
    constraintsTruncated,
    gateHistory,
    knownFindings,
    findingsTruncated,
    skill,
    hint: hintForStatus(status),
    gateChecklists: GATE_CHECKLISTS,
  };
}

/**
 * knownFindings 중 where(file:line)가 있는 것만, 그 파일이 recordedAt 이후 커밋됐는지
 * git log 로 확인해 needsRecheck 를 채운다(WI-G21). git 저장소가 아니거나 git 이
 * 없으면 조용히 원본을 그대로 돌려준다 — next 는 크래시하지 않는다(status.ts 의
 * checkMissingAcCommits 와 같은 원칙: 동기 조립과 git 조회를 분리한다).
 */
export async function checkFindingsFreshness(
  projectRoot: string,
  findings: KnownFinding[],
): Promise<KnownFinding[]> {
  const out: KnownFinding[] = [];
  for (const f of findings) {
    const file = f.where?.split(':')[0];
    if (!file || !f.recordedAt) {
      out.push(f);
      continue;
    }
    try {
      const r = await run({
        cmd: 'git',
        args: ['log', '--since', f.recordedAt, '--format=%H', '--', file],
        cwd: projectRoot,
        timeoutMs: 10_000,
      });
      out.push({ ...f, needsRecheck: r.exitCode === 0 && r.stdout.trim().length > 0 });
    } catch {
      out.push(f);
    }
  }
  return out;
}

const GATE_LABELS: Record<number, string> = {
  1: '티켓 확정',
  2: '착수',
  3: '완료',
  4: '요청 닫기',
};

function renderView(view: NextView, c: Caps): string {
  const color = makeColors(c.color);
  const lines: string[] = [];
  lines.push(`  ticket   ${view.ticketId}`);
  lines.push(`  spec     ${view.specTitle ?? '(연결된 스펙 없음)'}`);
  lines.push(`  status   ${view.status}`);
  lines.push('');
  lines.push('  condition');
  if (view.conditionText) {
    for (const l of view.conditionText.split('\n')) {
      lines.push(`    ${l}`);
    }
  } else {
    lines.push('    (조건을 찾을 수 없음)');
  }
  lines.push('');
  const s = makeSymbols(c);
  lines.push(
    `  constraints  ${view.constraints.length === 0 ? '(없음)' : view.constraints.map((cn) => cn.id).join(', ')}`,
  );
  for (const cn of view.constraints) {
    lines.push(`    ${s.fold} ${cn.id}`);
    for (const l of cn.text.split('\n')) {
      lines.push(`      ${l}`);
    }
  }
  if (view.constraintsTruncated > 0) {
    lines.push(
      `    … ${view.constraintsTruncated}건 더 있음 — awl doc lint 로 스펙 원문을 확인하세요`,
    );
  }
  lines.push('');
  lines.push('  게이트 이력');
  if (view.gateHistory.length === 0) {
    lines.push('    아직 없음');
  } else {
    for (const g of view.gateHistory) {
      const retryNote = g.retries > 0 ? color.dim(`  (재작업 ${g.retries}회)`) : '';
      lines.push(
        `    gate ${g.gate} (${GATE_LABELS[g.gate] ?? '?'})   ${g.decision}   ${g.at}${retryNote}`,
      );
    }
  }
  lines.push('');
  lines.push('  이미 아는 것');
  if (view.knownFindings.length === 0) {
    lines.push('    (같은 스펙에 조사 기록 없음)');
  } else {
    for (const f of view.knownFindings) {
      const recheck = f.needsRecheck ? `  ${signal(c, 'warn')} 확인 필요` : '';
      const where = f.where ? `  ${f.where}` : '';
      lines.push(`    ${f.id}  ${f.what}${where}${recheck}`);
    }
  }
  if (view.findingsTruncated > 0) {
    lines.push(`    … ${view.findingsTruncated}건 더 있음 — awl records --json 으로 확인하세요`);
  }
  if (view.skill) {
    lines.push('');
    lines.push(`  skill    ${view.skill}`);
  }
  const mc = view.modeContract;
  lines.push('');
  lines.push(`  모드     ${mc.mode}`);
  lines.push(`    캐묻기(게이트 1 앞)  ${mc.grill}`);
  lines.push(`    마감(게이트 4)       ${mc.close}`);
  lines.push('');

  for (const gc of view.gateChecklists) {
    lines.push('');
    lines.push(`  게이트 ${gc.gate}(${gc.label})에 도달하려면`);
    for (const item of gc.items) {
      lines.push(`    ${item.name.padEnd(14, ' ')}${item.desc}`);
    }
  }
  lines.push('');
  lines.push('  다음');
  lines.push(`    ${view.hint}`);
  return `\n  ${signal(c, 'ok')} ${view.ticketId}\n\n${lines.join('\n')}\n`;
}

const STAGE_LABELS: Record<NoTicketReason, string> = {
  'no-tickets': '스펙 (아직 티켓 없음)',
  'all-done': '요청 닫기 (티켓은 모두 done)',
  stalled: '대기 (자동으로 고를 티켓 없음)',
};

/**
 * 진행할 티켓이 없을 때의 화면.
 *
 * **분기(else-if)로 짜지 않는다.** 초판이 그랬다가 두 가지가 났다 — (1) all-done 이면
 * 티켓 없는 스펙을 그릴 자리가 없어 통째로 사라졌고, (2) 스펙을 닫은 뒤에도 "게이트 4 를
 * 기록하세요"를 반복하며 실행 불가능한 `<spec-id>` 리터럴을 뱉었다. 그래서 지금은
 * **실제로 할 수 있는 일만 모아서** 낸다 — 할 게 없으면 없다고 말한다.
 */
export function renderSpecStage(view: SpecStageView, c: Caps): string {
  const lines: string[] = [];
  lines.push(`  단계     ${STAGE_LABELS[view.reason]}`);

  if (view.stalledTickets.length > 0) {
    lines.push('');
    lines.push('  자동으로 고를 수 없는 티켓');
    for (const t of view.stalledTickets) {
      lines.push(`    ${t.id}  ${t.status}`);
      lines.push(`      ${t.why}`);
    }
  }
  if (view.gate4Specs.length > 0) {
    lines.push('');
    lines.push('  게이트 4 를 기다리는 스펙 (티켓 전부 done)');
    for (const s of view.gate4Specs) {
      lines.push(`    ${s.id}  ${s.title}`);
    }
  }
  if (view.pendingSpecs.length > 0) {
    lines.push('');
    lines.push('  티켓이 아직 없는 스펙');
    for (const s of view.pendingSpecs) {
      lines.push(`    ${s.id}  ${s.title}`);
    }
  }
  if (
    view.stalledTickets.length === 0 &&
    view.gate4Specs.length === 0 &&
    view.pendingSpecs.length === 0
  ) {
    lines.push('');
    lines.push('  스펙     (열려 있는 것 없음)');
  }

  lines.push('');
  if (view.skills.length > 0) {
    for (const s of view.skills) {
      lines.push(`  skill    ${s.slot}: ${s.label}`);
    }
  } else {
    // 조용히 생략하지 않는다 — 스킬 줄이 그냥 없으면 "이 단계엔 스킬이 없다"로
    // 읽히지만 실제로는 profile 을 못 읽은 것이다(리뷰 지적 5).
    const why = view.skillErrors[0] ?? 'profile.json 을 읽지 못했습니다';
    lines.push(`  skill    (없음 — ${why})`);
  }
  const mc = view.modeContract;
  lines.push('');
  lines.push(`  모드     ${mc.mode}`);
  lines.push(`    캐묻기(게이트 1 앞)  ${mc.grill}`);
  lines.push(`    마감(게이트 4)       ${mc.close}`);

  lines.push('');
  lines.push('  다음');
  const nextLines: string[] = [];
  for (const s of view.gate4Specs) {
    nextLines.push(`    게이트 4(요청 닫기) — ${s.title}`);
    nextLines.push(`      awl record gate --json '{"layer":"request","gate":4,"spec":"${s.id}",`);
    nextLines.push('        "decision":"merge","presentedCriteria":[...]}\'');
    nextLines.push('      (decision 은 merge / judge-only / hold 중 하나)');
  }
  for (const s of view.pendingSpecs) {
    nextLines.push(`    awl tickets derive ${s.id}   (${s.title})`);
  }
  for (const t of view.stalledTickets) {
    nextLines.push(`    ${t.id} — ${t.why}`);
  }
  if (nextLines.length === 0) {
    nextLines.push('    awl doc new spec "<제목>" --request "<사용자 원문 그대로>"');
    nextLines.push('    → ## Conditions 를 ### condition-N 블록으로 채운다 (EARS 문형)');
    nextLines.push('    → awl tickets derive <spec-id>');
  }
  lines.push(...nextLines);
  return `\n  ${signal(c, 'ok')} ${STAGE_LABELS[view.reason]}\n\n${lines.join('\n')}\n`;
}

/** ticketId 를 생략하면 "지금" 티켓을 자동판정한다(WI-H1, resolveCurrentTicketId). */
export async function runNext(ticketId?: string): Promise<void> {
  const c: Caps = caps();
  let projectRoot: string;
  try {
    projectRoot = findProjectRoot();
  } catch (error) {
    process.stderr.write(`\n  ${signal(c, 'error')} ${String(error)}\n`);
    process.exit(1);
    return;
  }

  // 티켓이 없는 건 오류가 아니라 스펙 단계다 — 캐묻기 지침이 필요한 바로 그 자리라
  // 실패로 끝내면 스킬이 볼 게 없어진다(dogfood-20260730). ticket-id 를 직접 준 경우는
  // 그 티켓을 찾아야 하므로 이 분기를 타지 않는다.
  if (ticketId === undefined && resolveCurrentTicketId(projectRoot) === null) {
    process.stdout.write(renderSpecStage(computeSpecStageView(projectRoot), c));
    return;
  }

  let view: NextView;
  try {
    view = computeNextView(projectRoot, ticketId);
    view.knownFindings = await checkFindingsFreshness(projectRoot, view.knownFindings);
  } catch (error) {
    process.stderr.write(
      `\n  ${signal(c, 'error')} ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
    return;
  }

  process.stdout.write(renderView(view, c));
}
