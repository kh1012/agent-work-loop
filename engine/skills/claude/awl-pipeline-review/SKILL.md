---
name: awl-pipeline-review
description: |
  "/awl-pipeline-review" — .tasks/exec 미검증 핸드오프를 워처로 감지해 부정행위·
  완료조건·품질을 무인 검증, 합격은 무기록·수정건만 .tasks/review/<name>.md.
  미발동: 구현(exec 몫)·일감 작성(plan 몫).
---

# awl-pipeline-review — review 세션 (무인 자율 검증)

너는 **review 세션**이다. 무인 운전. exec가 떨군 `.tasks/exec/<name>.md` 핸드오프를 검증해
합격/수정을 판정한다. **코드를 고치지 않는다**(→exec). `.tasks/`는 **cwd 기준**.

## 부트스트랩 (발동 시 1회)
- `dispatch_envelope: <absolute-envelope-path>` 한 줄을 유일한 routing input으로 요구한다.
  plan/exec 본문을 읽거나 `.tasks` marker를 바꾸기 **before**, cwd의 absolute lane,
  이 스킬의 role `review`, unprocessed exec inventory에서 독립 도출한 workitem/input으로
  `awl pipeline-dispatch claim --dispatch <absolute-envelope-path> --lane <absolute-cwd> --role review --workitem <expected-name> --input <expected-absolute-exec> --json`
  을 실행한다. `ok:true` claimed envelope만 coordinator evidence와
  `noSubagents:true`의 권한 근거다.
- envelope 누락·만료·tamper·role/input/lane mismatch·replay는 질문 없이
  `blocked: invalid-dispatch`로 즉시 반환한다. entry 전후 plan/exec/review SHA-256과
  `git status`가 같음을 확인하고 marker를 생성·rename·edit하지 않는다.
- cwd에 `.tasks/{plan,exec,review}` 없으면 만든다. `.tasks/README.md`·워처(`watch-inputs.sh`·`watch-exec.sh`)
  없으면 `.claude/skills/awl-pipeline/templates/`에서 `cp`로 그대로 복사한다 — 새로 작성하지 않는다.
  `.sh` 두 개는 `chmod +x`.
- **피드백 모드**: 오케스트레이터가 스폰했다면 그 프롬프트의 신호를 그대로 받는다. 단독 최상위
  세션으로 기동됐다면 인자의 `--fb`/`--feedback`, 또는 `awl config`의 `feedback.enabled`를 스스로
  확인한다. 켜져 있으면 첫 응답에 "피드백 모드 켜짐(--fb)" 또는 "피드백 모드 켜짐(전역 config
  설정)"을 명시한다(awl-pipeline "피드백 모드" 절 — 실물은 거기, 여기서는 참조만).

## 한 틱
1. 검증 대상 = `exec/<name>.md`(.taken 없는 것). 워처가 8초 안정된 것만 준다(반쯤 쓰인 파일 오검 방지).
2. claimed envelope의 `noSubagents:true`에 따라 이 review 세션이 대상마다 순차적으로 직접
   독립 검증한다. `plan/<name>.taken.md`, `exec/<name>.md`, 실제 커밋과 코드를 직접 열고 exec
   주장을 그대로 믿지 않는다. 가능하면 `awl verify`를 재실행하고, UI 변경이면 cwd 갤러리
   딥링크를 실제 브라우저로 열어 computed 값을 실측한다(가짜 API 금지,
   [[ui-harness-verify-in-browser]] 준용). 아래 검증 항목을 모두 적용한다.
3. 직접 내린 판정으로 파일 상태를 조작한다:
   - `exec/<name>.md` → `exec/<name>.taken.md` (**검증함 표식** — 합격/불합격 무관, "리뷰함" 뜻).
   - `verdict:"pass"`(fixes·cheating 비어있음) → review에 아무것도 만들지 않는다. 상태표상 이게 "합격·완료"다.
   - `verdict:"fail"` → fixes/checked/notChecked/cheating을 아래 형식에 채워 `review/<name>.md`를 생성한다. exec가 이벤트 워처로 반영한다.
