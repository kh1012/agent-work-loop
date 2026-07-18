/**
 * 파이프라인 스킬 단일 정본화 (pipeline-skill-source-unify).
 *
 * 정본 = 엔진 `engine/skills/claude/awl-pipeline-{plan,exec,review}/SKILL.md`.
 * 글로벌 `~/.claude/skills/temp-loop-{plan,exec,review}/SKILL.md` 는 여기서 파생된다.
 * 두 소스가 갈라져 크로스-세션 동작이 달라지는 드리프트를 끝내려는 목적이다 —
 * 앞으로 엔진만 고치면 이 메커니즘으로 글로벌이 따라온다(수동 반복 정합 금지).
 *
 * 파생 규칙은 단 하나: 트리거·역할명 `awl-pipeline` → `temp-loop` 치환.
 * 구현 코어 `awl-loop` 는 두 소스에서 동일하다 — `awl-pipeline` 의 부분문자열이 아니라
 * 치환에 걸리지 않는다. lane(autolane)·mode(graded)·marker(.taken) 문단은 `awl-pipeline`
 * 토큰을 담지 않으므로 그대로 보존된다 → diff 가 트리거·역할명 줄에만 국한된다(AC-01).
 */

const CANONICAL_PREFIX = 'awl-pipeline';
const DERIVED_PREFIX = 'temp-loop';

/**
 * 엔진 파이프라인 스킬 본문을 글로벌 temp-loop 본문으로 파생한다.
 * `awl-pipeline` → `temp-loop` 리터럴 치환. `awl-loop`(구현 코어)은 안 건드린다.
 */
export function deriveTempLoopContent(canonical: string): string {
  return canonical.replaceAll(CANONICAL_PREFIX, DERIVED_PREFIX);
}

/**
 * 엔진 스킬 디렉토리명 → 파생 글로벌 스킬 디렉토리명. 파생 대상이 아니면 null.
 *
 * `awl-pipeline-<role>`(plan/exec/review)만 매핑한다. 오케스트레이터 bare
 * `awl-pipeline`(mode A)은 글로벌 대응 스킬이 없어 제외되고, 구현 코어 `awl-loop` 도
 * 접두어가 달라 제외된다 — `-` 를 포함한 접두어 검사가 그 경계를 만든다.
 */
export function derivedSkillName(engineSkillName: string): string | null {
  if (!engineSkillName.startsWith(`${CANONICAL_PREFIX}-`)) {
    return null;
  }
  return deriveTempLoopContent(engineSkillName);
}
