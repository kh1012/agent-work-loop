# 시뮬레이션 — awl loop 와 pipeline

설계를 문서로만 보면 빈 곳이 안 보인다. 실제로 돌린다고 치고 로그를 써본다.
**매끄럽게 흘러가면 시뮬레이션이 아니다.** 막히는 지점을 그대로 남긴다.

전제: 프로젝트는 이미 `awl init` 이 끝났고 `feature/editor-rework` 브랜치에 서 있다.

**이 로그는 그 시점 설계로 돌린 기록이다.** 이후 바뀐 것이 있다.
기본 모드가 `semi-auto` 가 됐고, 리뷰는 `--review` 를 켰을 때만 돈다.
아래 멈춤 횟수는 `--strict` 기준이고 리뷰어 세션은 지금 기본이 아니다.

---

# 시나리오 A · loop 하나

## 14:12 — 사람이 던진다

```
> /awl 레이어 패널을 키보드로 조작하고 싶어
```

```
$ awl next

  stage         spec
  skill         grill-with-docs  →  .claude/skills/grill-with-docs/SKILL.md
  instruction   이 스킬을 읽고 그대로 수행한다. 대화는 docs/specs/ 에 남긴다.
  context       domain 미정. 확정되면 같은 domain 의 이전 스펙과 gotcha 를 로드한다
  done when     스펙이 티켓으로 쪼개질 만큼 구조화됐는가
  then          awl record spec --file <경로>
```

## 14:13 — AI 가 묻고 사람이 답한다

```
AI   어느 패널을 말하는 건가요. 에디터 좌측 레이어 트리 맞습니까?
사람  응 좌측 트리

AI   domain 을 editor 로 잡겠습니다.
     같은 domain 의 이전 스펙 3건과 gotcha 7건을 읽었습니다.
     그중 하나가 걸립니다. gotcha-014 — e2e 가 낡은 dev 서버를 물어
     타임아웃이 났던 적이 있습니다. 이번 스펙의 제약으로 넣겠습니다.

AI   이름 편집 중에도 방향키가 선택을 옮겨야 합니까?
사람  아니 편집 중엔 커서 이동이어야지

AI   맨 아래에서 아래키를 누르면 처음으로 돌아갑니까?
사람  아니 그냥 멈춰

AI   접힌 노드의 자식은 건너뜁니까?
사람  응 안 보이는 건 건너뛰어야지

AI   다중 선택은 이번 범위에 넣습니까?
사람  아니 나중에
```

**이 왕복이 네 번이다.** 여기가 사람 시간을 가장 많이 쓰는 자리다.

## 14:21 — 스펙이 나온다

```
docs/specs/20260726-142107-editor-keyboard-nav.md
```

```markdown
## Request
> 레이어 패널을 키보드로 조작하고 싶어

## Instruction
좌측 레이어 트리를 키보드만으로 다룰 수 있게 한다.

## Constraints
### constraint-1
Puck 코어를 수정하지 않는다
verification: git diff 에 @measured/puck 없음
source: -
hits: 0

### constraint-2
e2e 는 포트를 격리한 뒤 실행한다
verification: 테스트 시작 시 lsof 로 점유 프로세스 확인
source: gotcha-014
hits: 2

## Conditions
### condition-1
언제 포커스가 패널에 있고 위·아래 방향키를 누르면,
선택이 한 칸씩 이동해야 한다

### condition-2
언제 노드에 자식이 있고 좌·우 방향키를 누르면,
접히거나 펼쳐져야 한다

### condition-3
만약 이름 편집 중이라면,
방향키는 선택을 이동시키지 않아야 한다

### condition-4
만약 목록의 끝이라면,
선택은 순환하지 않고 그 자리에 머물러야 한다

## Out of scope
- 다중 선택       ItemSelector 가 단일값
- 드래그 재정렬    이번 요청과 무관
```

**`constraint-2` 는 사람이 말한 적이 없다.** gotcha 에서 자동으로 들어왔다.
`source` 가 있어서 나중에 셀 수 있다.

## 14:23 — 티켓 도출

```
$ awl tickets derive

  conditions 4  →  tickets 5

  ticket-1  키보드 이벤트 배선     conditions: []          기반
  ticket-2  선택 인덱스 유틸       conditions: []          기반
  ticket-3  방향키 이동           conditions: [1, 4]
  ticket-4  접기·펼치기           conditions: [2]
  ticket-5  편집 중 차단          conditions: [3]

  dependencies
    ticket-3, ticket-4, ticket-5  ←  ticket-2  ←  ticket-1
```

