# agent-work-loop

`agent-work-loop`(명령어: `awl`)은 AI 에이전트가 같은 실패를 두 번 반복하지 않도록 돕는 도구입니다. 에이전트가 작업하며 남긴 기록, 검증 결과, 완료 조건, 규칙, 교훈, 막힘을 파일로 관리합니다.

awl 자체는 판단하지 않습니다. LLM을 호출하지 않고, 파일과 상태만 결정적으로 다룹니다. 무엇을 배우고 어떤 규칙을 세울지는 이미 설치된 에이전트(Claude Code, Codex)가 스킬을 통해 판단합니다. 에이전트가 머리라면 awl은 손발입니다. 그래서 awl의 모든 동작은 예측할 수 있고 테스트할 수 있습니다.

크로스 환경을 처음부터 전제로 합니다. macOS와 Windows, Claude Code와 Codex를 모두 지원하는 것을 목표로 하며, 경로·홈 디렉토리·셸·줄바꿈·터미널 렌더링의 차이를 고려합니다.

## 어떻게 쓰나요

### 1. 설치

```bash
npm install -g agent-work-loop
awl doctor            # 설치와 환경을 점검합니다
```

### 2. 프로젝트에 설정하기

프로젝트 디렉토리에서 한 번만 실행합니다. 이것이 유일한 튜토리얼입니다 — 질문마다 왜 묻는지 설명합니다.

```bash
awl init              # 주 언어·검증 명령을 자동 감지해 확인만 받습니다
                      # 쓰는 에이전트(Claude Code / Codex)에 스킬을 설치합니다
```

`awl init`은 이런 것을 만듭니다.

- `.awl/config.json` — 검증 명령과 프로젝트 성격 (**커밋하세요.** 팀원이 씁니다)
- `.awl/state.json` — 현재 루프 위치 (gitignore, 각자의 것)
- `.claude/skills/awl-loop/` 또는 `AGENTS.md` — 작업 루프 스킬

### 3. 작업 루프 돌리기

에이전트(Claude Code / Codex)를 열고 목표를 서술문으로 줍니다.

```
/awl-loop  페이지 편집기에 여백 시스템을 넣고 싶어
```

그러면 스킬이 이 흐름을 따릅니다. **awl은 손발일 뿐, 판단은 에이전트가 합니다.**

```
[조사] → [설계] → [스파이크] → [완료 조건]
  ↓  게이트 1: 완료 조건을 사람이 승인 (도구 호출로 멈춥니다)
반복 { awl commit --start → 실패 테스트 → 구현 → awl verify → awl commit }
  ↓  게이트 2: 완료. push는 사람이 합니다
awl evolve  ← 실패에서 교훈을 뽑습니다
```

- `awl commit`은 **내 변경만** 격리 커밋합니다. 같은 파일의 남의 미커밋 변경을 삼키지 않습니다.
- `awl verify`가 유일한 심판입니다. 통과 없이 "완료"를 선언할 수 없습니다.
- 3번 막히면 `awl record blocked`로 시도한 접근들을 남기고 코드를 버립니다.

### 4. 배움이 쌓입니다

워크아이템이 끝나면 `awl evolve`가 이번 실패에서 재사용 가능한 교훈을 뽑습니다. 같은 교훈이 2번 반복되면 알립니다. 사람이 확인하고 `awl rules promote`로 규칙을 만들면, 다음 프로젝트에도 따라옵니다.

```bash
awl status            # 지금 어디까지 왔는지 한눈에
awl records           # 쌓인 기록 (사람이 읽는 목록)
awl rules             # 이 프로젝트에 적용되는 규칙
awl deltas            # 아직 규칙이 되지 않은 교훈
```

## 이름에 대하여

npm에 `awl` 패키지가 이미 있어, 패키지 이름은 `agent-work-loop`로 배포하고 명령어 이름만 `awl`로 제공합니다. 둘이 다른 것은 의도된 선택입니다.

## 개발

이 저장소는 pnpm을 사용합니다.

```bash
pnpm install      # 의존성 설치
pnpm run build    # dist/cli.js 빌드
pnpm test         # vitest 실행
pnpm run lint     # biome 검사
```

## 라이선스

MIT
