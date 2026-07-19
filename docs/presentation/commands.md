# awl 명령어 레퍼런스

`storyline.md`가 왜/무엇인지를 다룬다면, 이 문서는 실제로 손에 잡히는 명령 전부를 다룬다. 모든 출력은 이 저장소(`agent-work-loop`, 버전 0.6.18)에서 2026-07-19에 실제로 실행한 결과다. 길면 자르고 "(생략)"이라고 표시했다. 색이 없는 터미널에서 실행했기 때문에 `[ok]`/`[!]`/`[x]` 같은 텍스트 마커가 그대로 보인다 — 이것도 실제 출력이다.

`awl --help`에 노출되는 명령은 18개다. 이 중 `commit`/`review`는 사람이 직접 칠 수도 있지만 실제로는 awl-loop 스킬이 루프 중 자동으로 호출하는 경우가 대부분이라 "스킬용" 쪽에 묶었다. `--help`에 안 나오는(hidden) 명령이 6개 더 있다 — `record`/`verify`/`state`/`evolve`/`defer-summary`/`hold-recheck`. 전부 합쳐 24개다. 형식은 전부 같다: **역할 / 언제 쓰나 / 실행+실제출력 / 읽는법**.

---

## 사람용 명령

### `awl init`

- **역할**: 이 프로젝트에 awl을 설정한다. `~/.awl`이 없으면 만들고, `.awl/config.json`을 만들고, 선택한 에이전트(Claude Code/Codex)에 스킬을 설치한다.
- **언제 쓰나**: 새 프로젝트에서 딱 한 번. 스킬이 갱신됐는데 설치본이 낡았을 때 재실행(스킬 재설치).
- **실행+실제출력**(`--yes`로 비대화형 실행, 스크래치 프로젝트):
  ```
  $ awl init --yes

  +- 설정 완료 ---------------------------------------------------------------+
  |    ~/.awl              생성됨                                             |
  |    ~/.awl/engine       0.6.18                                             |
  |    .awl/config.json    생성됨    <- 커밋하세요. 팀원은 이 파일을 씁니다   |
  |    .awl/state.json     gitignore 에 추가함    [ok] git push 차단 훅 설치  |
  |  규칙 0개 · 교훈 0개 · 등록된 프로젝트 1개 · 1세대                        |
  +---------------------------------------------------------------------------+

  +- 다음 단계 ----------------------------------------------------+
  |  Claude Code 를 열고 이렇게 말하세요.                          |
  |                                                                |
  |  /awl-loop  페이지 편집기에 여백 시스템을 넣고 싶어            |
  +----------------------------------------------------------------+
  ```
- **읽는법**: `git push 차단 훅 설치`가 이번 조회에서 새로 확인한 부분이다 — `awl init`이 `.git/hooks/pre-push`에 훅을 심어서, `AWL_ALLOW_PUSH=1` 없이는 `git push` 자체가 막힌다("절대 규칙 10: push는 사람이 한다"를 git 레벨에서도 강제). 대화형 모드는 `--yes` 없이 실행하면 3단계 화면(주 언어 → 검증 명령어 → 규칙과 프로젝트 성격)과 스킬 설치 화면을 순서대로 보여준다.

### `awl status`

- **역할**: 지금 어느 워크아이템의 어느 단계인지 한 화면에 모은다.
- **언제 쓰나**: 세션을 다시 열었을 때, "내가 어디까지 했더라" 확인할 때.
- **실행+실제출력**:
  ```
  $ awl status

  +- 진행 상황 · 1세대 -----------------------------------------------------------------------------+
  |  단계  loop  awl-team-storyline                                                                 |
  |  |-- 완료 조건  1/8 통과  (막힘 0, 진행 0, 대기 6)                                              |
  |  |   `-- [!] AC-02 블록됨  (대기: AC-01)
  ...
  |  `-- 최근 검증  passed                                                                          |
  |      `-- 게이트 1  approved (자동)   2026-07-19 09:16   완료조건 8개, 제외 1건                  |
  |      `-- [i] 게이트 2  대기중                                                                   |
  +-------------------------------------------------------------------------------------------------+
  ```
