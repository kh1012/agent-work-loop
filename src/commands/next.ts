import fs from 'node:fs';
import { type FrontmatterData, parseFrontmatter } from '../core/doc-frontmatter.js';
import { findProjectRoot } from '../core/paths.js';
import { run } from '../core/runner.js';
import { type Caps, caps, signal } from '../core/tty.js';
import { type DocType, extractConditionBlocks, listDocFiles } from './doc.js';
import { type SkillSlot, loadProfile, skillRefLabel } from './profile.js';
import { readRecords } from './record.js';

/**
 * `awl next <ticket-id>` — 지금 이 티켓에 대해 이미 아는 것(스펙 조건·게이트 이력·
 * 같은 스펙의 다른 티켓이 조사에서 남긴 finding)과 다음에 뭘 해야 하는지를 조립해
 * 보여준다(ADK stage 2c, 읽기 전용).
 *
 * 아무것도 안 쓰고 판단도 안 한다 — 있는 걸 조립할 뿐이다. 인자 없는 "지금 티켓"
 * 자동판정, .tasks 파이프라인 연동은 이번 범위가 아니다.
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

export interface GateHistoryEntry {
  gate: number;
  decision: string;
  at: string;
}

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

export interface NextView {
  ticketId: string;
  ticketPath: string;
  status: string;
  specId: string;
  specTitle: string | null;
  conditionId: string | null;
  conditionText: string | null;
  gateHistory: GateHistoryEntry[];
  knownFindings: KnownFinding[];
  /** 지금 status 에 해당하는 profile.skills 슬롯 라벨. 매칭 슬롯이 없거나 profile 이 없으면 null. */
  skill: string | null;
  hint: string;
}

export function computeNextView(projectRoot: string, ticketId: string): NextView {
  const ticket = findDocById(projectRoot, 'ticket', ticketId);
  if (!ticket) {
    throw new Error(`티켓을 찾을 수 없습니다: ${ticketId}`);
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

  const gateHistory: GateHistoryEntry[] = readRecords(projectRoot, { type: 'gate' })
    .filter((r) => r.ticket === ticketId)
    .map((r) => ({
      gate: typeof r.gate === 'number' ? r.gate : Number.NaN,
      decision: typeof r.decision === 'string' ? r.decision : '',
      at: typeof r.at === 'string' ? r.at : '',
    }))
    .sort((a, b) => a.at.localeCompare(b.at));

  const status = typeof ticket.data.status === 'string' ? ticket.data.status : 'pending';

  const knownFindings: KnownFinding[] = [];
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
        knownFindings.push({
          id: item.id,
          what: item.what,
          where: typeof item.where === 'string' ? item.where : undefined,
          source: typeof item.source === 'string' ? item.source : undefined,
          recordedAt,
        });
      }
    }
  }

  const slot = STATUS_TO_SKILL_SLOT[status];
  const profile = slot ? loadProfile(projectRoot).profile : null;
  const skill = profile ? `${slot}: ${skillRefLabel(profile.skills[slot as SkillSlot])}` : null;

  return {
    ticketId,
    ticketPath: ticket.path,
    status,
    specId,
    specTitle: typeof spec?.data.title === 'string' ? spec.data.title : null,
    conditionId,
    conditionText,
    gateHistory,
    knownFindings,
    skill,
    hint: hintForStatus(status),
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
  lines.push('  게이트 이력');
  if (view.gateHistory.length === 0) {
    lines.push('    아직 없음');
  } else {
    for (const g of view.gateHistory) {
      lines.push(`    gate ${g.gate} (${GATE_LABELS[g.gate] ?? '?'})   ${g.decision}   ${g.at}`);
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
  if (view.skill) {
    lines.push('');
    lines.push(`  skill    ${view.skill}`);
  }
  lines.push('');
  lines.push('  다음');
  lines.push(`    ${view.hint}`);
  return `\n  ${signal(c, 'ok')} ${view.ticketId}\n\n${lines.join('\n')}\n`;
}

export async function runNext(ticketId: string): Promise<void> {
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
