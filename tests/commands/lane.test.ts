import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { collectChecks } from '../../src/commands/doctor.js';
import {
  collectLanes,
  laneRegistryRoot,
  parseWorktreeBranches,
  renderLaneList,
  runLaneList,
  runLaneNew,
  runLaneRemove,
} from '../../src/commands/lane.js';
import { removeWorkitemFromState, summarizeWorkitems } from '../../src/commands/work.js';

describe('parseWorktreeBranches (AC-02, 순수 파서)', () => {
  it('git worktree list --porcelain 을 경로→브랜치 맵으로 파싱하고 refs/heads/ 를 벗긴다', () => {
    const porcelain = [
      'worktree /repo',
      'HEAD abc',
      'branch refs/heads/main',
      '',
      'worktree /repo/.awl-worktrees/probe',
      'HEAD def',
      'branch refs/heads/work/probe',
      '',
    ].join('\n');
    const map = parseWorktreeBranches(porcelain);
    expect(map.get('/repo')).toBe('main');
    expect(map.get('/repo/.awl-worktrees/probe')).toBe('work/probe');
  });

  it('detached HEAD 워크트리(branch 라인 없음)는 맵에 담지 않는다 — 호출부가 부재를 해석한다', () => {
    const porcelain = ['worktree /repo/.awl-worktrees/x', 'HEAD abc', 'detached', ''].join('\n');
    const map = parseWorktreeBranches(porcelain);
    expect(map.has('/repo/.awl-worktrees/x')).toBe(false);
  });
});

describe('renderLaneList (AC-02, 순수 렌더)', () => {
  const CC = { unicode: true, color: false, tty: true };

  it('레인이 없으면 안내 카드를 낸다', () => {
    const out = renderLaneList([], CC);
    expect(out).toContain('레인이 없습니다');
  });

  it('각 레인의 이름·경로·브랜치를 모두 렌더한다(뮤테이션 저항 — 셋 중 하나라도 누락하면 실패)', () => {
    const out = renderLaneList(
      [
        { name: 'alpha', path: '/repo/.awl-worktrees/alpha', branch: 'work/alpha' },
        { name: 'beta', path: '/repo/.awl-worktrees/beta', branch: 'work/beta' },
      ],
      CC,
    );
    for (const s of [
      'alpha',
      '/repo/.awl-worktrees/alpha',
      'work/alpha',
      'beta',
      '/repo/.awl-worktrees/beta',
      'work/beta',
    ]) {
      expect(out).toContain(s);
    }
  });
});

describe('laneRegistryRoot (lane lifecycle AC-02)', () => {
  it('linked lane path 는 부모 registry root 로, main path 는 그대로 해석한다', () => {
    expect(laneRegistryRoot('/repo/.awl-worktrees/probe')).toBe('/repo');
    expect(laneRegistryRoot('/repo')).toBe('/repo');
  });
});

