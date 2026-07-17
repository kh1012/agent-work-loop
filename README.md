# agent-work-loop

`agent-work-loop`(명령어: `awl`)은 AI 에이전트가 같은 실패를 두 번 반복하지 않도록 돕는 도구입니다. 에이전트가 작업하며 남긴 기록, 검증 결과, 완료 조건, 규칙, 교훈, 막힘을 파일로 관리합니다.

**awl 자체는 판단하지 않습니다.** LLM을 호출하지 않고, 파일과 상태만 결정적으로 다룹니다. 무엇을 배우고 어떤 규칙을 세울지는 이미 설치된 에이전트(Claude Code, Codex)가 스킬을 통해 판단합니다. 에이전트가 머리라면 awl은 손발입니다. 그래서 awl의 모든 동작은 예측할 수 있고 테스트할 수 있습니다.

크로스 환경을 처음부터 전제로 합니다. macOS와 Windows, Claude Code와 Codex를 모두 지원하는 것을 목표로 하며, 경로·홈 디렉토리·셸·줄바꿈·터미널 렌더링의 차이를 고려합니다(Windows는 아직 macOS만큼 검증되지 않았습니다 — [알려진 위험](docs/decisions.md)을 참고하세요).

---

## 설치

```bash
npm install -g agent-work-loop
```

pnpm이나 yarn을 쓴다면:

```bash
pnpm add -g agent-work-loop
yarn global add agent-work-loop
```

> **pnpm 함정**: pnpm으로 전역 설치하면 `awl` 명령을 찾을 수 없다는 에러가 날 수 있습니다. pnpm의 전역 bin 디렉토리가 PATH에 없어서입니다. `pnpm setup`을 한 번 실행하고 터미널을 새로 열면 해결됩니다.

설치가 됐는지 확인합니다:

```bash
$ awl doctor

  Agent Work Loop  진단

  환경
    Node           v22.22.2       ok
    플랫폼         darwin arm64   ok
    터미널         유니코드 미지원, 색 미지원   ok

  전역 설치
    ~/.awl         없음   -> awl init 을 실행하세요

  이 프로젝트
    프로젝트 루트  (아님, .git/.awl 없음)

  에이전트
    Claude Code    없음
    Codex          없음
    awl 스킬       설치 안 됨   -> awl init 에서 설치할 수 있습니다

  문제 2개. awl init 을 실행하세요.
```

터미널이 유니코드/색을 지원하면(Windows Terminal, VS Code 터미널 등) 자동으로 감지해 상자 그림과 색을 씁니다. 지원 안 되면 ASCII로 자동 전환됩니다 — 위 출력은 파이프로 캡처한 것이라 미지원 모드입니다.

`doctor`는 아무것도 고치지 않습니다. 점검만 합니다.

---

## 5분 퀵스타트

프로젝트 디렉토리에서 한 번만 실행합니다. 이것이 유일한 튜토리얼입니다 — 질문마다 왜 묻는지 화면에 설명이 나옵니다.