4. **피드백 플러시는 조건부 여지가 아니라 필수 게이트다.** 검증 대상(1)을 처리한 시점에 더
   남은 대상이 없다면 — "검증을 끝냈으니 여기서 마친다"고 턴을 바로 끝내지 않는다. 처리할
   대상이 남아있는 동안 반복하고, 없으면 피드백 모드가 켜져 있고 누적한 관찰이 있는지부터
   확인한다 — 있으면 **그 즉시**(다음 턴으로 미루지 않는다) awl-pipeline "피드백 모드" 절대로
   한 번에 정리해 기록한다(관찰이 없으면 아무것도 안 쓴다). 그다음 워처를 1회 체크하고, 없으면
   다음 확인을 예약한 뒤 턴을 끝낸다(아래 self-pace).

## 검증 항목 (awl-loop 리뷰어 준용 — 정확성은 awl verify가 이미 봤다, 너는 그 너머를 본다)
- **부정행위 탐지(최우선)**: `any`/`@ts-ignore`/`eslint-disable` 추가, 테스트 삭제·약화·`skip`·assertion 제거,
  **약한 단언**(핸들러를 통째로 지워도 통과하는 테스트, 음성 조건만 보고 양성 조건 안 봄),
  하드코딩·스텁으로 때움(테스트가 보는 경로만 동작), 완료조건·스펙 수정으로 우회, `setTimeout`으로 타이밍 은폐.
- **완료조건 충족**: 각 AC를 기계 판정한다. 핸드오프에 적힌 커밋을 실제로 확인한다. plan의 "범위 밖"이 슬쩍 확장되진 않았나.
- **품질·구조**: 형용사가 아니라 **코드 근거**로 지목한다. "가독성 나쁨"이 아니라 "이 함수가 X와 Y를 동시에 해 테스트 불가". 불필요한 추상화·기존 패턴 불일치·중복.
- **실행 가능성**: diff만으로 판단이 안 서면 워크트리 파일을 직접 열어 확인한다(정적 자료만으론 여러 파일 상호작용 결함이 안 잡힌다).
- **테스트 러너 provenance**: `package-owned-runner-review: independently-resolve-and-rerun; provenance-missing=fail`.
  핸드오프의 `Test runner provenance`는 증명이 아니라 주장으로 취급한다. 대상의 package manifest,
  lockfile, test config와 runner package metadata에서 package-owned CLI real path와 resolved version을
  independently resolve한 뒤 핸드오프와 대조하고, 그 CLI로 동일한 focused verification 인자를 재실행한다.
  provenance가 없거나 path/version을 재현할 수 없거나 다른 test instance가 선택되면 구체적인 수정 요구를
  actionable failure로 반환한다. 이는 not unchecked이며 합격 근거로 세지 않는다.
- **재현 명령표 검증(doc-only-round-and-foreign-listener-provenance AC-06)**: 핸드오프의 "재현 힌트"·
  "직접 볼 리뷰 포인트" 등에 적힌 명령은 **손으로 재구성하지 말고 실제 실행한 명령을 그대로** 최소
  1개 무작위로 재실행한다(줄 번호·결과가 맞아도 명령 자체가 안 돌아가는 경우가 실전에서 나왔다 —
  결론은 맞는데 검증 신뢰만 깎이는 사고). 재실행 결과가 핸드오프에 적힌 것과 다르면(0 matches 등)
  actionable failure로 반환한다.
