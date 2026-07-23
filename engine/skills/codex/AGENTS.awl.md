<!-- awl-loop:start -->
## Agent Work Loop

- 발동 판정은 어떤 `awl` 명령보다 먼저 한다: 사용자가 `$awl-loop`를 명시하면 항상 발동한다.
- 자동 발동은 `AUTO-EXCLUDE-FIRST`: radius·색상 토큰·간격·문구·class처럼 대상과 결과가
  구체적이고 한두 파일에서 끝날 국소 변경, 단순 질문·설명·조사·리뷰는 발동하지 않는다.
- `AUTO-INCLUDE-AFTER-EXCLUSIONS`: 제외되지 않은 비단순 기능 목표 중 범위·완료 상태에
  조사나 설계가 필요하거나, 여러 동작·상태가 얽히거나, 원인·수정 범위가 불명확한 복합
  버그에만 자동 발동한다. 완료 조건이 없다는 사실만으로는 발동하지 않는다.
- 명령 경계는 `PRE-SELECTION-AWL=none`,
  `POST-SELECTION-FIRST-AWL=awl version-check --json`,
  `OTHER-SKILL-ONLY-AWL-VERSION-CHECK=forbidden`이다.
- 서로 독립적인 여러 워크아이템을 격리해 처리할 때는 `$awl-pipeline` 스킬을 사용한다.
- pipeline의 plan/exec/review 역할만 직접 수행할 때는 각각 `$awl-pipeline-plan`,
  `$awl-pipeline-exec`, `$awl-pipeline-review`를 사용한다.
- push는 사용자가 직접 한다.
<!-- awl-loop:end -->
