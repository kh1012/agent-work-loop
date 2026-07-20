# .tasks 파이프라인 계약

세 세션이 파일로 협업하는 비동기 파이프라인. 파일명 하나가 곧 상태다.

**디렉토리(cwd 기준, gitignore)**: `plan/`(일감·plan) · `exec/`(핸드오프·exec) · `review/`(피드백·review).
**공유 키 `<name>`**: 일감 1개당 1개(awl WI-ID 또는 kebab-case). 세 디렉토리 공유.
**표식 `.taken`**: `<name>.md`=미처리, `<name>.taken.md`=집어감(합격 뜻 아님). `<name>.hold.md`=exec가 자동
부적합 판정(전략문서·타 워크트리·사용자 선행작업 필요), 워처 무시·사람 조율. 단, "un-hold 조건: X 합격 후"류
의존 대기형은 exec가 유휴 진입 전 `awl hold-recheck`로 스스로 재점검해 의존 착지+합격 시 자동 un-hold
한다(사람 rename 불필요, pipeline-hold-recheck) — 전략문서·부분미충족은 여전히 사람 조율.

## 상태표
| plan/ | exec/ | review/ | 의미 |
|---|---|---|---|
| `<name>.md` | — | — | 신규 (exec 미착수) |
| `<name>.hold.md` | — | — | exec 자동 부적합, 사람 조율 (워처 무시) |
| `<name>.taken.md` | `<name>.md` | — | exec 완료, review 미검증 |
| `<name>.taken.md` | `<name>.taken.md` | — | 합격·완료 |
| `<name>.taken.md` | `<name>.taken.md` | `<name>.md` | review 수정요구, exec 미반영 |
| `<name>.taken.md` | `<name>.md` | `<name>.taken.md` | exec 반영·재검증 대기 |

## 소유권
plan/* 표식·exec/<name>.md 생성갱신·review/* 표식·exec의 .taken떼기 → exec. exec/에 .taken표식·review/<name>.md
생성 → review. plan/<name>.md 생성 → plan.

## 워처
review=`.tasks/watch-exec.sh`(exec/ 감시, `UNVERIFIED_READY`), exec=`.tasks/watch-inputs.sh`(review/+plan/
감시, review 우선, hold 무시, `INPUTS_READY`). 미표식 *.md 8초 안정 시 발화. **포그라운드 1회 체크(one-shot)**
— 내부 폴링 없이 즉시 결과를 찍고 종료한다. 처리 후, 또는 결과가 없으면(`EMPTY_COUNT:N`) `/loop` 또는
`ScheduleWakeup`으로 다음 확인을 예약한다 — N이 0~1이면 240초, 2 이상이면 1500초(초기값, 2단계 백오프,
pipeline-self-pace-adaptive-backoff).

**워처 락(그 순간의 체크 권리, one-shot)**: 각 워처는 원자적 `mkdir` 락 `.tasks/.locks/<role>`(role=review|exec)로
이 cwd에서 role당 "이 순간 한 번 검사할 권리"를 하나로 강제한다(오래 보유가 아니다 — pipeline-self-pace-loop
AC-02, 워처가 one-shot이라 락 보유 시간도 그 한 번의 체크만큼으로 짧다). 다른 인스턴스가 같은 순간 같은 role
워처를 띄우면 `ALREADY_OWNED` 출력 후 즉시 종료(standby). 체크 시작 시 heartbeat 기록, 60s 넘게 stale(소유자가
EXIT trap 없이 죽음)이면 다음 체크가 원자적으로 탈취. → 여러 Orca claude-teams 인스턴스가 같은 cwd에 떠도 같은
순간의 중복 감시·이중 처리 없음.

## 재검증
파일명이 상태 → 이미 .taken인 파일 재수정은 재감지 안 됨. .taken 떼거나 새 name.

## 게이트 자율승인
exec가 awl-loop 게이트1·2를 auto:true 승인. 게이트1=plan문서, 게이트2=review세션이 대신.
