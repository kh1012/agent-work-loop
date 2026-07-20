# awl 발표 자료 기반 데이터 (raw material)

> 이 문서는 발표자료가 **아니다**. 발표자료를 만들기 위한 **근거 창고 + 논리 구조**다. 최종 발표자료(슬라이드 + 3분 가이드)는 이 문서 + 실측 json(metrics/records/narrative/gotchas/rules/generations)으로 조립한다.
>
> **원칙**: 데이터에 없는 것을 만들지 않는다. 증명 안 된 건 "아직 증명 안 됨"으로 표시한다. 팔지 말고 보여준다. 숫자엔 표본과 한계를 붙인다.
>
> **표기**: `[확보]`=근거 있음(파일:라인) · `[미확보]`=최종 시 awl 명령으로 채움 · `[정직]`=한계·불확실 명시.
> 루트: `/Users/kh1012/MIDAS/Research/agent-work-loop` · 버전 **0.6.23**(`package.json:3`).

## 문서 사용법
각 섹션 = 최종 발표 서사의 한 단계(문제→해법→증거→구조→발전→실측→한계). 새 근거가 나오면 계속 `[확보]`로 쌓는다.

---

## 섹션 1. 문제 (왜 이게 필요한가)
**논리 3단**: ① "다 했습니다"라는데 실제로는 안 돼 있다 → ② 목표가 **완료 조건으로 번역되지 않았기 때문**(무엇이 되면 끝인지 정의 안 함) → ③ **같은 실패를 반복**(실패가 기록 안 됨).

- `[확보]` 원래 사건(서사 출발점): 에이전트가 **명세가 얇은 트랙을 통째로 스킵**. (`[미확보]` records 원본에서 직접 인용)
- `[확보]` "다 했다는데 안 됨"의 실물: `awl commit`이 **"자체 검증: 내가 쓴 파일만 커밋됨"을 출력하고도** 완료조건 범위 밖 파일 흡수(editor-ux 3차 실사용, 14개·122줄/73줄 삭제). 자체검증이 동어반복(순환참조)이라 못 잡음. (decisions.md D-36, line 346-352)
- `[미확보]` records.json에서 "완료조건 없이 시작 → 실패" 사례.

---

## 섹션 2. 해법 (무엇을 만들었나)
**핵심 문장**: "awl은 판단하지 않는다. 파일과 상태만 관리한다. 판단은 이미 쓰고 있는 에이전트가 한다."

- `[확보]` 모토 원문:
  - `package.json:4`: "같은 실패를 두 번 하지 않는 도구. AI 에이전트가 한 일과 확인한 내용을 파일로 남깁니다."
  - `program.ts:18-19`(CLI 배너): "같은 실패를 두 번 하지 않는 도구입니다. 판단은 Claude Code나 Codex가 하고, awl은 파일과 상태만 관리합니다."
  - `SKILL.md:13-15`: "너(에이전트)가 머리다. 판단은 전부 네가 한다. / awl은 손발이다. 판단하지 않는다. 파일과 상태만 관리한다."
  - `README.md:7`: "awl 자체는 판단하지 않습니다. LLM을 호출하지 않고, 파일과 상태만 결정적으로 다룹니다."
- 파이프라인: `조사 → 설계 → 명료화 → 스파이크 → 완료조건` → **[게이트1]** → `자율루프(commit --start → 실패 테스트 → 구현 → verify → commit → record)` → **[게이트2]** → `evolve`.
- **게이트 2개가 왜 거기 있나**:
  - 게이트1: 목표를 정하는 일은 **판단**이다. 판단은 자율에 안 맡긴다. **자율 구간 시작점이 게이트1 이후라는 것이 이 설계의 전부.**
  - `[확보]` 게이트 = 실행 가능한 정지점(`SKILL.md:124-125`): "게이트는 의지가 아니라 도구 호출이다. `AskUserQuestion`의 응답을 받기 전에는 어떤 파일도 수정하지 않는다." "'승인을 기다립니다'라고 쓰고 다음 단락에서 구현을 시작하면 이 스킬은 실패한 것이다."
  - `[확보]` 완료조건 없는 목표 = 번역 태스크(`SKILL.md:57`).
- `[확보]` commit 격리(`SKILL.md:343` 절대규칙9 "git add 직접 쓰면 남의 미커밋 변경을 삼킨다" · `commit.ts:18-21` "확신할 수 없으면 커밋하지 않고 사람에게 알린다").

---

## 섹션 3. 왜 이게 작동하는가 (증거 — narrative **5종**)
**핵심**: `reviewer-caught`가 가장 설득력(기계 검증 전부 통과 → 리뷰어가 잡음). 각 사례에 **counterfactual** 필수. 철학(`SKILL.md:304-306`): "counterfactual은 그 일이 일어나는 순간에만 정확히 남길 수 있다 — 나중에 되짚으면 사후 정당화."

