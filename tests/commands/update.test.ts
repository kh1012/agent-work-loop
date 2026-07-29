import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyInit, nonInteractiveInputs, stagesMdContent } from '../../src/commands/init.js';
import { applyLocalUpdate, applyUpdate, runUpdate } from '../../src/commands/update.js';
import { installedEngineVersion } from '../../src/core/engine.js';

const origHome = process.env.AWL_HOME;

function tmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function readJson(p: string): unknown {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

/** applyUpdate() 는 engine/ 이 이미 있어야 동작한다(scaffoldGlobal 이 아니라 순수 갱신이라) —
 * 테스트에서 실제 엔진 내용으로 채우려면 빈 engine/ 디렉토리를 먼저 만들어둬야 한다. */
function seedEngineDir(home: string): void {
  fs.mkdirSync(path.join(home, 'engine'), { recursive: true });
  fs.writeFileSync(
    path.join(home, 'engine', 'version.json'),
    JSON.stringify({ engineVersion: '0.0.1' }),
  );
}

function readEngineVersion(home: string): string {
  return (readJson(path.join(home, 'engine', 'version.json')) as { engineVersion: string })
    .engineVersion;
}

afterEach(() => {
  if (origHome === undefined) {
    delete process.env.AWL_HOME;
  } else {
    process.env.AWL_HOME = origHome;
  }
});

// 설계 대조 2단계 #7 — 엔진은 설치된 npm 패키지 그 자체라 복사할 사본이 없다.
describe('applyUpdate — 엔진 사본을 만들지 않는다', () => {
  it('아무 파일도 안 고치고 지금 버전만 돌려준다', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'awl-update-'));
    process.env.AWL_HOME = home;
    const r = applyUpdate();
    expect(r.updated).toBe(false);
    expect(r.fromVersion).toBe(r.toVersion);
    expect(fs.existsSync(path.join(home, 'engine'))).toBe(false);
  });
});

describe('applyLocalUpdate — 등록된 프로젝트 전부 재동기화 (awl-update-local AC-01)', () => {
  it('등록된 프로젝트가 없으면 빈 배열을 돌려준다', () => {
    const home = tmp('awl-update-local-empty-');
    seedEngineDir(home);
    process.env.AWL_HOME = home;
    applyUpdate(); // ~/.awl 생성(엔진 설치)
    expect(applyLocalUpdate('0.0.1', '2026-01-02T00:00:00.000Z')).toEqual([]);
  });

  it('등록된 프로젝트의 skills-version 마커가 낡았으면 갱신하고 status:updated 를 낸다(ADK 0.8.0: config.json 은 안 건드림)', () => {
    const home = tmp('awl-update-local-home-');
    seedEngineDir(home);
    process.env.AWL_HOME = home;
    applyUpdate();
    const engineVersion = installedEngineVersion() as string;

    const proj = tmp('awl-update-local-proj-');
    const inputs = nonInteractiveInputs(proj);
    inputs.skills = { claude: true, codex: false };
    applyInit(proj, inputs, '2026-01-01T00:00:00.000Z');

    // 마커만 낡은 버전으로 되돌려 "engine 이 그 사이 갱신됐다"를 재현한다.
    const skillsVerPath = path.join(proj, '.awl', 'skills-version.json');
    fs.writeFileSync(skillsVerPath, JSON.stringify({ claude: '0.0.1' }));

    const results = applyLocalUpdate(engineVersion, '2026-01-02T00:00:00.000Z');
    expect(results).toHaveLength(1);
    const [r] = results;
    expect(r?.status).toBe('updated');
    expect(r?.skills).toEqual(['claude']);
    expect((readJson(skillsVerPath) as Record<string, unknown>).claude).toBe(engineVersion);
    const configPath = path.join(proj, '.awl', 'config.json');
    expect(readJson(configPath) as Record<string, unknown>).not.toHaveProperty('engineVersion');
  });

  it('이미 최신인 프로젝트는 status:up-to-date 를 낸다', () => {
    const home = tmp('awl-update-local-home-');
    seedEngineDir(home);
    process.env.AWL_HOME = home;
    applyUpdate();
    const engineVersion = installedEngineVersion() as string;

    const proj = tmp('awl-update-local-proj-');
    const inputs = nonInteractiveInputs(proj);
    inputs.skills = { claude: true, codex: false };
    applyInit(proj, inputs, '2026-01-01T00:00:00.000Z');

    const results = applyLocalUpdate(engineVersion, '2026-01-02T00:00:00.000Z');
    expect(results).toHaveLength(1);
    expect(results[0]?.status).toBe('up-to-date');
  });

  it('낡은 stages.md 는 awl update --local(applyLocalUpdate) 이 최신으로 재생성한다(ADK stage 1)', () => {
    const home = tmp('awl-update-local-home-');
    seedEngineDir(home);
    process.env.AWL_HOME = home;
    applyUpdate();
    const engineVersion = installedEngineVersion() as string;

    const proj = tmp('awl-update-local-proj-');
    const inputs = nonInteractiveInputs(proj);
    applyInit(proj, inputs, '2026-01-01T00:00:00.000Z');

    const stagesMdPath = path.join(proj, '.awl', 'stages.md');
    fs.writeFileSync(stagesMdPath, '낡은 내용\n');
    expect(fs.readFileSync(stagesMdPath, 'utf8')).not.toBe(stagesMdContent());

    applyLocalUpdate(engineVersion, '2026-01-02T00:00:00.000Z');

    expect(fs.readFileSync(stagesMdPath, 'utf8')).toBe(stagesMdContent());
  });

  it('등록된 프로젝트의 경로가 사라졌으면 죽지 않고 status:skipped 로 건너뛴다', () => {
    const home = tmp('awl-update-local-home-');
    seedEngineDir(home);
    process.env.AWL_HOME = home;
    applyUpdate();

    const proj = tmp('awl-update-local-proj-gone-');
    const inputs = nonInteractiveInputs(proj);
    applyInit(proj, inputs, '2026-01-01T00:00:00.000Z');
    fs.rmSync(proj, { recursive: true, force: true });

    const results = applyLocalUpdate('0.0.1', '2026-01-02T00:00:00.000Z');
    expect(results).toHaveLength(1);
    expect(results[0]?.status).toBe('skipped');
    expect(results[0]?.reason).toMatch(/경로를 찾을 수 없습니다/);
  });
});

