/**
 * base→local 병합 규칙(ADK stage 4, adk-reference.md:1313-1324).
 *
 * "배열을 통째로 안 갈아끼운다" — e2e 하나 끄려고 목록 전체를 복사하게 하면 아무도
 * 제대로 안 쓴다. name 키로 병합해 local 이 지목한 항목만 덮는다.
 */

/**
 * name 키로 배열을 병합한다. local 항목이 이긴다(얕은 병합 — 필드 단위로 덮는다).
 * local 이 base 에 없는 이름을 가리키면 **무시한다** — 로컬 오버라이드는 이미 있는
 * 판정 기준을 개인 사정으로 끄거나 조정하는 통로이지, 팀과 안 나눈 새 검증을
 * 몰래 추가하는 통로가 아니다("판정 기준은 팀이 같아야 한다", reference.md:1173).
 * 새 검증을 더하려면 base(config.json)를 `config set` 으로 고친다.
 */
export function mergeByName<T extends { name: string }>(
  base: readonly T[],
  local: readonly Partial<T>[] | undefined,
): T[] {
  if (!local || local.length === 0) {
    return base.map((b) => ({ ...b }));
  }
  return base.map((b) => {
    const patch = local.find((p) => p.name === b.name);
    return patch ? { ...b, ...patch } : { ...b };
  });
}

/** 고정 슬롯 객체를 키 단위로 깊게 병합한다 — local 에 있는 슬롯만 덮는다. */
export function mergeSlots<K extends string, V>(
  base: Record<K, V>,
  local: Partial<Record<K, V>> | undefined,
): Record<K, V> {
  if (!local) {
    return { ...base };
  }
  return { ...base, ...local };
}
