import { describe, expect, it } from 'vitest';
import {
  buildLaneTokensReport,
  computeTokensReport,
  renderLaneTokensReport,
  renderTokensReport,
} from '../../src/commands/tokens.js';
import type { SessionUsageEvent } from '../../src/core/session-log.js';

const ASCII = { unicode: false, color: false, tty: false };

function ev(
  timestamp: string,
  input: number,
  output = 0,
  cacheCreation = 0,
  cacheRead = 0,
): SessionUsageEvent {
  return {
    timestamp,
    inputTokens: input,
    outputTokens: output,
    cacheCreationTokens: cacheCreation,
    cacheReadTokens: cacheRead,
  };
}

describe('computeTokensReport — 순수 함수', () => {
  it('레코드가 없으면 found:false 다(세션 로그가 있어도 시간창을 못 잡으므로 의미 없다)', () => {
    const report = computeTokensReport('WI-1', [], [ev('2026-07-17T00:00:00.000Z', 100)]);
    expect(report).toEqual({
      ticketId: 'WI-1',
      found: false,
      total: { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 },
      byStage: [],
    });
  });

  it('at 이 없는 레코드는 시간창 계산에서 제외된다', () => {
    const records = [{ type: 'spike', at: '2026-07-17T04:00:00.000Z' }, { type: 'no-at-field' }];
    const report = computeTokensReport('WI-1', records, []);
    expect(report.found).toBe(true);
    expect(report.windowStart).toBe('2026-07-17T04:00:00.000Z');
    expect(report.windowEnd).toBe('2026-07-17T04:00:00.000Z');
  });

  it('시간창 밖의 이벤트는 집계에서 제외된다', () => {
    const records = [
      { type: 'spike', at: '2026-07-17T04:00:00.000Z' },
      { type: 'review', at: '2026-07-17T05:00:00.000Z' },
    ];
    const events = [
      ev('2026-07-17T03:00:00.000Z', 999), // 시작 전 — 제외
      ev('2026-07-17T04:30:00.000Z', 100), // 구간 안
      ev('2026-07-17T06:00:00.000Z', 999), // 끝난 뒤 — 제외
    ];
    const report = computeTokensReport('WI-1', records, events);
    expect(report.total.input).toBe(100);
  });

  it('인접 레코드 사이 이벤트는 그 구간을 연 레코드의 type 으로 귀속된다', () => {
    // 시간창은 [첫 레코드.at, 마지막 레코드.at] 이다 — 그 밖의 이벤트는 애초에
    // inWindow 필터에서 빠진다(윗 테스트가 이미 그 규칙을 검증한다). 그래서 세 번째
    // 레코드(가상의 verify)를 추가해 review 구간이 실제로 창 안에 들도록 한다.
    const records = [
      { type: 'spike', at: '2026-07-17T04:00:00.000Z' },
      { type: 'review', at: '2026-07-17T05:00:00.000Z' },
      { type: 'verify', at: '2026-07-17T06:00:00.000Z' },
    ];
    const events = [
      ev('2026-07-17T04:10:00.000Z', 10), // spike 구간
      ev('2026-07-17T04:50:00.000Z', 20), // 여전히 spike 구간(review 전)
      ev('2026-07-17T05:30:00.000Z', 30), // review 구간(verify 전)
    ];
    const report = computeTokensReport('WI-1', records, events);
    const spike = report.byStage.find((s) => s.stage === 'spike');
    const review = report.byStage.find((s) => s.stage === 'review');
    expect(spike?.input).toBe(30); // 10+20
    expect(review?.input).toBe(30);
    expect(report.total.input).toBe(60);
  });

  it('type 이 없는 레코드는 "(알 수 없음)" 으로 묶인다', () => {
    const records = [{ at: '2026-07-17T04:00:00.000Z' }];
    const events = [ev('2026-07-17T04:00:00.000Z', 5)];
    const report = computeTokensReport('WI-1', records, events);
    expect(report.byStage.find((s) => s.stage === '(알 수 없음)')?.input).toBe(5);
  });

  it('input/output/cache 는 서로 섞이지 않는다', () => {
    const records = [{ type: 'implement', at: '2026-07-17T04:00:00.000Z' }];
    const events = [ev('2026-07-17T04:00:00.000Z', 10, 20, 30, 40)];
    const report = computeTokensReport('WI-1', records, events);
    expect(report.total).toEqual({ input: 10, output: 20, cacheCreation: 30, cacheRead: 40 });
  });

  it('레코드가 시각순으로 안 들어와도(입력 순서 무관) 정확히 계산한다', () => {
    const records = [
      { type: 'review', at: '2026-07-17T05:00:00.000Z' },
      { type: 'spike', at: '2026-07-17T04:00:00.000Z' },
    ];
    const events = [ev('2026-07-17T04:10:00.000Z', 10)];
    const report = computeTokensReport('WI-1', records, events);
    expect(report.windowStart).toBe('2026-07-17T04:00:00.000Z');
    expect(report.byStage.find((s) => s.stage === 'spike')?.input).toBe(10);
  });
});