```bash
$ cd my-project
$ awl init

  ~/.awl 이 없습니다. 처음 오셨군요.
  이 프로젝트를 첫 번째로 등록합니다.

+- 1/4 ------------------------------------------------- 주 언어
|
|  자동 감지했습니다. 맞으면 Enter.
|
|  (*) 1  TypeScript
|  ( ) 2  JavaScript
|  ( ) 3  Python
|  ( ) 4  직접 입력

+- 2/4 --------------------------------------------- 검증 명령어
|
|  package.json 등에서 찾았습니다. 맞으면 Enter, 고치려면 새로 입력.
|
|    타입체크  tsc --noEmit
|    린트      eslint .
|    테스트    vitest run
|    E2E       (없음)
|
|  이 명령어들이 유일한 심판입니다.
|  AI 가 "다 했습니다"라고 말할 수 없게 만드는 장치입니다.

+- 3/4 ------------------------------------------------ 규칙이란
|
|  작업하다 같은 실패를 두 번 하면, awl 이 그걸 규칙으로 만듭니다.
|  예: "여백은 토큰 값만. 자유 px 금지"
|
|  규칙은 당신에게 쌓입니다. 다음 프로젝트에도 따라옵니다.
|  그래서 문제가 하나 생깁니다.
|
|    이 프로젝트의 규칙이, 저 프로젝트에서도 맞을까?

+- 4/4 ----------------------------- 이 프로젝트는 어떤 곳입니까
|
|  한 줄이면 됩니다. 비워둬도 됩니다. 다만 적어두면, 다른
|  프로젝트의 규칙이 여기로 잘못 끌려오지 않습니다.

+- 스킬 ---------------------------------------------- 스킬 설치
|
|  [x] 1  Claude Code   .claude/skills/awl-loop/ 에 설치
|  [ ] 2  Codex         AGENTS.md 에 추가

  ~/.awl              생성됨
  .awl/config.json    생성됨    <- 커밋하세요. 팀원은 이 파일을 씁니다
  .awl/state.json     gitignore 에 추가함
```

(위 화면은 유니코드 터미널에서는 상자선이 실선으로 그려집니다. `--yes`를 붙이면 질문 없이 감지된 값으로 바로 진행합니다.)

`awl init`이 만든 것:

- **`.awl/config.json`** — 검증 명령과 프로젝트 성격. **커밋하세요.** 팀원이 같이 씁니다.
- **`.awl/state.json`** — 지금 어느 워크아이템의 어느 단계인지. gitignore 대상, 사람마다·워크트리마다 다릅니다.
- **`.claude/skills/awl-loop/`** 또는 **`AGENTS.md`** — 작업 루프 스킬. 선택한 에이전트에 설치됩니다.

이제 에이전트(Claude Code / Codex)를 열고 목표를 서술문으로 줍니다.

```
/awl-loop  페이지 편집기에 여백 시스템을 넣고 싶어
```

스킬이 이 흐름을 따릅니다. **awl은 손발일 뿐, 판단은 에이전트가 합니다.**

```
목표 도착 (너무 크면 awl work new 로 여러 워크아이템으로 쪼갤지부터 판단)
  ↓
[조사] → [설계] → [명료화] → [스파이크] → [완료 조건]
  ↓            (사람만 답할 수 있는 결정이 남았으면 되묻습니다)
=== 게이트 1 === 완료 조건을 사람이 승인 (도구 호출로 멈춥니다)
  ↓
반복(자율) { awl commit --start → 실패 테스트 → 구현 → awl verify → awl commit → awl record }
  ↓  완료 조건 3개마다: 서브에이전트가 리뷰, 지적은 새 완료 조건으로 편입
=== 게이트 2 === 완료. push는 사람이 합니다
  ↓
awl evolve  ← 실패에서 재사용 가능한 교훈을 뽑습니다
```

- `awl commit`은 **내 변경만** 격리 커밋합니다. 같은 파일의 남의 미커밋 변경을 삼키지 않습니다 — hunk가 겹치면 커밋하지 않고 사람이 확인하라고 알립니다.
- `awl verify`가 유일한 심판입니다. 통과 없이 "완료"를 선언할 수 없습니다.
- 3번 막히면 `awl record blocked`로 시도한 접근 세 가지와 각각 왜 실패했는지를 남기고 코드를 버립니다. 같은 시행착오를 반복하지 않기 위해서입니다.

워크아이템이 끝나면(게이트 2 통과) `awl evolve`가 이번 작업에서 재사용 가능한 교훈을 뽑습니다. 같은 교훈이 2번 반복되면 알립니다. 사람이 확인하고 `awl rules promote`로 규칙을 만들면, 다음 프로젝트에도 따라옵니다.