**조건 4개에서 티켓 5개가 나왔다.** 기반 티켓 둘은 조건에 대응하지 않는다.
`condition-1` 과 `condition-4` 를 `ticket-3` 하나가 받은 것도 눈에 띈다.
둘 다 방향키 이동에 대한 것이라 같은 코드 경로다.

## 14:24 — 게이트 1 · 사람 1회

```
[Gate 1] 이 티켓들로 요청이 만족되는가

  request        레이어 패널을 키보드로 조작하고 싶어
  domain         editor
  tickets        5  foundation 2 · feature 3        ▸
  dependencies   ticket-1 → ticket-2 → (3, 4, 5)   ▸

  out of scope   2
    다중 선택       ItemSelector 가 단일값
    드래그 재정렬    이번 요청과 무관

  (*) 이대로 시작   ( ) out of scope 를 다시 논의   ( ) 중단
```

```
사람  시작
```

## 14:25 — ticket-1 (기반)

```
$ awl next

  ticket        ticket-1  키보드 이벤트 배선
  conditions    없음. 기반 티켓
  stage         investigation
  instruction   조건을 건드리는 코드 경로를 전부 찾는다.
                finding 으로 남기고 file:line 을 붙인다.
  done when     입력 경로 · 상태 경로 · 출력 경로가 목록에 있는가
```

```
finding-1  키보드 핸들러가 LayersPanel 밖에 있다      keyboard.tsx:42
finding-2  aria-selected 는 있는데 tabindex 관리가 없다  LayersPanel.tsx:203
finding-3  Puck 의 itemSelector 가 단일값이다          puck/types.ts:88
```

```
$ awl next

  stage         clarification
  instruction   코드를 읽고도 답이 안 나오는 것만 묻는다.
```

```
AI   물을 것이 없습니다. 스펙 단계에서 다 나왔습니다.
```

```
$ awl record clarification --none
```

**여기가 비어 있는 게 정상이다.** spec 에서 제대로 물었으면 남을 게 없다.
다만 `없음` 을 남겨야 "물을 게 없었다" 와 "안 물었다" 가 구분된다.

```
$ awl next

  stage         spike
  instruction   사람도 모르는 것을 코드로 판정한다.
```

```
AI   하나 확인하겠습니다. 패널 루트에서 keydown 을 잡으면
     input 안에서도 잡히는지.

     [코드 12줄 작성 → 실행 → 확인]

finding-4  패널 루트 리스너가 input 안 keydown 도 받는다
           source: spike
           result: 예상과 다름
```

**이 발견이 나중에 리뷰 지적으로 다시 나온다.** 지금은 넘어간다.

## 14:31 — 게이트 2 · 사람 2회

```
[Gate 2] ticket-1 키보드 이벤트 배선을 시작한다

  conditions    없음. 다른 티켓이 이 위에 쌓인다
  verification  test  given 패널이 마운트됐다
                      when  keydown 이 발생한다
                      then  핸들러가 이벤트를 받는다

  spike         2건 중 1건이 예상과 달랐다
    ✗ 패널 루트 리스너가 input 안 keydown 도 받는다

  investigation finding 4                          ▸

  (*) 착수   ( ) 계획을 다시   ( ) 중단
```

```
사람  착수
```

## 14:38 — 구현 · 검증 · 즉시 리뷰

```
$ awl verify ticket-1

  typecheck   ok    1.2s
  lint        ok    0.4s
  test        ok    6.8s
  a11y        skip  scope: changed · 해당 파일 없음
  e2e         ok    58.1s
```

기반 티켓이므로 여기서 바로 리뷰를 돈다.

```
$ awl review pack ticket-1  →  리뷰어 세션 스폰

  재료   조건 없음 · 제약 2건 · diff 84줄 · 파일 2개 · finding 4건 · 검증 결과
  지시   재료만으로 판단한다. 파일을 추가로 열지 않는다.
```

```
리뷰어  지적 1건.
        핸들러가 window 에 붙어 있습니다. 패널이 언마운트돼도 남습니다.
        constraint 해당: 없음

        재료 부족: 없음
```

```
$ awl record review --finding "핸들러 정리 누락"
```

**`재료 부족: 없음` 이 나왔다.** 팩이 충분했다는 뜻이다.
이게 계속 나오면 팩 구성이 맞다는 신호고, 자꾸 부족하다고 하면 뭘 더 넣어야 하는지 알려준다.

