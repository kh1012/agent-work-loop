/**
 * 버전 불일치 검사 (WI-X).
 *
 * 어긋날 수 있는 버전이 네 쌍이다:
 *   1. build              — package.json vs engine/version.json (패키지 소스, 빌드 시점)
 *   2. binary-vs-engine   — 실행 바이너리(package.json) vs 설치된 엔진(~/.awl/engine)
 *   3. project-vs-engine  — 프로젝트 config.engineVersion vs 설치된 엔진
 *   4. {claude,codex}-skill-vs-engine — 설치된 스킬(.awl/skills-version.json) vs 설치된 엔진
 *
 * 순수 함수. 값을 못 구했으면(null) 그 쌍은 검사하지 않는다 — 크래시하지 않는다.
 */

export interface VersionInputs {
  packageVersion: string;
  engineSourceVersion: string | null;
  installedEngineVersion: string | null;
  projectEngineVersion: string | null;
  installedSkillVersions: { claude: string | null; codex: string | null };
}

export type VersionMismatchKind =
  | 'build'
  | 'binary-vs-engine'
  | 'project-vs-engine'
  | 'claude-skill-vs-engine'
  | 'codex-skill-vs-engine';

export interface VersionMismatch {
  kind: VersionMismatchKind;
  a: string;
  b: string;
  hint: string;
}

export interface VersionCheckResult {
  ok: boolean;
  mismatches: VersionMismatch[];
}

const SKILL_LABELS: Record<'claude' | 'codex', string> = {
  claude: 'Claude',
  codex: 'Codex',
};

export function checkVersions(inputs: VersionInputs): VersionCheckResult {
  const mismatches: VersionMismatch[] = [];

  if (inputs.engineSourceVersion !== null && inputs.engineSourceVersion !== inputs.packageVersion) {
    mismatches.push({
      kind: 'build',
      a: inputs.packageVersion,
      b: inputs.engineSourceVersion,
      hint: 'package.json 과 engine/version.json 버전이 다릅니다 — 설치가 손상됐을 수 있습니다. 재설치하세요.',
    });
  }

  if (
    inputs.installedEngineVersion !== null &&
    inputs.installedEngineVersion !== inputs.packageVersion
  ) {
    mismatches.push({
      kind: 'binary-vs-engine',
      a: inputs.packageVersion,
      b: inputs.installedEngineVersion,
      hint: '설치된 엔진(~/.awl/engine)이 실행 바이너리와 다릅니다. awl update 로 엔진을 갱신하세요.',
    });
  }

  if (
    inputs.projectEngineVersion !== null &&
    inputs.installedEngineVersion !== null &&
    inputs.projectEngineVersion !== inputs.installedEngineVersion
  ) {
    mismatches.push({
      kind: 'project-vs-engine',
      a: inputs.projectEngineVersion,
      b: inputs.installedEngineVersion,
      hint: `이 프로젝트는 ${inputs.projectEngineVersion} 기준으로 설정됐으나 엔진은 ${inputs.installedEngineVersion}입니다. awl update 후 awl init 으로 스킬을 재설치하세요.`,
    });
  }

  for (const skill of ['claude', 'codex'] as const) {
    const skillVersion = inputs.installedSkillVersions[skill];
    if (
      skillVersion !== null &&
      inputs.installedEngineVersion !== null &&
      skillVersion !== inputs.installedEngineVersion
    ) {
      mismatches.push({
        kind: `${skill}-skill-vs-engine`,
        a: skillVersion,
        b: inputs.installedEngineVersion,
        hint: `설치된 ${SKILL_LABELS[skill]} 스킬이 ${skillVersion} 기준입니다. 엔진은 ${inputs.installedEngineVersion}입니다. awl init 으로 스킬을 재설치하세요.`,
      });
    }
  }

  return { ok: mismatches.length === 0, mismatches };
}
