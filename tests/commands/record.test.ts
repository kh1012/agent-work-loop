import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  appendRecord,
  buildRecord,
  collectDeferred,
  computeCoverage,
  detailTierFor,
  laneFromRecordFilename,
  loadProjectName,
  measureDiffSize,
  monthFile,
  newRecordId,
  readRecords,
  renderDeferSummary,
  renderRecords,
  resolveBlockedBaseline,
  resolveEffectiveAuthor,
  runDeferSummary,
  runRecord,
  selectMonthFiles,
  shouldDefer,
} from '../../src/commands/record.js';
import { parseFrontmatter } from '../../src/core/doc-frontmatter.js';
import { readSyncCursor } from '../../src/core/sync.js';

const origHome = process.env.AWL_HOME;

afterEach(() => {
  if (origHome === undefined) {
    delete process.env.AWL_HOME;
  } else {
    process.env.AWL_HOME = origHome;
  }
});

const DEFAULTS = { project: 'maxflow', id: 'rec_test1', at: '2026-07-14T12:30:00.000Z' };

describe('loadProjectName — effective worktree config', () => {
  it('worktree-local overlay의 project를 사용한다', () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'awl-record-project-')));
    fs.mkdirSync(path.join(root, '.awl'), { recursive: true });
    fs.mkdirSync(path.join(root, '.git', 'objects'), { recursive: true });
    fs.mkdirSync(path.join(root, '.git', 'refs'), { recursive: true });
    fs.writeFileSync(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    fs.writeFileSync(
      path.join(root, '.awl', 'config.json'),
      JSON.stringify({
        project: 'tracked-project',
        engineVersion: '0.0.0',
        verify: {},
      }),
    );
    fs.writeFileSync(
      path.join(root, '.awl', 'config.local.json'),
      JSON.stringify({ project: 'lane-project' }),
    );

    expect(loadProjectName(root)).toBe('lane-project');
  });
});

describe('resolveEffectiveAuthor — 전역 → 저장소 → local (WI-G13, adk-prototype.md:117)', () => {
  function project(overlay?: { author?: string }): string {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'awl-record-author-')));
    fs.mkdirSync(path.join(root, '.awl'), { recursive: true });
    fs.mkdirSync(path.join(root, '.git', 'objects'), { recursive: true });
    fs.mkdirSync(path.join(root, '.git', 'refs'), { recursive: true });
    fs.writeFileSync(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    fs.writeFileSync(
      path.join(root, '.awl', 'config.json'),
      JSON.stringify({ project: 'p', engineVersion: '0.0.0', verify: {}, author: 'repo@x.com' }),
    );
    if (overlay) {
      fs.writeFileSync(path.join(root, '.awl', 'config.local.json'), JSON.stringify(overlay));
    }
    return root;
  }

  it('저장소 config.json 이 author 를 정했으면 전역보다 그걸 쓴다', () => {
    process.env.AWL_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'awl-record-author-home-'));
    fs.writeFileSync(
      path.join(process.env.AWL_HOME, 'config.json'),
      JSON.stringify({ author: 'global@x.com' }),
    );
    const root = project();
    expect(resolveEffectiveAuthor(root)).toBe('repo@x.com');
  });

  it('config.local.json 이 author 를 덮으면 저장소 base 보다 그걸 쓴다', () => {
    process.env.AWL_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'awl-record-author-home-'));
    const root = project({ author: 'local@x.com' });
    expect(resolveEffectiveAuthor(root)).toBe('local@x.com');
  });

  it('저장소가 author 를 안 정했으면 전역으로 폴백한다', () => {
    process.env.AWL_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'awl-record-author-home-'));
    fs.writeFileSync(
      path.join(process.env.AWL_HOME, 'config.json'),
      JSON.stringify({ author: 'global@x.com' }),
    );
    const root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'awl-record-author-nooverride-')),
    );
    fs.mkdirSync(path.join(root, '.awl'), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.awl', 'config.json'),
      JSON.stringify({ project: 'p', engineVersion: '0.0.0', verify: {} }),
    );
    expect(resolveEffectiveAuthor(root)).toBe('global@x.com');
  });

  it('projectRoot 가 null 이어도 전역으로 폴백한다', () => {
    process.env.AWL_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'awl-record-author-home-'));
    fs.writeFileSync(
      path.join(process.env.AWL_HOME, 'config.json'),
      JSON.stringify({ author: 'global@x.com' }),
    );
    expect(resolveEffectiveAuthor(null)).toBe('global@x.com');
  });
});

describe('buildRecord — awl-feedback (0.6.x, AC-01)', () => {
  it('area/what/impact/severity 가 다 있으면 기록을 만든다 (suggestion 은 선택)', () => {
    const r = buildRecord(
      'awl-feedback',
      { area: 'commit', what: '무관 파일 삼킴', impact: '수동 되돌림', severity: 'high' },
      DEFAULTS,
    );
    expect(r.missing).toEqual([]);
    expect(r.record).toMatchObject({ type: 'awl-feedback', area: 'commit', severity: 'high' });
  });

  it('suggestion 을 넣어도 통과한다', () => {
    const r = buildRecord(
      'awl-feedback',
      { area: 'gate', what: 'x', impact: 'y', severity: 'low', suggestion: '개선안' },
      DEFAULTS,
    );
    expect(r.missing).toEqual([]);
    expect(r.record?.suggestion).toBe('개선안');
  });

  it('필수 필드가 없으면 무엇이 빠졌는지 돌려준다', () => {
    const r = buildRecord('awl-feedback', { area: 'commit' }, DEFAULTS);
    expect(r.record).toBeUndefined();
    expect(r.missing).toContain('what');
    expect(r.missing).toContain('impact');
    expect(r.missing).toContain('severity');
  });

  it('area 가 허용값이 아니면 거부한다', () => {
    const r = buildRecord(
      'awl-feedback',
      { area: '없는영역', what: 'x', impact: 'y', severity: 'high' },
      DEFAULTS,
    );
    expect(r.record).toBeUndefined();
    expect(r.missing.some((m) => m.startsWith('area'))).toBe(true);
  });

  it('severity 가 허용값이 아니면 거부한다', () => {
    const r = buildRecord(
      'awl-feedback',
      { area: 'commit', what: 'x', impact: 'y', severity: 'critical' },
      DEFAULTS,
    );
    expect(r.record).toBeUndefined();
    expect(r.missing.some((m) => m.startsWith('severity'))).toBe(true);
  });
});

describe('buildRecord — author (ADK stage 1)', () => {
  it('defaults.author 가 있으면 기록에 author 필드가 붙는다', () => {
    const r = buildRecord(
      'awl-feedback',
      { area: 'commit', what: 'x', impact: 'y', severity: 'high' },
      { ...DEFAULTS, author: 'hong@midasit.com' },
    );
    expect(r.record?.author).toBe('hong@midasit.com');
  });

  it('defaults.author 가 없으면 진행은 되고 author 필드는 아예 생략된다(필수 아님)', () => {
    const r = buildRecord(
      'awl-feedback',
      { area: 'commit', what: 'x', impact: 'y', severity: 'high' },
      DEFAULTS,
    );
    expect(r.missing).toEqual([]);
    expect(r.record).not.toHaveProperty('author');
  });
});

