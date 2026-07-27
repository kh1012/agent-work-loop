import fs from 'node:fs';
import { type FrontmatterData, parseFrontmatter } from '../core/doc-frontmatter.js';
import { findProjectRoot } from '../core/paths.js';
import { type Caps, caps, signal } from '../core/tty.js';
import { type DocType, extractConditionBlocks, listDocFiles } from './doc.js';
import { readRecords } from './record.js';

/**
 * `awl next <ticket-id>` — 지금 이 티켓에 대해 이미 아는 것(스펙 조건·게이트 이력)과
 * 다음에 뭘 해야 하는지를 조립해 보여준다(ADK stage 2c, 읽기 전용).
 *
 * 아무것도 안 쓰고 판단도 안 한다 — 있는 걸 조립할 뿐이다. finding/constraint 재사용,
 * 인자 없는 "지금 티켓" 자동판정, .tasks 파이프라인 연동은 이번 범위가 아니다.
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

export interface NextView {
  ticketId: string;
  ticketPath: string;
  status: string;
  specId: string;
  specTitle: string | null;
  conditionId: string | null;
  conditionText: string | null;
  gateHistory: GateHistoryEntry[];
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

  const gateHistory: GateHistoryEntry[] = readRecords({ type: 'gate' })
    .filter((r) => r.ticket === ticketId)
    .map((r) => ({
      gate: typeof r.gate === 'number' ? r.gate : Number.NaN,
      decision: typeof r.decision === 'string' ? r.decision : '',
      at: typeof r.at === 'string' ? r.at : '',
    }))
    .sort((a, b) => a.at.localeCompare(b.at));

  const status = typeof ticket.data.status === 'string' ? ticket.data.status : 'pending';

  return {
    ticketId,
    ticketPath: ticket.path,
    status,
    specId,
    specTitle: typeof spec?.data.title === 'string' ? spec.data.title : null,
    conditionId,
    conditionText,
    gateHistory,
    hint: hintForStatus(status),
  };
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
  } catch (error) {
    process.stderr.write(
      `\n  ${signal(c, 'error')} ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
    return;
  }

  process.stdout.write(renderView(view, c));
}
