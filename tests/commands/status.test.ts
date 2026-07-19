import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type StatusReport,
  buildStatus,
  checkMissingAcCommits,
  classifyAncestorExit,
  collectPipelineLaneGroups,
  pipelineLanes,
  renderPipelineGroups,
  renderStatus,
  runStatus,
} from '../../src/commands/status.js';
import { visibleWidth } from '../../src/core/tty.js';

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

  it('dependsOn 이 자기 자신을 가리켜도 크래시하지 않는다(영구 블록으로 표시) (AC-04, 리뷰 지적 — 엣지케이스 무테스트)', () => {
    const root = tmpProject({
      phase: 'loop',
      criteria: [{ id: 'AC-01', status: 'pending', dependsOn: ['AC-01'] }],
    });
    process.env.AWL_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'awl-home-'));

    const s = buildStatus(root);
    expect(s.criteria.blockedByDeps).toEqual([{ id: 'AC-01', waitingOn: ['AC-01'] }]);
  });

  it('dependsOn 이 존재하지 않는 ID 를 가리켜도 크래시하지 않는다(영구 블록으로 표시) (AC-04, 리뷰 지적)', () => {
    const root = tmpProject({
      phase: 'loop',
      criteria: [{ id: 'AC-01', status: 'pending', dependsOn: ['AC-99'] }], // AC-99 는 없다
    });
    process.env.AWL_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'awl-home-'));

    const s = buildStatus(root);
    expect(s.criteria.blockedByDeps).toEqual([{ id: 'AC-01', waitingOn: ['AC-99'] }]);
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

  it('블록된 완료조건을 텍스트로 보여준다(대기 중인 선행 ID 포함) (AC-04, 리뷰 지적 — 계산만 테스트하고 출력 텍스트는 안 봤었다)', () => {
    const root = tmpProject({
      phase: 'loop',
      criteria: [
        { id: 'AC-01', status: 'pending' },
        { id: 'AC-02', status: 'pending', dependsOn: ['AC-01'] },
      ],
    });
    process.env.AWL_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'awl-home-'));
    const text = renderStatus(buildStatus(root), { unicode: false, color: false, tty: false });
    expect(text).toContain('AC-02');
    expect(text).toContain('블록됨');
    expect(text).toContain('AC-01'); // 무엇을 기다리는지도 나온다
  });

  it('블록된 완료조건이 없으면 블록됨 줄 자체가 없다(회귀 없음)', () => {
    const root = tmpProject({
      phase: 'loop',
      criteria: [{ id: 'AC-01', status: 'pending' }],
    });
    process.env.AWL_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'awl-home-'));
    const text = renderStatus(buildStatus(root), { unicode: false, color: false, tty: false });
    expect(text).not.toContain('블록됨');
  });

  it('아직 시작 전이면 안내한다', () => {
    const root = tmpProject(undefined);
    process.env.AWL_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'awl-home-'));
    const text = renderStatus(buildStatus(root), { unicode: false, color: false, tty: false });
    expect(text).toContain('아직');
  });
});