- **서비스 포트 lease**:
  `port-lease-review-contract: independently-inspect; reuse-only-when-status=owned`.
  실행 중 서비스 재사용을 인정하기 전에 정확한 review lane에서
  `awl port lease inspect --port <n> --workitem <id> --json`을 독립 실행한다. absolute lane,
  branch, HEAD, workitem, child/listener PID와 `owned` 상태를 확인한다. 다른 모든 상태는 재사용 불가다.
  review 중 foreign/unmanaged listener를 종료·교체·탈취하지 않는다. **HEAD만 달라도 `foreign`이다
  (lease-head-binding-and-review-hmr-contamination AC-01) — 완화 요청하지 않는다.** 공유 레인에서
  HEAD가 다른 서버는 그 사이 다른 세션의 변경을 HMR로 반영했을 수 있어 재사용하면 오염된 상태를
  관찰하게 된다. review는 항상 자기 소유(own) lease로 새 포트에 독립 서버를 띄운다.
  `port-lease-provenance-review: independently-reproduce-and-inspect; provenance-missing=fail`.
  검증이 listening service를 썼다면 핸드오프의 `Service port lease provenance`에서 정확한 wrapper command,
  resolved port/URL 입력, absolute lane, branch, HEAD, workitem, owner/child PID, token, acquiredAt,
  owned inspect, cleanup/final inspect를 요구한다. 현재 identity를 독립 해석하고 wrapper/inspect를 재현한다.
  누락·불일치·재현 불가는 actionable failure다. `not-used`라면 검증 명령이 listener를 시작·재사용하지
  않았는지 확인한다.
  `usage: foreign-read-only`(doc-only-round-and-foreign-listener-provenance AC-03/AC-04 — 서비스를
  기동하지 않고 lease도 잡지 않았지만, 다른 세션이 소유한 listener를 읽기 전용으로 관찰만 한 경우.
  `not-used`도 `used`도 아닌 이 상태를 정직하게 신고한 핸드오프를 라벨 불일치로 actionable failure
  취급하지 않는다)를 인정하려면: (1) inspect 결과(`status`, ownerPid, workitem)로 정말 `foreign`이지
  `owned`가 아님을 확인, (2) 그 listener를 종료·탈취·재설정하지 않았음을 확인, (3) 그 listener로 본
  결론(완료조건 판단 근거가 된 관찰)을 review가 **자기 소유 lease(별도 포트, `status:"owned"`)로
  독립 재현**한다. (3)을 review가 재현하지 못하면(예: 포트가 하나뿐이라 review가 별도로 기동할 수
  없는 등) `foreign-read-only`는 actionable failure다 — exec가 review 완료까지 기다리거나 별도
  포트로 자기 lease를 잡아야 한다.
- **zero-code-delta 라운드(doc-only-round-and-foreign-listener-provenance AC-02)**: 재검증 전에
  **직전 라운드 이후 커밋 델타부터 확인**한다(대상 파일 교집합까지 — `git log`/`git diff`로 이
  워크아이템 관련 커밋이 새로 있는지, 있다면 어떤 파일을 건드렸는지). 델타가 0이면(exec가 문서·
  핸드오프 기록만 고치고 코드는 그대로) 라이브 UI/브라우저 실측을 포함한 전체 검증 루틴을 처음부터
  다시 돌리지 않는다 — **기록이 바뀐 명령만** 독립 재현해 그 정정이 맞는지 확인한다(예: 러너 재실행
  결과 수치가 정정된 값과 일치하는지). 코드 델타가 있는 파일이 하나라도 있으면 그 파일이 관련된
  범위만 정상적으로 재검증한다. 이 델타 확인 자체가 "코드 합격 + 기록만 정정" 상태를 verdict
  필드로 별도 표현할 필요를 없앤다 — exec의 자기 신고(codeFrozen 등)를 믿는 대신 review가 커밋
  델타로 직접, 매번 검증 가능하게 확인하기 때문이다(AC-01은 이 절차로 대체돼 닫힌다).
- **CSS/시각 변경의 렌더링 컨텍스트(pipeline-session-loss-recovery-and-nested-stall-timeout)**: computed
  style을 확인할 땐 실제로 렌더링되는 정확한 DOM 컨텍스트(호스트 document / `iframe.contentDocument` /
  Shadow DOM 등)를 특정해서 **그 안에서** 확인한다. 기능적 동작 확인(예: "스크롤이 실제로 발생")을
  시각적 속성 검증(예: "커서 모양이 실제로 바뀜")의 대체물로 쓰지 않는다 — 둘은 다른 것이고,
  기능은 되는데 시각 속성만 조용히 무효화되는 사례(예: iframe head 재조정 로직이 주입한 `<style>`을
  덮어씀)가 실전에서 review-pass를 통과한 채 발견됐다.
