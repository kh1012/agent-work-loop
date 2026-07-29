# 구현 점검 목록

프로토타입이 설계대로 됐는지 확인한다.
**이 목록 자체가 스펙이다.** 항목이 전부 EARS 조건이라,
실패한 항목은 그대로 스펙의 조건이 되고 티켓으로 도출된다.

```
[ ] 아직 안 봄
[o] 통과
[x] 실패  →  조건으로 옮겨 티켓을 만든다
[-] 해당 없음  →  왜 해당 없는지 한 줄
```

**`[x]` 를 발견하면 고치지 말고 먼저 적는다.**
바로 고치면 무엇이 왜 틀렸는지가 안 남는다.
`awl doc new spec "점검에서 나온 결함"` 으로 모아 한 번에 돈다.

**2026-07-28 1차 점검 완료.** 워크트리 `work/adk-stage1-foundation`(HEAD 당시 `cf69b2b`, 단계 1~6 커밋 완료 상태)를 대상으로 6개 감사 에이전트가 코드를 직접 읽고 판정했다. `x`/`?` 항목마다 근거(file:line)를 짧게 남긴다.

**⚠ 2026-07-29 정정 — 이 문서를 근거로 쓰지 마라.** 설계 원문과 코드를 직접 대조하니 불일치 19건이 나왔고, 그중 상당수는 이 목록에 **항목 자체가 없어서** 구조적으로 잡힐 수 없었다(`~/.awl/engine` 사본 금지 조항은 "사본"이라는 낱말조차 이 문서 전문에 없다). 한 건(서브에이전트 0개)은 실패한 범위를 빼내고 통과로 찍은 골대 이동이었다.

세 가지가 겹쳤다 — ① 구현한 파이프라인이 자기 산출물을 감사했다 ② 항목마다 `확인` 란에 "세션 수를 센다" 같은 **실행** 절차를 적어놓고 실제 `근거`는 전부 코드 인용이다(아래 "6개 감사 에이전트가 코드를 직접 읽고 판정했다") ③ 설계가 요구한 "단계마다 실사용으로 검증"(prototype.md:8, 759)을 한 번도 안 했다.

전수 결과와 조치는 0.8.2~0.9.0 커밋에 있다. 다음 감사는 **구현하지 않은 주체**가, 코드 인용이 아니라 실제로 돌려서 한다.

**2026-07-28 라운드1 반영 완료.** 핵심 12 중 실패했던 2개(모드 시스템, 서브에이전트 기본 0개)를 WI-F1~F4 로 고쳤다 — `engineVersion` 필드 제거(설계 충돌 해소, WI-F1) · `state.json` `loopMode` 필드 + 게이트3/4 상태 확장(WI-F2) · awl-loop 게이트2 조건부 자동승인(WI-F3) · 리뷰 서브에이전트 `--review` 옵트인 전환(WI-F4). **핵심 12는 이제 8→10 통과, 실패 0, 애매(`?`) 2**(교차검증 "안 함" 명시 기록·skills 전부 null 실행경로 미배선 — 둘 다 저장소/기록 스키마 신설이 필요해 별도 라운드). 나머지 단계별 `[x]`(단계1 스펙형식·단계2 게이트UI·자가검증·`--review`재료팩 등·단계3 소급전송버그·단계4 검증scope/level·단계5/6 소소한 갭)는 여전히 미반영 — 순서대로 다음 라운드.

---

## 핵심 12

**이 열둘이 깨지면 나머지를 봐도 소용없다.** 여기부터 본다.

