# awl-loop 참조 (reference)

SKILL.md 본문에서 조건부·저빈도로 분류된 섹션의 상세. 매 완료조건마다 참조하지 않는다 — 아래 트리거 조건에 해당할 때만 Read한다.

---

### 실패 원인 판별 (이 구분이 핵심이다)

- **구현 실패** = 설계가 틀렸다.
  → `attempts` +1. 3회 미만이면 **다른 접근**으로 다시. 같은 접근을 3회 반복하지 않는다(절대 규칙 6).
  → 3회 도달하면 "막힘 처리".
- **절차적 실수** = 내가 도구를 잘못 썼다 (git 오조작, 포트 충돌, 스크립트 인자 전달 실패 등).
  → `proceduralErrors` +1. **고치고 계속한다.** `attempts` 는 올리지 않는다.
  → `awl state set --json '{"criteria":[{"id":"<AC>","proceduralErrors":N}]}'`
- **환경 문제** = 검증 환경을 신뢰할 수 없다 (전체 스위트가 대량 실패, 무관한 테스트가 깨짐 등).
  → **먼저 환경을 의심한다.** 동시 편집, 포트 충돌, 스크립트 인자 전달 실패를 배제한다.
  → 배제한 뒤에야 코드 결함으로 결론짓는다. 이건 게이트 대상이 아니다. 자율적으로 처리한다.
  → 성급히 코드 결함으로 결론짓지 마라.

---

### 막힘 처리 (3회 실패)

- `awl record blocked --diff --json '{"what":"...","why":"...","tried":[{"approach":"...","failed":"..."},{"approach":"...","failed":"..."},{"approach":"...","failed":"..."}],"lesson":"..."}'`
  - `tried` 배열이 blocked 기록의 핵심이다. 3가지 접근과 각각 **어떻게 실패했는지**를 남긴다. 이게 없으면 다음 시도가 같은 세 가지를 반복한다.
  - `--diff` 가 현재 git diff 를 캡처해 첨부한다.
- 코드를 버린다: `git checkout -- .`
- 다음 완료 조건으로 이동한다. 완료 조건을 마음대로 수정하지 않는다(절대 규칙 7).

---

### 완료 조건 3개마다 리뷰

- `awl review AC-xx..AC-yy --json` 으로 자료를 조립한다. 조립 결과에 `reviewId`(새로 발급, `rev_` 접두어)가 포함된다.
- **리뷰어를 서브에이전트로 호출한다. 구현자의 대화 맥락을 넘기지 마라.** (아래 "리뷰어" 참고)
- 리뷰어의 지적은 **새 완료 조건으로 편입**한다. 리뷰어는 코드를 고치지 않는다. 편입한 완료 조건의 `awl record criteria` 항목에 `becameCriterion` 자유 필드로 `"<reviewId> finding #1"` 처럼 원래 지적을 가리키는 값을 남겨, 나중에 어느 리뷰 지적이 어느 완료 조건이 됐는지 역추적할 수 있게 한다.
- **판정을 받으면 바로 기록한다**: `awl record review --json '{"reviewId":"<번들의 reviewId>","criteria":["AC-xx","AC-yy"],"findings":[{"severity":"medium","what":"...","evidence":"파일:줄"}],"cheatingDetected":[],"verifyPassedBefore":true}'`.
  - `criteria` 는 비어있지 않은 배열(리뷰한 완료 조건 ID들).
  - `findings`/`cheatingDetected` 는 지적·부정행위가 없으면 빈 배열이어도 된다 — 다만 반드시 **배열**이어야 한다(문자열로 뭉치지 마라, 빈 배열도 정당한 결과다).
  - `verifyPassedBefore` 는 이 리뷰 **직전**에 `awl verify` 가 이미 통과 상태였는지를 적는다. `true` 인 채로 `findings` 가 비어있지 않으면 "기계 검증은 통과했는데 리뷰가 실사고를 잡았다"는 이 시스템의 가장 강한 증거가 된다 — 아래 "narrative" 의 `reviewer-caught` 와 짝을 이룬다.
  - 이걸 빼먹으면 `awl evolve`/`awl metrics` 의 `reviewRejects` 지표가 조용히 0으로 샌다(WI-P 소급 발견 — 리뷰를 실제로 돌리고도 이 한 줄을 빼먹은 채 워크아이템을 닫을 뻔했다). `awl record gate` 로 gate:2 를 기록할 때 완료 조건 3개 이상이 통과했는데 review 기록이 하나도 없으면 경고도 뜬다(WI-S).

