# agent-work-loop

[![npm version](https://img.shields.io/npm/v/agent-work-loop.svg)](https://www.npmjs.com/package/agent-work-loop)
[![CI](https://github.com/kh1012/agent-work-loop/actions/workflows/ci.yml/badge.svg)](https://github.com/kh1012/agent-work-loop/actions/workflows/ci.yml)
[![release](https://img.shields.io/github/v/tag/kh1012/agent-work-loop?label=release&sort=semver)](https://github.com/kh1012/agent-work-loop/tags)
[![license](https://img.shields.io/npm/l/agent-work-loop.svg)](LICENSE)

`agent-work-loop`(명령어: `awl`)은 AI 에이전트가 같은 실패를 두 번 반복하지 않도록 돕는 도구입니다. 에이전트가 작업하며 남긴 기록, 검증 결과, 완료 조건, 규칙, 교훈, 막힘을 파일로 관리합니다.

**awl 자체는 판단하지 않습니다.** LLM을 호출하지 않고, 파일과 상태만 결정적으로 다룹니다. 무엇을 배우고 어떤 규칙을 세울지는 이미 설치된 에이전트(Claude Code, Codex)가 스킬로 판단합니다.

이 README는 **실용 문서**입니다. 설치부터 첫 루프까지, 손으로 따라 할 수 있는 순서만 다룹니다. "왜 이렇게 만들었는가"(하네스 개념, 게이트 위치, narrative 실증 사례)는 [`docs/presentation/storyline.md`](docs/presentation/storyline.md)에, 명령어 하나하나의 자세한 사용법은 [`docs/presentation/commands.md`](docs/presentation/commands.md)에 정리했습니다.

크로스 환경을 처음부터 전제로 합니다. macOS와 Windows, Claude Code와 Codex를 모두 지원하는 것을 목표로 합니다(Windows는 아직 macOS만큼 검증되지 않았습니다. [알려진 위험](docs/decisions.md)을 참고하세요).

## 목차

- [언제 쓰나](#언제-쓰나)
- [설치](#설치)
- [5분 시작](#5분-시작)
- [LLM과 함께 실제로 쓰는 시나리오](#llm과-함께-실제로-쓰는-시나리오)
- [명령어 요약](#명령어-요약)
- [설정(config): 검증 명령과 모노레포](#설정config-검증-명령과-모노레포)
- [무엇이 어디에 쌓이나](#무엇이-어디에-쌓이나)
- [워크아이템 병행](#워크아이템-병행)
- [오케스트레이션 파이프라인: 여러 레인을 나란히](#오케스트레이션-파이프라인-여러-레인을-나란히)
- [문제 해결](#문제-해결)
- [기여하기](#기여하기)

---

## 언제 쓰나

세 단계로 나뉩니다. 자세한 판단 기준은 [`storyline.md` 3절](docs/presentation/storyline.md)에 있고, 여기서는 요약만 둡니다.

1. **요구사항 하나**: 그냥 합니다. awl이 필요 없습니다.
2. **완료 조건이 여러 개고 되돌아볼 가치가 있는 작업**: Claude Code는 `/awl-loop`, Codex는 `$awl-loop`. 조사→게이트1→자율 반복→게이트2→evolve를 한 세션이 진행합니다.
3. **여러 워크아이템을 격리해서 돌려야 할 때**: Claude Code는 `/awl-pipeline`, Codex는 `$awl-pipeline`. `awl lane`으로 격리 워크트리를 만들고, 오케스트레이터가 plan/exec/review를 스폰합니다.

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

저장소를 직접 빌드해서 쓰고 싶다면(기여하거나 배포 전 최신 상태를 바로 써보고 싶을 때):

```bash
git clone https://github.com/kh1012/agent-work-loop.git && cd agent-work-loop
pnpm install && pnpm run build
pnpm link --global   # 또는: npm link
```

`dist/cli.js`가 `awl` bin으로 등록됩니다.

### 업데이트 하기

```
1. npm i -g agent-work-loop@latest    npm에 배포된 최신 버전을 받습니다
2. awl update                         설치된 패키지로 전역 엔진(~/.awl/engine)을 갱신합니다
```

pnpm이나 yarn을 쓴다면 1번만 그 도구로 바꿉니다. `awl update`(옵션 없음)는 `awl update --global`과 같습니다. 전역 엔진만 갱신하고 어떤 프로젝트도 건드리지 않습니다. 대부분은 이 두 줄이면 끝입니다.

**여러 프로젝트를 관리하는 입장이라면** 등록된 프로젝트들의 로컬 스킬(`.claude/skills`, `.agents/skills`, `AGENTS.md`, `.awl/config.json`)까지 한 번에 맞추고 싶을 수 있습니다.

```bash
npm i -g agent-work-loop@latest
awl update --all
```

`--all`은 전역 엔진과 `~/.awl/projects.json`에 등록된 프로젝트 전부의 로컬 스킬을 갱신하고, 끝에 바뀐 프로젝트 목록과 "커밋하세요" 안내를 보여줍니다. 등록된 프로젝트만 로컬을 건드리고 싶으면 `--local`만 씁니다.

이렇게 갱신한 프로젝트를 커밋해서 push하면, 그 저장소를 쓰는 다른 사람들은 다음에 pull할 때 최신 스킬을 받습니다. **다만 자동으로 알림이 가는 구조는 아닙니다.** 각자 컴퓨터의 `~/.awl/engine`이 낡았는지는 그 사람이 `awl doctor`/`awl version-check`를 실행하거나 loop/pipeline 스킬을 실행할 때(버전 확인이 맨 처음 단계로 들어있습니다) 노란 경고로 보게 됩니다.

설치가 됐는지 확인합니다.

```bash
$ awl doctor

+  Agent Work Loop · 진단
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
|  `-- config.json: 없음  [x] awl init 을 실행하세요
|
|  에이전트
|  |-- Claude Code: 없음
|  `-- Codex: 없음
|
|  [x] 문제 2개. awl init 을 실행하세요.
+
```

터미널이 유니코드/색을 지원하면(Windows Terminal, VS Code 터미널 등) 자동으로 감지해 상자 그림과 색을 씁니다. 지원 안 되면 위처럼 ASCII로 자동 전환됩니다. `doctor`는 아무것도 고치지 않습니다. 점검만 합니다.

---

## 5분 시작

프로젝트 디렉토리에서 한 번만 실행합니다.

```bash
$ cd my-project
$ awl init
```

질문 없이 감지된 값으로 바로 진행하려면 `awl init --yes`를 씁니다. 실제 출력:

```
+  설정 완료
|  [v0.6.46]
|    ~/.awl              생성됨
|    ~/.awl/engine       0.6.46
|    .awl/config.json    생성됨    <- 커밋하세요. 팀원은 이 파일을 씁니다
|    .awl/state.json     gitignore 에 추가함    [ok] git push 차단 훅 설치
|  규칙 0개 · 교훈 0개 · 등록된 프로젝트 1개 · 1세대
+

+  다음 단계
|  Claude Code 를 열고 이렇게 말하세요.
|
|  /awl-loop  페이지 편집기에 여백 시스템을 넣고 싶어
|
|  /awl-pipeline <레인명> --gl 을 실행해보세요.
|  (격리된 작업 세션이 생성되며, 자율 모드로 실행됩니다.)
+
```

대화형 모드(`--yes` 없이)는 3단계 화면(1/3 주 언어 → 2/3 검증 명령어 → 3/3 규칙과 이 프로젝트의 성격)을 방향키(또는 번호)로 물은 뒤, 설치할 에이전트를 고르는 스킬 화면을 보여줍니다.

`awl init`이 만든 것:

- **`.awl/config.json`**: 검증 명령과 프로젝트 성격. **커밋하세요.** 팀원이 같이 씁니다.
- **`.awl/state.json`**: 지금 어느 워크아이템의 어느 단계인지. gitignore 대상입니다.
- **`.claude/skills/`** 또는 **`.agents/skills/` + `AGENTS.md`**: 작업 루프 스킬. 선택한 에이전트에 설치됩니다.
- **`.git/hooks/pre-push`**: "push는 사람이 한다"는 규칙을 git 레벨에서도 강제하는 훅. 사람이 실제 터미널에서 직접 치는 `git push`는 그냥 통과합니다(제어 터미널이 잡히는지로 판별). 에이전트가 비대화형으로 실행한 push는 막히고, 이 경우엔 `AWL_ALLOW_PUSH=1 git push`로 명시적으로 통과시켜야 합니다.

이제 에이전트(Claude Code / Codex)를 열고 목표를 서술문으로 줍니다. Codex에서는 `/` 대신 `$awl-loop`로 스킬을 명시합니다.

```
/awl-loop  페이지 편집기에 여백 시스템을 넣고 싶어
```

스킬이 [조사]→[설계]→[명료화]→[스파이크]→[완료 조건]→게이트1→자율 반복→게이트2→evolve를 진행합니다. 왜 이 순서인지는 [`storyline.md` 6절](docs/presentation/storyline.md)에서 다룹니다.

```bash
awl status    # 지금 어디까지 왔는지 한눈에
```

명령어 전체와 스킬(`awl-loop`·`awl-pipeline`) 부연설명은 CLI 안에서도 바로 볼 수 있습니다.

```bash
awl --examples   # 자주 쓰는 명령 예시
awl --skills     # /awl-loop·/awl-pipeline·레인·게이트 밀도(<mode>) 설명
```

---

## LLM과 함께 실제로 쓰는 시나리오

위 5분 시작이 워크아이템 하나를 트리거하는 법이었다면, 여기서는 설치부터 여러 워크아이템을 동시에 돌리는 것까지 이어 붙입니다.

### 워크아이템 하나: `awl-loop`

위 "5분 시작"에서 다룬 흐름 그대로입니다. `awl init`이 설치한 스킬로 에이전트를 열고 목표 하나를 서술문으로 던지면, 한 세션이 조사부터 게이트1·게이트2까지 진행합니다. 무관한 작업을 여러 개 동시에 돌리고 싶을 때는 다음으로 넘어갑니다.

### 여러 워크아이템 동시에: `awl-pipeline`

무관한 작업 여러 개를 병행하고 싶으면 Claude Code에서 `/awl-pipeline <레인명> <mode>`, Codex에서 `$awl-pipeline <레인명> <mode>`를 씁니다.

```
/awl-pipeline design-tokens gate-medium
```

`awl init`에서 Codex를 고르면 `.agents/skills/`에 loop와 pipeline 4개 역할 스킬이 함께 설치됩니다. 기존 Codex 설치도 `awl init --yes` 또는 `awl update --local`을 다시 실행하면 긴 `AGENTS.md` 기반 지침이 짧은 라우팅 블록 + 실제 스킬 디렉토리 구조로 바뀝니다.

**레인명(첫 인자)**: 이름을 주면 `.awl-worktrees/<이름>`에 격리 워크트리를 만들어(없으면 자동으로 `awl lane new`) 그 안에서 돕니다. 인자를 생략하면(mode만 주거나 아무 인자도 없으면) cwd 대신 `unknown-lane-<N>`을 자동으로 만들어 격리해서 돕니다. cwd에 이미 다른 파이프라인이 돌고 있을 때 스폰이 엉키는 사고를 막기 위한 기본값입니다. `.`을 명시하면(`/awl-pipeline . gate-low`) 자동 격리 없이 지금 cwd를 그대로 씁니다. cwd에 라이브 파이프라인이 없다고 확신할 때만 쓰는 탈출구입니다.

**mode(둘째 인자)**: 게이트 밀도입니다. 생략하면 `gate-high`.

| mode | 축약 | 뜻 |
|---|---|---|
| `gate-high`(기본) | `--gh` | 게이트마다 사람 승인을 기다립니다. 개입 최대 |
| `gate-medium` | `--gm` | 승인은 자동 진행하되, 심각도 `high`인 항목만 큐에 모아 사이클 끝에 따로 보고합니다 |
| `gate-low` | `--gl` | 전부 자율로 진행하고, 사이클 끝에 요약만 한 번 보여줍니다. 개입 최소 |

### 실행 시점에 실제로 벌어지는 일

pipeline 스킬을 받은 세션은 **오케스트레이터(plan 역할)**가 됩니다. 목표를 조사해 그 레인의 `.tasks/plan/<name>.md`로 쓰고 exec·review 에이전트를 스폰합니다. 한 레인에는 writer를 하나만 두고 워크아이템을 순차 처리합니다(리뷰 피드백 반영이 신규 착수보다 먼저). Claude Code는 파일 워처로 역할 세션을 깨우고, Codex는 `wait_agent`로 완료를 기다린 뒤 `followup_task`로 idle 역할을 다시 깨웁니다. 둘 다 `.tasks/` 파일명이 상태의 정본입니다.

### 완료 시점에 남는 기록

워크아이템이 게이트2를 통과하면 `awl evolve`가 그 워크아이템의 기록을 훑어 다음을 남깁니다.

- **`~/.awl/records/`**: 있었던 일의 전수(시도·실패·리뷰·게이트 결정 전부). 지우지 않습니다.
- **`~/.awl/gotchas/`**: evolve가 실패·리뷰 기록에서 뽑은 재사용 가능한 교훈 한 줄. 강제력 없습니다.
- **`~/.awl/generations/<project>/<WI>.json`**: 이 워크아이템의 세대 지표(완료조건 수, 평균 시도, 막힘 비율, 리뷰 지적 수 등) 스냅샷.
- 같은 gotcha가 2번 반복되면 사람이 `awl rules promote`로 **`~/.awl/rules/active/`**에 규칙으로 승격할 수 있습니다(자동 승격은 없습니다).

### 기록 보는 법

```bash
awl records --json     # 있었던 일 전수(타입·워크아이템으로 필터 가능)
awl gotchas            # 아직 규칙 안 된 교훈
awl rules               # 이 프로젝트에 적용되는 규칙
awl metrics --compare   # 워크아이템 세대별 지표 추세
awl brief               # 오늘(KST) 진행분만 모아 보기
awl defer-summary       # gate-medium/gate-low에서 보류된 중요 항목 최종 확인
```

`~/.awl`을 직접 열어보면 이렇게 생겼습니다.

```
~/.awl/
  engine/                 설치된 스킬 원본. awl update가 덮어쓰므로 손대지 않습니다
  records/YYYY-MM.jsonl   월별 기록(append-only)
  gotchas/*.json          아직 규칙 안 된 교훈
  rules/active/R-NNN.md   승격된 규칙(상한 15개)
  generations/<project>/  워크아이템별 세대 지표 스냅샷
  templates/              개인 초안 기본값(강제 아님)
  projects.json           등록된 프로젝트 목록
```

각 칸의 역할과 이걸 사람 단위로 쌓는 이유는 [`storyline.md` 4절·5절](docs/presentation/storyline.md)에서 더 다룹니다.

---

## 명령어 요약

자주 쓰는 것만 적습니다. 전체 명령과 실제 실행 예시는 [`commands.md`](docs/presentation/commands.md)에, `awl --examples`로도 바로 볼 수 있습니다.

```bash
awl status    # 지금 어디까지 왔는지
awl doctor    # 설치·환경 점검 (아무것도 안 고침)
awl brief     # 오늘(KST) 진행분 모아 보기
awl records   # 쌓인 기록
awl gotchas   # 아직 규칙이 안 된 교훈
awl rules     # 이 프로젝트에 적용되는 규칙
awl metrics   # 워크아이템 세대별 지표 추세
awl feedback-log  # awl 도구 자체에 남겨진 피드백 기록 검토
```

---

## 설정(config): 검증 명령과 모노레포

`.awl/config.json`은 프로젝트의 검증 명령을 담습니다. `awl verify`가 이 명령들을 실제로 실행해 통과/실패를 가릅니다.

```json
{
  "project": "my-project",
  "mainLanguage": ["typescript"],
  "character": "디자인 토큰 강제, 여백은 자유 px 금지",
  "verify": {
    "typecheck": { "cmd": "tsc --noEmit" },
    "lint": { "cmd": "biome check ." },
    "test": { "cmd": "vitest run" },
    "e2e": null
  }
}
```

`verify.<name>`이 `null`이면 그 검증은 건너뜁니다.

### 모노레포: 패키지별로 다른 위치에서 검증하기

`typecheck`/`lint`/`test`/`e2e` 각각에 `cwd`(작업 디렉토리)를 지정합니다. 상대경로 실행 파일(`../../node_modules/.bin/tsc` 같은 것)도 그 `cwd` 기준으로 풀립니다.

```json
"verify": {
  "typecheck": { "cmd": "tsc -p gallery/tsconfig.json", "cwd": "packages/page-harness" },
  "test":      { "cmd": "vitest run", "cwd": "packages/app" }
}
```

`awl init`이 모노레포를 감지하면(루트에 검증 명령이 안 보이면) 어느 패키지를 검증할지 물어봅니다. 나중에 바꾸려면:

```bash
$ awl config set verify.typecheck.cwd packages/app
  저장했습니다: verify.typecheck.cwd = packages/app
```

`cwd` 디렉토리가 실제로 없으면 저장을 거부합니다(`--force`로 강제 가능). 키를 생략하면 지금 설정 가능한 키와 현재 값을 전부 보여줍니다. TTY에서 `awl config`를 인자 없이 실행하면 항목을 골라 수정하는 화면이 뜹니다.

---

## 무엇이 어디에 쌓이나

| | `~/.awl` (전역, 사람 기준) | `<project>/.awl` (프로젝트 기준) |
|---|---|---|
| 담는 것 | 엔진(스킬 템플릿), 규칙, 교훈(gotcha), 기록(records), 등록된 프로젝트 목록 | 이 프로젝트의 설정(config.json), 지금 루프 위치(state.json) |
| 누구 것인가 | **당신**. 프로젝트를 옮겨 다녀도 따라옵니다 | **이 프로젝트**. 리포지토리를 나가면 안 따라옵니다 |
| git 커밋 | 대상 아님(홈 디렉토리) | 프로젝트마다 다름 — `state.json`은 항상 gitignore, `config.json`은 팀 컨벤션에 따라 커밋하거나 로컬 전용으로 gitignore할 수 있습니다 |

두 층으로 나눈 이유(다음 프로젝트에서 빈손으로 시작하지 않기 위해)와 규칙/교훈이 어떻게 승격되는지는 [`storyline.md` 4절·5절](docs/presentation/storyline.md)에서 다룹니다. `AWL_HOME` 환경변수로 전역 위치를 바꿀 수 있습니다(테스트·CI에서 유용합니다).

규칙 승격은 사람이 직접 합니다(자동 승격 없음).

```bash
awl rules promote G-003 \
  --applies "여백 값을 CSS/스타일에 쓸 때" \
  --counter "이미 디자인 토큰 시스템이 없는 프로젝트"
```

교훈(gotcha, `~/.awl/gotchas`)과 awl 도구 자체 피드백(`~/.awl/records`, `awl record awl-feedback`)은 다른 종류입니다. 전자는 작업 대상 코드에 대한 것이고, 후자는 "awl commit이 이래서 아팠다" 같은 도구 자체의 문제입니다. `awl feedback-log`로 모아 봅니다.

---

## 워크아이템 병행

한 프로젝트에서 동시에 여러 작업을 오갈 때 `awl work`를 씁니다.

```bash
awl work list              # 등록된 워크아이템과 진행 상황
awl work new <ID> [설명]   # 새 워크아이템을 만들고 전환(현재 것은 보관)
awl work switch <ID>       # 보관된 워크아이템으로 전환
```

`*`가 지금 작업 중인 워크아이템입니다. `awl work switch`로 다른 브랜치에서 만든 워크아이템으로 돌아가면, 그 워크아이템이 만들어질 때의 브랜치와 지금 브랜치가 다를 경우 경고합니다(막지는 않습니다). 완료 조건 사이에 순서가 있으면 `dependsOn`을 붙일 수 있고, `awl status`가 아직 안 끝난 선행 조건이 있는 완료 조건을 "블록됨"으로 보여줍니다.

---

## 오케스트레이션 파이프라인: 여러 레인을 나란히

위 "워크아이템 병행"이 한 워크트리 안에서 작업을 순차로 오가는 **작업 루프**라면, 오케스트레이션은 워크아이템마다 전용 워크트리(레인)를 두고 **나란히** 진행하는 층입니다. 세 조각으로 씁니다.

- **`awl lane`**: 격리 레인을 만듭니다. `awl lane new <이름>`은 전용 워크트리와 별도 `AWL_HOME`, 스킬 한 벌을 깔고 기동 안내를 찍습니다. `awl lane ls`로 현존 레인을 보고, `awl lane rm <이름>`으로 정리합니다.
- **`awl status --pipeline`**: 레인별 진행을 한 화면에 모읍니다. 각 레인 안의 plan/exec/review 단계 상태를 배지로 훑습니다.
- **역할 스킬(`awl-pipeline` 계열)**: 오케스트레이터가 plan 역할로 들어가 exec·review를 스폰합니다. `awl init`에서 Claude Code 또는 Codex를 선택하면 해당 에이전트용 구현이 함께 설치됩니다.

개념(왜 3단으로 나뉘는지, `pipeline-hold-recheck` 실증 사례)은 [`storyline.md` 3절·6절](docs/presentation/storyline.md)에서, 명령별 실행 예시는 [`commands.md`](docs/presentation/commands.md)에서 다룹니다.

**로드맵**: 한 pipeline 호출 안의 역할 스폰은 Claude Code와 Codex 모두 지원합니다. 서로 다른 여러 레인을 한 호출에서 동시에 생성·감독하는 상위 스케줄러는 아직 없습니다. 지금은 레인마다 별도 pipeline 세션을 열어 병렬 실행합니다.

---

## 문제 해결

**`awl: command not found` (pnpm 설치 후)**
`pnpm setup`을 실행하고 터미널을 새로 엽니다. pnpm 전역 bin이 PATH에 없어서입니다.

**`awl --version`이 엔진 버전 불일치를 경고한다**
`awl`을 업그레이드했는데 `~/.awl/engine`은 예전 버전 그대로일 때 나옵니다. `awl update`로 엔진을 갱신하면 맞춰집니다(프로젝트 설정은 안 건드립니다). `awl version-check`로 어긋난 버전 쌍(package.json, 설치된 엔진, 프로젝트 config, 설치된 스킬)을 직접 봅니다. 프로젝트 config가 엔진보다 낡았다면 `awl init --yes`를 다시 실행합니다.

**업그레이드해도 프로젝트 설정이 사라지나요**
아니요. `awl init --yes`는 `config.engineVersion`만 지금 엔진에 맞추고, 팀이 정한 검증 명령 등 나머지 설정 필드는 그대로 둡니다.

**`awl doctor`가 검증 명령을 "명령을 찾을 수 없습니다"라고 한다**
`node_modules/.bin`이 지금 셸의 PATH에 없을 수 있습니다. `cwd`를 지정했다면 그 디렉토리 자체가 없는 건 아닌지도 확인하세요.

**모노레포에서 검증 명령이 상대경로 실행 파일을 못 찾는다**
`verify.<name>.cwd`를 그 패키지 디렉토리로 지정하세요. `cwd` 없이 프로젝트 루트에서 실행하면 `../../node_modules/.bin/tsc` 같은 상대경로가 안 풀립니다.

**`awl commit`이 "hunk가 남의 변경과 겹칠 수 있다"며 거부한다**
정확한 동작입니다. 확신할 수 없으면 커밋하지 않고 사람에게 알리도록 설계했습니다. `git status`/`git diff`로 실제로 무엇이 섞였는지 확인하세요. 완료 조건마다 `awl commit <AC> -m`으로 닫고 넘어가는 습관을 들이세요(`awl commit --start`를 편집보다 먼저 호출하지 않으면 그 편집이 스냅샷에 흡수돼 격리 커밋이 무의미해집니다).

**`git push`가 막힌다**
`awl init`이 심는 pre-push 훅 때문입니다(위 5분 시작 참고). 실제 터미널에서 사람이 직접 치는 push는 막히지 않습니다 — 막혔다면 비대화형(에이전트, CI, 스크립트)으로 실행된 경우이고, 그때는 `AWL_ALLOW_PUSH=1 git push`를 씁니다.

**대형 저장소에서 `awl lane new`/`awl work new --worktree`가 `Could not write new index file`로 실패한다**
`git worktree add`가 기본 180초 안에 못 끝나 강제 종료됐다는 뜻입니다(대형 모노레포는 체크아웃이 오래 걸립니다) — 디스크 문제가 아닙니다. `AWL_GIT_WORKTREE_TIMEOUT_MS=<ms>` 환경변수로 값을 늘려 다시 시도하세요(예: `AWL_GIT_WORKTREE_TIMEOUT_MS=300000 awl lane new <이름>`).

**게이트에서 스킬이 안 멈추고 그냥 진행한다**
스킬 문서가 게이트에서 실제로 턴을 끝내고 사용자 응답을 기다리도록 지시돼 있습니다. 계속 안 멈추면 스킬이 최신인지 확인하세요. `awl doctor`가 `claude-skill-vs-engine` 또는 `codex-skill-vs-engine` 불일치를 경고하면 `awl init --yes`로 재설치합니다.

**awl을 완전히 제거하려면**
`awl remove`를 실행합니다. 기본은 드라이런이라 먼저 무엇이 지워질지 보여주고, 실제로 지우려면 `--yes`를 붙입니다. 기본은 이 프로젝트만 지우고, `~/.awl`까지 지우려면 `--global`을 명시해야 합니다. 자세한 플래그와 실제 출력은 [`commands.md`의 `awl remove`](docs/presentation/commands.md#awl-remove)를 참고하세요.

---

## 기여하기

이 저장소는 pnpm을 사용합니다.

```bash
pnpm install      # 의존성 설치
pnpm run build    # dist/cli.js 빌드
pnpm test         # vitest 실행
pnpm run lint     # biome 검사
pnpm run typecheck
```

PR을 올리면 [GitHub Actions](.github/workflows/ci.yml)가 Node 18/22 두 버전에서 typecheck·lint·test·build를 자동으로 돌립니다.

릴리스는 `pnpm release:patch` / `pnpm release:minor` / `pnpm release:major`로 합니다. 검증·빌드·tarball·`npm publish --dry-run`을 통과한 뒤 버전, CHANGELOG, 커밋, 태그, 원격 push를 한 번에 처리합니다. **`npm publish`만 사람이 실행합니다.**

npm에 `awl` 패키지가 이미 있어, 패키지 이름은 `agent-work-loop`로 배포하고 명령어 이름만 `awl`로 씁니다.

라이선스는 [MIT](LICENSE)입니다.
