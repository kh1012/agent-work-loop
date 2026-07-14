import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  appendRecord,
  buildRecord,
  monthFile,
  newRecordId,
  readRecords,
  renderRecords,
} from '../../src/commands/record.js';

const origHome = process.env.AWL_HOME;

afterEach(() => {
  if (origHome === undefined) {
    delete process.env.AWL_HOME;
  } else {
    process.env.AWL_HOME = origHome;
  }
});

const DEFAULTS = { project: 'maxflow', id: 'rec_test1', at: '2026-07-14T12:30:00.000Z' };

describe('buildRecord — 구조 강제', () => {
  it('attempt 의 필수 필드가 없으면 무엇이 빠졌는지 돌려준다', () => {
    const r = buildRecord('attempt', { what: 'x' }, DEFAULTS);
    expect(r.record).toBeUndefined();
    expect(r.missing).toContain('why');
    expect(r.missing).toContain('how');
    expect(r.missing).toContain('result');
  });

  it('필수 필드가 다 있으면 레코드를 만든다(id/at/project/type 주입)', () => {
    const r = buildRecord(
      'attempt',
      { what: 'a', why: 'b', how: 'c', result: 'passed' },
      DEFAULTS,
    );
    expect(r.missing).toEqual([]);
    expect(r.record).toMatchObject({
      id: 'rec_test1',
      at: DEFAULTS.at,
      project: 'maxflow',
      type: 'attempt',
      result: 'passed',
    });
  });

  it('project 가 데이터에도 config 에도 없으면 거부한다', () => {
    const r = buildRecord('attempt', { what: 'a', why: 'b', how: 'c', result: 'passed' }, {
      id: 'x',
      at: DEFAULTS.at,
    });
    expect(r.record).toBeUndefined();
    expect(r.missing).toContain('project');
  });

  it('blocked 의 tried 가 비어있으면 거부한다(핵심 구조)', () => {
    const r = buildRecord('blocked', { what: 'a', why: 'b', tried: [], lesson: 'x' }, DEFAULTS);
    expect(r.record).toBeUndefined();
    expect(r.missing.some((m) => m.startsWith('tried'))).toBe(true);
  });

  it('blocked 의 tried 가 채워지면 통과한다', () => {
    const r = buildRecord(
      'blocked',
      { what: 'a', why: 'b', tried: [{ approach: 'x', failed: 'y' }], lesson: 'z' },
      DEFAULTS,
    );
    expect(r.missing).toEqual([]);
    expect(Array.isArray((r.record as Record<string, unknown>).tried)).toBe(true);
  });
});

describe('record 저장 — append only', () => {
  beforeEach(() => {
    process.env.AWL_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'awl-rec-'));
  });

  it('두 번 써도 기존 기록이 보존된다', () => {
    const a = buildRecord('spike', { question: 'q1', found: 'f1' }, DEFAULTS).record;
    const b = buildRecord('spike', { question: 'q2', found: 'f2' }, {
      ...DEFAULTS,
      id: 'rec_test2',
      at: '2026-07-14T13:00:00.000Z',
    }).record;
    if (!a || !b) {
      throw new Error('레코드 생성 실패');
    }
    appendRecord(a);
    appendRecord(b);
    const all = readRecords();
    expect(all).toHaveLength(2);
    // 같은 월이면 같은 파일에 append
    expect(monthFile(DEFAULTS.at)).toBe(monthFile('2026-07-14T13:00:00.000Z'));
  });

  it('type/workitem 으로 거른다', () => {
    appendRecord(buildRecord('attempt', { what: 'a', why: 'b', how: 'c', result: 'passed', workitem: 'WI-3' }, DEFAULTS).record ?? {});
    appendRecord(buildRecord('blocked', { what: 'x', why: 'y', tried: [{ approach: 'a', failed: 'b' }], lesson: 'l', workitem: 'WI-4' }, { ...DEFAULTS, id: 'r2' }).record ?? {});
    expect(readRecords({ type: 'blocked' })).toHaveLength(1);
    expect(readRecords({ workitem: 'WI-3' })).toHaveLength(1);
  });
});

describe('renderRecords — 줄글이 아니라 목록', () => {
  it('what 을 한 줄씩 보여준다(줄글 아님)', () => {
    const records = [
      { id: '1', at: '2026-07-14T12:00:00Z', type: 'blocked', workitem: 'WI-3', what: '리사이즈 미러링' },
      { id: '2', at: '2026-07-13T12:00:00Z', type: 'attempt', what: '터미널 감지' },
    ];
    const text = renderRecords(records, { unicode: false, color: false, tty: false });
    const lines = text.split('\n').filter((l) => l.includes('리사이즈') || l.includes('터미널'));
    // 각 기록이 정확히 한 줄
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('리사이즈 미러링');
  });

  it('기록이 없으면 안내한다', () => {
    expect(renderRecords([], { unicode: false, color: false, tty: false })).toContain('기록이 없습니다');
  });
});

describe('newRecordId', () => {
  it('rec_ 접두사와 hex', () => {
    expect(newRecordId()).toMatch(/^rec_[0-9a-f]+$/);
  });
});
