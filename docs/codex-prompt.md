# awl v0.6.x 구현 지침서 (Codex & Agent용 프롬프트 명세)

이 문서는 AI 에이전트가 `agent-work-loop` (awl) 도구의 `v0.6.x` 마일스톤 패치를 구현하기 위해 참고해야 하는 정밀 사양서다. 지시 사항을 순차적으로 검증하여 구현을 진행하라.

---

## 1. 개요 및 설계 철학
- **역할**: awl은 판단하지 않고 디스크의 파일 상태와 검증 명령 실행만을 다루는 초경량 결정론적 CLI 도구다.
- **다중 LLM 지원 방식**: awl CLI 코어 내부에 LLM API나 서브프로세스 어댑터를 연동하지 않는다. 다중 LLM(Claude Code, Codex) 지원은 스킬 템플릿 배포(`installClaudeSkill`, `installCodexSkill`)를 통해 에이전트단에 위임한다.
- **용어 치환**: 기존 'gotcha' 및 'gotchas'의 사용자 대면 한글 명칭을 **'함정'**으로 일관되게 치환한다. 단, 메트릭 변수명(`gotchaApplied` 등)이나 기존 파일명(`gotchas.ts`)은 하위 호환성을 위해 유지하되 출력 텍스트 설명만 번역한다.

---

## 2. 구체적 구현 요구사항

### [1] 세션 복구를 위한 원문 요구사항 보존 (`raw_request`)
- **수정 대상**: `src/commands/state.ts`, `src/commands/work.ts` 및 관련 스키마 정의
- **상세**: 
  - `.awl/state.json`에 `raw_request` 필드(string)를 추가한다.
  - `awl work new` 등으로 세션을 시작할 때 입력된 최초 프롬프트 문자열을 가공 없이 `raw_request`에 기록하고, 상태를 파일로 쓸 때(writeState) 손실 없이 직렬화되도록 보장한다.
  - **[상태 격리 누수 방지]**: `work.ts`의 `archiveCurrent` 함수 내의 구조분해 할당(destructuring) 리스트에 `raw_request`를 명시적으로 추가하여 최상위에서 비워주고, 아카이브 상태 스냅샷(`WorkitemEntry` 및 `restoreWorkitem` 복원 로직)에 안전하게 적재/복원되도록 매핑한다.

### [2] 3회 검증 실패 시 기계적 차단 및 `blocked` 전이
- **수정 대상**: `src/commands/verify.ts`, `src/commands/state.ts`, `src/commands/record.ts`
- **상세**:
  - `state.json` 내의 완료 조건(`criteria`) 객체마다 검증 실패 시도 횟수(`attempts`)를 카운트하는 정수형 필드를 확보한다.
  - `awl verify`를 실행하여 특정 완료 조건이 실패할 때마다 `attempts`를 증가시킨다.
  - 동일한 완료 조건의 `attempts`가 **3회** 누적되는 즉시, 해당 완료 조건의 `status`를 `'blocked'`로 전이하고 전체 워크아이템 루프를 잠금(block) 처리한다.
  - **[리셋 조건]**: 특정 완료 조건 검증이 통과(Success)하는 즉시, 해당 criteria의 `attempts` 카운트를 **0으로 리셋**하여 정상적인 개발-수정 빌드 루프가 가로막히지 않게 조율한다.
  - **[record blocked 와의 정합성]**: 기존에 `status: 'blocked'`는 `awl record blocked`(what/why/tried/lesson 필수 필드)로 사람/에이전트가 명시적으로 남기는 값이며, `evolve.ts`의 `blockedRatio` 등 메트릭이 이를 근거로 집계한다. 이 3회-실패 자동 전이는 **해당 completion criteria 에 대응하는 `record blocked` 항목이 아직 없을 때, 최소 필드(what/tried)만 채운 자동 기록을 함께 남기거나, 최소한 "자동 전이로 생성됨" 플래그를 criteria 에 남겨** 사람이 남긴 blocked 기록과 기계가 만든 blocked 상태가 메트릭상 섞여 혼동되지 않게 한다.