describe('runUpdate — 스코프 기본값 (awl-update-local AC-02)', () => {
  it('옵션 없이 치면 전역만 갱신하고, 등록된 프로젝트는 건드리지 않는다', () => {
    const home = tmp('awl-update-scope-home-');
    seedEngineDir(home);
    process.env.AWL_HOME = home;
    applyUpdate();
    const engineVersion = installedEngineVersion() as string;

    const proj = tmp('awl-update-scope-proj-');
    const inputs = nonInteractiveInputs(proj);
    inputs.skills = { claude: true, codex: false };
    applyInit(proj, inputs, '2026-01-01T00:00:00.000Z');
    const skillsVerPath = path.join(proj, '.awl', 'skills-version.json');
    fs.writeFileSync(skillsVerPath, JSON.stringify({ claude: '0.0.1' }));

    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    runUpdate();
    stdoutSpy.mockRestore();

    // --local/--all 을 안 줬으니 프로젝트 skills-version 마커는 그대로 낡은 채여야 한다.
    expect((readJson(skillsVerPath) as Record<string, unknown>).claude).toBe('0.0.1');
    expect(engineVersion).not.toBe('0.0.1'); // 전역 엔진 자체는 실제 갱신됐다(비교용 sanity).
  });

  it('--local 을 주면 등록된 프로젝트를 갱신하고, 전역 엔진 재설치(applyUpdate)는 별도로 타지 않는다', () => {
    const home = tmp('awl-update-scope-home-');
    seedEngineDir(home);
    process.env.AWL_HOME = home;
    applyUpdate(); // 먼저 엔진을 설치해둔다(런타임에서라면 이미 설치돼 있는 상태).

    const proj = tmp('awl-update-scope-proj2-');
    const inputs = nonInteractiveInputs(proj);
    inputs.skills = { claude: true, codex: false };
    applyInit(proj, inputs, '2026-01-01T00:00:00.000Z');
    const skillsVerPath = path.join(proj, '.awl', 'skills-version.json');
    fs.writeFileSync(skillsVerPath, JSON.stringify({ claude: '0.0.1' }));

    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    runUpdate({ local: true });
    stdoutSpy.mockRestore();

    expect((readJson(skillsVerPath) as Record<string, unknown>).claude).not.toBe('0.0.1');
  });

  it('--all 을 주면 전역과 등록된 프로젝트를 모두 갱신한다', () => {
    const home = tmp('awl-update-scope-home-');
    seedEngineDir(home);
    process.env.AWL_HOME = home;
    applyUpdate();

    const proj = tmp('awl-update-scope-proj3-');
    const inputs = nonInteractiveInputs(proj);
    inputs.skills = { claude: true, codex: false };
    applyInit(proj, inputs, '2026-01-01T00:00:00.000Z');
    const skillsVerPath = path.join(proj, '.awl', 'skills-version.json');
    fs.writeFileSync(skillsVerPath, JSON.stringify({ claude: '0.0.1' }));

    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    runUpdate({ all: true });
    stdoutSpy.mockRestore();

    expect((readJson(skillsVerPath) as Record<string, unknown>).claude).not.toBe('0.0.1');
  });

  it('--all 은 Codex의 옛 Claude 스킬 symlink를 실제 디렉터리로 마이그레이션한다', () => {
    const home = tmp('awl-update-symlink-home-');
    seedEngineDir(home);
    process.env.AWL_HOME = home;
    applyUpdate();

    const proj = tmp('awl-update-symlink-proj-');
    const inputs = nonInteractiveInputs(proj);
    inputs.skills = { claude: true, codex: true };
    applyInit(proj, inputs, '2026-01-01T00:00:00.000Z');

    const claudeSkill = path.join(proj, '.claude', 'skills', 'awl-loop');
    const codexSkill = path.join(proj, '.agents', 'skills', 'awl-loop');
    fs.writeFileSync(path.join(claudeSkill, 'sentinel.txt'), 'keep the Claude target\n');
    fs.rmSync(codexSkill, { recursive: true });
    fs.symlinkSync(path.relative(path.dirname(codexSkill), claudeSkill), codexSkill, 'dir');

    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    runUpdate({ all: true });
    stdoutSpy.mockRestore();

    expect(fs.lstatSync(codexSkill).isSymbolicLink()).toBe(false);
    expect(fs.statSync(codexSkill).isDirectory()).toBe(true);
    expect(fs.existsSync(path.join(codexSkill, 'SKILL.md'))).toBe(true);
    expect(fs.readFileSync(path.join(claudeSkill, 'sentinel.txt'), 'utf8')).toBe(
      'keep the Claude target\n',
    );
  });
});