```
[o] 언제 게이트 승인 기록이 없으면, 다음 단계로 넘어가지 못해야 한다
    확인   승인 없이 강제로 진행시켜본다
    의미   게이트가 산문이면 안 지켜진다. 도구 호출이어야 한다
    근거   state.ts requireGateForLoop, program.ts hasApprovedGate1 — 미승인 시 exit(1)

[o] 언제 중앙 서버가 꺼져 있으면, 루프가 멈추지 않고 기록이 로컬에 쌓여야 한다
    확인   서버를 끄고 한 사이클 돌린다
    의미   로컬이 원본이다. 원격이 죽어서 개발이 멈추면 아무도 안 쓴다
    근거   core/sync.ts postEnvelope 는 실패해도 throw 안 하고 {ok:false} 반환, 지수 백오프

[o] 항상 awl 은 무엇이 옳은지 판단하지 않아야 한다
    확인   판정 로직이 코드에 있는지 훑는다
    의미   awl 은 파일과 상태만 만진다. 판단은 에이전트가 한다
    근거   review.ts:12 "awl 은 리뷰를 하지 않는다", rules.ts:328 "awl 은 위반을 스스로 탐지하지 않는다"

[o] 언제 조건이 EARS 문형이 아니면, 검사가 실패해야 한다
    확인   "적절히 동작해야 한다" 를 넣고 lint 를 돌린다
    의미   계약 검사가 실제로 실패를 내야 계약이다. 경고만 내면 무시된다
    근거   doc.ts EARS_PREFIXES + isEarsForm, tests/commands/doc.test.ts 회귀 테스트 있음

[o] 언제 문서 파일명을 바꾸면, 참조가 깨지지 않아야 한다
    확인   스펙 파일명을 바꾸고 티켓에서 여전히 찾아지는지 본다
    의미   참조는 UUID 다. 파일명은 사람이 눈으로 찾는 용도다
    근거   doc.ts uuidv7 발급, tickets.ts findSpecById 는 frontmatter id 로 매칭(파일명 무관) — 다만 리네임 시나리오 전용 테스트는 없음(구조적 보장만)

[o] 언제 아무 플래그도 안 주면, semi-auto 로 돌아야 한다
    확인   awl run 만 실행하고 게이트 2·3 이 자동 승인되는지 본다
    근거   2026-07-28 라운드1 WI-F2/F3 로 고침. state.ts 에 loopMode 필드(strict/semi-auto/auto, 기본 semi-auto) 신설 — "mode" 는 파이프라인 게이트-밀도 등급과 이미 겹쳐 이름을 분리했다. awl-loop/SKILL.md 게이트2(완료) 절이 loopMode 를 조회해 semi-auto/auto 면 AskUserQuestion 을 생략하고 auto:true 로 기록한다. 게이트3 은 이 스킬이 아직 레거시 2게이트 흐름이라 해당 없음(아래 단계2 "모드" 절 참고) — awl-loop 의 실제 게이트2(완료)에만 적용

[o] 언제 아무 플래그도 안 주면, 서브에이전트를 하나도 안 띄워야 한다
    확인   프로세스 목록이나 세션 수를 센다
    의미   기본은 자가 검증이다. --review 를 켰을 때만 하나 뜬다
    근거   2026-07-28 라운드1 WI-F4 로 고침. awl-loop/SKILL.md·reference.md — 완료조건 3개마다 트리거가 이제 --review 옵트인(기본 자가 검증).
    정정   **2026-07-29: 위 판정은 골대를 옮긴 것이었다.** "awl-pipeline 계열은 다른 관심사"라고 범위를 좁혔는데, 설계 원문(reference.md:1511)은 "`loop` 도 `pipeline` 도 단일 세션으로 끝난다"로 pipeline 을 **명시적으로 포함**한다. 실패한 부분을 요구사항에서 빼내 통과로 찍은 셈이다. 0.8.4 에서 오케스트레이터·역할분할·`.tasks` 큐를 은퇴시켜 실제로 충족했다(레인당 1세션, --review 리뷰어 1회 스폰만 남김 — :2173 이 허용하는 편향 회피).

[?] 언제 교차 검증을 안 돌렸으면, 기록에 "안 함" 으로 남아야 한다
    확인   자가 검증만 돌린 뒤 기록을 연다
    의미   조용히 통과시키면 나중에 왜 놓쳤는지 알 수 없다
    근거   2026-07-28 라운드1로 --review 옵트인 자체는 생겼다(WI-F4, review.ts skip 표시는 별개). 다만 "review: 안 함 [-]" 을 기계가 판정 가능한 형태로 남기는 저장소(record 타입이든 status 필드든)는 아직 없다 — awl-loop 는 지금 review 를 안 돌리면 그냥 아무 기록도 안 남길 뿐, "안 함"이라는 사실 자체를 명시적으로 기록하진 않는다. 별도 라운드

[?] 언제 skills 를 전부 비우면, 파이프라인이 여전히 끝까지 돌아야 한다
    확인   profile.json 의 skills 를 전부 null 로 두고 돌린다
    의미   절차는 갈아끼우는 것이다. 없어도 계약은 만족돼야 한다
    근거   profile.ts defaultProfile 은 6슬롯 전부 null 이 유효하다고 주석에 명시(트리비얼하게 안 막음). 다만 profile.skills 를 실제로 읽어 절차를 갈아끼우는 실행 경로(파이프라인/루프)가 아직 없어서 "여전히 돈다"를 실측할 지점 자체가 없다

[o] 항상 커밋되는 파일에 토큰이 없어야 한다
    확인   git grep 으로 토큰 패턴을 훑는다
    의미   토큰은 ~/.awl/config.json 에 있다
    근거   프로젝트 AwlConfig(config.ts)엔 token/secret 필드 없음. sync token 은 core/global-config.ts 의 홈 전역 config 전용

[o] 언제 .awl 에 새 파일을 만들면, gitignore 를 안 고쳐도 untracked 여야 한다
    확인   .awl/아무거나.json 을 만들고 git status 를 본다
    의미   허용목록이라야 유출 사고가 구조적으로 안 난다
    근거   init.ts .gitignore 템플릿 — .awl/* 전체 무시 + !.awl/config.json, !.awl/profile.json 화이트리스트

[o] 언제 레인 A 가 gotcha 를 남기면, 레인 B 가 그것을 읽을 수 있어야 한다
    확인   레인 둘을 열고 한쪽에서 실패를 낸 뒤 다른 쪽 investigation 을 본다
    의미   격리는 코드만이다. 학습이 안 흐르면 같은 실수를 레인 수만큼 반복한다
    근거   lane.ts runLaneSync → learning-merge.ts mergeGotchaLists 로 전역 병합(레인은 안 지움), 명시적 동기화(단계5 WI-C)
```

---

## 1 · 문서 구조

### 생성

```
[o] 언제 awl doc new spec 을 실행하면, 프론트매터가 채워진 파일이 생성되어야 한다
[o] 언제 문서를 만들면, 파일명이 YYYYMMDD-HHMMSS-kebab 형식이어야 한다
[o] 언제 문서를 만들면, id 가 UUIDv7 이어야 한다
[o] 언제 문서를 만들면, 파일명은 로컬 시각이고 created 는 오프셋 포함 ISO 여야 한다
[o] 언제 스펙을 저장하면, revision 이 본문 해시로 채워져야 한다
    근거   2026-07-28 라운드2 WI-G3 — record.ts writeSpecStatus 가 게이트 전이(status 저장)마다 revision 을 본문 sha256 으로 재계산한다. 실제 CLI로 확인(빈 문자열→실제 해시)
[o] 언제 두 사람이 같은 초에 문서를 만들지 않는 한, 파일명이 겹치지 않아야 한다
    근거   2026-07-28 라운드2 WI-G9 — 문구가 감수해도 되는 경계로 읽히더라도 코드가 그 경계를 전혀 방어 안 하던 건 별개 결함이었다. createDoc 이 uniqueFilePath 로 파일이 이미 있으면 -2·-3… 접미사를 붙여 덮어쓰지 않는다. 라이브 검증: 같은 초에 같은 제목 두 번 생성 → 둘 다 보존(-2 접미사)
```

### 검사기

```
[o] 언제 조건이 EARS 다섯 문형으로 시작하지 않으면, lint 가 실패해야 한다
[o] 언제 조건에 질적 표현(적절한·깔끔한·최적화된·충분한)이 있으면, lint 가 실패해야 한다
[o] 언제 스펙 본문에 파일 경로가 있으면, lint 가 실패해야 한다
[o] 언제 파일명이 형식에 안 맞으면, lint 가 실패해야 한다
[o] 언제 용어집의 "쓰지 않음" 단어가 문서에 있으면, lint 가 실패해야 한다
[o] 언제 lint 가 실패하면, 어느 파일 어느 줄인지 지목해야 한다
    근거   2026-07-28 라운드2 WI-G4 — LintViolation.line 신설, extractConditionBlocks 가 본문 상대 줄 번호를 돌려주고 lintDoc 이 프론트매터 줄 수를 더해 파일 전체 기준으로 바꾼다. 실제 CLI로 확인(파일:줄 형태, 실제 파일 줄과 정확히 일치)
```

### 스펙 형식