## 14:44 — 게이트 3 · 사람 3회

```
[Gate 3] ticket-1 을 완료로 볼 것인가

  verification  typecheck · lint · test · e2e   모두 통과   ▸
  commits       2                                          ▸

  review        지적 1건 · 반영 완료
    ! 핸들러가 언마운트 후에도 남는다
      구현 결함. cleanup 추가

  (*) 완료   ( ) 더 작업   ( ) 중단
```

```
사람  완료
```

## 14:45 ~ 16:20 — ticket-2 ~ ticket-5

같은 흐름이 반복된다. 다만 **기능 티켓(3·4·5)은 리뷰를 안 돈다.**

```
ticket-2  기반   investigation → spike(없음) → [Gate 2] → 구현 → verify → 리뷰 → [Gate 3]
ticket-3  기능   investigation → [Gate 2] → 구현 → verify → [Gate 3]
ticket-4  기능   investigation → [Gate 2] → 구현 → verify → [Gate 3]
ticket-5  기능   investigation → [Gate 2] → 구현 → verify → [Gate 3]
```

**여기서 하나 눈에 띈다.** ticket-3·4·5 의 investigation 이 거의 같은 파일을 다시 읽는다.
ticket-1 에서 만든 finding 4건이 그대로 유효한데 재사용되지 않는다.

```
$ awl tokens ticket-3

  총              64,200
    investigation  28,400   44%   ← ticket-1 과 겹치는 탐색
    implement      27,100   42%
    verify          8,700   14%
```

## 16:20 — 전체 리뷰 · 리뷰어 세션 1회

```
$ awl review pack --request  →  리뷰어 세션 스폰

  재료   조건 4건 · 제약 2건 · 커밋 9개 · 파일 5개 · finding 11건
  지시   커밋을 하나씩 본다. 재료만으로 판단한다.
```

```
리뷰어  커밋 9개 순차 검토.

        지적 1  ticket-5 의 테스트가 핸들러를 지워도 통과한다
                단언이 "에러가 안 난다" 수준이다
                constraint 해당: 없음

        지적 2  ticket-3 과 ticket-4 가 같은 인덱스 계산을 각자 한다
                ticket-2 의 유틸을 ticket-4 가 안 쓴다
                constraint 해당: 없음

        재료 부족: 없음
```

**지적 2 는 티켓 하나만 봤으면 안 나온다.** 커밋을 순차로 보니까 잡혔다.

```
$ awl next

  stage         implement
  instruction   리뷰 지적 2건을 반영한다.
                지적 1 은 구현 결함. 지적 2 는 구현 결함.
                스펙 누락이 아니므로 조건을 늘리지 않는다.
```

## 16:41 — 재리뷰 · 고친 커밋만

```
$ awl review pack --commits HEAD~2..HEAD

  리뷰어  통과. 추가 지적 없음.
```

## 16:44 — 게이트 4 · 사람 11회

```
[Gate 4] 요청을 닫을 것인가                        default

  conditions     승인 때 4개 → 지금 4개              ▸
  out of scope   2 그대로                            ▸
  review         지적 3건 · 전부 반영                ▸
  verification   typecheck · lint · test · a11y · e2e  전부 통과

  qualitative    이번 요청에는 붙지 않았다 (verification: [binary])

  마무리
    병합    awl/keyboard-nav  →  feature/editor-rework
    정리    기록 전송 · 워크트리 제거 · 브랜치 삭제

  (*) 병합하고 마무리   ( ) 판정만 하고 병합은 나중에   ( ) 보류
```

```
사람  병합하고 마무리
```

```
$ awl close

  merged     awl/keyboard-nav → feature/editor-rework  (fast-forward)
  synced     records 42건 → http://localhost:9999
  synced     spec 1건 (status: closed)
  removed    worktree 없음 (레인을 안 썼다)
  branch     awl/keyboard-nav 삭제
```

## 총계

```
사람이 멈춘 횟수    11회   Gate1(1) + Gate2(5) + Gate3(5) + Gate4(1)
사람이 답한 질문    4회    spec grill
경과 시간           2시간 32분
토큰                412,000
  spec               38,000    9%
  investigation     118,400   29%   ← 겹치는 탐색이 많다
  implement         167,200   41%
  verify             22,100    5%
  review             52,300   13%   리뷰어 세션 3회 (기반 2 + 전체 1)
  기타               14,000    3%
```