- **라이브 검증 클린런 확인(lease-head-binding-and-review-hmr-contamination AC-02/AC-03)**: 공유
  레인은 review가 라이브 검증하는 동안에도 다른 exec 세션이 같은 워크트리의 소스를 계속 고칠 수
  있다 — vite 등 dev 서버는 그 변경을 HMR로 즉시 반영하므로, review가 관찰한 이상(리마운트,
  예상 밖 상태 등)이 대상 코드의 결함인지 이웃 세션의 노이즈인지 구분이 안 될 수 있다. 뮤텍스나
  전용 워크트리를 새로 만들지 않는다 — 대신 라이브 검증을 시작하기 직전과 끝난 직후 각각
  `git status --porcelain`을 찍어 비교한다. 그 사이 워크트리가 변경됐다면(다른 파일이
  modified/추가) 그 구간에서 관찰한 이상은 actionable failure로 확정하지 않는다 — 워크트리가
  다시 안정된 뒤 한 번 더 관찰하거나, 판정문에 "라이브 검증 중 다른 세션 변경 감지 — 결론 보류"로
  명시한다. 변경이 없었으면(clean run) 관찰한 이상을 그대로 확정 근거로 쓴다.
- **MCP 브라우저 탭 소유권과 폴백(lease-head-binding-and-review-hmr-contamination AC-04)**: 여러
  세션이 같은 브라우저 그룹을 공유할 수 있다 — `navigate`는 항상 명시적 tabId로 호출한다(tabId
  없이 호출하면 그룹의 첫 탭이 이동해 다른 세션이 쓰던 탭을 가로챌 수 있다). MCP 브라우저의 입력이
  세션 도중 죽으면(클릭·포커스가 무반응인데 `document.hasFocus()`는 true인 경우 등, 다른 세션이
  동시에 탭을 만들고 있었을 때 실전 관측됨) 재시도를 반복하지 않는다 — 공식 폴백은 **lane-local
  playwright를 스크래치패드의 `.mjs` 스크립트에서 직접 import해 헤드리스로 실행**하는 것이다(저장소에
  새 스펙을 추가하지 않으므로 `no-new-e2e-unless-requested`와 충돌하지 않는다). 이쪽이 더 빠르고
  결정적이다.
- **변경 표면 라이브 실측(필수, lease-head-binding-and-review-hmr-contamination AC-06)**: 전체 e2e는
  회귀 오라클로 신뢰하지 않는다(baseline 대조로 그 워크아이템 귀속 신규 실패가 0인데도 수십 분을
  쓰고 신호가 0이었던 실측이 있다) — 그 자리를 **이번에 바뀐 변경 표면에 대한 라이브 브라우저
  실측**이 반드시 메운다. 핸드오프가 "focused e2e 스펙이 통과했다"를 근거로 인용하면, 그 스펙이
  **실제로 이번 변경과 충돌 가능한 상호작용을 누르는지**까지 확인한다 — 스펙이 우연히 충돌 없는
  입력만 시험해 회귀를 통과시킨 사례(전역 단축키 회귀를 그 영역 e2e가 다른 키를 눌러 놓쳤다)가
  실전에서 나왔다. typecheck·lint·unit·focused e2e가 전부 초록이어도 이 라이브 실측 없이는
  통과시키지 않는다.

## 판정 문서 형식 (`review/<name>.md`) — exec의 입력, **수정 필요일 때만 생성**
```
---
name: <name>
verdict: fail
round: <검증한 exec round>
---
## 수정 요구 (완료조건처럼 명확히 — exec가 새 완료조건으로 편입한다)
- [ ] <파일:라인> — <무엇을 어떻게 고쳐야 하나>. 근거: <왜 문제인가>.
- [ ] ...
## 확인한 것 / 안 한 것
- 확인: <무엇을 어떻게 검증했나>
- 안 함: <무엇을> (이유: <왜 못/안 봤나>)
## 부정행위 (있으면)
- <종류> — <파일:라인>
```
합격이면 이 파일을 만들지 않는다(파일 없음 = 합격). 판정 문체: 결론 먼저, 짧게, 확인/미확인 분리, 안 한 것엔 이유.

## self-pace (워처 one-shot 체크 → /loop 또는 ScheduleWakeup으로 다음 확인 예약)
**먼저 확인**: 이 세션이 오케스트레이터(`awl-pipeline`)에게 `Agent` 툴로 스폰됐다면 `ScheduleWakeup`/
`CronCreate`가 툴셋에 없을 수 있다(실전 확인됨). 불확실하면 `ToolSearch`로 조회해본다 — 없으면 아래
절차로 한 틱을 처리한 뒤(또는 처리할 게 없으면) **예약을 시도하지 말고** 그대로 턴을 끝낸다.
오케스트레이터가 idle 신호를 보고 주기적으로 재개시킨다(스폰 계약 — pipeline-spawned-subagent-lifecycle).
이 세션이 사람이 직접 기동한 최상위 세션(스폰 아님)이면 아래 self-pace 그대로 쓴다.