```
[o] 언제 스펙을 만들면, Request 에 사용자 원문이 인용으로 남아야 한다
    근거   2026-07-28 라운드2 WI-G5 — `awl doc new spec ... --request <text>` 신설. 안 주면 기존 플레이스홀더로 하위호환. 실제 CLI로 확인
[o] 언제 스펙을 만들면, Instruction · Constraints · Conditions · Out of scope 자리가 있어야 한다
[o] 항상 스펙에 정지 조건 항목이 없어야 한다
[o] 언제 제약을 쓰면, verification · source · hits 가 함께 있어야 한다
    근거   2026-07-28 라운드2 WI-G6 — lintDoc 이 ### constraint-N 블록마다 verification:/source:/hits: 세 줄을 요구한다(extractSubBlocks 로 Conditions 와 동형 구조 공유)
[o] 언제 스펙 단계를 시작하면, 같은 domain 의 이전 스펙과 gotcha 를 자동으로 읽어야 한다
    근거   2026-07-28 라운드2 WI-G7 — `awl doc related --domain <domain>` 신설. 스펙은 domain 정밀매칭, gotcha 는 domain 필드가 없어 전체를 낸다(관련성 판단은 에이전트 몫). 스펙 저작 스킬 자체가 이 저장소에 아직 없어 SKILL.md 자동호출 배선은 별도
[-] 언제 이전 gotcha 에서 제약이 들어오면, source 에 그 gotcha 가 적혀야 한다
    근거   awl doc related 는 조회만 한다(WI-G7) — "제약이 들어오면"은 에이전트가 이 조회 결과를 보고 스펙 편집기로 Constraints 절에 source: <gotchaId> 를 직접 쓰는 행위이지 awl 이 자동으로 채우는 필드가 아니다(awl은 판단하지 않는다). WI-G6의 lint가 source: 필드 존재는 강제하지만 그 값이 실제 gotcha를 가리키는지는 검증하지 않는다 — 이 세부 검증은 범위 밖
```

### 설정

```
[o] 언제 awl init 을 처음 실행하면, ~/.awl/config.json 이 만들어져야 한다
[o] 언제 git config user.email 이 있으면, init 이 그 값으로 입력란을 채워야 한다
[o] 언제 author 를 고치면, git config 자체는 안 바뀌어야 한다
[o] 언제 두 번째 저장소에서 init 을 실행하면, author 를 다시 묻지 않아야 한다
[o] 언제 전역 config 가 없으면, 기록에 author 가 안 붙되 진행은 되어야 한다
[o] 항상 .awl/ 에 config.json · profile.json · *.local.json · state.json · records/ 등 gitignore 허용목록 밖 파일만 있어야 한다
    근거   2026-07-28 라운드4 문서 정본 갱신 — adk-prototype.md 단계1 "만들 것" 목록을 후속 단계가 실제로 추가한 파일들(skills-version.json·lane-meta.json·state.lock·verify-baseline.json·stages.md·tickets/<id>.json·records/+records-suffix.json·home/)로 갱신, 전부 gitignore 허용목록(!.awl/config.json·!.awl/profile.json) 밖 untracked라 유출 위험 없음을 명시. 코드 결함이 아니었던 항목 — gitignore 허용목록 구조(핵심12) 자체는 애초에 [o]였다
[o] 항상 config.json 에 engineVersion 이 없어야 한다
    근거   2026-07-28 라운드1 WI-F1 로 고침 — engineVersion 필드 완전 제거, versions.ts 의 project-vs-engine 쌍도 제거(skill-vs-engine 두 쌍이 같은 신호를 대체)
[o] 언제 awl config --show-origin 을 실행하면, 값마다 어느 파일에서 왔는지 나와야 한다
```

### stages.md

```
[o] 언제 awl 을 업데이트하면, stages.md 가 새 버전으로 재생성되어야 한다
[o] 언제 stages.md 를 열면, 계약만 있고 절차가 없어야 한다
[?] 언제 CLAUDE.md 를 열면, stages.md 를 참조하는 한 줄만 있어야 한다
    근거   upsertMarkedBlock 이 마커 사이 3줄(시작/@.awl/stages.md/끝)만 삽입 — 새 프로젝트에선 사실상 성립하나, 기존 CLAUDE.md에 다른 내용이 있어도 지우지 않으므로 "한 줄만"은 마커 블록 안에서만 참
```

---

## 2 · 티켓과 게이트

**이 단계 대부분이 미구현이다.** "완료"로 전해졌던 것과 달리, 실제로는 도출(§도출)과 게이트 layer 검증(record.ts)만 구현됐고, 게이트 화면 접기/펼치기 UI·모드 시스템 전체·`awl stages`·`awl next` 의 finding 재사용·자가검증(대응/제약/부존재)·`--review` 플로우 전체는 코드 근거가 없다. `engine/skills/claude/awl-loop/SKILL.md` 에도 이 문서가 말하는 `awl next`/`awl tickets`/모드 플래그 언급이 없어, 이 CLI 명령들이 실제 루프 스킬과 배선되지 않은 채 독립적으로 존재한다.

### 도출

```
[o] 언제 티켓을 도출하면, 조건 하나에 티켓 하나가 기본이어야 한다
[x] 언제 여러 조건이 기반을 공유하면, conditions 가 빈 티켓이 따로 나와야 한다
    근거   tickets.ts:14-16 주석에 명시적으로 범위 밖("필요하면 awl doc new ticket --spec <id> 를 직접 쓴다") — 자동화 없음
[o] 언제 티켓이 나오면, dependencies 가 구현 순서를 그대로 말해야 한다
    근거   2026-07-28 라운드2 WI-G8 — dependencies 가 [] 고정값이라 사람/AI 가 수동으로도 채울 방법이 전무했던 게 실제 결함(자동추론이 아니라 "채울 방법 자체가 없음"). adk-reference.md:587 "conditions 가 빈 티켓이 필요한지는 AI 가 판정한다" 원칙대로 자동 도출은 여전히 안 함(deriveTickets 는 손 안 댐) — 대신 DocNewOptions.dependencies + `doc new ticket --dependencies <ids>`(쉼표구분) 로 판정 결과를 저장할 수 있게 함. 라이브 검증: --dependencies 없이 만들면 [], "ticket-1, ticket-2" 주면 트림 후 [ticket-1, ticket-2] 저장 확인
[o] 항상 티켓이 조건을 복사하지 않고 참조해야 한다
[o] 언제 티켓이 완료되면, 파일을 지우지 않고 status 만 바꿔야 한다
```

### 게이트

```
[o] 언제 게이트 1 을 그리면, 범위 밖 항목이 접히지 않고 펼쳐져야 한다
[o] 언제 검증이 전부 통과했으면, 게이트에서 한 줄로 접혀야 한다
[o] 언제 실패나 지적이 있으면, 게이트에서 펼쳐져야 한다
[o] 언제 접힌 항목이 있으면, 거기 무언가 있다는 표시가 보여야 한다
    근거   2026-07-28 라운드4 WI-G19 — 4문장 공통. GateStatus 에 원본 배열(presentedCriteria:{id,status}[], presentedExclusions, reviewFindings)+folded 판정 추가. state.criteria 와 대조해 제시된 완료조건이 전부 passed 면 folded, exclusion/reviewFindings 가 하나라도 있으면 무조건 펼침. tty.ts Symbols 에 fold 필드(유니코드 ▸/ASCII >) 신설. 신규 테스트 5개 + 전체 스위트 64 files/1660 tests 통과. 라이브 검증: 미통과 조건+exclusion 있는 게이트 → 항목별 펼침(상태·사유 텍스트), 전부 passed 인 게이트 → "완료조건 N개 ▸" 한 줄 접힘 확인
[o] 항상 게이트 기록에 layer(request/ticket)가 있어야 한다
    근거   record.ts GATE_LAYERS, gate 3→ticket/gate 4→request 강제 검증
[o] 언제 자동 승인이 되면, 그 사실이 기록에 남아야 한다
    근거   2026-07-28 라운드1 — status.ts buildGateStatus 를 게이트 1~4 로 확장(WI-F2), g.auto 렌더링이 전 게이트에 일반화됨. 게이트2 자동승인 시 awl-loop/SKILL.md 가 "auto":true 를 기록에 명시(WI-F3)
[o] 언제 모드를 세션 중에 바꾸면, 바꾼 것도 기록에 남아야 한다
    근거   2026-07-28 라운드1 WI-F2/F3 — loopMode 는 state.json 에 저장되고(awl state set), 세션 중 재변경도 그 이후 게이트 기록의 auto/시각으로 재구성된다(별도 변경 로그는 안 둠, D-15 원칙과 일관)
```

