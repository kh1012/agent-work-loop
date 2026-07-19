import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  findMarkerLegacyFiles,
  readOtherProjects,
  resolveScope,
  runUninstall,
  scanGlobal,
  scanProjectLocal,
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
