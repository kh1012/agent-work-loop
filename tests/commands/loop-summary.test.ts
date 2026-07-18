import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type LoopSummary,
  assembleLoopSummary,
  buildSummaryLines,
  computeEfficiencyLens,
  computeInterventionLens,
  computeOutputLens,
  computeQualityLens,
  renderLoopSummary,
  runLoopSummary,
  summaryToJson,
} from '../../src/commands/loop-summary.js';
import { withCostAtStart } from '../../src/commands/work.js';
import { caps } from '../../src/core/tty.js';

type Rec = Record<string, unknown>;
const noColor = { ...caps(), color: false };

describe('computeInterventionLens (AC-01 ① / AC-02 헤드라인)', () => {
  it('gate auto:true 는 자율, auto:false·auto 부재·defer 는 사람 개입으로 분리한다', () => {
    const records: Rec[] = [
      { type: 'gate', gate: 1, auto: true },
      { type: 'gate', gate: 2, auto: false }, // 사람
      { type: 'gate', gate: 1, auto: true }, // 자율(재승인)
      { type: 'gate', gate: 2 }, // auto 부재 → 사람으로 센다(무인율 부풀리지 않음)
      { type: 'defer', severity: 'high', what: 'x', why: 'y', at: '2026-07-18T00:00:00Z' },
    ];
    const iv = computeInterventionLens(records);
    expect(iv.autonomous).toBe(2);
    expect(iv.humanGateCount).toBe(2);
    expect(iv.deferCount).toBe(1);
    expect(iv.humanInterventions).toBe(3);
    // 자율 2 / (자율 2 + 사람 3) = 40%
    expect(iv.unmannedRate).toBe(40);
  });

  it('완전 자율(gate 전부 auto:true, defer 0)이면 무인율 100', () => {
    const iv = computeInterventionLens([
      { type: 'gate', gate: 1, auto: true },
      { type: 'gate', gate: 2, auto: true },
    ]);
    expect(iv.autonomous).toBe(2);
    expect(iv.humanInterventions).toBe(0);
    expect(iv.unmannedRate).toBe(100);
  });

  it('판단 지점이 하나도 없으면(값 없음) 무인율 undefined — 100%로 오도하지 않는다', () => {
    const iv = computeInterventionLens([{ type: 'attempt', result: 'passed' }]);
    expect(iv.autonomous).toBe(0);
    expect(iv.humanInterventions).toBe(0);
    expect(iv.unmannedRate).toBeUndefined();
  });
});

describe('computeQualityLens (AC-01 ②)', () => {
  it('findings 있는 리뷰만 반려로 세고, 구현/절차 실패를 criteria 에서 합산한다', () => {
    const records: Rec[] = [
      { type: 'review', findings: [{ severity: 'high' }] }, // 반려
      { type: 'review', findings: [] }, // 통과(반려 아님)
      { type: 'blocked' },
    ];
    const criteria: Rec[] = [
      { id: 'AC-01', status: 'passed', attempts: 2, proceduralErrors: 1 },
      { id: 'AC-02', status: 'passed', attempts: 0, proceduralErrors: 0 },
    ];
    const q = computeQualityLens(records, criteria);
    expect(q.reviewCount).toBe(2);
    expect(q.reviewRejects).toBe(1);
    expect(q.blocked).toBe(1);
    expect(q.implementationFailures).toBe(2);
    expect(q.proceduralErrors).toBe(1);
    expect(q.avgAttempts).toBe(1); // 2 / 2 AC
  });

  it('리뷰·막힘·재시도가 없으면(값 없음) 전부 0', () => {
    const q = computeQualityLens([], [{ id: 'AC-01', status: 'passed', attempts: 0 }]);
    expect(q).toEqual({
      reviewCount: 0,
      reviewRejects: 0,
      blocked: 0,
      avgAttempts: 0,
      implementationFailures: 0,
      proceduralErrors: 0,
    });
  });
});