describe('buildRecord — refactor (loop-refactor-checkpoint AC-03)', () => {
  it('what/kind 가 다 있으면 기록을 만든다', () => {
    const r = buildRecord(
      'refactor',
      { what: 'gotchaCluster 인접구성을 헬퍼로 추출', kind: 'split' },
      DEFAULTS,
    );
    expect(r.missing).toEqual([]);
    expect(r.record).toMatchObject({ type: 'refactor', kind: 'split' });
  });

  it('필수 필드(what/kind)가 없으면 무엇이 빠졌는지 돌려준다', () => {
    const r = buildRecord('refactor', { what: 'x' }, DEFAULTS);
    expect(r.record).toBeUndefined();
    expect(r.missing).toContain('kind');
  });

  it('kind 가 허용값이 아니면 거부한다', () => {
    const r = buildRecord('refactor', { what: 'x', kind: '없는종류' }, DEFAULTS);
    expect(r.record).toBeUndefined();
    expect(r.missing.some((m) => m.startsWith('kind'))).toBe(true);
  });
});

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

  it('attempt result:verified 는 why/how 없이 what 만으로 통과한다 (무변경 가드/검증형, F-3)', () => {
    const r = buildRecord(
      'attempt',
      { what: 'LayersPanel 은 이미 tell-free 임을 확인', result: 'verified' },
      DEFAULTS,
    );
    expect(r.missing).toEqual([]);
    expect(r.record).toMatchObject({ type: 'attempt', result: 'verified' });
  });

  it('attempt result:passed 는 diffTier 없으면 why/how 를 요구한다 (verified 와 대비, F-3)', () => {
    const r = buildRecord('attempt', { what: '실제로 변경함', result: 'passed' }, DEFAULTS);
    expect(r.record).toBeUndefined();
    expect(r.missing).toContain('why');
    expect(r.missing).toContain('how');
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

  it('criteria 의 항목에 금지된 질적 표현이 있으면 거부한다 (WI-T AC-01)', () => {
    for (const banned of ['저위험', '주요한', '적절한', '가능한 만큼', '필요시']) {
      const items = [{ id: 'AC-01', 조건: `chrome-lint ${banned} 건 수정`, 범위: 'y', 검증: 'z' }];
      const r = buildRecord('criteria', { items }, DEFAULTS);
      expect(r.record, `"${banned}" 가 거부돼야 함`).toBeUndefined();
      expect(r.missing.some((m) => m.includes(banned))).toBe(true);
    }
  });

  it('criteria 의 항목에 금지어가 없으면 통과한다', () => {
    const items = [
      {
        id: 'AC-01',
        조건: 'chrome-lint ERROR 4건(파일:라인 명시) 전부 수정',
        범위: 'y',
        검증: 'z',
      },
    ];
    const r = buildRecord('criteria', { items }, DEFAULTS);
    expect(r.missing).toEqual([]);
  });

  it('criteria 여러 항목 중 하나만 금지어를 써도 전체를 거부한다', () => {
    const items = [
      { id: 'AC-01', 조건: '정상 조건', 범위: 'y', 검증: 'z' },
      { id: 'AC-02', 조건: '적절한 처리', 범위: 'y', 검증: 'z' },
    ];
    const r = buildRecord('criteria', { items }, DEFAULTS);
    expect(r.record).toBeUndefined();
    expect(r.missing.some((m) => m.includes('AC-02'))).toBe(true);
  });

  it('금지어가 더 큰 한글 단어에 포함돼 있으면 오탐하지 않는다 (WI-T AC-07, 리뷰 지적)', () => {
    const items = [
      { id: 'AC-01', 조건: 'chrome-lint 대응이 부적절한 부분을 고친다', 범위: 'y', 검증: 'z' },
    ];
    const r = buildRecord('criteria', { items }, DEFAULTS);
    expect(r.missing).toEqual([]);
  });

  it('금지어가 다른 한글 단어 뒤에 이어져도(단어 뒤쪽 경계) 오탐하지 않는다', () => {
    const items = [{ id: 'AC-01', 조건: '필요시간을 미리 확인한다', 범위: 'y', 검증: 'z' }];
    const r = buildRecord('criteria', { items }, DEFAULTS);
    expect(r.missing).toEqual([]);
  });

  it('금지어 앞뒤가 한글이 아니면(공백/시작/끝) 여전히 거부한다', () => {
    const items = [{ id: 'AC-01', 조건: '필요시 다시 확인한다', 범위: 'y', 검증: 'z' }];
    const r = buildRecord('criteria', { items }, DEFAULTS);
    expect(r.record).toBeUndefined();
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

  it('narrative 의 kind 가 허용된 5값이 아니면 거부한다', () => {
    const r = buildRecord('narrative', { kind: 'something-else', counterfactual: 'x' }, DEFAULTS);
    expect(r.record).toBeUndefined();
    expect(r.missing.some((m) => m.startsWith('kind'))).toBe(true);
  });

  it('narrative 의 kind 가 5값 중 하나이고 counterfactual 이 있으면 통과한다 (WI-W: tool-failed 추가)', () => {
    for (const kind of [
      'gate-caught',
      'reviewer-caught',
      'spike-prevented',
      'blocked-discarded',
      'tool-failed',
    ]) {
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

  it('gate 값이 1~4 가 아니면 거부한다(ADK stage 2a 로 3/4 추가)', () => {
    const r = buildRecord(
      'gate',
      { gate: 5, decision: 'approved', presentedCriteria: ['AC-01'] },
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

  it('gate 1/2 는 layer 없이 불러도 레거시와 동일하게 통과한다(완전 하위호환, ADK stage 2a)', () => {
    const r1 = buildRecord(
      'gate',
      { gate: 1, decision: 'approved', presentedCriteria: ['AC-01'] },
      DEFAULTS,
    );
    expect(r1.missing).toEqual([]);
    expect(r1.record).not.toHaveProperty('layer');

    const r2 = buildRecord(
      'gate',
      { gate: 2, decision: 'approved', presentedCriteria: ['AC-01'] },
      DEFAULTS,
    );
    expect(r2.missing).toEqual([]);
  });

  it('gate 1/2 에 layer 를 같이 줘도(정보성 태그) decision 검증 목록은 안 바뀐다', () => {
    const r = buildRecord(
      'gate',
      {
        gate: 1,
        decision: 'approved',
        presentedCriteria: ['AC-01'],
        layer: 'request',
        spec: 'spec-id-1',
      },
      DEFAULTS,
    );
    expect(r.missing).toEqual([]);
    expect(r.record?.layer).toBe('request');
  });

  it('gate 3 을 layer 없이 기록하면 거부한다(ticket 완료 게이트, ADK stage 2a)', () => {
    const r = buildRecord(
      'gate',
      { gate: 3, decision: 'approved', presentedCriteria: ['AC-01'] },
      DEFAULTS,
    );
    expect(r.record).toBeUndefined();
    expect(r.missing.some((m) => m.includes("layer ('ticket'"))).toBe(true);
  });

  it("gate 3 을 layer:'ticket' 로 허용된 decision과 ticket id 를 함께 기록하면 통과한다", () => {
    for (const decision of ['approved', 'more-work', 'abandoned']) {
      const r = buildRecord(
        'gate',
        { gate: 3, decision, presentedCriteria: ['AC-01'], layer: 'ticket', ticket: 'ticket-id-1' },
        DEFAULTS,
      );
      expect(r.missing).toEqual([]);
    }
  });

  it("gate 2/3 을 layer:'ticket' 으로 기록하는데 ticket 필드가 없으면 거부한다(ADK stage 2b)", () => {
    const r2 = buildRecord(
      'gate',
      { gate: 2, decision: 'approved', presentedCriteria: ['AC-01'], layer: 'ticket' },
      DEFAULTS,
    );
    expect(r2.record).toBeUndefined();
    expect(r2.missing.some((m) => m.startsWith('ticket'))).toBe(true);

    const r3 = buildRecord(
      'gate',
      { gate: 3, decision: 'approved', presentedCriteria: ['AC-01'], layer: 'ticket' },
      DEFAULTS,
    );
    expect(r3.record).toBeUndefined();
    expect(r3.missing.some((m) => m.startsWith('ticket'))).toBe(true);
  });

  it("gate 4 를 layer:'request' 없이(또는 'ticket'으로) 기록하면 거부한다(요청 닫기 게이트)", () => {
    const withoutLayer = buildRecord(
      'gate',
      { gate: 4, decision: 'merge', presentedCriteria: ['AC-01'] },
      DEFAULTS,
    );
    expect(withoutLayer.record).toBeUndefined();
    expect(withoutLayer.missing.some((m) => m.includes("layer ('request'"))).toBe(true);

    const wrongLayer = buildRecord(
      'gate',
      { gate: 4, decision: 'merge', presentedCriteria: ['AC-01'], layer: 'ticket' },
      DEFAULTS,
    );
    expect(wrongLayer.record).toBeUndefined();
  });

  it("gate 4 를 layer:'request' 로 merge/judge-only/hold 중 하나로 기록하면 통과한다", () => {
    for (const decision of ['merge', 'judge-only', 'hold']) {
      const r = buildRecord(
        'gate',
        { gate: 4, decision, presentedCriteria: ['AC-01'], layer: 'request', spec: 'spec-id-1' },
        DEFAULTS,
      );
      expect(r.missing).toEqual([]);
    }
  });

  it("gate 1/4 를 layer:'request' 로 기록하는데 spec 필드가 없으면 거부한다(ADK stage 3)", () => {
    const r1 = buildRecord(
      'gate',
      { gate: 1, decision: 'approved', presentedCriteria: ['AC-01'], layer: 'request' },
      DEFAULTS,
    );
    expect(r1.record).toBeUndefined();
    expect(r1.missing.some((m) => m.startsWith('spec'))).toBe(true);

    const r4 = buildRecord(
      'gate',
      { gate: 4, decision: 'merge', presentedCriteria: ['AC-01'], layer: 'request' },
      DEFAULTS,
    );
    expect(r4.record).toBeUndefined();
    expect(r4.missing.some((m) => m.startsWith('spec'))).toBe(true);
  });

  it('layer 가 request/ticket 이 아닌 값이면 거부한다', () => {
    const r = buildRecord(
      'gate',
      { gate: 1, decision: 'approved', presentedCriteria: ['AC-01'], layer: '없는레이어' },
      DEFAULTS,
    );
    expect(r.record).toBeUndefined();
    expect(r.missing.some((m) => m.startsWith('layer'))).toBe(true);
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

  it('review 는 reviewId/criteria/findings/cheatingDetected/verifyPassedBefore 가 필수다 (WI-S AC-01)', () => {
    const r = buildRecord('review', {}, DEFAULTS);
    expect(r.record).toBeUndefined();
    expect(r.missing).toContain('reviewId');
    expect(r.missing).toContain('criteria');
    expect(r.missing).toContain('findings');
    expect(r.missing).toContain('cheatingDetected');
    expect(r.missing).toContain('verifyPassedBefore');
  });

  it('review 의 criteria 는 비어있지 않은 배열이어야 한다', () => {
    const r = buildRecord(
      'review',
      {
        reviewId: 'rev_1',
        criteria: [],
        findings: [],
        cheatingDetected: [],
        verifyPassedBefore: true,
      },
      DEFAULTS,
    );
    expect(r.record).toBeUndefined();
    expect(r.missing.some((m) => m.startsWith('criteria'))).toBe(true);
  });

  it('review 의 findings/cheatingDetected 는 빈 배열이어도 통과한다(지적/부정행위 없음도 정당한 결과)', () => {
    const r = buildRecord(
      'review',
      {
        reviewId: 'rev_1',
        criteria: ['AC-01'],
        findings: [],
        cheatingDetected: [],
        verifyPassedBefore: true,
      },
      DEFAULTS,
    );
    expect(r.missing).toEqual([]);
  });

  it('review 의 verifyPassedBefore 가 false 여도(값 자체는 존재) 통과한다', () => {
    const r = buildRecord(
      'review',
      {
        reviewId: 'rev_1',
        criteria: ['AC-01'],
        findings: [],
        cheatingDetected: [],
        verifyPassedBefore: false,
      },
      DEFAULTS,
    );
    expect(r.missing).toEqual([]);
  });

  it('review 의 findings 내부에 becameCriterion 같은 자유 필드를 넣어도 그대로 보존된다(ruleId 는 필수, ADK stage 6)', () => {
    const findings = [
      {
        severity: 'high',
        what: 'AC-C1 이 주 진입점을 놓침',
        evidence: 'LayersPanel.toggleProp:236',
        becameCriterion: 'AC-C3',
        ruleId: '없음',
      },
    ];
    const r = buildRecord(
      'review',
      {
        reviewId: 'rev_1',
        criteria: ['AC-C1'],
        findings,
        cheatingDetected: [],
        verifyPassedBefore: true,
      },
      DEFAULTS,
    );
    expect(r.missing).toEqual([]);
    expect((r.record as Record<string, unknown>).findings).toEqual(findings);
  });

  it('review 의 findings/cheatingDetected 가 배열이 아니면 거부한다 (WI-S AC-05, 리뷰 지적)', () => {
    const r = buildRecord(
      'review',
      {
        reviewId: 'rev_1',
        criteria: ['AC-01'],
        findings: 'no issues found',
        cheatingDetected: false,
        verifyPassedBefore: true,
      },
      DEFAULTS,
    );
    expect(r.record).toBeUndefined();
    expect(r.missing.some((m) => m.startsWith('findings'))).toBe(true);
    expect(r.missing.some((m) => m.startsWith('cheatingDetected'))).toBe(true);
  });

  it('review 의 findings 가 숫자여도 거부한다', () => {
    const r = buildRecord(
      'review',
      {
        reviewId: 'rev_1',
        criteria: ['AC-01'],
        findings: 0,
        cheatingDetected: [],
        verifyPassedBefore: true,
      },
      DEFAULTS,
    );
    expect(r.record).toBeUndefined();
    expect(r.missing.some((m) => m.startsWith('findings'))).toBe(true);
  });
});

describe('review.findings — ruleId 지목 (ADK stage 6, D-15 의 좁은 예외)', () => {
  const origCwd = process.cwd();
  const origHome = process.env.AWL_HOME;
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'awl-review-ruleid-'));
    process.env.AWL_HOME = home;
  });

  afterEach(() => {
    process.chdir(origCwd);
    if (origHome === undefined) {
      delete process.env.AWL_HOME;
    } else {
      process.env.AWL_HOME = origHome;
    }
  });

  function writeActiveRule(id: string): void {
    const dir = path.join(home, 'rules', 'active');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, `${id}.md`),
      `---\nid: ${id}\napplies: a\ncounter: c\nhits: 0\n---\n\nbody`,
    );
  }

  /** runRecord 가 요구하는 프로젝트 루트 + 활성 워크아이템을 갖춘 임시 프로젝트. */
  function project(): void {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'awl-review-ruleid-proj-')));
    fs.mkdirSync(path.join(root, '.awl'), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.awl', 'config.json'),
      JSON.stringify({ project: 'p', mainLanguage: 'other', engineVersion: '0.0.0', verify: {} }),
    );
    fs.writeFileSync(path.join(root, '.awl', 'state.json'), JSON.stringify({ workitem: 'WI-X' }));
    process.chdir(root);
  }

  it('ruleId 가 없는 finding 은 거부한다', () => {
    const r = buildRecord(
      'review',
      {
        reviewId: 'rev_1',
        criteria: ['AC-01'],
        findings: [{ severity: 'high', what: 'x' }],
        cheatingDetected: [],
        verifyPassedBefore: true,
      },
      DEFAULTS,
    );
    expect(r.record).toBeUndefined();
    expect(r.missing.some((m) => m.includes('ruleId'))).toBe(true);
  });

  it("ruleId: '없음' 은 통과한다(제약에 해당 없음을 명시)", () => {
    const r = buildRecord(
      'review',
      {
        reviewId: 'rev_1',
        criteria: ['AC-01'],
        findings: [{ severity: 'low', what: 'x', ruleId: '없음' }],
        cheatingDetected: [],
        verifyPassedBefore: true,
      },
      DEFAULTS,
    );
    expect(r.missing).toEqual([]);
  });

  it('실재하는 규칙을 가리키면 통과한다', () => {
    writeActiveRule('R-001');
    const r = buildRecord(
      'review',
      {
        reviewId: 'rev_1',
        criteria: ['AC-01'],
        findings: [{ severity: 'high', what: 'x', ruleId: 'R-001' }],
        cheatingDetected: [],
        verifyPassedBefore: true,
      },
      DEFAULTS,
    );
    expect(r.missing).toEqual([]);
  });

  it('존재하지 않는 규칙 id(오탈자)는 거부한다', () => {
    const r = buildRecord(
      'review',
      {
        reviewId: 'rev_1',
        criteria: ['AC-01'],
        findings: [{ severity: 'high', what: 'x', ruleId: 'R-999' }],
        cheatingDetected: [],
        verifyPassedBefore: true,
      },
      DEFAULTS,
    );
    expect(r.record).toBeUndefined();
    expect(r.missing.some((m) => m.includes('R-999'))).toBe(true);
  });

  it('review 저장 시 실재 ruleId 를 가리키는 finding 마다 그 규칙의 hits 가 자동으로 늘어난다', async () => {
    project();
    writeActiveRule('R-001');
    await runRecord('review', {
      json: JSON.stringify({
        reviewId: 'rev_1',
        criteria: ['AC-01'],
        findings: [
          { severity: 'high', what: 'a', ruleId: 'R-001' },
          { severity: 'low', what: 'b', ruleId: 'R-001' },
          { severity: 'low', what: 'c', ruleId: '없음' },
        ],
        cheatingDetected: [],
        verifyPassedBefore: true,
      }),
    });
    const text = fs.readFileSync(path.join(home, 'rules', 'active', 'R-001.md'), 'utf8');
    expect(text).toContain('hits: 2');
  });

  it("ruleId: '없음' 인 finding 은 어떤 규칙의 hits 도 건드리지 않는다", async () => {
    project();
    writeActiveRule('R-001');
    await runRecord('review', {
      json: JSON.stringify({
        reviewId: 'rev_1',
        criteria: ['AC-01'],
        findings: [{ severity: 'low', what: 'x', ruleId: '없음' }],
        cheatingDetected: [],
        verifyPassedBefore: true,
      }),
    });
    const text = fs.readFileSync(path.join(home, 'rules', 'active', 'R-001.md'), 'utf8');
    expect(text).toContain('hits: 0');
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
    const root = process.env.AWL_HOME as string;
    appendRecord(a, root);
    appendRecord(b, root);
    const all = readRecords(root);
    expect(all).toHaveLength(2);
    // 같은 월이면 같은 파일에 append
    expect(monthFile(DEFAULTS.at, root)).toBe(monthFile('2026-07-14T13:00:00.000Z', root));
  });

  it('type/workitem 으로 거른다', () => {
    const root = process.env.AWL_HOME as string;
    appendRecord(
      buildRecord(
        'attempt',
        { what: 'a', why: 'b', how: 'c', result: 'passed', workitem: 'WI-3' },
        DEFAULTS,
      ).record ?? {},
      root,
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
      root,
    );
    expect(readRecords(root, { type: 'blocked' })).toHaveLength(1);
    expect(readRecords(root, { workitem: 'WI-3' })).toHaveLength(1);
  });

  it('months 범위를 주면 그 월 파일만 읽는다(하위호환: 없으면 전량)', () => {
    const root = process.env.AWL_HOME as string;
    // 6월/7월 각각에 기록을 남긴다(월별 파일 분할).
    appendRecord(
      buildRecord(
        'spike',
        { question: '6월', found: 'f' },
        { ...DEFAULTS, id: 'jun', at: '2026-06-15T12:00:00.000Z' },
      ).record ?? {},
      root,
    );
    appendRecord(
      buildRecord(
        'spike',
        { question: '7월', found: 'f' },
        { ...DEFAULTS, id: 'jul', at: '2026-07-15T12:00:00.000Z' },
      ).record ?? {},
      root,
    );
    // 범위 없음 = 전량(하위호환)
    expect(readRecords(root)).toHaveLength(2);
    // 7월만 = 7월 기록만(6월 파일은 읽지 않음 → 6월 기록이 결과에 없다)
    const jul = readRecords(root, { months: ['2026-07'] });
    expect(jul).toHaveLength(1);
    expect(jul[0]?.id).toBe('jul');
    // from/to 범위도 동작
    expect(readRecords(root, { from: '2026-06', to: '2026-06' })).toHaveLength(1);
    expect(readRecords(root, { from: '2026-06', to: '2026-07' })).toHaveLength(2);
  });
});

describe('laneFromRecordFilename — 순수 함수 (WI-G17d)', () => {
  it('접미사가 없으면 null(메인)', () => {
    expect(laneFromRecordFilename('2026-07.jsonl')).toBeNull();
  });

  it('접미사가 있으면 그 이름을 돌려준다', () => {
    expect(laneFromRecordFilename('2026-07.keyboard.jsonl')).toBe('keyboard');
  });

  it('.jsonl 이 아니어도(diffs 등) 크래시 없이 처리한다', () => {
    expect(laneFromRecordFilename('diffs')).toBeNull();
  });
});

describe('readRecords — 레인 접미사 파일에서 읽은 레코드에 lane 필드를 얹는다 (WI-G17d)', () => {
  beforeEach(() => {
    process.env.AWL_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'awl-record-lane-'));
  });

  it('메인 파일(접미사 없음) 레코드에는 lane 필드가 없다', () => {
    const root = process.env.AWL_HOME as string;
    appendRecord(buildRecord('spike', { question: 'q', found: 'f' }, DEFAULTS).record ?? {}, root);
    const [record] = readRecords(root);
    expect(record).not.toHaveProperty('lane');
  });

  it('레인 접미사 파일(records-suffix.json)에서 읽은 레코드에는 lane 필드가 붙는다', () => {
    const root = process.env.AWL_HOME as string;
    fs.mkdirSync(path.join(root, '.awl'), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.awl', 'records-suffix.json'),
      JSON.stringify({ suffix: 'keyboard' }),
    );
    appendRecord(buildRecord('spike', { question: 'q', found: 'f' }, DEFAULTS).record ?? {}, root);
    const [record] = readRecords(root);
    expect(record?.lane).toBe('keyboard');
  });
});

