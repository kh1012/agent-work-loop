import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  collectLanes,
  parseWorktreeBranches,
  renderLaneList,
  runLaneList,
  runLaneNew,
  runLaneRemove,
} from '../../src/commands/lane.js';

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

  it('lane new: worktree + .awl-home + 스킬 재설치 + export AWL_HOME + 파이프라인 트리거 안내 (AC-01)', async () => {
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
    const homeDir = path.join(lanePath, '.awl-home');
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
  });

  it('lane new: 같은 이름 두 번이면 두 번째를 거부하고 기존 레인명을 알린다 (AC-04)', async () => {
    const proj = realGitProject();
    await runLaneNew('probe');

    const warns: string[] = [];
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation((s: unknown) => {
      warns.push(String(s));
      return true;
    });
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('exit');
    }) as unknown as typeof process.exit);
    await expect(runLaneNew('probe')).rejects.toThrow('exit');
    // G-056: mockRestore 전에 캡처 배열로 단언한다.
    const combined = warns.join('');
    exitSpy.mockRestore();
    errSpy.mockRestore();

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
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('exit');
    }) as unknown as typeof process.exit);
    await expect(runLaneNew('probe')).rejects.toThrow('exit');
    const combined = warns.join('');
    exitSpy.mockRestore();
    errSpy.mockRestore();

    expect(combined).toMatch(/git/);
    // 워크트리 디렉토리를 만들지 않았다.
    expect(fs.existsSync(path.join(proj, '.awl-worktrees'))).toBe(false);
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
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('exit');
    }) as unknown as typeof process.exit);
    await expect(runLaneRemove('probe', {})).rejects.toThrow('exit');
    exitSpy.mockRestore();
    errSpy.mockRestore();

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
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('exit');
    }) as unknown as typeof process.exit);
    await expect(runLaneRemove('ghost', {})).rejects.toThrow('exit');
    const combined = warns.join('');
    exitSpy.mockRestore();
    errSpy.mockRestore();
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
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('exit');
    }) as unknown as typeof process.exit);
    await expect(runLaneRemove('probe', {})).rejects.toThrow('exit');
    const combined = warns.join('');
    exitSpy.mockRestore();
    errSpy.mockRestore();

    // 거부됐으니 워크트리·브랜치는 그대로 남는다(커밋 손실 방지).
    expect(combined).toMatch(/병합되지 않은/);
    expect(fs.existsSync(lanePath)).toBe(true);
    const branches = execFileSync('git', ['branch', '--list'], { cwd: proj, encoding: 'utf8' });
    expect(branches).toContain('work/probe');

    // --force 면 미머지 커밋이 있어도 제거한다.
    await runLaneRemove('probe', { force: true });
    expect(fs.existsSync(lanePath)).toBe(false);
  });

  it('lane rm: 빈 이름은 거부한다 (AC-05, runLaneNew 와 대칭)', async () => {
    realGitProject();
    const warns: string[] = [];
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation((s: unknown) => {
      warns.push(String(s));
      return true;
    });
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('exit');
    }) as unknown as typeof process.exit);
    await expect(runLaneRemove('   ', {})).rejects.toThrow('exit');
    const combined = warns.join('');
    exitSpy.mockRestore();
    errSpy.mockRestore();
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
