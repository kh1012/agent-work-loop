# agent-work-loop

`agent-work-loop`(명령어: `awl`)은 AI 에이전트가 같은 실패를 두 번 반복하지 않도록 돕는 도구입니다. 에이전트가 작업하며 남긴 기록, 검증 결과, 완료 조건, 규칙, 교훈, 막힘을 파일로 관리합니다.

awl 자체는 판단하지 않습니다. LLM을 호출하지 않고, 파일과 상태만 결정적으로 다룹니다. 무엇을 배우고 어떤 규칙을 세울지는 이미 설치된 에이전트(Claude Code, Codex)가 스킬을 통해 판단합니다. 에이전트가 머리라면 awl은 손발입니다. 그래서 awl의 모든 동작은 예측할 수 있고 테스트할 수 있습니다.

크로스 환경을 처음부터 전제로 합니다. macOS와 Windows, Claude Code와 Codex를 모두 지원하는 것을 목표로 하며, 경로·홈 디렉토리·셸·줄바꿈·터미널 렌더링의 차이를 고려합니다.

## 이름에 대하여

npm에 `awl` 패키지가 이미 있어, 패키지 이름은 `agent-work-loop`로 배포하고 명령어 이름만 `awl`로 제공합니다. 둘이 다른 것은 의도된 선택입니다.

## 개발

```bash
npm install      # 의존성 설치
npm run build    # dist/cli.js 빌드
npm test         # vitest 실행
npm run lint     # biome 검사
```

> 현재 상태: 저장소 골격과 배포 파이프라인을 확인하는 단계입니다. `awl --version`과 `awl --help`만 동작합니다.

## 라이선스

MIT
