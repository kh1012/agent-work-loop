import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDoc } from '../../src/commands/doc.js';
import {
  type StatusReport,
  buildStatus,
  checkMissingAcCommits,
  classifyAncestorExit,
  renderStatus,
  runStatus,
} from '../../src/commands/status.js';
import { visibleWidth } from '../../src/core/tty.js';

const origHome = process.env.AWL_HOME;

afterEach(() => {
  if (origHome === undefined) {
    delete process.env.AWL_HOME;
  } else {
    process.env.AWL_HOME = origHome;
  }
});

function tmpProject(state: unknown): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'awl-status-'));
  fs.mkdirSync(path.join(root, '.awl'), { recursive: true });
  if (state !== undefined) {
    fs.writeFileSync(path.join(root, '.awl', 'state.json'), JSON.stringify(state));
  }
  return root;
}

function tmpHomeWithRecords(root: string, records: Record<string, unknown>[]): void {
  process.env.AWL_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'awl-home-'));
  const dir = path.join(root, '.awl', 'records');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, '2026-07.jsonl'),
    `${records.map((r) => JSON.stringify(r)).join('\n')}\n`,
  );
}

describe('buildStatus', () => {
  it('phase·완료조건 진행·기록 타입별 카운트를 요약한다 (AC-01)', () => {
    const root = tmpProject({
      generation: 2,
      phase: 'loop',
      workitem: 'WI-9',
      criteria: [
        { id: 'AC-01', status: 'passed' },
        { id: 'AC-02', status: 'passed' },
        { id: 'AC-03', status: 'blocked' },
        { id: 'AC-04', status: 'in_progress' },
        { id: 'AC-05', status: 'pending' },
      ],
    });
    tmpHomeWithRecords(root, [
      { id: '1', at: '2026-07-14T10:00:00Z', type: 'attempt', result: 'passed', what: 'x' },
      { id: '2', at: '2026-07-14T09:00:00Z', type: 'blocked', what: 'y' },
      { id: '3', at: '2026-07-14T08:00:00Z', type: 'audit', scope: 'z' },
    ]);

    const s = buildStatus(root);
    expect(s.phase).toBe('loop');
    expect(s.generation).toBe(2);
    expect(s.criteria).toEqual({
      total: 5,
      passed: 2,
      blocked: 1,
      inProgress: 1,
      pending: 1,
      blockedByDeps: [],
    });
    expect(s.records.total).toBe(3);
    expect(s.records.byType.attempt).toBe(1);
    expect(s.lastAttempt).toBe('passed');
  });

  it('dependsOn 이 아직 안 끝난 완료조건을 블록됨으로 계산한다 (WI-E AC-03)', () => {
    const root = tmpProject({
      phase: 'loop',
      criteria: [
        { id: 'AC-01', status: 'passed' },
        { id: 'AC-02', status: 'pending' },
        { id: 'AC-03', status: 'pending', dependsOn: ['AC-01', 'AC-02'] },
        { id: 'AC-04', status: 'pending', dependsOn: ['AC-01'] }, // AC-01 이미 passed -> 안 막힘
      ],
    });
    process.env.AWL_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'awl-home-'));

    const s = buildStatus(root);
    expect(s.criteria.blockedByDeps).toEqual([{ id: 'AC-03', waitingOn: ['AC-02'] }]);
  });

  it('이미 passed 인 완료조건은 dependsOn 이 안 끝났어도 블록 목록에 안 넣는다', () => {
    const root = tmpProject({
      phase: 'loop',
      criteria: [
        { id: 'AC-01', status: 'pending' },
        // 이례적이지만(먼저 통과했는데 dependsOn 이 나중에 추가된 경우) 이미 끝난 건 블록 아님.
        { id: 'AC-02', status: 'passed', dependsOn: ['AC-01'] },
      ],
    });
    process.env.AWL_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'awl-home-'));

    const s = buildStatus(root);
    expect(s.criteria.blockedByDeps).toEqual([]);
  });

  it('dependsOn 이 자기 자신을 가리켜도 크래시하지 않는다(영구 블록으로 표시) (AC-04, 리뷰 지적 — 엣지케이스 무테스트)', () => {
    const root = tmpProject({
      phase: 'loop',
      criteria: [{ id: 'AC-01', status: 'pending', dependsOn: ['AC-01'] }],
    });
    process.env.AWL_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'awl-home-'));

    const s = buildStatus(root);
    expect(s.criteria.blockedByDeps).toEqual([{ id: 'AC-01', waitingOn: ['AC-01'] }]);
  });

  it('dependsOn 이 존재하지 않는 ID 를 가리켜도 크래시하지 않는다(영구 블록으로 표시) (AC-04, 리뷰 지적)', () => {
    const root = tmpProject({
      phase: 'loop',
      criteria: [{ id: 'AC-01', status: 'pending', dependsOn: ['AC-99'] }], // AC-99 는 없다
    });
    process.env.AWL_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'awl-home-'));

    const s = buildStatus(root);
    expect(s.criteria.blockedByDeps).toEqual([{ id: 'AC-01', waitingOn: ['AC-99'] }]);
  });

  it('state·기록이 비어도 크래시하지 않는다 (AC-03)', () => {
    const root = tmpProject(undefined); // state.json 없음
    process.env.AWL_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'awl-home-')); // records 없음
    const s = buildStatus(root);
    expect(s.phase).toBeNull();
    expect(s.criteria.total).toBe(0);
    expect(s.records.total).toBe(0);
    expect(s.lastAttempt).toBeNull();
  });

  it('결과는 유효한 JSON 으로 직렬화된다 (AC-02)', () => {
    const root = tmpProject({ phase: 'audit', criteria: [] });
    process.env.AWL_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'awl-home-'));
    const s = buildStatus(root);
    const parsed = JSON.parse(JSON.stringify(s));
    expect(parsed.phase).toBe('audit');
    expect(typeof parsed.criteria.total).toBe('number');
  });
});

