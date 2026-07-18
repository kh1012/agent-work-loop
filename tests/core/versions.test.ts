import { describe, expect, it } from 'vitest';
import { type VersionInputs, checkVersions } from '../../src/core/versions.js';

function inputs(overrides: Partial<VersionInputs> = {}): VersionInputs {
  return {
    packageVersion: '0.5.0',
    engineSourceVersion: '0.5.0',
    installedEngineVersion: '0.5.0',
    projectEngineVersion: '0.5.0',
    installedSkillVersions: { claude: '0.5.0', codex: '0.5.0' },
    npmLatestVersion: null,
    ...overrides,
  };
}

describe('checkVersions — 4쌍 순수 계산 (WI-X AC-02)', () => {
  it('전부 일치하면 ok:true, mismatches 빈 배열', () => {
    const r = checkVersions(inputs());
    expect(r.ok).toBe(true);
    expect(r.mismatches).toEqual([]);
  });

  it('build 쌍(package.json vs engine 소스) 불일치를 잡는다', () => {
    const r = checkVersions(inputs({ engineSourceVersion: '0.4.9' }));
    expect(r.ok).toBe(false);
    expect(r.mismatches).toHaveLength(1);
    expect(r.mismatches[0]?.kind).toBe('build');
    expect(r.mismatches[0]?.a).toBe('0.5.0');
    expect(r.mismatches[0]?.b).toBe('0.4.9');
  });

  it('engineSourceVersion 이 null 이면(못 읽음) build 쌍은 검사하지 않는다', () => {
    const r = checkVersions(inputs({ engineSourceVersion: null }));
    expect(r.mismatches.some((m) => m.kind === 'build')).toBe(false);
  });

  it('binary-vs-engine 쌍(실행 바이너리 vs 설치된 엔진) 불일치를 잡는다', () => {
    const r = checkVersions(inputs({ installedEngineVersion: '0.4.5' }));
    expect(r.mismatches.some((m) => m.kind === 'binary-vs-engine')).toBe(true);
    const m = r.mismatches.find((m) => m.kind === 'binary-vs-engine');
    expect(m?.a).toBe('0.5.0');
    expect(m?.b).toBe('0.4.5');
  });

  it('installedEngineVersion 이 null 이면(엔진 미설치) binary-vs-engine/project-vs-engine/skill 쌍 전부 검사하지 않는다(크래시 없음)', () => {
    const r = checkVersions(inputs({ installedEngineVersion: null, engineSourceVersion: null }));
    expect(r.ok).toBe(true);
    expect(r.mismatches).toEqual([]);
  });

  it('project-vs-engine 쌍(프로젝트 config vs 설치된 엔진) 불일치를 잡는다', () => {
    const r = checkVersions(
      inputs({ installedEngineVersion: '0.5.0', projectEngineVersion: '0.3.1' }),
    );
    const m = r.mismatches.find((x) => x.kind === 'project-vs-engine');
    expect(m).toBeDefined();
    expect(m?.a).toBe('0.3.1');
    expect(m?.b).toBe('0.5.0');
    expect(m?.hint).toContain('0.3.1');
    expect(m?.hint).toContain('0.5.0');
  });

  it('projectEngineVersion 이 null 이면(프로젝트 밖 실행) project-vs-engine 쌍은 검사하지 않는다', () => {
    const r = checkVersions(inputs({ projectEngineVersion: null }));
    expect(r.mismatches.some((m) => m.kind === 'project-vs-engine')).toBe(false);
  });

  it('claude-skill-vs-engine 쌍 불일치를 잡는다', () => {
    const r = checkVersions(
      inputs({ installedSkillVersions: { claude: '0.4.5', codex: '0.5.0' } }),
    );
    const m = r.mismatches.find((x) => x.kind === 'claude-skill-vs-engine');
    expect(m).toBeDefined();
    expect(m?.a).toBe('0.4.5');
  });

  it('codex-skill-vs-engine 쌍 불일치를 잡는다', () => {
    const r = checkVersions(
      inputs({ installedSkillVersions: { claude: '0.5.0', codex: '0.4.5' } }),
    );
    const m = r.mismatches.find((x) => x.kind === 'codex-skill-vs-engine');
    expect(m).toBeDefined();
    expect(m?.a).toBe('0.4.5');
  });

  it('스킬이 미설치(null)면 그 스킬의 쌍은 검사하지 않는다', () => {
    const r = checkVersions(inputs({ installedSkillVersions: { claude: null, codex: null } }));
    expect(r.mismatches.some((m) => m.kind.includes('skill'))).toBe(false);
  });

  it('여러 쌍이 동시에 어긋나면 전부 mismatches 에 담긴다', () => {
    const r = checkVersions({
      packageVersion: '0.5.0',
      engineSourceVersion: '0.4.9',
      installedEngineVersion: '0.4.5',
      projectEngineVersion: '0.3.1',
      installedSkillVersions: { claude: '0.2.0', codex: null },
      npmLatestVersion: null,
    });
    expect(r.ok).toBe(false);
    const kinds = r.mismatches.map((m) => m.kind).sort();
    expect(kinds).toEqual(
      ['binary-vs-engine', 'build', 'claude-skill-vs-engine', 'project-vs-engine'].sort(),
    );
  });
});

describe('checkVersions — updateAvailable (npm 레지스트리, mismatches 와 분리, AC-02)', () => {
  it('npmLatestVersion 이 없으면(null) updateAvailable 은 없다', () => {
    const r = checkVersions(inputs({ npmLatestVersion: null }));
    expect(r.updateAvailable).toBeUndefined();
  });

  it('npmLatestVersion 이 packageVersion 과 같으면(최신) updateAvailable 은 없다', () => {
    const r = checkVersions(inputs({ packageVersion: '0.5.0', npmLatestVersion: '0.5.0' }));
    expect(r.updateAvailable).toBeUndefined();
  });

  it('npmLatestVersion 이 packageVersion 과 다르면 updateAvailable 을 채운다', () => {
    const r = checkVersions(inputs({ packageVersion: '0.5.0', npmLatestVersion: '0.6.0' }));
    expect(r.updateAvailable).toEqual({
      current: '0.5.0',
      latest: '0.6.0',
      hint: expect.stringContaining('npm i -g agent-work-loop@latest'),
    });
  });

  it('updateAvailable 은 mismatches 배열에 섞이지 않는다 — 로컬 불일치와 동시에 있어도 mismatches 는 그대로', () => {
    const r = checkVersions(
      inputs({
        packageVersion: '0.5.0',
        engineSourceVersion: '0.4.9', // build 불일치
        npmLatestVersion: '0.6.0', // 동시에 npm 업데이트도 있음
      }),
    );
    expect(r.mismatches.some((m) => 'current' in m || 'latest' in m)).toBe(false);
    expect(r.mismatches.map((m) => m.kind)).toEqual(['build']);
    expect(r.updateAvailable).toEqual({
      current: '0.5.0',
      latest: '0.6.0',
      hint: expect.stringContaining('npm i -g agent-work-loop@latest'),
    });
  });
});
