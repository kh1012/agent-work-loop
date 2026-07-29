import { describe, expect, it } from 'vitest';
import { type VersionInputs, checkVersions } from '../../src/core/versions.js';

function inputs(overrides: Partial<VersionInputs> = {}): VersionInputs {
  return {
    packageVersion: '0.5.0',
    engineSourceVersion: '0.5.0',
    installedEngineVersion: '0.5.0',
    installedSkillVersions: { claude: '0.5.0', codex: '0.5.0' },
    npmLatestVersion: null,
    ...overrides,
  };
}

describe('checkVersions — 3쌍 순수 계산 (WI-X AC-02, ADK 0.8.0: project-vs-engine 제거)', () => {
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

  // 설계 대조 2단계 #7 — 엔진이 사본이 아니라 설치된 패키지라 이 드리프트는 구조적으로 없다.
  it('실행 바이너리 vs 엔진 쌍은 더는 만들지 않는다', () => {
    const r = checkVersions(inputs({ installedEngineVersion: '0.4.5' }));
    expect(r.mismatches.map((m) => m.kind)).not.toContain('binary-vs-engine');
  });

  it('installedEngineVersion 이 null 이면(엔진 미설치) skill 쌍을 검사하지 않는다(크래시 없음)', () => {
    const r = checkVersions(inputs({ installedEngineVersion: null, engineSourceVersion: null }));
    expect(r.ok).toBe(true);
    expect(r.mismatches).toEqual([]);
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
      installedSkillVersions: { claude: '0.2.0', codex: null },
      npmLatestVersion: null,
    });
    expect(r.ok).toBe(false);
    const kinds = r.mismatches.map((m) => m.kind).sort();
    expect(kinds).toEqual(['build', 'claude-skill-vs-engine'].sort());
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

  it('낮은 버전(다운그레이드 후보) 응답이면 updateAvailable 은 없다 — 실측 재현(로컬 0.6.16, 레지스트리 0.0.0)', () => {
    const r = checkVersions(inputs({ packageVersion: '0.6.16', npmLatestVersion: '0.0.0' }));
    expect(r.updateAvailable).toBeUndefined();
  });

  it('현재 버전보다 낮은 패치 버전이어도 updateAvailable 은 없다', () => {
    const r = checkVersions(inputs({ packageVersion: '1.2.3', npmLatestVersion: '1.2.2' }));
    expect(r.updateAvailable).toBeUndefined();
  });

  it('레지스트리 응답이 semver 로 파싱 불가(malformed)하면 updateAvailable 은 없다 — fail-safe(비교 불가는 "모른다")', () => {
    const r = checkVersions(
      inputs({ packageVersion: '0.6.16', npmLatestVersion: 'not-a-version' }),
    );
    expect(r.updateAvailable).toBeUndefined();
  });

  it('레지스트리 응답이 빈 문자열이어도 updateAvailable 은 없다', () => {
    const r = checkVersions(inputs({ packageVersion: '0.6.16', npmLatestVersion: '' }));
    expect(r.updateAvailable).toBeUndefined();
  });
});
