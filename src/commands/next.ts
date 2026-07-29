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
 * audit 레코드는 workitem 단위(AC 모델)라 스펙(specId)과 직접 이어주는 필드가
 * 없었다 — record.ts 가 top-level 필드를 제한하지 않으므로(D-15) `awl record audit`
 * 호출 시 `specId` 를 자유 필드로 얹으면 코드 변경 없이 이어진다. specId 없이
 * 남긴(옛) audit 기록은 이 집계에서 조용히 빠진다(하위호환, 크래시하지 않는다).
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

  const allFindings: KnownFinding[] = [];
  if (specId) {
    for (const r of readRecords(projectRoot, { type: 'audit' })) {
      if (r.specId !== specId) {
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