```bash
awl status    # 지금 어디까지 왔는지 한눈에
awl brief     # 오늘(KST) 진행분을 모아서 봅니다 (--json 은 스킬이 읽습니다)
awl records   # 쌓인 기록 (사람이 읽는 목록)
awl rules     # 이 프로젝트에 적용되는 규칙
awl gotchas   # 아직 규칙이 되지 않은 교훈
awl metrics   # 워크아이템 세대별 지표 추세 (--compare 로 실험 케이스 비교)
awl feedback  # awl 도구 자체에 대한 피드백 모아보기
```

---

## `~/.awl` 와 `<project>/.awl` — 무엇이 어디에 쌓이나

awl은 두 층으로 상태를 나눕니다. 헷갈리기 쉬워서 명확히 짚습니다.

| | `~/.awl` (전역, 사람 기준) | `<project>/.awl` (프로젝트 기준) |
|---|---|---|
| 담는 것 | 엔진(스킬 템플릿), 규칙, 교훈(gotcha), 기록(records), 등록된 프로젝트 목록 | 이 프로젝트의 설정(config.json), 지금 루프 위치(state.json) |
| 누구 것인가 | **당신**. 프로젝트를 옮겨 다녀도 따라옵니다 | **이 프로젝트**. 리포지토리를 나가면 안 따라옵니다 |
| git 커밋 | 대상 아님(홈 디렉토리) | `config.json`은 커밋, `state.json`은 gitignore |
| 언제 쓰이나 | 규칙 승격(`rules promote`), 교훈 축적(`evolve`), 여러 프로젝트를 오갈 때 | `awl commit`/`awl verify`/`awl status`가 매번 읽는 현재 작업 컨텍스트 |

이렇게 나눈 이유: **"이 프로젝트에서 배운 것이 저 프로젝트에서도 맞을까?"** 라는 질문에 답하기 위해서입니다. 규칙과 교훈은 프로젝트가 아니라 당신에게 쌓입니다 — `awl init`의 마지막 질문("이 프로젝트는 어떤 곳입니까")이 나중에 그 규칙을 여기로 끌어올지 판단하는 근거가 됩니다.

`AWL_HOME` 환경변수로 전역 위치를 바꿀 수 있습니다(테스트나 CI에서 유용합니다).

---

## 설정(config) — 검증 명령과 모노레포

`.awl/config.json`은 프로젝트의 검증 명령을 담습니다. `awl verify`가 이 명령들을 실제로 실행해 통과/실패를 가릅니다.

```json
{
  "project": "my-project",
  "mainLanguage": "typescript",
  "character": "디자인 토큰 강제, 여백은 자유 px 금지",
  "verify": {
    "typecheck": { "cmd": "tsc --noEmit" },
    "lint": { "cmd": "biome check ." },
    "test": { "cmd": "vitest run" },
    "e2e": null
  }
}
```

`verify.<name>`이 `null`이면 그 검증은 건너뜁니다(설정 안 함 표시).

### 모노레포: 패키지별로 다른 위치에서 검증하기

`typecheck`/`lint`/`test`/`e2e` 각각에 `cwd`(작업 디렉토리)를 지정할 수 있습니다. 상대경로 실행 파일(`../../node_modules/.bin/tsc` 같은 것)도 그 `cwd` 기준으로 정확히 풀립니다.

```json
"verify": {
  "typecheck": { "cmd": "tsc -p gallery/tsconfig.json", "cwd": "packages/page-harness" }
}
```

`awl init`이 모노레포를 감지하면(루트에 검증 명령이 안 보이면) 어느 패키지를 검증할지 물어봅니다. 나중에 바꾸려면:

```bash
$ awl config set verify.typecheck.cwd packages/app
  저장했습니다: verify.typecheck.cwd = packages/app
```

`cwd` 디렉토리가 실제로 없으면 저장을 거부합니다(`--force`로 강제 가능):

```bash
$ awl config set verify.typecheck.cwd packages/nope
  디렉토리가 없습니다: /Users/you/my-project/packages/nope
그래도 저장하려면 --force 를 붙이세요.
```

키를 생략하면 지금 설정 가능한 키와 현재 값을 전부 보여줍니다:

