import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  acquireLock,
  collectEvolve,
  loadGotchaList,
  migrateDeltasToGotchas,
  recordGotcha,
  releaseLock,
  writeGeneration,
} from '../../src/commands/evolve.js';
import { legacyDeltasDir } from '../../src/core/paths.js';

const origHome = process.env.AWL_HOME;

function seedRecords(records: Record<string, unknown>[]): void {
  const dir = path.join(process.env.AWL_HOME as string, 'records');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, '2026-07.jsonl'),
    `${records.map((r) => JSON.stringify(r)).join('\n')}\n`,
  );
}

beforeEach(() => {
  process.env.AWL_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'awl-evolve-'));
});

afterEach(() => {
  if (origHome === undefined) {
    delete process.env.AWL_HOME;
  } else {
    process.env.AWL_HOME = origHome;
  }
});

describe('collectEvolve — 모으기만 (판단하지 않음)', () => {
  it('blocked/review/retried 를 정확히 모으고 metrics 를 계산한다', () => {
    seedRecords([
      {
        id: '1',
        at: '2026-07-14T10:00:00Z',
        type: 'blocked',
        workitem: 'WI-6',
        what: '리사이즈',
        tried: [{ approach: 'a', failed: 'b' }],
        lesson: 'x',
      },
      {
        id: '2',
        at: '2026-07-14T09:00:00Z',
        type: 'attempt',
        workitem: 'WI-6',
        attempt: 3,
        result: 'passed',
        what: 'y',
      },
      {
        id: '3',
        at: '2026-07-14T08:00:00Z',
        type: 'attempt',
        workitem: 'WI-6',
        attempt: 1,
        result: 'passed',
        what: 'z',
      },
      {
        id: '4',
        at: '2026-07-14T07:00:00Z',
        type: 'review',
        workitem: 'WI-6',
        target: 'AC-01',
        verdict: 'needs-work',
      },
      { id: '5', at: '2026-07-14T06:00:00Z', type: 'audit', workitem: 'WI-9', scope: 'other' }, // 다른 워크아이템
    ]);
    const state = {
      criteria: [
        { id: 'AC-01', status: 'passed', attempts: 1, proceduralErrors: 0 },
        { id: 'AC-02', status: 'blocked', attempts: 3, proceduralErrors: 2 },
      ],
    };
    const col = collectEvolve('agent-work-loop', 'WI-6', state);

    expect(col.blocked).toHaveLength(1);
    expect(col.reviews).toHaveLength(1);
    // attempt>=2 인 것만 (id:2), id:3(attempt:1)은 제외
    expect(col.retried).toHaveLength(1);
    expect(col.retried[0]?.id).toBe('2');
    // metrics
    expect(col.metrics.criteriaTotal).toBe(2);
    expect(col.metrics.avgAttempts).toBe(2); // (1+3)/2
    expect(col.metrics.blockedRatio).toBe(0.5); // 1/2
    expect(col.metrics.proceduralErrors).toBe(2);
    expect(col.metrics.reviewRejects).toBe(1);
  });

  it('gotcha-applied/gotcha-missed 개수를 워크아이템 기준으로 센다 (WI-P AC-03)', () => {
    seedRecords([
      {
        id: '1',
        at: '2026-07-14T10:00:00Z',
        type: 'gotcha-applied',
        workitem: 'WI-6',
        gotchaId: 'G-006',
        what: '적용함',
      },
      {
        id: '2',
        at: '2026-07-14T09:00:00Z',
        type: 'gotcha-applied',
        workitem: 'WI-6',
        gotchaId: 'G-013',
        what: '적용함',
      },
      {
        id: '3',
        at: '2026-07-14T08:00:00Z',
        type: 'gotcha-missed',
        workitem: 'WI-6',
        gotchaId: 'G-006',
        what: '또 새어들어감',
        why: '확인 안 함',
      },
      {
        id: '4',
        at: '2026-07-14T07:00:00Z',
        type: 'gotcha-applied',
        workitem: 'WI-9', // 다른 워크아이템 — 안 세야 함
        gotchaId: 'G-001',
        what: 'x',
      },
    ]);
    const col = collectEvolve('agent-work-loop', 'WI-6', { criteria: [] });
    expect(col.metrics.gotchaApplied).toBe(2);
    expect(col.metrics.gotchaMissed).toBe(1);
  });

  it('gotcha-applied/gotcha-missed 기록이 없으면 0이다', () => {
    seedRecords([]);
    const col = collectEvolve('agent-work-loop', 'WI-6', { criteria: [] });
    expect(col.metrics.gotchaApplied).toBe(0);
    expect(col.metrics.gotchaMissed).toBe(0);
  });

  it('existingGotchas 를 함께 준다', () => {
    seedRecords([]);
    recordGotcha(
      { lesson: '축을 파라미터로 빼기 전에 좌표계 의존을 확인한다', source: { workitem: 'WI-4' } },
      '2026-07-14T00:00:00Z',
    );
    const col = collectEvolve('p', 'WI-6', { criteria: [] });
    expect(col.existingGotchas).toHaveLength(1);
    expect(col.existingGotchas[0]?.count).toBe(1);
    expect(col.existingGotchas[0]?.lesson).toContain('좌표계');
  });
});

