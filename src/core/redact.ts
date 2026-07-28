/**
 * 절대경로를 상대화한다(홈 디렉토리·프로젝트 루트 → 플레이스홀더). 순수 함수.
 *
 * auto-feedback.ts(도구 오류 자동수집)와 record.ts(사람이 직접 남기는
 * awl-feedback) 양쪽이 같은 함수를 쓴다 — 둘 중 한쪽에만 두면 다른 경로는
 * 방어가 없다.
 */
export function redactAbsolutePaths(
  text: string,
  home: string,
  projectRoot: string | null,
): string {
  let out = text;
  if (projectRoot && projectRoot.trim() !== '') {
    out = out.split(projectRoot).join('<project>');
  }
  if (home.trim() !== '') {
    out = out.split(home).join('<home>');
  }
  return out;
}