---

## 리뷰어

**반드시 서브에이전트(Task 도구)로 호출한다. 구현자의 대화 맥락을 넘기지 마라.** 신선한 눈으로 봐야 한다.

`awl review` 가 조립해준 자료만 준다: diff, 완료 조건, 검증 결과, **provenance**(어느 브랜치/커밋/워크트리에서 나왔는지), 해당 scope의 규칙.

**diff 컨텍스트만으로 판단이 안 서면 주저하지 말고 provenance 의 워크트리 경로에서 프로젝트 파일을 직접 읽어라.** (WI-H 실측: diff 를 미리 넓히거나 파일을 통째로 끼워 넣는 것보다, 이렇게 능동적으로 확인하라고 명시하는 쪽이 실제 결함을 더 많이 잡았다 — 특히 여러 파일에 걸친 상호작용/실행 가능성 문제는 정적 자료만으론 안 잡혔다.)

리뷰어의 임무는 **정확성 검증이 아니다.** 정확성은 `awl verify` 가 이미 판정했다. 세 가지를 한다.

### A. 부정행위 탐지 (최우선)

- `any` / `@ts-ignore` / `eslint-disable` 추가
- 테스트 삭제, assertion 제거, `skip`, 조건 완화
- **약한 단언** — 핸들러를 통째로 지워도 통과하는 테스트. 음성 조건만 확인하고 양성 조건을 확인하지 않는 함정.
- 하드코딩·스텁으로 때움 (테스트가 보는 경로만 동작)
- 완료 조건이나 스펙을 수정해 우회
- `setTimeout` 으로 타이밍 은폐
- 남의 hunk를 함께 커밋 (`awl commit` 이 막지만 리뷰어도 확인한다)
- 규칙 위반

### B. 품질 판정

형용사가 아니라 **코드 근거**로 지목한다. "가독성이 나쁘다"가 아니라 "이 함수는 X와 Y를 동시에 해서 테스트가 불가능하다".

### C. 구조 판정 (WI-I)

불필요한 추상화, 기존 패턴과의 일관성, 재사용 가능한 로직의 중복을 코드 근거로 지목한다. **숫자 임계값으로 환원하지 않는다** — "함수가 30줄을 넘으면 안 된다" 같은 기계적 규칙이 아니라, 이 변경이 실제로 이해/유지보수를 어렵게 만드는지 판단한다. 판단이 필요한 영역이라 검사기가 아니라 리뷰어의 몫이다(기계적으로 셀 수 있는 것 — 파일 크기 이상치 등 — 은 이미 `awl doctor` 가 담당한다).

리뷰어는 코드를 고치지 않는다. 지적만 한다. 지적은 새 완료 조건이 되어 루프에 편입된다.

리뷰어 서브에이전트의 완료를 사람에게 보고할 때(`@<이름> ... finished` 류 문구를 옮길 때)는 맨 앞에
`date '+[%y%m%d / %H:%M:%S]'`로 얻은 24시간제 타임스탬프(예: `[260721 / 12:42:03]`)를 붙인다. 실제
시각은 반드시 `date` 명령으로 조회한다 — 추정해서 쓰지 않는다.

---

## evolve — 배움의 흐름을 닫는다 (워크아이템 단위)

게이트 2를 통과한 뒤, 이번 워크아이템의 실패에서 교훈을 뽑는다. **awl 은 판단하지 않는다. 교훈 추출은 네가 한다.**

```
awl evolve --collect --workitem <WI>
  → 자료(blocked/review/retried/metrics/existingGotchas)를 읽는다
  → 교훈을 추출한다 (판단):
      - blocked 의 tried/lesson 에서 "무엇이 실패했는가"를 재사용 가능한 문장으로
      - 프로젝트 이름 없이, 완료 조건 ID 없이, 다음에도 쓸 수 있게
      - 나쁜 예: "AC-03에서 ComponentOverlay 수정이 실패했다"
      - 좋은 예: "축을 파라미터로 빼기 전에 오버레이 좌표계가 축에 의존하는지 먼저 확인한다"
  → 기존 gotcha(existingGotchas)와 같으면 sameAs 를 붙인다
awl evolve --record --json '{"lesson":"...","context":"...","source":{...},"sameAs":"G-003"}'
  → 2회 반복 알림이 뜨면 사용자에게 그대로 전달한다. 자동으로 promote 하지 마라.
```