describe('renderStatus (AC-01 사람용)', () => {
  it('phase 와 진행(통과/전체)을 사람이 읽는 형태로 보여준다', () => {
    const root = tmpProject({
      phase: 'loop',
      criteria: [
        { id: 'AC-01', status: 'passed' },
        { id: 'AC-02', status: 'pending' },
      ],
    });
    process.env.AWL_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'awl-home-'));
    const text = renderStatus(buildStatus(root), { unicode: false, color: false, tty: false });
    expect(text).toContain('loop');
    expect(text).toContain('1/2'); // 통과/전체
  });

  it('블록된 완료조건을 텍스트로 보여준다(대기 중인 선행 ID 포함) (AC-04, 리뷰 지적 — 계산만 테스트하고 출력 텍스트는 안 봤었다)', () => {
    const root = tmpProject({
      phase: 'loop',
      criteria: [
        { id: 'AC-01', status: 'pending' },
        { id: 'AC-02', status: 'pending', dependsOn: ['AC-01'] },
      ],
    });
    process.env.AWL_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'awl-home-'));
    const text = renderStatus(buildStatus(root), { unicode: false, color: false, tty: false });
    expect(text).toContain('AC-02');
    expect(text).toContain('블록됨');
    expect(text).toContain('AC-01'); // 무엇을 기다리는지도 나온다
  });

  it('블록된 완료조건이 없으면 블록됨 줄 자체가 없다(회귀 없음)', () => {
    const root = tmpProject({
      phase: 'loop',
      criteria: [{ id: 'AC-01', status: 'pending' }],
    });
    process.env.AWL_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'awl-home-'));
    const text = renderStatus(buildStatus(root), { unicode: false, color: false, tty: false });
    expect(text).not.toContain('블록됨');
  });

  it('아직 시작 전이면 안내한다', () => {
    const root = tmpProject(undefined);
    process.env.AWL_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'awl-home-'));
    const text = renderStatus(buildStatus(root), { unicode: false, color: false, tty: false });
    expect(text).toContain('아직');
  });
});