describe('selectMonthFiles — 순수 월파일 선택(전량 로드 제거)', () => {
  const twelve = Array.from(
    { length: 12 },
    (_, i) => `2026-${String(i + 1).padStart(2, '0')}.jsonl`,
  );

  it('months 지정 시 해당 월만, diffs 같은 비-jsonl 은 제외', () => {
    const files = ['2026-06.jsonl', '2026-07.jsonl', 'diffs'];
    expect(selectMonthFiles(files, { months: ['2026-07'] })).toEqual(['2026-07.jsonl']);
    // 범위 없음 = 전량(.jsonl 만)
    expect(selectMonthFiles(files, {})).toEqual(['2026-06.jsonl', '2026-07.jsonl']);
  });

  it('months:[](빈 배열)은 빈 결과 — 전량 폴백이 아님(명시적 빈 필터, AC-04)', () => {
    const files = ['2026-06.jsonl', '2026-07.jsonl'];
    // 빈 배열 = "월로 거르는데 그 집합이 비었다" → 0개(전량 아님)
    expect(selectMonthFiles(files, { months: [] })).toEqual([]);
    // 키 자체가 없으면(undefined) 전량(하위호환) — 빈 배열과 구분
    expect(selectMonthFiles(files, {})).toEqual(files);
  });

  it('from/to 범위(YYYY-MM, 포함)로 거른다', () => {
    expect(selectMonthFiles(twelve, { from: '2026-03', to: '2026-05' })).toEqual([
      '2026-03.jsonl',
      '2026-04.jsonl',
      '2026-05.jsonl',
    ]);
    expect(selectMonthFiles(twelve, { from: '2026-11' })).toEqual([
      '2026-11.jsonl',
      '2026-12.jsonl',
    ]);
  });

  it('성능 가드 — 12개월 중 1개월 질의가 여는 파일 수 < 12(전량)', () => {
    const selected = selectMonthFiles(twelve, { months: ['2026-07'] });
    expect(selected).toHaveLength(1);
    expect(selected.length).toBeLessThan(twelve.length);
    // 전량(무범위)은 12개 모두
    expect(selectMonthFiles(twelve, {})).toHaveLength(12);
  });
});

