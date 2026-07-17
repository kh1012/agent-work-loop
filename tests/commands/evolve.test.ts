import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type Gotcha,
  acquireLock,
  collectEvolve,
  gotchaCluster,
  gotchasBySource,
  loadGotchaList,
  migrateDeltasToGotchas,
  normalizeRelations,
  recordGotcha,
  releaseLock,
  runEvolveCollect,
  runEvolveRecord,
  writeGeneration,
} from '../../src/commands/evolve.js';
import { loadGenerations } from '../../src/commands/metrics.js';
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

describe('collectEvolve — 기간 범위 scope (records-read-scope AC-02)', () => {
  function seedMonth(month: string, records: Record<string, unknown>[]): void {
    const dir = path.join(process.env.AWL_HOME as string, 'records');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, `${month}.jsonl`),
      `${records.map((r) => JSON.stringify(r)).join('\n')}\n`,
    );
  }
  const blk = (id: string, at: string, what: string) => ({
    id,
    at,
    type: 'blocked',
    workitem: 'WI-6',
    what,
    tried: [{ approach: 'a', failed: 'b' }],
    lesson: 'l',
  });

  it('scope 없으면 전량(폴백), scope 주면 그 월만 모은다', () => {
    seedMonth('2026-06', [blk('j6', '2026-06-10T10:00:00Z', '6월막힘')]);
    seedMonth('2026-07', [blk('j7', '2026-07-10T10:00:00Z', '7월막힘')]);
    const state = { criteria: [] };
    // 폴백(scope 없음) = 두 달 다 (기존 동작 보존)
    expect(collectEvolve('p', 'WI-6', state).blocked).toHaveLength(2);
    // scope 7월만
    const scoped = collectEvolve('p', 'WI-6', state, { months: ['2026-07'] });
    expect(scoped.blocked).toHaveLength(1);
    expect(scoped.blocked[0]?.what).toBe('7월막힘');
    // from/to 도 동작
    expect(
      collectEvolve('p', 'WI-6', state, { from: '2026-06', to: '2026-06' }).blocked,
    ).toHaveLength(1);
  });
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

describe('gotcha 관계 필드 relations (AC-01)', () => {
  it('relations 를 넣어 기록하면 로드 왕복에서 보존된다', () => {
    recordGotcha(
      {
        lesson: '축 파라미터화 전 좌표계 확인',
        source: { workitem: 'WI-4' },
        relations: [{ type: 'refines', target: 'G-005' }],
      },
      'now',
    );
    const loaded = loadGotchaList();
    expect(loaded[0]?.relations).toEqual([{ type: 'refines', target: 'G-005' }]);
  });

  it('relations 없는 레거시 gotcha 는 그대로 로드된다(relations undefined)', () => {
    const dir = path.join(process.env.AWL_HOME as string, 'gotchas');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'G-001.json'),
      JSON.stringify({ id: 'G-001', lesson: '레거시', count: 1 }),
    );
    const loaded = loadGotchaList();
    expect(loaded[0]?.id).toBe('G-001');
    expect(loaded[0]?.relations).toBeUndefined();
  });

  it('normalizeRelations 는 구조만 검증한다(의미는 판단 안 함)', () => {
    expect(normalizeRelations(undefined)).toEqual({ ok: true });
    expect(normalizeRelations([{ type: 'refines', target: 'G-002' }])).toEqual({
      ok: true,
      relations: [{ type: 'refines', target: 'G-002' }],
    });
    // 배열 아님 → 거부
    expect(normalizeRelations({ type: 'refines' }).ok).toBe(false);
    // 허용 안 된 type → 거부
    expect(normalizeRelations([{ type: 'causes', target: 'G-002' }]).ok).toBe(false);
    // target 없음 → 거부
    expect(normalizeRelations([{ type: 'refines' }]).ok).toBe(false);
  });

  it('runEvolveRecord 가 relations JSON 을 파싱해 기록한다(WRITE 경로)', () => {
    runEvolveRecord(
      JSON.stringify({
        lesson: '관계 있는 교훈',
        source: { workitem: 'WI-9', project: 'p' },
        relations: [{ type: 'supersedes', target: 'G-003' }],
      }),
    );
    const loaded = loadGotchaList();
    expect(loaded[0]?.relations).toEqual([{ type: 'supersedes', target: 'G-003' }]);
  });
});