- **읽는법**: `dependsOn`이 안 끝난 완료 조건은 "블록됨"으로 뜬다(계산만 — 순서 판단은 스킬 몫). `--pipeline`을 붙이면 `.awl-worktrees/*` 레인들의 plan/exec/review 상태를 배지(pending/executing/reviewing/complete/blocked)로 모아 보여준다. `--archive`(파이프라인과 함께)는 유예기간(3일) 지난 완료 workitem을 `.tasks/archive/`로 옮긴다.

### `awl brief`

- **역할**: KST 오늘(또는 `--date`) 하루의 진행분을 모아 낸다.
- **언제 쓰나**: 하루 마무리, 또는 다른 세션에 오늘 뭘 했는지 넘겨줄 때.
- **실행+실제출력**:
  ```
  $ awl brief
  2026-07-19 (KST) — records 140 · commits 37 · criteria 8 · verify 0
  ```
- **읽는법**: `--json`을 붙이면 레코드별 상세(type/workitem/at/summary)가 배열로 나온다 — 스킬이 이 형태로 소비한다.

### `awl doctor`

- **역할**: 설치와 환경을 점검한다. **아무것도 고치지 않는다.**
- **언제 쓰나**: awl-loop 스킬이 파이프라인을 시작하기 전에 항상. 뭔가 이상할 때 제일 먼저.
- **실행+실제출력**(이 저장소, 초기화 전 스크래치 프로젝트에서):
  ```
  $ awl doctor

  +- Agent Work Loop · 진단 ------------------------------------------------------------------+
  |  환경
  |  |-- Node: v22.22.2  [ok]
  |  |-- 플랫폼: darwin arm64  [ok]
  |  `-- 터미널: 유니코드 미지원, 색 미지원  [ok]
  |
  |  전역 설치
  |  `-- ~/.awl: 없음  [x] awl init 을 실행하세요
  |
  |  이 프로젝트
  |  |-- 프로젝트 루트: (생략)
  |  |-- 브랜치: main
  |  |-- 워킹트리: 미커밋 변경 1개  [!] package.json
  |  `-- config.json: 없음  [x] awl init 을 실행하세요
  |
  |  에이전트
  |  |-- Claude Code: 없음
  |  |-- Codex: 없음
  |
  |  [x] 문제 2개. awl init 을 실행하세요.
  +-------------------------------------------------------------------------------------------+
  ```
- **읽는법**: `[ok]`/`[!]`/`[x]` 세 등급이다. `[x]`는 반드시 조치, `[!]`는 판단 필요(경고), `[ok]`는 그냥 진행. **워킹트리 상태는 doctor가 직접 `git status`를 친 결과만 믿는다** — 대화·환경이 준 요약을 믿지 말라고 awl-loop 스킬이 못박는다.

### `awl version-check`

- **역할**: `package.json` vs 설치된 엔진, 설치된 엔진 vs 실행 바이너리, 프로젝트 config vs 엔진, 설치된 스킬 vs 엔진 — 4쌍의 버전 불일치를 검사한다.
- **언제 쓰나**: awl-loop 파이프라인을 시작하기 전(워킹트리 확인보다도 먼저). `awl --version`이 노란색 경고를 띄웠을 때.
- **실행+실제출력**(이 저장소, 2026-07-19):
  ```
  $ awl version-check --json
  {
    "ok": false,
    "mismatches": [
      {"kind":"binary-vs-engine","a":"0.6.18","b":"0.6.16","hint":"설치된 엔진(~/.awl/engine)이 실행 바이너리와 다릅니다. awl update 로 엔진을 갱신하세요."},
      {"kind":"project-vs-engine","a":"0.6.13","b":"0.6.16","hint":"이 프로젝트는 0.6.13 기준으로 설정됐으나 엔진은 0.6.16입니다. awl init --yes 로 동기화하세요."},
      {"kind":"claude-skill-vs-engine","a":"0.6.13","b":"0.6.16","hint":"설치된 Claude 스킬이 0.6.13 기준입니다. 엔진은 0.6.16입니다. awl init --yes 로 재설치·동기화하세요."}
    ]
  }
  ```
- **읽는법**: 이 저장소 자신도 지금 세 쌍이 어긋나 있다(그대로 보여준다). `ok:false`라고 무조건 멈추는 게 아니다 — awl은 판단하지 않으니 강제로 막지 않는다. 계속 진행하기로 하면 그 판단 근거를 `awl record audit`에 남기는 게 awl-loop 스킬의 규칙이다. `updateAvailable` 필드가 있으면(npm에 새 배포가 나온 경우) 이건 `mismatches`와 다르게 정보로만 취급한다 — 설치가 깨진 게 아니라 새 버전이 있다는 뜻이다.

### `awl update`

- **역할**: 설치된 엔진(`~/.awl/engine`)을 실행 바이너리 버전으로 갱신한다.
- **언제 쓰나**: `version-check`의 `binary-vs-engine` 불일치를 해소할 때.
- **실행**: `awl update` (인자 없음). 프로젝트 설정은 건드리지 않는다 — 전역 엔진만 갱신한다.
- **읽는법**: `awl init --yes`와 헷갈리기 쉽다. `update`는 전역 엔진만, `init --yes`는 이 프로젝트의 config/스킬까지 동기화한다.

### `awl config`

- **역할**: 이 프로젝트의 검증 명령과 설정을 본다(TTY면 수정도).
- **언제 쓰나**: 검증 명령이 바뀌었을 때, 모노레포에서 패키지별 `cwd`를 지정할 때.
- **실행+실제출력**:
  ```
  $ awl config

  +- agent-work-loop 설정 ------------------------------------------------+
  |  |-- 주 언어  typescript
  |  |-- 성격     (없음)
  |  |-- 엔진     0.6.13
  |
  |  |-- typecheck tsc --noEmit
  |  |-- lint      biome check .
  |  |-- test      vitest run
  |  |-- e2e       (없음)
  |
  |  `-- 명령을 바꾸려면: awl config set verify.lint.cmd "biome check ."
  |      직접 편집도 됩니다: .awl/config.json
  +-----------------------------------------------------------------------+
  ```
