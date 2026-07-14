# 변경 이력

이 프로젝트는 [유의적 버전](https://semver.org/lang/ko/)을 따릅니다.
형식은 [Keep a Changelog](https://keepachangelog.com/ko/1.0.0/)를 따릅니다.

## [Unreleased]

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