| kind | 무엇을 증명 | 확보 근거 |
|---|---|---|
| `gate-caught` | 게이트가 실제로 막았다 | `[미확보]` narrative.json |
| `reviewer-caught` | **verify 통과했는데 리뷰어가 잡음** | `[확보]` 2건(아래) |
| `spike-prevented` | 스파이크가 잘못된 설계 사전 차단 | `[확보]` 1건(아래) |
| `blocked-discarded` | 3회 실패 후 코드 버렸고 옳았다 | `[미확보]` narrative.json |
| `tool-failed` | **awl 자신의 도구가 실사고를 냈다(숨기지 않음)** | `[확보]` 0.4.5 tool-failed 추가 |

(정의: `record.ts:40-46` `NARRATIVE_KINDS` · `SKILL.md:308-312`)

- `[확보]` reviewer-caught ①: 리뷰가 **안전장치 자체의 구조결함** 발견 — `verifyPassedBefore:true`인데 findings 4건. `computeCoverage`가 `addresses` 오판 → 정상 처리된 발견을 게이트1에서 배제로 오판. 리뷰어가 **실제 CLI로 문서 예시를 그대로 실행해 재현**. (decisions.md line 395)
- `[확보]` reviewer-caught ②: 한글 파일명 **무증상 누락** — `git ls-files` quotePath로 한글 경로 인용돼 `git add` 매칭 실패. 리뷰어가 코드 근거로 지목, AC-05 편입해 `-z`(NUL) 통일 + 회귀 테스트. (decisions.md line 163-164)
- `[확보]` spike/test-caught: 파일 크기 이상치 임계를 **90th percentile 인덱스**로 설계 → 최댓값 자신이 인덱스 값이 돼 조건을 절대 못 만족하는 구조결함을 **테스트로 발견** → IQR(Tukey's fences)로 교체. (decisions.md line 298)
- `[확보]` tool-failed: `awl commit`이 "자체 검증 통과"를 보고하고도 무관한 파일 흡수 — 이 결함을 0.4.5에서 narrative `tool-failed` 신설과 함께 **기록·수정**(CHANGELOG 0.4.5). "발표에서 숨기지 않는다"(`record.ts:36-38`).
- `[미확보]` narrative.json에서 gate-caught / blocked-discarded 각 1건 + counterfactual.

**게이트1이 막는 것(코드 강제)**: audit 발견 중 어떤 완료조건도 안 다루는 배제를 `presentedExclusions`로 사람에게 명시 안 하면 **게이트1 기록 자체를 거부**(`record.ts:909` "배제는 판단이다. 판단은 게이트를 거쳐야 한다"). 게이트1 승인 기록 없이 `phase:"loop"` 전환 거부(`state.ts:352-366`). 0.6.3 적대검증: REJECT한 계획도 루프 진입되던 버그를 `hasApprovedGate1` fail-closed 수정(`program.ts:486-493`).

---

## 섹션 4. 시스템의 구조 (디렉토리와 관계)
```
~/.awl/                사람에게 속한다. 프로젝트를 옮겨도 따라온다
 engine/               npx가 덮어쓴다. 손대지 않는다
 records/              기록(월별 JSONL). 무슨 일이 있었는지. 안 지운다
 gotchas/              gotcha. 다음에 알아야 할 것. 강제력 없다
 rules/active/         규칙. 2회 반복된 gotcha. 강제된다. 얇게(상한 15)
 templates/            개인 초안 편향. 강제 아님
 generations/<proj>/   워크아이템=세대 지표 스냅샷
<프로젝트>/.awl/
 config.json           커밋한다. 팀원이 쓴다
 state.json            커밋하지 않는다(원자적 쓰기+락)
 verify-baseline.json  시작 시점 pass/fail(회귀 vs 사전결함 구분)
```
(경로 정의 `paths.ts` · 월별 `record.ts:527` monthFile · self-filter로 커밋 제외)

`[미확보]` 이 문서는 아직 `awl-pipeline`(여러 워크아이템을 레인으로 격리해 오케스트레이터가 exec·review를 스폰하는 구조)을 다루지 않는다. 그 내용은 [`storyline.md` 3절·6절](docs/presentation/storyline.md)과 README의 "LLM과 함께 실제로 쓰는 시나리오" 절에 먼저 정리돼 있다 — 다음 발표자료 조립 시 이 섹션에 편입한다.

**핵심 관계**:
- `[확보]` **왜 사람에게 쌓이나**(`README.md:171`): "이 프로젝트에서 배운 것이 저 프로젝트에서도 맞을까?" → 다음 프로젝트에서 빈손 방지.
- **기록 vs gotcha**: 사건의 전수 vs 재사용 가능한 요약(원본과 요약).
- **규칙 vs 템플릿**: 검사기로 만들 수 있으면 규칙(강제), 없으면 템플릿(기본값). **잘못된 강제는 없느니만 못하다.**
- `[확보]` 4갈래 + 상한: 강제가능=검사기, 판단필요=리뷰어, 프로젝트사실=config, 기본값=템플릿. `rules/active` 상한 15(`RULE_LOAD_LIMIT`, README:279 "아무도 안 읽는 규칙 목록이 되기 때문"). (decisions.md line 296-302)
- `[확보]` **awl-feedback ≠ gotcha**(`SKILL.md:256-258`): 도구 자체 아픔은 `~/.awl/records`에, 코드 교훈은 `~/.awl/gotchas`에.

---

## 섹션 5. 어떻게 발전하는가 (배움의 흐름)
```
검증 실패 → 기록(시도한 접근·실패 양상·diff)
  → 워크아이템 끝에 evolve가 gotcha를 뽑음(재사용 문장, 프로젝트명·AC ID 제거)
    → 2회 반복되면 알림(자동 승격 금지 — 사람이 rules promote)
        검사기로 만들 수 있으면 → 규칙(강제)
        만들 수 없으면          → 템플릿(기본값)
          → 규칙은 다시 검사기가 되어 검증에 편입
```
(흐름 `evolve.ts:14,219-330` · `SKILL.md:235-251` · sameAs면 count+1 `evolve.ts:318-330`)

**규칙 비대화 방지(가장 비직관적 — 질문 나올 지점)**:
- **졸업**: 같은 위반 2회 → 검사기로 승격 → `rules/active`에서 **삭제**.
- **잘 도는 시스템에서 `rules/active`는 얇아진다.** 두꺼우면 졸업이 안 되고 있다는 신호.
- 스코프 · TTL · 상한 15.
- `[정직]` `[미확보]` rules.json에서 실제 승격 사례 확인 — **규칙이 0개면 "승격 경로는 동작하나 실제 승격 사례가 아직 없다"고 정직하게 쓴다.**

---

## 섹션 6. 실측: 탐색 시간이 줄어드는가 (가장 중요, 가장 정직해야)
- `[미확보/최종]` metrics.json + generations로 표:
  ```
  세대  워크아이템  조사파일  시도/조건  막힘  리뷰지적  gotcha적용
  ```
  (지표 정의 `SKILL.md:248`: criteriaTotal/avgAttempts/blockedRatio/reviewRejects/proceduralErrors/gotchaApplied/gotchaMissed)
- `[확보]` gotcha-applied 실물 존재: G-013(매 AC 재빌드 확인) applied, G-004 missed. (decisions.md line 362) → 최종엔 "지난번 시도 N회 → 이번 0회" 형태로 구체화.
- **`[정직]` 반드시**: 워크아이템마다 난이도 다름(단순비교 조심) · `savedEstimate`는 추정 · **토큰 직접측정 불가**(awl은 LLM 호출 안 함 → 대리 지표, `metrics`) · 표본 적으면 "아직 표본이 적다".

---

## 섹션 7. 한계와 다음 (질문을 미리 받는다)
**실사용에서 터진 것 — 숨기지 않는다("우리도 겪었고 고쳤다" > "완벽합니다")**:
- `[확보]` **commit 자체검증 순환참조** → 무관 파일 흡수 → 고침. `selfCheckOk`가 커밋 파일==스테이징 파일 비교인데 커밋은 스테이징대로 만들어지므로 항상 동어반복 참. 메시지를 "내부 검증: 스테이징한 내용 그대로"로 정정 + 5개 초과 시 개수 경고. (decisions.md D-36) · `[정직]` **파일 수: decisions=14개(editor-ux) / 최종프롬프트=27개 — records에서 확정 후 인용.**
- `[확보]` **commit self-filter**(`commit.ts:87` `AWL_SELF_PREFIXES=['.awl-worktrees/','.awl/','.awl-home/']`): `.awl-worktrees/` 13만 파일이 criteria 88MB·state.json 128MB로 폭증하던 사고를 gitignore 아닌 **코드 레벨에서 근원 차단**(이중 방어 `init.ts:502`, `work.ts:545`). (섹션1의 14파일 흡수와 **별개 사고** — 하나는 범위오염, 하나는 자기데이터 폭증)
- `[확보]` **게이트가 도구로 강제 안 돼 우회** → 도구가 거부(phase 전환=승인레코드 검증, 0.6.3). (`program.ts:486-493`)
- `[확보]` **리뷰어가 구현자 미커밋 편집 파괴** → 리뷰는 깨끗할 때만 + provenance 명시. (decisions.md line 144, 264 주변)
- **아직 안 푼 것**: 팀 공유 경로(지금은 개인화만) · 대시보드 · 토큰 최적화.

---

## 부록 A. 진화 흐름 (CHANGELOG, 버전별 한 줄)
이 도구가 **자기 자신을 awl-loop 스킬로 개선**해온 궤적(CHANGELOG:260 "실사용 maxflow 모노레포에서 발견된 결함을 awl-loop로 awl 자신에게 적용"):
- **0.1.0** 첫 출시(init/doctor/verify/record/state/commit 격리/review/evolve + awl-loop 스킬)
- **0.2.0** 워크아이템 여러 개(work list/new/switch) · **0.2.x** dependsOn·`--worktree`·`--since-baseline`·파일크기 IQR·리뷰어 "구조 판정"
- **0.3.0** delta→gotcha 개명 · **0.3.1 계측 도입**(gotcha-applied/missed, narrative, metrics 세대추세)
- **0.4.0 게이트를 기록**(record gate, 게이트1 없이 loop 거부) · 0.4.1 워크아이템 등록 강제 · 0.4.2 리뷰 기록 구조화 · **0.4.3 완료조건 질 검사**(질적표현 거부)+배제 강제 · 0.4.4 diff 크기별 상세도 · **0.4.5 [명료화] 단계 + tool-failed + commit 순환참조 수정**
- **0.5.0** 버전 불일치 4쌍+version-check/update · 0.5.x init 방향키·카드 렌더
- **0.6.0~0.6.2** 안전·복구, Gate1 데드락 해소, **awl 자체 피드백** · **0.6.3 적대 검증**(게이트1 우회 차단) · 0.6.4~0.6.5 work done·doctor·gitignore
- **Unreleased** 동시성 3종(원자 state+락 / --isolated AWL_HOME / 병렬 사실표시) · records 월범위 · critical-only defer · brief · 실험 케이스 메타
- **한 줄 요약**: 계측(0.3.1) → 게이트 기록(0.4.0) → 완료조건 질·배제 강제(0.4.3) → **자기 도구 결함까지 기록(tool-failed 0.4.5)** → 적대적 자기검증(0.6.3) → 동시성/병렬 격리(Unreleased).

## 부록 B. 테스트 규모
`[확보]` 테스트 **파일 28개 · 총 686 케이스 · describe 160**. 최대 `record.test.ts` 126(기록 스키마 강제 = 심장). 단위(core) 5파일 95(paths/runner/select/tty/versions). 통합 21파일(init 58/work 50/doctor 45/config 40/verify 39...). 게이트 흐름 `gate-flow.test.ts`. **동시성/스트레스 2개**: `commit-isolation.stress.test.ts`(격리 커밋), `input-edge.stress.test.ts`(입력 엣지). → "awl의 모든 동작은 테스트할 수 있다"(README:5)의 실증.

## 부록 C. 명령 세트 (program.ts)
사람용: init/status/brief/doctor/version-check/update/config/work(+list/new/switch/abandon/done)/records/rules(+edit/promote)/gotchas/metrics/feedback/changelog/commit/review/deltas(폐기예정). 스킬 전용(hidden): record/verify/state(get/set)/evolve/defer-summary. 설계(`program.ts:89-93`): "--help엔 사람이 치는 명령만, 스킬 전용은 hidden."

## 부록 D. 큰 메시지 (계몽)
- 하네스 = LLM을 제어하면서 사람이 **에이전틱하게** 일하도록 돕는 트렌드.
- 곧 사라질 개념이라도 **경험해본 것과 아닌 것은 천지차이**.
- 이 도구는 그 경험을 "만들어가는 과정"에서 스스로 쌓아 증명한다(이 문서 자체가 그 산물).

---

## 최종 산출물 (요청 오면 2개)
1. **발표 슬라이드 md** — 슬라이드 1개 = 섹션 1개. 핵심 문장 1 + 근거.
2. **팀원용 3분 가이드** — 발표 못 들은 사람이 읽고 바로 쓰게: 설치 · 첫 루프 · 하드 룰 3줄.

## 문체 규칙 (최종 생성 시)
결론 먼저 · 나열은 리스트 · 금지어("혁신적/강력한/성공적으로/~을 통해") · 숫자엔 표본+한계 · **팔지 마라, 보여줘라.**

## 최종 시 첨부할 실측 데이터 (미확보분 채우는 명령)
```
awl metrics --json > metrics.json
awl metrics --narrative --json > narrative.json      # 섹션3 gate-caught/blocked-discarded
awl records --json > records.json                    # 섹션1 원래 사건, 27 vs 14 확정
awl gotchas --json > gotchas.json                    # 섹션6 gotcha-applied 사례
awl rules --json > rules.json                        # 섹션5 승격 사례(0개면 정직히)
cat ~/.awl/generations/<project>/*.json > generations.json   # 섹션6 세대 표
```