### [3] 설정 기반 보호 파일(`protectedFiles`) 무단 수정 방지
- **수정 대상**: `src/commands/config.ts`, `src/commands/commit.ts` (또는 verify 단계)
- **상세**:
  - `.awl/config.json` 스키마에 `protectedFiles` 배열 필드를 추가한다. (예: `["vitest.config.ts", "tsconfig.json"]` 등)
  - `awl commit` 또는 `awl verify`가 실행될 때, `git diff`를 대조하여 `protectedFiles`에 명시된 파일이 수정되었는지 검사한다.
  - **[개발자 오버라이드 지원]**: 인간 개발자가 직접 명시적으로 수정을 진행하고 우회할 수 있도록 `commit` 및 `verify` 시 검사를 우회하는 **`--force` 옵션**을 지원하고, 옵션이 없을 때 변경이 포착되면 에러 메시지(exit code 1)를 내고 즉시 중단한다.
  - **[기존 `--force`와의 이름 충돌 주의]**: `config set` 커맨드에 이미 `--force`(검증 실패해도 저장한다는 의미)가 존재한다. 커맨드가 다르므로 commander 상 기술적 충돌은 없지만, 같은 플래그명이 커맨드마다 다른 의미(여기서는 "보호 파일 검사 우회")를 갖게 되므로 각 커맨드의 `--help` 설명문에 의미를 명확히 구분해 적어 혼동을 막는다.

### [4] `npm publish` 및 `git push` 물리적 차단 훅 등록 (경량 템플릿 복사 방식)
- **수정 대상**: `src/commands/init.ts` (또는 훅 관리 모듈), `package.json` 스킬 템플릿
- **상세**:
  - **[전제 — 두 관심사를 분리한다]** git의 `pre-push` 훅은 `git push`가 실행될 때만 발동하며, `$1`=원격 이름, `$2`=원격 URL, stdin=ref 목록만 받는다. 별도 프로세스로 실행되는 `npm publish`/`pnpm publish`/`yarn npm publish`는 애초에 이 훅을 전혀 거치지 않으므로, "하나의 pre-push 훅 스크립트가 명령어 문자열을 보고 `npm publish`와 `git push`를 모두 판별해 차단한다"는 설계는 **기술적으로 불가능**하다. 아래처럼 두 메커니즘으로 나눠 구현한다.
  - **(A) `git push` 차단 — pre-push 훅**
    - Windows와 macOS 간의 권한 및 쉘 차이로 인해 코드가 비대해지는 것을 방어하기 위해, CLI 코어 내부에 동적 훅 스크립트 작성 로직을 직접 짜지 않는다.
    - 대신, 차단 스크립트 템플릿(쉘 스크립트 포맷)을 `engine/templates/pre-push.sample` 등 정적 파일로 보관하고, `awl init` 시점에 `.git/hooks/pre-push` 위치로 단순 복사(fs.cpSync 등)하여 배포한다.
    - 복사 및 권한 설정 과정(`chmod +x`)에서 예외가 발생할 경우 크래시하지 않고 부드럽게 경고(Warning)만 남기도록 예외 처리를 단단히 삼킨다.
    - **[치명적 — 이 저장소 자신의 릴리스 스크립트와 충돌 금지]**: `scripts/release.mjs`는 정상 릴리스 흐름의 일부로 `git push --atomic origin HEAD:refs/heads/<branch> refs/tags/v<version>`을 dry-run 없이 직접 실행한다(release.mjs:277). pre-push 훅이 `git push`를 무조건 차단하면 **이 프로젝트 자신의 릴리스가 첫 실행부터 실패**한다. 따라서 훅에는 반드시 우회 경로를 둔다 — 예: 환경변수(`AWL_ALLOW_PUSH=1`)를 확인해 설정돼 있으면 통과시키고, `release.mjs`가 `git push` 실행 전에 이 환경변수를 세팅하도록 함께 수정한다. (`--dry-run` 플래그로 예외를 주는 방식은 `git push`엔 적용할 수 없다 — dry-run은 npm 쪽 개념이다.)
  - **(B) `npm publish` 차단 — `prepublishOnly`**
    - `npm publish`(및 이를 내부적으로 호출하는 `pnpm publish`/`yarn npm publish`)는 pre-push 훅으로 막을 수 없으므로, `package.json`의 `prepublishOnly` 스크립트에서 차단 로직을 실행한다.
    - **주의**: 이 저장소는 이미 `prepublishOnly: "pnpm run build"`를 쓰고 있다. 템플릿 배포 시 이 값을 덮어쓰지 말고 체이닝(예: `"prepublishOnly": "node ./engine/templates/block-publish.mjs && pnpm run build"`)해야 기존 빌드 스텝이 사라지지 않는다.
    - 이 차단 스크립트는 `npm_config_dry_run` 환경변수(또는 `process.argv`의 `--dry-run`)를 확인해, dry-run 호출(`npm publish --dry-run`)은 통과시키고 실제 publish만 차단한다. `release.mjs`의 `npm publish --dry-run`(release.mjs:238) 호출이 이 경로로 정상 통과해야 한다.