describe('computeEfficiencyLens (AC-01 ③)', () => {
  it('gate1~마지막 record 간격을 재고 costDelta 를 실어 넘긴다', () => {
    const records: Rec[] = [
      { type: 'gate', gate: 1, at: '2026-07-18T05:00:00Z' },
      { type: 'attempt', at: '2026-07-18T06:00:00Z', result: 'passed' },
    ];
    const e = computeEfficiencyLens(records, 2.4);
    expect(e.durationMs).toBe(3_600_000);
    expect(e.costDelta).toBe(2.4);
  });

  it('record 가 없거나 costDelta 가 없으면(값 없음) 둘 다 undefined', () => {
    const e = computeEfficiencyLens([], undefined);
    expect(e.durationMs).toBeUndefined();
    expect(e.costDelta).toBeUndefined();
  });
});

describe('computeOutputLens (AC-01 ④)', () => {
  it('완료 AC/전체·distinct 커밋·gotcha·gate1 배제 수를 센다', () => {
    const records: Rec[] = [
      { type: 'gotcha-applied', gotchaId: 'G-1' },
      { type: 'gotcha-applied', gotchaId: 'G-2' },
      { type: 'gotcha-missed', gotchaId: 'G-3' },
      { type: 'gate', gate: 1, presentedExclusions: [{ id: 'F-9' }, { id: 'F-8' }] },
    ];
    const criteria: Rec[] = [
      { id: 'AC-01', status: 'passed', commit: 'abc123' },
      { id: 'AC-02', status: 'passed', commit: 'abc123' }, // 같은 해시 → 1로 센다
      { id: 'AC-03', status: 'pending' }, // 커밋·완료 아님
    ];
    const o = computeOutputLens(records, criteria);
    expect(o.passedCriteria).toBe(2);
    expect(o.totalCriteria).toBe(3);
    expect(o.commits).toBe(1);
    expect(o.gotchaApplied).toBe(2);
    expect(o.gotchaMissed).toBe(1);
    expect(o.exclusions).toBe(2);
  });

  it('커밋·gotcha·배제가 없으면(값 없음) 0, 배제 없는 gate1 도 0', () => {
    const o = computeOutputLens([{ type: 'gate', gate: 1 }], [{ id: 'AC-01', status: 'pending' }]);
    expect(o).toEqual({
      passedCriteria: 0,
      totalCriteria: 1,
      commits: 0,
      gotchaApplied: 0,
      gotchaMissed: 0,
      exclusions: 0,
    });
  });
});

describe('assembleLoopSummary + 렌더 (AC-01 4렌즈)', () => {
  const records: Rec[] = [
    {
      type: 'gate',
      gate: 1,
      auto: true,
      at: '2026-07-18T05:00:00Z',
      presentedExclusions: [{ id: 'V-1' }],
    },
    { type: 'gate', gate: 2, auto: true, at: '2026-07-18T06:00:00Z' },
    { type: 'review', findings: [] },
    { type: 'gotcha-applied', gotchaId: 'G-1' },
  ];
  const criteria: Rec[] = [{ id: 'AC-01', status: 'passed', attempts: 0, commit: 'h1' }];

  it('4렌즈가 모두 요약에 존재한다', () => {
    const s = assembleLoopSummary('wi-x', records, criteria, 2.4);
    expect(s.hasRecords).toBe(true);
    expect(s.intervention.autonomous).toBe(2);
    expect(s.quality.reviewCount).toBe(1);
    expect(s.efficiency.durationMs).toBe(3_600_000);
    expect(s.output.exclusions).toBe(1);
  });

  it('렌더가 4렌즈 라벨을 모두 낸다', () => {
    const s = assembleLoopSummary('wi-x', records, criteria, 2.4);
    const out = renderLoopSummary(s, noColor);
    expect(out).toContain('사람 개입');
    expect(out).toContain('품질');
    expect(out).toContain('효율');
    expect(out).toContain('산출');
    expect(out).toContain('비용 ~$2.4');
  });
});

