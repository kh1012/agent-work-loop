import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createDoc } from '../../src/commands/doc.js';
import { deriveTickets } from '../../src/commands/tickets.js';
import { parseFrontmatter } from '../../src/core/doc-frontmatter.js';

function tmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function specWithConditions(
  projectRoot: string,
  conditions: { heading: string; text: string }[],
): Promise<string> {
  const result = await createDoc('spec', '레이어 패널 키보드 조작', projectRoot);
  const content = fs.readFileSync(result.path, 'utf8');
  const parsed = parseFrontmatter(content);
  if (!parsed) {
    throw new Error('spec 스캐폴드 파싱 실패');
  }
  const conditionsBlock = conditions.map((c) => `### ${c.heading}\n${c.text}`).join('\n\n');
  const body = parsed.body.replace('## Conditions\n', `## Conditions\n\n${conditionsBlock}\n`);
  fs.writeFileSync(result.path, content.replace(parsed.body, body));
  return result.id;
}

describe('deriveTickets', () => {
  it('조건 N개짜리 스펙 → 티켓 N개를 생성한다(EARS #1)', async () => {
    const p = tmp('awl-tickets-derive-');
    const specId = await specWithConditions(p, [
      {
        heading: 'condition-1',
        text: '언제 포커스가 패널에 있고 방향키를 누르면, 선택이 이동해야 한다',
      },
      {
        heading: 'condition-2',
        text: '만약 이름 편집 중이라면, 방향키는 선택을 이동시키지 않아야 한다',
      },
    ]);

    const result = await deriveTickets(p, specId);

    expect(result.conditionsFound).toBe(2);
    expect(result.created).toHaveLength(2);
    expect(result.skipped).toEqual([]);
    for (const t of result.created) {
      expect(fs.existsSync(t.path)).toBe(true);
      const parsed = parseFrontmatter(fs.readFileSync(t.path, 'utf8'));
      expect(parsed?.data.spec).toBe(specId);
      expect(parsed?.data.status).toBe('pending');
      expect(parsed?.data.dependencies).toEqual([]);
      expect(parsed?.data.conditions).toEqual([t.condition]);
    }
  });

  it('재실행해도 중복 티켓이 생기지 않는다(멱등, EARS #2)', async () => {
    const p = tmp('awl-tickets-derive-');
    const specId = await specWithConditions(p, [
      { heading: 'condition-1', text: '언제 X 이면, Y 해야 한다' },
    ]);

    const first = await deriveTickets(p, specId);
    expect(first.created).toHaveLength(1);

    const second = await deriveTickets(p, specId, new Date(Date.now() + 5000));
    expect(second.created).toHaveLength(0);
    expect(second.skipped).toEqual(['condition-1']);
  });

  it('새 티켓이 생기면 스펙의 tickets 프론트매터 배열에 반영된다(EARS #3)', async () => {
    const p = tmp('awl-tickets-derive-');
    const specId = await specWithConditions(p, [
      { heading: 'condition-1', text: '언제 X 이면, Y 해야 한다' },
      { heading: 'condition-2', text: '만약 Z 라면, W 해야 한다' },
    ]);

    const result = await deriveTickets(p, specId);

    const specPath = result.specPath;
    const specParsed = parseFrontmatter(fs.readFileSync(specPath, 'utf8'));
    const ticketIds = result.created.map((t) => t.id);
    expect(specParsed?.data.tickets).toEqual(expect.arrayContaining(ticketIds));
    expect((specParsed?.data.tickets as string[]).length).toBe(2);
  });

  it('일부만 새로 도출되면 스펙의 tickets 배열에 기존 것을 보존하고 새 것만 추가한다', async () => {
    const p = tmp('awl-tickets-derive-');
    const specId = await specWithConditions(p, [
      { heading: 'condition-1', text: '언제 X 이면, Y 해야 한다' },
    ]);
    const first = await deriveTickets(p, specId);
    const firstTicketId = first.created[0]?.id;

    // 조건 하나를 더 추가한 뒤 다시 도출 — ## Conditions 섹션 안에 넣어야 한다.
    // 그 다음 절은 ## Qualitative 다(설계 §2 뼈대, 2단계 #11).
    const content = fs.readFileSync(first.specPath, 'utf8');
    const updated = content.replace(
      '## Qualitative',
      '### condition-2\n만약 Z 라면, W 해야 한다\n\n## Qualitative',
    );
    fs.writeFileSync(first.specPath, updated);

    const second = await deriveTickets(p, specId, new Date(Date.now() + 5000));
    expect(second.created).toHaveLength(1);
    expect(second.skipped).toEqual(['condition-1']);

    const finalSpecParsed = parseFrontmatter(fs.readFileSync(first.specPath, 'utf8'));
    const tickets = finalSpecParsed?.data.tickets as string[];
    expect(tickets).toContain(firstTicketId);
    expect(tickets).toContain(second.created[0]?.id);
    expect(tickets).toHaveLength(2);
  });

  it('존재하지 않는 spec-id 는 에러로 실패한다(EARS #4)', async () => {
    const p = tmp('awl-tickets-derive-');
    await expect(deriveTickets(p, 'not-a-real-id')).rejects.toThrow('spec을 찾을 수 없습니다');
  });

  it('조건이 없는 스펙(스캐폴드 직후)은 에러 없이 티켓 0개로 끝난다', async () => {
    const p = tmp('awl-tickets-derive-');
    const result = await createDoc('spec', '아직 조건 없음', p);
    const derived = await deriveTickets(p, result.id);
    expect(derived.conditionsFound).toBe(0);
    expect(derived.created).toEqual([]);
  });
});