- **읽는법**: `config set <key> <value>`로 값을 하나씩 바꾼다(`--force` 없이는 존재하지 않는 `cwd`를 저장하지 않는다). 인자 없이 TTY에서 실행하면 항목을 골라 고치는 대화형 화면이 뜬다.

### `awl work`

- **역할**: 이 프로젝트의 워크아이템(작업 단위)을 만들고 전환한다.
- **언제 쓰나**: `[조사]`를 시작하기 전에 항상(`work new`). 다른 작업으로 옮겨갈 때(`work switch`).
- **실행+실제출력**:
  ```
  $ awl work list

  +- 워크아이템 -------------------------------------------------------------------------------------+
  |  * awl-team-storyline                   active  1/8 통과  main
  |    WI-D                                 paused  12/12 통과
  |    awl-uninstall-reset                  paused  6/7 통과  main
  (생략 — 총 70여개)
  +-------------------------------------------------------------------------------------------------+
  ```
- **읽는법**: `*`가 지금 활성 워크아이템이다. `new <id> [설명]`은 새로 만들고 전환(현재 것은 자동으로 `paused`로 보관, 삭제 아님). `--worktree`를 붙이면 격리된 git 워크트리에서 시작한다(다른 워크아이템의 미커밋 변경과 안 섞인다). `--isolated`는 `~/.awl` records까지 이 워크아이템 전용으로 격리한다(병렬 세션용). `abandon <id>`는 중단 표시(기록은 남는다). `done <id>`는 완료된 워크아이템의 워크트리를 회수한다.