describe('게이트 이력 (WI-Q AC-03)', () => {
  it('buildStatus 가 gate:1/gate:2 레코드를 읽어 게이트 상태를 낸다', () => {
    const root = tmpProject({ phase: 'loop', workitem: 'WI-9', criteria: [] });
    tmpHomeWithRecords([
      {
        id: '1',
        at: '2026-07-15T13:44:00Z',
        type: 'gate',
        workitem: 'WI-9',
        gate: 1,
        decision: 'approved',
        presentedCriteria: ['AC-01', 'AC-02', 'AC-03', 'AC-04', 'AC-05'],
        presentedExclusions: ['a', 'b', 'c'],
        auto: false,
      },
      // 다른 워크아이템의 게이트 기록 — 섞이면 안 된다.
      {
        id: '2',
        at: '2026-07-15T12:00:00Z',
        type: 'gate',
        workitem: 'WI-OTHER',
        gate: 1,
        decision: 'approved',
        presentedCriteria: ['x'],
      },
    ]);
    const s = buildStatus(root);
    expect(s.gates).toHaveLength(2);
    const g1 = s.gates.find((g) => g.gate === 1);
    expect(g1?.recorded).toBe(true);
    expect(g1?.decision).toBe('approved');
    expect(g1?.at).toBe('2026-07-15T13:44:00Z');
    expect(g1?.presentedCriteriaCount).toBe(5);
    expect(g1?.presentedExclusionsCount).toBe(3);
    expect(g1?.auto).toBe(false);
    const g2 = s.gates.find((g) => g.gate === 2);
    expect(g2?.recorded).toBe(false);
  });

  it('게이트 decision 을 상태값으로 색코딩한다 — approved=green, rejected=red (cli-visual-consistency AC-04)', () => {
    const mk = (decision: string) => {
      const root = tmpProject({ phase: 'loop', workitem: 'WI-9', criteria: [] });
      tmpHomeWithRecords([
        {
          id: '1',
          at: '2026-07-15T13:44:00Z',
          type: 'gate',
          workitem: 'WI-9',
          gate: 1,
          decision,
          presentedCriteria: ['AC-01'],
        },
      ]);
      return renderStatus(buildStatus(root), { unicode: true, color: true, tty: true });
    };
    expect(mk('approved')).toContain('\x1b[32mapproved'); // green
    expect(mk('rejected')).toContain('\x1b[31mrejected'); // red
  });

  it('같은 게이트 번호로 여러 번 기록되면(재승인 등) 가장 최근 것을 쓴다', () => {
    const root = tmpProject({ phase: 'loop', workitem: 'WI-9', criteria: [] });
    tmpHomeWithRecords([
      {
        id: '1',
        at: '2026-07-15T14:00:00Z',
        type: 'gate',
        workitem: 'WI-9',
        gate: 1,
        decision: 'modified',
        presentedCriteria: ['AC-01'],
      },
      {
        id: '2',
        at: '2026-07-15T13:00:00Z',
        type: 'gate',
        workitem: 'WI-9',
        gate: 1,
        decision: 'approved',
        presentedCriteria: ['AC-01'],
      },
    ]);
    const s = buildStatus(root);
    const g1 = s.gates.find((g) => g.gate === 1);
    expect(g1?.decision).toBe('modified'); // 더 최근(14:00) 것
  });

  it('renderStatus 가 사람용 텍스트로 게이트 이력을 보여준다', () => {
    const root = tmpProject({ phase: 'loop', workitem: 'WI-9', criteria: [] });
    tmpHomeWithRecords([
      {
        id: '1',
        at: '2026-07-15T13:44:00Z',
        type: 'gate',
        workitem: 'WI-9',
        gate: 1,
        decision: 'approved',
        presentedCriteria: ['AC-01', 'AC-02', 'AC-03', 'AC-04', 'AC-05'],
        presentedExclusions: ['a', 'b', 'c'],
      },
    ]);
    const text = renderStatus(buildStatus(root), { unicode: false, color: false, tty: false });
    expect(text).toContain('게이트 1');
    expect(text).toContain('게이트 2');
    expect(text).toContain('대기중'); // 게이트 2는 아직 없음
    expect(text).toContain('5'); // presentedCriteria 개수
    expect(text).toContain('3'); // exclusion 개수
  });
});

// wi8-F3: 캐노니컬 HEAD 검증 ---------------------------------------------------

function makeGitRepo(): { dir: string; g: (args: string[]) => string } {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'awl-status-git-')));
  const g = (args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  g(['init', '-q', '-b', 'main']);
  g(['config', 'user.email', 'x@x.com']);
  g(['config', 'user.name', 'x']);
  g(['config', 'commit.gpgsign', 'false']);
  fs.mkdirSync(path.join(dir, '.awl'), { recursive: true });
  return { dir, g };
}

function writeStateFile(dir: string, state: unknown): void {
  fs.writeFileSync(path.join(dir, '.awl', 'state.json'), JSON.stringify(state));
}