### 모드

```
[o] 언제 --strict 를 주면, 네 게이트에서 다 멈춰야 한다
    근거   원래부터 기본 동작(항상 AskUserQuestion) — loopMode 신설로 strict 를 명시값으로 확정했을 뿐 동작 변화 없음(WI-F3)
[o] 언제 아무것도 안 주면, 게이트 2·3 이 자동 승인되어야 한다
    근거   2026-07-28 라운드1 WI-F2/F3 — semi-auto(기본)에서 게이트2(완료)가 자동승인된다. "게이트 3"은 awl-loop 가 아직 레거시 2게이트 흐름이라 해당 없음 — 4게이트 티켓 모델(게이트2=착수/게이트3=완료)로 이관되기 전까지는 게이트2 하나로 대응한다
[o] 언제 --auto 를 주면, 게이트 4 가 완료 티켓·조건·검증·자동승인 횟수까지 펼쳐야 한다
    근거   2026-07-28 라운드5 WI-H4 — status.ts 의 신규 GateStatus.requestSummary(totalTickets/completedTickets/conditionsTotal/autoApprovalCount). 게이트4 기록이 auto:true+spec 필드가 있을 때만 계산 — docs/tickets/*.md 중 그 spec 에 속한 티켓들을 모아 집계하고, 그 티켓들(+게이트4 자신)의 gate 기록 중 auto:true 인 것을 자동승인 횟수로 센다. auto:false 거나 spec 없는 레거시 호출이면 조용히 생략(크래시 아님). 신규 테스트 4개 + 전체 스위트 64 files/1695 tests 통과. 라이브 검증: 티켓 1개(조건 1개)인 스펙에 gate4 auto:true 기록 → `awl status` 에 "완료 티켓 0/1개 · 조건 1개 · 자동승인 1회" 정확히 출력
```

### awl next

```
[o] 언제 awl next 를 부르면, 단계 지시가 아니라 티켓의 계약이 통째로 나와야 한다
    근거   2026-07-28 라운드5 WI-H1 — `awl next [ticket-id]`(인자 선택, 생략 시 resolveCurrentTicketId 로 "지금" 티켓 자동판정) + NextView.constraints(doc.ts 의 기존 extractConstraintBlocks 재사용) + NextView.gateChecklists(게이트2/3 도달 정적 계약, adk-reference.md:998-1006 예시 그대로). 신규 테스트 10개 + 전체 스위트 64 files/1691 tests 통과. 라이브 검증: constraints 채운 스펙에서 `awl next` 무인자 실행 → 티켓 자동판정+constraints+게이트체크리스트+기존 finding/skill 전부 확인
[o] 언제 awl next 를 부르면, 기존 finding 이 재료로 함께 나와야 한다
[o] 언제 finding 이 가리키는 파일이 그 뒤 커밋에서 바뀌었으면, "확인 필요" 로 표시되어야 한다
[o] 언제 프로파일의 skills 를 바꾸면, SKILL.md 를 안 고쳐도 awl next 출력이 바뀌어야 한다
    근거   2026-07-28 라운드4 WI-G21 — 3문장 공통. NextView 에 knownFindings/skill 추가. computeNextView 가 같은 specId 의 audit 기록에서 findings 를 모아 "이미 아는 것"으로 출력(WI-G20 이 놓은 where/source 필드 활용, specId 는 record.ts 가 top-level 필드를 제한하지 않아 자유 필드로 이음, D-15). 신규 checkFindingsFreshness — where(file:line) 파일이 finding 기록 이후 커밋됐는지 `git log --since` 로 확인, status.ts checkMissingAcCommits 와 같은 원칙(동기 조립/비동기 git 조회 분리, git 없어도 안 죽음). profile.ts SKILL_SLOTS 를 티켓 status 와 매칭해 skill 줄에 노출. 신규 테스트 12개 + 전체 스위트 64 files/1670 tests 통과. 라이브 검증(스크래치패드): spec→ticket 도출 → specId 포함 audit finding 기록 → next 에 "이미 아는 것"+skill 노출 확인, finding 이후 파일 커밋 → 재실행 시 "확인 필요" 등장 확인
[o] 언제 awl stages 를 실행하면, 요청 층과 티켓 층이 나뉘어 나와야 한다
[o] 언제 awl stages --short 를 실행하면, 다섯 줄만 나와야 한다
    근거   2026-07-28 라운드2 WI-G14 — 신규 src/commands/stages.ts + program.ts 등록. 요청 층/티켓 층을 나눠 profile.json 의 스킬 슬롯을 그 자리에 채워 보여주고(adk-reference.md:1030-1057), --short 는 다섯 단계 이름만(adk-reference.md:1081). 라이브 검증: awl stages 출력에 "요청 층"/"티켓 층"/게이트 1~4 확인, awl stages --short 는 정확히 다섯 줄
```

### 검증