describe('gotchaCluster — 관계 클러스터 순회 (AC-02)', () => {
  const mk = (id: string, extra: Partial<Gotcha> = {}): Gotcha => ({
    id,
    lesson: id,
    count: 1,
    ...extra,
  });

  it('relations/sameAs 엣지를 따라 관련 교훈을 모은다(시드 제외)', () => {
    const list = [
      mk('G-001', { relations: [{ type: 'refines', target: 'G-002' }] }),
      mk('G-002', { sameAs: 'G-003' }),
      mk('G-003'),
      mk('G-009'), // 무관 — 클러스터에 안 들어감
    ];
    const cluster = gotchaCluster('G-001', list)
      .map((x) => x.id)
      .sort();
    expect(cluster).toEqual(['G-002', 'G-003']);
  });

  it('엣지 없는 시드는 빈 클러스터', () => {
    expect(gotchaCluster('G-001', [mk('G-001'), mk('G-002')])).toEqual([]);
  });

  it('순환(G-001↔G-002)에서 무한루프 없이 종료', () => {
    const list = [
      mk('G-001', { relations: [{ type: 'refines', target: 'G-002' }] }),
      mk('G-002', { relations: [{ type: 'refines', target: 'G-001' }] }),
    ];
    expect(gotchaCluster('G-001', list).map((x) => x.id)).toEqual(['G-002']);
  });

  it('maxHops 로 순회 깊이를 제한한다', () => {
    const list = [
      mk('G-001', { relations: [{ type: 'refines', target: 'G-002' }] }),
      mk('G-002', { sameAs: 'G-003' }),
      mk('G-003'),
    ];
    expect(gotchaCluster('G-001', list, 1).map((x) => x.id)).toEqual(['G-002']);
    expect(
      gotchaCluster('G-001', list, 2)
        .map((x) => x.id)
        .sort(),
    ).toEqual(['G-002', 'G-003']);
  });

  it('실재하지 않는 target(dangling)은 결과에서 뺀다', () => {
    const list = [mk('G-001', { relations: [{ type: 'supersedes', target: 'G-999' }] })];
    expect(gotchaCluster('G-001', list)).toEqual([]);
  });
});