---

# 시나리오 B · pipeline 세 레인

## 09:02 — 세 요청을 동시에

```
> /awl --lanes "레이어 패널 키보드 조작" "인증 토큰 갱신 실패 처리" "번들 크기 20% 축소"
```

```
$ awl lane new

  base branch   feature/editor-rework   (현재 브랜치)

  lane  keyboard   .awl-worktrees/keyboard   awl/keyboard    PORT=3000  PW=9323
  lane  auth       .awl-worktrees/auth       awl/auth        PORT=3010  PW=9333
  lane  bundle     .awl-worktrees/bundle     awl/bundle      PORT=3020  PW=9343

  [!] 레인 3개입니다. 토큰이 대략 3배 나갑니다. 계속할까요?
```

```
사람  응
```

**상한 확인이 여기서 뜬다.** 3개를 넘으면 더 강하게 물어야 한다.

## 09:03 — 세 세션이 뜬다

```
오케스트레이터
  spawn  lane keyboard  →  세션 A
  spawn  lane auth      →  세션 B
  spawn  lane bundle    →  세션 C

  각 세션은 자기 워크트리에서 loop 를 돈다.
  오케스트레이터는 만들고 띄우고 거두는 것만 한다.
```

## 09:04 ~ 09:40 — spec 단계가 겹친다

```
09:07  세션 A  grill 질문 4개
09:11  세션 B  grill 질문 6개
09:14  세션 C  grill 질문 3개
```

**사람 하나에게 세 세션이 동시에 묻는다.** 이게 실제로 제일 정신없는 구간이다.
질문이 뒤섞이고 어느 레인 것인지 헷갈린다.

```
[lane auth]  토큰이 만료됐을 때 재시도를 몇 번까지 합니까?
[lane keyboard]  이름 편집 중에도 방향키가 선택을 옮겨야 합니까?
[lane bundle]  번들 크기 측정 기준이 gzip 입니까 raw 입니까?
```

**레인 이름 접두어가 없으면 못 쓴다.**

## 09:52 — 게이트 1 이 세 번 온다

```
[Gate 1] lane keyboard   tickets 5  →  승인
[Gate 1] lane auth       tickets 3  →  승인
[Gate 1] lane bundle     tickets 4  →  out of scope 를 다시 논의
```

`bundle` 은 사람이 되돌렸다. 트리 셰이킹을 범위 밖으로 뺐는데
그게 없으면 20% 를 못 맞춘다고 판단했다.

**나머지 두 레인은 그 사이에도 계속 돈다.** 한 레인이 멈춰도 다른 레인은 안 멈춘다.

## 10:15 — e2e 가 줄을 선다

```
10:14  lane keyboard  verify  e2e  시작
10:14  lane auth      verify  e2e  대기   exclusive 락
10:15  lane bundle    verify  e2e  대기   exclusive 락

10:15  lane keyboard  e2e  ok  58.1s
10:15  lane auth      e2e  시작
10:16  lane auth      e2e  ok  61.4s
10:16  lane bundle    e2e  시작
10:17  lane bundle    e2e  ok  55.2s
```

**포트를 나눠줬는데도 `exclusive` 가 걸려 있다.**
프로젝트가 `PW_PORT` 를 안 읽어서 아직 나눌 수 없기 때문이다.

e2e 만 3분이 직렬이 된다. 병렬 이득이 그만큼 깎인다.
`exclusive` 를 뗄 수 있으면 1분이다. **프로젝트 쪽 작업이 필요하다는 신호다.**

## 11:30 — 레인 간 학습이 흐른다

```
lane auth   verify  e2e  실패
            포트 3010 이 이미 점유돼 있다

            gotcha 를 남긴다
            .awl/records/2026-07.auth.jsonl
```

```
11:47  lane bundle  investigation
       같은 domain 의 gotcha 를 읽는다
       .awl/records/2026-07.*.jsonl  전부 훑음

       [i] lane auth 가 30분 전에 겪은 것을 읽었습니다.
           포트 점유 확인을 검증 전에 넣습니다.
```

**이게 격리를 코드에만 둔 효과다.**
개인 저장소까지 격리했으면 `bundle` 이 같은 실패를 다시 겪었다.

## 13:20 — 게이트 4 가 세 번, 그런데 순서가 문제다

```
[Gate 4] lane keyboard   병합 대상  feature/editor-rework
[Gate 4] lane auth       병합 대상  feature/editor-rework
[Gate 4] lane bundle     병합 대상  feature/editor-rework
```