### `awl lane`

- **역할**: 파이프라인용 격리 레인(워크트리+전용 `AWL_HOME`+스킬 재설치)을 만들고 관리한다. 내부적으로 `work new --worktree --isolated`를 재사용한다.
- **언제 쓰나**: 여러 워크아이템을 동시에 격리해서 돌리고 싶을 때(3절 "언제 쓰는가"의 3단).
- **실행+실제출력**:
  ```
  $ awl lane ls

  +- 레인 -----------------------------------------+
  |  [i] 레인이 없습니다.
  |
  |  awl lane new <name> 로 격리 레인을 만드세요.
  +------------------------------------------------+
  ```
- **읽는법**: `new <name> [설명]`이 레인을 만든다. `rm <name>`은 워크트리를 회수하고 디렉토리를 지운다 — 미머지 커밋이 있으면 `--force` 없이는 거부한다(커밋 손실 방지).

### `awl records`

- **역할**: 쌓인 기록을 사람이 읽는 목록으로 본다.
- **언제 쓰나**: 무슨 일이 있었는지 훑어볼 때. `--type`/`--workitem`으로 좁혀서.
- **실행+실제출력**:
  ```
  $ awl records --type narrative --workitem WI-P --json
  ```
  (2절 `WI-P`의 `reviewer-caught`/`spike-prevented` narrative 3건이 그대로 나온다 — storyline.md 7절에 인용한 원문의 출처가 이 명령이다.)
- **읽는법**: `--type`은 `attempt`/`blocked`/`gate`/`review`/`narrative`/`awl-feedback`/`audit`/`criteria`/`decision`/`clarify`/`spike`/`refactor`/`gotcha-applied`/`gotcha-missed`/`defer` 등을 받는다.

### `awl rules`

- **역할**: 이 프로젝트에 적용되는 규칙(승격된 gotcha)을 본다.
- **언제 쓰나**: `[조사]` 단계에서 (`--scope audit`), 구현 전 확인.
- **실행+실제출력**:
  ```
  $ awl rules --json
  {"rules":[],"warnings":[]}
  ```
- **읽는법**: 이 프로젝트는 지금 규칙이 0건이다 — storyline.md 5절/8절에서 정직하게 다룬 그대로다. `rules edit`으로 규칙을 고치고, `rules promote <gotcha-id>`로 gotcha를 규칙으로 승격한다(자동 승격 없음, 사람이 실행).

### `awl gotchas`

- **역할**: 아직 규칙이 되지 않은 교훈(gotcha) 목록을 본다.
- **언제 쓰나**: 완료 조건마다 구현 시작 전, 적용 가능한 교훈이 있는지 훑을 때.
- **실행+실제출력**:
  ```
  $ awl gotchas --json
  ```
  75건(이 조회 시점). 예: `G-001` — "구현 시작 전 작업트리 git status를 실제 git 바이너리로 확인한다. 다른 세션의 무관한 미커밋 변경이 이미 섞여 있으면, 내 변경이 끝난 뒤 격리 커밋 단계에서 hunk가 겹쳐 자동 커밋이 거부될 수 있다."
- **읽는법**: 각 항목엔 `count`(반복 횟수)가 있다. 2번 반복되면 `awl evolve`가 승격 후보로 알려준다.

### `awl metrics`

- **역할**: 워크아이템(세대)별 지표 추세를 본다 — `criteriaTotal`/`avgAttempts`/`blockedRatio`/`reviewRejects`/`proceduralErrors`/`gotchaApplied`/`gotchaMissed`/`refactorCount`. 토큰을 직접 재는 게 아니라 대리 지표다.
- **언제 쓰나**: 워크아이템을 마친 뒤 이번 작업이 얼마나 매끄러웠는지 볼 때.
- **실행+실제출력**(초기 세대 하나):
  ```
  $ awl metrics --json
  {"generations":[{"workitem":"WI-B","at":"2026-07-14T12:59:59.177Z","criteriaTotal":11,"avgAttempts":0.73,"blockedRatio":0,"reviewRejects":2,"proceduralErrors":4, ...}, ...]}
  ```