### [5] Gate 1 승인 전 코드 수정성 커맨드 차단
- **수정 대상**: `src/commands/state.ts` 및 CLI 명령어 엔트리포인트
- **상세**:
  - 워크아이템의 `phase`가 `awaiting-gate1` (Gate 1 승인 대기 상태)인 경우, `awl verify`와 단순 상태 조회 명령을 제외한 모든 파일 쓰기성/상태 전이성 CLI 커맨드의 실행을 강제로 차단하고 Gate 1 승인이 우선임을 출력한다.
  - **[데드락 방지 예외 규칙(Allowlist)]**: 승인 대기 상태일지라도 Gate 1 계획을 작성하고 준비하기 위한 `record gate`, `work switch`, `work abandon`, `status`, `state get` 명령어는 차단하지 않고 정상 실행을 허용한다.
  - **[구현 시 주의 — `record`는 서브커맨드가 아니라 위치 인자]**: CLI 상 `record <type>`은 commander 커맨드 하나이고 `gate`/`blocked`/`gotcha` 등은 모두 `type`이라는 동일한 위치 인자 값일 뿐이다(서브커맨드로 분리돼 있지 않음). 따라서 커맨드 이름(`record`)만 보고 허용/차단을 판별하면 `record gate`뿐 아니라 `record blocked` 등 다른 모든 record 타입까지 통째로 허용되거나 차단된다. Gate 1 대기 차단 로직은 반드시 **커맨드 이름과 함께 첫 번째 위치 인자(`type === 'gate'`)까지 검사**하도록 구현한다.

### [6] 완료 시 Changelog 초안 자동 제안 기능
- **수정 대상**: `src/commands/work.ts` 또는 신규 `changelog` 관련 명령어
- **상세**:
  - 워크아이템이 최종 완료(Gate 2 통과 및 evolve 완료)되는 시점에, 그동안 누적된 `records/` 폴더 내의 변경 이력과 함정 기록들을 파싱하여 `CHANGELOG.md`에 추가할 수 있는 마크다운 초안 텍스트를 생성하여 stdout으로 출력해주는 보조 커맨드를 추가한다. (자동 커밋이나 로컬 태그 자동 생성은 에이전트의 오판 위험이 크므로 배제한다.)

### [7] `awl init` 대화형 UI/UX 개선 (3단계로 축소 및 입력 예시 추가)
- **수정 대상**: `src/commands/init.ts` (`buildScreens` 및 `interactiveInputs` 함수)
- **상세**:
  - 기존 4단계(`1/4` 주 언어 -> `2/4` 검증 명령 -> `3/4` 규칙이란 설명 -> `4/4` 이 프로젝트는 어떤 곳입니까)의 구성에서 단순 엔터로 넘어가는 `3/4` 설명 단계를 제거하고, **전체 3단계**(`1/3` 주 언어 -> `2/3` 검증 명령 -> `3/3` 규칙과 이 프로젝트의 성격)로 UI를 축소/통합한다.
  - 새 `3/3` 단계(테두리 박스)의 텍스트에 "규칙이 전파되는 원리"에 대한 짧은 요약과 함께, **"이 프로젝트는 어떤 곳입니까"** 질문을 배치한다.
  - 사용자가 입력을 쉽게 시작할 수 있도록 입력 대기 라인 위에 다음과 같은 구체적 예시 문자열을 가이드로 출력한다:
    - `(예시: "React + TailwindCSS 웹 프론트엔드", "Python Fast API 분석 서버", "TypeScript 라이브러리 패키지" 등)`

---

## 3. 도움말(Help) 보완 및 임시 진단 스킬 안내
- **수정 대상**: `src/program.ts` 또는 도움말 출력 모듈
- **상세**:
  - CLI 도움말 설명에 피드백 및 아키텍처 예외 상황 진단용 임시 스킬인 `/awl-improve-loop` 스킬의 용도와 주의사항을 추가한다.
  - "이 스킬은 하네스의 동시성, 상태 누수, 게이트 우회를 임시 테스트하기 위한 진단 피드백 전용 스킬이므로 실제 개발 환경에서는 사용을 자제하고 격리된 Mock 환경에서만 트리거해야 한다"는 경고 및 설명문을 명시한다.
