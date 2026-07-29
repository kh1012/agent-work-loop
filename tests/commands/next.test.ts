import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDoc } from '../../src/commands/doc.js';
import {
  MAX_SHOWN_CONSTRAINTS,
  MAX_SHOWN_FINDINGS,
  checkFindingsFreshness,
  computeNextView,
  computeSpecStageView,
  modeContract,
  renderSpecStage,
  resolveCurrentTicketId,
  runNext,
} from '../../src/commands/next.js';
import { defaultProfileSkills, profilePath } from '../../src/commands/profile.js';
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
      { gate: 2, decision: 'approved', at: '2026-01-01T00:00:00.000Z', retries: 0 },
      { gate: 3, decision: 'approved', at: '2026-01-02T00:00:00.000Z', retries: 0 },
    ]);
  });

  it('같은 게이트가 여러 번 기록되면(재작업) 최신 1건만 남고 retries 로 횟수를 곁들인다(WI-I1, status.ts 와 같은 원칙)', async () => {
    const p = tmp('awl-next-');
    process.env.AWL_HOME = tmp('awl-next-home-');
    const { ticketId } = await specWithOneTicket(p);

    appendRecord(
      gateRecord({
        at: '2026-01-01T00:00:00.000Z',
        gate: 2,
        layer: 'ticket',
        ticket: ticketId,
        decision: 'more-work',
        presentedCriteria: ['AC-01'],
      }),
      p,
    );
    appendRecord(
      gateRecord({
        at: '2026-01-02T00:00:00.000Z',
        gate: 2,
        layer: 'ticket',
        ticket: ticketId,
        decision: 'more-work',
        presentedCriteria: ['AC-01'],
      }),
      p,
    );
    appendRecord(
      gateRecord({
        at: '2026-01-03T00:00:00.000Z',
        gate: 2,
        layer: 'ticket',
        ticket: ticketId,
        decision: 'approved',
        presentedCriteria: ['AC-01'],
      }),
      p,
    );

    const view = computeNextView(p, ticketId);
    expect(view.gateHistory).toEqual([
      { gate: 2, decision: 'approved', at: '2026-01-03T00:00:00.000Z', retries: 2 },
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
        findings: [
          {
            id: 'finding-1',
            what: '기존 훅이 방향키를 먹는다',
            where: 'src/a.ts:10',
            source: 'investigation',
          },
        ],
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

/** ticket 파일의 status 줄을 직접 바꾼다(테스트 전용 — status 별로 알맞은 안내 문구 테스트와 같은 패턴). */
function setTicketStatus(ticketPath: string, status: string): void {
  const content = fs.readFileSync(ticketPath, 'utf8').replace(/^status: .+$/m, `status: ${status}`);
  fs.writeFileSync(ticketPath, content);
}

describe('resolveCurrentTicketId — "지금" 티켓 자동판정 (WI-H1)', () => {
  it('implementing 인 티켓이 있으면 그걸 고른다', async () => {
    const p = tmp('awl-next-');
    process.env.AWL_HOME = tmp('awl-next-home-');
    const { ticketId: t1 } = await specWithOneTicket(p);
    const dir = path.join(p, 'docs', 'tickets');
    const files = fs.readdirSync(dir);
    const t1Path = files
      .map((f) => path.join(dir, f))
      .find((fp) => parseFrontmatter(fs.readFileSync(fp, 'utf8'))?.data.id === t1);
    if (!t1Path) {
      throw new Error('t1 파일을 못 찾음');
    }
    setTicketStatus(t1Path, 'implementing');

    expect(resolveCurrentTicketId(p)).toBe(t1);
  });

  it('implementing 이 없고 dependencies 가 없는 pending 만 있으면 그걸 고른다', async () => {
    const p = tmp('awl-next-');
    process.env.AWL_HOME = tmp('awl-next-home-');
    const { ticketId } = await specWithOneTicket(p);
    expect(resolveCurrentTicketId(p)).toBe(ticketId); // 기본 status 는 pending, dependencies 없음
  });

  it('dependencies 가 아직 done 이 아닌 pending 티켓은 건너뛴다(막힘)', async () => {
    const p = tmp('awl-next-');
    process.env.AWL_HOME = tmp('awl-next-home-');
    const spec = await createDoc('spec', '스펙', p);
    const blocked = await createDoc('ticket', '막힌 티켓', p, {
      spec: spec.id,
      conditions: [],
      dependencies: ['no-such-ticket-not-done'],
    });
    expect(resolveCurrentTicketId(p)).toBe(null); // 유일한 티켓이 막혀있어 고를 게 없다
    void blocked;
  });

  it('dependencies 가 전부 done 이면 그 pending 티켓을 고른다(막힘 해제)', async () => {
    const p = tmp('awl-next-');
    process.env.AWL_HOME = tmp('awl-next-home-');
    const spec = await createDoc('spec', '스펙', p);
    const base = await createDoc('ticket', '기반 티켓', p, { spec: spec.id, conditions: [] });
    const dir = path.join(p, 'docs', 'tickets');
    const files = fs.readdirSync(dir);
    const basePath = files
      .map((f) => path.join(dir, f))
      .find((fp) => parseFrontmatter(fs.readFileSync(fp, 'utf8'))?.data.id === base.id);
    if (!basePath) {
      throw new Error('base 파일을 못 찾음');
    }
    setTicketStatus(basePath, 'done');
    const dependent = await createDoc('ticket', '의존 티켓', p, {
      spec: spec.id,
      conditions: [],
      dependencies: [base.id],
    });

    expect(resolveCurrentTicketId(p)).toBe(dependent.id);
  });

  it('티켓이 하나도 없으면 null', () => {
    const p = tmp('awl-next-');
    process.env.AWL_HOME = tmp('awl-next-home-');
    expect(resolveCurrentTicketId(p)).toBe(null);
  });

  it('computeNextView 가 ticketId 를 생략하면 resolveCurrentTicketId 로 고른 티켓을 쓴다', async () => {
    const p = tmp('awl-next-');
    process.env.AWL_HOME = tmp('awl-next-home-');
    const { ticketId } = await specWithOneTicket(p);
    const view = computeNextView(p);
    expect(view.ticketId).toBe(ticketId);
  });

  it('고를 티켓이 없으면 computeNextView 가 명확한 에러를 던진다(크래시 스택 아님)', () => {
    const p = tmp('awl-next-');
    process.env.AWL_HOME = tmp('awl-next-home-');
    expect(() => computeNextView(p)).toThrow('진행할 티켓을 찾지 못했습니다');
  });
});

describe('NextView.constraints — 스펙 Constraints 섹션 노출 (WI-H1)', () => {
  it('스펙의 constraint 블록을 전부 뽑아 id/text 로 담는다', async () => {
    const p = tmp('awl-next-');
    process.env.AWL_HOME = tmp('awl-next-home-');
    const { specId, ticketId } = await specWithOneTicket(p);
    const specDir = path.join(p, 'docs', 'specs');
    const [specFile] = fs.readdirSync(specDir);
    const specPath = path.join(specDir, specFile as string);
    const content = fs.readFileSync(specPath, 'utf8');
    const parsed = parseFrontmatter(content);
    if (!parsed) {
      throw new Error('스펙 파싱 실패');
    }
    const body = parsed.body.replace(
      '## Constraints\n',
      '## Constraints\n\n### constraint-1\nPuck 코어를 수정하지 않는다\n\nverification: git diff 에 없음\n',
    );
    fs.writeFileSync(specPath, content.replace(parsed.body, body));
    void specId;

    const view = computeNextView(p, ticketId);
    expect(view.constraints).toHaveLength(1);
    expect(view.constraints[0]?.id).toBe('constraint-1');
    expect(view.constraints[0]?.text).toContain('Puck 코어를 수정하지 않는다');
  });

  it('Constraints 섹션이 비어있으면 빈 배열(크래시 아님)', async () => {
    const p = tmp('awl-next-');
    process.env.AWL_HOME = tmp('awl-next-home-');
    const { ticketId } = await specWithOneTicket(p);
    const view = computeNextView(p, ticketId);
    expect(view.constraints).toEqual([]);
  });
});

describe('NextView.gateChecklists — 게이트 2/3 도달 계약 (WI-H1)', () => {
  it('항상 게이트 2/3 체크리스트를 정적으로 담는다', async () => {
    const p = tmp('awl-next-');
    process.env.AWL_HOME = tmp('awl-next-home-');
    const { ticketId } = await specWithOneTicket(p);
    const view = computeNextView(p, ticketId);
    expect(view.gateChecklists.map((g) => g.gate)).toEqual([2, 3]);
    expect(view.gateChecklists[0]?.items.map((i) => i.name)).toEqual([
      'finding',
      'clarification',
      'verification',
    ]);
  });
});

describe('토큰 상한 — finding/constraint 대량 누적 스트레스 (WI-I1)', () => {
  it(`finding 이 ${MAX_SHOWN_FINDINGS}건을 넘으면 최신 ${MAX_SHOWN_FINDINGS}건만 담고 나머지는 findingsTruncated 로 센다`, async () => {
    const p = tmp('awl-next-');
    process.env.AWL_HOME = tmp('awl-next-home-');
    const { specId, ticketId } = await specWithOneTicket(p);

    const total = MAX_SHOWN_FINDINGS + 25; // 상한을 넉넉히 넘긴다
    const findings = Array.from({ length: total }, (_, i) => ({
      id: `finding-${i + 1}`,
      what: `모듈 ${i + 1} 이관 필요`,
      where: `src/modules/m${i + 1}.ts:1`,
      source: 'investigation',
    }));
    appendRecord(
      {
        id: 'rec_bulk',
        at: '2026-07-29T00:00:00Z',
        type: 'audit',
        project: 'p',
        specId,
        scope: '대량 조사',
        findings,
      },
      p,
    );

    const view = computeNextView(p, ticketId);
    expect(view.knownFindings).toHaveLength(MAX_SHOWN_FINDINGS);
    expect(view.findingsTruncated).toBe(total - MAX_SHOWN_FINDINGS);
    // 가장 먼저 기록된(id 순서상 앞쪽) finding 들이 담긴다 — 유일한 audit 기록 안에서는
    // 원본 배열 순서 그대로 앞에서부터 자른다.
    expect(view.knownFindings[0]?.id).toBe('finding-1');
  });

  it(`finding 이 ${MAX_SHOWN_FINDINGS}건 이하면 잘리지 않는다(findingsTruncated:0)`, async () => {
    const p = tmp('awl-next-');
    process.env.AWL_HOME = tmp('awl-next-home-');
    const { specId, ticketId } = await specWithOneTicket(p);
    const findings = Array.from({ length: 5 }, (_, i) => ({ id: `finding-${i + 1}`, what: 'x' }));
    appendRecord(
      {
        id: 'rec_small',
        at: '2026-07-29T00:00:00Z',
        type: 'audit',
        project: 'p',
        specId,
        scope: 's',
        findings,
      },
      p,
    );

    const view = computeNextView(p, ticketId);
    expect(view.knownFindings).toHaveLength(5);
    expect(view.findingsTruncated).toBe(0);
  });

  it(`constraint 가 ${MAX_SHOWN_CONSTRAINTS}건을 넘으면 상위 ${MAX_SHOWN_CONSTRAINTS}건만 담고 나머지는 constraintsTruncated 로 센다`, async () => {
    const p = tmp('awl-next-');
    process.env.AWL_HOME = tmp('awl-next-home-');
    const { ticketId } = await specWithOneTicket(p);
    const specDir = path.join(p, 'docs', 'specs');
    const [specFile] = fs.readdirSync(specDir);
    const specPath = path.join(specDir, specFile as string);
    const content = fs.readFileSync(specPath, 'utf8');
    const parsed = parseFrontmatter(content);
    if (!parsed) {
      throw new Error('스펙 파싱 실패');
    }
    const total = MAX_SHOWN_CONSTRAINTS + 10;
    const blocks = Array.from(
      { length: total },
      (_, i) => `### constraint-${i + 1}\n제약 ${i + 1}\n`,
    ).join('\n');
    const body = parsed.body.replace('## Constraints\n', `## Constraints\n\n${blocks}`);
    fs.writeFileSync(specPath, content.replace(parsed.body, body));

    const view = computeNextView(p, ticketId);
    expect(view.constraints).toHaveLength(MAX_SHOWN_CONSTRAINTS);
    expect(view.constraintsTruncated).toBe(total - MAX_SHOWN_CONSTRAINTS);
  });

  it('게이트 재작업이 아무리 많아도(50회) 게이트당 한 줄만 남는다', async () => {
    const p = tmp('awl-next-');
    process.env.AWL_HOME = tmp('awl-next-home-');
    const { ticketId } = await specWithOneTicket(p);
    for (let i = 0; i < 50; i++) {
      appendRecord(
        gateRecord({
          at: `2026-01-01T00:${String(i).padStart(2, '0')}:00.000Z`,
          gate: 2,
          layer: 'ticket',
          ticket: ticketId,
          decision: i === 49 ? 'approved' : 'more-work',
          presentedCriteria: ['AC-01'],
        }),
        p,
      );
    }

    const view = computeNextView(p, ticketId);
    expect(view.gateHistory).toHaveLength(1);
    expect(view.gateHistory[0]?.retries).toBe(49);
    expect(view.gateHistory[0]?.decision).toBe('approved');
  });
});

// 모드는 게이트 자동승인만 정하는 게 아니다. 사람이 실제로 손을 대는 두 자리 —
// 게이트 1 앞의 캐묻기와 게이트 4의 마감 설명 — 의 강도도 같이 정한다.
describe('modeContract — 모드가 캐묻기·마감 강도를 정한다', () => {
  it('strict 는 미해결 0건까지 캐묻는다', () => {
    const c = modeContract('strict');
    expect(c.grill).toContain('0건');
    expect(c.close).toContain('확인');
  });

  it('semi-auto 는 한 번 캐묻고 남은 건 clarification 으로 넘긴다', () => {
    const c = modeContract('semi-auto');
    expect(c.grill).toContain('clarification');
    expect(c.grill).not.toContain('건너뛴다');
  });

  it('auto 는 캐묻지 않는다 — 사람 손을 뺀 모드에서 캐묻는 건 모순이다', () => {
    const c = modeContract('auto');
    expect(c.grill).toContain('건너뛴다');
  });

  it('세 모드의 캐묻기 강도가 서로 다르다(같으면 모드를 나눈 의미가 없다)', () => {
    const g = (['strict', 'semi-auto', 'auto'] as const).map((m) => modeContract(m).grill);
    expect(new Set(g).size).toBe(3);
  });

  it('마감 설명은 auto 만 요약으로 낮아진다', () => {
    expect(modeContract('auto').close).toContain('요약');
    expect(modeContract('strict').close).not.toContain('요약만');
    expect(modeContract('semi-auto').close).not.toContain('요약만');
  });
});

describe('SpecStageView — 티켓이 없는 스펙 단계 (dogfood-20260730)', () => {
  it('티켓이 하나도 없으면 던지지 않고 스펙 단계 뷰를 돌려준다', () => {
    const p = tmp('awl-next-');
    process.env.AWL_HOME = tmp('awl-next-home-');
    const view = computeSpecStageView(p);
    expect(view.kind).toBe('spec-stage');
  });

  it('지금 모드가 요구하는 캐묻기 강도를 담는다 — 캐물어야 할 그 순간에 지침이 0이면 안 된다', () => {
    const p = tmp('awl-next-');
    process.env.AWL_HOME = tmp('awl-next-home-');
    fs.mkdirSync(path.join(p, '.awl'), { recursive: true });
    fs.writeFileSync(path.join(p, '.awl', 'state.json'), JSON.stringify({ loopMode: 'strict' }));
    const view = computeSpecStageView(p);
    expect(view.modeContract.mode).toBe('strict');
    expect(view.modeContract.grill).toBe(modeContract('strict').grill);
  });

  it('spec·clarification 두 자리의 스킬을 함께 보여준다', async () => {
    const p = tmp('awl-next-');
    process.env.AWL_HOME = tmp('awl-next-home-');
    fs.mkdirSync(path.join(p, '.awl'), { recursive: true });
    fs.writeFileSync(
      profilePath(p),
      JSON.stringify({
        name: 'test',
        skills: {
          ...defaultProfileSkills(),
          spec: { type: 'external', url: 'https://example.test/grill-with-docs' },
          clarification: { type: 'external', url: 'https://example.test/grill-me' },
        },
      }),
    );
    const view = computeSpecStageView(p);
    expect(view.skills.map((s) => s.slot)).toEqual(['spec', 'clarification']);
    expect(view.skills[0]?.label).toContain('grill-with-docs');
    expect(view.skills[1]?.label).toContain('grill-me');
  });

  it('프로파일을 못 읽으면 스킬 자리를 비우되 왜인지 함께 남긴다 (조용히 사라지면 안 된다)', () => {
    const p = tmp('awl-next-');
    process.env.AWL_HOME = tmp('awl-next-home-');
    const view = computeSpecStageView(p);
    expect(view.skills).toEqual([]);
    expect(view.skillErrors.length).toBeGreaterThan(0);
    expect(view.modeContract.grill.length).toBeGreaterThan(0);

    const out = renderSpecStage(view, { color: false, unicode: false, width: 80 } as never);
    expect(out).toContain('skill    (없음');
  });

  it('profile.json 이 깨져 있어도 그 사실을 출력에 드러낸다', () => {
    const p = tmp('awl-next-');
    process.env.AWL_HOME = tmp('awl-next-home-');
    fs.mkdirSync(path.join(p, '.awl'), { recursive: true });
    fs.writeFileSync(profilePath(p), '{ broken');
    const out = renderSpecStage(computeSpecStageView(p), {
      color: false,
      unicode: false,
      width: 80,
    } as never);
    expect(out).toContain('skill    (없음');
    expect(out).toContain('파싱 오류');
  });

  it('아직 티켓이 안 도출된 스펙을 알려준다 — 다음에 무엇을 derive 할지 되묻지 않게', async () => {
    const p = tmp('awl-next-');
    process.env.AWL_HOME = tmp('awl-next-home-');
    await createDoc('spec', '레이어 패널 키보드 조작', p);
    const view = computeSpecStageView(p);
    expect(view.pendingSpecs).toHaveLength(1);
    expect(view.pendingSpecs[0]?.title).toBe('레이어 패널 키보드 조작');
  });

  // 이 블록은 runNext 를 **실제로 부른다**. 앞선 판에서는 같은 이름을 달고 순수함수
  // 두 개만 호출해, runNext 의 분기를 통째로 없애도 초록이었다(뮤테이션 M1 생존).
  it('runNext 를 실제로 불러도 exit 하지 않고 스펙 단계 뷰를 stdout 에 쓴다', async () => {
    const p = tmp('awl-next-');
    process.env.AWL_HOME = tmp('awl-next-home-');
    fs.mkdirSync(path.join(p, '.awl'), { recursive: true });
    const cwd = process.cwd();
    process.chdir(p);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);
    const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      await runNext();
      const out = outSpy.mock.calls.map((c) => String(c[0])).join('');
      expect(out).toContain('스펙 (아직 티켓 없음)');
      expect(out).toContain('캐묻기');
      expect(out).toContain('awl doc new spec');
      expect(exitSpy).not.toHaveBeenCalled();
    } finally {
      outSpy.mockRestore();
      exitSpy.mockRestore();
      process.chdir(cwd);
    }
  });

  it('티켓이 전부 done 이면 "티켓 없음"이 아니라 게이트 4 로 안내한다 (거짓 뷰 금지)', async () => {
    const p = tmp('awl-next-');
    process.env.AWL_HOME = tmp('awl-next-home-');
    const { specId, ticketId } = await specWithOneTicket(p);
    const dir = path.join(p, 'docs', 'tickets');
    const [file] = fs.readdirSync(dir);
    const fp = path.join(dir, file as string);
    fs.writeFileSync(fp, fs.readFileSync(fp, 'utf8').replace(/^status: .+$/m, 'status: done'));

    const view = computeSpecStageView(p);
    expect(view.reason).toBe('all-done');
    expect(view.gate4Specs.map((s) => s.id)).toContain(specId);

    const out = renderSpecStage(view, { color: false, unicode: false, width: 80 } as never);
    expect(out).toContain('게이트 4');
    expect(out).not.toContain('아직 티켓 없음');
    expect(out).not.toContain('awl doc new spec "<제목>"');
    expect(ticketId).toBeTruthy();
  });

  it('의존이 안 풀린 티켓만 남으면 무엇을 기다리는지 보여준다', async () => {
    const p = tmp('awl-next-');
    process.env.AWL_HOME = tmp('awl-next-home-');
    await specWithOneTicket(p);
    const dir = path.join(p, 'docs', 'tickets');
    const [file] = fs.readdirSync(dir);
    const fp = path.join(dir, file as string);
    fs.writeFileSync(
      fp,
      fs.readFileSync(fp, 'utf8').replace(/^dependencies: .*$/m, 'dependencies: [없는-선행-티켓]'),
    );

    const view = computeSpecStageView(p);
    expect(view.reason).toBe('stalled');
    expect(view.stalledTickets[0]?.waitingOn).toEqual(['없는-선행-티켓']);

    const out = renderSpecStage(view, { color: false, unicode: false, width: 80 } as never);
    expect(out).toContain('자동으로 고를 수 없는 티켓');
    expect(out).toContain('없는-선행-티켓');
    expect(out).not.toContain('아직 티켓 없음');
  });

  // record 는 `spec` 으로 쓰고 next 는 `specId` 로 읽던 불일치가 이 패널을 늘 비게
  // 했다. 정본 이름(`spec`)으로 남긴 기록이 잡히는지 직접 본다 — 여기가 비면
  // `r.spec === specId ||` 를 떼도 초록이다(재리뷰 M10 생존).
  it('정본 이름 spec 으로 남긴 조사가 "이미 아는 것"에 잡힌다', async () => {
    const p = tmp('awl-next-');
    process.env.AWL_HOME = tmp('awl-next-home-');
    const { specId, ticketId } = await specWithOneTicket(p);
    appendRecord(
      {
        id: 'rec_spec',
        at: new Date().toISOString(),
        type: 'audit',
        project: 'p',
        spec: specId,
        scope: 's',
        findings: [{ id: 'f-spec', what: '스펙에 붙인 조사', where: 'b.ts:2' }],
      },
      p,
    );
    const view = computeNextView(p, ticketId);
    expect(view.knownFindings.map((f) => f.id)).toContain('f-spec');
  });

  it('옛 이름 specId 로 남긴 조사도 계속 잡힌다 (하위호환)', async () => {
    const p = tmp('awl-next-');
    process.env.AWL_HOME = tmp('awl-next-home-');
    const { specId, ticketId } = await specWithOneTicket(p);
    appendRecord(
      {
        id: 'rec_legacy',
        at: new Date().toISOString(),
        type: 'audit',
        project: 'p',
        specId,
        scope: 's',
        findings: [{ id: 'f-legacy', what: '옛 이름으로 붙인 조사', where: 'c.ts:3' }],
      },
      p,
    );
    const view = computeNextView(p, ticketId);
    expect(view.knownFindings.map((f) => f.id)).toContain('f-legacy');
  });

  it('티켓으로만 남긴 조사도 같은 스펙의 다음 티켓에서 "이미 아는 것"으로 보인다', async () => {
    const p = tmp('awl-next-');
    process.env.AWL_HOME = tmp('awl-next-home-');
    const { specId, ticketId } = await specWithOneTicket(p);
    appendRecord(
      {
        id: 'rec_x',
        at: new Date().toISOString(),
        type: 'audit',
        project: 'p',
        ticket: ticketId,
        scope: 's',
        findings: [{ id: 'f-1', what: '티켓에 붙인 조사', where: 'a.ts:1' }],
      },
      p,
    );
    const view = computeNextView(p, ticketId);
    expect(view.specId).toBe(specId);
    expect(view.knownFindings.map((f) => f.id)).toContain('f-1');
  });

  it('렌더까지 가도 캐묻기 강도와 두 스킬 자리가 같이 찍힌다 (condition-2 글루)', async () => {
    const p = tmp('awl-next-');
    process.env.AWL_HOME = tmp('awl-next-home-');
    fs.mkdirSync(path.join(p, '.awl'), { recursive: true });
    fs.writeFileSync(path.join(p, '.awl', 'state.json'), JSON.stringify({ loopMode: 'strict' }));
    fs.writeFileSync(
      profilePath(p),
      JSON.stringify({
        name: 'test',
        skills: {
          ...defaultProfileSkills(),
          spec: { type: 'external', url: 'https://example.test/grill-with-docs' },
          clarification: { type: 'external', url: 'https://example.test/grill-me' },
        },
      }),
    );
    await createDoc('spec', '자동 저장', p);

    const out = renderSpecStage(computeSpecStageView(p), {
      color: false,
      unicode: false,
      width: 80,
    } as never);

    expect(out).toContain(modeContract('strict').grill);
    expect(out).toContain('skill    spec: ');
    expect(out).toContain('grill-with-docs');
    expect(out).toContain('skill    clarification: ');
    expect(out).toContain('grill-me');
    expect(out).toContain('awl tickets derive');
  });
});

describe('SpecStageView — 재리뷰가 잡은 거짓 뷰들 (2차)', () => {
  /** 조건 하나짜리 스펙 + 티켓 하나를 만들고 티켓 status 를 지정한다. */
  async function withTicketStatus(
    p: string,
    status: string,
  ): Promise<{ specId: string; ticketId: string }> {
    const r = await specWithOneTicket(p);
    const dir = path.join(p, 'docs', 'tickets');
    const [file] = fs.readdirSync(dir);
    const fp = path.join(dir, file as string);
    fs.writeFileSync(fp, fs.readFileSync(fp, 'utf8').replace(/^status: .+$/m, `status: ${status}`));
    return r;
  }

  function setSpecStatus(p: string, status: string): void {
    const dir = path.join(p, 'docs', 'specs');
    const [file] = fs.readdirSync(dir);
    const fp = path.join(dir, file as string);
    fs.writeFileSync(fp, fs.readFileSync(fp, 'utf8').replace(/^status: .+$/m, `status: ${status}`));
  }

  const render = (v: ReturnType<typeof computeSpecStageView>): string =>
    renderSpecStage(v, { color: false, unicode: false, width: 80 } as never);

  it('게이트 4 를 기록해 스펙이 닫히면 더는 게이트 4 를 시키지 않는다 (무한 루프 금지)', async () => {
    const p = tmp('awl-next-');
    process.env.AWL_HOME = tmp('awl-next-home-');
    await withTicketStatus(p, 'done');
    setSpecStatus(p, 'closed');

    const view = computeSpecStageView(p);
    expect(view.gate4Specs).toEqual([]);

    const out = render(view);
    // 닫힌 스펙을 다시 닫으라고 하지 않는다. 게이트 4 명령 자체가 나가면 안 되고,
    // 특히 채울 값이 없어 만들어낸 "spec":"<spec-id>" 같은 실행 불가 리터럴은 금지다.
    expect(out).not.toContain('awl record gate');
    expect(out).not.toContain('"spec":"<spec-id>"');
  });

  it('티켓 없는 스펙은 all-done 상태에서도 사라지지 않는다', async () => {
    const p = tmp('awl-next-');
    process.env.AWL_HOME = tmp('awl-next-home-');
    await withTicketStatus(p, 'done');
    const second = await createDoc('spec', '둘째 요청', p);

    const view = computeSpecStageView(p);
    expect(view.reason).toBe('all-done');
    expect(view.pendingSpecs.map((s) => s.id)).toContain(second.id);

    const out = render(view);
    expect(out).toContain('둘째 요청');
    expect(out).toContain(`awl tickets derive ${second.id}`);
  });

  it('티켓 없는 스펙은 stalled 상태에서도 사라지지 않는다', async () => {
    const p = tmp('awl-next-');
    process.env.AWL_HOME = tmp('awl-next-home-');
    await withTicketStatus(p, 'reviewing');
    const second = await createDoc('spec', '둘째 요청', p);

    const view = computeSpecStageView(p);
    expect(view.reason).toBe('stalled');
    expect(view.pendingSpecs.map((s) => s.id)).toContain(second.id);
    expect(render(view)).toContain('둘째 요청');
  });

  it('리뷰 중인 티켓에 "선행 티켓을 먼저 끝내라"고 하지 않는다', async () => {
    const p = tmp('awl-next-');
    process.env.AWL_HOME = tmp('awl-next-home-');
    await withTicketStatus(p, 'reviewing');

    const view = computeSpecStageView(p);
    expect(view.stalledTickets[0]?.status).toBe('reviewing');
    expect(view.stalledTickets[0]?.waitingOn).toEqual([]);

    const out = render(view);
    expect(out).toContain('리뷰 중입니다');
    expect(out).not.toContain('선행 티켓이 아직 done');
  });

  it('막힌 티켓에는 게이트 2 재기록을 안내한다', async () => {
    const p = tmp('awl-next-');
    process.env.AWL_HOME = tmp('awl-next-home-');
    await withTicketStatus(p, 'blocked');

    const out = render(computeSpecStageView(p));
    expect(out).toContain('게이트 2(착수)를 다시 기록');
    expect(out).not.toContain('선행 티켓이 아직 done');
  });

  it('스펙마다 따로 판정한다 — 한 스펙이 끝나도 다른 스펙 티켓이 남아 있으면 게이트 4 대상이 아니다', async () => {
    const p = tmp('awl-next-');
    process.env.AWL_HOME = tmp('awl-next-home-');
    const a = await withTicketStatus(p, 'done');
    // 둘째 스펙 + 그 티켓은 reviewing 으로 남긴다.
    const b = await createDoc('spec', '둘째 요청', p);
    const bTicket = await createDoc('ticket', '둘째 티켓', p, {
      spec: b.id,
      conditions: ['condition-1'],
    });
    const bPath = bTicket.path;
    fs.writeFileSync(
      bPath,
      fs.readFileSync(bPath, 'utf8').replace(/^status: .+$/m, 'status: reviewing'),
    );

    const view = computeSpecStageView(p);
    expect(view.gate4Specs.map((s) => s.id)).toEqual([a.specId]);
    expect(view.reason).toBe('stalled');
  });

  it('id 없는 티켓이 undefined 로 찍히지 않는다', async () => {
    const p = tmp('awl-next-');
    process.env.AWL_HOME = tmp('awl-next-home-');
    await withTicketStatus(p, 'reviewing');
    const dir = path.join(p, 'docs', 'tickets');
    const [file] = fs.readdirSync(dir);
    const fp = path.join(dir, file as string);
    fs.writeFileSync(fp, fs.readFileSync(fp, 'utf8').replace(/^id: .+$/m, 'id:'));

    const view = computeSpecStageView(p);
    // String(undefined)/String(null) 이 그대로 화면에 나가면 안 된다 — 사람이
    // 복사해 붙일 수 있는 값만 보여준다.
    expect(view.stalledTickets[0]?.id).toBe('(id 없음)');
    const out = render(view);
    expect(out).not.toContain('undefined');
    expect(out).not.toMatch(/^ {4}null\b/m);
  });

  it('배너가 단계와 어긋나지 않는다 (all-done 인데 "스펙 단계"라 하지 않는다)', async () => {
    const p = tmp('awl-next-');
    process.env.AWL_HOME = tmp('awl-next-home-');
    await withTicketStatus(p, 'done');

    const out = render(computeSpecStageView(p));
    expect(out).toContain('요청 닫기');
    expect(out.split('\n')[1]).not.toContain('스펙 단계');
  });

  it('열린 것이 아무것도 없으면 그렇다고 말한다 (가짜 지시 금지)', async () => {
    const p = tmp('awl-next-');
    process.env.AWL_HOME = tmp('awl-next-home-');
    await withTicketStatus(p, 'done');
    setSpecStatus(p, 'closed');

    const out = render(computeSpecStageView(p));
    expect(out).toContain('열려 있는 것 없음');
  });
});