describe('게이트 이력 (WI-Q AC-03)', () => {
  it('buildStatus 가 gate:1/gate:2 레코드를 읽어 게이트 상태를 낸다', () => {
    const root = tmpProject({ phase: 'loop', workitem: 'WI-9', criteria: [] });
    tmpHomeWithRecords(root, [
      {
        id: '1',
        at: '2026-07-15T13:44:00Z',
        type: 'gate',
        workitem: 'WI-9',
        gate: 1,
        decision: 'approved',
        presentedCriteria: ['AC-01', 'AC-02', 'AC-03', 'AC-04', 'AC-05'],
        presentedExclusions: ['a', 'b', 'c'],
        auto: false,
      },
      // 다른 워크아이템의 게이트 기록 — 섞이면 안 된다.
      {
        id: '2',
        at: '2026-07-15T12:00:00Z',
        type: 'gate',
        workitem: 'WI-OTHER',
        gate: 1,
        decision: 'approved',
        presentedCriteria: ['x'],
      },
    ]);
    const s = buildStatus(root);
    expect(s.gates).toHaveLength(4); // ADK stage 2a: 게이트 3/4 로 확장
    const g1 = s.gates.find((g) => g.gate === 1);
    expect(g1?.recorded).toBe(true);
    expect(g1?.decision).toBe('approved');
    expect(g1?.at).toBe('2026-07-15T13:44:00Z');
    expect(g1?.presentedCriteria).toHaveLength(5);
    expect(g1?.presentedExclusions).toHaveLength(3);
    expect(g1?.auto).toBe(false);
    const g2 = s.gates.find((g) => g.gate === 2);
    expect(g2?.recorded).toBe(false);
    const g3 = s.gates.find((g) => g.gate === 3);
    expect(g3?.recorded).toBe(false);
    const g4 = s.gates.find((g) => g.gate === 4);
    expect(g4?.recorded).toBe(false);
  });

  it('게이트 3/4(ADK stage 2a) 레코드도 게이트 1/2 와 동일하게 읽힌다', () => {
    const root = tmpProject({ phase: 'loop', workitem: 'WI-9', criteria: [] });
    tmpHomeWithRecords(root, [
      {
        id: '1',
        at: '2026-07-15T14:00:00Z',
        type: 'gate',
        workitem: 'WI-9',
        gate: 3,
        layer: 'ticket',
        ticket: 'ticket-1',
        decision: 'approved',
        presentedCriteria: ['AC-01'],
        auto: true,
      },
      {
        id: '2',
        at: '2026-07-15T15:00:00Z',
        type: 'gate',
        workitem: 'WI-9',
        gate: 4,
        layer: 'request',
        spec: 'spec-1',
        decision: 'merge',
        presentedCriteria: ['AC-01'],
      },
    ]);
    const s = buildStatus(root);
    expect(s.gates).toHaveLength(4);
    const g3 = s.gates.find((g) => g.gate === 3);
    expect(g3?.recorded).toBe(true);
    expect(g3?.decision).toBe('approved');
    expect(g3?.auto).toBe(true);
    const g4 = s.gates.find((g) => g.gate === 4);
    expect(g4?.recorded).toBe(true);
    expect(g4?.decision).toBe('merge');
  });

  it('게이트 decision 을 상태값으로 색코딩한다 — approved=green, rejected=red (cli-visual-consistency AC-04)', () => {
    const mk = (decision: string) => {
      const root = tmpProject({ phase: 'loop', workitem: 'WI-9', criteria: [] });
      tmpHomeWithRecords(root, [
        {
          id: '1',
          at: '2026-07-15T13:44:00Z',
          type: 'gate',
          workitem: 'WI-9',
          gate: 1,
          decision,
          presentedCriteria: ['AC-01'],
        },
      ]);
      return renderStatus(buildStatus(root), { unicode: true, color: true, tty: true });
    };
    expect(mk('approved')).toContain('\x1b[32mapproved'); // green
    expect(mk('rejected')).toContain('\x1b[31mrejected'); // red
  });

  it('같은 게이트 번호로 여러 번 기록되면(재승인 등) 가장 최근 것을 쓴다', () => {
    const root = tmpProject({ phase: 'loop', workitem: 'WI-9', criteria: [] });
    tmpHomeWithRecords(root, [
      {
        id: '1',
        at: '2026-07-15T14:00:00Z',
        type: 'gate',
        workitem: 'WI-9',
        gate: 1,
        decision: 'modified',
        presentedCriteria: ['AC-01'],
      },
      {
        id: '2',
        at: '2026-07-15T13:00:00Z',
        type: 'gate',
        workitem: 'WI-9',
        gate: 1,
        decision: 'approved',
        presentedCriteria: ['AC-01'],
      },
    ]);
    const s = buildStatus(root);
    const g1 = s.gates.find((g) => g.gate === 1);
    expect(g1?.decision).toBe('modified'); // 더 최근(14:00) 것
  });

  it('renderStatus 가 사람용 텍스트로 게이트 이력을 보여준다', () => {
    const root = tmpProject({ phase: 'loop', workitem: 'WI-9', criteria: [] });
    tmpHomeWithRecords(root, [
      {
        id: '1',
        at: '2026-07-15T13:44:00Z',
        type: 'gate',
        workitem: 'WI-9',
        gate: 1,
        decision: 'approved',
        presentedCriteria: ['AC-01', 'AC-02', 'AC-03', 'AC-04', 'AC-05'],
        presentedExclusions: ['a', 'b', 'c'],
      },
    ]);
    const text = renderStatus(buildStatus(root), { unicode: false, color: false, tty: false });
    expect(text).toContain('게이트 1');
    expect(text).toContain('게이트 2');
    expect(text).toContain('대기중'); // 게이트 2는 아직 없음
    expect(text).toContain('5'); // presentedCriteria 개수
    expect(text).toContain('3'); // exclusion 개수
  });
});