describe('checkMissingAcCommits — 캐노니컬 HEAD 검증 (wi8-F3 AC-02/03 B)', () => {
  it('완료조건 커밋이 HEAD 조상이 아니면(다른 계보) diverged 로 수집한다', async () => {
    const { dir, g } = makeGitRepo();
    fs.writeFileSync(path.join(dir, 'f.txt'), 'base\n');
    g(['add', '-A']);
    g(['commit', '-q', '-m', 'base']);
    const base = g(['rev-parse', 'HEAD']).trim();
    // 계보 A: AC-01 이 여기서 커밋됨.
    fs.writeFileSync(path.join(dir, 'a.txt'), 'A\n');
    g(['add', '-A']);
    g(['commit', '-q', '-m', 'A']);
    const cA = g(['rev-parse', 'HEAD']).trim();
    // 계보 B: base 에서 분기(A 를 포함하지 않음). 지금 HEAD=other.
    g(['checkout', '-q', '-b', 'other', base]);
    fs.writeFileSync(path.join(dir, 'b.txt'), 'B\n');
    g(['add', '-A']);
    g(['commit', '-q', '-m', 'B']);
    // state 는 AC-01 이 cA(A 계보)에서 커밋됐다고 기록 — 열등 계보(other)를 최종 지목한 상황.
    writeStateFile(dir, { criteria: [{ id: 'AC-01', status: 'passed', commit: cA }] });

    const missing = await checkMissingAcCommits(dir);
    expect(missing).toHaveLength(1);
    expect(missing[0]).toMatchObject({ id: 'AC-01', commit: cA, reason: 'diverged' });
  });

  it('완료조건 커밋이 HEAD 조상이면 빈 배열(정상 계보)', async () => {
    const { dir, g } = makeGitRepo();
    fs.writeFileSync(path.join(dir, 'f.txt'), 'base\n');
    g(['add', '-A']);
    g(['commit', '-q', '-m', 'base']);
    fs.writeFileSync(path.join(dir, 'a.txt'), 'A\n');
    g(['add', '-A']);
    g(['commit', '-q', '-m', 'A']);
    const cA = g(['rev-parse', 'HEAD']).trim();
    writeStateFile(dir, { criteria: [{ id: 'AC-01', status: 'passed', commit: cA }] });
    expect(await checkMissingAcCommits(dir)).toEqual([]);
  });

  it('완료조건 커밋 SHA 가 이 클론에 아예 없으면 not-found', async () => {
    const { dir, g } = makeGitRepo();
    fs.writeFileSync(path.join(dir, 'f.txt'), 'base\n');
    g(['add', '-A']);
    g(['commit', '-q', '-m', 'base']);
    writeStateFile(dir, { criteria: [{ id: 'AC-01', status: 'passed', commit: '0'.repeat(40) }] });
    const missing = await checkMissingAcCommits(dir);
    expect(missing).toHaveLength(1);
    expect(missing[0]).toMatchObject({ id: 'AC-01', reason: 'not-found' });
  });

  it('commit 필드 없는 완료조건은 검사하지 않는다(빈 배열)', async () => {
    const { dir, g } = makeGitRepo();
    fs.writeFileSync(path.join(dir, 'f.txt'), 'base\n');
    g(['add', '-A']);
    g(['commit', '-q', '-m', 'base']);
    writeStateFile(dir, { criteria: [{ id: 'AC-01', status: 'passed', baseline: 'x' }] });
    expect(await checkMissingAcCommits(dir)).toEqual([]);
  });

  it('git 저장소가 아니거나 커밋이 없으면 빈 배열(크래시 없음)', async () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'awl-status-nogit-')));
    fs.mkdirSync(path.join(dir, '.awl'), { recursive: true });
    writeStateFile(dir, { criteria: [{ id: 'AC-01', status: 'passed', commit: 'deadbeef' }] });
    expect(await checkMissingAcCommits(dir)).toEqual([]);
  });
});

describe('renderStatus / JSON — missingAcCommits 표시 (wi8-F3 AC-03 C)', () => {
  const plain = { unicode: false, color: false, tty: false };
  function mkReport(over: Partial<StatusReport>): StatusReport {
    return {
      generation: 1,
      phase: 'loop',
      workitem: 'WI',
      criteria: { total: 1, passed: 1, blocked: 0, inProgress: 0, pending: 0, blockedByDeps: [] },
      records: { total: 0, byType: {} },
      lastAttempt: null,
      gates: [
        { gate: 1, recorded: false },
        { gate: 2, recorded: false },
      ],
      ...over,
    };
  }

  it('missingAcCommits 가 있으면 AC id·"HEAD에 없음"·단축 SHA 를 출력한다', () => {
    const report = mkReport({
      missingAcCommits: [{ id: 'AC-01', commit: 'abcdef1234567890', reason: 'diverged' }],
    });
    const text = renderStatus(report, plain);
    expect(text).toContain('AC-01');
    expect(text).toContain('HEAD에 없음');
    expect(text).toContain('abcdef1234'); // 단축 SHA 10자
  });

  it('missingAcCommits 가 없거나 비었으면 그 줄을 출력하지 않는다', () => {
    expect(renderStatus(mkReport({}), plain)).not.toContain('HEAD에 없음');
    expect(renderStatus(mkReport({ missingAcCommits: [] }), plain)).not.toContain('HEAD에 없음');
  });

  it('JSON 왕복 — missingAcCommits 가 직렬화된다', () => {
    const report = mkReport({
      missingAcCommits: [{ id: 'AC-01', commit: 'abcdef1234567890', reason: 'not-found' }],
    });
    const round = JSON.parse(JSON.stringify(report)) as StatusReport;
    expect(round.missingAcCommits).toEqual([
      { id: 'AC-01', commit: 'abcdef1234567890', reason: 'not-found' },
    ]);
  });
});

describe('classifyAncestorExit — 확실한 사실만 (wi8-F3 AC-04, rev_a2bec44c3ee51649ad finding #1)', () => {
  it('0=포함, 1=diverged, 128=not-found 로 분류한다', () => {
    expect(classifyAncestorExit(0)).toBe('present');
    expect(classifyAncestorExit(1)).toBe('diverged');
    expect(classifyAncestorExit(128)).toBe('not-found');
  });

  it('null(타임아웃/시그널)·기타 exit 은 unknown 으로 — not-found 를 지어내지 않는다', () => {
    // 리뷰 지적: 예전엔 null·기타를 전부 not-found 로 떨궈 거짓 사실을 표시했다.
    expect(classifyAncestorExit(null)).toBe('unknown');
    expect(classifyAncestorExit(129)).toBe('unknown');
    expect(classifyAncestorExit(-1)).toBe('unknown');
  });
});

