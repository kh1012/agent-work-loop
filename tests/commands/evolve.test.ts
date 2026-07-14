import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  acquireLock,
  collectEvolve,
  loadDeltaList,
  recordDelta,
  releaseLock,
  writeGeneration,
} from '../../src/commands/evolve.js';

const origHome = process.env.AWL_HOME;

function seedRecords(records: Record<string, unknown>[]): void {
  const dir = path.join(process.env.AWL_HOME as string, 'records');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '2026-07.jsonl'), `${records.map((r) => JSON.stringify(r)).join('\n')}\n`);
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
      { id: '1', at: '2026-07-14T10:00:00Z', type: 'blocked', workitem: 'WI-6', what: '리사이즈', tried: [{ approach: 'a', failed: 'b' }], lesson: 'x' },
      { id: '2', at: '2026-07-14T09:00:00Z', type: 'attempt', workitem: 'WI-6', attempt: 3, result: 'passed', what: 'y' },
      { id: '3', at: '2026-07-14T08:00:00Z', type: 'attempt', workitem: 'WI-6', attempt: 1, result: 'passed', what: 'z' },
      { id: '4', at: '2026-07-14T07:00:00Z', type: 'review', workitem: 'WI-6', target: 'AC-01', verdict: 'needs-work' },
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

  it('existingDeltas 를 함께 준다', () => {
    seedRecords([]);
    recordDelta({ lesson: '축을 파라미터로 빼기 전에 좌표계 의존을 확인한다', source: { workitem: 'WI-4' } }, '2026-07-14T00:00:00Z');
    const col = collectEvolve('p', 'WI-6', { criteria: [] });
    expect(col.existingDeltas).toHaveLength(1);
    expect(col.existingDeltas[0]?.count).toBe(1);
    expect(col.existingDeltas[0]?.lesson).toContain('좌표계');
  });
});

describe('recordDelta — 쓰고 세기만 (승격 안 함)', () => {
  it('새 교훈을 D-001 로 만든다', () => {
    const r = recordDelta({ lesson: '테스트 먼저 작성한다', source: { workitem: 'WI-6', project: 'p' } }, 'now');
    expect(r.created).toBe(true);
    expect(r.repeated).toBe(false);
    expect(r.delta.id).toBe('D-001');
    expect(r.delta.count).toBe(1);
  });

  it('sameAs 로 같은 교훈을 다시 기록하면 count 가 2 가 되고 repeated=true', () => {
    const first = recordDelta({ lesson: '좌표계 의존 먼저 확인', source: { workitem: 'WI-4', project: 'p' } }, 't1');
    const second = recordDelta({ lesson: '(중복)', sameAs: first.delta.id, source: { workitem: 'WI-6', project: 'p' } }, 't2');
    expect(second.created).toBe(false);
    expect(second.repeated).toBe(true);
    expect(second.delta.count).toBe(2);
    // 자동 승격하지 않는다: 규칙 파일이 생기지 않는다.
    const rulesActive = path.join(process.env.AWL_HOME as string, 'rules', 'active');
    expect(fs.existsSync(rulesActive)).toBe(false);
    // history 에 처음/이번이 남는다
    expect(loadDeltaList()[0]?.history).toHaveLength(2);
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
    const metrics = { criteriaTotal: 5, avgAttempts: 1.4, blockedRatio: 0, reviewRejects: 1, proceduralErrors: 2 };
    const file = writeGeneration('agent-work-loop', 'WI-6', metrics, '2026-07-14T00:00:00Z');
    expect(file).toContain(path.join('generations', 'agent-work-loop', 'WI-6.json'));
    const written = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(written.criteriaTotal).toBe(5);
    expect(written.workitem).toBe('WI-6');
  });
});
