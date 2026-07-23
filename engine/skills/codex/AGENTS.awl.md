<!-- awl-loop:start -->
## Agent Work Loop

- 완료 조건이 없는 기능 목표는 `$awl-loop` 스킬로 조사·게이트·구현·검증·기록한다.
- 서로 독립적인 여러 워크아이템을 격리해 처리할 때는 `$awl-pipeline` 스킬을 사용한다.
- pipeline의 plan/exec/review 역할만 직접 수행할 때는 각각 `$awl-pipeline-plan`,
  `$awl-pipeline-exec`, `$awl-pipeline-review`를 사용한다.
- 스킬 지침과 `awl` CLI가 충돌하면 작업을 멈추고 `awl version-check --json`과
  `awl doctor` 결과를 먼저 확인한다.
- push는 사용자가 직접 한다.
<!-- awl-loop:end -->