세 레인이 같은 브랜치로 들어간다. 첫 번째는 fast-forward 인데 나머지는 아니다.

```
사람  keyboard 부터 병합

$ awl close --lane keyboard
  merged  awl/keyboard → feature/editor-rework  (fast-forward)
```

```
$ awl close --lane auth
  [!] feature/editor-rework 가 앞서 있습니다.
      awl/auth 를 rebase 해야 합니다. 진행할까요?
```

```
사람  응

  rebased  awl/auth  onto  feature/editor-rework
  [!] 충돌 1건  src/lib/http.ts
      lane keyboard 가 같은 파일의 import 순서를 바꿨습니다.
```

**서로 무관한 요청이었는데 같은 파일을 건드렸다.**
lint 의 import 정렬 규칙 때문에 양쪽이 같은 줄을 만졌다.

이건 코드 충돌이라 git 이 잡았다. 조용히 지나가지 않았다.

## 13:52 — 총계

```
사람이 멈춘 횟수    31회   레인 3개분 + 병합 3회 + rebase 확인 1회
사람이 답한 질문    13회   grill 3레인분
경과 시간           4시간 50분
토큰              1,284,000

  lane keyboard    412,000
  lane auth        386,000
  lane bundle      471,000
  오케스트레이터     15,000    1.2%

  순차로 했다면 대략 1,269,000 · 7시간 30분
```

**토큰은 1.2% 늘고 시간은 35% 줄었다.**
오케스트레이터가 얇아서 병렬화 자체의 추가 비용이 거의 없다.

**대신 사람의 부담은 3배다.** 31회 멈춤은 하루 종일 붙어 있어야 하는 수치다.

---

# 이 시뮬레이션이 드러낸 것

## 1. default 모드는 멈춤이 너무 많다

티켓 5개에 **11회**다. 레인 3개면 31회다.

```
Gate 1   요청당 1회        적당하다
Gate 2   티켓당 1회        착수 승인. 대부분 그냥 통과시킬 것이다
Gate 3   티켓당 1회        완료 승인. 검증이 통과했는데 또 묻는다
Gate 4   요청당 1회        적당하다
```

**게이트 2와 3이 부담의 전부다.** 그리고 둘 다 기계 판정이 이미 끝난 뒤에 묻는다.

`semi-auto` 가 사실상 기본이어야 할지 모른다.
그러면 요청당 2회가 되고, 레인 3개여도 6회 + 병합 3회다.

## 2. investigation 이 겹친다

같은 요청 안에서 티켓마다 같은 파일을 다시 읽는다.
`ticket-1` 이 만든 finding 4건이 `ticket-3·4·5` 에서 재사용되지 않았다.

**요청 안에서는 finding 을 공유해야 한다.** 지금 설계에 그 규칙이 없다.
`investigation` 이 29% 를 먹었는데 상당 부분이 중복이다.

## 3. clarification 이 대부분 비어 있다

spec 에서 제대로 물으면 남을 게 없다. 다섯 티켓 중 다섯 개가 `없음` 이었다.

단계가 형식적이 된다면 **spec 이 부실할 때만 켜지는 조건부 단계**로 두는 게 맞을 수 있다.
다만 `없음` 기록 자체는 값이 있다. 나중에 "왜 안 물었나" 에 답한다.

## 4. 병렬 grill 이 정신없다

세 레인이 동시에 사람에게 묻는다. 레인 접두어가 필수다.
**그리고 spec 단계만이라도 순차로 도는 게 나을 수 있다.**
어차피 사람이 하나라 병렬이 안 된다.

## 5. exclusive 가 병렬 이득을 깎는다

e2e 3분이 직렬이 됐다. 포트를 나눌 수 있으면 1분이다.
**`exclusive` 가 켜져 있다는 건 프로젝트가 아직 준비 안 됐다는 신호**이므로
게이트나 doctor 에서 그렇게 보여주면 좋다.

## 6. 병합 순서가 남는다

레인이 서로 무관해도 같은 파일을 건드리면 두 번째부터 rebase 다.
`awl close` 가 순서를 제안할 수 있다 — **건드린 파일이 겹치지 않는 것부터.**

## 7. 오케스트레이터가 정말 얇다

1.2% 다. 세션을 만들고 띄우고 거두기만 하니까 그렇다.
**exec 를 안 띄우기로 한 결정이 여기서 값을 한다.**
