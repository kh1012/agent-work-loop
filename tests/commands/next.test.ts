import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createDoc } from '../../src/commands/doc.js';
import { computeNextView } from '../../src/commands/next.js';
import { appendRecord } from '../../src/commands/record.js';
import { deriveTickets } from '../../src/commands/tickets.js';
import { parseFrontmatter } from '../../src/core/doc-frontmatter.js';

const origHome = process.env.AWL_HOME;

afterEach(() => {
  if (origHome === undefined) {
    delete process.env.AWL_HOME;
  } else {
    process.env.AWL_HOME = origHome;
  }
});

function tmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** 조건 하나짜리 스펙 → 티켓 하나를 실제로 도출한다(deriveTickets 재사용). */
async function specWithOneTicket(
  projectRoot: string,
  conditionText = '언제 포커스가 패널에 있고 방향키를 누르면, 선택이 이동해야 한다',
): Promise<{ specId: string; ticketId: string }> {
  const spec = await createDoc('spec', '레이어 패널 키보드 조작', projectRoot);
  const content = fs.readFileSync(spec.path, 'utf8');
  const parsed = parseFrontmatter(content);
  if (!parsed) {
    throw new Error('spec 스캐폴드 파싱 실패');
  }
  const body = parsed.body.replace(
    '## Conditions\n',
    `## Conditions\n\n### condition-1\n${conditionText}\n`,
  );
  fs.writeFileSync(spec.path, content.replace(parsed.body, body));

  const derived = await deriveTickets(projectRoot, spec.id);
  const ticketId = derived.created[0]?.id;
  if (!ticketId) {
    throw new Error('티켓 도출 실패');
  }
  return { specId: spec.id, ticketId };
}

function gateRecord(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: `rec_${Math.random().toString(36).slice(2)}`,
    at: new Date().toISOString(),
    type: 'gate',
    project: 'p',
    ...overrides,
  };
}

describe('computeNextView', () => {
  it('존재하는 ticket id 로 status·조건 원문·spec 제목·게이트 이력을 조립한다(EARS #1/#2)', async () => {
    const p = tmp('awl-next-');
    process.env.AWL_HOME = tmp('awl-next-home-');
    const { specId, ticketId } = await specWithOneTicket(p);

    const view = computeNextView(p, ticketId);

    expect(view.ticketId).toBe(ticketId);
    expect(view.specId).toBe(specId);
    expect(view.specTitle).toBe('레이어 패널 키보드 조작');
    expect(view.status).toBe('pending');
    expect(view.conditionText).toContain('언제 포커스가 패널에 있고 방향키를 누르면');
    expect(view.gateHistory).toEqual([]);
    expect(view.hint).toContain('게이트 2');
  });

  it('스펙을 못 찾거나 spec 필드가 비어 있으면 크래시하지 않고 null 로 빠진다(EARS #3)', async () => {
    const p = tmp('awl-next-');
    process.env.AWL_HOME = tmp('awl-next-home-');
    const ticket = await createDoc('ticket', '제목', p, {
      spec: 'no-such-spec',
      conditions: ['condition-1'],
    });

    const view = computeNextView(p, ticket.id);

    expect(view.specTitle).toBeNull();
    expect(view.conditionText).toBeNull();
  });

  it('존재하지 않는 ticket id 는 에러를 던진다(EARS #4)', () => {
    const p = tmp('awl-next-');
    process.env.AWL_HOME = tmp('awl-next-home-');
    expect(() => computeNextView(p, 'no-such-ticket')).toThrow('티켓을 찾을 수 없습니다');
  });

  it('게이트 기록이 없으면 게이트 이력이 빈 배열이다(에러 아님, EARS #5)', async () => {
    const p = tmp('awl-next-');
    process.env.AWL_HOME = tmp('awl-next-home-');
    const { ticketId } = await specWithOneTicket(p);

    const view = computeNextView(p, ticketId);
    expect(view.gateHistory).toEqual([]);
  });

  it('그 티켓에 대한 게이트 기록만 시간순으로 모은다(다른 티켓 기록은 안 섞인다)', async () => {
    const p = tmp('awl-next-');
    process.env.AWL_HOME = tmp('awl-next-home-');
    const { ticketId } = await specWithOneTicket(p);

    appendRecord(
      gateRecord({
        at: '2026-01-01T00:00:00.000Z',
        gate: 2,
        layer: 'ticket',
        ticket: ticketId,
        decision: 'approved',
        presentedCriteria: ['AC-01'],
      }),
    );
    appendRecord(
      gateRecord({
        at: '2026-01-02T00:00:00.000Z',
        gate: 3,
        layer: 'ticket',
        ticket: ticketId,
        decision: 'approved',
        presentedCriteria: ['AC-01'],
      }),
    );
    appendRecord(
      gateRecord({
        at: '2026-01-01T12:00:00.000Z',
        gate: 2,
        layer: 'ticket',
        ticket: '다른-티켓',
        decision: 'approved',
        presentedCriteria: ['AC-01'],
      }),
    );

    const view = computeNextView(p, ticketId);
    expect(view.gateHistory).toEqual([
      { gate: 2, decision: 'approved', at: '2026-01-01T00:00:00.000Z' },
      { gate: 3, decision: 'approved', at: '2026-01-02T00:00:00.000Z' },
    ]);
  });

  it('status 별로 알맞은 안내 문구가 붙는다(EARS #6)', async () => {
    const p = tmp('awl-next-');
    process.env.AWL_HOME = tmp('awl-next-home-');
    const { ticketId } = await specWithOneTicket(p);

    for (const [status, expected] of [
      ['pending', '게이트 2'],
      ['implementing', '게이트 3'],
      ['reviewing', '리뷰'],
      ['done', '완료'],
      ['blocked', '막혔습니다'],
    ] as const) {
      const dir = path.join(p, 'docs', 'tickets');
      const [file] = fs.readdirSync(dir);
      const filePath = path.join(dir, file as string);
      const content = fs
        .readFileSync(filePath, 'utf8')
        .replace(/^status: .+$/m, `status: ${status}`);
      fs.writeFileSync(filePath, content);

      const view = computeNextView(p, ticketId);
      expect(view.hint).toContain(expected);
    }
  });

  it('알 수 없는 status 값도 크래시하지 않고 그대로 보여준다(EARS #7)', async () => {
    const p = tmp('awl-next-');
    process.env.AWL_HOME = tmp('awl-next-home-');
    const { ticketId } = await specWithOneTicket(p);

    const dir = path.join(p, 'docs', 'tickets');
    const [file] = fs.readdirSync(dir);
    const filePath = path.join(dir, file as string);
    const content = fs.readFileSync(filePath, 'utf8').replace(/^status: .+$/m, 'status: 이상한값');
    fs.writeFileSync(filePath, content);

    const view = computeNextView(p, ticketId);
    expect(view.hint).toContain('이상한값');
  });
});
