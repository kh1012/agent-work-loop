import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  appendRecord,
  buildRecord,
  monthFile,
  newRecordId,
  readRecords,
  renderRecords,
  resolveBlockedBaseline,
  runRecord,
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
    const r = buildRecord('attempt', { what: 'a', why: 'b', how: 'c', result: 'passed' }, DEFAULTS);
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
    const r = buildRecord(
      'attempt',
      { what: 'a', why: 'b', how: 'c', result: 'passed' },
      {
        id: 'x',
        at: DEFAULTS.at,
      },
    );
    expect(r.record).toBeUndefined();
    expect(r.missing).toContain('project');
  });

  it('workitem 이 데이터에 없으면 defaults(현재 워크아이템)로 자동 태깅한다(evolve 워크아이템 집계가 이 태그에 의존)', () => {
    const r = buildRecord(
      'attempt',
      { what: 'a', why: 'b', how: 'c', result: 'passed' },
      { ...DEFAULTS, workitem: 'WI-O' },
    );
    expect(r.record?.workitem).toBe('WI-O');
  });

  it('workitem 이 데이터에 명시되면 defaults 보다 우선한다', () => {
    const r = buildRecord(
      'attempt',
      { what: 'a', why: 'b', how: 'c', result: 'passed', workitem: 'WI-X' },
      { ...DEFAULTS, workitem: 'WI-O' },
    );
    expect(r.record?.workitem).toBe('WI-X');
  });

  it('workitem 이 데이터에도 defaults 에도 없으면 필드 자체를 만들지 않는다(안 쓰는 필드 금지, WI-7 D-21)', () => {
    const r = buildRecord('attempt', { what: 'a', why: 'b', how: 'c', result: 'passed' }, DEFAULTS);
    expect(r.record).not.toHaveProperty('workitem');
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

  it('criteria 의 각 항목에 dependsOn(선행 완료조건 ID 배열)을 넣어도 코드 변경 없이 그대로 보존된다 (WI-E AC-02)', () => {
    const items = [
      { id: 'AC-01', 조건: 'x', 범위: 'y', 검증: 'awl verify' },
      { id: 'AC-02', 조건: 'x', 범위: 'y', 검증: 'awl verify', dependsOn: ['AC-01'] },
    ];
    const r = buildRecord('criteria', { items }, DEFAULTS);
    expect(r.missing).toEqual([]);
    const record = r.record as Record<string, unknown>;
    expect(record.items).toEqual(items); // dependsOn 이 사라지거나 바뀌지 않는다.
  });

  it('decision: performanceSensitive:true 인데 alternatives 가 없으면 거부한다 (WI-I AC-05)', () => {
    const r = buildRecord(
      'decision',
      {
        question: 'q',
        decision: 'd',
        rationale: 'r',
        performanceSensitive: true,
      },
      DEFAULTS,
    );
    expect(r.record).toBeUndefined();
    expect(r.missing.some((m) => m.startsWith('alternatives'))).toBe(true);
  });

  it('decision: performanceSensitive:true 인데 alternatives 가 빈 배열이면 거부한다', () => {
    const r = buildRecord(
      'decision',
      {
        question: 'q',
        decision: 'd',
        rationale: 'r',
        performanceSensitive: true,
        alternatives: [],
      },
      DEFAULTS,
    );
    expect(r.record).toBeUndefined();
    expect(r.missing.some((m) => m.startsWith('alternatives'))).toBe(true);
  });

  it('decision: performanceSensitive:true 이고 alternatives 가 채워지면 통과한다', () => {
    const r = buildRecord(
      'decision',
      {
        question: 'q',
        decision: 'd',
        rationale: 'r',
        performanceSensitive: true,
        alternatives: ['다른 방법 A: 이런 이유로 기각'],
      },
      DEFAULTS,
    );
    expect(r.missing).toEqual([]);
    expect((r.record as Record<string, unknown>).alternatives).toEqual([
      '다른 방법 A: 이런 이유로 기각',
    ]);
  });

  it('decision: performanceSensitive 가 없거나 false 면 alternatives 없어도 기존처럼 통과(하위호환)', () => {
    const r1 = buildRecord('decision', { question: 'q', decision: 'd', rationale: 'r' }, DEFAULTS);
    expect(r1.missing).toEqual([]);
    const r2 = buildRecord(
      'decision',
      { question: 'q', decision: 'd', rationale: 'r', performanceSensitive: false },
      DEFAULTS,
    );
    expect(r2.missing).toEqual([]);
  });

  it('gotcha-applied 는 gotchaId/what 이 필수다 (WI-P AC-01)', () => {
    const r = buildRecord('gotcha-applied', { what: 'x' }, DEFAULTS);
    expect(r.record).toBeUndefined();
    expect(r.missing).toContain('gotchaId');
  });

  it('gotcha-applied 필수 필드가 다 있으면 통과한다', () => {
    const r = buildRecord('gotcha-applied', { gotchaId: 'G-006', what: '적용함' }, DEFAULTS);
    expect(r.missing).toEqual([]);
    expect(r.record).toMatchObject({ type: 'gotcha-applied', gotchaId: 'G-006' });
  });

  it('gotcha-missed 는 gotchaId/what/why 가 필수다 (WI-P AC-01)', () => {
    const r = buildRecord('gotcha-missed', { gotchaId: 'G-006', what: 'x' }, DEFAULTS);
    expect(r.record).toBeUndefined();
    expect(r.missing).toContain('why');
  });

  it('gotcha-missed 필수 필드가 다 있으면 통과한다', () => {
    const r = buildRecord(
      'gotcha-missed',
      { gotchaId: 'G-006', what: '또 새어들어감', why: '확인을 안 함' },
      DEFAULTS,
    );
    expect(r.missing).toEqual([]);
  });

  it('narrative 는 kind/counterfactual 이 필수다 (WI-P AC-02)', () => {
    const r = buildRecord('narrative', { kind: 'gate-caught' }, DEFAULTS);
    expect(r.record).toBeUndefined();
    expect(r.missing).toContain('counterfactual');
  });

  it('narrative 의 kind 가 허용된 4값이 아니면 거부한다', () => {
    const r = buildRecord('narrative', { kind: 'something-else', counterfactual: 'x' }, DEFAULTS);
    expect(r.record).toBeUndefined();
    expect(r.missing.some((m) => m.startsWith('kind'))).toBe(true);
  });

  it('narrative 의 kind 가 4값 중 하나이고 counterfactual 이 있으면 통과한다', () => {
    for (const kind of ['gate-caught', 'reviewer-caught', 'spike-prevented', 'blocked-discarded']) {
      const r = buildRecord('narrative', { kind, counterfactual: 'x' }, DEFAULTS);
      expect(r.missing).toEqual([]);
    }
  });

  it('narrative 의 kind 필드 자체가 없으면 missing 에 kind 가 담긴다(counterfactual 과 별개로)', () => {
    const r = buildRecord('narrative', { counterfactual: 'x' }, DEFAULTS);
    expect(r.record).toBeUndefined();
    expect(r.missing).toContain('kind');
    // enum 불일치 메시지("kind (다음 중...")까지 중복으로 붙지는 않는다.
    expect(r.missing.filter((m) => m.startsWith('kind')).length).toBe(1);
  });

  it('narrative 의 kind 가 문자열이 아닌 값(숫자 등)이면 enum 우회 없이 거부한다 (WI-P 리뷰 지적)', () => {
    const r = buildRecord('narrative', { kind: 123, counterfactual: 'x' }, DEFAULTS);
    expect(r.record).toBeUndefined();
    expect(r.missing.some((m) => m.startsWith('kind'))).toBe(true);
  });

  it('gate 는 gate/decision/presentedCriteria 가 필수다 (WI-Q AC-01)', () => {
    const r = buildRecord('gate', { gate: 1, decision: 'approved' }, DEFAULTS);
    expect(r.record).toBeUndefined();
    expect(r.missing.some((m) => m.startsWith('presentedCriteria'))).toBe(true);
  });

  it('gate 값이 1/2 가 아니면 거부한다', () => {
    const r = buildRecord(
      'gate',
      { gate: 3, decision: 'approved', presentedCriteria: ['AC-01'] },
      DEFAULTS,
    );
    expect(r.record).toBeUndefined();
    expect(r.missing.some((m) => m.startsWith('gate'))).toBe(true);
  });

  it('gate 1 에서 decision 이 게이트1 전용 값이 아니면 거부한다(게이트2 전용 값 more-work 는 게이트1에서 무효)', () => {
    const r = buildRecord(
      'gate',
      { gate: 1, decision: 'more-work', presentedCriteria: ['AC-01'] },
      DEFAULTS,
    );
    expect(r.record).toBeUndefined();
    expect(r.missing.some((m) => m.startsWith('decision'))).toBe(true);
  });

  it('gate 2 에서 decision 이 게이트2 전용 값이 아니면 거부한다(게이트1 전용 값 split 은 게이트2에서 무효)', () => {
    const r = buildRecord(
      'gate',
      { gate: 2, decision: 'split', presentedCriteria: ['AC-01'] },
      DEFAULTS,
    );
    expect(r.record).toBeUndefined();
    expect(r.missing.some((m) => m.startsWith('decision'))).toBe(true);
  });

  it('gate 1/2 각각 자기 전용 decision 값이면 통과한다', () => {
    for (const decision of ['approved', 'modified', 'rejected', 'split']) {
      const r = buildRecord('gate', { gate: 1, decision, presentedCriteria: ['AC-01'] }, DEFAULTS);
      expect(r.missing).toEqual([]);
    }
    for (const decision of ['approved', 'more-work', 'abandoned']) {
      const r = buildRecord('gate', { gate: 2, decision, presentedCriteria: ['AC-01'] }, DEFAULTS);
      expect(r.missing).toEqual([]);
    }
  });

  it('gate 의 선택 필드(presentedExclusions/riskSignals/modifications/humanFindings/auto)는 그대로 보존된다', () => {
    const r = buildRecord(
      'gate',
      {
        gate: 1,
        decision: 'approved',
        presentedCriteria: ['AC-01'],
        presentedExclusions: ['다중 선택'],
        riskSignals: ['조사 미확인 2건'],
        auto: false,
      },
      DEFAULTS,
    );
    expect(r.missing).toEqual([]);
    expect(r.record).toMatchObject({
      presentedExclusions: ['다중 선택'],
      riskSignals: ['조사 미확인 2건'],
      auto: false,
    });
  });

  it('gate 가 숫자가 아닌 타입(문자열/객체/배열/불리언)이면 전부 거부한다(회귀 테스트, WI-Q 리뷰 지적)', () => {
    for (const badGate of ['1', {}, [1], true]) {
      const r = buildRecord(
        'gate',
        { gate: badGate, decision: 'approved', presentedCriteria: ['AC-01'] },
        DEFAULTS,
      );
      expect(r.record).toBeUndefined();
      expect(r.missing.some((m) => m.startsWith('gate'))).toBe(true);
    }
  });

  it('decision 이 문자열이 아닌 타입(숫자/객체/배열)이면 enum 우회 없이 거부한다(회귀 테스트, WI-Q 리뷰 지적)', () => {
    for (const badDecision of [5, {}, ['approved']]) {
      const r = buildRecord(
        'gate',
        { gate: 1, decision: badDecision, presentedCriteria: ['AC-01'] },
        DEFAULTS,
      );
      expect(r.record).toBeUndefined();
      expect(r.missing.some((m) => m.startsWith('decision'))).toBe(true);
    }
  });

  it('clarify 는 questions(비어있지 않은 배열)가 필수다 (WI-V AC-01)', () => {
    const r = buildRecord('clarify', {}, DEFAULTS);
    expect(r.record).toBeUndefined();
    expect(r.missing.some((m) => m.startsWith('questions'))).toBe(true);
  });

  it('clarify 의 questions 가 빈 배열이면 거부한다', () => {
    const r = buildRecord('clarify', { questions: [] }, DEFAULTS);
    expect(r.record).toBeUndefined();
    expect(r.missing.some((m) => m.startsWith('questions'))).toBe(true);
  });

  it('clarify 의 questions 가 채워지면 통과하고 내용이 그대로 보존된다', () => {
    const questions = [{ asked: '닫힘 트리거를?', answered: '바깥 클릭 + Esc' }];
    const r = buildRecord('clarify', { questions }, DEFAULTS);
    expect(r.missing).toEqual([]);
    expect((r.record as Record<string, unknown>).questions).toEqual(questions);
  });
});