describe('pipelineLanes — .tasks 레인 상태 판정(.taken 단일 마커, pipeline-marker-finalization AC-01)', () => {
  it('스킬이 만드는 .taken 마커로 상태를 매핑한다(파일 내용 안 엶)', () => {
    // 스킬 계약(awl-pipeline-exec SKILL 상태표): claim=plan/<n>.taken.md,
    // 합격=exec/<n>.taken.md + review 무파일, 수정요구=review/<n>.md.
    const lanes = pipelineLanes(
      // plan — claim 은 .taken, 신규는 .md, 에스컬레이션은 .hold
      [
        'freshwi.md',
        'execwi.taken.md',
        'reviewwi.taken.md',
        'donewi.taken.md',
        'fixwi.taken.md',
        'heldwi.hold.md',
      ],
      ['reviewwi.md', 'donewi.taken.md', 'fixwi.taken.md'], // exec — 미검증 핸드오프 .md · 검증함 .taken
      ['fixwi.md'], // review — 미반영 수정요구 .md
    );
    const by = Object.fromEntries(lanes.map((l) => [l.name, l.status]));
    expect(by.freshwi).toBe('pending'); // plan/<n>.md 신규(claim 전)
    expect(by.execwi).toBe('executing'); // plan/<n>.taken.md claim, 핸드오프 전
    expect(by.reviewwi).toBe('reviewing'); // exec/<n>.md 미검증 핸드오프
    expect(by.donewi).toBe('complete'); // exec/<n>.taken.md + review 무 = 무파일 합격
    expect(by.fixwi).toBe('blocked'); // review/<n>.md 미반영 수정요구
    expect(by.heldwi).toBe('blocked'); // plan/<n>.hold.md 에스컬레이션
  });

  it('빈 .tasks 는 빈 레인', () => {
    expect(pipelineLanes([], [], [])).toEqual([]);
  });
});

describe('pipelineLanes — 생산자-소비자 계약 · 뮤테이션-저항(pipeline-marker-finalization AC-02)', () => {
  // 리더 자기가정이 아니라 awl-pipeline-* 스킬이 실제 만드는 마커(.taken)를 seed한다.
  // 리더를 옛 규약(ㅍ/.pass)으로 되돌리면 이 블록은 반드시 fail 한다(status.ts 직접 뮤테이션으로 실증).
  const statusOf = (plan: string[], exec: string[], review: string[]): Record<string, string> =>
    Object.fromEntries(pipelineLanes(plan, exec, review).map((l) => [l.name, l.status]));

  it('옛 마커(ㅍ·.pass)는 특별한 뜻을 잃었다 — executing/complete 로 안 읽힌다', () => {
    // 옛 리더: plan/<n>ㅍ.md=executing, review/<n>.pass.md=complete. 이제 둘 다 폐기.
    const by = statusOf(['legacyㅍ.md'], [], ['gonepass.pass.md']);
    // ㅍ 는 이름의 일부일 뿐(base 가 안 벗김), claim(.taken) 이 아니라 executing 아님.
    expect(by.legacyㅍ).toBe('pending');
    expect(Object.values(by)).not.toContain('executing');
    // review/<n>.pass.md 는 complete 표식이 아니다 — 무파일 합격은 exec/<n>.taken.md 가 근거다.
    expect(Object.values(by)).not.toContain('complete');
  });

  it('스킬 라이프사이클 전이를 순서대로 재현한다(plan.taken→exec.md→exec.taken)', () => {
    // 1) exec claim: plan/<n>.taken.md, 핸드오프 전 → executing
    expect(statusOf(['wi.taken.md'], [], []).wi).toBe('executing');
    // 2) exec 핸드오프: exec/<n>.md(미검증) → reviewing
    expect(statusOf(['wi.taken.md'], ['wi.md'], []).wi).toBe('reviewing');
    // 3) review 검증·합격(무파일 계약): exec/<n>.taken.md + review 무 → complete
    expect(statusOf(['wi.taken.md'], ['wi.taken.md'], []).wi).toBe('complete');
  });

  it('review/<n>.md(미반영)=blocked 대 review/<n>.taken.md(반영)=complete/reviewing 을 가른다', () => {
    // review 수정요구: exec.taken + review/<n>.md → blocked
    expect(statusOf(['wi.taken.md'], ['wi.taken.md'], ['wi.md']).wi).toBe('blocked');
    // exec 반영(.taken 떼 재검증 유발) + review/<n>.taken.md → reviewing(재검증 대기, blocked 아님)
    expect(statusOf(['wi.taken.md'], ['wi.md'], ['wi.taken.md']).wi).toBe('reviewing');
    // 재검증 합격: exec.taken + review/<n>.taken.md(반영본 잔존) → complete(review.md 아님)
    expect(statusOf(['wi.taken.md'], ['wi.taken.md'], ['wi.taken.md']).wi).toBe('complete');
  });
});