describe('게이트 접기/펼치기 판정 (WI-G19)', () => {
  it('제시된 완료조건이 전부 passed 면 접힌다(▸, 항목별 줄 없음)', () => {
    const root = tmpProject({
      phase: 'loop',
      workitem: 'WI-9',
      criteria: [
        { id: 'condition-1', status: 'passed' },
        { id: 'condition-2', status: 'passed' },
      ],
    });
    tmpHomeWithRecords(root, [
      {
        id: '1',
        at: '2026-07-15T13:44:00Z',
        type: 'gate',
        workitem: 'WI-9',
        gate: 3,
        decision: 'approved',
        presentedCriteria: ['condition-1', 'condition-2'],
      },
    ]);
    const s = buildStatus(root);
    const g3 = s.gates.find((g) => g.gate === 3);
    expect(g3?.folded).toBe(true);
    const text = renderStatus(s, { unicode: true, color: false, tty: true });
    expect(text).toContain('▸');
    expect(text).not.toContain('condition-1');
  });

  it('제시된 완료조건 중 하나라도 passed 가 아니면 펼쳐진다(실패/지적, 항목별 줄)', () => {
    const root = tmpProject({
      phase: 'loop',
      workitem: 'WI-9',
      criteria: [
        { id: 'condition-1', status: 'passed' },
        { id: 'condition-2', status: 'blocked' },
      ],
    });
    tmpHomeWithRecords(root, [
      {
        id: '1',
        at: '2026-07-15T13:44:00Z',
        type: 'gate',
        workitem: 'WI-9',
        gate: 3,
        decision: 'modified',
        presentedCriteria: ['condition-1', 'condition-2'],
      },
    ]);
    const s = buildStatus(root);
    const g3 = s.gates.find((g) => g.gate === 3);
    expect(g3?.folded).toBe(false);
    const text = renderStatus(s, { unicode: true, color: false, tty: true });
    expect(text).toContain('condition-1');
    expect(text).toContain('condition-2 (blocked)');
  });

  it('presentedExclusions(범위 밖)이 하나라도 있으면 완료조건이 전부 passed 여도 펼쳐진다', () => {
    const root = tmpProject({
      phase: 'loop',
      workitem: 'WI-9',
      criteria: [{ id: 'condition-1', status: 'passed' }],
    });
    tmpHomeWithRecords(root, [
      {
        id: '1',
        at: '2026-07-15T13:44:00Z',
        type: 'gate',
        workitem: 'WI-9',
        gate: 1,
        decision: 'approved',
        presentedCriteria: ['condition-1'],
        presentedExclusions: [{ id: 'finding-1', reason: '다음 라운드로 미룸' }],
      },
    ]);
    const s = buildStatus(root);
    const g1 = s.gates.find((g) => g.gate === 1);
    expect(g1?.folded).toBe(false);
    const text = renderStatus(s, { unicode: true, color: false, tty: true });
    expect(text).toContain('범위 밖: finding-1');
    expect(text).toContain('다음 라운드로 미룸');
  });

  it('review 기록의 findings 가 이 게이트가 제시한 완료조건을 지목하면 펼쳐진다', () => {
    const root = tmpProject({
      phase: 'loop',
      workitem: 'WI-9',
      criteria: [{ id: 'condition-1', status: 'passed' }],
    });
    tmpHomeWithRecords(root, [
      {
        id: '1',
        at: '2026-07-15T13:44:00Z',
        type: 'gate',
        workitem: 'WI-9',
        gate: 3,
        decision: 'approved',
        presentedCriteria: ['condition-1'],
      },
      {
        id: '2',
        at: '2026-07-15T13:30:00Z',
        type: 'review',
        workitem: 'WI-9',
        reviewId: 'r1',
        criteria: ['condition-1'],
        findings: [{ severity: 'medium', what: '약한 단언', evidence: 'x.ts:10' }],
        cheatingDetected: [],
        verifyPassedBefore: true,
      },
    ]);
    const s = buildStatus(root);
    const g3 = s.gates.find((g) => g.gate === 3);
    expect(g3?.folded).toBe(false);
    expect(g3?.reviewFindings).toHaveLength(1);
    const text = renderStatus(s, { unicode: true, color: false, tty: true });
    expect(text).toContain('리뷰: 약한 단언');
    expect(text).toContain('x.ts:10');
  });

  it('ASCII 폴백에서는 ▸ 대신 > 를 쓴다', () => {
    const root = tmpProject({
      phase: 'loop',
      workitem: 'WI-9',
      criteria: [{ id: 'condition-1', status: 'passed' }],
    });
    tmpHomeWithRecords(root, [
      {
        id: '1',
        at: '2026-07-15T13:44:00Z',
        type: 'gate',
        workitem: 'WI-9',
        gate: 3,
        decision: 'approved',
        presentedCriteria: ['condition-1'],
      },
    ]);
    const text = renderStatus(buildStatus(root), { unicode: false, color: false, tty: false });
    expect(text).not.toContain('▸');
    expect(text).toContain('>');
  });
});