describe('헤드라인 = 개입 렌즈 (AC-02)', () => {
  it('요약 첫 콘텐츠 줄이 사람 개입 N · 자율 M (무인율 X%) 이다', () => {
    const s = assembleLoopSummary(
      'wi-x',
      [
        { type: 'gate', gate: 1, auto: true },
        { type: 'gate', gate: 2, auto: false },
      ],
      [{ id: 'AC-01', status: 'passed' }],
      undefined,
    );
    const lines = buildSummaryLines(s);
    // 첫 줄이 개입/자율. 렌즈 순서를 바꿔 품질/효율이 먼저 오면 이 잠금이 깨진다.
    expect(lines[0]).toBe('사람 개입 1 · 자율 1 (무인율 50%)');
  });

  it('무인율을 못 내면(판단 지점 0) 첫 줄에 무인율 괄호를 붙이지 않는다', () => {
    const s = assembleLoopSummary('wi-x', [{ type: 'attempt' }], [], undefined);
    expect(buildSummaryLines(s)[0]).toBe('사람 개입 0 · 자율 0');
  });
});

describe('기록 없음 안내 (AC-04)', () => {
  it('record 0 이면 안내만 내고 0-통계 렌즈를 렌더하지 않는다', () => {
    const s = assembleLoopSummary('wi-empty', [], [], undefined);
    expect(s.hasRecords).toBe(false);
    const lines = buildSummaryLines(s);
    expect(lines[0]).toBe('기록 없음 — record-trail-guard 참조');
    // 0-통계 렌즈(품질/효율/산출 라벨, 무인율)를 내면 오도한다 — 한 줄도 없어야 한다.
    const joined = lines.join('\n');
    expect(joined).not.toContain('품질');
    expect(joined).not.toContain('효율');
    expect(joined).not.toContain('산출');
    expect(joined).not.toContain('무인율');
  });

  it('렌더도 안내 문구를 담고 렌즈 라벨을 담지 않는다', () => {
    const out = renderLoopSummary(assembleLoopSummary('wi-empty', [], [], undefined), noColor);
    expect(out).toContain('기록 없음 — record-trail-guard 참조');
    expect(out).not.toContain('품질');
  });

  it('JSON 은 hasRecords:false + note 만 내고 0-렌즈 키를 싣지 않는다', () => {
    const json = summaryToJson(assembleLoopSummary('wi-empty', [], [], undefined));
    expect(json).toEqual({
      workitem: 'wi-empty',
      hasRecords: false,
      note: '기록 없음 — record-trail-guard 참조',
    });
    expect(json.intervention).toBeUndefined();
    expect(json.quality).toBeUndefined();
  });
});

describe('커밋 지표 라벨 정확화 (AC-05, 리뷰 finding #1)', () => {
  it('④ 산출이 격리커밋 라벨을 쓴다 — raw git 커밋으로 오독되는 커밋 단독 라벨을 쓰지 않는다', () => {
    const s = assembleLoopSummary(
      'wi-x',
      [{ type: 'gate', gate: 1, auto: true, at: '2026-07-18T05:00:00Z' }],
      [{ id: 'AC-01', status: 'passed', commit: 'h1' }],
      undefined,
    );
    const out = renderLoopSummary(s, noColor);
    expect(out).toContain('격리커밋 1');
    expect(out).not.toContain('· 커밋 ');
  });
});

