# 변경 이력

이 프로젝트는 [유의적 버전](https://semver.org/lang/ko/)을 따릅니다.
형식은 [Keep a Changelog](https://keepachangelog.com/ko/1.0.0/)를 따릅니다.

## [Unreleased]

### 변경

- 0.6.39의 두 결정 항목을 실측으로 마무리했다. 핸드오프 지연(F-03): depth-2(서브에이전트가 또
  서브에이전트를 스폰)를 직접 재현한 결과 완료 알림에 결과 본문이 정상적으로 실려 왔다 — 메일박스
  전달 자체는 문제가 아니었다. 지연의 실제 원인은 스폰된 exec/review가 서브에이전트를 띄운 뒤 자기
  턴을 끝내면 자식의 완료 알림으로 스스로 재개되는지가 확인되지 않았다는 쪽으로 좁혔다(오케스트레이터
  SendMessage 재개 처방과 일치). 격리 AWL_HOME(F-02 대안): `mergeIsolatedHome`이 `lane rm`/`work done`
  같은 워크아이템·레인 teardown 경로에서만 호출되고 서브에이전트 단위 즉석 병합 CLI가 없다는 걸
  확인해, 미채택 결정의 근거를 구체화했다. 코드 변경 없음 — awl-pipeline 계열 SKILL.md 3개의
  설명 문구만 갱신.

## [0.6.39] - 2026-07-20

### 변경

- `/awl-pipeline --gl` 실전 세션(0720_improve 레인, 14 workitem 무인 처리) 피드백을 awl-pipeline 계열
  스킬 4개에 반영했다. (1) `Agent` 툴로 스폰된 exec/review 세션은 `ScheduleWakeup`/`CronCreate`가
  툴셋에 없어 self-pace 절이 지시하는 자가 재예약이 불가능하다는 사실과, 그래서 오케스트레이터가
  주기적으로 `SendMessage`로 재개시켜야 한다는 책임을 스폰 계약에 명시했다. (2) 위임한 구현/검증
  서브에이전트의 구조화 응답이 지연되면 무한정 기다리지 말고 `git log`/diff를 직접 대조해 핸드오프·
  판정을 메인이 직접 작성하는 폴백을 exec/review에 추가했다. (3) 스폰한 서브에이전트가 idle이 돼도
  `TaskStop`은 시도하지 않는다(하위 세션은 소유권이 없어 실패, idle teammate는 자원을 점유하지
  않음)고 명시했다. (4) 한 workitem에서 구현 서브에이전트를 동시에 여러 개 스폰할 때 공유
  `AWL_HOME`의 `state.json` 활성 포인터 경합(gotcha G-001/G-002)을 피하도록, 각 서브에이전트에
  pathspec 커밋(`git commit -- <파일>`)과 `awl record --workitem <id>` 명시를 표준 지침으로
  승격했다. 게이트 record가 없는 예외 경로(단일 consolidated attempt record)는 `awl loop-summary`
  개입·gate1배제 집계에서 조용히 0 기여로 빠진다는 사실도 참고로 남겼다(코드 변경 없음 — 저빈도
  edge case).

## [0.6.38] - 2026-07-20

### 추가

- `awl status --pipeline`이 워크아이템마다 하나의 배지+상태단어 줄로만 보여주던 걸, `워크아이템 |
  EXEC | REVIEW | 상태` 열을 가진 표로 바꿨다 — exec가 어디까지 갔는지(pending/in_progress/
  handed_off/verified)와 review가 어디까지 갔는지(waiting/changes_requested/passed)를 하나로
  합쳐진 상태(pending/executing/reviewing/complete/blocked) 옆에 따로 보여준다. `--json` 출력의
  각 workitem 에도 `execState`/`reviewState` 필드가 추가됐다(하위호환, 기존 `status` 필드는 그대로).
- `awl-pipeline`(오케스트레이터) SKILL.md에 "보고·응답 형식" 절을 추가했다 — 사람에게 진행 상황을
  보고하거나 질문에 답할 때 줄글을 먼저 쓰지 않고, 진행 보고는 위 표를 먼저 인용하고 질문 응답은
  경로·ID·수치 같은 단서를 먼저 목록으로 제시한 뒤 줄글을 붙이도록 명문화했다. 데이터량이 많을수록
  줄글만으로는 시인성이 떨어진다는 피드백에 따른 것. awl-pipeline-exec·awl-pipeline-review·
  awl-pipeline-plan의 사람 대면 보고에도 같은 원칙을 참조하게 했다.

## [0.6.37] - 2026-07-20

### 고침

- `/awl-pipeline` 계열 세션이 `.tasks/{README.md,watch-inputs.sh,watch-exec.sh}`를 매번 즉흥 작성하던
  문제를 고쳤다. `engine/skills/claude/awl-pipeline/templates/`를 신설해 `awl init`/`awl lane new`의
  기존 스킬 설치 경로(`installClaudeSkill`)로 함께 배포하고, `awl-pipeline`/`awl-pipeline-plan`/
  `awl-pipeline-exec`/`awl-pipeline-review` 4개 SKILL.md의 부트스트랩 절이 그 템플릿을 `cp`로 그대로
  복사하도록 통일했다(내용 재작성 금지). 템플릿 원본은 이 저장소 루트 `.tasks/`에 남아있던 구버전
  (`while true` 폴링) 대신, exec/review SKILL.md에 이미 박혀있던 최신 one-shot(`EMPTY_COUNT` 2단계
  백오프) 워처를 채택했다 — exec/review에 중복 박혀있던 heredoc은 삭제해 향후 드리프트를 막았다.
- `awl-pipeline-plan`이 목표 서술 없이 진입했을 때 AskUserQuestion(닫힌 선택지용 도구)을 열린 목표
  질의에 오남용하지 않도록, 평서문으로 안내하고 대기하라고 명시했다(오케스트레이터 `awl-pipeline`에도
  동일 규칙을 반영).

## [0.6.36] - 2026-07-20

### 추가

- `awl remove --global`/`--all`이 다른 등록 프로젝트의 학습 손실을 경고할 때, 그
  프로젝트들의 로컬(`.awl/` 등)은 이 명령이 건드리지 않는다는 안내와 함께 바로
  복사해 실행할 수 있는 `cd "<경로>" && awl remove --project --yes` 체인을 낸다.

## [0.6.35] - 2026-07-20

### 추가

- `awl init`/`awl config`의 "다음 단계" 안내에 `/awl-pipeline <레인명> --gl` 실행을
  제안하는 줄을 추가했다(격리된 작업 세션이 생성되고 자율 모드로 실행된다는 설명 포함).

## [0.6.34] - 2026-07-20

### 고침

- `awl lane new`/`awl work new --worktree`가 대형 모노레포(15만+ 파일)에서 `git worktree
  add` 30초 타임아웃에 걸려 인덱스 파일을 쓰다 만 채(`Could not write new index file`)
  실패하던 문제를 고쳤다. 기본 타임아웃을 180초로 올리고, `AWL_GIT_WORKTREE_TIMEOUT_MS`
  (ms) 환경변수로 직접 조정할 수 있다. 타임아웃으로 실패하면 원인(몇 초 만에 강제
  종료됐는지)과 조정 방법을 에러 메시지에 바로 보여준다.
- `awl remove`가 `.awl-worktrees/`의 레인은 `git worktree remove`로 정리하면서도 빈
  부모 디렉토리 자체는 그대로 남기던 문제를 고쳤다. 레인을 모두(또는 애초에 하나도
  없이) 정리한 뒤 비어 있으면 마저 지운다.
- `.awl/config.json`이 이미 있는 프로젝트에서 "그대로 쓴다"(또는 `awl init --yes`
  재실행)를 고르면 `~/.awl/projects.json`에 등록되지 않던 문제를 고쳤다. `awl remove
  --all`로 레지스트리가 비워진 뒤에도 재init만으로 복구된다. 같은 함수를 쓰는 `awl
  update --local`도 함께 고쳐졌다.

### 추가

- `awl lane new`/`awl work new --worktree`가 워크트리 생성 소요시간과 디스크 여유공간
  변화(델타)를 성공/실패 여부와 무관하게 항상 출력한다.

### 변경

- 루트 도움말의 예시 카드가 4줄(commit/review/status)에서 사람용 명령 전체(시작·점검
  /완료조건 게이트/워크아이템·레인/기록·규칙·교훈/설정·관리/그 외 조회)로 확장됐다.

## [0.6.33] - 2026-07-20

### 변경

- CLI 카드/프롬프트 시각 언어를 clack-prompts 스타일 연결 트랜스크립트(┌ ◇ ◆ │ └)로
  재설계. `awl init`/`awl config`의 다단계 흐름은 세션 시작부터 끝까지 하나의 좌측
  세로선으로 이어지고, `status`/`doctor`/`lane` 등 나머지 명령의 카드 출력도 같은
  글리프로 자동 전환된다(`sectionBox` 시그니처는 그대로 — 새 `flowOpen`/`flowActiveNode`
  /`flowClose` 위의 얇은 래퍼가 됐다). 신규 `src/core/flow.ts`가 세션 상태를 관리한다.
  ASCII 폴백도 동일하게 지원(`+ o * > | +`).

## [0.6.32] - 2026-07-20

### 고침

- 배너 제목의 버전을 하드코딩에서 package.json 동적 참조로

## [0.6.31] - 2026-07-20

### 변경

- `awl init`/`awl config`의 주 언어 선택을 단일선택에서 다중선택으로 확장. TypeScript
  프론트 + Python 백엔드 같은 폴리글랏 프로젝트도 한 번에 반영할 수 있다.
  `.awl/config.json`의 `mainLanguage`가 문자열에서 문자열 배열로 바뀐다(하위 호환 없음 —
  기존 설치는 `~/.awl` 리셋 후 재설치 필요). `detectLanguages()`가 JS/TS와 Python 신호를
  독립적으로 감지해 여러 언어를 기본 체크한다. `awl config set mainLanguage a,b`처럼
  쉼표로 여러 값을 지정할 수 있다.
- `awl uninstall` 명령을 `awl remove`로 이름을 바꾼다. 옵션(`--yes`/`--project`/`--global`/
  `--all`/`--json`)과 동작은 그대로다. 하위 호환 별칭 없음.

## [0.6.30] - 2026-07-20

### 추가

- `awl lane rm`/`awl work done`(teardown) 시 격리 home의 records를 전역(`~/.awl/records`)으로
  재생하고, 레인 출처는 `records/archive/<project>/<date>-<lane>.jsonl` 스냅샷으로 따로 남긴다.
  이전엔 gotcha/rule/generation만 전역으로 이어지고 records는 워크트리와 함께 폐기됐다. records는
  gotcha와 달리 전역 고유 ID가 없는 순수 append 로그라 동시 teardown에도 안전하다.

## [0.6.28] - 2026-07-20

### 추가

- awl update에 --local/--all 추가 — 등록 프로젝트 로컬 스킬까지 동기화
- signal() 상태 표시를 이모지에서 텍스트+색으로 통일
- sectionBox 마지막 줄을 ㄴ자로 닫고, --help 예시를 --examples로 분리

### 고침

- sectionBox 마감이 본문 자체 트리 마커(lastBranch)와 겹치던 문제 수정

## [0.6.27] - 2026-07-20

### 추가

- 전체 명령 화면을 닫힌 카드에서 열린 ㄷ자로 통일

## [0.6.26] - 2026-07-20

### 추가

- 카드를 ㄷ자 열린 형태로, 스킬0개/버전표시/프로젝트중복 버그 수정

### 변경

- version-check의 updateAvailable/mismatches 구분 명시
- 부트스트랩에 awl version-check 1회 호출 추가(awl-loop와 동일 패턴)
- SKILL.md description을 2~3줄 사용예+트리거로 압축
- 공유용 소스 업데이트

## [0.6.25] - 2026-07-20

### 추가

- 시작 안내 카드 분리 + 로고 좌우 무지개 그라데이션 + help 예시 카드

### 고침

- 배너 문구 다듬기 반영 + 회귀 테스트 정렬

### 변경

- .idea/.agents/ gitignore 추가, skills-lock.json 커밋

## [0.6.24] - 2026-07-20

### 변경

- 배너 회귀 테스트를 새 문구에 맞춘다
- LLM 실사용 시나리오 추가, 문구 정리, Claude Code 전용 범위 명시
- 초기 계획 문서(tasks/todo.md) 정리

## [0.6.23] - 2026-07-20

### 추가

- 사이클 종료 보고에 반복 gotcha 승격 후보 안내 추가

### 고침

- generations 파일명에 타임스탬프 접두어 추가(데이터 유실 방지)
- .awl-verify 를 IGNORE_DIRS 에서 제거(리네임 아님)

### 변경

- 삭제된 ref-knowledge-graph/ ignore 항목 정리
- 6절에 self-pace adaptive backoff 반영
- self-pace 2단계 백오프 exec/review 섹션 반영 + 재확인로그3 [AC-01]

## [0.6.22] - 2026-07-20

### 추가

- 연속빈체크 카운터를 .tasks/.locks 파일로 영속화, INPUTS_READY/UNVERIFIED_READY 시 리셋 [AC-02]

### 고침

- ALREADY_OWNED 분기 stage 미정의 해소(1단계로 안전 기본값) + 워처 헤더 주석 stale ScheduleWakeup(~1800s) 정합 [리뷰 rev_fa1920c8ab0e1eb1b0] [AC-07]

### 변경

- exec 계약 전문의 ScheduleWakeup(~1800초) 잔존 문구를 2단계 백오프로 정합 [AC-01]
- self-pace 간격을 2단계 백오프(240s/1500s)로 교체 [AC-01]

## [0.6.21] - 2026-07-19

### 변경

- 워처 heredoc(watch-inputs/watch-exec)을 while true 내부폴링에서 one-shot 단일패스로 재작성 [AC-02]
- self-pace를 one-shot 체크+/loop|ScheduleWakeup 예약으로 재설계 [AC-01]
- 명령 카운트 재확인 로그 2 추가(0.6.20, 변동없음) [AC-04]
- 6절에 파이프라인 사이클 요약 서사 1문단 추가 [AC-03]
- loop-summary 배치모드(--workitems/--since) 섹션 추가 [AC-02]

## [0.6.20] - 2026-07-19

### 추가

- 배치모드(--workitems/--since) + 집계(AC-01/02/03)

### 변경

- [조사] 절에 구조적 사실 스크립트 우선 지침 추가(AC-00~05) [AC-01]
- 리뷰 지적 반영 - --workitems 파싱 함수 추출+테스트, unmannedRate 있는값만평균 직접 테스트 [AC-06]
- 사이클 경계 추적·보고(시작기록/카운트/종료보고) + wall-clock 분리 원칙(AC-04)
- 하위호환 보장 문답 추가 [AC-06]
- 문제해결에 awl uninstall 항목 추가 [AC-02]
- 4절에 awl uninstall 반영 [AC-01]
- engineVersion 을 0.6.19 로 동기화

## [0.6.19] - 2026-07-19

### 추가

- awl uninstall 라이브 프로세스 안전장치 — .tasks/.locks 살아있으면 --yes 전체 중단(AC-06, 최우선)
- awl uninstall 부분 제거 — AGENTS.md 마커 구간만/pre-push 템플릿 일치시만(AC-04)
- awl uninstall 레인 워크트리 안전 제거 — git worktree remove + lane rm 3단 안전망 재사용(AC-03)
- awl uninstall 스코프 분리 --project/--global/--all + 다른 프로젝트 학습 손실 공시(AC-02)
- awl uninstall 신설 — 전역+로컬 스캔·드라이런 기본값(AC-01)

### 변경

- 독립 리뷰 지적 반영 — gotcha/feedback 카운트 프로젝트스코프 정직화, awl uninstall 레퍼런스 추가, 인용 verbatim화+줄번호 정정 [AC-09]
- storyline/commands와 역할분담 재구성 — 실용문서로, npm 0.0.0 placeholder 안내+git push 훅 문서화 [AC-05]
- commands.md pipeline 스킬 최신화 — hold-recheck 재확인+워처 symlink 수정 명시 [AC-04]
- commands.md — 사람용16+스킬용8+파이프라인 스킬5 레퍼런스 [AC-03]
- storyline.md 8절 초안 — 문제/개념/사다리/구조/데이터흐름/파이프라인/실증/한계 [AC-01]
- 리뷰 지적 반영 — --json+--yes 출력 계약 수정, 레인 학습폐기 의도 문서화, stripAwlAgentsBlock 미커버 분기 테스트 추가 [AC-07]
- awl uninstall→init 통합 검증 — 재설치가 최초설치처럼 부트스트랩되고 버전 불일치 없음(AC-07)
- awl uninstall 레거시 스윕(ㅍ마커/.awl-home/deltas+backup) 전 과정 검증(AC-05)

## [0.6.18] - 2026-07-19

### 추가

- --pipeline --archive 로 보관 실행(F-03/pipeline-archive 재사용, 기계적·게이트 불요) [AC-05]
- F-03(pipelineLanes) 재사용 보관 후보 판정 + 유예기간(3일) [AC-01]

### 변경

- 마커 접미사 정규식 중복 제거 — markerBaseName 공유(리뷰 지적) [AC-01]
- 섹션 슬라이스로 단언 강화(G-059) — 토큰 존재만 보지 않고 올바른 섹션 범위 안에서 검증 [AC-01]
- SKILL.md progressive disclosure 분할 — 조건부/저빈도 6섹션을 reference.md로 [AC-01]

## [0.6.17] - 2026-07-18

### 제거

- `awl sync-skills` 명령을 철회했다. temp-loop-*(awl 자체 개발용 하네스)와 awl-pipeline-*(awl이 배포하는 제품 스킬)는 독립 목적이라 동기화가 필요 없다고 판명됐다. 0.6.15에 추가된 동기화 메커니즘은 서로 다른 두 산출물을 형제 관계로 잘못 다룬 설계였다. 기존 릴리스 항목(0.6.15의 sync-skills 추가 기록)은 역사 그대로 남긴다.

## [0.6.16] - 2026-07-18

### 변경

- 과거 워크아이템 레지스트리 분기 + startCostOf 가드 glue (loop-completion-stats AC-07, 리뷰 finding #1)
- cost write→read 계약 e2e + 핸들러 진입 잠금 (loop-completion-stats AC-06, 리뷰 finding #2)

## [0.6.15] - 2026-07-18

### 추가

- awl sync-skills 재생성 메커니즘 + program 등록 (pipeline-skill-source-unify AC-02)
- 파이프라인 스킬 파생 규칙 순수함수 + 정본 속성 잠금 (pipeline-skill-source-unify AC-01)
- 루프 완료 4렌즈 요약 명령 + 집계 순수함수 (loop-completion-stats AC-01)
- work new 시 루프시작 cost 스냅샷을 state.costAtStart 로 캡처 (loop-completion-stats AC-03)
- cc-usage.json cost 스냅샷 리더 + 루프경계 델타 (loop-completion-stats AC-03)
- 폐기예정 deltas 명령 제거 + 미지 명령 unknown-command 가드
- record 트레일 공백 표면화 — 활성 워크아이템 없이 커밋 이력이면 warn [AC-01]
- 활성 워크아이템 없이 커밋 시 record 트레일 공백 경고(차단 아님) [AC-02]

### 고침

- 바레 실행 라이브 글로벌 안전장치 + 멱등 write-skip 스파이 (pipeline-skill-source-unify AC-04, 리뷰 finding #1/#2)
- AC-02 테스트 noUncheckedIndexedAccess 정리
- unknown-command 가드가 내장 help 를 오판하지 않게(deltas-removal AC-04, 리뷰)
- trail 경고를 실제 커밋 경로로 이동 — baseline 없을 때 오해 문구 방지(리뷰) [AC-04]
- 파이프라인 마커 리더를 .taken 단일 진실로 통일 [AC-01]

### 변경

- 커밋 지표 라벨을 격리커밋으로 정확화 (loop-completion-stats AC-05, 리뷰 finding #1)
- 기록 없음 안내 + 0-렌즈 억제 잠금 (loop-completion-stats AC-04)
- 헤드라인 개입/자율 첫줄 잠금 (loop-completion-stats AC-02)
- legacyDeltas 마이그레이션 유지 결정 명시(deltas-removal AC-02)
- 크로스 프로젝트 record 는 트레일 경고 억제 안 함 — 프로젝트 필터 방향 잠금(리뷰) [AC-05]
- 정상 흐름(워크아이템+gate1)은 트레일 경고 없이 커밋 — 회귀 가드 [AC-03]
- 파이프라인 마커 생산자-소비자 계약·뮤테이션-저항 테스트 [AC-02]

## [0.6.14] - 2026-07-18

### 추가

- teardown 시 격리 학습(gotchas/rules/generations)을 전역으로 멱등 병합 [AC-01]
- mode 매핑 3단계 설명을 graded 헤더로 — gate-high/gate-medium/gate-low(=기존 gate/skip-gate/auto) 전이 주석 + 오해방지 유지 [AC-02]
- 게이트 밀도 인자절을 graded 3단계로 — gate-high(기본)/gate-medium/gate-low + 축약 --gh/--gm/--gl + 방향 규약 [AC-01]
- awl-pipeline mode 기본 gate + skip-gate/auto 3상태·축약·유연파싱 (critical-only 리네임) [AC-01]
- awl-pipeline 인자 없으면 unknown-lane-<N> 자동 생성 — 3-way 파싱·중첩 방지 (AC-01/02/03, 저작-전용)
- awl-pipeline 오케스트레이터 스킬 저작 — 스폰 계약·수집·mode·flush·상태 (설계 스펙 AC-01/02/04/05 인코딩, 저작-전용) [AC-01/02/03]

### 고침

- 리뷰 지적 반영 — work done 비워크트리 격리 병합 + 병합실패 깔끔한 중단 + 빈 lesson 가드 [rev]
- awl init 재실행이 엔진 신규 스킬도 설치 (syncExistingInstall)
- 파이프라인 nameWidth 를 표시폭(stringWidth) 기반 nameColWidth 로 — 한글 이름 status 열 정렬 [AC-03]
- --pipeline 폴백을 main 그룹으로 통일 — 폴백/다중 --json 동형 {name,workitems[]} 스키마 [AC-02]
- --pipeline 이 메인 트리 .tasks/ 를 main 그룹으로 롤업 — 레인 존재 시 메인 안 숨김 [AC-01]
- lane rm 이 root state 의 유령 workitem 을 정리(removeWorkitemFromState) — 삭제된 워크트리 가리키는 유령 제거 [AC-02]
- 격리 레인 lane new 가 root state 불변 — 레인 workitem 을 worktree state 에 기록(현재 workitem pause·유령 근원 제거) [AC-03]
- lane rm 이 untracked WIP 를 손실 전 차단 — awl 산출물 필터 후 --force 요구 [AC-01]
- unmergedCommitCount fail-open 수정 — git 실패 시 null 로 차단(미확인=위험) [AC-04]
- 설치 메뉴 Claude Code 라벨을 claudeSkillNames() 개수로 파생 [AC-01]

### 변경

- defer 사용자대면·주석을 모드-중립으로 — skip-gate 모드명 제거, 보류 큐/최종 확인 항목 메커니즘 표현(로직 불변, skip-gate-defer 스펙명만 유지) [AC-03]
- mode 픽스처 critical-only→skip-gate 현행 어휘로 (리뷰 rev finding #1) [AC-04]
- defer 사용자대면 문자열·주석 critical-only→skip-gate 통일, 판정 로직 불변 [AC-03]
- awl-pipeline mode 3모드 설명 + skip-gate 오해방지(게이트=판단 정지점, 도구 권한 아님) [AC-02]
- syncExistingInstall 재설치를 installClaudeSkill 재사용으로 (DRY)
- AC-01 텍스트 단언 강화 — main workitem 이름 alpha 로 바꿔 헤더 존재를 실제로 요구(공허 통과 방지) [AC-05] (rev finding #3)
- 프로덕션 미참조 renderPipeline 제거 — AC-02 통일로 dead, 도달불가 빈상태 문자열 divergence 정리 [AC-04] (rev finding #1)

## [0.6.13] - 2026-07-17

### 추가

- --pipeline 을 .awl-worktrees/* 교차 레인 롤업으로 확장 + 단일 .tasks 폴백 [AC-01/02/03]
- awl lane new/ls/rm — 격리 레인 생성·조회·정리 (P1) [AC-01]
- --worktree 가 워크트리에 engine 스킬 재설치 (pipeline-lane-skill-reinstall AC-01/02/03)
- temp-loop-{plan,exec,review} → awl-pipeline-* 정식 이관 [AC-01]
- 재실행 스킬 동기화를 다중-스킬로 확장 [AC-02]
- Claude 스킬 설치기를 다중-스킬로 일반화 [AC-01]

### 고침

- renderBanner 열계산을 visibleWidth 로 교체해 색 켜짐 정렬 복구
- rm 이 미머지 커밋을 --force 없이 파기하지 않게 + 빈이름 가드·realpath 폴백 커버 (리뷰) [AC-05]

### 변경

- status --pipeline 레인/역할 용어 정정 + AC-01 테스트 섹션 공존 단언 강화 [AC-04]
- 작업 루프(단일 워크아이템)↔오케스트레이션(다중 레인) 용어 분리 + 테스트 잠금 [AC-03]
- 오케스트레이션 파이프라인 섹션 추가(lane·status --pipeline·역할 스킬, auto-spawn 로드맵) + 테스트 잠금 [AC-01]
- lane 설명에 파이프라인 맥락 노출 + 테스트 잠금 [AC-02]
- renderBanner 색 켜짐 정렬 회귀잠금 (뮤테이션-저항)
- 에러 경로 6곳이 process.exit 종료코드(=1)를 뮤테이션-저항으로 잠금 (리뷰 test-strength) [AC-06]
- 재설치 예외 catch 분기 락 (AC-04, 리뷰 rev finding#1)
- awl-pipeline-* 에 설계 계약(pipeline-subagent-delegation AC-01/02/04/05) 인코딩 [AC-03]
- renderPipeline name 열정렬(padEndDisplay) 뮤테이션-저항 잠금(pipeline-status r2, 리뷰) [pipeline-status-tracking]
- 성공 렌더를 renderCommitSuccess 순수함수로 추출 + selfCheckOk 경고 분기 단언(AC-09, 리뷰)

## [0.6.12] - 2026-07-17

### 고침

- 루트 README 를 0.6.x 에 맞춰 최신화(readme-refresh) — 빠져 있던 명령(brief/metrics/feedback/version-check)을 문서화하고, awl-feedback(도구 자체 피드백·`~/.awl/records`)과 gotcha(코드 교훈·`~/.awl/gotchas`)의 구분, deltas→gotchas 이름 변경을 반영했다. 파이프라인 다이어그램에 [명료화] 단계를 넣고, 엔진 버전 불일치 안내를 `awl update`/`awl version-check` 로 정정했다. 이 과정에서 `awl --version` 배너가 엔진 불일치 때 여전히 `awl init` 을 지시하던 문구를 `awl update` 로 바로잡았다(0.5.0 이 `version-check` 힌트만 고치고 배너를 놓쳤던 드리프트 — 같은 증상에 두 표면이 다른 명령을 지시하던 것). README 명령·개념·문체(금지어)를 회귀 테스트로 잠갔다 [readme-refresh]

## [0.6.11] - 2026-07-17

### 추가

- 반복 루프 리팩토링 체크포인트(loop-refactor-checkpoint) — awl-loop 스킬 반복 절에 "완료 조건 하나가 verify 를 통과할 때마다 코드 스플리팅·추상화 레벨을 점검한다"는 상시 단계를 넣었다. 예전엔 완료 조건 3개마다 도는 리뷰에서만 구조를 봤다. 점검 신호는 `awl doctor` 의 파일 크기 이상치(IQR)와 리뷰어 "구조 판정" 기준을 재활용하되 숫자 임계로 강제하지 않는다(판단은 에이전트, awl 은 신호만). 작은 정리는 그 자리에서 격리 커밋하고, 큰 구조 변경은 완료 조건으로 편입해 게이트를 거친다. 실제 리팩토링은 `awl record refactor`(kind: split/dedup/abstraction/rename/inline/기타)로 남기고, `awl metrics` 세대 표에 리팩토링 열을 더해 추세로 본다 [loop-refactor-checkpoint]

## [0.6.10] - 2026-07-17

### 추가

- gotcha 관계 그래프(gotcha-graph) — 교훈끼리 관계를 맺어 흩어진 지식을 묶는다. gotcha 에 `relations`(duplicates/refines/supersedes + target) 필드를 더했다. 무엇이 무엇을 refine/supersede 하는지는 LLM 이 매기고, awl 은 필드를 저장·순회만 한다(판단하지 않는다). `gotchaCluster` 가 relations 와 기존 sameAs 를 무방향 엣지로 순회해 시드 교훈의 클러스터를 낸다(N홉 제한·순환 가드). `gotchasBySource` 가 출처(workitem)로 교훈을 뒤조회하고, `evolve --collect` 가 이 워크아이템에서 나온 교훈과 그 관계 클러스터를 `relatedGotchas` 로 실어, 전체 나열(existingGotchas) 대신 상황에 가까운 묶음을 준다. relations 없는 옛 gotcha 는 그대로 로드된다(하위호환) [gotcha-graph]

## [0.6.9] - 2026-07-17

### 고침

- doctor 체크 값(value)도 emphasis(bold)로 강조 — cli-visual-consistency AC-04 완결. tty 에 clipToWidth(색 ANSI 를 보존하며 표시폭으로 자르고 잘린 끝에서 색을 닫는 절단)를 신설해, doctor 의 로컬 clip(stringWidth 기반, ANSI 미인지)을 대체하고 값에 색을 입혀도 truncation/색번짐 없이 살아남게 했다(이전엔 이 한계로 group 헤더 bold 만 유지했음). rules 락 경고의 signal(caps()) 를 signal(c) 로 정정 [cli-visual-consistency]

## [0.6.8] - 2026-07-16

### 추가

- 파이프라인 상태 배지 + status --pipeline (pipeline-status-tracking) — tty.ts 에 statusBadge(pending/executing/reviewing/complete/blocked)를 signal 패턴(색 토큰 + 유니코드 글리프 폭1 / ASCII 폴백)으로 추가해 상태 어휘를 한 곳에서 관리한다. awl status --pipeline 이 temp-loop 하네스의 .tasks/{plan,exec,review} 파일명만으로(내용 안 엶) 레인별 workitem 상태를 배지로 낸다(review .pass=complete, 미반영 수정요구=blocked, exec 핸드오프=reviewing, plan .hold=blocked, 착수 ㅍ=executing, 신규=pending). --pipeline opt-in 이라 일반 status 는 무영향, .tasks 가 없으면 빈 뷰(awl 은 하네스 유무를 판단하지 않는다). 세션 상태-요약 규칙(AC-04)과 review 의 .pass emit(AC-03)은 프로젝트 밖 스킬 계약이라 로드맵 P4(engine/skills 편입)로 미룸 [pipeline-status-tracking]

## [0.6.7] - 2026-07-16

### 고침

- CLI 출력 어휘 통일(cli-visual-consistency) — config/record/evolve/rules/changelog/commit 의 평문 stderr 에러를 signal(error)(유니코드 ❌/ASCII [x])로, 락 경합·비차단 경고는 signal(warn)([!])로 통일해 CI·파이프에서도 마커가 폴백된다. commit 성공 라인을 feedback(ok)+커밋 해시 강조로 바꾸고(feedback 유틸 첫 사용처), 상태값 색코딩(work status: 진행/완료=green·보류=warn·중단=muted, 게이트 decision: 승인=green·거부=red)과 핵심값 강조(passed/total·버전 값·init 결과 값)를 status.ts 패턴으로 work/status/version-check/init 에 이식했다. feedback 반복 태그의 하드코딩 [!] 도 signal(warn)로. doctor 값은 clip() 이 ANSI 미인지라 group 헤더 bold 만 유지(per-value 보류) [cli-visual-consistency]

## [0.6.6] - 2026-07-16

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
- 실험 측정 지원(experiment-harness) — awl work new --experiment '{"model":..,"mode":..,"taskType":..}' 로 워크아이템에 실험 케이스 메타를 달면(D-15) evolve 가 세대 스냅샷에 실어, awl metrics --compare 가 케이스(model/mode/taskType)별로 지표(시도평균·막힘비율·리뷰지적·소요평균)를 나란히 비교한다(--json). 던지기~완료 소요(workitemCreatedAt~완료 at)를 durationMs 로 집계. 태그 없는 옛 세대는 비교에서 제외·하위호환. awl 은 케이스 기록·집계만, 실험 실행·판단은 사람/스킬 [experiment-harness]

- CLI 디자인 정비(cli-design-tokens) — tty.ts 에 역할 의미 토큰(makeTokens: emphasis/muted/danger/accent/frame/info…)을 도입해 명령이 외형 색이 아니라 역할로 색을 쓴다. info 신호를 blue 로 바꿔 카드 제목 accent(cyan)와 색을 분리. 죽은 코드 box() 를 폐기하고 사람용 박스를 card 로 통일. card 본문 wrap 에 hanging indent 를 넣어 넘친 줄이 트리/불릿 들여쓰기를 유지(둘째 줄이 왼쪽에 붙던 정렬 깨짐 수정). metrics 표와 init 을 stringWidth 기반 padEndDisplay 로 통일(한글 섞인 열 정렬), 배너의 임시 진단 문구 제거 [cli-design-tokens]

### 고침

- 보호 파일 변경 경고의 하드코딩 ❌ 를 signal(error)로 — commit/verify 가 caps 게이트를 타 CI·파이프에서 유니코드 ❌/ASCII [x] 로 폴백(글리프 깨짐 차단). 유일하게 signal 을 우회하던 상태 마커 [cli-visual-consistency AC-01]
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
