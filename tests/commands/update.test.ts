import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyInit, nonInteractiveInputs } from '../../src/commands/init.js';
import { applyLocalUpdate, applyUpdate, runUpdate } from '../../src/commands/update.js';

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

describe('applyUpdate — 엔진 재설치 (WI-X AC-05)', () => {
  it('엔진이 설치된 적 없으면(scaffoldGlobal 전) 아무것도 안 하고 안내만 한다', () => {
    // tmp() 는 디렉토리 자체를 만들어버리므로(실제 존재 여부와 무관하게), engine/
    // 이 아예 없는 상태를 흉내내려면 아직 존재하지 않는 경로 문자열만 준다.
    process.env.AWL_HOME = path.join(os.tmpdir(), `awl-update-none-${process.pid}-${Date.now()}`);
    const result = applyUpdate();
    expect(result.updated).toBe(false);
    expect(result.reason).toBe('not-installed');
  });

  it('~/.awl 이 있으면 packageEngineDir() 의 내용으로 engine/ 을 덮어쓰고 이전/이후 버전을 돌려준다', () => {
    const home = tmp('awl-update-home-');
    fs.mkdirSync(path.join(home, 'engine'), { recursive: true });
    fs.writeFileSync(
      path.join(home, 'engine', 'version.json'),
      JSON.stringify({ engineVersion: '0.0.1' }),
    );
    process.env.AWL_HOME = home;

    const result = applyUpdate();
    expect(result.updated).toBe(true);
    expect(result.fromVersion).toBe('0.0.1');
    // packageEngineDir() 은 이 저장소 자신의 engine/ 을 가리킨다 — 실제 버전으로 갱신됨.
    expect(result.toVersion).not.toBeNull();
    expect(result.toVersion).not.toBe('0.0.1');
    // 스킬 디렉토리까지 실제로 복사됐는지 확인(engine/ 이 통째로 덮어써졌는지).
    expect(
      fs.existsSync(path.join(home, 'engine', 'skills', 'claude', 'awl-loop', 'SKILL.md')),
    ).toBe(true);
  });

  it('이미 최신이면 fromVersion 과 toVersion 이 같다', () => {
    const home = tmp('awl-update-home-');
    process.env.AWL_HOME = home;
    // 먼저 한 번 설치해 최신으로 만든다.
    fs.mkdirSync(path.join(home, 'engine'), { recursive: true });
    applyUpdate();
    const first = applyUpdate();
    const second = applyUpdate();
    expect(second.fromVersion).toBe(first.toVersion);
    expect(second.toVersion).toBe(first.toVersion);
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

  it('등록된 프로젝트의 config.engineVersion 이 낡았으면 갱신하고 status:updated 를 낸다', () => {
    const home = tmp('awl-update-local-home-');
    seedEngineDir(home);
    process.env.AWL_HOME = home;
    applyUpdate();
    const engineVersion = readEngineVersion(home);

    const proj = tmp('awl-update-local-proj-');
    const inputs = nonInteractiveInputs(proj);
    inputs.skills = { claude: true, codex: false };
    applyInit(proj, inputs, '2026-01-01T00:00:00.000Z');

    // 마커만 낡은 버전으로 되돌려 "engine 이 그 사이 갱신됐다"를 재현한다.
    const configPath = path.join(proj, '.awl', 'config.json');
    const cfg = readJson(configPath) as Record<string, unknown>;
    fs.writeFileSync(configPath, JSON.stringify({ ...cfg, engineVersion: '0.0.1' }));

    const results = applyLocalUpdate(engineVersion, '2026-01-02T00:00:00.000Z');
    expect(results).toHaveLength(1);
    const [r] = results;
    expect(r?.status).toBe('updated');
    expect(r?.skills).toEqual(['claude']);
    expect((readJson(configPath) as Record<string, unknown>).engineVersion).toBe(engineVersion);
  });

  it('이미 최신인 프로젝트는 status:up-to-date 를 낸다', () => {
    const home = tmp('awl-update-local-home-');
    seedEngineDir(home);
    process.env.AWL_HOME = home;
    applyUpdate();
    const engineVersion = readEngineVersion(home);

    const proj = tmp('awl-update-local-proj-');
    const inputs = nonInteractiveInputs(proj);
    inputs.skills = { claude: true, codex: false };
    applyInit(proj, inputs, '2026-01-01T00:00:00.000Z');

    const results = applyLocalUpdate(engineVersion, '2026-01-02T00:00:00.000Z');
    expect(results).toHaveLength(1);
    expect(results[0]?.status).toBe('up-to-date');
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
    const engineVersion = readEngineVersion(home);

    const proj = tmp('awl-update-scope-proj-');
    const inputs = nonInteractiveInputs(proj);
    inputs.skills = { claude: true, codex: false };
    applyInit(proj, inputs, '2026-01-01T00:00:00.000Z');
    const configPath = path.join(proj, '.awl', 'config.json');
    const cfg = readJson(configPath) as Record<string, unknown>;
    fs.writeFileSync(configPath, JSON.stringify({ ...cfg, engineVersion: '0.0.1' }));

    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    runUpdate();
    stdoutSpy.mockRestore();

    // --local/--all 을 안 줬으니 프로젝트 config 는 그대로 낡은 채여야 한다.
    expect((readJson(configPath) as Record<string, unknown>).engineVersion).toBe('0.0.1');
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
    const configPath = path.join(proj, '.awl', 'config.json');
    const cfg = readJson(configPath) as Record<string, unknown>;
    fs.writeFileSync(configPath, JSON.stringify({ ...cfg, engineVersion: '0.0.1' }));

    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    runUpdate({ local: true });
    stdoutSpy.mockRestore();

    expect((readJson(configPath) as Record<string, unknown>).engineVersion).not.toBe('0.0.1');
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
    const configPath = path.join(proj, '.awl', 'config.json');
    const cfg = readJson(configPath) as Record<string, unknown>;
    fs.writeFileSync(configPath, JSON.stringify({ ...cfg, engineVersion: '0.0.1' }));

    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    runUpdate({ all: true });
    stdoutSpy.mockRestore();

    expect((readJson(configPath) as Record<string, unknown>).engineVersion).not.toBe('0.0.1');
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

    const configPath = path.join(proj, '.awl', 'config.json');
    const cfg = readJson(configPath) as Record<string, unknown>;
    fs.writeFileSync(configPath, JSON.stringify({ ...cfg, engineVersion: '0.7.1' }));

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