- **읽는법**: `--compare`로 실험 케이스(모델/모드/작업유형)별 비교를 본다. 워크아이템마다 난이도가 다르니 세대 간 단순 비교는 조심하라고 스킬 문서가 못박는다.

### `awl loop-summary`

- **역할**: 루프/파이프라인 완료를 4렌즈(개입·품질·효율·산출)로 요약한다.
- **언제 쓰나**: 워크아이템 하나가 끝난 뒤 전체를 한눈에 볼 때.
- **실행+실제출력**(이 워크아이템, 진행 중 시점):
  ```
  $ awl loop-summary --json
  {
    "workitem": "awl-team-storyline",
    "intervention": {"autonomous":1,"humanInterventions":0,"humanGateCount":0,"deferCount":0,"unmannedRate":100},
    "quality": {"reviewCount":0,"reviewRejects":0,"blocked":0,"avgAttempts":0,"implementationFailures":0,"proceduralErrors":0},
    "efficiency": {"durationMs":423134},
    "output": {"passedCriteria":0,"totalCriteria":8,"commits":1,"gotchaApplied":1,"gotchaMissed":0,"exclusions":1}
  }
  ```
- **읽는법**: `unmannedRate`가 게이트를 얼마나 자율로 통과했는지(자동 승인 비율)를 보여준다.

### `awl feedback`

- **역할**: awl 도구 자체에 대한 피드백(코드 교훈이 아니라 "도구가 아팠던 점")을 area별로 묶어 본다. 해법은 제시하지 않는다.
- **언제 쓰나**: awl 자신을 고칠 재료를 찾을 때.
- **실행+실제출력**:
  ```
  $ awl feedback --json
  {"collectedFrom":30,"areas":{"cli":{"count":3,"repeated":true,"items":[...]}, "review":{...}, ...}}
  ```
- **읽는법**: `area`는 commit/review/gate/verify/state/init/cli/기타로 나뉜다. `repeated:true`면 같은 area에서 피드백이 반복됐다는 뜻이다.

### `awl changelog`

- **역할**: 게이트 2 승인 뒤 `CHANGELOG.md`에 옮겨 적을 초안을 만든다. **파일을 직접 쓰지는 않는다.**
- **언제 쓰나**: 워크아이템이 끝나고 CHANGELOG를 정리할 때.
- **실행+실제출력**(게이트 2 승인 전이라 아직 초안이 없다):
  ```
  $ awl changelog
    [!] Gate 2 승인 뒤에만 CHANGELOG 초안을 만듭니다.
  ```
- **읽는법**: 게이트 2 기록이 있어야 초안이 나온다 — 완료 안 된 작업이 CHANGELOG에 조용히 새는 걸 막는다.

---

## 스킬/에이전트용 명령

사람이 못 칠 명령은 아니지만, 실제로는 awl-loop 스킬이 루프를 도는 동안 에이전트가 호출한다.

### `awl commit`

- **역할**: 완료 조건 작업을 **내 변경만** 격리 커밋한다. 남의 미커밋 변경과 섞이면 커밋하지 않고 알린다.
- **언제 쓰나**: `commit --start <AC>`로 베이스라인을 잡고, 구현 후 `commit <AC> -m "..."`로 닫는다.
- **실행+실제출력**(이 워크아이템 AC-01 실제 커밋):
  ```
  $ awl commit AC-01 -m "docs(presentation): storyline.md 8절 초안 ..."
    커밋할 내 변경:
      + docs/presentation/storyline.md
    제외(남의 미커밋 변경, 워킹트리에 그대로 둡니다):
      - .gitignore
      - docs/presentation-source.md

    [ok] 커밋됨: 7b5709e7c5
      docs(presentation): storyline.md 8절 초안 ...
    내부 검증: 스테이징한 내용 그대로 커밋됨.
  ```