describe('게이트4 auto 요청 요약 (WI-H4, adk-prototype.md:365 "auto 는 게이트4 에서 펼친 요약만 낸다")', () => {
  async function makeSpecWithTickets(
    root: string,
    ticketStatuses: string[],
    conditionsPerTicket: string[][],
  ): Promise<{ specId: string; ticketIds: string[] }> {
    const spec = await createDoc('spec', '요약 대상 스펙', root);
    const ticketIds: string[] = [];
    for (let i = 0; i < ticketStatuses.length; i++) {
      const ticket = await createDoc('ticket', `티켓 ${i}`, root, {
        spec: spec.id,
        conditions: conditionsPerTicket[i] ?? [],
      });
      const content = fs
        .readFileSync(ticket.path, 'utf8')
        .replace(/^status: .+$/m, `status: ${ticketStatuses[i]}`);
      fs.writeFileSync(ticket.path, content);
      ticketIds.push(ticket.id);
    }
    return { specId: spec.id, ticketIds };
  }

  it('게이트4 가 auto:true 로 기록되면 완료티켓/조건/자동승인 횟수를 집계한다', async () => {
    const root = tmpProject({ phase: 'loop', workitem: null, criteria: [] });
    const { specId, ticketIds } = await makeSpecWithTickets(
      root,
      ['done', 'done', 'pending'],
      [['condition-1'], ['condition-1', 'condition-2'], ['condition-1']],
    );
    tmpHomeWithRecords(root, [
      {
        id: '1',
        at: '2026-07-28T10:00:00Z',
        type: 'gate',
        workitem: null,
        gate: 2,
        layer: 'ticket',
        ticket: ticketIds[0],
        decision: 'approved',
        presentedCriteria: [],
        auto: true,
      },
      {
        id: '2',
        at: '2026-07-28T10:01:00Z',
        type: 'gate',
        workitem: null,
        gate: 3,
        layer: 'ticket',
        ticket: ticketIds[0],
        decision: 'approved',
        presentedCriteria: [],
        auto: true,
      },
      {
        id: '3',
        at: '2026-07-28T10:02:00Z',
        type: 'gate',
        workitem: null,
        gate: 3,
        layer: 'ticket',
        ticket: ticketIds[1],
        decision: 'approved',
        presentedCriteria: [],
        auto: false, // 사람이 직접 승인 — 자동승인 카운트에 안 들어간다
      },
      {
        id: '4',
        at: '2026-07-28T10:03:00Z',
        type: 'gate',
        workitem: null,
        gate: 4,
        layer: 'request',
        spec: specId,
        decision: 'merge',
        presentedCriteria: [],
        auto: true,
      },
    ]);

    const s = buildStatus(root);
    const g4 = s.gates.find((g) => g.gate === 4);
    expect(g4?.requestSummary).toEqual({
      totalTickets: 3,
      completedTickets: 2,
      conditionsTotal: 4, // 티켓별 조건 1+2+1
      autoApprovalCount: 3, // gate2(t0)+gate3(t0)+gate4 자신 — gate3(t1)은 auto:false
    });
  });

  it('게이트4 가 auto:false(사람이 직접 승인)면 requestSummary 가 없다', async () => {
    const root = tmpProject({ phase: 'loop', workitem: null, criteria: [] });
    const spec = await createDoc('spec', '스펙', root);
    tmpHomeWithRecords(root, [
      {
        id: '1',
        at: '2026-07-28T10:00:00Z',
        type: 'gate',
        workitem: null,
        gate: 4,
        layer: 'request',
        spec: spec.id,
        decision: 'merge',
        presentedCriteria: [],
        auto: false,
      },
    ]);
    const s = buildStatus(root);
    expect(s.gates.find((g) => g.gate === 4)?.requestSummary).toBeUndefined();
  });

  it('게이트4 가 spec 필드 없이 기록됐으면(레거시) requestSummary 를 안 만든다(크래시 아님)', async () => {
    const root = tmpProject({ phase: 'loop', workitem: null, criteria: [] });
    tmpHomeWithRecords(root, [
      {
        id: '1',
        at: '2026-07-28T10:00:00Z',
        type: 'gate',
        workitem: null,
        gate: 4,
        layer: 'request',
        decision: 'merge',
        presentedCriteria: [],
        auto: true,
      },
    ]);
    const s = buildStatus(root);
    expect(s.gates.find((g) => g.gate === 4)?.requestSummary).toBeUndefined();
  });

  it('renderStatus 가 완료 티켓/조건/자동승인 횟수를 사람용 텍스트로 보여준다', async () => {
    const root = tmpProject({ phase: 'loop', workitem: null, criteria: [] });
    const { specId } = await makeSpecWithTickets(root, ['done'], [['condition-1']]);
    tmpHomeWithRecords(root, [
      {
        id: '1',
        at: '2026-07-28T10:00:00Z',
        type: 'gate',
        workitem: null,
        gate: 4,
        layer: 'request',
        spec: specId,
        decision: 'merge',
        presentedCriteria: [],
        auto: true,
      },
    ]);
    const text = renderStatus(buildStatus(root), { unicode: false, color: false, tty: false });
    expect(text).toContain('완료 티켓 1/1개');
    expect(text).toContain('조건 1개');
    expect(text).toContain('자동승인 1회');
  });
});