describe('renderTokensReport — 크래시 없이 렌더', () => {
  it('found:false 면 안내 문구만 보여준다', () => {
    const out = renderTokensReport(
      {
        ticketId: 'WI-1',
        found: false,
        total: { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 },
        byStage: [],
      },
      ASCII,
    );
    expect(out).toContain('기록이 없습니다');
  });

  it('found:true 면 총합과 단계별 줄을 보여준다', () => {
    const out = renderTokensReport(
      {
        ticketId: 'WI-1',
        found: true,
        windowStart: '2026-07-17T04:00:00.000Z',
        windowEnd: '2026-07-17T05:00:00.000Z',
        total: { input: 100, output: 50, cacheCreation: 10, cacheRead: 5 },
        byStage: [{ stage: 'spike', input: 100, output: 50, cacheCreation: 10, cacheRead: 5 }],
      },
      ASCII,
    );
    expect(out).toContain('spike');
    expect(out).toContain('100');
  });

  it('byStage 가 비어 있어도(시간창 안에 세션 로그가 없음) 크래시하지 않는다', () => {
    const out = renderTokensReport(
      {
        ticketId: 'WI-1',
        found: true,
        windowStart: '2026-07-17T04:00:00.000Z',
        windowEnd: '2026-07-17T05:00:00.000Z',
        total: { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 },
        byStage: [],
      },
      ASCII,
    );
    expect(out).toContain('못 찾았습니다');
  });
});

describe('buildLaneTokensReport — 순수 함수 (WI-G17d, 레인별 합계 + 총합)', () => {
  it('레인마다 합계를 내고, 전체 합은 레인 합계의 합이다', () => {
    const report = buildLaneTokensReport([
      {
        lane: '(메인)',
        records: [{ type: 'spike', at: '2026-07-17T04:00:00.000Z' }],
        events: [ev('2026-07-17T04:00:00.000Z', 10, 5)],
      },
      {
        lane: 'keyboard',
        records: [{ type: 'attempt', at: '2026-07-17T04:00:00.000Z' }],
        events: [ev('2026-07-17T04:00:00.000Z', 20, 8)],
      },
    ]);
    expect(report.lanes).toHaveLength(2);
    expect(report.lanes.find((l) => l.lane === '(메인)')?.input).toBe(10);
    expect(report.lanes.find((l) => l.lane === 'keyboard')?.input).toBe(20);
    expect(report.total).toEqual({ input: 30, output: 13, cacheCreation: 0, cacheRead: 0 });
  });

  it('레코드가 없는(찾을 게 없는) 레인은 결과에서 빠진다', () => {
    const report = buildLaneTokensReport([
      { lane: '(메인)', records: [], events: [] },
      {
        lane: 'keyboard',
        records: [{ type: 'spike', at: '2026-07-17T04:00:00.000Z' }],
        events: [ev('2026-07-17T04:00:00.000Z', 5)],
      },
    ]);
    expect(report.lanes.map((l) => l.lane)).toEqual(['keyboard']);
  });

  it('input 내림차순으로 정렬한다', () => {
    const report = buildLaneTokensReport([
      {
        lane: 'small',
        records: [{ type: 's', at: '2026-07-17T04:00:00.000Z' }],
        events: [ev('2026-07-17T04:00:00.000Z', 5)],
      },
      {
        lane: 'big',
        records: [{ type: 's', at: '2026-07-17T04:00:00.000Z' }],
        events: [ev('2026-07-17T04:00:00.000Z', 50)],
      },
    ]);
    expect(report.lanes.map((l) => l.lane)).toEqual(['big', 'small']);
  });

  it('레인이 하나도 없으면(빈 배열) lanes/total 이 빈 값이다', () => {
    const report = buildLaneTokensReport([]);
    expect(report.lanes).toEqual([]);
    expect(report.total).toEqual({ input: 0, output: 0, cacheCreation: 0, cacheRead: 0 });
  });
});

describe('renderLaneTokensReport — 크래시 없이 렌더', () => {
  it('레인이 없으면 안내 문구만 보여준다', () => {
    const out = renderLaneTokensReport(
      { lanes: [], total: { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 } },
      ASCII,
    );
    expect(out).toContain('못 찾았습니다');
  });

  it('레인마다 한 줄 + 총합 줄을 보여준다', () => {
    const out = renderLaneTokensReport(
      {
        lanes: [
          { lane: 'keyboard', input: 20, output: 8, cacheCreation: 0, cacheRead: 0 },
          { lane: '(메인)', input: 10, output: 5, cacheCreation: 0, cacheRead: 0 },
        ],
        total: { input: 30, output: 13, cacheCreation: 0, cacheRead: 0 },
      },
      ASCII,
    );
    expect(out).toContain('keyboard');
    expect(out).toContain('(메인)');
    expect(out).toContain('30');
  });
});