- **읽는법**: "제외" 줄이 이 명령의 핵심이다 — 이 저장소에 실제로 있던(`.gitignore`, `docs/presentation-source.md`) 무관한 미커밋 변경을 자동으로 걸러냈다. "내부 검증" 문구는 1절/7절에서 다룬 D-36 사고 이후 정정된 표현이다(스테이징한 그대로 커밋되는 동어반복이라는 사실을 숨기지 않는다).

### `awl review`

- **역할**: 리뷰어에게 넘길 자료(diff, 완료 조건, 검증 결과, provenance, 관련 규칙)를 조립한다.
- **언제 쓰나**: 완료 조건 3개마다.
- **실행**: `awl review AC-01..AC-03 --json` — 새 `reviewId`(`rev_` 접두어)가 발급된다.
- **읽는법**: 조립만 하지 판정은 안 한다 — 판정(부정행위/품질/구조)은 서브에이전트로 띄운 리뷰어가 하고, 그 결과를 `awl record review`로 기록한다.

### `awl record` (hidden)

- **역할**: 구조화된 기록을 남긴다. `--type` 자리에 `audit`/`criteria`/`gate`/`attempt`/`blocked`/`review`/`narrative`/`gotcha-applied`/`gotcha-missed`/`refactor`/`decision`/`clarify`/`spike`/`awl-feedback` 등이 온다.
- **언제 쓰나**: 파이프라인의 거의 매 단계.
- **실행**: `awl record audit --json '{"scope":"...","findings":[{"id":"F-01","what":"...","severity":"high"}]}'`
- **읽는법**: 활성 워크아이템이 없으면 거부한다(기록이 어느 워크아이템 것인지 못 정하면 안 남긴다). `--workitem`으로 다른 워크아이템에 남길 수 있다.

### `awl verify` (hidden)

- **역할**: `.awl/config.json`의 검증 명령(typecheck/lint/test/e2e)을 순서대로 실행한다. **유일한 심판이다.**
- **언제 쓰나**: 구현 하나가 끝날 때마다.
- **실행+실제출력**(이 워크아이템, AC-01 커밋 직후):
  ```
  $ awl verify --json
  {"results":[
    {"name":"typecheck","exitCode":0,"durationMs":1156,"output":"","timedOut":false},
    {"name":"lint","exitCode":0,"durationMs":190,"output":"Checked 88 files in 65ms. No fixes applied.","timedOut":false},
    {"name":"test","exitCode":0,"durationMs":7067,"output":"(생략 — 1023 테스트 통과)","timedOut":false}
  ]}
  ```
- **읽는법**: `--since-baseline`은 베이스라인 대비 새로 생긴 실패만 회귀로 판정한다(원래 있던 실패와 구분). `--related`는 변경 파일에 관련된 테스트만 돌린다(폴백 있음).

### `awl state` (hidden)

- **역할**: 루프 상태(`phase`/`workitem`/`criteria`/게이트 기록)를 읽고 쓴다.
- **언제 쓰나**: 완료 조건을 등록할 때(`state set`), 다음에 뭘 할지 정할 때(`state get`).
- **실행**: `awl state set --json '{"phase":"awaiting-gate1","criteria":[...]}'`
- **읽는법**: `phase:"loop"`로의 전환은 게이트 1 기록이 없으면 코드로 거부된다(storyline.md 6절의 핵심 근거).

### `awl evolve` (hidden)