describe('runStatus --pipeline 핸들러 (pipeline-status-tracking AC-02, glue 커버)', () => {
  const origCwd = process.cwd();
  afterEach(() => process.chdir(origCwd));

  it('.tasks/{plan,exec,review} 를 읽어 --json 으로 lanes 를 낸다', () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'awl-pipe-')));
    fs.mkdirSync(path.join(root, '.awl'), { recursive: true });
    for (const d of ['plan', 'exec', 'review'])
      fs.mkdirSync(path.join(root, '.tasks', d), { recursive: true });
    fs.writeFileSync(path.join(root, '.tasks', 'plan', 'freshwi.md'), '');
    fs.writeFileSync(path.join(root, '.tasks', 'plan', 'donewi.taken.md'), '');
    fs.writeFileSync(path.join(root, '.tasks', 'exec', 'donewi.taken.md'), ''); // review 무파일 = 합격
    process.chdir(root);
    process.env.AWL_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'awl-pipe-home-'));

    let buf = '';
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => {
      buf += String(c);
      return true;
    });
    try {
      // runStatus 는 async 지만 --pipeline 분기는 동기 렌더 후 return.
      void runStatus({ json: true, pipeline: true });
    } finally {
      spy.mockRestore();
    }
    const j = JSON.parse(buf);
    // 단일 프로젝트(레인 없음)도 메인 트리를 main 그룹으로 롤업한다(AC-02 동형 스키마).
    const main = j.lanes.find((l: { name: string }) => l.name === 'main');
    const by = Object.fromEntries(
      main.workitems.map((w: { name: string; status: string }) => [w.name, w.status]),
    );
    expect(by.donewi).toBe('complete');
    expect(by.freshwi).toBe('pending');
  });
});

// --- pipeline-status-view: 교차 레인 롤업 ---

/** .awl-worktrees/<lane>/.tasks/{plan,exec,review} 에 파일을 심어 레인을 만든다. */
function seedLane(root: string, lane: string, files: Record<'plan' | 'exec' | 'review', string[]>) {
  for (const dir of ['plan', 'exec', 'review'] as const) {
    const p = path.join(root, '.awl-worktrees', lane, '.tasks', dir);
    fs.mkdirSync(p, { recursive: true });
    for (const f of files[dir]) {
      fs.writeFileSync(path.join(p, f), '');
    }
  }
}

describe('collectPipelineLaneGroups — 교차 레인 롤업(pipeline-status-view AC-01)', () => {
  it('레인 2개를 각각 순회해 레인별 workitem 상태를 롤업한다', () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'awl-plv-')));
    // fe: 착수(executing) 하나. be: 완료(complete) 하나.
    seedLane(root, 'fe', { plan: ['login.taken.md'], exec: [], review: [] });
    seedLane(root, 'be', { plan: ['migrate.taken.md'], exec: ['migrate.taken.md'], review: [] });

    const groups = collectPipelineLaneGroups(root);
    // 레인 2개 — 순회가 첫 레인에서 멈추면(break) 이 단언이 깨진다.
    expect(groups.map((g) => g.name)).toEqual(['be', 'fe']); // localeCompare 정렬
    const be = groups.find((g) => g.name === 'be');
    const fe = groups.find((g) => g.name === 'fe');
    // 그룹핑이 레인별로 되지 않고 평탄화되면 workitems 중첩이 깨져 RED.
    expect(be?.workitems).toEqual([{ name: 'migrate', status: 'complete' }]);
    expect(fe?.workitems).toEqual([{ name: 'login', status: 'executing' }]);
  });

  it('.awl-worktrees/ 부재면 빈 배열(폴백 신호, AC-02)', () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'awl-plv-')));
    fs.mkdirSync(path.join(root, '.tasks', 'plan'), { recursive: true });
    fs.writeFileSync(path.join(root, '.tasks', 'plan', 'solo.md'), '');
    // .awl-worktrees/ 가 없으면 단일 .tasks/ 가 있어도 그룹은 비어야 폴백이 걸린다.
    expect(collectPipelineLaneGroups(root)).toEqual([]);
  });

  it('레인 .tasks/ 가 비어있으면 workitems 빈 배열로 담긴다', () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'awl-plv-')));
    seedLane(root, 'empty', { plan: [], exec: [], review: [] });
    const groups = collectPipelineLaneGroups(root);
    expect(groups).toEqual([{ name: 'empty', workitems: [] }]);
  });
});