describe('recordGotcha — 쓰고 세기만 (승격 안 함)', () => {
  it('새 교훈을 G-001 로 만든다', () => {
    const r = recordGotcha(
      { lesson: '테스트 먼저 작성한다', source: { workitem: 'WI-6', project: 'p' } },
      'now',
    );
    expect(r.created).toBe(true);
    expect(r.repeated).toBe(false);
    expect(r.gotcha.id).toBe('G-001');
    expect(r.gotcha.count).toBe(1);
  });

  it('sameAs 로 같은 교훈을 다시 기록하면 count 가 2 가 되고 repeated=true', () => {
    const first = recordGotcha(
      { lesson: '좌표계 의존 먼저 확인', source: { workitem: 'WI-4', project: 'p' } },
      't1',
    );
    const second = recordGotcha(
      { lesson: '(중복)', sameAs: first.gotcha.id, source: { workitem: 'WI-6', project: 'p' } },
      't2',
    );
    expect(second.created).toBe(false);
    expect(second.repeated).toBe(true);
    expect(second.gotcha.count).toBe(2);
    // 자동 승격하지 않는다: 규칙 파일이 생기지 않는다.
    const rulesActive = path.join(process.env.AWL_HOME as string, 'rules', 'active');
    expect(fs.existsSync(rulesActive)).toBe(false);
    // history 에 처음/이번이 남는다
    expect(loadGotchaList()[0]?.history).toHaveLength(2);
  });
});

describe('acquireLock — 동시 실행을 막는다', () => {
  it('두 번째 acquire 는 실패하고, release 후 다시 성공한다', () => {
    expect(acquireLock()).toBe(true);
    expect(acquireLock()).toBe(false); // 이미 잡혀 있음
    releaseLock();
    expect(acquireLock()).toBe(true);
    releaseLock();
  });
});

describe('writeGeneration — 프로젝트별 디렉토리', () => {
  it('generations/<project>/<workitem>.json 에 지표를 쓴다', () => {
    const metrics = {
      criteriaTotal: 5,
      avgAttempts: 1.4,
      blockedRatio: 0,
      reviewRejects: 1,
      proceduralErrors: 2,
      gotchaApplied: 3,
      gotchaMissed: 1,
      coverage: { auditFindingsTotal: 4, addressed: 2, excluded: 2, excludedApprovedByHuman: true },
    };
    const file = writeGeneration('agent-work-loop', 'WI-6', metrics, '2026-07-14T00:00:00Z');
    expect(file).toContain(path.join('generations', 'agent-work-loop', 'WI-6.json'));
    const written = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(written.criteriaTotal).toBe(5);
    expect(written.workitem).toBe('WI-6');
    expect(written.gotchaApplied).toBe(3);
    expect(written.gotchaMissed).toBe(1);
    expect(written.coverage).toEqual({
      auditFindingsTotal: 4,
      addressed: 2,
      excluded: 2,
      excludedApprovedByHuman: true,
    });
  });
});

describe('collectEvolve — coverage 계측 (WI-T AC-04)', () => {
  it('audit findings 와 criteria.addresses 를 대조해 addressed/excluded 를 센다', () => {
    seedRecords([
      {
        id: '1',
        at: '2026-07-14T10:00:00Z',
        type: 'audit',
        workitem: 'WI-6',
        scope: 's',
        findings: [
          { id: 'F-01', what: 'a' },
          { id: 'F-02', what: 'b' },
        ],
      },
      {
        id: '2',
        at: '2026-07-14T09:00:00Z',
        type: 'gate',
        workitem: 'WI-6',
        gate: 1,
        decision: 'approved',
        presentedCriteria: ['AC-01'],
        auto: false,
      },
    ]);
    const state = { criteria: [{ id: 'AC-01', status: 'passed', addresses: ['F-01'] }] };
    const col = collectEvolve('agent-work-loop', 'WI-6', state);

    expect(col.metrics.coverage).toEqual({
      auditFindingsTotal: 2,
      addressed: 1,
      excluded: 1,
      excludedApprovedByHuman: true,
    });
  });

  it('gate:1 이 auto:true(자율 승인)면 excludedApprovedByHuman 은 false', () => {
    seedRecords([
      {
        id: '1',
        at: '2026-07-14T10:00:00Z',
        type: 'audit',
        workitem: 'WI-6',
        scope: 's',
        findings: [{ id: 'F-01', what: 'a' }],
      },
      {
        id: '2',
        at: '2026-07-14T09:00:00Z',
        type: 'gate',
        workitem: 'WI-6',
        gate: 1,
        decision: 'approved',
        presentedCriteria: ['AC-01'],
        auto: true,
      },
    ]);
    const state = { criteria: [{ id: 'AC-01', status: 'passed' }] };
    const col = collectEvolve('agent-work-loop', 'WI-6', state);

    expect(col.metrics.coverage.excludedApprovedByHuman).toBe(false);
  });

  it('gate:1 기록이 없으면 excludedApprovedByHuman 은 false', () => {
    seedRecords([]);
    const col = collectEvolve('agent-work-loop', 'WI-6', { criteria: [] });
    expect(col.metrics.coverage).toEqual({
      auditFindingsTotal: 0,
      addressed: 0,
      excluded: 0,
      excludedApprovedByHuman: false,
    });
  });
});

