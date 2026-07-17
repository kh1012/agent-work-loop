import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  computeDurationMs,
  experimentKey,
  groupByExperiment,
  loadGenerations,
  renderCompare,
  renderMetrics,
  renderMetricsCaveat,
  runMetrics,
} from '../../src/commands/metrics.js';
import { caps, visibleWidth } from '../../src/core/tty.js';

const origHome = process.env.AWL_HOME;

function seedGeneration(project: string, workitem: string, data: Record<string, unknown>): void {
  const dir = path.join(process.env.AWL_HOME as string, 'generations', project);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${workitem}.json`), JSON.stringify(data));
}

beforeEach(() => {
  process.env.AWL_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'awl-metrics-'));
});

afterEach(() => {
  if (origHome === undefined) {
    delete process.env.AWL_HOME;
  } else {
    process.env.AWL_HOME = origHome;
  }
});

describe('loadGenerations (WI-P AC-04)', () => {
  it('세대 스냅샷을 시간순(at)으로 정렬해 돌려준다 — 알파벳순과 반대로 섞어 진짜 정렬을 검증한다 (WI-P 리뷰 지적)', () => {
    // WI-Z 가 알파벳으로는 뒤지만 at 은 더 이르다. 이 fixture 는 알파벳순 우연 일치로
    // 통과할 수 없다 — sort() 를 지워보면 반드시 실패해야 진짜 회귀 테스트다.
    seedGeneration('p', 'WI-Z', {
      workitem: 'WI-Z',
      at: '2026-07-14T09:00:00Z',
      criteriaTotal: 2,
      avgAttempts: 0,
      blockedRatio: 0,
      reviewRejects: 0,
      proceduralErrors: 0,
      gotchaApplied: 0,
      gotchaMissed: 0,
    });
    seedGeneration('p', 'WI-A', {
      workitem: 'WI-A',
      at: '2026-07-14T10:00:00Z',
      criteriaTotal: 3,
      avgAttempts: 1,
      blockedRatio: 0,
      reviewRejects: 0,
      proceduralErrors: 0,
      gotchaApplied: 1,
      gotchaMissed: 0,
    });
    const gens = loadGenerations('p');
    expect(gens.map((g) => g.workitem)).toEqual(['WI-Z', 'WI-A']);
  });

  it('startedAt/durationMs 를 읽는다 (experiment-harness AC-03)', () => {
    seedGeneration('p', 'WI-D', {
      workitem: 'WI-D',
      at: '2026-07-16T12:00:00Z',
      criteriaTotal: 3,
      startedAt: '2026-07-16T10:00:00Z',
      durationMs: 7_200_000,
    });
    const g = loadGenerations('p')[0];
    expect(g?.startedAt).toBe('2026-07-16T10:00:00Z');
    expect(g?.durationMs).toBe(7_200_000);
  });

  it('experiment 케이스 메타를 읽고, 없는 옛 스냅샷은 undefined (experiment-harness AC-01)', () => {
    seedGeneration('p', 'WI-X', {
      workitem: 'WI-X',
      at: '2026-07-16T10:00:00Z',
      criteriaTotal: 3,
      experiment: { model: 'lite', mode: 'loop', taskType: 'ui' },
    });
    seedGeneration('p', 'WI-Y', { workitem: 'WI-Y', at: '2026-07-16T11:00:00Z', criteriaTotal: 2 });
    const gens = loadGenerations('p');
    const x = gens.find((g) => g.workitem === 'WI-X');
    const y = gens.find((g) => g.workitem === 'WI-Y');
    expect(x?.experiment).toEqual({ model: 'lite', mode: 'loop', taskType: 'ui' });
    expect(y?.experiment).toBeUndefined(); // 없으면 하위호환 undefined
  });

  it('gotchaApplied/gotchaMissed 필드가 없는 옛 스냅샷도 크래시 없이 0으로 읽는다 (하위호환)', () => {
    seedGeneration('p', 'WI-B', {
      workitem: 'WI-B',
      at: '2026-07-14T08:00:00Z',
      criteriaTotal: 11,
      avgAttempts: 0.73,
      blockedRatio: 0,
      reviewRejects: 2,
      proceduralErrors: 4,
      // gotchaApplied/gotchaMissed 없음 — 이 필드가 생기기 전(WI-B~WI-O)의 실제 스냅샷 형태
    });
    const gens = loadGenerations('p');
    expect(gens).toHaveLength(1);
    expect(gens[0]?.gotchaApplied).toBe(0);
    expect(gens[0]?.gotchaMissed).toBe(0);
  });

  it('coverage 가 없는 옛 스냅샷도 크래시 없이 0/false 로 읽는다 (하위호환, WI-T AC-04)', () => {
    seedGeneration('p', 'WI-C', {
      workitem: 'WI-C',
      at: '2026-07-14T08:00:00Z',
      criteriaTotal: 3,
      avgAttempts: 0,
      blockedRatio: 0,
      reviewRejects: 0,
      proceduralErrors: 0,
      gotchaApplied: 0,
      gotchaMissed: 0,
      // coverage 없음 — WI-T 이전 스냅샷
    });
    const gens = loadGenerations('p');
    expect(gens[0]?.coverage).toEqual({
      auditFindingsTotal: 0,
      addressed: 0,
      excluded: 0,
      excludedApprovedByHuman: false,
    });
  });

  it('coverage 가 있으면 그대로 읽는다', () => {
    seedGeneration('p', 'WI-D', {
      workitem: 'WI-D',
      at: '2026-07-14T08:00:00Z',
      criteriaTotal: 3,
      avgAttempts: 0,
      blockedRatio: 0,
      reviewRejects: 0,
      proceduralErrors: 0,
      gotchaApplied: 0,
      gotchaMissed: 0,
      coverage: { auditFindingsTotal: 5, addressed: 3, excluded: 2, excludedApprovedByHuman: true },
    });
    const gens = loadGenerations('p');
    expect(gens[0]?.coverage).toEqual({
      auditFindingsTotal: 5,
      addressed: 3,
      excluded: 2,
      excludedApprovedByHuman: true,
    });
  });

  it('프로젝트에 세대 기록이 전혀 없으면 빈 배열(크래시하지 않는다)', () => {
    expect(loadGenerations('nope')).toEqual([]);
  });

  it('깨진 JSON 파일은 건너뛴다', () => {
    const dir = path.join(process.env.AWL_HOME as string, 'generations', 'p');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'WI-broken.json'), '{ 이건 JSON 이 아님');
    seedGeneration('p', 'WI-1', {
      workitem: 'WI-1',
      at: '2026-07-14T09:00:00Z',
      criteriaTotal: 1,
      avgAttempts: 0,
      blockedRatio: 0,
      reviewRejects: 0,
      proceduralErrors: 0,
      gotchaApplied: 0,
      gotchaMissed: 0,
    });
    const gens = loadGenerations('p');
    expect(gens).toHaveLength(1);
  });
});

describe('renderMetricsCaveat — 난이도 경고 문구', () => {
  it('워크아이템마다 난이도가 다르다는 캐비트를 담는다', () => {
    expect(renderMetricsCaveat()).toContain('난이도');
  });
});

describe('renderMetrics — 사람용 표 (WI-P 리뷰 지적: criteriaTotal 누락 수정)', () => {
  it('criteriaTotal 을 포함한 모든 지표 값을 표에 담는다', () => {
    const out = renderMetrics(
      [
        {
          workitem: 'WI-1',
          at: '2026-07-14T09:00:00Z',
          criteriaTotal: 7,
          avgAttempts: 1.5,
          blockedRatio: 0.2,
          reviewRejects: 3,
          proceduralErrors: 4,
          gotchaApplied: 5,
          gotchaMissed: 6,
          coverage: {
            auditFindingsTotal: 12,
            addressed: 5,
            excluded: 7,
            excludedApprovedByHuman: true,
          },
        },
      ],
      caps(),
    );
    expect(out).toContain('WI-1');
    expect(out).toContain('7'); // criteriaTotal — 리뷰가 지적한 누락 필드
    expect(out).toContain('1.5');
    expect(out).toContain('0.2');
    expect(out).toContain('3');
    expect(out).toContain('4');
    expect(out).toContain('5');
    expect(out).toContain('6');
    expect(out).toContain('난이도'); // 캐비트
    expect(out).toContain('5/12'); // 커버리지(addressed/auditFindingsTotal, WI-T AC-04)
  });

  it('세대가 없으면 캐비트를 포함한 안내만 보여준다', () => {
    const out = renderMetrics([], caps());
    expect(out).toContain('세대 기록이 없습니다');
    expect(out).toContain('난이도');
  });
});

describe('computeDurationMs — 던지기~완료 소요(experiment-harness AC-03)', () => {
  it('정상 범위는 ms 차이', () => {
    expect(computeDurationMs('2026-07-16T00:00:00Z', '2026-07-16T01:00:00Z')).toBe(3_600_000);
  });
  it('파싱 불가면 undefined', () => {
    expect(computeDurationMs('nope', '2026-07-16T01:00:00Z')).toBeUndefined();
    expect(computeDurationMs('2026-07-16T00:00:00Z', undefined)).toBeUndefined();
  });
  it('음수(시계 역전)는 undefined', () => {
    expect(computeDurationMs('2026-07-16T02:00:00Z', '2026-07-16T01:00:00Z')).toBeUndefined();
  });
});

describe('groupByExperiment/experimentKey — 케이스 비교 집계(experiment-harness AC-02)', () => {
  const gen = (
    wi: string,
    exp: Record<string, unknown> | undefined,
    over: Record<string, unknown> = {},
  ) => ({
    workitem: wi,
    at: `2026-07-16T${wi.length}0:00:00Z`,
    criteriaTotal: 3,
    avgAttempts: 1,
    blockedRatio: 0,
    reviewRejects: 0,
    proceduralErrors: 0,
    gotchaApplied: 0,
    gotchaMissed: 0,
    coverage: { auditFindingsTotal: 0, addressed: 0, excluded: 0, excludedApprovedByHuman: false },
    ...(exp ? { experiment: exp } : {}),
    ...over,
  });

  it('experimentKey 는 model/mode/taskType, 없으면 ?', () => {
    expect(experimentKey({ model: 'lite', mode: 'loop', taskType: 'ui' })).toBe('lite/loop/ui');
    expect(experimentKey({ model: 'lite' })).toBe('lite/?/?');
    expect(experimentKey(undefined)).toBe('?/?/?');
  });

  it('같은 케이스를 묶어 집계하고, 태그 없는 세대는 제외한다', () => {
    const groups = groupByExperiment([
      gen(
        'A',
        { model: 'lite', mode: 'loop', taskType: 'ui' },
        { avgAttempts: 1, reviewRejects: 2, durationMs: 60_000 },
      ),
      gen(
        'B',
        { model: 'lite', mode: 'loop', taskType: 'ui' },
        { avgAttempts: 3, reviewRejects: 1, durationMs: 120_000 },
      ),
      gen('C', { model: 'flagship', mode: 'loop', taskType: 'ui' }, { avgAttempts: 2 }),
      gen('D', undefined), // 태그 없음 → 제외
    ]);
    expect(groups).toHaveLength(2); // lite/.., flagship/.. — D 제외
    const lite = groups.find((g) => g.model === 'lite');
    expect(lite?.count).toBe(2);
    expect(lite?.avgAttempts).toBe(2); // (1+3)/2
    expect(lite?.reviewRejects).toBe(3); // 2+1 합
    expect(lite?.avgDurationMs).toBe(90_000); // (60k+120k)/2
    expect(lite?.workitems).toEqual(['A', 'B']);
  });

  it('duration 없는 케이스는 avgDurationMs 를 비운다', () => {
    const groups = groupByExperiment([
      gen('C', { model: 'flagship', mode: 'loop', taskType: 'ui' }),
    ]);
    expect(groups[0]?.avgDurationMs).toBeUndefined();
  });
});

describe('experiment-harness AC-04 — 리뷰 후속', () => {
  const gen2 = (wi: string, exp: Record<string, unknown>, over: Record<string, unknown> = {}) => ({
    workitem: wi,
    at: '2026-07-16T10:00:00Z',
    criteriaTotal: 3,
    avgAttempts: 1,
    blockedRatio: 0,
    reviewRejects: 0,
    proceduralErrors: 0,
    gotchaApplied: 0,
    gotchaMissed: 0,
    coverage: { auditFindingsTotal: 0, addressed: 0, excluded: 0, excludedApprovedByHuman: false },
    experiment: exp,
    ...over,
  });

  it('groupByExperiment 는 케이스 키를 사전순으로 정렬한다(positional 가드)', () => {
    const groups = groupByExperiment([
      gen2('A', { model: 'zeta', mode: 'loop', taskType: 'ui' }),
      gen2('B', { model: 'alpha', mode: 'loop', taskType: 'ui' }),
    ]);
    // alpha 가 zeta 보다 앞 — sort() 를 지우면 입력순(zeta,alpha)이라 실패한다
    expect(groups.map((g) => g.model)).toEqual(['alpha', 'zeta']);
  });

  it('renderCompare 는 케이스 키·지표·소요(h/m)·태그없음 안내를 담는다', () => {
    const groups = groupByExperiment([
      gen2(
        'A',
        { model: 'lite', mode: 'loop', taskType: 'ui' },
        { avgAttempts: 2, reviewRejects: 3, durationMs: 5_400_000 },
      ),
    ]);
    const out = renderCompare(groups, 4, caps());
    expect(out).toContain('lite/loop/ui');
    expect(out).toContain('2'); // avgAttempts
    expect(out).toContain('3'); // reviewRejects
    expect(out).toContain('1h 30m'); // 5,400,000ms = 90분
    expect(out).toContain('4'); // 태그 없는 세대 4개
    expect(out).toContain('난이도'); // 캐비트
  });

  it('renderCompare 는 케이스 없으면 태그없음 안내만', () => {
    const out = renderCompare([], 7, caps());
    expect(out).toContain('태그가 있는 세대가 없습니다');
    expect(out).toContain('7');
  });

  it('loadGenerations 는 배열 experiment 를 거부한다(쓰기 경로와 대칭)', () => {
    seedGeneration('p', 'WI-arr', {
      workitem: 'WI-arr',
      at: '2026-07-16T10:00:00Z',
      criteriaTotal: 1,
      experiment: ['nope'], // 배열은 experiment 아님
    });
    expect(loadGenerations('p')[0]?.experiment).toBeUndefined();
  });
});

describe('renderMetrics/renderCompare 표 정렬 회귀잠금 (cli-design-tokens AC-05, 리뷰)', () => {
  const origCols = process.env.COLUMNS;
  afterEach(() => {
    if (origCols === undefined) delete process.env.COLUMNS;
    else process.env.COLUMNS = origCols;
  });
  const g = (workitem: string) => ({
    workitem,
    at: '2026-07-16T09:00:00Z',
    criteriaTotal: 3,
    avgAttempts: 1,
    blockedRatio: 0,
    reviewRejects: 0,
    proceduralErrors: 0,
    gotchaApplied: 0,
    gotchaMissed: 0,
    coverage: { auditFindingsTotal: 0, addressed: 0, excluded: 0, excludedApprovedByHuman: false },
  });

  // 둘째 열이 시작하는 표시폭 오프셋(=첫 열의 실제 채움 폭). card 는 행 전체를 상수 폭으로
  // gap-fill 정규화하므로 "행 전체 폭"은 항상 같다 — 정렬 회귀는 열 시작 오프셋으로만 잡힌다.
  const col2Offset = (row: string, firstColText: string): number => {
    // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI SGR 제거용
    const plain = row.replace(/\x1b\[[0-9;]*m/g, '');
    const wEnd = plain.indexOf(firstColText) + firstColText.length;
    const col2Rel = plain.slice(wEnd).search(/\S/); // 첫 열 뒤 공백들 다음의 첫 글자 = 둘째 열
    return visibleWidth(plain.slice(0, wEnd + col2Rel));
  };

  it('한글 workitem(표시폭≠length)과 ASCII 의 둘째 열이 같은 표시폭 오프셋에서 시작한다 — padEnd 되돌리면 실패', () => {
    process.env.COLUMNS = '200'; // 넓게 둬서 card wrap 없이 원행 유지
    const out = renderMetrics([g('가나다라'), g('ABCD')], {
      unicode: true,
      color: false,
      tty: true,
    });
    const lines = out.split('\n');
    const rowKo = lines.find((l) => l.includes('가나다라')) ?? '';
    const rowAscii = lines.find((l) => l.includes('ABCD')) ?? '';
    // 표시폭 패딩이면 둘째 열(criteriaTotal)이 같은 오프셋에서 시작한다.
    // 코드유닛 padEnd 면 한글 첫 열이 과다 채움돼 오프셋이 어긋난다(뮤테이션 킬).
    expect(col2Offset(rowKo, '가나다라')).toBe(col2Offset(rowAscii, 'ABCD'));
  });

  it('renderCompare 도 한글 케이스키의 둘째 열 오프셋이 ASCII 와 일치한다', () => {
    process.env.COLUMNS = '200';
    const gc = (model: string) => ({
      ...g('WI'),
      experiment: { model, mode: 'loop', taskType: 'ui' },
    });
    const groups = groupByExperiment([gc('가나다'), gc('abcd')]);
    const out = renderCompare(groups, 0, { unicode: true, color: false, tty: true });
    const lines = out.split('\n');
    const rowKo = lines.find((l) => l.includes('가나다/loop/ui')) ?? '';
    const rowAscii = lines.find((l) => l.includes('abcd/loop/ui')) ?? '';
    expect(col2Offset(rowKo, '가나다/loop/ui')).toBe(col2Offset(rowAscii, 'abcd/loop/ui'));
  });
});

describe('runMetrics --compare 핸들러 + --json 계약 (experiment-harness AC-05, 리뷰)', () => {
  const origCwd = process.cwd();
  afterEach(() => process.chdir(origCwd));

  function projectWithGens(): void {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'awl-metcmp-')));
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
    process.chdir(root);
    process.env.AWL_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'awl-metcmp-home-'));
    seedGeneration('p', 'WI-A', {
      workitem: 'WI-A',
      at: '2026-07-16T09:00:00Z',
      criteriaTotal: 3,
      avgAttempts: 1,
      experiment: { model: 'lite', mode: 'loop', taskType: 'ui' },
    });
    seedGeneration('p', 'WI-B', { workitem: 'WI-B', at: '2026-07-16T10:00:00Z', criteriaTotal: 2 }); // 태그 없음
  }

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

  it('--compare --json 이 {cases, untagged, caveat} 구조를 낸다', () => {
    projectWithGens();
    const j = JSON.parse(capture(() => runMetrics({ compare: true, json: true })));
    expect(Array.isArray(j.cases)).toBe(true);
    expect(j.cases[0]?.key).toBe('lite/loop/ui'); // 태그된 세대만 케이스로
    expect(j.cases[0]?.count).toBe(1);
    expect(j.untagged).toBe(1); // 태그 없는 WI-B
    expect(typeof j.caveat).toBe('string');
  });

  it('--compare 사람용은 케이스 키와 캐비트를 담는다', () => {
    projectWithGens();
    const out = capture(() => runMetrics({ compare: true }));
    expect(out).toContain('lite/loop/ui');
    expect(out).toContain('난이도'); // 캐비트
  });
});