describe('renderPipelineGroups — 레인 헤더 그룹핑 렌더(pipeline-status-view AC-01)', () => {
  const ASCII = { unicode: false, color: false, tty: false };
  it('레인 헤더 + 각 workitem 배지/라벨을 담는다', () => {
    const out = renderPipelineGroups(
      [
        { name: 'be', workitems: [{ name: 'migrate', status: 'complete' as const }] },
        { name: 'fe', workitems: [{ name: 'login', status: 'executing' as const }] },
      ],
      ASCII,
    );
    expect(out).toContain('be'); // 레인 헤더
    expect(out).toContain('fe');
    expect(out).toContain('[ok]'); // complete 배지
    expect(out).toContain('[>]'); // executing 배지
    expect(out).toContain('migrate');
    expect(out).toContain('complete');
    expect(out).toContain('login');
    // 카드 줄 표시폭 균일(헤더/workitem/빈줄이 모두 박스에 맞물렸다).
    const widths = out.split('\n').map(visibleWidth);
    expect(new Set(widths).size).toBe(1);
  });
  it('workitem 없는 레인은 헤더 + (workitem 없음)', () => {
    const out = renderPipelineGroups([{ name: 'idle', workitems: [] }], ASCII);
    expect(out).toContain('idle');
    expect(out).toContain('workitem 없음');
  });
  it('AC-03: 한글 workitem 이름이어도 status 열이 표시폭 기준으로 정렬된다', () => {
    // 한 그룹에 ASCII 짧은 이름 + 한글 긴 이름. .length(UTF-16)로 폭을 재면 한글 셀이
    // nameWidth 를 넘쳐(한글=표시폭 2) status 라벨이 어긋난다. stringWidth 로 재야 정렬.
    const out = renderPipelineGroups(
      [
        {
          name: 'lane',
          workitems: [
            { name: 'zz', status: 'pending' as const },
            { name: '로그인화면개선', status: 'pending' as const },
          ],
        },
      ],
      ASCII,
    );
    const lines = out.split('\n');
    const asciiLine = lines.find((l) => l.includes('zz') && l.includes('pending'));
    const krLine = lines.find((l) => l.includes('로그인화면개선') && l.includes('pending'));
    expect(asciiLine).toBeDefined();
    expect(krLine).toBeDefined();
    // status 라벨 시작 표시열 = 라벨 앞부분의 visibleWidth. .length 로 재면 한글 셀이 넘쳐
    // 두 값이 어긋난다 — nameWidth 를 .length 로 되돌리면 이 단언이 깨진다(뮤테이션-저항).
    const statusCol = (line: string) => visibleWidth(line.slice(0, line.lastIndexOf('pending')));
    expect(statusCol(krLine as string)).toBe(statusCol(asciiLine as string));
  });
});