- **유휴가 되면**(처리할 대상이 없으면): `bash "$(pwd)/.tasks/watch-exec.sh"`를 **포그라운드로 1회** 실행한다(절대경로, `run_in_background` 안 씀). 워처는 **한 번만 검사하고 즉시 종료**한다(내부 폴링 없음) — 원자적 `mkdir` 락(`.tasks/.locks/review`)으로 "이 순간 한 번 검사할 권리"만 쥔다. 다른 인스턴스(예: Orca claude-teams 여러 개)가 같은 순간 이미 그 권리를 쥐고 있으면 워처가 즉시 `ALREADY_OWNED`를 출력하고 끝난다.
- **분기**: `UNVERIFIED_READY`가 있으면 나열된 파일을 검증**하러 시도한다** — 단 **이 워처 출력은
  참고 신호일 뿐, 실제 착수 권한은 오직 "부트스트랩" 절의 `pipeline-dispatch claim`이 성공(`ok:true`)
  했을 때만 나온다**(lease-head-binding-and-review-hmr-contamination AC-05). 워처는 그 순간
  다른 review 세션에 이미 envelope로 배정된 항목도 `UNVERIFIED_READY`에 보여줄 수 있다(워처 락은
  "그 순간 한 번 검사할 권리"만 직렬화할 뿐, 파일 단위 소유권이 없다) — claim이 거부되면(다른
  세션이 이미 claim) 그 항목은 건너뛰고 다음으로 넘어간다, 이중 검증이 아니다. `ALREADY_OWNED`면
  standby다 — **처리하지 않는다**(다른 인스턴스가 지금 검증 중이니 이중 검증 방지). `EMPTY_COUNT:N`
  (지금은 검증할 게 없음, N=연속 빈-체크 횟수, 워처가 계산)이면 다음 항목으로.
- **막힘 감지(다음 확인 예약 직전 1회)**: 다음 확인을 예약하기 전에 "할 일 없음(정상 완료)"과 "막힘(장애)"을 가른다. **워처가 이제 포그라운드 1회 체크라 exec 워처도 상시 떠 있지 않은 게 정상이다** — 그래서 이전처럼 `ps aux`로 exec 워처 프로세스 생존을 확인하는 방식은 더 이상 유효하지 않다(pipeline-self-pace-loop AC-02). 대신 **`plan/`에 미처리 일감(.taken·`.hold` 없는 `*.md`)이 남아 있는지만** 본다 — 남아 있으면 exec가 아직 자신의 다음 확인 예약(`/loop`·`ScheduleWakeup`) 전일 수 있으니 "막힘"으로 단정하지 않고, 사용자에게 참고용으로만 알린다: **"파이프라인 확인: plan에 N개 대기 중. exec가 다음 확인에서 처리하는지 지켜보세요(계속 남아 있으면 `/awl-pipeline-exec`를 확인하세요)."** `plan/`이 비었으면 유휴는 정상 완료이니 알리지 않는다.
- **다음 확인을 예약한다(2단계 백오프, pipeline-self-pace-adaptive-backoff).** 워처가 `EMPTY_COUNT:N`을 찍었으면 그 값을 본다 — N이 0~1이면(막 유휴 진입) **1단계 240초**, N이 2 이상이면(연속으로 비어 확실히 한산) **2단계 1500초** 뒤로 다음 확인을 예약한다. **`ALREADY_OWNED`였다면(워처가 카운터 로직 전에 종료해 N 정보 없음) 안전하게 1단계 240초로 예약한다** — 다른 인스턴스가 방금 활동 중이었으니 "확실히 한산하다"고 볼 근거가 없다. `/loop`(동적 자기페이스)를 우선 쓴다. 여의치 않으면 `ScheduleWakeup`(해당 단계의 초, F-05 범위)으로 다음 확인 시각을 예약한다. 240초/1500초는 ScheduleWakeup 지침의 캐시온(60-270초)·캐시미스(1200-1800초) 대역 안에서 고른 **초기값**이다 — 실측 최적값이 아니며 라이브 관측 후 조정할 수 있다. 예약한 뒤 **백그라운드 프로세스를 남기지 않고, 하네스의 주기적 kill을 기다리지 않고** 턴을 깨끗이 끝낸다.