describe('gotchasBySource + collectEvolve relatedGotchas (AC-03)', () => {
  const mk = (id: string, extra: Partial<Gotcha> = {}): Gotcha => ({
    id,
    lesson: id,
    count: 1,
    ...extra,
  });
  const writeGotchaFile = (g: Gotcha): void => {
    const dir = path.join(process.env.AWL_HOME as string, 'gotchas');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${g.id}.json`), JSON.stringify(g));
  };

  it('gotchasBySource 는 source.workitem 으로 뒤조회한다', () => {
    const list = [
      mk('G-001', { source: { workitem: 'WI-X' } }),
      mk('G-002', { source: { workitem: 'WI-Y' } }),
      mk('G-003', { source: { workitem: 'WI-X' } }),
    ];
    const found = gotchasBySource('WI-X', list)
      .map((g) => g.id)
      .sort();
    expect(found).toEqual(['G-001', 'G-003']);
  });

  it('collectEvolve 가 출처 + 관계 클러스터를 relatedGotchas 로 노출한다', () => {
    seedRecords([]);
    writeGotchaFile(
      mk('G-001', {
        source: { workitem: 'WI-6' },
        relations: [{ type: 'refines', target: 'G-002' }],
      }),
    );
    writeGotchaFile(mk('G-002', { source: { workitem: 'WI-9' } })); // 다른 워크아이템이나 G-001 관계로 딸려옴
    writeGotchaFile(mk('G-003', { source: { workitem: 'WI-6' } })); // 같은 워크아이템, 관계 없음
    writeGotchaFile(mk('G-009', { source: { workitem: 'WI-9' } })); // 무관
    const col = collectEvolve('p', 'WI-6', { criteria: [] });
    expect(col.relatedGotchas.map((g) => g.id).sort()).toEqual(['G-001', 'G-002', 'G-003']);
    // existingGotchas 는 여전히 전량(회귀 없음)
    expect(col.existingGotchas).toHaveLength(4);
  });

  it('workitem 이 null 이거나 관련 교훈이 없으면 relatedGotchas 는 빈 배열', () => {
    seedRecords([]);
    writeGotchaFile(mk('G-001', { source: { workitem: 'WI-9' } }));
    expect(collectEvolve('p', null, { criteria: [] }).relatedGotchas).toEqual([]);
    expect(collectEvolve('p', 'WI-6', { criteria: [] }).relatedGotchas).toEqual([]);
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

  it('extra(experiment/startedAt/durationMs)를 스냅샷에 싣는다 (experiment-harness AC-04, 리뷰)', () => {
    const metrics = {
      criteriaTotal: 1,
      avgAttempts: 1,
      blockedRatio: 0,
      reviewRejects: 0,
      proceduralErrors: 0,
      gotchaApplied: 0,
      gotchaMissed: 0,
      coverage: {
        auditFindingsTotal: 0,
        addressed: 0,
        excluded: 0,
        excludedApprovedByHuman: false,
      },
    };
    const file = writeGeneration('p', 'WI-E', metrics, '2026-07-16T12:00:00Z', {
      experiment: { model: 'lite', mode: 'loop', taskType: 'ui' },
      startedAt: '2026-07-16T10:00:00Z',
      durationMs: 7_200_000,
    });
    const written = JSON.parse(fs.readFileSync(file, 'utf8'));
    // ...extra 스프레드가 없으면 세 필드가 사라진다(회귀 킬).
    expect(written.experiment).toEqual({ model: 'lite', mode: 'loop', taskType: 'ui' });
    expect(written.startedAt).toBe('2026-07-16T10:00:00Z');
    expect(written.durationMs).toBe(7_200_000);
  });
});

describe('collectEvolve — awlFeedback 유도 (0.6.x, AC-02/AC-03)', () => {
  it('awl-feedback 기록이 있으면 recorded 에 모으고 prompt 를 준다', () => {
    seedRecords([
      {
        id: 'a1',
        at: '2026-07-14T10:00:00Z',
        type: 'awl-feedback',
        workitem: 'WI-6',
        area: 'commit',
        what: '무관 파일 삼킴',
        impact: '수동 되돌림',
        severity: 'high',
      },
      {
        id: 'b1',
        at: '2026-07-14T09:00:00Z',
        type: 'blocked',
        workitem: 'WI-6',
        what: 'x',
        tried: [{ approach: 'a', failed: 'b' }],
        lesson: 'y',
      },
    ]);
    const col = collectEvolve('agent-work-loop', 'WI-6', { criteria: [] });
    expect(col.awlFeedback.recorded).toHaveLength(1);
    expect(col.awlFeedback.recorded[0]?.area).toBe('commit');
    expect(col.awlFeedback.prompt.length).toBeGreaterThan(0);
    // gotcha 추출 자료(blocked)와 섞이지 않는다 — awl-feedback 은 blocked 에 안 들어간다.
    expect(col.blocked.some((r) => r.type === 'awl-feedback')).toBe(false);
    expect(col.blocked).toHaveLength(1);
  });

  it('awl-feedback 기록이 없으면 recorded 는 빈 배열이지만 prompt 는 여전히 준다', () => {
    seedRecords([
      { id: '1', at: '2026-07-14T10:00:00Z', type: 'audit', workitem: 'WI-6', scope: 's' },
    ]);
    const col = collectEvolve('agent-work-loop', 'WI-6', { criteria: [] });
    expect(col.awlFeedback.recorded).toEqual([]);
    expect(col.awlFeedback.prompt.length).toBeGreaterThan(0);
  });

  it('awl-feedback 은 existingGotchas 로 승격되지 않는다 (다른 종류, records/ 에 산다)', () => {
    seedRecords([
      {
        id: 'a1',
        at: '2026-07-14T10:00:00Z',
        type: 'awl-feedback',
        workitem: 'WI-6',
        area: 'gate',
        what: 'x',
        impact: 'y',
        severity: 'medium',
      },
    ]);
    const col = collectEvolve('agent-work-loop', 'WI-6', { criteria: [] });
    expect(col.existingGotchas).toEqual([]);
    expect(col.awlFeedback.recorded).toHaveLength(1);
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

  it('gate:1 의 auto 가 boolean 이 아니면(예: 문자열) auto:true 아닌 것으로 보고 excludedApprovedByHuman 은 true (WI-T AC-07, 리뷰 지적)', () => {
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
        auto: 'true', // 문자열 — boolean 아님
      },
    ]);
    const state = { criteria: [{ id: 'AC-01', status: 'passed' }] };
    const col = collectEvolve('agent-work-loop', 'WI-6', state);

    expect(col.metrics.coverage.excludedApprovedByHuman).toBe(true);
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

describe('runEvolveCollect — 세대에 experiment/duration 영속화 (experiment-harness AC-04, 리뷰)', () => {
  const origCwd = process.cwd();
  const origHome2 = process.env.AWL_HOME;
  afterEach(() => {
    process.chdir(origCwd);
    if (origHome2 === undefined) delete process.env.AWL_HOME;
    else process.env.AWL_HOME = origHome2;
  });

  it('state.workitemExperiment/workitemCreatedAt 를 세대 스냅샷에 실어 loadGenerations 로 읽힌다', () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'awl-evocol-')));
    fs.mkdirSync(path.join(root, '.awl'), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.awl', 'config.json'),
      JSON.stringify({
        project: 'p',
        mainLanguage: 'other',
        character: 'ko',
        engineVersion: '0.6.7',
        verify: {},
      }),
    );
    fs.writeFileSync(
      path.join(root, '.awl', 'state.json'),
      JSON.stringify({
        workitem: 'WI-9',
        criteria: [],
        workitemCreatedAt: '2026-07-16T10:00:00Z',
        workitemExperiment: { model: 'lite', mode: 'loop', taskType: 'ui' },
      }),
    );
    process.chdir(root);
    process.env.AWL_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'awl-evocol-home-'));

    runEvolveCollect({ workitem: 'WI-9', json: true });
    const gen = loadGenerations('p').find((g) => g.workitem === 'WI-9');
    // extra 조립 라인이 제거되면 이 세 단언이 실패한다(회귀 킬).
    expect(gen?.experiment).toEqual({ model: 'lite', mode: 'loop', taskType: 'ui' });
    expect(gen?.startedAt).toBe('2026-07-16T10:00:00Z');
    expect(typeof gen?.durationMs).toBe('number'); // 던지기~지금 소요(양수)
    expect(gen?.durationMs).toBeGreaterThan(0);
  });
});