// wi8-F3: 캐노니컬 HEAD 검증 ---------------------------------------------------

function makeGitRepo(): { dir: string; g: (args: string[]) => string } {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'awl-status-git-')));
  const g = (args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  g(['init', '-q', '-b', 'main']);
  g(['config', 'user.email', 'x@x.com']);
  g(['config', 'user.name', 'x']);
  g(['config', 'commit.gpgsign', 'false']);
  fs.mkdirSync(path.join(dir, '.awl'), { recursive: true });
  return { dir, g };
}

function writeStateFile(dir: string, state: unknown): void {
  fs.writeFileSync(path.join(dir, '.awl', 'state.json'), JSON.stringify(state));
}

describe('checkMissingAcCommits — 캐노니컬 HEAD 검증 (wi8-F3 AC-02/03 B)', () => {
  it('완료조건 커밋이 HEAD 조상이 아니면(다른 계보) diverged 로 수집한다', async () => {
    const { dir, g } = makeGitRepo();
    fs.writeFileSync(path.join(dir, 'f.txt'), 'base\n');
    g(['add', '-A']);
    g(['commit', '-q', '-m', 'base']);
    const base = g(['rev-parse', 'HEAD']).trim();
    // 계보 A: AC-01 이 여기서 커밋됨.
    fs.writeFileSync(path.join(dir, 'a.txt'), 'A\n');
    g(['add', '-A']);
    g(['commit', '-q', '-m', 'A']);
    const cA = g(['rev-parse', 'HEAD']).trim();
    // 계보 B: base 에서 분기(A 를 포함하지 않음). 지금 HEAD=other.
    g(['checkout', '-q', '-b', 'other', base]);
    fs.writeFileSync(path.join(dir, 'b.txt'), 'B\n');
    g(['add', '-A']);
    g(['commit', '-q', '-m', 'B']);
    // state 는 AC-01 이 cA(A 계보)에서 커밋됐다고 기록 — 열등 계보(other)를 최종 지목한 상황.
    writeStateFile(dir, { criteria: [{ id: 'AC-01', status: 'passed', commit: cA }] });

    const missing = await checkMissingAcCommits(dir);
    expect(missing).toHaveLength(1);
    expect(missing[0]).toMatchObject({ id: 'AC-01', commit: cA, reason: 'diverged' });
  });

  it('완료조건 커밋이 HEAD 조상이면 빈 배열(정상 계보)', async () => {
    const { dir, g } = makeGitRepo();
    fs.writeFileSync(path.join(dir, 'f.txt'), 'base\n');
    g(['add', '-A']);
    g(['commit', '-q', '-m', 'base']);
    fs.writeFileSync(path.join(dir, 'a.txt'), 'A\n');
    g(['add', '-A']);
    g(['commit', '-q', '-m', 'A']);
    const cA = g(['rev-parse', 'HEAD']).trim();
    writeStateFile(dir, { criteria: [{ id: 'AC-01', status: 'passed', commit: cA }] });
    expect(await checkMissingAcCommits(dir)).toEqual([]);
  });

  it('완료조건 커밋 SHA 가 이 클론에 아예 없으면 not-found', async () => {
    const { dir, g } = makeGitRepo();
    fs.writeFileSync(path.join(dir, 'f.txt'), 'base\n');
    g(['add', '-A']);
    g(['commit', '-q', '-m', 'base']);
    writeStateFile(dir, { criteria: [{ id: 'AC-01', status: 'passed', commit: '0'.repeat(40) }] });
    const missing = await checkMissingAcCommits(dir);
    expect(missing).toHaveLength(1);
    expect(missing[0]).toMatchObject({ id: 'AC-01', reason: 'not-found' });
  });

  it('commit 필드 없는 완료조건은 검사하지 않는다(빈 배열)', async () => {
    const { dir, g } = makeGitRepo();
    fs.writeFileSync(path.join(dir, 'f.txt'), 'base\n');
    g(['add', '-A']);
    g(['commit', '-q', '-m', 'base']);
    writeStateFile(dir, { criteria: [{ id: 'AC-01', status: 'passed', baseline: 'x' }] });
    expect(await checkMissingAcCommits(dir)).toEqual([]);
  });

  it('git 저장소가 아니거나 커밋이 없으면 빈 배열(크래시 없음)', async () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'awl-status-nogit-')));
    fs.mkdirSync(path.join(dir, '.awl'), { recursive: true });
    writeStateFile(dir, { criteria: [{ id: 'AC-01', status: 'passed', commit: 'deadbeef' }] });
    expect(await checkMissingAcCommits(dir)).toEqual([]);
  });
});

