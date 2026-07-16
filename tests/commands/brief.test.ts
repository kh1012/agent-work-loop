import { describe, expect, it } from 'vitest';
import {
  buildBrief,
  kstDateOf,
  kstDayRange,
  recordsInKstDay,
  summarizeRecord,
} from '../../src/commands/brief.js';

describe('kstDateOf — UTC epoch ms → KST 달력 날짜', () => {
  it('UTC 14:59:59Z 는 같은 날 KST 23:59(경계 이전)', () => {
    // 2026-07-16T14:59:59Z + 9h = 2026-07-16T23:59:59 KST
    expect(kstDateOf(Date.parse('2026-07-16T14:59:59.000Z'))).toBe('2026-07-16');
  });

  it('UTC 15:00:00Z 는 KST 익일 00:00(경계 넘음)', () => {
    // 2026-07-16T15:00:00Z + 9h = 2026-07-17T00:00:00 KST
    expect(kstDateOf(Date.parse('2026-07-16T15:00:00.000Z'))).toBe('2026-07-17');
  });

  it('UTC 자정 직후는 KST 같은 날 오전 9시', () => {
    expect(kstDateOf(Date.parse('2026-07-16T00:00:00.000Z'))).toBe('2026-07-16');
  });
});

describe('kstDayRange — KST 날짜 → UTC epoch 범위 [start, end)', () => {
  it('KST 2026-07-16 의 시작은 UTC 2026-07-15T15:00:00Z', () => {
    const { startMs } = kstDayRange('2026-07-16');
    expect(new Date(startMs).toISOString()).toBe('2026-07-15T15:00:00.000Z');
  });

  it('끝은 시작 + 24h (UTC 2026-07-16T15:00:00Z)', () => {
    const { endMs } = kstDayRange('2026-07-16');
    expect(new Date(endMs).toISOString()).toBe('2026-07-16T15:00:00.000Z');
  });

  it('경계는 반열림 — 14:59:59Z 포함, 15:00:00Z 제외', () => {
    const { startMs, endMs } = kstDayRange('2026-07-16');
    const before = Date.parse('2026-07-16T14:59:59.999Z');
    const at = Date.parse('2026-07-16T15:00:00.000Z');
    expect(before >= startMs && before < endMs).toBe(true);
    expect(at >= startMs && at < endMs).toBe(false); // 익일로 넘어감
  });

  it('잘못된 날짜 문자열은 NaN 범위를 낸다(호출부가 판정)', () => {
    const { startMs } = kstDayRange('not-a-date');
    expect(Number.isNaN(startMs)).toBe(true);
  });
});

describe('recordsInKstDay — project + KST 오늘 범위 재필터', () => {
  const range = kstDayRange('2026-07-16');
  const records = [
    { at: '2026-07-16T05:00:00.000Z', project: 'awl', type: 'attempt' }, // KST 16일 14시 ✓
    { at: '2026-07-16T15:30:00.000Z', project: 'awl', type: 'attempt' }, // KST 17일 00:30 ✗
    { at: '2026-07-16T05:00:00.000Z', project: 'other', type: 'attempt' }, // 다른 project ✗
    { at: '2026-07-15T15:00:00.000Z', project: 'awl', type: 'gate' }, // KST 16일 00:00 경계 ✓
  ];

  it('범위 안 + project 일치만 남긴다', () => {
    const got = recordsInKstDay(records, 'awl', range);
    expect(got).toHaveLength(2);
    expect(got.every((r) => r.project === 'awl')).toBe(true);
  });

  it('project 미지정이면 범위만 필터한다', () => {
    const got = recordsInKstDay(records, undefined, range);
    expect(got).toHaveLength(3); // 범위 안 3건(다른 project 포함), 익일 1건 제외
  });

  it('at 파싱 불가 레코드는 버린다', () => {
    const got = recordsInKstDay([{ at: 'not-a-date', project: 'awl' }], 'awl', range);
    expect(got).toHaveLength(0);
  });
});

describe('summarizeRecord — 타입별 짧은 요약', () => {
  it('attempt 는 what 을 요약으로', () => {
    expect(summarizeRecord({ type: 'attempt', what: '구현 완료' })).toBe('구현 완료');
  });

  it('gate 는 gate N + decision', () => {
    expect(summarizeRecord({ type: 'gate', gate: 1, decision: 'approved' })).toBe('gate1 approved');
  });

  it('audit 는 scope, evolve 는 lesson 을 쓴다', () => {
    expect(summarizeRecord({ type: 'audit', scope: 'brief' })).toBe('brief');
    expect(summarizeRecord({ type: 'evolve', lesson: '먼저 확인한다' })).toBe('먼저 확인한다');
  });

  it('마땅한 필드가 없으면 type 을 요약으로', () => {
    expect(summarizeRecord({ type: 'narrative', kind: 'reviewer-caught' })).toBe('reviewer-caught');
    expect(summarizeRecord({ type: 'unknown' })).toBe('unknown');
  });
});

describe('buildBrief — 오늘 요약 3축(records/commits/criteria) 조립', () => {
  it('세 축을 담고 각 record 는 {type,workitem,at,summary} 로 압축', () => {
    const brief = buildBrief({
      date: '2026-07-16',
      project: 'awl',
      records: [
        { at: '2026-07-16T05:00:00.000Z', type: 'attempt', workitem: 'WI-1', what: '구현' },
      ],
      commits: [{ hash: 'abc1234', subject: 'feat: x' }],
      criteria: [{ id: 'AC-01', status: 'passed', attempts: 1, baseline: 'deadbeef' }],
      changedFiles: [],
    });
    expect(brief.date).toBe('2026-07-16');
    expect(brief.project).toBe('awl');
    expect(brief.records).toEqual([
      { type: 'attempt', workitem: 'WI-1', at: '2026-07-16T05:00:00.000Z', summary: '구현' },
    ]);
    expect(brief.commits).toEqual([{ hash: 'abc1234', subject: 'feat: x' }]);
    // criteria 는 {id,status} 로만 압축(baseline/attempts 등 내부필드 제외)
    expect(brief.criteria).toEqual([{ id: 'AC-01', status: 'passed' }]);
  });

  it('빈 하루는 빈 축들을 낸다(에러 아님)', () => {
    const brief = buildBrief({
      date: '2026-07-17',
      project: 'awl',
      records: [],
      commits: [],
      criteria: [],
      changedFiles: [],
    });
    expect(brief.records).toEqual([]);
    expect(brief.commits).toEqual([]);
    expect(brief.criteria).toEqual([]);
  });
});