- **역할**: 이번 워크아이템의 기록을 모아(`--collect`) 재사용 가능한 교훈으로 뽑고, gotcha로 기록한다(`--record`).
- **언제 쓰나**: 게이트 2를 통과한 뒤, 워크아이템을 닫기 전.
- **실행**: `awl evolve --collect --workitem <WI>` 다음 `awl evolve --record --json '{"lesson":"...","context":"...","source":{...}}'`
- **읽는법**: 같은 교훈이 2번 반복되면 알림이 뜨지만, 규칙으로 자동 승격하지 않는다 — `awl rules promote`는 사람이 직접 실행한다.

### `awl defer-summary` (hidden)

- **역할**: pipeline `gate-medium` 모드에서 큐에 쌓인 "사람 최종 확인 항목"을 사이클 끝에 한 번에 요약한다.
- **언제 쓰나**: pipeline 오케스트레이터가 한 사이클을 마칠 때.
- **실행**: `awl defer-summary --json --workitem <wi>`
- **읽는법**: `gate-high`(기본)에서는 안 쓰인다 — 게이트를 전부 사람에게 묻기 때문에 defer 큐 자체가 안 생긴다.

### `awl hold-recheck` (hidden)

- **역할**: `.tasks/plan`의 의존형 hold(`.hold.md`)를 재점검해, 의존 워크아이템이 착지+합격했으면 자동으로 un-hold(`.hold.md` → `.md`)한다.
- **언제 쓰나**: pipeline exec 세션이 유휴로 넘어가기 직전(신규 착수·피드백 처리가 둘 다 없을 때).
- **실행+실제출력**:
  ```
  $ awl hold-recheck --json
  Usage: awl hold-recheck [options]
  .tasks/plan 의 의존형 hold 를 재점검해 착지+합격한 의존이면 자동 un-hold 합니다
  ```
- **읽는법**: storyline.md 6절에서 다룬 `pipeline-hold-recheck`(커밋 `c3a58df`) 실증의 핵심 명령이다. 사람이 파일명을 손으로 바꾸지 않아도, 의존이 끝나는 순간 같은 턴에 자동으로 풀린다.

---

## 스킬 (Claude Code — `.claude/skills/`, 원본은 `engine/skills/claude/`)

**주의**: 이 저장소 자신의 `.claude/skills/`는 이번 조회 시점(0.6.18) 기준 0.6.13 상태로 뒤처져 있었다(`awl doctor`가 `claude-skill-vs-engine` 불일치로 경고한 그대로). 아래 설명은 뒤처진 설치본이 아니라 **`engine/skills/claude/`(현재 배포 원본)**를 기준으로 썼다 — pipeline은 이 세션 동안 여러 차례 바뀌었고(mode 어휘 개명, hold-recheck 추가, 워처 symlink 수정 등), 설치본을 그대로 옮기면 낡은 내용이 된다.

### `/awl-loop`

- **역할**: 워크아이템 하나의 생애를 처음부터 끝까지 진행한다 — 조사부터 게이트 2, evolve까지.
- **언제 쓰나**: 완료 조건이 여러 개인 작업(3절의 2단). 목표를 서술문으로 주면 스킬이 완료 조건으로 번역한다.
- **트리거**: `/awl-loop`, "이 기능 구현하자", 완료 조건 없는 목표 서술문.
- **읽는법**: 게이트에서 `AskUserQuestion` 도구를 실제로 호출한다("텍스트로 '승인을 기다립니다'라고 쓰고 넘어가면 이 스킬은 실패한 것이다" — `engine/skills/claude/awl-loop/SKILL.md:128` 근처). 자율 구간은 게이트 1 이후부터다.

### `/awl-pipeline`

