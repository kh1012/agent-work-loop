import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildStatus, renderStatus } from '../../src/commands/status.js';

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

function tmpHomeWithRecords(records: Record<string, unknown>[]): void {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'awl-home-'));
  process.env.AWL_HOME = home;
  const dir = path.join(home, 'records');
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
    tmpHomeWithRecords([
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

  it('아직 시작 전이면 안내한다', () => {
    const root = tmpProject(undefined);
    process.env.AWL_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'awl-home-'));
    const text = renderStatus(buildStatus(root), { unicode: false, color: false, tty: false });
    expect(text).toContain('아직');
  });
});