describe('migrateDeltasToGotchas (WI-O AC-02) — 무손실, 멱등, 원본 보존', () => {
  function seedLegacyDelta(id: string, extra: Record<string, unknown> = {}): void {
    const dir = legacyDeltasDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, `${id}.json`),
      JSON.stringify({ id, lesson: `lesson for ${id}`, count: 1, ...extra }),
    );
  }

  it('D-0XX 를 G-0XX 로 옮기고 id 를 재부여한다', () => {
    seedLegacyDelta('D-001');
    seedLegacyDelta('D-002');

    const result = migrateDeltasToGotchas();

    expect(result.migrated).toBe(true);
    expect(result.count).toBe(2);
    const gotchas = loadGotchaList();
    expect(gotchas.map((g) => g.id).sort()).toEqual(['G-001', 'G-002']);
  });

  it('sameAs 필드도 D-0XX -> G-0XX 로 함께 갱신한다', () => {
    seedLegacyDelta('D-001');
    seedLegacyDelta('D-002', { sameAs: 'D-001' });

    migrateDeltasToGotchas();

    const g2 = loadGotchaList().find((g) => g.id === 'G-002');
    expect(g2?.sameAs).toBe('G-001');
  });

  it('원본 deltas/ 디렉토리는 그대로 남는다(삭제 안 함) + 백업도 별도로 만든다', () => {
    seedLegacyDelta('D-001');
    const result = migrateDeltasToGotchas();

    expect(fs.existsSync(path.join(legacyDeltasDir(), 'D-001.json'))).toBe(true); // 원본 보존.
    expect(result.backupDir).toBeDefined();
    expect(fs.existsSync(path.join(result.backupDir as string, 'D-001.json'))).toBe(true);
  });

  it('내용(lesson/context/source/count/history)이 그대로 보존된다(무손실)', () => {
    seedLegacyDelta('D-001', {
      context: 'ctx',
      source: { project: 'p', workitem: 'WI-1' },
      count: 3,
      history: [{ at: 't1' }, { at: 't2' }],
    });

    migrateDeltasToGotchas();

    const g = loadGotchaList().find((g) => g.id === 'G-001');
    expect(g?.lesson).toBe('lesson for D-001');
    expect(g?.context).toBe('ctx');
    expect(g?.source).toEqual({ project: 'p', workitem: 'WI-1' });
    expect(g?.count).toBe(3);
    expect(g?.history).toEqual([{ at: 't1' }, { at: 't2' }]);
  });

  it('이미 gotchas/ 가 있으면(마이그레이션 이미 됨) 다시 옮기지 않는다(멱등)', () => {
    seedLegacyDelta('D-001');
    migrateDeltasToGotchas();
    const afterFirst = loadGotchaList().length;

    seedLegacyDelta('D-999'); // 마이그레이션 이후 deltas/ 에 새 파일이 생겨도.
    const second = migrateDeltasToGotchas();

    expect(second.migrated).toBe(false);
    expect(loadGotchaList().length).toBe(afterFirst); // 그대로 — 두 번째 실행이 안 건드림.
  });

  it('deltas/ 도 gotchas/ 도 둘 다 없으면(완전 새 설치) 아무 일도 안 한다', () => {
    const result = migrateDeltasToGotchas();
    expect(result.migrated).toBe(false);
    expect(result.count).toBe(0);
  });

  it('loadGotchaList 를 그냥 호출하기만 해도 자동으로 마이그레이션된다(migrateState 와 같은 패턴)', () => {
    seedLegacyDelta('D-001');
    const gotchas = loadGotchaList(); // 마이그레이션을 명시적으로 안 부름.
    expect(gotchas.map((g) => g.id)).toEqual(['G-001']);
  });
});