`metrics`(criteriaTotal/avgAttempts/blockedRatio/reviewRejects/proceduralErrors/gotchaApplied/gotchaMissed/refactorCount)는 이 워크아이템의 세대 스냅샷으로도 남는다(`~/.awl/generations/<project>/<WI>.json`). 세대별 추세는 `awl metrics` 로 사람이 직접 본다 — 워크아이템마다 난이도가 다르니 절대 비교하지 말고 경향만 참고한다.

- 교훈은 **재사용 가능한 형태**여야 한다. `source`(추적용)는 남기되 `lesson` 본문에는 프로젝트/완료조건 이름을 넣지 않는다.
- **자동 승격하지 않는다.** `awl rules promote` 는 사람이 명시적으로 실행한다.
- blocked 가 하나도 없으면(이번에 안 막혔으면) 교훈이 없을 수 있다. 그때는 억지로 만들지 마라.
- diff에 남은 결함표시(`// lazy: ...`)를 gotcha 후보로 함께 검토한다 — 같은 표시가 워크아이템을 넘나들며 반복되면 위 2회 반복 감지가 그대로 잡는다(새 스토리지 신설 없음).

### awl 도구 자체 피드백 — gotcha 와 다르다 (0.6.x)

**gotcha 와 awl-feedback 을 섞지 마라. 저장 위치도 다르다.**
- **gotcha** = 작업하는 코드베이스에 대한 교훈. "이 슬롯을 건드리기 전에 구독 범위를 확인하라." (`~/.awl/gotchas/`)
- **awl-feedback** = awl 도구 자체가 아팠던 점. "awl commit 이 무관한 파일을 삼켰다." (`~/.awl/records/`)

`awl evolve --collect` 출력의 `awlFeedback.prompt` 를 본다. 이번 워크아이템에서 awl 도구 자체(작업 대상 코드가 아니라)가 불편했다면 남긴다:

`awl record awl-feedback --json '{"area":"commit","what":"...","impact":"...","severity":"high","suggestion":"..."}'`
- `area`: 어느 기능인가 (commit/review/gate/verify/state/init/cli/기타) — 나중에 모으기(`awl feedback-log`)의 묶는 키.
- `what`: 무슨 일이 있었나(사실). `impact`: 그래서 무엇을 해야 했나(아픔의 크기). `severity`: high/medium/low.
- `suggestion`: 선택. 개선 아이디어. 강제 아님 — 번역(패치로 바꾸기)은 사람 몫이다.

**없으면 억지로 만들지 마라 — 매끄러웠으면 그게 좋은 신호다.** awl-feedback 은 gotcha 로 승격되지 않는다(다른 종류다).

---

## narrative — 그 순간에 남긴다 (사후 재구성 아님, WI-P)

awl 은 토큰을 못 잰다. "이게 없었다면 무슨 일이 있었을지"(counterfactual)는 그 일이 일어나는 순간에만 정확하게 남길 수 있다 — 나중에 되짚으면 사후 정당화가 된다. `kind` 는 다섯 중 하나이고, 각각 파이프라인의 정해진 자리에서 발생한다.

- `gate-caught` — 게이트 1/2 승인 과정에서 뭔가를 발견해 진행/완료를 막았을 때.
- `reviewer-caught` — 리뷰어(서브에이전트)가 실사고를 발견했을 때(위 "리뷰어" 참고).
- `spike-prevented` — 스파이크가 "안 됩니다"로 잘못된 설계를 사전에 막았을 때(위 "[스파이크]" 참고).
- `blocked-discarded` — 막힘 처리로 코드를 버렸을 때(위 "막힘 처리" 참고).
- `tool-failed`(WI-W) — awl 자신의 도구가 오작동해 실사고를 냈을 때(예: `awl commit`이 "자체 검증 통과"를 보고하고도 무관한 파일을 함께 흡수한 경우). 완료 조건/리뷰/스파이크가 아니라 도구 자체의 결함이 원인일 때만 쓴다 — 발표에서 숨기지 않는다.

`awl record narrative --json '{"kind":"reviewer-caught","counterfactual":"이걸 못 잡았다면 ..."}'`

해당하는 순간이 하나도 없었으면(이번 워크아이템은 아무것도 안 막혔으면) 억지로 기록하지 않는다.
