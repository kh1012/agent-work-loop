import fs from 'node:fs';
import path from 'node:path';
import {
  type FrontmatterData,
  parseFrontmatter,
  serializeFrontmatter,
} from '../core/doc-frontmatter.js';
import { findProjectRoot } from '../core/paths.js';
import { type Caps, caps, signal } from '../core/tty.js';
import { createDoc, extractConditionBlocks, listDocFiles } from './doc.js';

/**
 * `awl tickets derive` — 스펙의 조건 하나당 티켓 파일 하나를 기계적으로 만든다
 * (ADK stage 2a). 순서·기반 판단 없이 1:1로 도출한다. "여러 조건이 공유하는
 * 기반" 같은 판단이 필요한 티켓(conditions:[] 인 기반 티켓)은 이 명령의 범위가
 * 아니다 — 필요하면 `awl doc new ticket --spec <id>` 를 직접 쓴다(ADK stage 1).
 */

interface ParsedSpec {
  path: string;
  data: FrontmatterData;
  body: string;
}

function findSpecById(projectRoot: string, specId: string): ParsedSpec | null {
  for (const file of listDocFiles(projectRoot)) {
    if (file.type !== 'spec') {
      continue;
    }
    const parsed = parseFrontmatter(fs.readFileSync(file.path, 'utf8'));
    if (parsed?.data.id === specId) {
      return { path: file.path, data: parsed.data, body: parsed.body };
    }
  }
  return null;
}

/** 이 스펙에서 이미 티켓으로 도출된 조건 식별자 집합(멱등 판정 근거). */
function existingTicketConditions(projectRoot: string, specId: string): Set<string> {
  const covered = new Set<string>();
  for (const file of listDocFiles(projectRoot)) {
    if (file.type !== 'ticket') {
      continue;
    }
    const parsed = parseFrontmatter(fs.readFileSync(file.path, 'utf8'));
    if (!parsed || parsed.data.spec !== specId) {
      continue;
    }
    const conditions = parsed.data.conditions;
    if (Array.isArray(conditions)) {
      for (const c of conditions) {
        covered.add(c);
      }
    }
  }
  return covered;
}

/** 조건 본문 첫 줄(최대 40자)을 제목으로 쓴다 — 의미를 창작하지 않는다(기계적 도출). */
function ticketTitleFromCondition(text: string): string {
  const firstLine = text.split(/\r?\n/).find((l) => l.trim() !== '') ?? '';
  const trimmed = firstLine.trim();
  if (trimmed === '') {
    return '제목 없음';
  }
  return trimmed.length > 40 ? `${trimmed.slice(0, 40)}...` : trimmed;
}

export interface DeriveResult {
  specPath: string;
  conditionsFound: number;
  created: { path: string; id: string; condition: string }[];
  skipped: string[];
}

export async function deriveTickets(
  projectRoot: string,
  specId: string,
  now: Date = new Date(),
): Promise<DeriveResult> {
  const spec = findSpecById(projectRoot, specId);
  if (!spec) {
    throw new Error(`spec을 찾을 수 없습니다: ${specId}`);
  }

  const conditions = extractConditionBlocks(spec.body);
  const covered = existingTicketConditions(projectRoot, specId);

  const created: { path: string; id: string; condition: string }[] = [];
  const skipped: string[] = [];

  for (const [index, block] of conditions.entries()) {
    if (covered.has(block.heading)) {
      skipped.push(block.heading);
      continue;
    }
    // 같은 초에 여러 티켓을 만들어도 파일명이 겹치지 않게 인덱스만큼 시간을 민다.
    const ticketNow = new Date(now.getTime() + index * 1000);
    const title = ticketTitleFromCondition(block.text);
    const result = await createDoc(
      'ticket',
      title,
      projectRoot,
      { spec: specId, conditions: [block.heading] },
      ticketNow,
    );
    created.push({ path: result.path, id: result.id, condition: block.heading });
  }

  if (created.length > 0) {
    const existingTickets = Array.isArray(spec.data.tickets) ? spec.data.tickets : [];
    const nextTickets = [...new Set([...existingTickets, ...created.map((c) => c.id)])];
    const nextData: FrontmatterData = { ...spec.data, tickets: nextTickets };
    fs.writeFileSync(spec.path, `${serializeFrontmatter(nextData)}\n${spec.body}`);
  }

  return { specPath: spec.path, conditionsFound: conditions.length, created, skipped };
}

export async function runDeriveTickets(specId: string): Promise<void> {
  const c: Caps = caps();
  let projectRoot: string;
  try {
    projectRoot = findProjectRoot();
  } catch (error) {
    process.stderr.write(`\n  ${signal(c, 'error')} ${String(error)}\n`);
    process.exit(1);
    return;
  }

  let result: DeriveResult;
  try {
    result = await deriveTickets(projectRoot, specId);
  } catch (error) {
    process.stderr.write(
      `\n  ${signal(c, 'error')} ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
    return;
  }

  if (result.conditionsFound === 0) {
    process.stdout.write(
      `\n  ${signal(c, 'ok')} 이 스펙에 조건이 없습니다(## Conditions 섹션이 비어 있음).\n`,
    );
    return;
  }
  if (result.created.length === 0) {
    process.stdout.write(
      `\n  ${signal(c, 'ok')} 새로 만들 티켓이 없습니다(조건 ${result.skipped.length}개 모두 이미 도출됨).\n`,
    );
    return;
  }

  process.stdout.write(`\n  ${signal(c, 'ok')} 티켓 ${result.created.length}개 생성\n`);
  for (const t of result.created) {
    process.stdout.write(`      ${path.relative(projectRoot, t.path)}  (${t.condition})\n`);
  }
  if (result.skipped.length > 0) {
    process.stdout.write(`  ${result.skipped.length}개 조건은 이미 도출되어 건너뜀\n`);
  }
}