describe('renderStatus / JSON — missingAcCommits 표시 (wi8-F3 AC-03 C)', () => {
  const plain = { unicode: false, color: false, tty: false };
  function mkReport(over: Partial<StatusReport>): StatusReport {
    return {
      generation: 1,
      phase: 'loop',
      workitem: 'WI',
      criteria: { total: 1, passed: 1, blocked: 0, inProgress: 0, pending: 0, blockedByDeps: [] },
      records: { total: 0, byType: {} },
      lastAttempt: null,
      gates: [
        { gate: 1, recorded: false },
        { gate: 2, recorded: false },
      ],
      ...over,
    };
  }

  it('missingAcCommits 가 있으면 AC id·"HEAD에 없음"·단축 SHA 를 출력한다', () => {
    const report = mkReport({
      missingAcCommits: [{ id: 'AC-01', commit: 'abcdef1234567890', reason: 'diverged' }],
    });
    const text = renderStatus(report, plain);
    expect(text).toContain('AC-01');
    expect(text).toContain('HEAD에 없음');
    expect(text).toContain('abcdef1234'); // 단축 SHA 10자
  });

  it('missingAcCommits 가 없거나 비었으면 그 줄을 출력하지 않는다', () => {
    expect(renderStatus(mkReport({}), plain)).not.toContain('HEAD에 없음');
    expect(renderStatus(mkReport({ missingAcCommits: [] }), plain)).not.toContain('HEAD에 없음');
  });

  it('JSON 왕복 — missingAcCommits 가 직렬화된다', () => {
    const report = mkReport({
      missingAcCommits: [{ id: 'AC-01', commit: 'abcdef1234567890', reason: 'not-found' }],
    });
    const round = JSON.parse(JSON.stringify(report)) as StatusReport;
    expect(round.missingAcCommits).toEqual([
      { id: 'AC-01', commit: 'abcdef1234567890', reason: 'not-found' },
    ]);
  });
});