```
[o] 언제 자가 검증이 돌면, 조건 ↔ 검증 ↔ 커밋 대응을 확인해야 한다
[o] 언제 자가 검증이 돌면, 제약 위반을 확인해야 한다
[o] 언제 커밋을 지워도 테스트가 통과하면, 부존재 탐지가 그것을 잡아야 한다
    근거   2026-07-28 라운드4 WI-G22 — 재평가(코드 변경 없음). 이 3항목의 [x] 판정은 1차 점검(라운드1 착수 전) 스냅샷인데, 라운드1 WI-F4(커밋 efa0370)가 이미 engine/skills/claude/awl-loop/reference.md:47-53 "기본 — 자가 검증(서브에이전트 없음)" 절에 정확히 이 세 가지를 프로즈로 명시했다: "조건 ↔ 검증 ↔ 커밋 대응(완료조건마다 해당 커밋이 실제로 있는가), 규칙 위반(`awl rules --json`에 걸리는 게 없는가), 부존재 탐지 — 방금 만든 완료조건의 커밋을 임시로 되돌려보고... 그 상태에서도 테스트가 통과하면 그 테스트는 아무것도 안 재고 있다는 뜻이다". 코드로 강제되는 게 아니라 스킬 지침(SKILL.md 레벨)이라는 점은 라운드1의 게이트2/3 자동승인·모드시스템과 같은 방식 — 이 설계에서 자가 검증은 처음부터 "같은 세션이 절차로 수행"하는 것으로 설계됐다(verify.ts 에 별도 selfCheck 코드가 없는 게 결함이 아니다)
[o] 언제 --review 를 켜면, 리뷰어에게 재료를 주고, 그것만으로 판단이 안 서면 능동적으로 추가 파일을 읽을 수 있어야 한다
    정정   2026-07-28 라운드4 WI-G23/G24 재확인 — 원래 문구("추가 파일 열기를 막아야 한다")는 1차 점검 스냅샷 당시의 설계 의도였으나, 그 이후 engine/skills/claude/awl-loop/reference.md:63(WI-H 실측: "diff 를 미리 넓히거나 파일을 통째로 끼워 넣는 것보다, 이렇게 능동적으로 확인하라고 명시하는 쪽이 실제 결함을 더 많이 잡았다")가 반대 결론을 내렸다 — **차단이 아니라 능동적 확인 권장이 실측으로 더 나은 것으로 확인됐다.** 사용자 확인 후 이 항목의 EARS 문구 자체를 실측 결과에 맞게 정정한다(코드/스킬 문서는 이미 이 형태로 동작 중, 고칠 대상은 문구였다). "재료를 준다" 부분은 review pack(WI-G23)으로 별도 충족
[o] 언제 리뷰어가 재료로 판단할 수 없으면, "재료 부족: <무엇>" 을 반환해야 한다
    근거   2026-07-28 라운드4 WI-G23 — `assembleReviewForTicket`(review.ts)이 `{bundle} | {missing: string}` 을 반환. 티켓을 못 찾음/스펙에서 조건 원문을 못 찾음/베이스라인 이후 diff 가 비어있음 세 경우에 "재료 부족: <무엇>" 반환(CLI `awl review pack <ticket-id>`, exit 1). 신규 테스트 5개 + 전체 스위트 통과. 라이브 검증: 없는 티켓/베이스라인 없음 각각 "재료 부족: ..." + exit 1 확인
[o] 언제 --review 를 켜면, 티켓마다가 아니라 세션 하나가 커밋을 순차로 봐야 한다
[o] 언제 기반 티켓이 끝나면, --review 상태에서 그 자리에서 리뷰가 돌아야 한다
[o] 언제 재리뷰를 하면, 고친 커밋만 봐야 한다
[o] 언제 리뷰 왕복이 2회를 넘으면, 사람을 불러야 한다
    근거   2026-07-28 라운드4 WI-G24 — 4문장 공통. 세션 하나가 순차로 본다는 건 awl-loop 자체가 이미 단일 연속 세션 구조(별도 서브에이전트를 티켓마다 새로 안 띄움)라는 아키텍처로 성립하고, reference.md 신설 절이 그 흐름 안에서 기반(즉시)/기능(모아서) 티켓을 어떻게 스케줄할지 명시. 재리뷰 diff-only 는 `.awl/tickets/<id>.json` 의 신규 `lastReviewedCommit`(runReviewPack 이 성공할 때마다 자동 기록) 기준으로 diff 범위를 좁혀 코드로 구현(review.ts). 왕복카운트는 findings 있는 review 기록을 매번 파생 계산하는 `countReviewRoundTrips`(저장 안 함, D-15) 로 구현, ReviewBundle.roundTrips 로 노출하고 3회부터 사람용 렌더가 경고, reference.md 가 AskUserQuestion 호출을 지침으로 명시. 신규 테스트 6개 + 전체 스위트 64 files/1681 tests 통과. 라이브 검증: 1차 review pack → 재요청 시 재료부족 → 지적 담은 review 기록+수정 커밋 → 재리뷰가 roundTrips:1 을 정확히 세고 diff 가 새 커밋만(이전 커밋 내용 안 보임) 담음 확인
```

---

## 3 · 중앙 저장소

```
[o] 언제 POST /records 를 두 번 보내면, 같은 id 는 한 번만 저장되어야 한다
[o] 언제 같은 revision 의 스펙을 두 번 보내면, 두 번째를 무시해야 한다
[o] 언제 GET /specs 를 부르면, 본문 없이 프론트매터만 나와야 한다
[o] 언제 GET /specs?q= 를 부르면, 본문까지 훑어 찾아야 한다
    근거   4문장 공통 — scripts/dev-sync-server.mjs(로컬 개발용, npm 미배포)에 구현돼 있다. appendJsonlDedup/writeSpec 의 revision 대조/GET 핸들러 확인
[o] 언제 스펙이 draft 나 active 이면, 중앙에 전송되지 않아야 한다
[o] 언제 스펙이 closed 가 되면, 그때 전송되어야 한다
    근거   record.ts SPEC_STATUS_TRANSITIONS, nextStatus==='closed' 일 때만 syncClosedSpec 호출
[o] 언제 중앙에 파일이 쌓이면, docs/<owner>/<repo>/ 아래여야 한다
    근거   dev-sync-server.mjs specFilePath(dev 서버 한정)
[o] 언제 기록을 보내면, 봉투에 author 가 있어야 한다
    근거   2026-07-28 라운드2 WI-G1 — syncProjectRecords 가 author 없는 기록을 전송 전에 건너뛴다(커서는 그 자리에서 안 움직이고, 뒤이어 author 있는 기록이 성공하면 자연히 지나쳐진다). 실제 dev-sync-server 로 왕복 검증: 전송된 봉투에 author 항상 포함
[?] 언제 문서를 보내면, author 가 생성자여야 한다
    근거   record.ts:298-305 는 gate4 시점의 전역 author 를 쓴다. 스펙 프론트매터 자체엔 독립된 "생성자" 필드가 없어(doc-frontmatter.ts) "생성자인지 지금 승인하는 사람인지" 코드로 구분·검증이 불가능하다 — 단일기기·단일author 가정 하 근사치
[o] 항상 feedback 에는 author 가 없어야 한다
    근거   core/sync.ts buildFeedbackEnvelope 이 author 를 구조분해 후 버림
```

### 전송

