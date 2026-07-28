---
name: awl
description: |
  "/awl" — 얇은 오케스트레이션 스킬(ADK 0.8.0, WI-H2). `awl next`(무인자, "지금"
  티켓 자동판정)가 매번 다음에 뭘 할지 계약을 통째로 낸다 — 이 스킬은 그 출력을
  그대로 따르기만 한다. `/awl-loop`(완료조건 단위 레거시 흐름)와 별개로 병행한다.
  미발동: `/awl-loop`가 이미 담당하는 완료조건 단위 작업, awl 명령 단발 실행만.
---

# awl — 얇은 오케스트레이션 스킬

지시는 CLI 가 만든다. 이 스킬은 세 줄이면 된다(adk-prototype.md:330-332).

1. 목표를 받으면 `awl next` 를 호출한다.
2. 출력에 다음에 할 일과 그 방법이 있다. 그대로 따른다. `skill` 줄이 채워져 있으면
   그 파일을 읽는다. 비어 있으면(`skill (없음)`) 계약만 보고 알아서 한다.
3. 끝나면 `awl record`(finding/clarification/attempt 등, 상황에 맞는 타입)로 결과를
   남기고 다시 `awl next` 를 부른다.

**게이트는 사람이 멈추는 자리다.** `awl next` 출력의 "게이트 N 에 도달하려면" 목록이
채워졌으면, 그 게이트에 해당하는 `awl record gate --json '{...}'` 를 기록하기 전에
`state.json` 의 `mode`(strict/semi-auto/auto, `awl state get`)를 확인한다 — `strict`
이거나 mode 가 없으면 `AskUserQuestion` 으로 사람에게 승인을 받은 뒤 기록한다.
`semi-auto`/`auto` 면 게이트 2·3 은 승인을 묻지 않고 `"auto":true` 를 남겨 자동
승인한다(게이트 1·4 는 모든 모드에서 사람에게 묻는다 — 티켓 확정과 요청 닫기는
자주 있는 일이 아니다).

**단계를 하나씩 지시받지 않는다.** 조사부터 하든 코드를 먼저 읽든 사람에게 먼저
묻든 상관없다 — 게이트에 도달할 때 `awl next` 가 요구한 형식(finding/clarification/
verification, 또는 커밋)만 맞으면 된다.

**티켓이 없으면 먼저 만든다.** `awl next` 가 "진행할 티켓을 찾지 못했습니다"라고
하면, 목표를 스펙으로 옮긴다: `awl doc new spec <제목> --request "<원문>"` →
Conditions/Constraints 채우기 → `awl tickets derive <spec-id>` → 다시 `awl next`.

**전체 파이프라인이 궁금하면** `awl stages`(전부) 또는 `awl stages --short`(다섯
줄)를 본다 — 이 스킬 파일이 다시 설명하지 않는다.