describe('lane new/ls/rm — 실제 git 저장소 통합', () => {
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

  function realGitProject(): string {
    const proj = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'awl-lane-')));
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: proj });
    execFileSync('git', ['config', 'user.email', 't@t.com'], { cwd: proj });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: proj });
    fs.writeFileSync(path.join(proj, 'f.txt'), 'base\n');
    fs.mkdirSync(path.join(proj, '.awl'), { recursive: true });
    execFileSync('git', ['add', '-A'], { cwd: proj });
    execFileSync('git', ['commit', '-q', '-m', 'base'], { cwd: proj });
    process.chdir(proj);
    process.env.AWL_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'awl-lane-home-'));
    return proj;
  }

  // engine Claude 스킬 원본을 이 테스트의 AWL_HOME 아래에 시드한다(fresh home 엔 없다).
  function seedEngineSkill(name: string): void {
    const dir = path.join(process.env.AWL_HOME as string, 'engine', 'skills', 'claude', name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), `# ${name}\n`);
  }

  function captureStdout(): { writes: string[]; restore: () => void } {
    const writes: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((s: unknown) => {
      writes.push(String(s));
      return true;
    });
    return { writes, restore: () => spy.mockRestore() };
  }

  // process.exit 을 막되 호출된 종료 코드를 캡처한다 — 에러 경로가 exit(1) 을
  // 잠그도록(exit(0) 회귀를 RED 로 만들도록) code() 로 단언한다.
  function spyProcessExit(): { restore: () => void; code: () => number | undefined } {
    let captured: number | undefined;
    const spy = vi.spyOn(process, 'exit').mockImplementation(((c?: number) => {
      captured = c;
      throw new Error('exit');
    }) as unknown as typeof process.exit);
    return { restore: () => spy.mockRestore(), code: () => captured };
  }

  it('lane new: worktree + .awl/home + 스킬 재설치 + export AWL_HOME + 파이프라인 트리거 안내 (AC-01)', async () => {
    const proj = realGitProject();
    seedEngineSkill('awl-loop');
    seedEngineSkill('awl-pipeline-plan');

    const cap = captureStdout();
    try {
      await runLaneNew('probe');
    } finally {
      cap.restore();
    }

    const lanePath = path.join(proj, '.awl-worktrees', 'probe');
    const homeDir = path.join(lanePath, '.awl', 'home');
    // (a) worktree + isolated home.
    expect(fs.existsSync(lanePath)).toBe(true);
    expect(fs.existsSync(homeDir)).toBe(true);
    // (b) 워크트리에 스킬 재설치(.claude 는 gitignore 라 재설치가 채워야 존재).
    expect(fs.existsSync(path.join(lanePath, '.claude', 'skills', 'awl-loop', 'SKILL.md'))).toBe(
      true,
    );
    // (c) 기동 안내: export AWL_HOME 라인(isolated 누락 시 사라짐) + 스킬 트리거(트리거 블록 누락 시 사라짐).
    const out = cap.writes.join('');
    expect(out).toContain(`export AWL_HOME=${homeDir}`);
    expect(out).toContain('/awl-pipeline-plan');
    // (d) 소요시간·디스크 리포트(D-46) — runLaneNew 는 runWorkNew 를 그대로 감싸 쓰므로
    // (lane.ts 소스 변경 없이) "레인 준비" 블록이 아니라 그 앞의 "워크아이템 생성" 블록에
    // 붙는다. 위치가 목업과 다르지만 awl lane new 의 같은 출력 스트림에 포함된다(설계 결정, D-46).
    expect(out).toContain('소요시간');
  });

  it('lane new: tracked project skill manifest를 lane root agent surface에 동기화한다', async () => {
    const proj = realGitProject();
    const source = path.join(proj, 'nested/workspace/skills/page-create');
    fs.mkdirSync(source, { recursive: true });
    fs.writeFileSync(path.join(source, 'SKILL.md'), '# lane page-create\n');
    fs.writeFileSync(
      path.join(proj, '.awl', 'skills.json'),
      `${JSON.stringify(
        {
          version: 1,
          skills: [
            {
              name: 'page-create',
              agent: 'codex',
              source: 'nested/workspace/skills/page-create',
              target: '.agents/skills/page-create',
            },
          ],
        },
        null,
        2,
      )}\n`,
    );
    execFileSync('git', ['add', '-A'], { cwd: proj });
    execFileSync('git', ['commit', '-q', '-m', 'tracked project skill'], { cwd: proj });

    await runLaneNew('project-skills');

    expect(
      fs.readFileSync(
        path.join(proj, '.awl-worktrees/project-skills/.agents/skills/page-create/SKILL.md'),
        'utf8',
      ),
    ).toBe('# lane page-create\n');
  });

  it('lane new: 초기화되지 않은 git 저장소에서도 lane project config/state 를 만들고 doctor 가 인식한다', async () => {
    const proj = realGitProject();

    await runLaneNew('probe');

    const lanePath = path.join(proj, '.awl-worktrees', 'probe');
    const configPath = path.join(lanePath, '.awl', 'config.json');
    const statePath = path.join(lanePath, '.awl', 'state.json');
    expect(JSON.parse(fs.readFileSync(configPath, 'utf8'))).toMatchObject({
      project: 'probe',
      engineVersion: expect.any(String),
      verify: expect.any(Object),
    });
    expect(JSON.parse(fs.readFileSync(statePath, 'utf8'))).toMatchObject({
      workitem: 'probe',
      phase: expect.any(String),
    });

    process.chdir(lanePath);
    const report = await collectChecks();
    expect(
      report.checks.find((check) => check.group === '이 프로젝트' && check.name === 'config.json'),
    ).toMatchObject({ status: 'ok', value: '있음' });
  });

  it('lane new: 같은 이름 두 번이면 두 번째를 거부하고 기존 레인명을 알린다 (AC-04)', async () => {
    const proj = realGitProject();
    await runLaneNew('probe');

    const warns: string[] = [];
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation((s: unknown) => {
      warns.push(String(s));
      return true;
    });
    const exitCap = spyProcessExit();
    await expect(runLaneNew('probe')).rejects.toThrow('exit');
    // G-056: mockRestore 전에 캡처 배열로 단언한다.
    const combined = warns.join('');
    exitCap.restore();
    errSpy.mockRestore();

    expect(exitCap.code()).toBe(1);
    expect(combined).toContain('probe');
    expect(combined).toMatch(/이미 존재/);
    // 기존 레인은 그대로다(잔재/파괴 없음).
    expect(fs.existsSync(path.join(proj, '.awl-worktrees', 'probe'))).toBe(true);
  });

  it('lane new: 비-git cwd 는 명확한 에러로 거른다 (AC-04)', async () => {
    // .awl 만 있고 git 은 없는 디렉토리 — findProjectRoot 는 루트로 인정하지만 worktree 는 불가.
    const proj = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'awl-lane-nogit-')));
    fs.mkdirSync(path.join(proj, '.awl'), { recursive: true });
    process.chdir(proj);
    process.env.AWL_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'awl-lane-home-'));

    const warns: string[] = [];
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation((s: unknown) => {
      warns.push(String(s));
      return true;
    });
    const exitCap = spyProcessExit();
    await expect(runLaneNew('probe')).rejects.toThrow('exit');
    const combined = warns.join('');
    exitCap.restore();
    errSpy.mockRestore();

    expect(exitCap.code()).toBe(1);
    expect(combined).toMatch(/git/);
    // 워크트리 디렉토리를 만들지 않았다.
    expect(fs.existsSync(path.join(proj, '.awl-worktrees'))).toBe(false);
  });

  it('lane new: root 의 현재 workitem 을 pause 안 하고 root state 불변 — 레인 state 는 worktree 에 (AC-03, F-03)', async () => {
    const proj = realGitProject();
    // root 에서 작업 중인 상태 시뮬레이션: 활성 workitem 을 root state 에 심는다.
    const rootStatePath = path.join(proj, '.awl', 'state.json');
    fs.mkdirSync(path.dirname(rootStatePath), { recursive: true });
    fs.writeFileSync(
      rootStatePath,
      JSON.stringify({
        workitem: 'root-task',
        phase: 'loop',
        criteria: [{ id: 'X', status: 'in_progress' }],
        workitems: {},
      }),
    );

    await runLaneNew('sidecar');

    // root state 불변: 현재 workitem 이 여전히 root-task(sidecar 로 안 바뀌고 pause 안 됨).
    const rootState = JSON.parse(fs.readFileSync(rootStatePath, 'utf8'));
    expect(rootState.workitem).toBe('root-task');
    expect(rootState.phase).toBe('loop');
    // sidecar 가 root 에 없다(유령 근원 제거, F-02) & root-task 가 레지스트리로 안 밀렸다.
    expect(rootState.workitems.sidecar).toBeUndefined();
    expect(rootState.workitems['root-task']).toBeUndefined();

    // 레인 state 는 worktree 에 기록됐다(레인 세션이 자기 워크아이템을 본다).
    const laneStatePath = path.join(proj, '.awl-worktrees', 'sidecar', '.awl', 'state.json');
    expect(fs.existsSync(laneStatePath)).toBe(true);
    expect(JSON.parse(fs.readFileSync(laneStatePath, 'utf8')).workitem).toBe('sidecar');
  });

  it('lane ls / collectLanes: 레인 2개를 이름·경로·브랜치와 함께 나열한다 (AC-02)', async () => {
    const proj = realGitProject();
    await runLaneNew('alpha');
    await runLaneNew('beta');

    const lanes = await collectLanes(proj);
    expect(lanes.map((l) => l.name)).toEqual(['alpha', 'beta']);
    const alpha = lanes.find((l) => l.name === 'alpha');
    expect(alpha?.path).toBe(path.join(proj, '.awl-worktrees', 'alpha'));
    expect(alpha?.branch).toBe('work/alpha');

    // 사람 출력(I/O 래퍼)도 두 레인의 이름·브랜치를 낸다.
    const cap = captureStdout();
    try {
      await runLaneList({ json: false });
    } finally {
      cap.restore();
    }
    const out = cap.writes.join('');
    expect(out).toContain('alpha');
    expect(out).toContain('beta');
    expect(out).toContain('work/beta');
  });

  it('lane ls: linked lane cwd 에서도 부모 registry 의 동일 경로와 브랜치를 나열한다', async () => {
    const proj = realGitProject();
    await runLaneNew('probe');
    const lanePath = path.join(proj, '.awl-worktrees', 'probe');

    const main = await collectLanes(proj);
    expect(main).toContainEqual({ name: 'probe', path: lanePath, branch: 'work/probe' });

    process.chdir(lanePath);
    const jsonCap = captureStdout();
    try {
      await runLaneList({ json: true });
    } finally {
      jsonCap.restore();
    }
    expect(JSON.parse(jsonCap.writes.join(''))).toContainEqual({
      name: 'probe',
      path: lanePath,
      branch: 'work/probe',
    });

    const humanCap = captureStdout();
    try {
      await runLaneList({ json: false });
    } finally {
      humanCap.restore();
    }
    expect(humanCap.writes.join('')).toContain('work/probe');
    expect(humanCap.writes.join('')).not.toContain('레인이 없습니다');
  });

  it('lane rm: removeGitWorktree 로 워크트리·브랜치를 회수하고 디렉토리를 제거한다 (AC-03)', async () => {
    const proj = realGitProject();
    await runLaneNew('probe');
    const lanePath = path.join(proj, '.awl-worktrees', 'probe');
    expect(fs.existsSync(lanePath)).toBe(true);

    await runLaneRemove('probe', {});

    expect(fs.existsSync(lanePath)).toBe(false);
    const worktrees = execFileSync('git', ['worktree', 'list'], { cwd: proj, encoding: 'utf8' });
    expect(worktrees).not.toContain('probe');
    const branches = execFileSync('git', ['branch', '--list'], { cwd: proj, encoding: 'utf8' });
    expect(branches).not.toContain('work/probe');
  });

  it('lane rm: tracked 미커밋 변경이 있으면 --force 없이 거부하고 워크트리를 보존한다 (AC-03)', async () => {
    const proj = realGitProject();
    await runLaneNew('probe');
    const lanePath = path.join(proj, '.awl-worktrees', 'probe');
    // 워크트리 안 tracked 파일을 고쳐 미커밋 상태로 둔다.
    fs.writeFileSync(path.join(lanePath, 'f.txt'), '고침\n');

    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const exitCap = spyProcessExit();
    await expect(runLaneRemove('probe', {})).rejects.toThrow('exit');
    exitCap.restore();
    errSpy.mockRestore();

    expect(exitCap.code()).toBe(1);
    // 거부됐으니 워크트리는 그대로 남는다.
    expect(fs.existsSync(lanePath)).toBe(true);

    // --force 면 더러워도 제거한다.
    await runLaneRemove('probe', { force: true });
    expect(fs.existsSync(lanePath)).toBe(false);
  });

  it('lane rm: 없는 레인은 명확한 에러로 거른다 (AC-03)', async () => {
    realGitProject();
    const warns: string[] = [];
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation((s: unknown) => {
      warns.push(String(s));
      return true;
    });
    const exitCap = spyProcessExit();
    await expect(runLaneRemove('ghost', {})).rejects.toThrow('exit');
    const combined = warns.join('');
    exitCap.restore();
    errSpy.mockRestore();
    expect(exitCap.code()).toBe(1);
    expect(combined).toMatch(/찾을 수 없습니다/);
    expect(combined).toContain('ghost');
  });

  it('lane rm: 병합되지 않은 커밋이 있으면 --force 없이 거부하고 워크트리를 보존한다 (AC-05, 리뷰 지적)', async () => {
    const proj = realGitProject();
    await runLaneNew('probe');
    const lanePath = path.join(proj, '.awl-worktrees', 'probe');
    // 레인 워크트리(work/probe 브랜치)에서 커밋을 만든다 — main 에 병합되지 않은 커밋.
    fs.writeFileSync(path.join(lanePath, 'lane-work.txt'), 'lane\n');
    execFileSync('git', ['add', '-A'], { cwd: lanePath });
    execFileSync('git', ['commit', '-q', '-m', 'lane commit'], { cwd: lanePath });

    const warns: string[] = [];
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation((s: unknown) => {
      warns.push(String(s));
      return true;
    });
    const exitCap = spyProcessExit();
    await expect(runLaneRemove('probe', {})).rejects.toThrow('exit');
    const combined = warns.join('');
    exitCap.restore();
    errSpy.mockRestore();

    expect(exitCap.code()).toBe(1);
    // 거부됐으니 워크트리·브랜치는 그대로 남는다(커밋 손실 방지).
    expect(combined).toMatch(/병합되지 않은/);
    expect(fs.existsSync(lanePath)).toBe(true);
    const branches = execFileSync('git', ['branch', '--list'], { cwd: proj, encoding: 'utf8' });
    expect(branches).toContain('work/probe');

    // --force 면 미머지 커밋이 있어도 제거한다.
    await runLaneRemove('probe', { force: true });
    expect(fs.existsSync(lanePath)).toBe(false);
  });

  it('lane rm: 미add untracked WIP 가 있으면 --force 없이 거부하고 파일을 보존한다 (AC-01, F-01)', async () => {
    const proj = realGitProject();
    await runLaneNew('probe');
    const lanePath = path.join(proj, '.awl-worktrees', 'probe');
    // 미add 신규 파일(genuine WIP) — worktreeDirtyTracked(--untracked-files=no)는 못 본다.
    const wip = path.join(lanePath, 'wip.txt');
    fs.writeFileSync(wip, '미저장 작업\n');

    const warns: string[] = [];
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation((s: unknown) => {
      warns.push(String(s));
      return true;
    });
    const exitCap = spyProcessExit();
    await expect(runLaneRemove('probe', {})).rejects.toThrow('exit');
    const combined = warns.join('');
    exitCap.restore();
    errSpy.mockRestore();

    expect(exitCap.code()).toBe(1);
    // 거부됐으니 워크트리와 미add 파일이 보존된다(untracked 검사 제거 시 파괴돼 RED).
    expect(fs.existsSync(lanePath)).toBe(true);
    expect(fs.existsSync(wip)).toBe(true);
    expect(combined).toMatch(/새 파일/);

    // --force 면 untracked 가 있어도 제거한다.
    await runLaneRemove('probe', { force: true });
    expect(fs.existsSync(lanePath)).toBe(false);
  });

  it('lane rm: awl 자신의 산출물(.awl/·.awl/home/)만 untracked 면 정상 제거한다 (AC-01 필터, G-034)', async () => {
    const proj = realGitProject();
    await runLaneNew('probe');
    const lanePath = path.join(proj, '.awl-worktrees', 'probe');
    // awl 산출물을 흉내 — 필터가 이걸 WIP 로 오판하면 rm 이 막혀(throw) RED.
    fs.mkdirSync(path.join(lanePath, '.awl'), { recursive: true });
    fs.writeFileSync(path.join(lanePath, '.awl', 'state.json'), '{}\n');
    fs.writeFileSync(path.join(lanePath, '.awl', 'home', 'rec.jsonl'), 'x\n');

    await runLaneRemove('probe', {}); // 막히지 않아야 한다(필터가 awl 산출물 제외).
    expect(fs.existsSync(lanePath)).toBe(false);
  });

  it('lane rm: 미머지 커밋 수를 확인 못 하면(없는/detached 브랜치) --force 없이 차단하고 워크트리를 보존한다 (AC-04, fail-open 수정)', async () => {
    const proj = realGitProject();
    // work/x 브랜치 없이 detached 워크트리를 만든다 — unmergedCommitCount 의 rev-list 가
    // 실패하는(HEAD..work/x 미해석) 경로. fail-open(0 반환)이면 게이트가 통과해
    // removeGitWorktree 가 워크트리를 파괴한다.
    const lanePath = path.join(proj, '.awl-worktrees', 'x');
    execFileSync('git', ['worktree', 'add', '--detach', lanePath, 'HEAD'], { cwd: proj });
    expect(fs.existsSync(lanePath)).toBe(true);

    const warns: string[] = [];
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation((s: unknown) => {
      warns.push(String(s));
      return true;
    });
    const exitCap = spyProcessExit();
    await expect(runLaneRemove('x', {})).rejects.toThrow('exit');
    const combined = warns.join('');
    exitCap.restore();
    errSpy.mockRestore();

    expect(exitCap.code()).toBe(1);
    // 수정 후: 게이트가 판정 불가를 위험으로 보고 차단 → 워크트리 보존(파괴 금지).
    // fail-open 이면 이 시점에 워크트리가 이미 제거돼 RED.
    expect(fs.existsSync(lanePath)).toBe(true);
    // "미머지 N개"(>0)가 아니라 "확인할 수 없다"(판정 불가) 메시지여야 한다.
    expect(combined).toMatch(/확인할 수 없/);
  });

  it('lane rm: root state 의 유령 workitem(top-level 현재)을 정리하고 무관한 것은 보존한다 (AC-02, F-02)', async () => {
    const proj = realGitProject();
    await runLaneNew('probe');
    // 구버전 lane new 가 남길 법한 유령: probe 가 root 의 현재(top-level) workitem.
    const rootStatePath = path.join(proj, '.awl', 'state.json');
    fs.writeFileSync(
      rootStatePath,
      JSON.stringify({
        workitem: 'probe',
        phase: 'loop',
        criteria: [{ id: 'X', status: 'in_progress' }],
        workitems: { 'other-task': { status: 'paused', createdAt: 'x', criteria: [] } },
      }),
    );

    // force: 워크트리 삭제 게이트는 이 테스트 관심 밖 — state 정리에 집중.
    await runLaneRemove('probe', { force: true });

    const rootState = JSON.parse(fs.readFileSync(rootStatePath, 'utf8'));
    // 유령 제거: work list(top-level + registry 합산)에 probe 가 없다.
    expect(summarizeWorkitems(rootState).find((w) => w.id === 'probe')).toBeUndefined();
    expect(rootState.workitem).toBeNull();
    // 무관한 워크아이템은 보존(과잉 삭제 방지).
    expect(rootState.workitems['other-task']).toBeDefined();
  });

  it('lane rm: 유령이 레지스트리(paused)에 있어도 정리한다 (AC-02, F-02)', async () => {
    const proj = realGitProject();
    await runLaneNew('probe');
    const rootStatePath = path.join(proj, '.awl', 'state.json');
    fs.writeFileSync(
      rootStatePath,
      JSON.stringify({
        workitem: null,
        phase: null,
        criteria: [],
        workitems: {
          probe: { status: 'paused', createdAt: 'x', criteria: [] },
          keep: { status: 'paused', createdAt: 'y', criteria: [] },
        },
      }),
    );

    await runLaneRemove('probe', { force: true });

    const rootState = JSON.parse(fs.readFileSync(rootStatePath, 'utf8'));
    expect(rootState.workitems.probe).toBeUndefined();
    expect(rootState.workitems.keep).toBeDefined();
  });

  it('removeWorkitemFromState: 대소문자 무시로 top-level/registry 를 지우고 removed 를 알린다 (AC-02 순수)', () => {
    // top-level 대상(대소문자 다름) — 비운다.
    const a = removeWorkitemFromState(
      { workitem: 'Probe', phase: 'loop', criteria: [{ id: 'X' }], workitems: {} },
      ['probe'],
    );
    expect(a.removed).toBe(true);
    expect(a.state.workitem).toBeNull();
    expect(a.state.phase).toBeNull();
    // 대상 없음 — removed:false, 원본 보존.
    const b = removeWorkitemFromState(
      { workitem: 'keep', workitems: { other: { status: 'paused' } } },
      ['probe'],
    );
    expect(b.removed).toBe(false);
    expect(b.state.workitem).toBe('keep');
  });

  it('lane rm: 빈 이름은 거부한다 (AC-05, runLaneNew 와 대칭)', async () => {
    realGitProject();
    const warns: string[] = [];
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation((s: unknown) => {
      warns.push(String(s));
      return true;
    });
    const exitCap = spyProcessExit();
    await expect(runLaneRemove('   ', {})).rejects.toThrow('exit');
    const combined = warns.join('');
    exitCap.restore();
    errSpy.mockRestore();
    expect(exitCap.code()).toBe(1);
    expect(combined).toMatch(/이름/);
  });

  it('collectLanes: 심링크 루트에서도 브랜치를 해석한다 — branchOf realpath 폴백 (AC-05, 리뷰 지적)', async () => {
    const proj = realGitProject();
    await runLaneNew('probe');
    // resolveProjectRoot 는 realpath 하지 않으므로 심링크 경로 루트를 재현한다.
    const link = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'awl-lane-link-')), 'proj');
    fs.symlinkSync(proj, link);

    // 심링크 경로를 root 로 넘기면 .awl-worktrees/probe 는 심링크 경로,
    // git worktree list 는 realpath 를 돌려준다 — realpath 폴백이 있어야 매칭된다.
    const lanes = await collectLanes(link);
    const probe = lanes.find((l) => l.name === 'probe');
    expect(probe?.branch).toBe('work/probe'); // 폴백 제거 시 '(detached)' 로 떨어져 RED.
  });
});