```
[o] 언제 endpoint 가 없으면, 재시도도 큐도 없이 로컬에만 쌓여야 한다
[o] 언제 endpoint 를 나중에 설정하면, 그 이전 기록은 소급 전송되지 않아야 한다
    근거   2026-07-28 라운드2 WI-G2 — 이 프로젝트의 records 스트림을 처음 추적하는 트리거는 전송 없이 커서만 시드한다(가장 최근 기록으로). 부수적으로 readRecords() 가 최신순(내림차순)이라는 걸 재확인해 커서 재개(resume) 슬라이싱 방향도 같이 고쳤다(기존엔 최신이 아니라 더 오래된 기록 쪽을 slice하고 있었음). 실제 dev-sync-server 로 왕복 검증: 첫 트리거는 서버에 아무것도 안 남기고, 다음 트리거부터 새 기록만 순서대로 전송됨
[o] 언제 전송이 실패하면, 커서가 그 자리에 머물러야 한다
[o] 언제 서버를 다시 켜면, 밀린 기록이 함께 전송되어야 한다
[o] 언제 7일이 지나면, 커서를 앞으로 밀고 "이 기간에 N건이 안 갔다" 를 로그로 남겨야 한다
[o] 항상 보낼 것을 따로 복사해 쌓지 않아야 한다
```

### doctor

```
[o] 언제 endpoint 가 없으면, doctor 가 [-] 로 표시하고 경고로 표시하지 않아야 한다
[o] 언제 전송이 재시도 중이면, doctor 가 미전송 건수를 함께 보여줘야 한다
```

---

## 4 · 프로파일

```
[o] 항상 verifications 가 config.json 에만 있어야 한다
[-] 항상 profile.json 에 name · description · skills 만 있어야 한다
    근거   AwlProfile 타입은 이 셋뿐이지만, validateProfile 이 알 수 없는 최상위 키를 거부하지 않아 강제는 느슨하다(타입은 맞음, 런타임 방어는 약함)
[o] 언제 공유 프로파일을 받으면, config.json 이 덮어써지지 않아야 한다
[o] 언제 프로파일을 받으면, 거기 적힌 스킬 중 설치 안 된 것만 받아야 한다
[o] 항상 설치 목록을 따로 두지 않아야 한다
```

### 검증 설정

```
[o] 언제 verifications 를 정의하면, 배열이고 순서가 실행 순서여야 한다
[o] 언제 scope 가 changed 이면, 변경한 파일에서 나온 실패만 봐야 한다
    근거   2026-07-28 라운드2 WI-G15 — D-30(검증 명령은 불투명한 셸 명령) 을 지키려고 출력 파싱 대신 applyChangedScope 로 명령 자체를 변경 파일로 좁혀 돌린다({files} 치환 또는 뒤에 붙임, --related 와 같은 방식). 변경 파일이 없으면 skipped:'no-changed-files'. 라이브 검증: scope:changed 검증에 변경 파일명이 인자로 실제로 전달됨 확인
[o] 언제 level 이 request 이면, 티켓마다가 아니라 요청을 닫을 때 한 번 돌아야 한다
    근거   2026-07-28 라운드2 WI-G15 — runVerifyChecks 에 opts.level 필터 + `awl verify --level ticket|request` 신설. opts.level 생략 시(기존 호출부 전부) 레벨 무관 전부 실행 유지 — awl-loop 가 아직 레거시 2게이트라 "요청 닫힘" 호출 지점이 없어 기본 동작을 바꾸면 e2e 류가 아예 안 도는 회귀가 생기기 때문(4게이트 이관 시 그 지점에서 --level request 호출). 라이브 검증: --level ticket/request 각각 올바른 부분집합만 실행 확인
[o] 언제 새 검사를 추가하면, scope: changed 로 시작할지 물어봐야 한다
    근거   2026-07-28 라운드2 WI-G15 후속 — runConfigSet 이 base 에 완전히 새 이름의 검증이 생기는 순간에만, TTY 인터랙티브 세션이면 readline 으로 한 번 묻는다(기본 Enter=changed). 비-TTY(CI·스킬 자동호출)는 안 묻고 지금처럼 scope 없이 저장 — 자동화 경로를 안 막는다. 라이브 검증: 비-TTY(stdin < /dev/null)로 새 검증 추가 시 프롬프트 없이 scope 미설정 확인
```

### 병합

```
[o] 언제 config.local 이 명령을 덮으면, 그대로 적용되고 경고가 없어야 한다
[-] 언제 config.local 이 검증을 skip 하면, 게이트에 경고로 표시되고 기록에 남아야 한다
    근거   doctor.ts·review.ts 가 [!] 로 표시는 한다(o 부분). 다만 record.ts 에 skip 관련 필드/영속 기록 로직이 없어 "기록에 남는다"는 안 지켜진다 — 표시만 되고 기록은 안 남음(부분 통과)
[o] 언제 profile.local 이 스킬을 바꾸면, 게이트에 정보로 표시되고 기록에 남아야 한다
    근거   2026-07-28 라운드2 WI-G16 — review.ts ReviewBundle.localSkills(renderReview 가 정보로 표시) + record.ts 가 게이트 기록마다 profile.local 오버라이드를 자동 첨부(localSkills, 없으면 필드 자체를 안 만듦). 라이브 검증: profile.local.json 으로 implement 슬롯을 덮고 awl review 실행 → "[i] 로컬 스킬: implement" 확인. 게이트 기록 첨부는 유닛테스트로 확인(readRecords 로 localSkills 필드 대조)
[o] 언제 배열을 병합하면, name 키로 항목 단위로 합쳐야 한다
[o] 언제 값이 여러 층에 있으면, 전역 → 저장소 → local 순으로 덮어야 한다
    근거   2026-07-28 라운드2 WI-G13 — 조사 결과 GlobalAwlConfig(author·sync)와 AwlConfig(project·verifications 등)는 겹치는 필드가 애초에 author 하나뿐이다(adk-prototype.md:58 "config.json 전역 기본값. author·sync"). AwlConfig 에 author(옵션) 추가, config.local.json 오버레이도 허용, loadConfig 가 base+local 을 병합하고 record.ts resolveEffectiveAuthor 가 "저장소가 정했으면 그것, 아니면 전역"으로 폴백. 라이브 검증: 전역만/저장소 추가/local 오버라이드 순으로 spike 기록 3건 남겨 author 가 global→repo→local 순으로 정확히 바뀜을 jsonl 에서 확인, --show-origin 도 저장소 출처를 정확히 보여줌
```

### 스킬

```
[o] 언제 스킬을 참조하면, url 만 필수여야 한다
[o] 언제 type 이 custom 이면, path 가 있어야 한다
[o] 언제 스킬이 null 이면, 그 자리를 건너뛰고 계약만으로 진행해야 한다
    근거   2026-07-28 라운드5 WI-H1/H2 — 신규 얇은 오케스트레이션 스킬 `awl`(engine/skills/claude/awl/SKILL.md)이 "`skill` 줄이 채워져 있으면 그 파일을 읽는다. 비어 있으면(`skill (없음)`) 계약만 보고 알아서 한다"고 명시하고, 그 판단 근거가 되는 `awl next`의 `skill` 필드는 WI-G21에서 이미 profile.skills 를 실제로 읽어 채운다(next.ts STATUS_TO_SKILL_SLOT). "profile.skills 를 읽어 절차를 갈아끼우는 실행 경로"는 결국 CLI(`awl next`)가 매번 지시를 만들고 얇은 스킬이 그 지시를 따르는 구조로 구현됐다 — 파이프라인/루프 코드 자체를 프로그래밍적으로 스왑하는 방식이 아니라, 설계 문서(adk-prototype.md:335 "지시는 CLI 가 만든다")가 실제로 말하는 방식 그대로다
[o] 항상 기본 스킬이 시스템에 박혀 있지 않아야 한다
```