- **역할**: 오케스트레이터. plan 역할로 진입해 exec·review를 백그라운드 LLM CLI 에이전트로 스폰하고, 한 레인의 파이프라인을 무인으로 돌린다.
- **언제 쓰나**: 여러 워크아이템을 동시에 격리해서 돌리고 싶을 때(3절의 3단). 사람은 목표만 던진다.
- **트리거**: `/awl-pipeline [레인] [모드]`.
- **읽는법**: 첫 인자가 레인 이름, `.`(cwd를 단일 레인으로), 인자 없음(자동 레인 `unknown-lane-<N>` 생성), 또는 mode 토큰만 온 경우(자동 레인 + 그 모드) 넷 중 하나로 해석된다. mode는 `gate-high`(기본, 매 게이트 사람 승인) / `gate-medium`(승인 자동, high만 최종 요약) / `gate-low`(전부 자율) 세 단계다 — 방향 규약은 "높을수록 게이트가 많다". `awl`은 스폰하지 않는다는 게 이 스킬의 경계다(스폰은 스킬 몫, awl은 설치·데이터만).

### `/awl-pipeline-plan`

- **역할**: 사람이 준 목표를 `.tasks/plan/<name>.md` 일감 문서로 구조화한다. exec가 `/awl-loop`로 자율 구현할 수 있게 완료 조건·범위·검증 힌트를 명시한다.
- **언제 쓰나**: pipeline의 plan 역할 세션(오케스트레이터가 이 역할로 들어간다).
- **트리거**: `/awl-pipeline-plan`.
- **읽는법**: 직접 구현하지 않는다(exec 몫). 검증하지 않는다(review 몫).

### `/awl-pipeline-exec`

- **역할**: `.tasks/plan`의 신규 일감과 `.tasks/review`의 피드백을 이벤트 워처로 감지해 무인으로 구현한다. 구현 코어는 반드시 `/awl-loop`(게이트는 자율 승인). 핸드오프를 `.tasks/exec/<name>.md`에 남긴다.
- **언제 쓰나**: pipeline의 exec 역할 세션.
- **트리거**: `/awl-pipeline-exec`.
- **읽는법**: 한 틱의 순서는 피드백(review) 처리 → 신규 착수(plan) → **hold 재점검**(`awl hold-recheck`, storyline.md 6절 hold-recheck 사례가 여기서 나온다) → 유휴(워처 재무장) 순이다. 무거운 구현은 서브에이전트(`Task`)에 위임해 메인 세션의 컨텍스트를 구현 로그로 채우지 않는다.

### `/awl-pipeline-review`

- **역할**: `.tasks/exec`의 미검증 핸드오프를 감지해 무인으로 검증한다. 부정행위·완료조건 충족·품질을 확인한다. 합격이면 기록 없음(파일명이 상태), 수정 요구가 있으면 `.tasks/review/<name>.md`에 남긴다.
- **언제 쓰나**: pipeline의 review 역할 세션.
- **트리거**: `/awl-pipeline-review`.
- **읽는법**: 마커는 `.taken` 하나로 통일돼 있다 — `exec/<name>.taken.md` + `review/` 쪽에 파일이 없으면 그게 곧 "합격·완료"다. 검증은 서브에이전트에 위임한다(exec 주장을 그대로 안 믿고 신선한 눈으로 독립 재검증). 이 세션 동안 워처 스크립트(`watch-exec.sh`)가 symlink된 `.tasks/` 경로(예: `.tasks -> .awl/lanes/<lane>`)에서도 올바르게 동작하도록 고쳐졌다 — `cd -P`/`pwd -P`로 스크립트의 물리적 위치를 완전히 따라가게 했다(`pipeline-watcher-symlink-invoke-fix`).

---

## 참고 — 명령 카운트 재확인 로그

`awl --help`(2026-07-19, 버전 0.6.18): init/status/brief/doctor/version-check/update/config/work/lane/records/rules/gotchas/metrics/loop-summary/feedback/changelog/commit/review = 18개, F-01(이전 조사)과 동일. hidden 명령은 `record`/`verify`/`state`/`evolve`/`defer-summary` 5개에 더해 `hold-recheck`가 새로 확인돼 6개다(`awl hold-recheck --help`로 존재 확인, `--help` 목록엔 안 뜬다).
