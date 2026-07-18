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
  /** npm 레지스트리에서 조회한 최신 배포 버전(null=미조회/조회실패). AC-01(npm-registry.ts)의 결과값. */
  npmLatestVersion: string | null;
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

/**
 * "새 버전이 나왔다"는 정보성 안내(WI-npm-update-notice AC-02). mismatches 와 다른 성격이다 —
 * mismatches 는 "설치가 깨졌나"(계속할지 사람에게 묻고 audit 기록 요구), 이건 "npm에 새
 * 배포가 있다"(그냥 알림). 그래서 별도 필드로 둔다 — mismatches 배열에 섞지 않는다.
 */
export interface UpdateAvailable {
  current: string;
  latest: string;
  hint: string;
}

export interface VersionCheckResult {
  ok: boolean;
  mismatches: VersionMismatch[];
  /** 새 npm 배포가 있을 때만 채워진다. mismatches 와 섞이지 않는 별도 필드. */
  updateAvailable?: UpdateAvailable;
}

const UPDATE_HINT = 'npm i -g agent-work-loop@latest 로 갱신하세요.';

/**
 * "x.y.z" 앞부분만 파싱한다(release.mjs 의 `/^(\d+)\.(\d+)\.(\d+)/` 패턴과 동일).
 * 파싱 불가하면 null — 비교 불가 상황은 항상 "모른다"로 취급한다(fail-safe).
 */
function parseSemver(version: string): [number, number, number] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!m) {
    return null;
  }
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** a 가 b 보다 순서상 진짜로 큰지. 같거나 작으면 false(다운그레이드 후보를 걸러낸다). */
function isNewerSemver(a: [number, number, number], b: [number, number, number]): boolean {
  if (a[0] !== b[0]) return a[0] > b[0];
  if (a[1] !== b[1]) return a[1] > b[1];
  if (a[2] !== b[2]) return a[2] > b[2];
  return false;
}

/**
 * 순수. semver 순서 비교로 판정한다 — 문자열 부등호(`!==`)가 아니다.
 * npmLatestVersion 이 없거나(null), semver 로 파싱 불가하거나, current 를 파싱 못 하거나,
 * current 보다 크지 않으면(같거나 낮으면) undefined — fail-safe: "모르면 표시 안 함" 방향으로만
 * 기운다(네트워크 실패 시 null 반환하는 기존 패턴과 대칭. 실측: registry 가 아직 배포 안 된
 * placeholder(예: 0.0.0)를 돌려주면 문자열 비교만으론 다운그레이드를 "업데이트"로 오탐한다).
 * program.ts(--version)와 checkVersions 가 같은 안내 문구를 쓰도록 여기 하나로 모은다
 * (G-052 — 같은 안내가 여러 표면에서 서로 다른 처방을 내지 않게).
 */
export function computeUpdateAvailable(
  current: string,
  npmLatestVersion: string | null,
): UpdateAvailable | undefined {
  if (npmLatestVersion === null) {
    return undefined;
  }
  const latestParsed = parseSemver(npmLatestVersion);
  const currentParsed = parseSemver(current);
  if (latestParsed === null || currentParsed === null) {
    return undefined;
  }
  if (!isNewerSemver(latestParsed, currentParsed)) {
    return undefined;
  }
  return { current, latest: npmLatestVersion, hint: UPDATE_HINT };
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
      hint: `이 프로젝트는 ${inputs.projectEngineVersion} 기준으로 설정됐으나 엔진은 ${inputs.installedEngineVersion}입니다. awl init --yes 로 프로젝트·스킬 버전을 엔진에 맞춰 동기화하세요.`,
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
        hint: `설치된 ${SKILL_LABELS[skill]} 스킬이 ${skillVersion} 기준입니다. 엔진은 ${inputs.installedEngineVersion}입니다. awl init --yes 로 스킬을 재설치·동기화하세요.`,
      });
    }
  }

  return {
    ok: mismatches.length === 0,
    mismatches,
    updateAvailable: computeUpdateAvailable(inputs.packageVersion, inputs.npmLatestVersion),
  };
}