describe('record 저장 — append only', () => {
  beforeEach(() => {
    process.env.AWL_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'awl-rec-'));
  });

  it('두 번 써도 기존 기록이 보존된다', () => {
    const a = buildRecord('spike', { question: 'q1', found: 'f1' }, DEFAULTS).record;
    const b = buildRecord(
      'spike',
      { question: 'q2', found: 'f2' },
      {
        ...DEFAULTS,
        id: 'rec_test2',
        at: '2026-07-14T13:00:00.000Z',
      },
    ).record;
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
    appendRecord(
      buildRecord(
        'attempt',
        { what: 'a', why: 'b', how: 'c', result: 'passed', workitem: 'WI-3' },
        DEFAULTS,
      ).record ?? {},
    );
    appendRecord(
      buildRecord(
        'blocked',
        {
          what: 'x',
          why: 'y',
          tried: [{ approach: 'a', failed: 'b' }],
          lesson: 'l',
          workitem: 'WI-4',
        },
        { ...DEFAULTS, id: 'r2' },
      ).record ?? {},
    );
    expect(readRecords({ type: 'blocked' })).toHaveLength(1);
    expect(readRecords({ workitem: 'WI-3' })).toHaveLength(1);
  });
});

describe('renderRecords — 줄글이 아니라 목록', () => {
  it('what 을 한 줄씩 보여준다(줄글 아님)', () => {
    const records = [
      {
        id: '1',
        at: '2026-07-14T12:00:00Z',
        type: 'blocked',
        workitem: 'WI-3',
        what: '리사이즈 미러링',
      },
      { id: '2', at: '2026-07-13T12:00:00Z', type: 'attempt', what: '터미널 감지' },
    ];
    const text = renderRecords(records, { unicode: false, color: false, tty: false });
    const lines = text.split('\n').filter((l) => l.includes('리사이즈') || l.includes('터미널'));
    // 각 기록이 정확히 한 줄
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('리사이즈 미러링');
  });

  it('기록이 없으면 안내한다', () => {
    expect(renderRecords([], { unicode: false, color: false, tty: false })).toContain(
      '기록이 없습니다',
    );
  });
});