---

## 5 · 레인과 토큰

```
[o] 언제 awl lane new 를 실행하면, 에이전트를 띄우지 않고 준비만 해야 한다
[o] 언제 레인을 만들면, 현재 브랜치가 기준 브랜치로 저장되어야 한다
[-] 언제 레인을 셋 열면, 서로 다른 worktree 와 포트에서 동시에 돌아야 한다
    근거   worktree 분리는 실재한다. 포트는 설계상 "정보성 오프셋 — awl 이 강제 주입하지 않는다"(lane.ts 주석)로 의도된 것이라 해당없음에 가깝다 — 실제 프로세스에 강제 주입하지 않는 게 이번 범위의 의도된 경계
[o] 언제 검증에 exclusive 가 붙으면, 레인이 여럿이어도 한 번에 하나만 돌아야 한다
[o] 언제 exclusive 가 켜져 있으면, doctor 가 그것을 표시해야 한다
    근거   2026-07-28 라운드2 WI-G10 — "로컬에서 건너뛴 검증"과 같은 패턴으로 exclusive 검증 이름을 info 로 보여주는 체크 추가. 라이브 검증: config.json 에 exclusive:true 검증 추가 후 awl doctor 출력에 "exclusive 검증: 1개: e2e" 확인
[o] 언제 기록을 쓰면, 레인별 파일로 나뉘어야 한다
[o] 언제 기록을 읽으면, 레인 파일 전부를 훑어야 한다
[o] 언제 레인을 정리하면, 기록을 병합할 것이 없어야 한다
    근거   2026-07-28 라운드3 WI-G17a/b — 3문장 공통. 사용자 확인("지금 기존걸 변경하는거라, 문서를 기준으로 진행해줘")에 따라 문서(adk-reference.md:576-591) 기준으로 구현을 바꿨다. records 저장 위치를 전역(~/.awl)에서 project-local(.awl/records/)로 이전(WI-G17a) + 레인 워크트리는 .awl/records 를 main 트리로 심링크하고 records-suffix.json 으로 파일명만 나눈다(WI-G17b) — config.json/profile.json 의 git 커밋 동기화와 다른, 실시간 공유 메커니즘. gotcha/rules 는 기존 AWL_HOME 격리+명시적 병합(runLaneSync) 그대로 안 건드림(이미 통과, 리스크 최소화). 라이브 검증(실제 워크트리): 레인에서 남긴 기록이 main 트리에서 커밋 없이 즉시 awl records --json 으로 보임, awl lane rm --force 후에도 레인접미사 있는/없는 두 파일 모두 그대로 남아 읽힘(병합 스텝 자체가 없어짐)
[o] 언제 미머지 커밋이 있으면, awl lane rm 이 거부해야 한다
[o] 언제 게이트 4 를 통과하면, 레인을 열 때 서 있던 브랜치로 병합을 제안해야 한다
[o] 언제 병합을 미루기로 하면, 판정만 기록되고 브랜치가 남아야 한다
```

### 토큰

```
[o] 언제 awl tokens 를 실행하면, 티켓별·단계별 사용량이 나와야 한다
[o] 언제 토큰을 기록하면, input · output · cache 를 나눠 남겨야 한다
[o] 언제 레인을 여럿 돌리면, 레인별 합계와 총합이 나와야 한다
    근거   2026-07-28 라운드3 WI-G17d — WI-G17a/b/c 로 records 파일명에 레인 접미사가 실제로 생겨 집계가 가능해졌다. record.ts readRecords 가 접미사 파일에서 읽은 레코드에 읽기 시점 lane 필드를 얹고, tokens.ts buildLaneTokensReport(순수)+computeLaneTokensReport(collectLanes 로 각 레인 워크트리 경로를 얻어 그 경로의 세션 로그를 따로 읽음, mangleProjectPath 가 절대경로별로 세션 로그를 가르기 때문)가 레인별 합계+총합을 낸다. `awl tokens --lanes` 신설. 라이브 검증: --worktree 레인 있는 프로젝트에서 (메인)과 레인 이름 둘 다 잡혀 각각 합계+총합 출력(발견·집계 구조 확인, 세션 로그 실측 데이터는 데모 환경이라 0건)
[o] 항상 세션 로그를 읽는 코드가 한 파일에 모여 있어야 한다
```

---

## 6 · 정리와 피드백

```
[o] 언제 검사기가 제약 위반을 잡으면, 그 제약의 hits 가 증가해야 한다
[o] 언제 리뷰어가 지적하면, 어느 제약인지 지목하거나 "없음" 을 명시해야 한다
[?] 언제 3회 반복 승격 후보가 30건을 넘으면, 부트스트랩 시 알림이 떠야 한다
    근거   SKILL.md 에 awl backlog --json 을 부트스트랩 시 부르고 overThreshold 를 확인하라는 지침은 있다. 다만 이건 "스킬 문서 지침"이지 CLI/awl 이 강제하는 게 아니다 — 에이전트가 안 따라도 코드 레벨에서 걸리지 않는다
[o] 언제 알림이 뜨면, "누구든 회의를 소집할 수 있다" 가 함께 나와야 한다
    근거   2026-07-28 라운드2 WI-G11 — backlog.ts renderBacklog(overThreshold 일 때 경고 줄 아래) 와 awl-loop/SKILL.md 의 사람용 알림 문장 둘 다에 문구 추가(--json 경로는 문자열을 안 내려주므로 SKILL.md 쪽도 별도로 고쳐야 실제로 사람에게 전달됨). 라이브 검증: 후보 31건으로 awl backlog 실행 → "누구든 회의를 소집할 수 있습니다." 출력 확인
[o] 언제 정리를 마치면, 증분 카운터가 리셋되어야 한다
[o] 언제 반복 안 된 항목이 쌓이면, 기록은 하되 알림에는 안 넣어야 한다
[o] 언제 도구 오류가 발생하면, 코드 내용 없이 최소 맥락만 전송되어야 한다
[o] 언제 awl feedback 으로 남기면, 사람이 쓴 것으로 구분되어야 한다
    근거   2026-07-28 라운드3 WI-G18 — `awl feedback "<text>"` 신설(program.ts, feedback-log.ts runFeedback). --area/--impact/--severity 검증 후 awl-feedback 레코드를 project-local records 에 source:'manual' 로 남긴다. 기존 자동수집(core/auto-feedback.ts)에도 source:'auto' 를 추가해 구분. 활성 워크아이템 없이도 남길 수 있다(자동수집과 같은 원칙). glue 테스트 9개(빈 text/잘못된 area·severity 거부, 프로젝트 못 찾음 거부, 기본값/커스텀 필드, 워크아이템 없이 동작, manual/auto 구분) + 전체 스위트 64 files/1655 tests 통과. 라이브 검증(스크래치패드 격리 프로젝트): `awl feedback "..."` → .awl/records/*.jsonl 에 source:manual 로 저장 → projects.json 등록 후 `awl feedback-log` 로 정상 집계 확인
[o] 항상 피드백에 절대 경로가 안 들어가야 한다
    근거   2026-07-28 라운드2 WI-G12 — redactAbsolutePaths 를 core/redact.ts(중립 위치, 순환참조 회피)로 옮겨 auto-feedback.ts 와 record.ts 양쪽이 공유. runRecord 가 type==='awl-feedback' 일 때 what/impact 를 buildRecord 호출 전에 redaction. 라이브 검증: 프로젝트 루트·홈 경로가 섞인 what/impact 로 awl record awl-feedback 실행 → 저장된 레코드에 <project>/<home> 치환 확인, 원본 경로 문자열 없음
```

