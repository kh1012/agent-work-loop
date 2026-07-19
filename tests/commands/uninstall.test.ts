import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { packageEngineDir } from '../../src/commands/init.js';
import {
  checkLiveLocks,
  findMarkerLegacyFiles,
  readOtherProjects,
  resolveScope,
  runUninstall,
  scanGlobal,
  scanProjectLocal,
  stripAwlAgentsBlock,
} from '../../src/commands/uninstall.js';

/**
 * awl uninstall — awl-uninstall-reset AC-01~AC-07. lane.test.ts 와 같은 격리 패턴을
 * 쓴다: 실 저장소를 절대 건드리지 않고 mkdtempSync 로 만든 임시 git 프로젝트 +
 * 임시 AWL_HOME 안에서만 검증한다.
 */

describe('uninstall', () => {
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

  function fixtureProject(): string {
    const proj = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'awl-uninstall-')));
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: proj });
    execFileSync('git', ['config', 'user.email', 't@t.com'], { cwd: proj });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: proj });
    fs.writeFileSync(path.join(proj, 'f.txt'), 'base\n');
    execFileSync('git', ['add', '-A'], { cwd: proj });
    execFileSync('git', ['commit', '-q', '-m', 'base'], { cwd: proj });
    process.chdir(proj);
    process.env.AWL_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'awl-uninstall-home-'));
    return proj;
  }

  function captureStdout(): { writes: string[]; restore: () => void } {
    const writes: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((s: unknown) => {
      writes.push(String(s));
      return true;
    });
    return { writes, restore: () => spy.mockRestore() };
  }

  // process.exit 을 막되 호출된 종료 코드를 캡처한다(lane.test.ts 와 같은 패턴).
  function spyProcessExit(): { restore: () => void; code: () => number | undefined } {
    let captured: number | undefined;
    const spy = vi.spyOn(process, 'exit').mockImplementation(((c?: number) => {
      captured = c;
      throw new Error('exit');
    }) as unknown as typeof process.exit);
    return { restore: () => spy.mockRestore(), code: () => captured };
  }

  /** exec/review 락 디렉토리를 심는다. pid 는 살아있는 프로세스(기본: 현재 테스트 프로세스)를 쓴다. */
  function seedLock(
    proj: string,
    role: 'exec' | 'review',
    pid: number,
    beatEpochSec: number,
  ): void {
    const lockDir = path.join(proj, '.tasks', '.locks', role);
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(path.join(lockDir, 'pid'), String(pid));
    fs.writeFileSync(path.join(lockDir, 'beat'), String(beatEpochSec));
  }

  /** 프로젝트 로컬 + 전역 양쪽에 F-02~F-04 카테고리를 실제로 심는다. */
  function seedFullFixture(proj: string): void {
    fs.mkdirSync(path.join(proj, '.awl'), { recursive: true });
    fs.writeFileSync(path.join(proj, '.awl', 'config.json'), '{}\n');
    fs.mkdirSync(path.join(proj, '.claude', 'skills', 'awl-loop'), { recursive: true });
    fs.writeFileSync(path.join(proj, '.claude', 'skills', 'awl-loop', 'SKILL.md'), '# x\n');
    fs.writeFileSync(
      path.join(proj, 'AGENTS.md'),
      '<!-- awl-loop:start -->\nfoo\n<!-- awl-loop:end -->\n',
    );
    fs.mkdirSync(path.join(proj, '.tasks', 'plan'), { recursive: true });
    fs.writeFileSync(path.join(proj, '.tasks', 'plan', 'x.md'), '# x\n');

    const home = process.env.AWL_HOME as string;
    fs.mkdirSync(path.join(home, 'records'), { recursive: true });
    fs.writeFileSync(path.join(home, 'records', '2026-01.jsonl'), '{}\n');
    fs.mkdirSync(path.join(home, 'gotchas'), { recursive: true });
  }

  describe('AC-01: 기본 드라이런 — --yes 없이는 fs 변경 0', () => {
    it('F-02~F-05 카테고리를 나열하고 아무것도 지우지 않는다(전/후 mtime·존재 비교)', async () => {
      const proj = fixtureProject();
      seedFullFixture(proj);

      const dotAwlPath = path.join(proj, '.awl');
      const skillPath = path.join(proj, '.claude', 'skills', 'awl-loop');
      const agentsPath = path.join(proj, 'AGENTS.md');
      const tasksPlanPath = path.join(proj, '.tasks', 'plan');
      const homeRecordsPath = path.join(process.env.AWL_HOME as string, 'records');

      const beforeAwlMtime = fs.statSync(dotAwlPath).mtimeMs;
      const beforeHomeMtime = fs.statSync(homeRecordsPath).mtimeMs;

      // --all: AC-01 은 F-02(전역)~F-05(레거시) 전 카테고리 표시 범위를 검증한다.
      // 스코프 좁히기 자체(기본=project만)는 AC-02 가 별도로 검증한다.
      const cap = captureStdout();
      try {
        await runUninstall({ all: true });
      } finally {
        cap.restore();
      }
      const out = cap.writes.join('');

      // 목록에 실제 발견 항목이 나온다.
      expect(out).toContain('.awl/');
      expect(out).toContain('.claude/skills/awl-loop');
      expect(out).toContain('AGENTS.md');
      expect(out).toContain('.tasks/plan');
      expect(out).toContain('records/');

      // 아무것도 안 지워짐 — 존재 + mtime 불변(뮤테이션 저항: rm 이 실수로 불려도 잡힌다).
      for (const p of [dotAwlPath, skillPath, agentsPath, tasksPlanPath, homeRecordsPath]) {
        expect(fs.existsSync(p)).toBe(true);
      }
      expect(fs.statSync(dotAwlPath).mtimeMs).toBe(beforeAwlMtime);
      expect(fs.statSync(homeRecordsPath).mtimeMs).toBe(beforeHomeMtime);
    });

    it('실제 발견된 것만 나열한다 — 없는 카테고리는 목록에 안 뜬다', async () => {
      const proj = fixtureProject();
      fs.mkdirSync(path.join(proj, '.awl'), { recursive: true }); // 이것만 심는다.

      const cap = captureStdout();
      try {
        await runUninstall({});
      } finally {
        cap.restore();
      }
      const out = cap.writes.join('');
      expect(out).toContain('.awl/');
      expect(out).not.toContain('.claude/skills');
      expect(out).not.toContain('AGENTS.md');
      expect(out).not.toContain('.tasks/plan');
    });

    it('--yes 를 줘야 실제로 지운다(플래그 없이는 절대 삭제 없음의 대구)', async () => {
      const proj = fixtureProject();
      fs.mkdirSync(path.join(proj, '.awl'), { recursive: true });
      fs.mkdirSync(path.join(proj, '.claude', 'skills', 'awl-loop'), { recursive: true });
      const home = process.env.AWL_HOME as string;
      fs.mkdirSync(path.join(home, 'records'), { recursive: true });

      const dotAwlPath = path.join(proj, '.awl');
      const skillPath = path.join(proj, '.claude', 'skills', 'awl-loop');
      const homeRecordsPath = path.join(home, 'records');

      const cap = captureStdout();
      try {
        // --all: 이 테스트는 "--yes 를 줘야 지운다" 자체를 검증한다(스코프는 AC-02 몫).
        await runUninstall({ yes: true, all: true });
      } finally {
        cap.restore();
      }

      expect(fs.existsSync(dotAwlPath)).toBe(false);
      expect(fs.existsSync(skillPath)).toBe(false);
      expect(fs.existsSync(homeRecordsPath)).toBe(false);
    });
  });

  describe('AC-02: 스코프 분리 — --project(기본)/--global/--all', () => {
    it('resolveScope: 기본은 project 만, --global 은 global 만(전역은 opt-in), --all 은 둘 다', () => {
      expect(resolveScope({})).toEqual({ project: true, global: false });
      expect(resolveScope({ project: true })).toEqual({ project: true, global: false });
      expect(resolveScope({ global: true })).toEqual({ project: false, global: true });
      expect(resolveScope({ all: true })).toEqual({ project: true, global: true });
    });

    it('플래그 없이(기본) --yes 실행하면 프로젝트만 지워지고 전역은 그대로다', async () => {
      const proj = fixtureProject();
      seedFullFixture(proj);
      const dotAwlPath = path.join(proj, '.awl');
      const homeRecordsPath = path.join(process.env.AWL_HOME as string, 'records');
      const beforeGlobalMtime = fs.statSync(homeRecordsPath).mtimeMs;

      await runUninstall({ yes: true });

      expect(fs.existsSync(dotAwlPath)).toBe(false); // 프로젝트: 지워짐.
      expect(fs.existsSync(homeRecordsPath)).toBe(true); // 전역: 그대로.
      expect(fs.statSync(homeRecordsPath).mtimeMs).toBe(beforeGlobalMtime);
    });

    it('--global --yes 는 전역만 지우고 프로젝트 로컬은 그대로다', async () => {
      const proj = fixtureProject();
      seedFullFixture(proj);
      const dotAwlPath = path.join(proj, '.awl');
      const homeRecordsPath = path.join(process.env.AWL_HOME as string, 'records');
      const beforeProjectMtime = fs.statSync(dotAwlPath).mtimeMs;

      await runUninstall({ yes: true, global: true });

      expect(fs.existsSync(homeRecordsPath)).toBe(false); // 전역: 지워짐.
      expect(fs.existsSync(dotAwlPath)).toBe(true); // 프로젝트: 그대로.
      expect(fs.statSync(dotAwlPath).mtimeMs).toBe(beforeProjectMtime);
    });

    it('--all --yes 는 프로젝트+전역 둘 다 지운다', async () => {
      const proj = fixtureProject();
      seedFullFixture(proj);
      const dotAwlPath = path.join(proj, '.awl');
      const homeRecordsPath = path.join(process.env.AWL_HOME as string, 'records');

      await runUninstall({ yes: true, all: true });

      expect(fs.existsSync(dotAwlPath)).toBe(false);
      expect(fs.existsSync(homeRecordsPath)).toBe(false);
    });

    it('readOtherProjects: projects.json 에서 현재 프로젝트를 뺀 나머지만 돌려준다', () => {
      const proj = fixtureProject();
      const home = process.env.AWL_HOME as string;
      fs.mkdirSync(home, { recursive: true });
      fs.writeFileSync(
        path.join(home, 'projects.json'),
        JSON.stringify([
          { name: 'this-project', path: proj },
          { name: 'other-a', path: '/tmp/other-a' },
          { name: 'other-b', path: '/tmp/other-b' },
        ]),
      );
      const others = readOtherProjects(proj);
      expect(others.map((p) => p.name).sort()).toEqual(['other-a', 'other-b']);
    });

    it('--global 드라이런은 다른 등록 프로젝트 목록과 "학습도 같이 사라진다" 문구를 보여준다', async () => {
      const proj = fixtureProject();
      const home = process.env.AWL_HOME as string;
      fs.mkdirSync(home, { recursive: true });
      fs.writeFileSync(
        path.join(home, 'projects.json'),
        JSON.stringify([
          { name: 'this-project', path: proj },
          { name: 'other-project', path: '/tmp/other-project' },
        ]),
      );

      const cap = captureStdout();
      try {
        await runUninstall({ global: true });
      } finally {
        cap.restore();
      }
      const out = cap.writes.join('');
      expect(out).toContain('other-project');
      expect(out).toContain('학습');
      expect(out).toContain('사라');
      // this-project(자기 자신)는 "다른 프로젝트" 목록에 안 나온다.
      expect(out).not.toContain('this-project');
    });

    it('--project 스코프에서는 전역(다른 프로젝트) 공시 문구가 없다', async () => {
      const proj = fixtureProject();
      const home = process.env.AWL_HOME as string;
      fs.mkdirSync(home, { recursive: true });
      fs.writeFileSync(
        path.join(home, 'projects.json'),
        JSON.stringify([{ name: 'other-project', path: '/tmp/other-project' }]),
      );

      const cap = captureStdout();
      try {
        await runUninstall({});
      } finally {
        cap.restore();
      }
      const out = cap.writes.join('');
      expect(out).not.toContain('other-project');
    });
  });

  describe('AC-03: git worktree 안전 제거 — rm -rf 아니라 git worktree remove', () => {
    it('.awl-worktrees/<lane>/ 을 git worktree remove 로 정리하고 git worktree list 에 고아 메타가 없다', async () => {
      const proj = fixtureProject();
      const lanePath = path.join(proj, '.awl-worktrees', 'probe');
      fs.mkdirSync(path.dirname(lanePath), { recursive: true });
      execFileSync('git', ['worktree', 'add', lanePath, '-b', 'work/probe'], { cwd: proj });

      await runUninstall({ yes: true });

      expect(fs.existsSync(lanePath)).toBe(false);
      const listing = execFileSync('git', ['worktree', 'list'], { cwd: proj, encoding: 'utf8' });
      expect(listing).not.toContain('probe');
      // .git/worktrees/<name> 메타도 고아로 안 남는다(git worktree remove 가 정리).
      const metaDir = path.join(proj, '.git', 'worktrees', 'probe');
      expect(fs.existsSync(metaDir)).toBe(false);
    });

    it('워크트리에 미커밋 변경이 있으면 거부하고(lane rm 안전장치 재사용) 워크트리를 보존한다', async () => {
      const proj = fixtureProject();
      const lanePath = path.join(proj, '.awl-worktrees', 'probe');
      fs.mkdirSync(path.dirname(lanePath), { recursive: true });
      execFileSync('git', ['worktree', 'add', lanePath, '-b', 'work/probe'], { cwd: proj });
      // tracked 파일을 고쳐 미커밋 상태로 만든다(실제 작업 성과물 시뮬레이션).
      fs.writeFileSync(path.join(lanePath, 'f.txt'), '고침\n');

      const cap = captureStdout();
      try {
        await runUninstall({ yes: true });
      } finally {
        cap.restore();
      }
      const out = cap.writes.join('');

      // 거부됐으니 워크트리는 그대로 보존된다 — 강제로 날리지 않는다(범위 밖 명시).
      expect(fs.existsSync(lanePath)).toBe(true);
      expect(fs.existsSync(path.join(lanePath, 'f.txt'))).toBe(true);
      expect(out).toMatch(/커밋되지 않은 변경|probe/);
    });

    it('커밋됐지만 병합되지 않은 브랜치는 거부하고 워크트리를 보존한다', async () => {
      const proj = fixtureProject();
      const lanePath = path.join(proj, '.awl-worktrees', 'probe');
      fs.mkdirSync(path.dirname(lanePath), { recursive: true });
      execFileSync('git', ['worktree', 'add', lanePath, '-b', 'work/probe'], { cwd: proj });
      fs.writeFileSync(path.join(lanePath, 'lane-work.txt'), 'lane\n');
      execFileSync('git', ['add', '-A'], { cwd: lanePath });
      execFileSync('git', ['commit', '-q', '-m', 'lane commit'], { cwd: lanePath });

      await runUninstall({ yes: true });

      expect(fs.existsSync(lanePath)).toBe(true);
      const branches = execFileSync('git', ['branch', '--list'], { cwd: proj, encoding: 'utf8' });
      expect(branches).toContain('work/probe');
    });

    it('여러 레인 중 하나만 더러워도 나머지 깨끗한 레인은 정리된다', async () => {
      const proj = fixtureProject();
      const dirtyPath = path.join(proj, '.awl-worktrees', 'dirty');
      const cleanPath = path.join(proj, '.awl-worktrees', 'clean');
      fs.mkdirSync(path.dirname(dirtyPath), { recursive: true });
      execFileSync('git', ['worktree', 'add', dirtyPath, '-b', 'work/dirty'], { cwd: proj });
      execFileSync('git', ['worktree', 'add', cleanPath, '-b', 'work/clean'], { cwd: proj });
      fs.writeFileSync(path.join(dirtyPath, 'f.txt'), '고침\n');

      await runUninstall({ yes: true });

      expect(fs.existsSync(dirtyPath)).toBe(true); // 보존.
      expect(fs.existsSync(cleanPath)).toBe(false); // 정리됨.
    });
  });

  describe('AC-04: 부분 제거 — 파일 전체 삭제 금지', () => {
    it('stripAwlAgentsBlock: 마커 구간만 제거하고 앞뒤 사용자 내용은 보존한다', () => {
      const content =
        '# 내 프로젝트 지침\n\n사용자가 쓴 내용.\n\n<!-- awl-loop:start -->\nawl 안내\n<!-- awl-loop:end -->\n';
      const { content: next, removed } = stripAwlAgentsBlock(content);
      expect(removed).toBe(true);
      expect(next).toContain('# 내 프로젝트 지침');
      expect(next).toContain('사용자가 쓴 내용.');
      expect(next).not.toContain('awl-loop:start');
      expect(next).not.toContain('awl 안내');
    });

    it('stripAwlAgentsBlock: 마커 뒤에도 사용자 내용이 있으면 보존한다', () => {
      const content =
        '<!-- awl-loop:start -->\nawl 안내\n<!-- awl-loop:end -->\n\n## 뒤에 붙인 내용\n';
      const { content: next, removed } = stripAwlAgentsBlock(content);
      expect(removed).toBe(true);
      expect(next).toContain('## 뒤에 붙인 내용');
      expect(next).not.toContain('awl-loop:start');
    });

    it('stripAwlAgentsBlock: 마커가 없으면 손대지 않는다', () => {
      const content = '# 순수 사용자 파일\n';
      const { content: next, removed } = stripAwlAgentsBlock(content);
      expect(removed).toBe(false);
      expect(next).toBe(content);
    });

    it('AGENTS.md 에 awl 외 내용이 섞여 있으면 --yes 실행 후에도 그 내용이 보존된다', async () => {
      const proj = fixtureProject();
      fs.writeFileSync(
        path.join(proj, 'AGENTS.md'),
        '# 팀 지침\n\n독자적으로 추가한 내용.\n\n<!-- awl-loop:start -->\nawl 안내\n<!-- awl-loop:end -->\n',
      );

      await runUninstall({ yes: true });

      const agentsPath = path.join(proj, 'AGENTS.md');
      expect(fs.existsSync(agentsPath)).toBe(true);
      const after = fs.readFileSync(agentsPath, 'utf8');
      expect(after).toContain('# 팀 지침');
      expect(after).toContain('독자적으로 추가한 내용.');
      expect(after).not.toContain('awl-loop:start');
    });

    it('AGENTS.md 가 awl 마커뿐이면(다른 내용 없음) 파일 자체를 지운다', async () => {
      const proj = fixtureProject();
      fs.writeFileSync(
        path.join(proj, 'AGENTS.md'),
        '<!-- awl-loop:start -->\nawl 안내\n<!-- awl-loop:end -->\n',
      );

      await runUninstall({ yes: true });

      expect(fs.existsSync(path.join(proj, 'AGENTS.md'))).toBe(false);
    });

    it('pre-push 가 awl 템플릿과 정확히 일치하면 제거한다', async () => {
      const proj = fixtureProject();
      const hookDir = path.join(proj, '.git', 'hooks');
      fs.mkdirSync(hookDir, { recursive: true });
      const template = fs.readFileSync(
        path.join(packageEngineDir(), 'templates', 'pre-push.sample'),
        'utf8',
      );
      fs.writeFileSync(path.join(hookDir, 'pre-push'), template);

      await runUninstall({ yes: true });

      expect(fs.existsSync(path.join(hookDir, 'pre-push'))).toBe(false);
    });

    it('pre-push 가 awl 템플릿과 다르면(사용자가 병합) 보존하고 경고를 낸다', async () => {
      const proj = fixtureProject();
      const hookDir = path.join(proj, '.git', 'hooks');
      fs.mkdirSync(hookDir, { recursive: true });
      const merged = '#!/bin/sh\n# 사용자가 다른 훅과 병합함\necho custom\nexit 0\n';
      fs.writeFileSync(path.join(hookDir, 'pre-push'), merged);

      const cap = captureStdout();
      try {
        await runUninstall({ yes: true });
      } finally {
        cap.restore();
      }
      const out = cap.writes.join('');

      expect(fs.existsSync(path.join(hookDir, 'pre-push'))).toBe(true);
      expect(fs.readFileSync(path.join(hookDir, 'pre-push'), 'utf8')).toBe(merged);
      expect(out).toMatch(/pre-push/);
      expect(out).toMatch(/일치하지 않|병합|다릅니다|불일치/);
    });
  });

  describe('AC-05: 레거시 스윕 — ㅍ 마커 / 옛 .awl-home / deltas+backup', () => {
    it('ㅍ 마커 잔재(.tasks/**/*ㅍ*.md)를 드라이런에 [레거시]로 나열하고 --yes 로 지운다', async () => {
      const proj = fixtureProject();
      fs.mkdirSync(path.join(proj, '.tasks', 'plan'), { recursive: true });
      const markerFile = path.join(proj, '.tasks', 'plan', '일감ㅍ완료.md');
      fs.writeFileSync(markerFile, '# 레거시\n');

      const cap = captureStdout();
      try {
        await runUninstall({});
      } finally {
        cap.restore();
      }
      const dry = cap.writes.join('');
      expect(dry).toContain('[레거시]');
      expect(dry).toContain('마커');

      await runUninstall({ yes: true });
      expect(fs.existsSync(markerFile)).toBe(false);
    });

    it('최상위 .awl-home(0.6.17 이전 레거시)을 드라이런에 나열하고 --yes 로 지운다', async () => {
      const proj = fixtureProject();
      const legacyHome = path.join(proj, '.awl-home');
      fs.mkdirSync(path.join(legacyHome, 'records'), { recursive: true });

      const cap = captureStdout();
      try {
        await runUninstall({});
      } finally {
        cap.restore();
      }
      const dry = cap.writes.join('');
      expect(dry).toContain('.awl-home');
      expect(dry).toContain('[레거시]');

      await runUninstall({ yes: true });
      expect(fs.existsSync(legacyHome)).toBe(false);
      // 정본 .awl/home 은(있었다면) 이번 픽스처엔 없었으므로 별도 확인 불필요 — .awl-home 만 특정해 지웠는지 확인.
    });

    it('전역 deltas/ + deltas.backup-* 레거시를 --global 드라이런에 나열하고 --yes 로 지운다', async () => {
      fixtureProject();
      const home = process.env.AWL_HOME as string;
      fs.mkdirSync(path.join(home, 'deltas'), { recursive: true });
      fs.writeFileSync(path.join(home, 'deltas', 'x.json'), '{}\n');
      fs.writeFileSync(path.join(home, 'deltas.backup-2026-01-01'), '{}\n');

      const cap = captureStdout();
      try {
        await runUninstall({ global: true });
      } finally {
        cap.restore();
      }
      const dry = cap.writes.join('');
      expect(dry).toContain('deltas');
      expect(dry).toContain('[레거시]');

      await runUninstall({ yes: true, global: true });
      expect(fs.existsSync(path.join(home, 'deltas'))).toBe(false);
      expect(fs.existsSync(path.join(home, 'deltas.backup-2026-01-01'))).toBe(false);
    });

    it('레거시 패턴이 없으면 아무것도 안 지우고 목록에도 안 뜬다', async () => {
      fixtureProject();
      const cap = captureStdout();
      try {
        await runUninstall({ all: true });
      } finally {
        cap.restore();
      }
      const out = cap.writes.join('');
      expect(out).not.toContain('[레거시]');
    });
  });

  describe('AC-06: 라이브 프로세스 안전장치 — 최우선', () => {
    it('checkLiveLocks: 살아있는 PID + 최근 heartbeat 면 live:true', () => {
      const proj = fixtureProject();
      const now = Math.floor(Date.now() / 1000);
      seedLock(proj, 'review', process.pid, now);
      const statuses = checkLiveLocks(path.join(proj, '.tasks'), now * 1000);
      const review = statuses.find((s) => s.role === 'review');
      expect(review?.live).toBe(true);
      expect(review?.pid).toBe(process.pid);
    });

    it('checkLiveLocks: heartbeat 가 60초 이상 지났으면(stale) live:false', () => {
      const proj = fixtureProject();
      const now = Math.floor(Date.now() / 1000);
      seedLock(proj, 'exec', process.pid, now - 120); // 120초 전.
      const statuses = checkLiveLocks(path.join(proj, '.tasks'), now * 1000);
      const exec = statuses.find((s) => s.role === 'exec');
      expect(exec?.live).toBe(false);
    });

    it('checkLiveLocks: 죽은 PID(kill -0 실패)면 heartbeat 와 무관하게 live:false', () => {
      const proj = fixtureProject();
      const now = Math.floor(Date.now() / 1000);
      // 존재할 가능성이 거의 없는 PID — kill -0 이 ESRCH 로 실패해야 한다.
      seedLock(proj, 'exec', 999_999, now);
      const statuses = checkLiveLocks(path.join(proj, '.tasks'), now * 1000);
      const exec = statuses.find((s) => s.role === 'exec');
      expect(exec?.live).toBe(false);
    });

    it('checkLiveLocks: 락 디렉토리가 아예 없으면 빈 배열', () => {
      const proj = fixtureProject();
      expect(checkLiveLocks(path.join(proj, '.tasks'))).toEqual([]);
    });

    it('라이브 락이 있으면 --yes 를 경고하고 중단한다 — fs 변경 0(전/후 존재 비교)', async () => {
      const proj = fixtureProject();
      fs.mkdirSync(path.join(proj, '.awl'), { recursive: true });
      const dotAwlPath = path.join(proj, '.awl');
      const beforeMtime = fs.statSync(dotAwlPath).mtimeMs;
      const now = Math.floor(Date.now() / 1000);
      seedLock(proj, 'review', process.pid, now); // 살아있는 락.

      const errWrites: string[] = [];
      const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation((s: unknown) => {
        errWrites.push(String(s));
        return true;
      });
      const exitCap = spyProcessExit();
      await expect(runUninstall({ yes: true })).rejects.toThrow('exit');
      const combined = errWrites.join('');
      exitCap.restore();
      errSpy.mockRestore();

      expect(exitCap.code()).toBe(1);
      expect(combined).toMatch(/라이브|프로세스|중단/);
      // 아무것도 안 지워짐 — .awl/ 이 그대로다(mtime 도 불변, 뮤테이션 저항).
      expect(fs.existsSync(dotAwlPath)).toBe(true);
      expect(fs.statSync(dotAwlPath).mtimeMs).toBe(beforeMtime);
    });

    it('락이 stale(60초 이상 지남)이면 경고 없이 정상 진행한다', async () => {
      const proj = fixtureProject();
      fs.mkdirSync(path.join(proj, '.awl'), { recursive: true });
      const now = Math.floor(Date.now() / 1000);
      seedLock(proj, 'review', process.pid, now - 120); // stale.

      await runUninstall({ yes: true });

      expect(fs.existsSync(path.join(proj, '.awl'))).toBe(false);
    });

    it('락이 없으면 정상 진행한다', async () => {
      const proj = fixtureProject();
      fs.mkdirSync(path.join(proj, '.awl'), { recursive: true });

      await runUninstall({ yes: true });

      expect(fs.existsSync(path.join(proj, '.awl'))).toBe(false);
    });

    it('--global 전용 스코프에서는 라이브 락이 있어도 중단하지 않는다(.tasks 를 안 건드리므로)', async () => {
      const proj = fixtureProject();
      const home = process.env.AWL_HOME as string;
      fs.mkdirSync(path.join(home, 'records'), { recursive: true });
      const now = Math.floor(Date.now() / 1000);
      seedLock(proj, 'review', process.pid, now);

      await runUninstall({ yes: true, global: true });

      expect(fs.existsSync(path.join(home, 'records'))).toBe(false);
    });
  });

  describe('scanProjectLocal / scanGlobal (순수 스캔, 읽기 전용)', () => {
    it('scanProjectLocal 은 프로젝트가 비어 있으면 전부 present:false 를 돌려준다', () => {
      const proj = fixtureProject();
      const items = scanProjectLocal(proj);
      expect(items.length).toBeGreaterThan(0);
      expect(items.every((i) => i.present === false)).toBe(true);
    });

    it('scanGlobal 은 AWL_HOME 재정의를 존중한다', () => {
      fixtureProject();
      const home = process.env.AWL_HOME as string;
      fs.mkdirSync(path.join(home, 'records'), { recursive: true });
      const items = scanGlobal();
      const recordsItem = items.find((i) => i.category === 'records/');
      expect(recordsItem?.present).toBe(true);
      expect(recordsItem?.path).toBe(path.join(home, 'records'));
    });

    it('findMarkerLegacyFiles 는 .tasks 하위 ㅍ 마커 .md 파일만 찾는다', () => {
      const proj = fixtureProject();
      fs.mkdirSync(path.join(proj, '.tasks', 'plan'), { recursive: true });
      fs.writeFileSync(path.join(proj, '.tasks', 'plan', '일감ㅍ완료.md'), '# x\n');
      fs.writeFileSync(path.join(proj, '.tasks', 'plan', 'normal.md'), '# y\n');
      const found = findMarkerLegacyFiles(proj);
      expect(found).toHaveLength(1);
      expect(found[0]).toContain('일감ㅍ완료.md');
    });
  });
});