describe('classifyAncestorExit — 확실한 사실만 (wi8-F3 AC-04, rev_a2bec44c3ee51649ad finding #1)', () => {
  it('0=포함, 1=diverged, 128=not-found 로 분류한다', () => {
    expect(classifyAncestorExit(0)).toBe('present');
    expect(classifyAncestorExit(1)).toBe('diverged');
    expect(classifyAncestorExit(128)).toBe('not-found');
  });

  it('null(타임아웃/시그널)·기타 exit 은 unknown 으로 — not-found 를 지어내지 않는다', () => {
    // 리뷰 지적: 예전엔 null·기타를 전부 not-found 로 떨궈 거짓 사실을 표시했다.
    expect(classifyAncestorExit(null)).toBe('unknown');
    expect(classifyAncestorExit(129)).toBe('unknown');
    expect(classifyAncestorExit(-1)).toBe('unknown');
  });
});

describe('runStatus — cwd 밖(config-anywhere-fallback)', () => {
  const origCwd = process.cwd();
  afterEach(() => process.chdir(origCwd));

  function capture(fn: () => void): string {
    let buf = '';
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => {
      buf += String(c);
      return true;
    });
    try {
      fn();
    } finally {
      spy.mockRestore();
    }
    return buf;
  }

  /** .awl/config.json + .awl/state.json 만 갖춘 최소 프로젝트(registerProject 로 등록). */
  function seedProject(home: string, name: string): string {
    const root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), `awl-status-multi-${name}-`)),
    );
    fs.mkdirSync(path.join(root, '.awl'), { recursive: true });
    fs.writeFileSync(path.join(root, '.awl', 'config.json'), JSON.stringify({ project: name }));
    const projectsFile = path.join(home, 'projects.json');
    const existing = fs.existsSync(projectsFile)
      ? (JSON.parse(fs.readFileSync(projectsFile, 'utf8')) as unknown[])
      : [];
    fs.writeFileSync(
      projectsFile,
      JSON.stringify([...existing, { name, path: root, registeredAt: '2026-01-01T00:00:00.000Z' }]),
    );
    return root;
  }

  it('등록된 프로젝트 2개를 --json 에 multiProject 로 전부 담는다', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'awl-status-multi-home-'));
    fs.mkdirSync(home, { recursive: true });
    process.env.AWL_HOME = home;
    const a = seedProject(home, 'alpha');
    const b = seedProject(home, 'beta');
    process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'awl-status-multi-lonely-')));

    const buf = await new Promise<string>((resolve) => {
      let out = '';
      const spy = vi.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => {
        out += String(c);
        return true;
      });
      void runStatus({ json: true }).finally(() => {
        spy.mockRestore();
        resolve(out);
      });
    });

    const j = JSON.parse(buf);
    expect(j.multiProject).toBe(true);
    expect(j.projects.map((p: { name: string }) => p.name).sort()).toEqual(['alpha', 'beta']);
    expect(j.projects.map((p: { path: string }) => p.path).sort()).toEqual([a, b].sort());
  });

  it('사람용 렌더에는 각 프로젝트 헤더와 cd 안내가 나온다', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'awl-status-multi-home2-'));
    process.env.AWL_HOME = home;
    const a = seedProject(home, 'gamma');
    seedProject(home, 'delta'); // 등록 2개 이상이라야 진짜 모호함(single 자동 선택 대상 아님).
    process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'awl-status-multi-lonely2-')));

    let buf = '';
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => {
      buf += String(c);
      return true;
    });
    await runStatus({ json: false });
    spy.mockRestore();

    expect(buf).toContain('gamma');
    expect(buf).toContain(a);
    expect(buf).toContain('cd ');
  });
});

// ---------------------------------------------------------------------------
// .tasks/plan/<name>.md 의 <name> 이 티켓 id 일 때 티켓을 원천으로 삼는다 (ADK stage 2e)
// ---------------------------------------------------------------------------

function seedTicket(root: string, ticketId: string, status = 'pending'): string {
  const dir = path.join(root, 'docs', 'tickets');
  fs.mkdirSync(dir, { recursive: true });
  const ticketPath = path.join(dir, `20260101-000000-${ticketId.slice(0, 8)}.md`);
  fs.writeFileSync(
    ticketPath,
    `---\nid: ${ticketId}\nspec: spec-1\nconditions: [condition-1]\ndependencies: []\nstatus: ${status}\n---\n## Verification\n`,
  );
  return ticketPath;
}
