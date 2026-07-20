import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Gotcha } from '../../src/commands/evolve.js';
import { runLaneNew, runLaneRemove } from '../../src/commands/lane.js';
import {
  PARENT_MARKER,
  archiveIsolatedRecords,
  mergeGotchaLists,
  mergeIsolatedHome,
  mergeIsolatedLearning,
  mergeIsolatedRecords,
  writeParentMarker,
} from '../../src/commands/learning-merge.js';
import { runWorkDone, runWorkNew } from '../../src/commands/work.js';

// --- 헬퍼 -------------------------------------------------------------------

function g(id: string, lesson: string, extra: Partial<Gotcha> = {}): Gotcha {
  return { id, lesson, count: 1, ...extra };
}

function tmp(prefix: string): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function writeGotchaFile(root: string, gotcha: Gotcha): void {
  const dir = path.join(root, 'gotchas');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${gotcha.id}.json`), `${JSON.stringify(gotcha, null, 2)}\n`);
}

function readGotchaFiles(root: string): Gotcha[] {
  const dir = path.join(root, 'gotchas');
  if (!fs.existsSync(dir)) {
    return [];
  }
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as Gotcha);
}

function writeRuleFile(root: string, id: string, body: string, source: string): void {
  const dir = path.join(root, 'rules', 'active');
  fs.mkdirSync(dir, { recursive: true });
  const text = [
    '---',
    `id: ${id}`,
    'applies: 어떤 상황에서',
    'counter: 반증 조건',
    'violations: 0',
    `source: ${source}`,
    '---',
    '',
    body,
    '',
  ].join('\n');
  fs.writeFileSync(path.join(dir, `${id}.md`), text);
}

// --- 순수 병합 코어 ----------------------------------------------------------

describe('mergeGotchaLists (순수 병합 코어)', () => {
  it('같은 lesson 은 dedup — 추가하지 않고 idMap 이 전역 id 를 가리킨다(멱등 기반)', () => {
    const { added, idMap } = mergeGotchaLists([g('G-001', '같은교훈')], [g('G-007', '같은교훈')]);
    expect(added).toHaveLength(0);
    expect(idMap['G-001']).toBe('G-007');
  });

  it('ID 충돌 시 전역을 덮어쓰지 않고 새 ID 로 재부여한다(F-05 핵심)', () => {
    const { merged, added, idMap } = mergeGotchaLists([g('G-001', '격리X')], [g('G-001', '전역A')]);
    // 재ID: G-001 이 아니라 G-002 로 추가.
    expect(added).toHaveLength(1);
    expect(added[0]?.id).toBe('G-002');
    expect(added[0]?.lesson).toBe('격리X');
    expect(idMap['G-001']).toBe('G-002');
    // 전역 G-001(전역A)는 그대로 보존 — 덮어쓰기 회귀를 잠근다.
    expect(merged.find((x) => x.id === 'G-001')?.lesson).toBe('전역A');
    expect(merged).toHaveLength(2);
  });

  it('relations.target 을 재ID 로 remap 한다(F-06)', () => {
    const from = [
      g('G-001', 'X', { relations: [{ type: 'refines', target: 'G-002' }] }),
      g('G-002', 'Y'),
    ];
    const { added, idMap } = mergeGotchaLists(from, [g('G-001', 'A')]);
    // G-001(X)->G-002, G-002(Y)->G-003.
    expect(idMap).toEqual({ 'G-001': 'G-002', 'G-002': 'G-003' });
    const x = added.find((a) => a.lesson === 'X');
    // 원래 target G-002 는 이제 G-003 을 가리켜야 한다.
    expect(x?.relations?.[0]?.target).toBe('G-003');
  });

  it('sameAs 를 재ID 로 remap 한다(F-06)', () => {
    const from = [g('G-001', 'X', { sameAs: 'G-002' }), g('G-002', 'Y')];
    const { added } = mergeGotchaLists(from, [g('G-001', 'A'), g('G-002', 'B')]);
    const x = added.find((a) => a.lesson === 'X');
    expect(x?.id).toBe('G-003');
    expect(x?.sameAs).toBe('G-004');
  });

  it('멱등 — 병합 결과를 다시 병합하면 아무것도 추가되지 않는다', () => {
    const from = [g('G-001', '격리X')];
    const first = mergeGotchaLists(from, [g('G-001', '전역A')]);
    const second = mergeGotchaLists(from, first.merged);
    expect(second.added).toHaveLength(0);
  });

  it('입력(from)을 변경하지 않는다', () => {
    const from = [g('G-001', 'X', { relations: [{ type: 'refines', target: 'G-009' }] })];
    mergeGotchaLists(from, [g('G-001', 'A')]);
    expect(from[0]?.id).toBe('G-001');
    expect(from[0]?.relations?.[0]?.target).toBe('G-009');
  });

  it('빈/공백 lesson 은 dedup 키로 뭉치지 않고 각각 재부여된다(빈 키 가드)', () => {
    const { added } = mergeGotchaLists([g('G-001', '  '), g('G-002', '')], [g('G-005', '')]);
    expect(added).toHaveLength(2);
  });
});

// --- fs 병합 -----------------------------------------------------------------

describe('mergeIsolatedLearning (fs 병합)', () => {
  it('격리 gotcha 를 전역에 재ID 로 쓰고 전역 기존 gotcha 를 보존한다', () => {
    const home = tmp('awl-iso-');
    const global = tmp('awl-glob-');
    writeGotchaFile(global, g('G-001', '전역A'));
    writeGotchaFile(home, g('G-001', '격리X'));

    const res = mergeIsolatedLearning(home, global);
    expect(res.gotchasAdded).toBe(1);

    const gs = readGotchaFiles(global);
    expect(gs.map((x) => x.lesson).sort()).toEqual(['격리X', '전역A']);
    expect(gs.find((x) => x.id === 'G-001')?.lesson).toBe('전역A');
  });

  it('rule 을 병합하며 source 를 gotcha 재ID 로 remap 한다', () => {
    const home = tmp('awl-iso-');
    const global = tmp('awl-glob-');
    // 전역 G-001(전역A) → 격리 G-001(격리X)는 G-002 로 재ID.
    writeGotchaFile(global, g('G-001', '전역A'));
    writeGotchaFile(home, g('G-001', '격리X'));
    // 전역 규칙 1개(다른 본문), 격리 규칙 1개(source=G-001).
    writeRuleFile(global, 'R-001', '전역규칙본문', 'G-050');
    writeRuleFile(home, 'R-001', '격리규칙본문', 'G-001');

    const res = mergeIsolatedLearning(home, global);
    expect(res.rulesAdded).toBe(1);
    const merged = fs.readFileSync(path.join(global, 'rules', 'active', 'R-002.md'), 'utf8');
    // 재ID(R-002) + source 를 gotcha idMap 으로 remap(G-001 → G-002).
    expect(merged).toContain('id: R-002');
    expect(merged).toContain('source: G-002');
    expect(merged).toContain('격리규칙본문');
    // 전역 R-001 은 그대로.
    expect(fs.readFileSync(path.join(global, 'rules', 'active', 'R-001.md'), 'utf8')).toContain(
      '전역규칙본문',
    );
  });

  it('같은 본문 rule 은 dedup 하고 generation 은 copy-if-absent(둘 다 멱등)', () => {
    const home = tmp('awl-iso-');
    const global = tmp('awl-glob-');
    writeRuleFile(home, 'R-001', '같은규칙', 'G-001');
    writeRuleFile(global, 'R-003', '같은규칙', 'G-050');
    fs.mkdirSync(path.join(home, 'generations', 'proj'), { recursive: true });
    fs.writeFileSync(path.join(home, 'generations', 'proj', 'wi.json'), '{"x":1}\n');

    const res = mergeIsolatedLearning(home, global);
    expect(res.rulesAdded).toBe(0); // 같은 본문 → dedup.
    expect(res.generationsAdded).toBe(1);
    expect(fs.existsSync(path.join(global, 'generations', 'proj', 'wi.json'))).toBe(true);

    // 재실행 멱등: 추가 없음.
    const again = mergeIsolatedLearning(home, global);
    expect(again.rulesAdded).toBe(0);
    expect(again.generationsAdded).toBe(0);
    expect(again.gotchasAdded).toBe(0);
  });

  it('mergeIsolatedLearning 은 records/state 를 안 건드린다 — 그 스코프 밖(records 는 mergeIsolatedHome 이 별도 병합)', () => {
    const home = tmp('awl-iso-');
    const global = tmp('awl-glob-');
    fs.mkdirSync(path.join(home, 'records'), { recursive: true });
    fs.writeFileSync(path.join(home, 'records', 'r.jsonl'), 'ISOLATED-ONLY-RECORD\n');
    writeGotchaFile(home, g('G-001', '격리X'));

    mergeIsolatedLearning(home, global);
    // 학습(gotcha)은 갔지만 records 는 이 함수 스코프 밖이라 전역에 안 생긴다.
    expect(readGotchaFiles(global)).toHaveLength(1);
    expect(fs.existsSync(path.join(global, 'records'))).toBe(false);
  });
});

// --- records 병합/아카이브 ----------------------------------------------------

describe('mergeIsolatedRecords / archiveIsolatedRecords (records 는 gotcha 와 다르게 순수 append 로 병합된다)', () => {
  function writeRecordLine(root: string, file: string, record: Record<string, unknown>): void {
    const dir = path.join(root, 'records');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, file), `${JSON.stringify(record)}\n`);
  }

  function readMonthFile(root: string, month: string): string[] {
    const p = path.join(root, 'records', `${month}.jsonl`);
    if (!fs.existsSync(p)) {
      return [];
    }
    return fs
      .readFileSync(p, 'utf8')
      .split('\n')
      .filter((l) => l.trim() !== '');
  }

  it('records 를 at 필드 기준 월 파일로 전역에 재생한다', () => {
    const home = tmp('awl-iso-');
    const global = tmp('awl-glob-');
    writeRecordLine(home, '2026-07.jsonl', {
      type: 'decision',
      at: '2026-07-15T00:00:00.000Z',
      workitem: 'wi-1',
    });
    writeRecordLine(home, '2026-07.jsonl', {
      type: 'decision',
      at: '2026-08-01T00:00:00.000Z',
      workitem: 'wi-1',
    });

    const res = mergeIsolatedRecords(home, global);
    expect(res.recordsMerged).toBe(2);
    expect(readMonthFile(global, '2026-07')).toHaveLength(1);
    expect(readMonthFile(global, '2026-08')).toHaveLength(1);
  });

  it('전역 기존 records 를 보존하며 append 한다(덮어쓰지 않음)', () => {
    const home = tmp('awl-iso-');
    const global = tmp('awl-glob-');
    writeRecordLine(global, '2026-07.jsonl', {
      type: 'decision',
      at: '2026-07-01T00:00:00.000Z',
      workitem: 'existing',
    });
    writeRecordLine(home, '2026-07.jsonl', {
      type: 'decision',
      at: '2026-07-15T00:00:00.000Z',
      workitem: 'wi-1',
    });

    mergeIsolatedRecords(home, global);
    const lines = readMonthFile(global, '2026-07');
    expect(lines).toHaveLength(2);
    expect(lines.some((l) => l.includes('existing'))).toBe(true);
    expect(lines.some((l) => l.includes('wi-1'))).toBe(true);
  });

  it('at 필드가 없거나 깨진 줄은 건너뛴다', () => {
    const home = tmp('awl-iso-');
    const global = tmp('awl-glob-');
    fs.mkdirSync(path.join(home, 'records'), { recursive: true });
    fs.writeFileSync(
      path.join(home, 'records', 'x.jsonl'),
      ['{"broken":', '{"type":"decision"}', ''].join('\n'),
    );

    const res = mergeIsolatedRecords(home, global);
    expect(res.recordsMerged).toBe(0);
  });

  it('blocked 레코드의 diff 파일도 같이 옮긴다(copy-if-absent)', () => {
    const home = tmp('awl-iso-');
    const global = tmp('awl-glob-');
    writeRecordLine(home, '2026-07.jsonl', {
      type: 'blocked',
      at: '2026-07-15T00:00:00.000Z',
      workitem: 'wi-1',
      diff: 'diffs/2026-07-15-wi-1.patch',
    });
    fs.mkdirSync(path.join(home, 'records', 'diffs'), { recursive: true });
    fs.writeFileSync(
      path.join(home, 'records', 'diffs', '2026-07-15-wi-1.patch'),
      'PATCH-CONTENT\n',
    );

    mergeIsolatedRecords(home, global);
    expect(
      fs.readFileSync(path.join(global, 'records', 'diffs', '2026-07-15-wi-1.patch'), 'utf8'),
    ).toBe('PATCH-CONTENT\n');
  });

  it('records 가 없으면 0건, 아카이브도 안 만든다', () => {
    const home = tmp('awl-iso-');
    const global = tmp('awl-glob-');
    expect(mergeIsolatedRecords(home, global).recordsMerged).toBe(0);
    expect(archiveIsolatedRecords(home, global, { project: 'p', lane: 'l' })).toBeNull();
  });

  it('아카이브는 project/lane 별 스냅샷 파일로 원본 줄을 그대로 남긴다', () => {
    const home = tmp('awl-iso-');
    const global = tmp('awl-glob-');
    writeRecordLine(home, '2026-07.jsonl', {
      type: 'decision',
      at: '2026-07-15T00:00:00.000Z',
      workitem: 'wi-1',
    });

    const dest = archiveIsolatedRecords(home, global, { project: 'myproj', lane: 'mylane' });
    expect(dest).not.toBeNull();
    expect(dest).toContain(path.join('records', 'archive', 'myproj'));
    expect(dest).toContain('mylane');
    expect(fs.readFileSync(dest as string, 'utf8')).toContain('wi-1');
  });

  it('같은 project/lane 로 같은 날 두 번 아카이브하면 덮어쓰지 않고 -2 로 비켜 쓴다', () => {
    const home = tmp('awl-iso-');
    const global = tmp('awl-glob-');
    writeRecordLine(home, '2026-07.jsonl', {
      type: 'decision',
      at: '2026-07-15T00:00:00.000Z',
      workitem: 'first',
    });
    const first = archiveIsolatedRecords(home, global, { project: 'p', lane: 'l' });

    // 같은 레인 이름으로 다시 기록이 쌓였다고 가정(레인 재사용 — 같은 날 두 번째 teardown).
    fs.writeFileSync(path.join(home, 'records', '2026-07.jsonl'), '');
    writeRecordLine(home, '2026-07.jsonl', {
      type: 'decision',
      at: '2026-07-15T00:00:00.000Z',
      workitem: 'second',
    });
    const second = archiveIsolatedRecords(home, global, { project: 'p', lane: 'l' });

    expect(first).not.toBe(second);
    expect(fs.readFileSync(first as string, 'utf8')).toContain('first');
    expect(fs.readFileSync(second as string, 'utf8')).toContain('second');
  });
});

// --- 목적지 해석(마커) -------------------------------------------------------

describe('mergeIsolatedHome (부모 전역 마커로 목적지 해석, F-07)', () => {
  const origHome = process.env.AWL_HOME;
  afterEach(() => {
    if (origHome === undefined) {
      delete process.env.AWL_HOME;
    } else {
      process.env.AWL_HOME = origHome;
    }
  });

  const META = { project: 'testproj', lane: 'testlane' };

  it('마커의 부모 전역으로 병합한다 — teardown 시점 AWL_HOME env 가 달라도', () => {
    const home = tmp('awl-iso-');
    const trueGlobal = tmp('awl-true-');
    const envGlobal = tmp('awl-env-');
    fs.writeFileSync(path.join(home, PARENT_MARKER), `${trueGlobal}\n`);
    writeGotchaFile(home, g('G-001', '격리X'));
    // env 는 엉뚱한 곳을 가리켜도 마커가 우선.
    process.env.AWL_HOME = envGlobal;

    const res = mergeIsolatedHome(home, META);
    expect(res?.gotchasAdded).toBe(1);
    expect(readGotchaFiles(trueGlobal)).toHaveLength(1);
    expect(readGotchaFiles(envGlobal)).toHaveLength(0);
  });

  it('마커가 없으면 globalRoot()(AWL_HOME) 로 폴백한다', () => {
    const home = tmp('awl-iso-');
    const envGlobal = tmp('awl-env-');
    writeGotchaFile(home, g('G-001', '격리X'));
    process.env.AWL_HOME = envGlobal;

    const res = mergeIsolatedHome(home, META);
    expect(res?.gotchasAdded).toBe(1);
    expect(readGotchaFiles(envGlobal)).toHaveLength(1);
  });

  it('출발=목적(자기 자신)이면 병합하지 않는다(null)', () => {
    const home = tmp('awl-iso-');
    fs.writeFileSync(path.join(home, PARENT_MARKER), `${home}\n`);
    expect(mergeIsolatedHome(home, META)).toBeNull();
  });

  it('격리 home 이 없으면 null', () => {
    expect(mergeIsolatedHome(path.join(os.tmpdir(), 'awl-does-not-exist-xyz'), META)).toBeNull();
  });

  it('writeParentMarker 는 생성 시점 globalRoot() 를 마커에 남긴다', () => {
    const home = tmp('awl-iso-');
    const global = tmp('awl-glob-');
    process.env.AWL_HOME = global;
    writeParentMarker(home);
    expect(fs.readFileSync(path.join(home, PARENT_MARKER), 'utf8').trim()).toBe(
      path.resolve(global),
    );
  });
});

// --- teardown 통합(실제 git) -------------------------------------------------

describe('teardown 통합 — 격리 학습이 전역으로 이어진다(실제 git)', () => {
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

  function realGitProject(): { proj: string; global: string } {
    const proj = tmp('awl-lm-proj-');
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: proj });
    execFileSync('git', ['config', 'user.email', 't@t.com'], { cwd: proj });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: proj });
    fs.writeFileSync(path.join(proj, 'f.txt'), 'base\n');
    fs.mkdirSync(path.join(proj, '.awl'), { recursive: true });
    execFileSync('git', ['add', '-A'], { cwd: proj });
    execFileSync('git', ['commit', '-q', '-m', 'base'], { cwd: proj });
    process.chdir(proj);
    const global = tmp('awl-lm-home-');
    process.env.AWL_HOME = global;
    return { proj, global };
  }

  function silenceStderr(): () => void {
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    return () => spy.mockRestore();
  }
  function silenceStdout(): () => void {
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    return () => spy.mockRestore();
  }

  it('lane rm: 격리 gotcha 를 전역으로 병합, 전역 기존은 보존, records 는 전역 병합 + 레인 아카이브', async () => {
    const { proj, global } = realGitProject();
    // 전역에 기존 교훈.
    writeGotchaFile(global, g('G-001', '전역기존교훈'));

    const restoreErr = silenceStderr();
    const restoreOut = silenceStdout();
    try {
      await runLaneNew('probe');
    } finally {
      restoreOut();
    }
    const lanePath = path.join(proj, '.awl-worktrees', 'probe');
    const isoHome = path.join(lanePath, '.awl', 'home');
    // 생성 시점 마커가 전역을 가리키는지(글루 확인).
    expect(fs.readFileSync(path.join(isoHome, PARENT_MARKER), 'utf8').trim()).toBe(global);

    // 격리 세션이 gotcha 를 기록한 상황을 재현(같은 G-001 번호, 다른 내용 = 충돌).
    writeGotchaFile(isoHome, g('G-001', '격리레인교훈'));
    // 격리 records 도 하나 남긴다 — teardown 에 전역으로 재생 + 아카이브돼야 한다.
    fs.mkdirSync(path.join(isoHome, 'records'), { recursive: true });
    fs.writeFileSync(
      path.join(isoHome, 'records', '2026-07.jsonl'),
      `${JSON.stringify({ type: 'decision', at: '2026-07-15T00:00:00.000Z', workitem: 'probe-wi' })}\n`,
    );

    await runLaneRemove('probe', {});
    restoreErr();

    expect(fs.existsSync(lanePath)).toBe(false);

    const gs = readGotchaFiles(global);
    expect(gs.some((x) => x.lesson === '전역기존교훈')).toBe(true);
    expect(gs.some((x) => x.lesson === '격리레인교훈')).toBe(true);
    // 전역 G-001 은 덮이지 않았다.
    expect(gs.find((x) => x.id === 'G-001')?.lesson).toBe('전역기존교훈');

    // records 는 전역 월별 jsonl 로 재생된다(gotcha 와 달리 격리 유지가 아니다).
    const globalMonthFile = path.join(global, 'records', '2026-07.jsonl');
    expect(fs.existsSync(globalMonthFile)).toBe(true);
    expect(fs.readFileSync(globalMonthFile, 'utf8')).toContain('probe-wi');

    // 레인 출처 스냅샷이 project(=디렉토리명)/lane(probe) 별로 아카이브된다.
    const archiveDir = path.join(global, 'records', 'archive', path.basename(proj));
    expect(fs.existsSync(archiveDir)).toBe(true);
    const archiveFiles = fs.readdirSync(archiveDir);
    expect(archiveFiles.some((f) => f.endsWith('-probe.jsonl'))).toBe(true);
    const archived = fs.readFileSync(
      path.join(archiveDir, archiveFiles.find((f) => f.endsWith('-probe.jsonl')) as string),
      'utf8',
    );
    expect(archived).toContain('probe-wi');
  });

  it('work done: 워크트리의 .awl/home 학습을 삭제 전 전역으로 병합한다(수동 격리 flow)', async () => {
    // --isolated --worktree 는 state 를 워크트리에 두므로(work.ts stateRoot) work done
    // 이 root state 에서 못 찾는다 — 그 조합의 teardown 은 lane rm 이다. work done 의
    // 병합은 "root state 워크트리 wi 인데 워크트리에 .awl/home 이 있는" 경우에 동작한다:
    // 비isolated --worktree wi 에서 수동으로 AWL_HOME=wt/.awl/home 격리를 쓴 flow.
    const { proj, global } = realGitProject();

    const restoreErr = silenceStderr();
    const restoreOut = silenceStdout();
    try {
      await runWorkNew('WI-WT', undefined, { worktree: true }); // 비isolated: state 는 root.
    } finally {
      restoreOut();
    }
    const wtPath = path.join(proj, '.awl-worktrees', 'WI-WT');
    // 이 워크트리에서 수동 격리(AWL_HOME=wt/.awl/home)를 썼다고 가정: .awl/home + 마커 + gotcha.
    const isoHome = path.join(wtPath, '.awl', 'home');
    fs.mkdirSync(isoHome, { recursive: true });
    fs.writeFileSync(path.join(isoHome, PARENT_MARKER), `${global}\n`);
    writeGotchaFile(isoHome, g('G-001', 'workdone 격리교훈'));

    const restoreOut2 = silenceStdout();
    try {
      await runWorkDone('WI-WT', {});
    } finally {
      restoreOut2();
      restoreErr();
    }

    expect(fs.existsSync(wtPath)).toBe(false);
    expect(readGotchaFiles(global).some((x) => x.lesson === 'workdone 격리교훈')).toBe(true);
  });

  it('work done: 진짜 --isolated(비워크트리) 학습을 root/.awl/home 에서 전역으로 병합한다', async () => {
    // --isolated 만(워크트리 없음): state·홈 모두 root, work done 이 root state 에서 찾는다.
    // root/.awl/home 은 삭제되지 않지만 완료 시 전역으로 학습을 이어야 한다(AC-01 워크아이템).
    const { proj, global } = realGitProject();

    const restoreErr = silenceStderr();
    const restoreOut = silenceStdout();
    try {
      await runWorkNew('WI-ISO-NWT', undefined, { isolated: true });
    } finally {
      restoreOut();
    }
    const isoHome = path.join(proj, '.awl', 'home');
    // 진짜 --isolated 가 root/.awl/home + 부모전역 마커를 만든다(글루 확인).
    expect(fs.readFileSync(path.join(isoHome, PARENT_MARKER), 'utf8').trim()).toBe(global);
    writeGotchaFile(isoHome, g('G-001', 'isolated 비워크트리 교훈'));

    const restoreOut2 = silenceStdout();
    try {
      await runWorkDone('WI-ISO-NWT', {});
    } finally {
      restoreOut2();
      restoreErr();
    }

    expect(readGotchaFiles(global).some((x) => x.lesson === 'isolated 비워크트리 교훈')).toBe(true);
  });
});