describe('readRecords 실제 파일 오픈 수 — 통합 성능 가드(AC-03)', () => {
  beforeEach(() => {
    process.env.AWL_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'awl-rrs-'));
  });

  it('1개월 범위 질의는 그 월 파일만 readFileSync 한다(12개월 픽스처)', () => {
    const root = process.env.AWL_HOME as string;
    const dir = path.join(root, '.awl', 'records');
    fs.mkdirSync(dir, { recursive: true });
    // 12개월 픽스처 — 각 월 파일에 그 월의 레코드 1건.
    for (let m = 1; m <= 12; m++) {
      const mm = String(m).padStart(2, '0');
      fs.writeFileSync(
        path.join(dir, `2026-${mm}.jsonl`),
        `${JSON.stringify({ id: `r${mm}`, at: `2026-${mm}-10T00:00:00.000Z`, type: 'spike' })}\n`,
      );
    }
    // fs.readFileSync 를 직접 래핑해 오픈 수를 센다(vi.spyOn 은 esbuild interop 로 불가 → 이중단언 래핑).
    const fsMut = fs as unknown as { readFileSync: (...a: unknown[]) => unknown };
    const origRead = fsMut.readFileSync;
    let reads = 0;
    fsMut.readFileSync = (...args: unknown[]): unknown => {
      reads++;
      return origRead(...args);
    };
    try {
      const jul = readRecords(root, { months: ['2026-07'] });
      expect(jul).toHaveLength(1);
      expect(reads).toBe(1); // 7월 파일만 열었다(나머지 11개월 안 엶)
      reads = 0;
      const all = readRecords(root);
      expect(all).toHaveLength(12);
      expect(reads).toBe(12); // 전량은 12개 모두 연다
    } finally {
      fsMut.readFileSync = origRead;
    }
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

  it('review 기록은 (요약 없음) 대신 reviewId 와 findings 개수를 보여준다 (WI-S AC-06, 리뷰 지적)', () => {
    const records = [
      {
        id: '1',
        at: '2026-07-14T12:00:00Z',
        type: 'review',
        workitem: 'WI-3',
        reviewId: 'rev_abc123',
        criteria: ['AC-01'],
        findings: [{ severity: 'high', what: 'x', evidence: 'y' }],
        cheatingDetected: [],
        verifyPassedBefore: true,
      },
    ];
    const text = renderRecords(records, { unicode: false, color: false, tty: false });
    expect(text).not.toContain('(요약 없음)');
    expect(text).toContain('rev_abc123');
    expect(text).toContain('findings 1건');
  });

  it('reviewId 없는(마이그레이션 이전) review 기록은 기존 target 필드로 요약된다(하위호환)', () => {
    const records = [
      {
        id: '1',
        at: '2026-07-14T12:00:00Z',
        type: 'review',
        target: 'AC-01..AC-03',
        verdict: 'pass',
      },
    ];
    const text = renderRecords(records, { unicode: false, color: false, tty: false });
    expect(text).toContain('AC-01..AC-03');
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
      JSON.stringify({ project: 'p', mainLanguage: 'other', engineVersion: '0.0.0', verify: {} }),
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

  it('알 수 없는 기록 타입 에러가 평문이 아니라 signal(error) 마커를 단다 (cli-visual-consistency AC-02)', async () => {
    project({ workitem: 'WI-X' });
    const { exitSpy, stderrSpy } = mockExit();
    await expect(runRecord('nonsense-type', { json: '{}' })).rejects.toThrow('exit:1');
    const out = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(out).toContain('알 수 없는 기록 타입'); // 메시지 보존
    expect(/(\[x\]|❌)/.test(out)).toBe(true); // signal(error) 마커(유니코드 ❌ / ASCII [x])
    exitSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  it('프로젝트 루트 자체를 못 찾으면(.awl/.git 도 없음) 진짜 원인을 부연해서 알린다 (WI-R 리뷰 지적)', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'awl-record-noroot-')));
    process.chdir(root);
    process.env.AWL_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'awl-record-noroot-home-'));
    const { exitSpy, stderrSpy } = mockExit();

    await expect(runRecord('spike', { json: '{"question":"q","found":"f"}' })).rejects.toThrow(
      'exit:1',
    );
    expect(
      stderrSpy.mock.calls.some((c) => String(c[0]).includes('프로젝트 루트를 찾지 못했습니다')),
    ).toBe(true);

    exitSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  it('--workitem 플래그가 있으면 활성 워크아이템이 없어도 통과한다', async () => {
    const root = project(undefined);
    await runRecord('spike', { json: '{"question":"q","found":"f"}', workitem: 'WI-9' });
    const records = readRecords(root, { workitem: 'WI-9' });
    expect(records).toHaveLength(1);
  });

  it('state.json 에 현재 워크아이템이 있으면 --workitem 없어도 통과한다', async () => {
    const root = project({ workitem: 'WI-9', workitems: {} });
    await runRecord('spike', { json: '{"question":"q","found":"f"}' });
    const records = readRecords(root, { workitem: 'WI-9' });
    expect(records).toHaveLength(1);
  });

  it('refactor 를 CLI 로 기록한다 — 유효 kind 통과, 불량 kind 는 CLI 진입점에서 거부 (loop-refactor-checkpoint AC-04)', async () => {
    const root = project({ workitem: 'WI-9', workitems: {} });
    // 유효 kind → 실제로 기록됨(글루 왕복)
    await runRecord('refactor', { json: '{"what":"헬퍼 추출","kind":"split"}' });
    expect(readRecords(root, { workitem: 'WI-9' }).some((r) => r.type === 'refactor')).toBe(true);
    // 불량 kind → CLI 진입점(runRecord)에서 거부(buildRecord 검증이 exit 로 이어짐)
    const { exitSpy, stderrSpy } = mockExit();
    await expect(runRecord('refactor', { json: '{"what":"x","kind":"없는종류"}' })).rejects.toThrow(
      'exit:1',
    );
    expect(stderrSpy.mock.calls.map((c) => String(c[0])).join('')).toContain('kind');
    exitSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  it('데이터(JSON) 안에 workitem 이 명시되면 활성 워크아이템이 없어도 통과한다(우선순위 유지)', async () => {
    const root = project(undefined);
    await runRecord('spike', {
      json: '{"question":"q","found":"f","workitem":"WI-9"}',
    });
    const records = readRecords(root, { workitem: 'WI-9' });
    expect(records).toHaveLength(1);
  });

  it('전역 config(~/.awl/config.json) 가 없으면 author 없이 정상 기록된다(진행을 막지 않는다, ADK stage 1)', async () => {
    const root = project({ workitem: 'WI-9', workitems: {} });
    await runRecord('spike', { json: '{"question":"q","found":"f"}' });
    const records = readRecords(root, { workitem: 'WI-9' });
    expect(records).toHaveLength(1);
    expect(records[0]?.author).toBeUndefined();
  });

  it('전역 config 에 author 가 있으면 기록에 반영된다(ADK stage 1)', async () => {
    const root = project({ workitem: 'WI-9', workitems: {} });
    fs.writeFileSync(
      path.join(process.env.AWL_HOME as string, 'config.json'),
      JSON.stringify({ author: 'hong@midasit.com' }),
    );
    await runRecord('spike', { json: '{"question":"q","found":"f"}' });
    const records = readRecords(root, { workitem: 'WI-9' });
    expect(records[0]?.author).toBe('hong@midasit.com');
  });

  // --- ADK stage 2b: gate 2/3(layer:'ticket') 가 티켓 파일의 status 를 전이시킨다 ---

  function writeTicketFixture(root: string, id: string, status = 'pending'): string {
    const dir = path.join(root, 'docs', 'tickets');
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, `20260101-000000-${id}.md`);
    fs.writeFileSync(
      filePath,
      `---\nid: ${id}\nspec: spec-1\nconditions: [condition-1]\ndependencies: []\nstatus: ${status}\n---\n## Verification\n`,
    );
    return filePath;
  }

  function readTicketStatus(filePath: string): string | undefined {
    return fs.readFileSync(filePath, 'utf8').match(/^status: (.+)$/m)?.[1];
  }

  it('gate:2 layer:ticket approved 를 기록하면 그 티켓의 status 가 implementing 이 된다', async () => {
    const root = project({ workitem: 'WI-9', workitems: {} });
    const ticketPath = writeTicketFixture(root, 'ticket-1');

    await runRecord('gate', {
      json: '{"gate":2,"layer":"ticket","ticket":"ticket-1","decision":"approved","presentedCriteria":["AC-01"]}',
    });

    expect(readTicketStatus(ticketPath)).toBe('implementing');
  });

  it('profile.local.json 이 스킬을 바꾼 상태에서 게이트를 기록하면 localSkills 가 자동으로 실린다(WI-G16)', async () => {
    const root = project({ workitem: 'WI-9', workitems: {} });
    writeTicketFixture(root, 'ticket-1');
    fs.writeFileSync(
      path.join(root, '.awl', 'profile.json'),
      JSON.stringify({
        name: 'p',
        skills: {
          spec: null,
          investigation: null,
          clarification: null,
          spike: null,
          implement: null,
          review: null,
        },
      }),
    );
    fs.writeFileSync(
      path.join(root, '.awl', 'profile.local.json'),
      JSON.stringify({ skills: { review: { type: 'custom', path: 'my-review.md' } } }),
    );

    await runRecord('gate', {
      json: '{"gate":2,"layer":"ticket","ticket":"ticket-1","decision":"approved","presentedCriteria":["AC-01"]}',
    });

    const [record] = readRecords(root, { type: 'gate' });
    expect(record?.localSkills).toEqual(['review']);
  });

  it('profile.local.json 이 없으면 게이트 기록에 localSkills 필드 자체가 없다(D-21, 안 쓰는 필드를 안 만든다)', async () => {
    const root = project({ workitem: 'WI-9', workitems: {} });
    writeTicketFixture(root, 'ticket-1');

    await runRecord('gate', {
      json: '{"gate":2,"layer":"ticket","ticket":"ticket-1","decision":"approved","presentedCriteria":["AC-01"]}',
    });

    const [record] = readRecords(root, { type: 'gate' });
    expect(record).not.toHaveProperty('localSkills');
  });

  it('ticket 을 줬는데 layer 가 없는 게이트 2 는 거부한다 — 뜻이 정반대라 추측하면 안 된다', async () => {
    const root = project({ workitem: 'WI-9', workitems: {} });
    writeTicketFixture(root, 'ticket-1');
    const { exitSpy, stderrSpy } = mockExit();

    await expect(
      runRecord('gate', {
        json: '{"gate":2,"ticket":"ticket-1","decision":"approved","presentedCriteria":["AC-01"]}',
      }),
    ).rejects.toThrow('exit:1');
    expect(stderrSpy.mock.calls.some((c) => String(c[0]).includes('layer'))).toBe(true);
    // 아무것도 안 남아야 한다 — 반쯤 기록된 게이트는 나중에 못 읽는다.
    expect(readRecords(root, { type: 'gate' })).toEqual([]);

    exitSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  it('layer:ticket 을 명시하면 같은 기록이 통과한다 (ADK 게이트 2 = 티켓 착수)', async () => {
    const root = project({ workitem: 'WI-9', workitems: {} });
    writeTicketFixture(root, 'ticket-1');

    await runRecord('gate', {
      json: '{"gate":2,"layer":"ticket","ticket":"ticket-1","decision":"approved","presentedCriteria":["AC-01"]}',
    });

    const [record] = readRecords(root, { type: 'gate' });
    expect(record?.layer).toBe('ticket');
  });

  it('ticket 없는 레거시 게이트 2 는 그대로 통과한다 (awl-loop 하위호환)', async () => {
    const root = project({ workitem: 'WI-9', workitems: {} });

    await runRecord('gate', {
      json: '{"gate":2,"decision":"approved","presentedCriteria":["AC-01"]}',
    });

    const [record] = readRecords(root, { type: 'gate' });
    expect(record?.gate).toBe(2);
    expect(record).not.toHaveProperty('layer');
  });

  it('게이트 기록에 그 순간의 loopMode 가 각인된다 (ADK stage 2 "모드", prototype.md:360)', async () => {
    const root = project({ workitem: 'WI-9', workitems: {}, loopMode: 'auto' });
    writeTicketFixture(root, 'ticket-1');

    await runRecord('gate', {
      json: '{"gate":2,"layer":"ticket","ticket":"ticket-1","decision":"approved","presentedCriteria":["AC-01"]}',
    });

    const [record] = readRecords(root, { type: 'gate' });
    expect(record?.loopMode).toBe('auto');
  });

  it('loopMode 필드가 없어도 기본값 semi-auto 가 각인된다 — auto:true 만으로는 semi-auto/auto 를 못 가른다', async () => {
    const root = project({ workitem: 'WI-9', workitems: {} });
    writeTicketFixture(root, 'ticket-1');

    await runRecord('gate', {
      json: '{"gate":2,"layer":"ticket","ticket":"ticket-1","decision":"approved","presentedCriteria":["AC-01"]}',
    });

    const [record] = readRecords(root, { type: 'gate' });
    expect(record?.loopMode).toBe('semi-auto');
  });

  it('세션 중 모드가 바뀌면 "어디부터 사람이 안 봤나"가 게이트 기록으로 재구성된다 (reference.md:1370)', async () => {
    const root = project({ workitem: 'WI-9', workitems: {}, loopMode: 'strict' });
    writeTicketFixture(root, 'ticket-1');

    await runRecord('gate', {
      json: '{"gate":2,"layer":"ticket","ticket":"ticket-1","decision":"approved","presentedCriteria":["AC-01"]}',
    });

    // 사람이 세션 중 모드를 올린다(스킬이 awl state set 으로 쓰는 것과 같은 효과).
    const statePath = path.join(root, '.awl', 'state.json');
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    state.loopMode = 'auto';
    fs.writeFileSync(statePath, JSON.stringify(state));

    await runRecord('gate', {
      json: '{"gate":3,"layer":"ticket","ticket":"ticket-1","decision":"approved","presentedCriteria":["AC-01"]}',
    });

    // readRecords 는 최신순이라 뒤집어 시간순으로 본다.
    const modes = readRecords(root, { type: 'gate' })
      .map((r) => [r.gate, r.loopMode])
      .reverse();
    expect(modes).toEqual([
      [2, 'strict'],
      [3, 'auto'],
    ]);
  });

  it('연속으로 여러 번 전이해도 본문이 안 자라난다(round-trip 안정성, ADK stage 3 e2e 검증이 발견)', async () => {
    const root = project({ workitem: 'WI-9', workitems: {} });
    const ticketPath = writeTicketFixture(root, 'ticket-1');
    const before = fs.readFileSync(ticketPath, 'utf8').split('\n\n').length; // 빈 줄 개수의 대용

    await runRecord('gate', {
      json: '{"gate":2,"layer":"ticket","ticket":"ticket-1","decision":"approved","presentedCriteria":["AC-01"]}',
    });
    await runRecord('gate', {
      json: '{"gate":3,"layer":"ticket","ticket":"ticket-1","decision":"more-work","presentedCriteria":["AC-01"]}',
    });
    await runRecord('gate', {
      json: '{"gate":2,"layer":"ticket","ticket":"ticket-1","decision":"approved","presentedCriteria":["AC-01"]}',
    });

    const after = fs.readFileSync(ticketPath, 'utf8').split('\n\n').length;
    expect(after).toBe(before); // 세 번 다시 써도 빈 줄이 안 늘어난다
  });

  it('gate:3 layer:ticket approved 를 기록하면 그 티켓의 status 가 done 이 된다', async () => {
    const root = project({ workitem: 'WI-9', workitems: {} });
    const ticketPath = writeTicketFixture(root, 'ticket-1', 'implementing');

    await runRecord('gate', {
      json: '{"gate":3,"layer":"ticket","ticket":"ticket-1","decision":"approved","presentedCriteria":["AC-01"]}',
    });

    expect(readTicketStatus(ticketPath)).toBe('done');
  });

  it('gate:2/3 layer:ticket abandoned 를 기록하면 그 티켓의 status 가 blocked 가 된다', async () => {
    const root = project({ workitem: 'WI-9', workitems: {} });
    const ticketPath = writeTicketFixture(root, 'ticket-1');

    await runRecord('gate', {
      json: '{"gate":2,"layer":"ticket","ticket":"ticket-1","decision":"abandoned","presentedCriteria":["AC-01"]}',
    });

    expect(readTicketStatus(ticketPath)).toBe('blocked');
  });

  it('존재하지 않는 ticket id 를 가리키면 기록 자체가 거부되고 파일도 안 바뀐다', async () => {
    const root = project({ workitem: 'WI-9', workitems: {} });
    const ticketPath = writeTicketFixture(root, 'ticket-1');
    const { exitSpy, stderrSpy } = mockExit();

    await expect(
      runRecord('gate', {
        json: '{"gate":2,"layer":"ticket","ticket":"no-such-ticket","decision":"approved","presentedCriteria":["AC-01"]}',
      }),
    ).rejects.toThrow('exit:1');
    expect(stderrSpy.mock.calls.some((c) => String(c[0]).includes('티켓을 찾을 수 없습니다'))).toBe(
      true,
    );
    expect(readTicketStatus(ticketPath)).toBe('pending'); // 손대지 않음

    exitSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  it('레거시 gate 1/2(layer 없음)는 티켓 파일을 전혀 안 건드린다(회귀 없음)', async () => {
    const root = project({ workitem: 'WI-9', workitems: {} });
    const ticketPath = writeTicketFixture(root, 'ticket-1');

    await runRecord('gate', {
      json: '{"gate":1,"decision":"approved","presentedCriteria":["AC-01"]}',
    });
    await runRecord('gate', {
      json: '{"gate":2,"decision":"approved","presentedCriteria":["AC-01"]}',
    });

    expect(readTicketStatus(ticketPath)).toBe('pending');
  });

  it('gate 4(request 레이어)는 티켓 파일을 안 건드린다', async () => {
    const root = project({ workitem: 'WI-9', workitems: {} });
    const ticketPath = writeTicketFixture(root, 'ticket-1');
    writeSpecFixture(root, 'spec-1');

    await runRecord('gate', {
      json: '{"gate":4,"layer":"request","spec":"spec-1","decision":"merge","presentedCriteria":["AC-01"]}',
    });

    expect(readTicketStatus(ticketPath)).toBe('pending');
  });

  // --- ADK stage 3: gate 1/4(layer:'request') 가 스펙 파일의 status 를 전이시킨다 ---

  function writeSpecFixture(root: string, id: string, status = 'draft'): string {
    const dir = path.join(root, 'docs', 'specs');
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, `20260101-000000-${id}.md`);
    fs.writeFileSync(
      filePath,
      `---\nid: ${id}\nrevision: ''\norganization: acme\nproject: p\ntitle: t\nstatus: ${status}\ndomain: ''\nterms: []\nverification: [binary]\ntickets: []\ndecisions: []\n---\n## Request\n`,
    );
    return filePath;
  }

  function readSpecStatus(filePath: string): string | undefined {
    return fs.readFileSync(filePath, 'utf8').match(/^status: (.+)$/m)?.[1];
  }

  function readSpecRevision(filePath: string): string | undefined {
    return fs.readFileSync(filePath, 'utf8').match(/^revision: (.*)$/m)?.[1];
  }

  it('gate:1 layer:request approved 를 기록하면 그 스펙의 status 가 active 가 된다', async () => {
    const root = project({ workitem: 'WI-9', workitems: {} });
    const specPath = writeSpecFixture(root, 'spec-1');

    await runRecord('gate', {
      json: '{"gate":1,"layer":"request","spec":"spec-1","decision":"approved","presentedCriteria":["AC-01"]}',
    });

    expect(readSpecStatus(specPath)).toBe('active');
  });

  it('게이트 전이(저장) 때마다 revision 이 본문 sha256 으로 채워진다(ADK stage 1, WI-G3)', async () => {
    const root = project({ workitem: 'WI-9', workitems: {} });
    const specPath = writeSpecFixture(root, 'spec-1'); // 픽스처는 revision: '' 로 시작한다

    await runRecord('gate', {
      json: '{"gate":1,"layer":"request","spec":"spec-1","decision":"approved","presentedCriteria":["AC-01"]}',
    });

    const revision = readSpecRevision(specPath);
    expect(revision).toBeDefined();
    expect(revision).not.toBe("''");
    expect(revision).toMatch(/^[0-9a-f]{64}$/); // sha256 hex

    // 저장된 body(프론트매터 제외)로 직접 재계산 — writeSpecStatus 가 쓰는 것과 같은
    // parseFrontmatter 를 써서 body 추출 방식이 정확히 일치하게 한다.
    const reparsed = parseFrontmatter(fs.readFileSync(specPath, 'utf8'));
    const expected = crypto
      .createHash('sha256')
      .update(reparsed?.body ?? '')
      .digest('hex');
    expect(revision).toBe(expected);
  });

  it('gate:1→gate:4 로 두 번 전이해도 본문(frontmatter 제외)이 바이트 단위로 그대로다 — sync 의 revision(본문 sha256, ADK stage 3)이 안정되려면 필수', async () => {
    const root = project({ workitem: 'WI-9', workitems: {} });
    const specPath = writeSpecFixture(root, 'spec-1');
    const bodyBefore = fs.readFileSync(specPath, 'utf8').split(/^---$/m)[2];

    await runRecord('gate', {
      json: '{"gate":1,"layer":"request","spec":"spec-1","decision":"approved","presentedCriteria":["AC-01"]}',
    });
    await runRecord('gate', {
      json: '{"gate":4,"layer":"request","spec":"spec-1","decision":"merge","presentedCriteria":["AC-01"]}',
    });

    const bodyAfter = fs.readFileSync(specPath, 'utf8').split(/^---$/m)[2];
    expect(bodyAfter).toBe(bodyBefore);
  });

  it('gate:4 layer:request merge/judge-only 를 기록하면 그 스펙의 status 가 closed 가 된다', async () => {
    const root = project({ workitem: 'WI-9', workitems: {} });
    for (const decision of ['merge', 'judge-only']) {
      const specPath = writeSpecFixture(root, `spec-${decision}`, 'active');
      await runRecord('gate', {
        json: `{"gate":4,"layer":"request","spec":"spec-${decision}","decision":"${decision}","presentedCriteria":["AC-01"]}`,
      });
      expect(readSpecStatus(specPath)).toBe('closed');
    }
  });

  it('gate:4 layer:request hold 를 기록해도 스펙의 status 는 안 바뀐다(일시정지는 상태가 아니다)', async () => {
    const root = project({ workitem: 'WI-9', workitems: {} });
    const specPath = writeSpecFixture(root, 'spec-1', 'active');

    await runRecord('gate', {
      json: '{"gate":4,"layer":"request","spec":"spec-1","decision":"hold","presentedCriteria":["AC-01"]}',
    });

    expect(readSpecStatus(specPath)).toBe('active');
  });

  describe('게이트4 병합 제안(ADK stage 5, WI-D)', () => {
    function gitInit(root: string, branch: string): void {
      const g = (args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
      g(['init', '-q', '-b', branch]);
      g(['config', 'user.email', 't@t.com']);
      g(['config', 'user.name', 't']);
      fs.writeFileSync(path.join(root, 'f.txt'), 'x\n');
      g(['add', '.']);
      g(['commit', '-q', '-m', 'base']);
    }

    function writeLaneMetaFixture(root: string, baseBranch: string): void {
      fs.writeFileSync(
        path.join(root, '.awl', 'lane-meta.json'),
        JSON.stringify({ baseBranch, port: 3000, createdAt: new Date().toISOString() }),
      );
    }

    it('lane-meta.json 이 있고 decision 이 merge 면 레인 브랜치→기준 브랜치 병합 제안이 출력된다', async () => {
      const root = project({ workitem: 'WI-9', workitems: {} });
      gitInit(root, 'work/probe');
      writeLaneMetaFixture(root, 'feature/editor-rework');
      writeSpecFixture(root, 'spec-1', 'active');
      let stdout = '';
      const spy = vi.spyOn(process.stdout, 'write').mockImplementation((s: unknown) => {
        stdout += String(s);
        return true;
      });
      try {
        await runRecord('gate', {
          json: '{"gate":4,"layer":"request","spec":"spec-1","decision":"merge","presentedCriteria":["AC-01"]}',
        });
      } finally {
        spy.mockRestore();
      }
      expect(stdout).toContain('git merge work/probe → feature/editor-rework');
    });

    it('실행은 안 한다 — 병합 제안 뒤에도 현재 브랜치는 그대로다', async () => {
      const root = project({ workitem: 'WI-9', workitems: {} });
      gitInit(root, 'work/probe');
      writeLaneMetaFixture(root, 'feature/editor-rework');
      writeSpecFixture(root, 'spec-1', 'active');
      vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

      await runRecord('gate', {
        json: '{"gate":4,"layer":"request","spec":"spec-1","decision":"merge","presentedCriteria":["AC-01"]}',
      });

      const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
        cwd: root,
        encoding: 'utf8',
      }).trim();
      expect(branch).toBe('work/probe'); // merge 를 awl 이 실제로 실행했다면 브랜치가 바뀌었을 것.
      vi.restoreAllMocks();
    });

    it('decision 이 judge-only/hold 면 병합 제안이 안 뜬다(merge 일 때만)', async () => {
      const root = project({ workitem: 'WI-9', workitems: {} });
      gitInit(root, 'work/probe');
      writeLaneMetaFixture(root, 'feature/editor-rework');
      for (const decision of ['judge-only', 'hold']) {
        writeSpecFixture(root, `spec-${decision}`, 'active');
        let stdout = '';
        const spy = vi.spyOn(process.stdout, 'write').mockImplementation((s: unknown) => {
          stdout += String(s);
          return true;
        });
        try {
          await runRecord('gate', {
            json: `{"gate":4,"layer":"request","spec":"spec-${decision}","decision":"${decision}","presentedCriteria":["AC-01"]}`,
          });
        } finally {
          spy.mockRestore();
        }
        expect(stdout).not.toContain('병합 제안');
      }
    });

    it('lane-meta.json 이 없으면(레인이 아닌 곳) 조용히 생략된다(크래시 없음)', async () => {
      const root = project({ workitem: 'WI-9', workitems: {} });
      gitInit(root, 'main');
      writeSpecFixture(root, 'spec-1', 'active');
      let stdout = '';
      const spy = vi.spyOn(process.stdout, 'write').mockImplementation((s: unknown) => {
        stdout += String(s);
        return true;
      });
      try {
        await runRecord('gate', {
          json: '{"gate":4,"layer":"request","spec":"spec-1","decision":"merge","presentedCriteria":["AC-01"]}',
        });
      } finally {
        spy.mockRestore();
      }
      expect(stdout).not.toContain('병합 제안');
    });
  });

  it('gate:1 layer:request rejected/split 를 기록하면 그 스펙의 status 가 draft 로 (되)돌아간다', async () => {
    const root = project({ workitem: 'WI-9', workitems: {} });
    for (const decision of ['rejected', 'split']) {
      const specPath = writeSpecFixture(root, `spec-${decision}`, 'active');
      await runRecord('gate', {
        json: `{"gate":1,"layer":"request","spec":"spec-${decision}","decision":"${decision}","presentedCriteria":["AC-01"]}`,
      });
      expect(readSpecStatus(specPath)).toBe('draft');
    }
  });

  it('존재하지 않는 spec id 를 가리키면 기록 자체가 거부되고 파일도 안 바뀐다', async () => {
    const root = project({ workitem: 'WI-9', workitems: {} });
    const specPath = writeSpecFixture(root, 'spec-1');
    const { exitSpy, stderrSpy } = mockExit();

    await expect(
      runRecord('gate', {
        json: '{"gate":1,"layer":"request","spec":"no-such-spec","decision":"approved","presentedCriteria":["AC-01"]}',
      }),
    ).rejects.toThrow('exit:1');
    expect(stderrSpy.mock.calls.some((c) => String(c[0]).includes('스펙을 찾을 수 없습니다'))).toBe(
      true,
    );
    expect(readSpecStatus(specPath)).toBe('draft'); // 손대지 않음

    exitSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  it('레거시 gate 1(layer 없음)는 스펙 파일을 전혀 안 건드린다(회귀 없음)', async () => {
    const root = project({ workitem: 'WI-9', workitems: {} });
    const specPath = writeSpecFixture(root, 'spec-1');

    await runRecord('gate', {
      json: '{"gate":1,"decision":"approved","presentedCriteria":["AC-01"]}',
    });

    expect(readSpecStatus(specPath)).toBe('draft');
  });

  // --- ADK stage 3: 세 지점(스펙 closed·티켓 done·awl-feedback)의 전송 트리거 ---

  function writeGlobalSyncConfig(opts: {
    recordsEndpoint?: string;
    feedbackEndpoint?: string;
  }): void {
    fs.writeFileSync(
      path.join(process.env.AWL_HOME as string, 'config.json'),
      JSON.stringify({
        // records 봉투는 author 가 필수다(WI-G1) — 이 fixture 로 만든 기록은 전부
        // author 있는 정상 케이스를 흉내낸다. author 없는 케이스는 별도 테스트에서 다룬다.
        author: 'tester@example.com',
        sync: {
          records: opts.recordsEndpoint ? { endpoint: opts.recordsEndpoint } : undefined,
          feedback: opts.feedbackEndpoint ? { endpoint: opts.feedbackEndpoint } : undefined,
        },
      }),
    );
  }

  function okFetch() {
    return vi.fn(async () => new Response('{}', { status: 200 })) as unknown as typeof fetch;
  }

  function failFetch() {
    return vi.fn(async () => new Response('nope', { status: 500 })) as unknown as typeof fetch;
  }

  function stubFetch(impl: typeof fetch) {
    const orig = globalThis.fetch;
    globalThis.fetch = impl;
    return () => {
      globalThis.fetch = orig;
    };
  }

  it('스펙이 closed 로 전이되면 /specs 로 전송을 시도한다(endpoint 설정됨)', async () => {
    const root = project({ workitem: 'WI-9', workitems: {} });
    writeSpecFixture(root, 'spec-1', 'active');
    writeGlobalSyncConfig({ recordsEndpoint: 'http://localhost:9999' });
    const fetchImpl = okFetch();
    const restore = stubFetch(fetchImpl);

    await runRecord('gate', {
      json: '{"gate":4,"layer":"request","spec":"spec-1","decision":"merge","presentedCriteria":["AC-01"]}',
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0] as [string];
    expect(url).toBe('http://localhost:9999/specs');
    expect(readSyncCursor().specs?.lastSentId).toBe('spec-1');

    restore();
  });

  it('endpoint 가 없으면 스펙이 closed 돼도 전송 시도 자체가 없고 커서 파일도 안 생긴다(소급 전송 없음의 전제)', async () => {
    const root = project({ workitem: 'WI-9', workitems: {} });
    writeSpecFixture(root, 'spec-1', 'active');
    const fetchImpl = okFetch();
    const restore = stubFetch(fetchImpl);

    await runRecord('gate', {
      json: '{"gate":4,"layer":"request","spec":"spec-1","decision":"merge","presentedCriteria":["AC-01"]}',
    });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(process.env.AWL_HOME as string, 'sync-cursor.json'))).toBe(
      false,
    );

    restore();
  });

  it('전송이 실패해도(HTTP 500) 명령은 그대로 성공하고 커서에 백오프가 기록된다("서버가 죽어도 루프는 돈다")', async () => {
    const root = project({ workitem: 'WI-9', workitems: {} });
    writeSpecFixture(root, 'spec-1', 'active');
    writeGlobalSyncConfig({ recordsEndpoint: 'http://localhost:9999' });
    const restore = stubFetch(failFetch());

    await runRecord('gate', {
      json: '{"gate":4,"layer":"request","spec":"spec-1","decision":"merge","presentedCriteria":["AC-01"]}',
    });

    expect(readSpecStatus(path.join(root, 'docs', 'specs', '20260101-000000-spec-1.md'))).toBe(
      'closed',
    ); // 로컬은 이미 반영됨 — 전송 실패와 무관
    const cursor = readSyncCursor();
    expect(cursor.specs?.backoffIndex).toBe(0);
    expect(cursor.specs?.nextAttemptAt).toBeDefined();

    restore();
  });

  it('이 프로젝트의 records 스트림을 처음 추적하는 트리거는 소급 전송하지 않는다(prototype.md:435)', async () => {
    // 티켓 주도 흐름(ADK stage 2d)에서는 활성 workitem 자체가 티켓 id다 —
    // 그래야 이 티켓에 딸린 기록이 전부 workitem:'ticket-1' 로 태깅된다.
    const root = project({ workitem: 'ticket-1', workitems: {} });
    writeTicketFixture(root, 'ticket-1', 'implementing');
    writeGlobalSyncConfig({ recordsEndpoint: 'http://localhost:9999' });
    // 이 티켓에 속한 작업 기록 하나를 미리 남겨둔다 — endpoint 를 켜기 "전"에 쌓인
    // 이력을 흉내낸다.
    await runRecord('spike', { json: '{"question":"q","found":"f"}' });

    const fetchImpl = okFetch();
    const restore = stubFetch(fetchImpl);

    await runRecord('gate', {
      json: '{"gate":3,"layer":"ticket","ticket":"ticket-1","decision":"approved","presentedCriteria":["AC-01"]}',
    });

    // 이 프로젝트의 records 커서를 이번에 처음 만든다 — 아무것도 안 보내고
    // "지금까지는 이미 다룬 것"으로 시드만 한다(소급 전송 없음).
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(readSyncCursor().records?.p?.lastSentId).toBeDefined();

    restore();

    // 이후 새로 생기는 기록은 다음 트리거부터 정상 전송된다.
    const fetchImpl2 = okFetch();
    const restore2 = stubFetch(fetchImpl2);
    await runRecord('spike', { json: '{"question":"q2","found":"f2"}' });
    await runRecord('gate', {
      json: '{"gate":3,"layer":"ticket","ticket":"ticket-1","decision":"approved","presentedCriteria":["AC-01"]}',
    });
    // spike(q2) 기록 1건 + 방금 남긴 gate:3 기록 1건 = 2건 전송 시도(이번 것만).
    expect((fetchImpl2 as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2);
    const urls = (fetchImpl2 as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(urls.every((u) => u === 'http://localhost:9999/records')).toBe(true);
    restore2();
  });

  it('서버가 다시 살아나면, 이전 티켓 완료 때 실패해 밀린 기록도 다음 트리거에 함께 나간다(prototype.md:438)', async () => {
    const root = project({ workitem: 'ticket-a', workitems: {} });
    writeTicketFixture(root, 'ticket-a', 'implementing');
    writeTicketFixture(root, 'ticket-b', 'implementing');
    writeTicketFixture(root, 'ticket-prime', 'implementing');
    writeGlobalSyncConfig({ recordsEndpoint: 'http://localhost:9999' });

    // records 스트림 커서를 먼저 프라이밍한다(첫 트리거는 소급전송 없이 시드만 하므로,
    // 이 테스트가 검증하려는 "실패 후 재시도"를 보려면 커서가 이미 있어야 한다) — 다른
    // 티켓 하나를 먼저 완료시켜 스트림을 연다.
    const restorePrime = stubFetch(okFetch());
    await runRecord('gate', {
      json: '{"gate":3,"layer":"ticket","ticket":"ticket-prime","decision":"approved","presentedCriteria":["AC-01"]}',
    });
    restorePrime();

    // 티켓 A 완료 — 서버가 죽어있어(500) 전송이 실패한다. 로컬 status 전이는 그대로 된다.
    const restoreFail = stubFetch(failFetch());
    await runRecord('gate', {
      json: '{"gate":3,"layer":"ticket","ticket":"ticket-a","decision":"approved","presentedCriteria":["AC-01"]}',
    });
    restoreFail();
    expect(
      readTicketStatus(path.join(root, 'docs', 'tickets', '20260101-000000-ticket-a.md')),
    ).toBe('done');
    expect(readSyncCursor().records?.p?.backoffIndex).toBe(0); // 실패가 커서에 남았다

    // 백오프 대기 시간(1분)이 실제로 지날 때까지 테스트를 기다릴 수 없으니,
    // "그 시간이 지났다"만 흉내낸다(nextAttemptAt 제거) — 이 테스트가 검증하려는
    // 것은 타이머 정확도가 아니라 "재시도 때 이전 실패분까지 함께 나가는가"다.
    const cursorAfterFailure = readSyncCursor();
    fs.writeFileSync(
      path.join(process.env.AWL_HOME as string, 'sync-cursor.json'),
      JSON.stringify({
        ...cursorAfterFailure,
        records: {
          ...cursorAfterFailure.records,
          p: { ...cursorAfterFailure.records?.p, nextAttemptAt: undefined },
        },
      }),
    );

    // 서버가 살아난다. 다른 워크아이템(ticket-b)로 옮겨 완료시키면, ticket-b 의
    // 기록뿐 아니라 ticket-a 전송 실패로 밀렸던 기록도 이번에 함께 나가야 한다.
    fs.writeFileSync(
      path.join(root, '.awl', 'state.json'),
      JSON.stringify({ workitem: 'ticket-b' }),
    );
    const fetchImpl = okFetch();
    const restoreOk = stubFetch(fetchImpl);
    await runRecord('gate', {
      json: '{"gate":3,"layer":"ticket","ticket":"ticket-b","decision":"approved","presentedCriteria":["AC-01"]}',
    });
    restoreOk();

    // ticket-a 의 gate:3(밀렸던 것) + ticket-b 의 gate:3(방금 것) = 최소 2건.
    expect((fetchImpl as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(readSyncCursor().records?.p?.backoffIndex).toBeUndefined(); // 성공해 백오프가 지워졌다
  });

  it('author 없는 기록은(전역 config 에 author 가 없던 시절에 쓰인 것) 전송하지 않고 건너뛴다(WI-G1)', async () => {
    const root = project({ workitem: 'ticket-x', workitems: {} });
    writeTicketFixture(root, 'ticket-x', 'implementing');
    writeTicketFixture(root, 'ticket-prime2', 'implementing');
    // author 없는 전역 config — records 봉투는 author 가 필수라(prototype.md:394) 이
    // 상태에서 만든 기록은 author 필드 자체가 안 붙는다(단계1 "전역 config 없으면
    // author 없이 진행" 과 동일 경로).
    fs.writeFileSync(
      path.join(process.env.AWL_HOME as string, 'config.json'),
      JSON.stringify({ sync: { records: { endpoint: 'http://localhost:9999' } } }),
    );

    // 스트림을 프라이밍한다(첫 트리거는 시드만 하므로).
    const restorePrime = stubFetch(okFetch());
    await runRecord('gate', {
      json: '{"gate":3,"layer":"ticket","ticket":"ticket-prime2","decision":"approved","presentedCriteria":["AC-01"]}',
    });
    restorePrime();

    // author 없이 spike 기록을 하나 남긴 뒤, ticket-x 를 완료시킨다.
    await runRecord('spike', { json: '{"question":"q","found":"f"}' });
    const fetchImpl = okFetch();
    const restore = stubFetch(fetchImpl);
    await runRecord('gate', {
      json: '{"gate":3,"layer":"ticket","ticket":"ticket-x","decision":"approved","presentedCriteria":["AC-01"]}',
    });
    restore();

    // spike 도 이번 gate:3 기록도 둘 다 author 가 없어 전송 시도 자체가 없다.
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('awl-feedback 은 records 가 아니라 feedback endpoint 로, 발생 즉시 전송된다', async () => {
    project({ workitem: 'WI-9', workitems: {} });
    writeGlobalSyncConfig({ feedbackEndpoint: 'http://localhost:8888/feedback' });
    const fetchImpl = okFetch();
    const restore = stubFetch(fetchImpl);

    await runRecord('awl-feedback', {
      json: '{"area":"cli","severity":"low","what":"x","impact":"y"}',
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0] as [string];
    expect(url).toBe('http://localhost:8888/feedback'); // endpoint 가 이미 전체 경로(prototype.md:105)

    restore();
  });

  it('사람이 직접 남기는 awl-feedback 도 what/impact 의 절대경로가 지워진다(WI-G12)', async () => {
    const root = project({ workitem: 'WI-9', workitems: {} });

    await runRecord('awl-feedback', {
      json: JSON.stringify({
        area: 'cli',
        severity: 'low',
        what: `${root}/src/foo.ts 에서 실패`,
        impact: `${os.homedir()}/.awl/config.json 를 못 읽음`,
      }),
    });

    const [record] = readRecords(root, { type: 'awl-feedback' });
    expect(record?.what).toBe('<project>/src/foo.ts 에서 실패');
    expect(record?.impact).toBe('<home>/.awl/config.json 를 못 읽음');
    expect(record?.what).not.toContain(root);
    expect(record?.impact).not.toContain(os.homedir());
  });
});

describe('runRecord — gate:2 기록 시 리뷰 누락 경고 (WI-S AC-03)', () => {
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

  function project(criteria: Record<string, unknown>[]): string {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'awl-record-gate2-')));
    fs.mkdirSync(path.join(root, '.awl'), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.awl', 'config.json'),
      JSON.stringify({ project: 'p', mainLanguage: 'other', engineVersion: '0.0.0', verify: {} }),
    );
    fs.writeFileSync(
      path.join(root, '.awl', 'state.json'),
      JSON.stringify({ workitem: 'WI-9', workitems: {}, criteria }),
    );
    process.chdir(root);
    process.env.AWL_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'awl-record-gate2-home-'));
    return root;
  }

  const threePassed = [
    { id: 'AC-01', status: 'passed' },
    { id: 'AC-02', status: 'passed' },
    { id: 'AC-03', status: 'passed' },
  ];

  it('완료조건 3개 이상 통과했는데 review 기록이 없으면 경고한다(거부는 아님)', async () => {
    const root = project(threePassed);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    await runRecord('gate', {
      json: '{"gate":2,"decision":"approved","presentedCriteria":["AC-01"]}',
    });

    expect(stderrSpy.mock.calls.some((c) => String(c[0]).includes('리뷰'))).toBe(true);
    expect(readRecords(root, { type: 'gate' })).toHaveLength(1); // 경고만, 기록은 그대로 남는다.

    stderrSpy.mockRestore();
  });

  it('review 기록이 이미 있으면 경고하지 않는다', async () => {
    project(threePassed);
    await runRecord('review', {
      json: '{"reviewId":"rev_1","criteria":["AC-01"],"findings":[],"cheatingDetected":[],"verifyPassedBefore":true}',
    });
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    await runRecord('gate', {
      json: '{"gate":2,"decision":"approved","presentedCriteria":["AC-01"]}',
    });

    expect(stderrSpy.mock.calls.some((c) => String(c[0]).includes('리뷰'))).toBe(false);
    stderrSpy.mockRestore();
  });

  it('완료조건이 3개 미만이면 review 기록이 없어도 경고하지 않는다', async () => {
    project([
      { id: 'AC-01', status: 'passed' },
      { id: 'AC-02', status: 'passed' },
    ]);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    await runRecord('gate', {
      json: '{"gate":2,"decision":"approved","presentedCriteria":["AC-01"]}',
    });

    expect(stderrSpy.mock.calls.some((c) => String(c[0]).includes('리뷰'))).toBe(false);
    stderrSpy.mockRestore();
  });

  it('gate:1 기록에는 이 경고가 적용되지 않는다(게이트2 전용)', async () => {
    project(threePassed);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    await runRecord('gate', {
      json: '{"gate":1,"decision":"approved","presentedCriteria":["AC-01"]}',
    });

    expect(stderrSpy.mock.calls.some((c) => String(c[0]).includes('리뷰'))).toBe(false);
    stderrSpy.mockRestore();
  });
});

describe('runRecord — 게이트 2 "너무 쉬웠나" 안내 (WI-T AC-03)', () => {
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

  function project(criteria: Record<string, unknown>[]): string {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'awl-record-tooeasy-')));
    fs.mkdirSync(path.join(root, '.awl'), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.awl', 'config.json'),
      JSON.stringify({ project: 'p', mainLanguage: 'other', engineVersion: '0.0.0', verify: {} }),
    );
    fs.writeFileSync(
      path.join(root, '.awl', 'state.json'),
      JSON.stringify({ workitem: 'WI-9', workitems: {}, criteria }),
    );
    process.chdir(root);
    process.env.AWL_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'awl-record-tooeasy-home-'));
    return root;
  }

  it('전부 1차 통과(attempts:0)+막힘 0건이면 안내한다', async () => {
    project([
      { id: 'AC-01', status: 'passed', attempts: 0 },
      { id: 'AC-02', status: 'passed', attempts: 0 },
    ]);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    await runRecord('gate', {
      json: '{"gate":2,"decision":"approved","presentedCriteria":["AC-01"]}',
    });

    expect(stderrSpy.mock.calls.some((c) => String(c[0]).includes('충분히 야심찼습니까'))).toBe(
      true,
    );
    stderrSpy.mockRestore();
  });

  it('하나라도 재시도(attempts>0)가 있으면 안내하지 않는다', async () => {
    project([
      { id: 'AC-01', status: 'passed', attempts: 2 },
      { id: 'AC-02', status: 'passed', attempts: 0 },
    ]);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    await runRecord('gate', {
      json: '{"gate":2,"decision":"approved","presentedCriteria":["AC-01"]}',
    });

    expect(stderrSpy.mock.calls.some((c) => String(c[0]).includes('충분히 야심찼습니까'))).toBe(
      false,
    );
    stderrSpy.mockRestore();
  });

  it('막힌 완료조건이 있으면 안내하지 않는다', async () => {
    project([
      { id: 'AC-01', status: 'blocked', attempts: 3 },
      { id: 'AC-02', status: 'passed', attempts: 0 },
    ]);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    await runRecord('gate', {
      json: '{"gate":2,"decision":"more-work","presentedCriteria":["AC-01"]}',
    });

    expect(stderrSpy.mock.calls.some((c) => String(c[0]).includes('충분히 야심찼습니까'))).toBe(
      false,
    );
    stderrSpy.mockRestore();
  });

  it('완료조건이 0개면 안내하지 않는다', async () => {
    project([]);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    await runRecord('gate', {
      json: '{"gate":2,"decision":"approved","presentedCriteria":["AC-01"]}',
    });

    expect(stderrSpy.mock.calls.some((c) => String(c[0]).includes('충분히 야심찼습니까'))).toBe(
      false,
    );
    stderrSpy.mockRestore();
  });

  it('gate:1 에는 이 안내가 적용되지 않는다', async () => {
    project([{ id: 'AC-01', status: 'passed', attempts: 0 }]);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    await runRecord('gate', {
      json: '{"gate":1,"decision":"approved","presentedCriteria":["AC-01"]}',
    });

    expect(stderrSpy.mock.calls.some((c) => String(c[0]).includes('충분히 야심찼습니까'))).toBe(
      false,
    );
    stderrSpy.mockRestore();
  });
});

describe('computeCoverage — 순수 계산 (WI-T AC-02)', () => {
  it('addresses 로 안 다뤄진 audit finding 을 배제 목록으로 계산한다', () => {
    const auditRecords = [
      {
        findings: [
          { id: 'F-01', what: 'a' },
          { id: 'F-02', what: 'b' },
          { id: 'F-03', what: 'c' },
        ],
      },
    ];
    const criteria = [{ id: 'AC-01', addresses: ['F-01'] }, { id: 'AC-02' }];
    const coverage = computeCoverage(auditRecords, criteria);
    expect(coverage.auditFindingIds.sort()).toEqual(['F-01', 'F-02', 'F-03']);
    expect(coverage.addressedIds).toEqual(['F-01']);
    expect(coverage.excludedIds.sort()).toEqual(['F-02', 'F-03']);
  });

  it('전부 addresses 로 다뤄지면 배제 목록이 빈다', () => {
    const auditRecords = [{ findings: [{ id: 'F-01' }, { id: 'F-02' }] }];
    const criteria = [{ id: 'AC-01', addresses: ['F-01', 'F-02'] }];
    expect(computeCoverage(auditRecords, criteria).excludedIds).toEqual([]);
  });

  it('id 없는 finding 항목이 섞여도 죽지 않고 그냥 건너뛴다', () => {
    const auditRecords = [{ findings: ['그냥 문자열', { what: 'id 없음' }, { id: 'F-01' }] }];
    const criteria: Record<string, unknown>[] = [];
    const coverage = computeCoverage(auditRecords, criteria);
    expect(coverage.auditFindingIds).toEqual(['F-01']);
  });

  it('여러 audit 기록에 걸친 finding 을 합친다', () => {
    const auditRecords = [{ findings: [{ id: 'F-01' }] }, { findings: [{ id: 'F-02' }] }];
    const coverage = computeCoverage(auditRecords, []);
    expect(coverage.auditFindingIds.sort()).toEqual(['F-01', 'F-02']);
  });

  it('state.criteria 에 addresses 가 없어도 criteria 레코드에서 보완한다 (WI-T AC-06, 리뷰 지적 high — awl state set 예시가 addresses 를 안 옮겨도 배제로 오판하지 않는다)', () => {
    const auditRecords = [{ findings: [{ id: 'F-01' }] }];
    const criteria = [{ id: 'AC-01' }]; // state set 예시 그대로: addresses 없음
    const criteriaRecords = [{ items: [{ id: 'AC-01', addresses: ['F-01'] }] }]; // awl record criteria 엔 있음
    const coverage = computeCoverage(auditRecords, criteria, criteriaRecords);
    expect(coverage.excludedIds).toEqual([]);
    expect(coverage.addressedIds).toEqual(['F-01']);
  });

  it('state.criteria 에 addresses 가 있으면 criteria 레코드보다 우선한다(최신 상태)', () => {
    const auditRecords = [{ findings: [{ id: 'F-01' }] }];
    const criteria = [{ id: 'AC-01', addresses: [] }]; // state 가 명시적으로 비움(예: 재분류)
    const criteriaRecords = [{ items: [{ id: 'AC-01', addresses: ['F-01'] }] }]; // 레코드는 옛 값
    const coverage = computeCoverage(auditRecords, criteria, criteriaRecords);
    expect(coverage.excludedIds).toEqual(['F-01']); // state 의 빈 배열이 이긴다
  });

  it('criteriaRecords 를 안 넘기면(기본값) 기존과 동일하게 동작한다(하위호환)', () => {
    const auditRecords = [{ findings: [{ id: 'F-01' }] }];
    const criteria = [{ id: 'AC-01' }];
    expect(computeCoverage(auditRecords, criteria).excludedIds).toEqual(['F-01']);
  });
});

describe('runRecord — 게이트 1 배제 목록 강제 (WI-T AC-02, 핵심)', () => {
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

  function project(criteria: Record<string, unknown>[]): string {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'awl-record-gate1-')));
    fs.mkdirSync(path.join(root, '.awl'), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.awl', 'config.json'),
      JSON.stringify({ project: 'p', mainLanguage: 'other', engineVersion: '0.0.0', verify: {} }),
    );
    fs.writeFileSync(
      path.join(root, '.awl', 'state.json'),
      JSON.stringify({ workitem: 'WI-9', workitems: {}, criteria }),
    );
    process.chdir(root);
    process.env.AWL_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'awl-record-gate1-home-'));
    return root;
  }

  function mockExit() {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    return { exitSpy, stderrSpy };
  }

  it('배제가 있는데 presentedExclusions 가 없으면 gate:1 을 거부한다(파일에 안 씀)', async () => {
    const root = project([{ id: 'AC-01', addresses: ['F-01'] }]);
    await runRecord('audit', {
      json: '{"scope":"s","findings":[{"id":"F-01","what":"a"},{"id":"F-02","what":"b"}]}',
    });
    const { exitSpy, stderrSpy } = mockExit();

    await expect(
      runRecord('gate', { json: '{"gate":1,"decision":"approved","presentedCriteria":["AC-01"]}' }),
    ).rejects.toThrow('exit:1');
    expect(stderrSpy.mock.calls.some((c) => String(c[0]).includes('F-02'))).toBe(true);
    expect(readRecords(root, { type: 'gate' })).toHaveLength(0);

    exitSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  it('배제가 있어도 presentedExclusions 가 전부 포함하면 통과한다', async () => {
    const root = project([{ id: 'AC-01', addresses: ['F-01'] }]);
    await runRecord('audit', {
      json: '{"scope":"s","findings":[{"id":"F-01","what":"a"},{"id":"F-02","what":"b"}]}',
    });

    await runRecord('gate', {
      json: '{"gate":1,"decision":"approved","presentedCriteria":["AC-01"],"presentedExclusions":[{"id":"F-02","reason":"별도 워크아이템"}]}',
    });
    expect(readRecords(root, { type: 'gate' })).toHaveLength(1);
  });

  it('presentedExclusions 가 순수 문자열 배열이어도 통과한다 (WI-T AC-07, 리뷰 지적)', async () => {
    const root = project([{ id: 'AC-01', addresses: ['F-01'] }]);
    await runRecord('audit', {
      json: '{"scope":"s","findings":[{"id":"F-01","what":"a"},{"id":"F-02","what":"b"}]}',
    });

    await runRecord('gate', {
      json: '{"gate":1,"decision":"approved","presentedCriteria":["AC-01"],"presentedExclusions":["F-02"]}',
    });
    expect(readRecords(root, { type: 'gate' })).toHaveLength(1);
  });

  it('배제가 여럿인데 presentedExclusions 가 일부만 포함하면 거부한다', async () => {
    const root = project([{ id: 'AC-01', addresses: [] }]);
    await runRecord('audit', {
      json: '{"scope":"s","findings":[{"id":"F-01","what":"a"},{"id":"F-02","what":"b"}]}',
    });
    const { exitSpy, stderrSpy } = mockExit();

    await expect(
      runRecord('gate', {
        json: '{"gate":1,"decision":"approved","presentedCriteria":["AC-01"],"presentedExclusions":[{"id":"F-01"}]}',
      }),
    ).rejects.toThrow('exit:1');
    expect(stderrSpy.mock.calls.some((c) => String(c[0]).includes('F-02'))).toBe(true);

    exitSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  it('배제가 없으면(전부 addresses 로 다뤄짐) presentedExclusions 없이도 통과한다', async () => {
    const root = project([{ id: 'AC-01', addresses: ['F-01'] }]);
    await runRecord('audit', { json: '{"scope":"s","findings":[{"id":"F-01","what":"a"}]}' });

    await runRecord('gate', {
      json: '{"gate":1,"decision":"approved","presentedCriteria":["AC-01"]}',
    });
    expect(readRecords(root, { type: 'gate' })).toHaveLength(1);
  });

  it('audit 기록 자체가 없으면(발견 0건) presentedExclusions 없이도 통과한다', async () => {
    const root = project([{ id: 'AC-01' }]);
    await runRecord('gate', {
      json: '{"gate":1,"decision":"approved","presentedCriteria":["AC-01"]}',
    });
    expect(readRecords(root, { type: 'gate' })).toHaveLength(1);
  });

  it('gate:2 는 이 체크 대상이 아니다(배제가 있어도 거부하지 않는다)', async () => {
    const root = project([{ id: 'AC-01', addresses: [] }]);
    await runRecord('audit', { json: '{"scope":"s","findings":[{"id":"F-01","what":"a"}]}' });

    await runRecord('gate', {
      json: '{"gate":2,"decision":"approved","presentedCriteria":["AC-01"]}',
    });
    expect(readRecords(root, { type: 'gate' })).toHaveLength(1);
  });

  describe('audit findings — where/source 선택 필드 (WI-G20, awl next 의 finding 재사용 기반)', () => {
    it('finding 에 where/source 를 붙여도(새 관례) 그대로 저장된다', async () => {
      const root = project([{ id: 'condition-1' }]);
      await runRecord('audit', {
        json: '{"scope":"s","findings":[{"id":"finding-1","what":"a","where":"src/x.ts:10","source":"investigation"}]}',
      });
      const [r] = readRecords(root, { type: 'audit' });
      const [f] = r?.findings as Record<string, unknown>[];
      expect(f?.where).toBe('src/x.ts:10');
      expect(f?.source).toBe('investigation');
    });

    it('where/source 없이(옛 관례) 와도 그대로 통과한다(하위호환)', async () => {
      const root = project([{ id: 'condition-1' }]);
      await runRecord('audit', {
        json: '{"scope":"s","findings":[{"id":"F-01","what":"a","severity":"high"}]}',
      });
      const [r] = readRecords(root, { type: 'audit' });
      const [f] = r?.findings as Record<string, unknown>[];
      expect(f?.where).toBeUndefined();
      expect(f?.id).toBe('F-01');
    });
  });
});

describe('detailTierFor — 순수 계산 (WI-U AC-01)', () => {
  it('파일 1개 이하 + 줄 10 미만이면 minimal', () => {
    expect(detailTierFor({ files: 1, lines: 9 })).toBe('minimal');
    expect(detailTierFor({ files: 0, lines: 0 })).toBe('minimal');
  });
  it('파일 3개 이상이면 줄 수와 무관하게 detailed', () => {
    expect(detailTierFor({ files: 3, lines: 1 })).toBe('detailed');
  });
  it('줄 50개 이상이면 파일 수와 무관하게 detailed', () => {
    expect(detailTierFor({ files: 1, lines: 50 })).toBe('detailed');
  });
  it('경계 사이(예: 2파일/20줄)는 brief', () => {
    expect(detailTierFor({ files: 2, lines: 20 })).toBe('brief');
  });
  it('파일 1개인데 줄이 정확히 10이면 minimal 이 아니라 brief(경계값)', () => {
    expect(detailTierFor({ files: 1, lines: 10 })).toBe('brief');
  });
});

describe('measureDiffSize — 실제 git 저장소로 측정 (WI-U AC-01)', () => {
  function makeRepo(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'awl-attempt-diff-'));
    const g = (args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
    g(['init', '-q']);
    g(['config', 'user.email', 'x@x.com']);
    g(['config', 'user.name', 'x']);
    g(['config', 'commit.gpgsign', 'false']);
    fs.writeFileSync(path.join(dir, 'base.txt'), 'hello\n');
    g(['add', '.']);
    g(['commit', '-q', '-m', 'base']);
    return dir;
  }

  it('직전 커밋(HEAD)의 파일 수/줄 수를 잰다', async () => {
    const dir = makeRepo();
    fs.writeFileSync(path.join(dir, 'a.txt'), 'line1\nline2\nline3\n');
    execFileSync('git', ['add', '.'], { cwd: dir });
    execFileSync('git', ['commit', '-q', '-m', 'add a'], { cwd: dir });

    const size = await measureDiffSize(dir, ['show', '--numstat', '--format=', 'HEAD']);
    expect(size).toEqual({ files: 1, lines: 3 });
  });

  it('작업트리(미커밋, 추적 중인 파일의 수정)도 잰다', async () => {
    const dir = makeRepo();
    fs.writeFileSync(path.join(dir, 'base.txt'), 'hello\nmore\n');

    const size = await measureDiffSize(dir, ['diff', '--numstat', 'HEAD']);
    expect(size).toEqual({ files: 1, lines: 1 });
  });

  it('git 명령이 실패하면(존재하지 않는 ref) null 을 돌려준다', async () => {
    const dir = makeRepo();
    const size = await measureDiffSize(dir, ['show', '--numstat', '--format=', 'not-a-real-ref']);
    expect(size).toBeNull();
  });
});

describe('runRecord — attempt 기록 상세도를 diff 크기에 맞춘다 (WI-U)', () => {
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

  function project(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'awl-attempt-project-'));
    const g = (args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
    g(['init', '-q']);
    g(['config', 'user.email', 'x@x.com']);
    g(['config', 'user.name', 'x']);
    g(['config', 'commit.gpgsign', 'false']);
    fs.mkdirSync(path.join(dir, '.awl'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, '.awl', 'config.json'),
      JSON.stringify({ project: 'p', mainLanguage: 'other', engineVersion: '0.0.0', verify: {} }),
    );
    fs.writeFileSync(
      path.join(dir, '.awl', 'state.json'),
      JSON.stringify({ workitem: 'WI-9', workitems: {}, criteria: [] }),
    );
    fs.writeFileSync(path.join(dir, 'base.txt'), 'hello\n');
    g(['add', '.']);
    g(['commit', '-q', '-m', 'base']);
    process.chdir(dir);
    process.env.AWL_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'awl-attempt-project-home-'));
    return dir;
  }

  function mockExit() {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    return { exitSpy, stderrSpy };
  }

  it('작은 통과 변경(1파일/한 줄)은 what 만 있어도 통과한다', async () => {
    const dir = project();
    fs.writeFileSync(path.join(dir, 'small.txt'), 'x\n');
    execFileSync('git', ['add', '.'], { cwd: dir });
    execFileSync('git', ['commit', '-q', '-m', 'small change'], { cwd: dir });

    await runRecord('attempt', {
      json: '{"what":"작은 변경","result":"passed","attempt":1}',
    });
    const records = readRecords(dir, { type: 'attempt' });
    expect(records).toHaveLength(1);
    expect(records[0]?.diffTier).toBe('minimal');
  });

  it('큰 통과 변경(50줄 이상)은 alternatives 없이 거부한다', async () => {
    const dir = project();
    const bigContent = Array.from({ length: 60 }, (_, i) => `line ${i}\n`).join('');
    fs.writeFileSync(path.join(dir, 'big.txt'), bigContent);
    execFileSync('git', ['add', '.'], { cwd: dir });
    execFileSync('git', ['commit', '-q', '-m', 'big change'], { cwd: dir });

    const { exitSpy, stderrSpy } = mockExit();
    await expect(
      runRecord('attempt', {
        json: '{"what":"큰 변경","why":"y","how":"h","result":"passed","attempt":1}',
      }),
    ).rejects.toThrow('exit:1');
    expect(stderrSpy.mock.calls.some((c) => String(c[0]).includes('alternatives'))).toBe(true);

    exitSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  it('큰 통과 변경도 alternatives 를 채우면 통과한다', async () => {
    const dir = project();
    const bigContent = Array.from({ length: 60 }, (_, i) => `line ${i}\n`).join('');
    fs.writeFileSync(path.join(dir, 'big2.txt'), bigContent);
    execFileSync('git', ['add', '.'], { cwd: dir });
    execFileSync('git', ['commit', '-q', '-m', 'big change 2'], { cwd: dir });

    await runRecord('attempt', {
      json: '{"what":"큰 변경","why":"y","how":"h","alternatives":["대안 A"],"result":"passed","attempt":1}',
    });
    const records = readRecords(dir, { type: 'attempt' });
    expect(records).toHaveLength(1);
    expect(records[0]?.diffTier).toBe('detailed');
  });

  it('작은 변경이어도 실패(result:failed)면 why/how 를 여전히 요구한다(핵심 — 크기 무관 전체 상세)', async () => {
    project();
    // 작업트리에 아무 변경도 없어도(0/0, minimal 급) failed 는 전체 상세를 요구.
    const { exitSpy, stderrSpy } = mockExit();
    await expect(
      runRecord('attempt', { json: '{"what":"실패한 시도","result":"failed","attempt":1}' }),
    ).rejects.toThrow('exit:1');
    expect(stderrSpy.mock.calls.some((c) => String(c[0]).includes('why'))).toBe(true);

    exitSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  it('실패 시도에 why/how 를 채우면 diffTier 와 무관하게 통과한다', async () => {
    const dir = project();
    await runRecord('attempt', {
      json: '{"what":"실패한 시도","why":"y","how":"h","result":"failed","attempt":1}',
    });
    expect(readRecords(dir, { type: 'attempt' })).toHaveLength(1);
  });

  it('diffTier 를 이미 데이터에 명시하면 재측정하지 않는다(하위호환/오프라인 안전판)', async () => {
    const dir = project();
    await runRecord('attempt', {
      json: '{"what":"수동 지정","diffTier":"minimal","result":"passed","attempt":1}',
    });
    const records = readRecords(dir, { type: 'attempt' });
    expect(records[0]?.diffTier).toBe('minimal');
  });
});

describe('buildRecord — manualVerify/verifyHow 검증 태그 (records-verify-tag AC-01)', () => {
  it('attempt 에 붙이면 보존하고, 없으면 무시한다(하위호환)', () => {
    const tagged = buildRecord(
      'attempt',
      {
        what: 'x',
        result: 'passed',
        diffTier: 'minimal',
        manualVerify: true,
        verifyHow: '편집기 딥링크에서 레이어 패널 확인',
      },
      DEFAULTS,
    );
    expect(tagged.missing).toEqual([]);
    expect(tagged.record?.manualVerify).toBe(true);
    expect(tagged.record?.verifyHow).toBe('편집기 딥링크에서 레이어 패널 확인');

    // 없이 기록해도 유효(선택 필드 — 하위호환).
    const plain = buildRecord(
      'attempt',
      { what: 'x', result: 'passed', diffTier: 'minimal' },
      DEFAULTS,
    );
    expect(plain.missing).toEqual([]);
    expect(plain.record?.manualVerify).toBeUndefined();
    expect(plain.record?.verifyHow).toBeUndefined();
  });
});

describe('defer 레코드 타입 — 보류 큐(skip-gate-defer AC-01)', () => {
  it('severity/what/why 로 defer 기록을 만들고 선택필드를 보존한다', () => {
    const r = buildRecord(
      'defer',
      {
        severity: 'high',
        what: '스펙 이탈 가능',
        why: '되돌리기 어려움',
        recommendation: '보류',
        gate: 2,
      },
      DEFAULTS,
    );
    expect(r.missing).toEqual([]);
    expect(r.record?.type).toBe('defer');
    expect(r.record?.severity).toBe('high');
    expect(r.record?.recommendation).toBe('보류'); // 선택 필드 D-15 spread 보존
    expect(r.record?.gate).toBe(2);
  });

  it('severity/what/why 누락은 거부한다', () => {
    expect(buildRecord('defer', { severity: 'high', what: 'x' }, DEFAULTS).missing).toContain(
      'why',
    );
    expect(buildRecord('defer', { what: 'x', why: 'y' }, DEFAULTS).missing).toContain('severity');
  });

  it('정해진 값 밖 severity 는 거부한다', () => {
    const r = buildRecord('defer', { severity: 'urgent', what: 'x', why: 'y' }, DEFAULTS);
    expect(r.missing.some((m) => m.includes('severity'))).toBe(true);
  });
});

describe('shouldDefer — 보류 임계 술어(skip-gate-defer AC-03)', () => {
  it('기본 임계 high: high 만 defer, medium/low 는 통과', () => {
    expect(shouldDefer('high')).toBe(true);
    expect(shouldDefer('medium')).toBe(false);
    expect(shouldDefer('low')).toBe(false);
  });

  it('임계 medium: high+medium defer, low 통과', () => {
    expect(shouldDefer('high', 'medium')).toBe(true);
    expect(shouldDefer('medium', 'medium')).toBe(true);
    expect(shouldDefer('low', 'medium')).toBe(false);
  });

  it('임계 low: 전부 defer', () => {
    expect(shouldDefer('high', 'low')).toBe(true);
    expect(shouldDefer('medium', 'low')).toBe(true);
    expect(shouldDefer('low', 'low')).toBe(true);
  });

  it('알 수 없는 severity 는 fail-safe 로 defer(사람에게)', () => {
    expect(shouldDefer('urgent')).toBe(true);
    expect(shouldDefer('')).toBe(true);
  });

  it('잘못된 threshold 는 기본 high 로 취급한다', () => {
    expect(shouldDefer('medium', 'garbage')).toBe(false); // high 기본 → medium 통과
    expect(shouldDefer('high', 'garbage')).toBe(true);
  });
});

describe('collectDeferred — defer 큐 수집(skip-gate-defer AC-02)', () => {
  it('defer 만 골라 severity 높은 순으로 정렬한다', () => {
    const recs = [
      { type: 'defer', severity: 'low', what: 'L', why: 'wl', at: '2026-07-16T01:00:00Z' },
      { type: 'attempt', what: 'x' }, // defer 아님 → 제외
      {
        type: 'defer',
        severity: 'high',
        what: 'H',
        why: 'wh',
        recommendation: '보류',
        gate: 2,
        at: '2026-07-16T02:00:00Z',
      },
      { type: 'defer', severity: 'medium', what: 'M', why: 'wm', at: '2026-07-16T03:00:00Z' },
    ];
    const items = collectDeferred(recs);
    expect(items.map((i) => i.severity)).toEqual(['high', 'medium', 'low']);
    expect(items[0]).toMatchObject({ what: 'H', why: 'wh', recommendation: '보류', gate: 2 });
    expect(items[2]?.recommendation).toBeUndefined(); // 선택 필드 없으면 비움
  });

  it('같은 severity 는 최근(at desc) 먼저', () => {
    const recs = [
      { type: 'defer', severity: 'high', what: 'old', why: 'w', at: '2026-07-16T01:00:00Z' },
      { type: 'defer', severity: 'high', what: 'new', why: 'w', at: '2026-07-16T05:00:00Z' },
    ];
    expect(collectDeferred(recs).map((i) => i.what)).toEqual(['new', 'old']);
  });

  it('defer 기록이 없으면 빈 배열', () => {
    expect(collectDeferred([{ type: 'attempt', what: 'x' }])).toEqual([]);
  });
});

describe('collectDeferred — 리뷰 후속(skip-gate-defer AC-04)', () => {
  it('문서화된 선택 필드 addresses 를 요약 투영에 싣는다', () => {
    const items = collectDeferred([
      { type: 'defer', severity: 'high', what: 'H', why: 'w', addresses: ['F-02'], at: 'z' },
    ]);
    expect(items[0]?.addresses).toEqual(['F-02']);
  });

  it('알 수 없는 severity 는 맨 뒤로 정렬된다(방어 분기)', () => {
    const items = collectDeferred([
      { type: 'defer', severity: 'weird', what: 'U', why: 'w', at: '2026-07-16T09:00:00Z' },
      { type: 'defer', severity: 'low', what: 'L', why: 'w', at: '2026-07-16T01:00:00Z' },
    ]);
    expect(items.map((i) => i.what)).toEqual(['L', 'U']); // low 먼저, unknown 뒤
  });
});

describe('renderDeferSummary — 최종 요약 렌더(skip-gate-defer AC-06, 리뷰 후속)', () => {
  it('빈 큐는 안내 메시지 — 보류 큐 헤더(모드명 없음)', () => {
    const out = renderDeferSummary([]);
    expect(out).toContain('비어있습니다');
    // AC-03(모드-중립): 사용자대면 헤더는 메커니즘 표현(보류 큐). 뮤테이션 저항으로 옛 모드명 부재 단언
    expect(out).toContain('보류 큐');
    expect(out).not.toContain('skip-gate');
    expect(out).not.toContain('critical-only');
  });

  it('항목을 [severity] what·왜 중요·권장 라인으로 낸다(recommendation 유무 반영)', () => {
    const out = renderDeferSummary([
      {
        severity: 'high',
        what: '스펙 이탈',
        why: '되돌리기 어려움',
        recommendation: '보류',
        at: 'z',
      },
      { severity: 'low', what: '사소', why: '영향 적음', at: 'z' },
    ]);
    expect(out).toContain('[high] 스펙 이탈');
    expect(out).toContain('왜 중요: 되돌리기 어려움');
    expect(out).toContain('권장(자율 시): 보류'); // recommendation 있으면 라인 존재
    // recommendation 없는 항목엔 권장 라인이 그 항목에 안 붙는다
    const lowIdx = out.indexOf('[low] 사소');
    expect(out.slice(lowIdx)).not.toContain('권장(자율 시)');
    // AC-03(모드-중립): 헤더가 "보류 N건 — …" 로 메커니즘 표현. 옛 모드명(skip-gate) 부재
    expect(out).toMatch(/보류 \d+건/);
    expect(out).not.toContain('skip-gate');
    expect(out).not.toContain('critical-only');
  });
});

describe('runDeferSummary — --json 기계 계약 + workitem 폴백(skip-gate-defer AC-05, 리뷰 후속)', () => {
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
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'awl-defer-cli-')));
    fs.mkdirSync(path.join(root, '.awl'), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.awl', 'config.json'),
      JSON.stringify({ project: 'p', mainLanguage: 'other', engineVersion: '0.0.0', verify: {} }),
    );
    if (state) {
      fs.writeFileSync(path.join(root, '.awl', 'state.json'), JSON.stringify(state));
    }
    process.chdir(root);
    process.env.AWL_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'awl-defer-home-'));
    return root;
  }

  const seedDefer = (
    projectRoot: string,
    workitem: string,
    severity: string,
    what: string,
    at: string,
  ) =>
    appendRecord(
      {
        id: `d-${what}`,
        at,
        type: 'defer',
        workitem,
        severity,
        what,
        why: 'w',
        project: 'p',
      },
      projectRoot,
    );

  function captureStdout(fn: () => void): string {
    let buf = '';
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      buf += String(chunk);
      return true;
    });
    try {
      fn();
    } finally {
      spy.mockRestore();
    }
    return buf;
  }

  it('--json 은 {workitem,count,items} 를 내고 count 정확·items severity 내림차순', () => {
    const root = project(undefined);
    seedDefer(root, 'WI-D', 'low', 'L', '2026-07-16T01:00:00Z');
    seedDefer(root, 'WI-D', 'high', 'H', '2026-07-16T02:00:00Z');
    seedDefer(root, 'WI-OTHER', 'high', 'X', '2026-07-16T03:00:00Z'); // 다른 워크아이템 제외
    const out = captureStdout(() => runDeferSummary({ json: true, workitem: 'WI-D' }));
    const j = JSON.parse(out);
    expect(j.workitem).toBe('WI-D');
    expect(j.count).toBe(2);
    expect(j.items.map((i: { severity: string }) => i.severity)).toEqual(['high', 'low']); // 내림차순
  });

  it('workitem 미지정이면 state.workitem 으로 폴백한다', () => {
    const root = project({ workitem: 'WI-FALL' });
    seedDefer(root, 'WI-FALL', 'high', 'F', '2026-07-16T02:00:00Z');
    const out = captureStdout(() => runDeferSummary({ json: true }));
    const j = JSON.parse(out);
    expect(j.workitem).toBe('WI-FALL'); // state.workitem 폴백
    expect(j.count).toBe(1);
  });
});