```bash
$ awl config set
  설정 가능한 키
    project               my-project
    mainLanguage          typescript
    verify.typecheck.cmd  tsc --noEmit
    verify.typecheck.cwd  packages/app
    verify.typecheck.env  (없음)
    ...
```

TTY에서 `awl config`를 인자 없이 실행하면 항목을 골라 수정할 수 있는 화면이 뜹니다.

---

## 워크아이템 여러 개 오가기 (`awl work`)

한 프로젝트에서 동시에 여러 작업을 오갈 때 씁니다. `.awl/state.json`의 "지금 어느 워크아이템인가"를 전환합니다.

```bash
awl work list              # 등록된 워크아이템과 진행 상황
awl work new <ID> [설명]   # 새 워크아이템을 만들고 전환(현재 것은 보관)
awl work switch <ID>       # 보관된 워크아이템으로 전환
awl work abandon <ID>      # 중단 표시(삭제 아님 — 기록은 남습니다)
```

```bash
$ awl work list

  워크아이템

  * WI-D  active  8/12 통과  main
    WI-C  paused  4/4 통과
```

`*`가 지금 작업 중인 워크아이템입니다. `switch`로 다른 브랜치에서 만든 워크아이템으로 돌아가면, 그 워크아이템이 만들어질 때의 브랜치와 지금 브랜치가 다를 경우 경고합니다(막지는 않습니다 — 판단은 당신 몫입니다).

완료 조건 사이에 순서가 있으면 `dependsOn`을 붙일 수 있습니다. `awl status`가 아직 안 끝난 선행 조건이 있는 완료 조건을 "블록됨"으로 보여줍니다(계산만 합니다 — 어느 걸 먼저 할지는 스킬이 정합니다).

---

## 규칙과 교훈 — 어떻게 쌓이고 어떻게 승격되나

1. 작업 중 실패하면(3번 막히면) `awl record blocked`로 무엇을 시도했고 왜 실패했는지 남깁니다.
2. 워크아이템이 끝나면(게이트 2 통과) `awl evolve`가 이 기록들을 모아 재사용 가능한 교훈(gotcha)으로 추출합니다. `awl gotchas`로 볼 수 있습니다.
3. 같은 교훈이 2번 나오면 스킬이 알립니다. **자동으로 규칙이 되지 않습니다.** 사람이 직접 판단해 승격합니다:

```bash
awl rules promote G-003 \
  --applies "여백 값을 CSS/스타일에 쓸 때" \
  --counter "이미 디자인 토큰 시스템이 없는 프로젝트"
```

4. 승격된 규칙은 `~/.awl/rules/active/`에 쌓여 **당신이 여는 모든 프로젝트**에 적용됩니다. `awl rules`로 지금 프로젝트에 적용되는 규칙을 봅니다(프로젝트의 `character`와 규칙의 `applies`/`counter` 조건을 대조해서 걸러줍니다).

규칙은 최대 15개까지만 유지됩니다 — 계속 쌓이면 아무도 안 읽는 규칙 목록이 되기 때문입니다. 검사기(lint 등)로 강제할 수 있는 것은 규칙으로 만들지 마세요. 규칙은 검사기가 못 잡는, 그러나 반복해서 틀렸던 판단만 남깁니다.

### 교훈(gotcha)과 awl 자체 피드백은 다릅니다

작업하다 배운 교훈은 gotcha입니다 — 작업 대상 코드에 대한 것이고, `~/.awl/gotchas`에 쌓여 규칙 후보가 됩니다. 이와 종류가 다른 것이 하나 있습니다: **awl 도구 자체가 불편했던 점**입니다. "`awl commit`이 이래서 아팠다" 같은 것은 `awl record awl-feedback`으로 남기면 `~/.awl/records`에 따로 모이고, 규칙으로 승격되지 않습니다 — awl을 고칠 재료이지 당신의 작업 규칙이 아니기 때문입니다. `awl feedback`으로 area(commit/gate/verify/state 등)별로 묶어 봅니다.