describe('newRecordId', () => {
  it('rec_ 접두사와 hex', () => {
    expect(newRecordId()).toMatch(/^rec_[0-9a-f]+$/);
  });
});

describe('resolveBlockedBaseline — blocked 기록의 baseline SHA 추론 (WI-7 D-21)', () => {
  const state = {
    criteria: [
      { id: 'AC-01', status: 'in_progress', baseline: 'abc1234' },
      { id: 'AC-02', status: 'pending' }, // baseline 없음(commit --start 안 함)
    ],
    currentFocus: 'AC-01',
  };

  it('data.criterion 이 명시되면 그걸로 완료 조건을 찾는다', () => {
    expect(resolveBlockedBaseline({ criterion: 'AC-01' }, state)).toBe('abc1234');
  });

  it('data.criterion 이 없으면 state.currentFocus 로 추론한다', () => {
    expect(resolveBlockedBaseline({}, state)).toBe('abc1234');
  });

  it('완료 조건에 baseline 이 없으면 undefined', () => {
    expect(resolveBlockedBaseline({ criterion: 'AC-02' }, state)).toBeUndefined();
  });

  it('focus 를 전혀 알 수 없으면 undefined(크래시하지 않음)', () => {
    expect(resolveBlockedBaseline({}, {})).toBeUndefined();
  });
});