describe('runStatus --pipeline 교차 레인(pipeline-status-view AC-02/03)', () => {
  const origCwd = process.cwd();
  afterEach(() => process.chdir(origCwd));

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

  it('AC-03: 레인 있으면 --json 이 lanes[](name·workitems[]) 구조를 낸다', () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'awl-plv-run-')));
    fs.mkdirSync(path.join(root, '.awl'), { recursive: true });
    seedLane(root, 'fe', { plan: ['login.taken.md'], exec: [], review: [] });
    seedLane(root, 'be', { plan: ['migrate.taken.md'], exec: ['migrate.taken.md'], review: [] });
    process.chdir(root);
    process.env.AWL_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'awl-plv-home-'));

    const j = JSON.parse(capture(() => void runStatus({ json: true, pipeline: true })));
    // 교차 레인 구조: lanes[].workitems[]. 평탄 {name,status} 로 새면 workitems 가 없어 RED.
    const by = Object.fromEntries(j.lanes.map((g: { name: string }) => [g.name, g]));
    expect(by.fe.workitems).toEqual([{ name: 'login', status: 'executing' }]);
    expect(by.be.workitems).toEqual([{ name: 'migrate', status: 'complete' }]);
  });

  it('AC-01: 메인 .tasks/ workitem + 빈 레인 1개 → 메인 안 숨김(둘 다 --json·텍스트에)', () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'awl-plv-run-')));
    fs.mkdirSync(path.join(root, '.awl'), { recursive: true });
    // 메인 트리 .tasks/ 에 실작업 workitem 1개.
    fs.mkdirSync(path.join(root, '.tasks', 'plan'), { recursive: true });
    fs.writeFileSync(path.join(root, '.tasks', 'plan', 'alpha.md'), '');
    // 빈 레인 1개(레인 워크트리 .tasks/ 는 gitignore 라 빈 껍데기).
    seedLane(root, 'fe', { plan: [], exec: [], review: [] });
    process.chdir(root);
    process.env.AWL_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'awl-plv-home-'));

    const j = JSON.parse(capture(() => void runStatus({ json: true, pipeline: true })));
    const byName = Object.fromEntries(
      j.lanes.map((g: { name: string; workitems: unknown }) => [g.name, g]),
    );
    // 레인(fe)이 생겨도 메인이 통째 숨으면 안 된다 — main 그룹이 존재하고 실작업을 담는다.
    expect(byName.main.workitems).toEqual([{ name: 'alpha', status: 'pending' }]);
    // 빈 레인도 명확히 표기(workitems 빈 배열).
    expect(byName.fe.workitems).toEqual([]);

    // 텍스트 렌더 글루도 메인·레인 헤더를 둘 다 담는다. workitem 이름(alpha)에 부분문자열
    // 'main'/'fe' 가 없어, 이 단언은 헤더가 실제로 렌더돼야만 통과한다(공허 통과 방지).
    const text = capture(() => void runStatus({ json: false, pipeline: true }));
    expect(text).toContain('main');
    expect(text).toContain('fe');
    expect(text).toContain('alpha');
  });

  it('AC-02: 폴백(레인 없음)·다중(레인 있음) --json 이 동형 {name,workitems[]} 스키마', () => {
    // 폴백: .awl-worktrees/ 없이 메인 .tasks/ 만.
    const fbRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'awl-plv-run-')));
    fs.mkdirSync(path.join(fbRoot, '.awl'), { recursive: true });
    for (const d of ['plan', 'exec', 'review'])
      fs.mkdirSync(path.join(fbRoot, '.tasks', d), { recursive: true });
    fs.writeFileSync(path.join(fbRoot, '.tasks', 'plan', 'freshwi.md'), '');
    process.chdir(fbRoot);
    process.env.AWL_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'awl-plv-home-'));
    const jFallback = JSON.parse(capture(() => void runStatus({ json: true, pipeline: true })));

    // 다중: 레인 있음.
    const mlRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'awl-plv-run-')));
    fs.mkdirSync(path.join(mlRoot, '.awl'), { recursive: true });
    seedLane(mlRoot, 'fe', { plan: ['login.taken.md'], exec: [], review: [] });
    process.chdir(mlRoot);
    process.env.AWL_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'awl-plv-home-'));
    const jMulti = JSON.parse(capture(() => void runStatus({ json: true, pipeline: true })));

    // 두 경우 모두 lanes[] 의 모든 항목이 workitems 배열을 갖는다(동형). 평탄 {name,status}
    // 로 새면 workitems 가 undefined 라 fail — 폴백/다중 스키마가 갈리던 F-02 회귀 가드.
    const homogeneous = (j: { lanes: { workitems?: unknown }[] }) =>
      Array.isArray(j.lanes) &&
      j.lanes.length > 0 &&
      j.lanes.every((l) => Array.isArray(l.workitems));
    expect(homogeneous(jFallback)).toBe(true);
    expect(homogeneous(jMulti)).toBe(true);
    // 폴백은 메인 트리를 단일 main 그룹으로 롤업한다.
    expect(jFallback.lanes).toEqual([
      { name: 'main', workitems: [{ name: 'freshwi', status: 'pending' }] },
    ]);
  });
});

// --- pipeline-archive-cleanup: awl status --pipeline --archive glue(AC-05/06) ---

