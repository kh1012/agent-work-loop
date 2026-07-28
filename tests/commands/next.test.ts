import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createDoc } from '../../src/commands/doc.js';
import { checkFindingsFreshness, computeNextView } from '../../src/commands/next.js';
import { profilePath } from '../../src/commands/profile.js';
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
      p,
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
      p,
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
      p,
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

  it('같은 스펙의 audit finding 을 "이미 아는 것"으로 모은다(specId 로 join, WI-G21)', async () => {
    const p = tmp('awl-next-');
    process.env.AWL_HOME = tmp('awl-next-home-');
    const { specId, ticketId } = await specWithOneTicket(p);

    appendRecord(
      {
        id: 'rec_1',
        at: '2026-01-01T00:00:00.000Z',
        type: 'audit',
        project: 'p',
        specId,
        scope: '조사',
        findings: [{ id: 'finding-1', what: '기존 훅이 방향키를 먹는다', where: 'src/a.ts:10', source: 'investigation' }],
      },
      p,
    );
    // 다른 스펙의 audit — 섞이면 안 된다.
    appendRecord(
      {
        id: 'rec_2',
        at: '2026-01-01T00:00:00.000Z',
        type: 'audit',
        project: 'p',
        specId: '다른-스펙',
        scope: '조사',
        findings: [{ id: 'finding-9', what: '무관한 발견' }],
      },
      p,
    );

    const view = computeNextView(p, ticketId);
    expect(view.knownFindings).toHaveLength(1);
    expect(view.knownFindings[0]?.id).toBe('finding-1');
    expect(view.knownFindings[0]?.where).toBe('src/a.ts:10');
  });

  it('specId 없는(옛) audit 기록은 조용히 빠진다(하위호환)', async () => {
    const p = tmp('awl-next-');
    process.env.AWL_HOME = tmp('awl-next-home-');
    const { ticketId } = await specWithOneTicket(p);

    appendRecord(
      {
        id: 'rec_1',
        at: '2026-01-01T00:00:00.000Z',
        type: 'audit',
        project: 'p',
        scope: '조사',
        findings: [{ id: 'F-01', what: '옛 관례' }],
      },
      p,
    );

    const view = computeNextView(p, ticketId);
    expect(view.knownFindings).toEqual([]);
  });

  it('status 에 해당하는 profile.skills 슬롯을 skill 줄에 노출한다(WI-G21)', async () => {
    const p = tmp('awl-next-');
    process.env.AWL_HOME = tmp('awl-next-home-');
    const { ticketId } = await specWithOneTicket(p);
    fs.mkdirSync(path.join(p, '.awl'), { recursive: true });
    fs.writeFileSync(
      profilePath(p),
      JSON.stringify({
        name: 'p',
        skills: {
          spec: null,
          investigation: { type: 'external', url: 'https://example.com/investigation' },
          clarification: null,
          spike: null,
          implement: null,
          review: null,
        },
      }),
    );

    const view = computeNextView(p, ticketId); // status 는 기본 pending → investigation 슬롯
    expect(view.skill).toContain('investigation');
    expect(view.skill).toContain('https://example.com/investigation');
  });

  it('profile.json 이 없으면 skill 은 null(크래시하지 않는다)', async () => {
    const p = tmp('awl-next-');
    process.env.AWL_HOME = tmp('awl-next-home-');
    const { ticketId } = await specWithOneTicket(p);

    const view = computeNextView(p, ticketId);
    expect(view.skill).toBeNull();
  });
});

describe('checkFindingsFreshness — "확인 필요" 판정 (WI-G21)', () => {
  function gitRepo(): { dir: string; g: (args: string[]) => string } {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'awl-next-git-')));
    const g = (args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
    g(['init', '-q', '-b', 'main']);
    g(['config', 'user.email', 'x@x.com']);
    g(['config', 'user.name', 'x']);
    g(['config', 'commit.gpgsign', 'false']);
    return { dir, g };
  }

  it('finding 기록 이후 그 파일이 커밋됐으면 needsRecheck:true', async () => {
    const { dir, g } = gitRepo();
    fs.writeFileSync(path.join(dir, 'a.ts'), 'v1\n');
    g(['add', '-A']);
    g(['commit', '-q', '-m', 'v1']);

    const recordedAt = new Date().toISOString();
    await new Promise((r) => setTimeout(r, 1100)); // git log --since 는 초 단위 — 확실히 뒤 커밋으로 만든다.
    fs.writeFileSync(path.join(dir, 'a.ts'), 'v2\n');
    g(['add', '-A']);
    g(['commit', '-q', '-m', 'v2']);

    const out = await checkFindingsFreshness(dir, [
      { id: 'finding-1', what: 'x', where: 'a.ts:1', recordedAt },
    ]);
    expect(out[0]?.needsRecheck).toBe(true);
  });

  it('finding 기록 이후 그 파일이 안 바뀌었으면 needsRecheck:false', async () => {
    const { dir, g } = gitRepo();
    fs.writeFileSync(path.join(dir, 'a.ts'), 'v1\n');
    g(['add', '-A']);
    g(['commit', '-q', '-m', 'v1']);

    const recordedAt = new Date(Date.now() + 5000).toISOString(); // 커밋보다 미래로 — 그 뒤 변경 없음

    const out = await checkFindingsFreshness(dir, [
      { id: 'finding-1', what: 'x', where: 'a.ts:1', recordedAt },
    ]);
    expect(out[0]?.needsRecheck).toBe(false);
  });

  it('where/recordedAt 이 없으면 판정을 건너뛴다(그대로 반환, 크래시하지 않는다)', async () => {
    const { dir } = gitRepo();
    const out = await checkFindingsFreshness(dir, [{ id: 'finding-1', what: 'x' }]);
    expect(out[0]?.needsRecheck).toBeUndefined();
  });

  it('git 저장소가 아니어도 크래시하지 않고 원본을 그대로 돌려준다', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'awl-next-nogit-'));
    const out = await checkFindingsFreshness(dir, [
      { id: 'finding-1', what: 'x', where: 'a.ts:1', recordedAt: new Date().toISOString() },
    ]);
    expect(out[0]?.id).toBe('finding-1');
  });
});