describe('runRecord — 활성 워크아이템 강제 (WI-R AC-01)', () => {
  const origCwd = process.cwd();
  const origHome = process.env.AWL_HOME;

  afterEach(() => {
    process.chdir(origCwd);
    if (origHome === undefined) {
      delete process.env.AWL_HOME;
    } else {
      process.env.AWL_HOME = origHome;
    }
  });

  function project(state: Record<string, unknown> | undefined): string {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'awl-record-cli-')));
    fs.mkdirSync(path.join(root, '.awl'), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.awl', 'config.json'),
      JSON.stringify({ project: 'p', mainLanguage: 'other', verify: {} }),
    );
    if (state) {
      fs.writeFileSync(path.join(root, '.awl', 'state.json'), JSON.stringify(state));
    }
    process.chdir(root);
    process.env.AWL_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'awl-record-cli-home-'));
    return root;
  }

  function mockExit() {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    return { exitSpy, stderrSpy };
  }

  it('활성 워크아이템이 전혀 없으면(state 도 --workitem 도 없음) 거부한다', async () => {
    project(undefined); // state.json 없음 = 워크아이템 없음
    const { exitSpy, stderrSpy } = mockExit();

    await expect(runRecord('spike', { json: '{"question":"q","found":"f"}' })).rejects.toThrow(
      'exit:1',
    );
    expect(stderrSpy.mock.calls.some((c) => String(c[0]).includes('활성 워크아이템'))).toBe(true);

    exitSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  it('--workitem 플래그가 있으면 활성 워크아이템이 없어도 통과한다', async () => {
    project(undefined);
    await runRecord('spike', { json: '{"question":"q","found":"f"}', workitem: 'WI-9' });
    const records = readRecords({ workitem: 'WI-9' });
    expect(records).toHaveLength(1);
  });

  it('state.json 에 현재 워크아이템이 있으면 --workitem 없어도 통과한다', async () => {
    project({ workitem: 'WI-9', workitems: {} });
    await runRecord('spike', { json: '{"question":"q","found":"f"}' });
    const records = readRecords({ workitem: 'WI-9' });
    expect(records).toHaveLength(1);
  });

  it('데이터(JSON) 안에 workitem 이 명시되면 활성 워크아이템이 없어도 통과한다(우선순위 유지)', async () => {
    project(undefined);
    await runRecord('spike', {
      json: '{"question":"q","found":"f","workitem":"WI-9"}',
    });
    const records = readRecords({ workitem: 'WI-9' });
    expect(records).toHaveLength(1);
  });
});