(예전 버전은 교훈을 delta라고 불렀습니다. 지금은 gotcha로 이름이 바뀌었고, 옛 `~/.awl/deltas`는 처음 읽을 때 자동으로 `~/.awl/gotchas`로 옮겨집니다 — 교훈 번호도 `G-`로 매겨집니다.)

---

## 문제 해결

**`awl: command not found` (pnpm 설치 후)**
`pnpm setup`을 실행하고 터미널을 새로 엽니다. pnpm 전역 bin이 PATH에 없어서입니다.

**`awl --version`이 엔진 버전 불일치를 경고한다**
`awl`을 업그레이드했는데 `~/.awl/engine`은 예전 버전 그대로일 때 나옵니다. 실행 바이너리와 설치된 엔진이 어긋난 것이므로, `awl update`로 엔진을 갱신하면 맞춰집니다(프로젝트 설정은 안 건드립니다). 어긋난 버전 쌍을 직접 보려면 `awl version-check`를 씁니다 — package.json, 설치된 엔진, 프로젝트 config, 설치된 스킬 사이의 불일치를 짚어줍니다. 프로젝트 config가 엔진보다 낡았다면 그때는 `awl init`을 다시 실행합니다.

**`awl doctor`가 검증 명령을 "명령을 찾을 수 없습니다"라고 한다**
`node_modules/.bin`이 지금 셸의 PATH에 없을 수 있습니다(에디터 내장 터미널이 아닌 별도 셸에서 흔합니다). `cwd`를 지정했다면 그 디렉토리 자체가 없는 건 아닌지도 확인하세요 — `doctor`가 "cwd 없음"으로 구분해 알려줍니다.

**모노레포에서 검증 명령이 상대경로 실행 파일을 못 찾는다**
`verify.<name>.cwd`를 그 패키지 디렉토리로 지정하세요. `cwd` 없이 검증 명령을 프로젝트 루트에서 실행하면 `../../node_modules/.bin/tsc` 같은 상대경로가 안 풀립니다.

**`awl commit`이 "hunk가 남의 변경과 겹칠 수 있다"며 거부한다**
정확한 동작입니다 — 확신할 수 없으면 커밋하지 않고 사람에게 알리도록 설계했습니다. `git status`/`git diff`로 실제로 무엇이 섞였는지 직접 확인하세요. 같은 파일을 여러 완료 조건에 걸쳐 연속으로 편집했다면(베이스라인을 갱신하지 않고), 완료 조건마다 `awl commit <AC> -m`으로 닫고 다음으로 넘어가는 습관을 들이세요.

**게이트에서 스킬이 안 멈추고 그냥 진행한다**
스킬 문서(`awl-loop`)가 게이트에서 반드시 도구를 호출하도록 지시돼 있습니다. 계속 안 멈추면 스킬이 최신인지 확인하세요(`awl init`을 다시 실행하면 스킬 템플릿이 갱신됩니다).

---

## 이름에 대하여

npm에 `awl` 패키지가 이미 있어, 패키지 이름은 `agent-work-loop`로 배포하고 명령어 이름만 `awl`로 제공합니다. 둘이 다른 것은 의도된 선택입니다.

## 개발

이 저장소는 pnpm을 사용합니다.

```bash
pnpm install      # 의존성 설치
pnpm run build    # dist/cli.js 빌드
pnpm test         # vitest 실행
pnpm run lint     # biome 검사
pnpm run typecheck
```

릴리스는 `pnpm release:patch` / `pnpm release:minor` / `pnpm release:major`로 합니다. 검증·빌드·tarball·`npm publish --dry-run`을 통과한 뒤 버전, CHANGELOG, 커밋, 태그, 원격 push를 한 번에 처리합니다. `[Unreleased]`가 비어 있으면 마지막 릴리스 태그 뒤의 conventional commit 제목으로 CHANGELOG를 자동 작성하고, 직접 쓴 내용이 있으면 그대로 보존합니다. **`npm publish`만 사람이 실행합니다.**

## 라이선스

MIT