describe('runStatus --pipeline --archive (pipeline-archive-cleanup AC-05/06)', () => {
  const origCwd = process.cwd();
  afterEach(() => process.chdir(origCwd));

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

  const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;

  function agePast(filePath: string, ageMs: number): void {
    const past = new Date(Date.now() - ageMs);
    fs.utimesSync(filePath, past, past);
  }

  it('--archive 없으면(기존 --pipeline) complete 항목을 보관하지 않는다(회귀 없음, AC-06)', () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'awl-arc-run-')));
    fs.mkdirSync(path.join(root, '.awl'), { recursive: true });
    for (const d of ['plan', 'exec', 'review'])
      fs.mkdirSync(path.join(root, '.tasks', d), { recursive: true });
    fs.writeFileSync(path.join(root, '.tasks', 'plan', 'old.taken.md'), '');
    const execFile = path.join(root, '.tasks', 'exec', 'old.taken.md');
    fs.writeFileSync(execFile, '');
    agePast(execFile, THREE_DAYS_MS + 1000); // 유예 지났지만 --archive 안 줬다.
    process.chdir(root);
    process.env.AWL_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'awl-arc-home-'));

    const j = JSON.parse(capture(() => void runStatus({ json: true, pipeline: true })));
    const main = j.lanes.find((l: { name: string }) => l.name === 'main');
    expect(main.workitems).toEqual([{ name: 'old', status: 'complete' }]);
    expect(j.archived).toBeUndefined();
    expect(fs.existsSync(execFile)).toBe(true); // 파일도 그대로.
  });

  it('--archive 주면 유예 지난 complete 항목을 실제로 옮기고 --json 에 archived 를 낸다', () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'awl-arc-run-')));
    fs.mkdirSync(path.join(root, '.awl'), { recursive: true });
    for (const d of ['plan', 'exec', 'review'])
      fs.mkdirSync(path.join(root, '.tasks', d), { recursive: true });
    // old: 유예(3일) 지남 → 보관 대상. fresh: 완료했지만 유예 안 지남 → 유지.
    fs.writeFileSync(path.join(root, '.tasks', 'plan', 'old.taken.md'), '');
    const oldExec = path.join(root, '.tasks', 'exec', 'old.taken.md');
    fs.writeFileSync(oldExec, '');
    agePast(oldExec, THREE_DAYS_MS + 1000);
    fs.writeFileSync(path.join(root, '.tasks', 'plan', 'fresh.taken.md'), '');
    fs.writeFileSync(path.join(root, '.tasks', 'exec', 'fresh.taken.md'), '');
    // hold: 유예가 지나도 옮기면 안 된다.
    fs.writeFileSync(path.join(root, '.tasks', 'plan', 'stuck.hold.md'), '');
    const holdExec = path.join(root, '.tasks', 'exec', 'stuck.taken.md');
    fs.writeFileSync(holdExec, '');
    agePast(holdExec, THREE_DAYS_MS + 1000);
    process.chdir(root);
    process.env.AWL_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'awl-arc-home-'));

    const j = JSON.parse(
      capture(() => void runStatus({ json: true, pipeline: true, archive: true })),
    );

    // 실제 파일이 옮겨졌다(글루 커버 — 순수함수 아니라 CLI 경로에서 부작용 확인).
    expect(fs.existsSync(path.join(root, '.tasks', 'exec', 'old.taken.md'))).toBe(false);
    expect(fs.existsSync(path.join(root, '.tasks', 'archive', 'old', 'exec', 'old.taken.md'))).toBe(
      true,
    );
    // fresh/hold 는 안 옮겨졌다.
    expect(fs.existsSync(path.join(root, '.tasks', 'exec', 'fresh.taken.md'))).toBe(true);
    expect(fs.existsSync(path.join(root, '.tasks', 'exec', 'stuck.taken.md'))).toBe(true);

    // --json 출력에 archived 요약이 담긴다.
    expect(j.archived.main).toEqual(['old']);

    // 재계산된 lanes 에는 old 가 더는 안 잡히고(활성 스캔에서 제외), fresh/hold(blocked)는 남는다.
    const main = j.lanes.find((l: { name: string }) => l.name === 'main');
    const byName = Object.fromEntries(
      main.workitems.map((w: { name: string; status: string }) => [w.name, w.status]),
    );
    expect(byName.old).toBeUndefined();
    expect(byName.fresh).toBe('complete');
    expect(byName.stuck).toBe('blocked');
  });

  it('AC-06: 활성(비완료) 항목 집계는 보관 전후 회귀 없다', () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'awl-arc-run-')));
    fs.mkdirSync(path.join(root, '.awl'), { recursive: true });
    for (const d of ['plan', 'exec', 'review'])
      fs.mkdirSync(path.join(root, '.tasks', d), { recursive: true });
    // 활성 3개(pending/executing/reviewing) + complete 1개(유예 지남, 보관 대상).
    fs.writeFileSync(path.join(root, '.tasks', 'plan', 'p1.md'), ''); // pending
    fs.writeFileSync(path.join(root, '.tasks', 'plan', 'e1.taken.md'), ''); // executing
    fs.writeFileSync(path.join(root, '.tasks', 'plan', 'r1.taken.md'), '');
    fs.writeFileSync(path.join(root, '.tasks', 'exec', 'r1.md'), ''); // reviewing
    fs.writeFileSync(path.join(root, '.tasks', 'plan', 'done.taken.md'), '');
    const doneExec = path.join(root, '.tasks', 'exec', 'done.taken.md');
    fs.writeFileSync(doneExec, '');
    agePast(doneExec, THREE_DAYS_MS + 1000);
    process.chdir(root);
    process.env.AWL_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'awl-arc-home-'));

    const countActive = (j: {
      lanes: { name: string; workitems: { status: string }[] }[];
    }): number => {
      const main = j.lanes.find((l) => l.name === 'main');
      return (main?.workitems ?? []).filter((w) => w.status !== 'complete').length;
    };

    const before = JSON.parse(capture(() => void runStatus({ json: true, pipeline: true })));
    expect(countActive(before)).toBe(3);

    void runStatus({ json: true, pipeline: true, archive: true }); // 보관 실행(부작용만 필요).
    const after = JSON.parse(
      capture(() => void runStatus({ json: true, pipeline: true, archive: true })),
    );
    expect(countActive(after)).toBe(3); // 활성 카운트 불변 — complete 만 하나 더 사라짐(이미 없음).
  });
});