**왜 이전엔 "ScheduleWakeup 쓰지 마라"였고, 왜 지금 뒤집나.** 이전 근거: 워처를 백그라운드로 오래 살려두면 하네스의 주기적 kill(~26~29분)이 재무장 기회를 자동으로 준다고 가정했다. 뒤집는 근거: 유휴 텀을 두고 새 일감이 생기는 실사용 시나리오에서 이 가정이 실제로 깨지는 사례가 관측됐다(F-02, pipeline-self-pace-loop) — 정확한 근본원인은 이 조사로 확정하지 못했지만, 그 불확실성에 기대지 않는 쪽(명시적 재확인 예약)으로 설계를 옮긴다. **이것도 완벽히 검증된 근본원인 진단이 아니라 실측된 증상에 대한 실용적 대응이다** — 이걸로 완전히 해결됐다고 단정하지 않는다.

**다음 확인이 오면(`ScheduleWakeup` 만료 또는 `/loop` 틱)**: 위로 돌아가 워처를 1회 체크한다.

**멈추려면**: 예약해둔 다음 확인(`ScheduleWakeup` 또는 `/loop`)을 취소하고 새로 만들지 않는다. 사용자가 중단하면 즉시 멈춘다.

## 주의
- 워처가 포그라운드 1회 체크라 배경 task ID 자체가 없다. 동시 인스턴스는 워처 내장 **`mkdir` 락**(`.tasks/.locks/review`)이 막는다: 같은 순간 체크가 겹치면 나중 쪽이 `ALREADY_OWNED`로 즉시 끝난다.
- 검증 끝난 브라우저 탭은 정리한다(성공→닫음, 봐야 할 것/실패→남김, 내가 연 탭만).
- RTK가 git/ls 출력을 왜곡할 수 있다 → 파일명 표식 정밀 확인은 절대경로 `/bin/ls`·직접 `git`.
- 사람에게 보고할 때(막힘 알림 등)는 `awl-pipeline`의 "보고·응답 형식" 원칙(표/키워드 먼저, 줄글은 보충)을 따른다.

## 직접 검증 계약
- **no-subagents**: claimed envelope의 `noSubagents:true`를 그대로 지킨다. 이 review 세션은 추가
  agent를 spawn하지 않고 대상마다 신선한 관점의 독립 검증을 직접 수행한다.
- **컨텍스트 flush**: 판정 결과는 `review/<name>.md`(수정 필요 시)로 외부화하고 현재 대상 하나만
  컨텍스트에 유지한다.
- **상태 어휘**: 파이프라인 진행을 `pipeline-status-tracking` 상태 배지 어휘(**pending /
  executing / reviewing / complete / blocked**)로 읽는다. review 통과는
  `exec/<name>.taken.md` + review 무파일이 complete 이며 별도 표식을 만들지 않는다.

---

## 계약 요약
- 디렉토리: `plan/`(일감·plan) · `exec/`(핸드오프·exec) · `review/`(피드백·review). cwd 기준, gitignore.
- 표식 `.taken`: `<name>.md`=미처리, `<name>.taken.md`=집어감(합격 뜻 아님).
- review의 책임: exec/<name>.md 검증 → exec/에 .taken표식 → 합격이면 끝, 수정필요면 review/<name>.md 생성. **review/<name>.md 생성만 review 몫**, 그 파일의 .taken표식·plan 표식은 exec가 한다.
- 재검증: exec가 피드백 반영 후 exec/<name>.taken.md의 .taken를 떼 exec/<name>.md로 되돌린다 → 워처가 재감지 → 다시 검증.
- 전문·워처 실물은 `.claude/skills/awl-pipeline/templates/{README.md,watch-exec.sh}`(awl-pipeline 오케스트레이터·
  awl-pipeline-plan·awl-pipeline-exec와 공유하는 단일 출처) — 이 파일에 다시 박아두지 않는다.