// --- runLoopSummary 핸들러 glue (loop-completion-stats round2, 리뷰 finding #1/#2) ---
// 위 describe 들은 순수 렌즈·렌더만 잠근다. 핸들러 배선(CLI 진입·state 로딩·criteriaFor 분기
// 선택·startCostOf·computeCostDelta(readCostSnapshot()))은 미커버였다 — 셋을 통째로 지워도
// green(약단언, G-047: 래퍼·I/O 는 별도 회귀 표면). 실제 runLoopSummary 를 임시 프로젝트에서
// 호출해 stdout 을 단언한다.
describe('runLoopSummary 핸들러 glue (AC-06/AC-07, 리뷰 round1 finding #1/#2)', () => {
  const origHome = process.env.AWL_HOME;
  const origCwd = process.cwd();
  afterEach(() => {
    process.chdir(origCwd);
    if (origHome === undefined) {
      delete process.env.AWL_HOME;
    } else {
      process.env.AWL_HOME = origHome;
    }
  });

  /** requireConfig 가 요구하는 최소 config.json + 선택 state.json 을 심은 임시 프로젝트. */
  function tmpProject(state: unknown): string {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'awl-loopsum-')));
    fs.mkdirSync(path.join(root, '.awl'), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.awl', 'config.json'),
      JSON.stringify({
        project: 'loopsum-test',
        engineVersion: '0.0.0',
        verify: { typecheck: null, lint: null, test: null, e2e: null },
      }),
    );
    if (state !== undefined) {
      fs.writeFileSync(path.join(root, '.awl', 'state.json'), JSON.stringify(state));
    }
    return root;
  }

  /** readRecords 가 읽는 AWL_HOME/records 에 워크아이템 기록을 심는다. */
  function seedRecords(records: Record<string, unknown>[]): void {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'awl-loopsum-home-'));
    process.env.AWL_HOME = home;
    const dir = path.join(home, 'records');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, '2026-07.jsonl'),
      `${records.map((r) => JSON.stringify(r)).join('\n')}\n`,
    );
  }

  /** usage 스냅샷을 임시 파일에 쓰고 경로를 준다 — ambient /tmp/cc-usage.json 을 피해 결정론 확보. */
  function usageFile(snap: Record<string, unknown>): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'awl-usage-'));
    const f = path.join(dir, 'cc-usage.json');
    fs.writeFileSync(f, JSON.stringify(snap));
    return f;
  }

  /** gate 기록 한 건(readRecords 는 id 를 안 쓴다 — 짧게 유지). */
  function gateRec(wi: string, gate: number, at: string): Record<string, unknown> {
    return { type: 'gate', workitem: wi, gate, auto: true, at };
  }

  /** stdout 캡처. 버퍼는 클로저 변수라 mockRestore 가 안 비운다(G-065). */
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

  it('현재 워크아이템: work.ts withCostAtStart 가 심은 costAtStart 를 startCostOf 가 읽어 비용 델타를 렌더한다 (AC-06, write→read 계약 e2e)', () => {
    // write 측(work.ts 실경로): 시작 usage cost=2.00 → withCostAtStart 가 state.costAtStart 생성.
    const startUsage = usageFile({ cost: 2.0, ts: 100 });
    const seeded = withCostAtStart(
      { workitem: 'WI-NOW', criteria: [{ id: 'AC-01', status: 'passed', commit: 'h1' }] },
      startUsage,
    );
    // 계약의 write 절반: withCostAtStart 가 실제로 costAtStart(.cost) 키를 심었다.
    expect((seeded.costAtStart as { cost?: number } | undefined)?.cost).toBe(2.0);

    process.chdir(tmpProject(seeded));
    seedRecords([
      gateRec('WI-NOW', 1, '2026-07-18T05:00:00Z'),
      gateRec('WI-NOW', 2, '2026-07-18T06:00:00Z'),
    ]);

    // read 측: now usage cost=5.50 주입 → startCostOf(2.00)→computeCostDelta→5.50-2.00=3.50.
    const out = capture(() => runLoopSummary({ usagePath: usageFile({ cost: 5.5, ts: 200 }) }));

    // criteriaFor 현재 분기(state.criteria) 도달 — 완료 AC 1/1.
    expect(out).toContain('완료 AC 1/1');
    // startCostOf(:283-284) 가 costAtStart 를 읽고 델타가 렌더됐다(write→read 키·모양 계약).
    expect(out).toContain('비용 ~$3.5');
  });

  it('현재 워크아이템 --json: 핸들러가 efficiency.costDelta 를 직렬화한다 (AC-06, json 배선)', () => {
    const seeded = withCostAtStart(
      { workitem: 'WI-NOW', criteria: [{ id: 'AC-01', status: 'passed', commit: 'h1' }] },
      usageFile({ cost: 2.0 }),
    );
    process.chdir(tmpProject(seeded));
    seedRecords([gateRec('WI-NOW', 1, '2026-07-18T05:00:00Z')]);

    const out = capture(() => runLoopSummary({ json: true, usagePath: usageFile({ cost: 5.5 }) }));
    const j = JSON.parse(out) as LoopSummary;
    // write→read 계약이 json 표면에서도 3.5 로 잠긴다.
    expect(j.efficiency.costDelta).toBe(3.5);
    expect(j.output.passedCriteria).toBe(1);
  });
});
