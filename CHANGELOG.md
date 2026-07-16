# 변경 이력

이 프로젝트는 [유의적 버전](https://semver.org/lang/ko/)을 따릅니다.
형식은 [Keep a Changelog](https://keepachangelog.com/ko/1.0.0/)를 따릅니다.

## [Unreleased]

### 추가

- awl status 가 완료조건 커밋(criterion.commit)이 지금 HEAD 에 없으면 사실로 표시한다 — diverged(다른 계보)/not-found(커밋 없음) 구분. 열등 계보를 최종으로 지목한 인수인계를 잡는다. 격리 커밋 SHA 를 commit 전용 필드에 기록(--start 로 리셋 안 됨)하고 status 가 merge-base --is-ancestor 로 대조. 판단하지 않고 사실만 표시(새 명령 없음) [wi8-F3]
- awl work new --isolated — records(~/.awl)를 이 워크아이템 전용 AWL_HOME 으로 격리한다(병렬 세션용). 전용 .awl-home 을 만들고 export AWL_HOME 을 안내(실제 격리는 export 적용 시). worktree(state 격리)와 합쳐 병렬 루프를 완전히 나눈다 [concurrency-2]
- 병렬 세션 방어(사실 표시) — awl work new --worktree 출력에 "records 는 전역 공유" 경고 hint, awl doctor 에 "최근 활동"(최근 records 시각·state mtime) 표시. awl 은 세션 개념이 없어 판단하지 않고 시각 사실만 보여준다 [concurrency-1]
- state.json 동시성 방어 — writeState 를 원자적으로(temp+rename) 써 부분 쓰기에도 온전, runStateSet 을 프로젝트 락(.awl/state.lock, O_EXCL + stale 자가치유)으로 감싸 동시 세션의 clobber 차단, doctor 가 live 락을 "다른 세션이 state 쓰는 중(토큰)"으로 정확 표시 [concurrency-3]
- awl init 첫 설정에 프로젝트 선정 단계 — interactive 첫 실행에서 cwd 가 git 프로젝트면 "이 프로젝트/다른 곳/취소", 아니거나 원하면 하위 git 프로젝트를 최근 수정순 객관식(최대 20, node_modules 제외, maxdepth 3)으로 제시한다. --yes 와 기존 config 는 예전대로 cwd 자동(회귀) [init-project-picker]
- record/완료조건에 선택 검증 태그 manualVerify/verifyHow — 기계검증(awl verify)으로 못 잡고 사람이 눈으로/브라우저로 직접 재확인해야 하는 항목과 그 방법을 기록 시점에 남긴다. 스키마 변경 없이 흐르고(하위호환), awl brief 가 "직접 볼 검증 항목"의 1차 소스로 읽는다(없을 때만 UI 휴리스틱 폴백) [records-verify-tag]
- awl brief 명령 — KST "오늘"(또는 --date YYYY-MM-DD)의 진행분을 모아 스킬이 소비할 데이터로 낸다(--json). records(UTC at 을 KST+9 로 변환해 그날 경계 재필터)·commits(git log KST 경계)·criteria(진행/완료)·verifyItems(수동검증 명시필드 우선 + UI 파일변경 휴리스틱) 4축. awl 은 판단하지 않고 데이터만 — "오늘 한 일 정리" 가이드는 스킬 몫. 사람용 렌더는 개수 요약만 [awl-brief]
- records 읽기 범위 질의 — readRecords 에 months?/from/to(YYYY-MM) 를 주면 그 월 파일만 읽는다(전량 로드 회피). 쓰기는 월별(YYYY-MM.jsonl) 분할인데 읽기가 전 파일을 순회하던 걸 순수 selectMonthFiles 로 끊는다. 무범위면 전량(하위호환). evolve --collect 에 --from/--to 를 열어 hot 경로가 기간을 실제로 넘긴다(미지정 시 전량 폴백). 파이프라인 연속 실행 시 records 가 매 호출 O(전체 히스토리)로 자라던 것을 완화 [records-read-scope]
- critical-only 모드 지원(awl 코어=데이터만) — defer 레코드 타입(severity/what/why, 선택 recommendation/gate/addresses)으로 자율 통과를 보류한 중요 항목을 남긴다. shouldDefer(severity, threshold=high) 순수 술어(high=high만/medium=high+medium/low=전부, unknown severity 는 fail-safe defer)로 스킬이 게이트 defer/권장통과를 판단한다. awl defer-summary 로 완료 시 보류 큐를 severity 순으로 최종 요약(--json/사람용). mode/deferThreshold 는 state 에 D-15 로 보존. 끄면(mode 미설정) 기존 동작 무변화. 자율진행 실행은 스킬 몫 [skip-gate-defer]

### 고침

- doctor 교훈 수를 gotchas/ 의 .json 만 센다 — 비-json 아티팩트가 섞여도 awl gotchas 와 카운트가 어긋나지 않음 [B1 후속, 검증 세션 지적]

## [0.6.5] - 2026-07-16

### 고침

- doctor 가 교훈 수를 gotchas/ 에서 센다 — 예전엔 빈 lessons/ 를 봐서 늘 0개로 오보 [B1]
- init --yes 가 빈 프로젝트에도 Claude 스킬을 기본 설치 — 셋업 직후 바로 /awl-loop 사용 가능 [B3]
- init 이 .gitignore 에 verify-baseline.json 도 넣는다 — work new 가 나중에 만든 이 파일이 첫 commit 에 오귀속되던 문제 차단 [B4]

## [0.6.4] - 2026-07-16

### 추가

- 완료 워크아이템 정리 명령 awl work done 추가

## [0.6.3] - 2026-07-16

### 고침

- 게이트1 우회 차단 + 이모지 표시폭 + feedback --since (적대 검증)
- 자기피드백 기반 state 비대·버전 마커·무변경 기록 개선

## [0.6.2] - 2026-07-16

### 추가

- awl 자체 피드백을 area 별로 묶어 보는 awl feedback 명령 [BC-01]
- awl 자기 피드백(awl-feedback) 기록 타입과 evolve 유도 [AC-01]

## [0.6.1] - 2026-07-16

### 추가

- 카드·트리·배너 시각 업리프트와 뷰포트 대응 렌더

### 고침

- Gate 1 데드락 해소 — 커밋만 게이트로 막는다

### 변경

- codex v0.6.x 구현 지침서와 하네스 무게 검증 보고서 추가

## [0.6.0] - 2026-07-16

### 추가

- add v0.6 safety and recovery controls

### 변경

- style: format v0.6 implementation

## [0.5.5] - 2026-07-16

### 고침

- constrain diagnostics and align banner

## [0.5.4] - 2026-07-16

### 추가

- add hierarchical status output
- add install all skill option
- render human output as cards

## [0.5.3] - 2026-07-16

### 고침

- stabilize raw input and card rendering

## [0.5.2] - 2026-07-16

### 추가

- polish interactive setup and automate releases

## [0.5.1] - 2026-07-15

### 추가

- **`awl init`의 방향키 선택.** 터미널이 raw-mode를 지원하면(CI/파이프/`setRawMode` 부재 시엔 자동 감지로 꺼짐) 주 언어 선택과 스킬 설치 선택을 방향키+Enter(단일)/방향키+Space+Enter(다중)로 할 수 있다. 지원 안 되면 기존 번호/쉼표 입력으로 그대로 폴백한다. `awl config`는 변경 없이 기존 번호 입력을 유지한다.

## [0.5.0] - 2026-07-15

### 추가

- **버전 불일치 경고.** `awl --version`/`awl doctor`가 어긋날 수 있는 버전 4쌍(package.json vs engine 소스, 설치된 엔진 vs 실행 바이너리, 프로젝트 config vs 전역 엔진, 설치된 스킬 vs 엔진)을 감지해 노란색+`[!]` 마커(색 미지원/CI는 마커만)로 경고한다. 신설 `awl version-check --json`으로 사람/스킬이 직접 검사할 수 있다. 신설 `awl update`가 설치된 엔진을 갱신한다. 세 스킬 문서 모두 파이프라인 시작(워킹트리 확인보다도 먼저) 시 버전을 확인하도록 안내한다.

### 고침

- `awl --version`이 실행 바이너리와 설치된 엔진 버전이 다를 때 "awl init을 다시 실행하세요"라고 안내하던 문제(오답 — 이 쌍은 프로젝트 재설정이 아니라 엔진 자체 갱신이 필요하다). "awl update로 엔진을 갱신하세요"로 정정했다.

## [0.4.5] - 2026-07-15

### 추가

- **스킬 파이프라인에 [명료화] 단계 추가.** [조사] 뒤, [스파이크] 앞 — 목표에 사람만 답할 수 있는 취향/방향 결정이 남아있으면 완료 조건을 쓰기 전에 되묻는다(코드로 답할 수 있는 건 [조사]의 몫). `awl record clarify`로 오간 결정을 기록한다. 되물을 게 없으면 건너뛰고, 3개를 넘으면 목표가 모호하다는 신호로 알린다.
- **narrative에 `tool-failed` 종류 추가.** awl 자신의 도구가 오작동해(예: `awl commit`이 "자체 검증 통과"를 보고하고도 무관한 파일을 흡수) 실사고를 낸 순간을 기록할 수 있다.

### 고침

- `awl commit`의 "자체 검증 통과" 메시지가 스테이징한 내용과 커밋된 내용을 비교하는 동어반복(순환 참조)이라, 실제로는 무관한 파일이 함께 커밋돼도 항상 "통과"를 보고하던 문제. 완료조건 시작 시점 이후 다른 커밋이 얹혔는지(HEAD 드리프트)를 diff 계산 전에 먼저 확인해 정확한 원인과 함께 거부하고, 메시지도 무엇을 확인했는지 정직하게 정정했다. 스테이징 파일이 많으면(5개 초과) 개수를 눈에 띄게 알린다.

## [0.4.4] - 2026-07-15

### 추가

- **기록 상세도를 diff 크기에 맞춘다.** `awl record attempt`가 diff 크기(방금 만든 커밋 또는 작업트리)를 스스로 측정해 필요한 상세도를 안내한다 — 작은 통과 변경(1파일 미만 10줄)은 `what`만, 중간은 `what`/`why`/`how`, 큰 변경(50줄 이상 또는 3파일 이상)은 거기에 `alternatives`(설계 대안)까지 요구한다. 실패한 시도(`result:"failed"`)는 diff 크기와 무관하게 항상 `what`/`why`/`how` 전부를 요구한다(정보 손실 방지).

## [0.4.3] - 2026-07-15

### 추가

- **완료 조건의 질을 검사한다.** 완료 조건에 금지된 질적 표현 5개(저위험/주요한/적절한/가능한 만큼/필요시)가 있으면 `awl record criteria`가 거부한다. `awl record audit`의 findings와 완료 조건의 `addresses` 링크를 대조해, 게이트 1 기록 시 어떤 완료 조건도 다루지 않는 발견(배제)이 있는데 `presentedExclusions`로 명시 제시하지 않으면 게이트 1 기록 자체를 거부한다. 게이트 2 기록 시 완료 조건 전부가 1차 시도로 통과하고 막힘이 0건이면 커버리지 수치와 함께 "완료 조건이 충분히 야심찼습니까?"를 stderr에 안내한다(거부 아님). `awl evolve`/`awl metrics`에 커버리지 계측(발견 수/다룬 수/배제 수/사람 승인 여부)이 추가됐다.

### 고침

- 게이트 1의 배제 목록 계산이 `state.json`의 완료 조건 스냅샷만 보고 `awl record criteria`의 기록은 안 봐서, 스킬 문서 예시(`awl state set`에 `addresses`를 안 옮기는 경우)를 그대로 따르면 정상적으로 다뤄진 발견도 배제로 오판되던 문제.

## [0.4.2] - 2026-07-15

### 추가

- **리뷰를 기록한다.** `awl record review`의 스키마를 `target`/`verdict`(이분법)에서 `reviewId`/`criteria`/`findings`/`cheatingDetected`/`verifyPassedBefore`(구조화된 필드)로 전면 교체했다. `awl review`가 매 호출마다 새 `reviewId`(`rev_` 접두어)를 발급해 조립 결과와 사람용 출력에 포함한다. `awl record gate`로 게이트 2를 기록할 때 현재 워크아이템의 완료 조건 3개 이상이 통과했는데 `review` 기록이 하나도 없으면 stderr에 경고를 낸다(기록 자체는 거부하지 않는다).

### 고침

- `review` 타입 기록이 사람용 `awl records` 목록에서 항상 "(요약 없음)"으로만 표시되던 문제(요약 함수가 새 스키마의 필드를 인식하지 못함). `reviewId`와 `findings`/`cheatingDetected` 개수로 요약하도록 고쳤다.

## [0.4.1] - 2026-07-15

### 추가

- **워크아이템 등록을 강제한다.** `awl record`가 활성 워크아이템(기록 데이터의 `workitem` 필드, `--workitem` 플래그, `state.json`의 현재 워크아이템 중 하나)이 없으면 거부한다. `record` 명령에 `--workitem <id>`가 신설됐다(이 기록 하나만 다른 워크아이템으로 남길 때 씀). 스킬 문서에 "[조사]를 시작하기 전에 `awl work new`로 워크아이템을 등록한다"는 절대 규칙이 추가됐다.

## [0.4.0] - 2026-07-15

### 추가

- **게이트를 기록한다.** `awl record gate` — 게이트 1/2 승인 결과를 기록한다(`decision`: 게이트 1은 approved/modified/rejected/split, 게이트 2는 approved/more-work/abandoned, `presentedCriteria` 필수). `awl state set`으로 `phase`를 `"loop"`로 전환하려면 현재 워크아이템의 게이트 1 기록이 있어야 한다(없으면 거부). `awl status`가 게이트 1/2 이력(승인 시각/decision/제시된 완료조건 수/제외 건수, 없으면 "대기중")을 보여준다. 자율 승인은 `auto:true`로 구분해서 남긴다.

## [0.3.1] - 2026-07-14

### 추가

- **계측(프록시 지표).** `awl record gotcha-applied`/`gotcha-missed` 로 기존 gotcha 가 실제로 적용됐는지/놓쳤는지를 남긴다. `awl record narrative` 로 게이트/리뷰/스파이크/막힘 처리의 순간을 그때그때 기록한다(`kind`: gate-caught/reviewer-caught/spike-prevented/blocked-discarded, `counterfactual` 필수). `awl evolve --collect` 가 워크아이템별 gotcha 적용/누락 개수를 세어 세대 스냅샷에 포함한다. 신설 `awl metrics` 로 워크아이템(세대)별 시도 횟수/막힘 비율/리뷰 지적/절차 실수/gotcha 적용·누락 추세를 볼 수 있다(옛 스냅샷과 하위호환, "워크아이템마다 난이도가 다르다"는 캐비트 항상 포함). awl 은 LLM 토큰을 직접 측정하지 않는다 — 전부 프록시 지표다.

### 고침

- `awl record` 가 `workitem` 을 자동으로 태깅하지 않아, 스킬이 `--json` 에 직접 적어 넣지 않는 한(대부분의 경우 그랬다) 기록이 워크아이템 태그 없이 저장되던 문제(`awl evolve --collect --workitem`의 워크아이템별 집계가 조용히 데이터를 놓치게 됨). 이제 `state.json` 의 현재 워크아이템을 자동으로 채운다(명시적으로 적으면 그게 우선).

## [0.3.0] - 2026-07-14

### 추가

- **MINOR — `delta` 를 `gotcha` 로 개명.** `awl gotchas`(옛 `awl deltas`), `awl rules promote <gotchaId>`(옛 `<deltaId>`), 교훈 ID 체계도 `D-00x` 대신 `G-00x`. 기존 `~/.awl/deltas/*.json` 은 처음 접근하는 시점에 자동으로(무손실, 멱등) `~/.awl/gotchas/` 로 마이그레이션되고 백업도 남는다. `awl deltas` 는 0.4.0 까지 폐기 경고와 함께 그대로 동작한다(하위호환).

## [0.2.5] - 2026-07-14

### 추가

- **엔지니어링 상식 내장**: `awl doctor` 가 프로젝트의 파일명 컨벤션(kebab-case 등)을 세어 감지·보고하고(`awl config set namingConvention` 으로 기록), 파일 크기 이상치를 IQR 기반으로 warn 한다(하드코딩 임계값 없음, 절대 fail 하지 않음). 리뷰어 임무에 "C. 구조 판정"(불필요한 추상화/일관성/재사용 중복을 숫자 임계값 없이 코드 근거로 지목)이 추가됐다. `awl verify --related` 로 변경 파일에 관련된 테스트만 실행할 수 있다(`relatedCmd` 설정 필요, 없으면 전체 테스트로 안전하게 폴백). `awl record decision` 에 `performanceSensitive:true` 를 붙이면 `alternatives`(대안 검토) 가 필수가 된다.

### 고침

- `awl verify --related` 의 `relatedCmd` 치환이 변경 파일 경로에 공백이 있으면 여러 인자로 잘못 쪼개지던 문제.

## [0.2.4] - 2026-07-14

### 고침

- `awl review` 가 이미 닫힌 완료조건이 범위 첫 항목이면 그 조건 자신의 diff 를 빠뜨리던 문제(완료조건에 `firstBaseline` 을 별도로 고정해 다음 격리 커밋의 diff 기준점 갱신과 분리).
- `awl work new` 의 검증 베이스라인 저장이 실패(디스크/권한 등)하면 워크아이템 생성 전체가 크래시하던 문제.
- `awl verify --since-baseline` 이 베이스라인 워크아이템 불일치를 알릴 때, 실행하면 항상 실패하는 조치(`awl work new` 재실행)를 권하던 문제.

## [0.2.3] - 2026-07-14

### 추가

- `awl verify --since-baseline` — `awl work new` 시점에 캡처한 검증 베이스라인과 비교해, 새로 생긴 실패(회귀)와 원래부터 있던 사전 결함을 구분한다. 사전 결함이 남아있어도 신규 실패가 없으면 통과로 판정한다. 체크(typecheck/lint/test/e2e) 단위 비교이며, `--skip-baseline` 으로 캡처를 건너뛸 수 있다.

### 고침

- `awl work switch` 로 워크아이템을 전환해도 검증 베이스라인이 갱신되지 않아, 이전 워크아이템의 낡은 베이스라인과 무음으로 잘못 비교될 수 있던 문제(베이스라인에 캡처 당시 워크아이템을 태깅해 불일치 시 안전하게 폴백).

## [0.2.2] - 2026-07-14

### 추가

- `awl work new <id> --worktree [브랜치명]` — 격리된 git worktree 에서 새 워크아이템을 시작한다. `awl doctor` 가 워킹트리 미커밋 변경을 직접 점검(`git status --porcelain`)해 경고하고, 스킬(Claude/Codex 둘 다)이 더러우면 격리 워크트리 생성/그대로 진행/중단 중 판단하도록 안내한다. `awl commit` 이 hunk 충돌로 거부할 때도 이제 구체적인 구출 절차(stash+worktree)를 안내한다.

### 고침

- `awl work new --worktree` 로 워크아이템 ID 가 이미 존재하는 등 검증에 실패하면, 이미 만든 git worktree/브랜치가 정리되지 않고 orphan 으로 남던 문제.
- doctor 의 워킹트리 점검이 줄 단위로 `git status --porcelain` 을 파싱해, 한글 등 비ASCII 파일명이 이스케이프되거나 rename 레코드가 잘못 파싱될 수 있던 문제.

## [0.2.1] - 2026-07-14

### 추가

- 목표가 서로 독립적인 관심사를 여럿 묶고 있으면 `awl work new` 로 워크아이템을 쪼갤지 게이트 1에서 승인받도록 스킬에 안내를 추가했다(Claude/Codex 둘 다). 완료 조건에 `dependsOn`(선행 완료조건 ID 배열)을 붙일 수 있고, `awl status` 가 아직 안 끝난 선행 조건이 있는 완료 조건을 "블록됨"으로 보여준다(계산만 한다 — 순서 판단은 여전히 에이전트 몫).

## [0.2.0] - 2026-07-14

### 고침

- 격리 커밋(`awl commit`)의 baseline 보호용 git ref 가 워크아이템 구분 없이 완료조건 ID 만으로 저장돼, 서로 다른 워크아이템이 같은 ID 를 재사용하면(흔한 관행) 서로 덮어써 보관된 워크아이템 쪽 커밋이 `git gc` 대상이 될 수 있던 문제(내부 동작 — 사용자가 직접 관찰하진 못하지만 데이터 안전과 관련).

### 추가

- **MINOR — `state.json` 스키마 변경.** `awl work list` / `awl work new <id> [설명]` / `awl work switch <id>` / `awl work abandon <id>` — 한 프로젝트에서 워크아이템 여러 개를 오갈 수 있다. `state.json` 최상위(`workitem`/`phase`/`loop`/`criteria`)는 "현재 워크아이템의 실시간 뷰"로 그대로 두고, 새 `workitems` 레지스트리가 나머지(보관/중단된) 워크아이템을 담는다 — 기존 `awl status`/`awl commit`/`awl verify` 등은 변경 없이 그대로 동작한다. 기존(레거시) `state.json` 은 다음 읽기 시점에 자동으로, 무손실·멱등적으로 새 스키마에 맞춰진다.

## [0.1.4] - 2026-07-14

### 고침

- `awl doctor` 가 프로젝트 루트를 정상적으로 찾았을 때는 경로를 안 보여주고, 못 찾았을 때만 보여주던 문제(뒤바뀐 동작).

### 추가

- `awl doctor` 가 현재 git 브랜치를 보여준다.

## [0.1.3] - 2026-07-14

### 고침

- 모노레포에서 검증 명령이 `cwd` 없이 실행돼, 이미 `cwd` 가 설정된 상대경로 명령(예: `../../node_modules/.bin/tsc`)을 `awl config set` 으로 수정할 때 존재 확인 자체가 `cwd` 없이 실행돼 거짓으로 "명령을 찾을 수 없습니다"가 되던 문제.

### 추가

- `verify.<name>.cwd` 설정 지원 — 모노레포에서 패키지별로 다른 위치에서 검증 명령을 돌릴 수 있다. `awl init` 이 모노레포를 감지하면 어느 패키지를 검증할지 물어본다.

## [0.1.2] - 2026-07-14

0.1.1 이후 실사용(maxflow 모노레포)에서 발견된 결함을 awl-loop 스킬로 awl 자신에게 적용해 고치기 시작했다(WI-A~E, 여러 버전으로 나눠 릴리스).

### 고침

- `awl init` 의 언어 자동 감지가 TypeScript 모노레포를 JavaScript 로 오판하던 문제. 루트 tsconfig 뿐 아니라 typescript 의존성, 워크스페이스 멤버(`packages/*/tsconfig.json` 등)의 tsconfig 유무까지 확인한다.

## [0.1.1] - 2026-07-14

### 고침

- `awl config set` 이 `verify.*.cmd` 뿐 아니라 `project`/`mainLanguage`/`character`/`verify.*.cwd`/`verify.*.env` 도 지원한다. (이전엔 언어 자동 감지가 틀려도 CLI로 고칠 방법이 없었다)

### 추가

- `awl config` 를 인자 없이 실행하면(TTY 면) 항목을 골라 수정할 수 있다
- `awl --version` 이 설치된 엔진 버전도 보여준다. 어긋나면 경고한다
- `CHANGELOG.md`, 릴리스 스크립트(`pnpm release:patch` / `release:minor`)

## [0.1.0] - 2026-07-14

### 처음 출시

- `init`, `doctor`, `config`, `verify`, `record`, `state`, `rules`, `deltas`
- `commit` (격리 커밋), `review` (자료 조립), `evolve` (배움의 흐름)
- `awl-loop` 스킬 (Claude Code / Codex)