---

## 횡단 점검

**한 단계에 속하지 않고 전체를 가로지르는 것들이다.**

```
[o] 항상 계약과 절차가 섞여 있지 않아야 한다
    확인   stages.md 를 열어 "이 순서로 해라" 가 있는지 본다
    실패   순서 지시가 있으면 그것은 스킬로 내려가야 한다

[?] 언제 에이전트가 우리 절차를 무시하고 다른 순서로 해도,
    산출물이 계약을 만족하면 통과해야 한다
    확인   일부러 순서를 뒤집어 돌려본다
    의미   이게 안 되면 계약 기반이 아니라 절차 기반이다
    근거   게이트 전환이 기록 존재 여부만 검사해 순서 불문(order-agnostic)으로 보이나, 실제로 순서를 뒤집어 돌려보는 전용 테스트는 못 찾았다 — 구조적으로 참일 가능성은 높으나 실측 안 됨

[o] 언제 사람이 손으로 만든 문서를 넣어도, 형식이 맞으면 받아들여야 한다
    의미   awl 로 만든 것만 받으면 도구에 갇힌다
    근거   doc.ts listDocFiles 는 디렉토리+확장자만으로 스캔, awl 생성 여부 표식을 요구하지 않는다

[o] 항상 우리가 만든 축약어가 없어야 한다
    확인   AC · CN · FL 같은 것이 남아 있는지 훑는다
    근거   2026-07-28 라운드4 WI-G20 — 조사(fork)로 실제 범위 확정: `criterion.id`는 코드상 검증 없는 opaque 문자열이라 마이그레이션 리스크 없이 표기 예시만 바꾸면 됐다. `CN`은 코드/문서 어디에도 없음(제약 추적 자체가 미구현이라 해당 없음, 손댈 게 없음). `AC`/`F`(finding) 축약을 engine/skills/{claude,codex}/awl-loop/{SKILL,reference}.md 의 JSON 예시·`<AC-ID>`·`AC-xx..AC-yy`와 program.ts 도움말 전부에서 condition-N/finding-N/`<condition-ID>`로 교체. **의도적으로 안 건드린 것**: 이 세션 자체의 `(WI-X AC-0N)` 개발관행 인용과 테스트 설명(`it('... AC-01 ...')`)— 설계문서가 금지한 "완료조건 id 축약"과 무관한 이 세션 고유의 작업항목 추적 관용어이고, 건드리면 과거 커밋/메모리와의 대조가 끊겨 감사추적이 나빠진다. 전체 스위트 64 files/1662 tests 통과

[?] 항상 파일명이 하는 일을 말해야 한다
    확인   default 처럼 사실과 다른 이름이 없는지 본다
    근거   표본 검색(config.ts 등)에서 명백히 오도하는 이름은 못 찾았으나, 코드베이스 전수 감사는 이번 라운드에서 안 했다

[o] 언제 무언가 실패해서 멈추면, 다음에 무엇을 하라고 알려줘야 한다
    확인   일부러 실패시켜 출력을 읽는다
    근거   state.ts/lane.ts 등의 에러 메시지가 일관되게 "무엇을 하라"는 다음 행동을 함께 낸다(예: "awl record gate 로 계획을 승인한 뒤 다시 시도하세요")
```

---

## 사람이 봐야 하는 것

**기계로 못 재는 것들이다. 한 사이클 돌린 뒤 눈으로 본다.**

```
[ ] 게이트 화면을 3초 안에 읽고 판단할 수 있었나
    아니면 접기 규칙이 틀렸거나 재료가 너무 크다

[ ] 게이트에서 그냥 승인만 누르게 되지 않았나
    그렇다면 그 게이트는 지금 값을 못 하고 있다

[ ] grill 질문이 지치게 하지 않았나
    왕복 횟수와 질문의 질을 함께 본다

[ ] 스펙을 나중에 열었을 때 왜 그렇게 만들었는지 알 수 있었나
    이게 의도부채를 막는지의 실제 시험이다

[ ] 남의 스펙을 읽고 무슨 일이 있었는지 알 수 있었나
    중앙에 모아둔 값이 여기서 나온다

[ ] 자가 검증이 놓친 것이 있었나
    있으면 --review 를 켤 시점이다

[ ] 토큰이 어디서 많이 나갔나
    awl tokens 를 보고 놀란 항목이 다음 개선 대상이다
```

---

## 결함을 다루는 법

**`[x]` 가 나오면 이렇게 한다.**

```
1  항목을 그대로 옮긴다
   체크리스트 항목이 이미 EARS 조건이므로 그대로 스펙의 조건이 된다

2  왜 그렇게 만들었는지 먼저 찾는다
   docs/decisions/ 에 그 결정이 있으면 읽는다
   결정이 있는데 구현이 다르면 구현이 틀린 것이다
   결정이 없으면 지금 정하고 남긴다

3  티켓으로 도출한다
   여러 결함이 같은 기반을 건드리면 기반 티켓이 먼저다

4  고치고 나서 이 목록을 다시 돈다
   고친 것이 다른 항목을 깨뜨렸을 수 있다
```

**한 번에 다 고치려 하지 않는다.**
핵심 12 가 통과하면 나머지는 순서대로 해도 된다.

---

## 이 목록의 한계

```
설계대로 됐는지만 본다      설계가 맞는지는 안 본다
그건 실사용이 답한다

기계 판정이 대부분이다      사람이 봐야 하는 칸이 따로 있는 이유다

지금 설계 기준이다          결정이 바뀌면 이 목록도 바뀐다
바뀐 결정을 여기 반영하지 않으면 낡은 것을 검사하게 된다
```
