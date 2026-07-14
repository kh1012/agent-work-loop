# 결정 기록 (decisions)

이 워크로직에서 불확실한 지점을 만나면 여기에 "가정 / 근거 / 대안"을 남긴 뒤 진행한다.

---

## D-1. 패키지명 `agent-work-loop`, 명령어명 `awl`

- **결정**: npm 패키지명은 `agent-work-loop`, CLI 명령어(bin)는 `awl`.
- **근거**: `npm view awl`이 `awl@0.0.2`를 반환한다. 무스코프 `awl`은 이미 선점되어 배포 불가. 반면 `npm view agent-work-loop`은 404(미사용)라 확보 가능.
- **대안**: `@kh1012/awl` 같은 스코프 패키지. 그러나 설치 경험(`npm i -g agent-work-loop`)과 실행 명령(`awl`)을 분리하는 편이 더 명확해서 무스코프 `agent-work-loop`를 택함.

## D-2. 인자 파서: `commander`

- **결정**: `commander`를 인자 파싱 라이브러리로 사용.
- **근거**: (1) 성숙하고 의존성이 가볍다. (2) `{ hidden: true }` 옵션으로 스킬 전용 명령을 `--help`에서 숨기는 요구사항을 그대로 만족한다. (3) `addHelpText('beforeAll', ...)`로 배너를 help 상단에 붙일 수 있다. (4) 크로스 플랫폼에서 검증된 표준.
- **대안**: `yargs`(무겁고 API가 장황), `cac`(가볍지만 hidden 명령·help 커스터마이즈가 약함), `clipanion`(클래스 기반, 러닝커브). 요구사항 대비 commander가 가장 균형이 좋다.

## D-3. 빌드: `tsup`

- **결정**: `tsup`로 `src/cli.ts` → `dist/cli.js`(ESM) 번들.
- **근거**: esbuild 래퍼로 설정이 짧다. 소스의 shebang(`#!/usr/bin/env node`)을 결과물에 보존하고 실행 권한(+x)을 자동으로 부여한다. ESM/target 지정이 간단하다.
- **대안**: esbuild 직접 호출(shebang·권한 처리를 수동으로 해야 함), `tsc`만 사용(번들 아님, 의존성 인라인 불가). tsup이 요구사항(dist/cli.js + shebang)을 가장 적은 코드로 만족한다.

## D-4. lint/format: `biome`

- **결정**: `@biomejs/biome`로 lint와 format을 함께 처리.
- **근거**: 단일 바이너리라 크로스 환경 설치가 단순하고, eslint+prettier 두 도구·플러그인 조합보다 설정이 짧다. "단순함 우선" 원칙에 맞는다.
- **대안**: `eslint` + `prettier`. 생태계는 넓지만 설정·플러그인이 많아 초기 골격에는 과하다.

## D-5. 테스트: `vitest`

- **결정**: 명세대로 `vitest` 사용. (선택 사항 없음)

## D-6. 버전 주입 방식: `package.json`에서 JSON import

- **가정**: `src/program.ts`에서 `import { version } from '../package.json'`로 버전을 읽고, tsup 번들 시 값이 인라인된다.
- **근거**: 빌드 시점에 버전이 결과물에 박혀서, 배포된 `dist/cli.js`가 런타임에 package.json을 다시 읽을 필요가 없다. `resolveJsonModule`로 타입체크도 통과한다.
- **대안**: 런타임에 `../package.json`을 `readFileSync`로 읽기(파일 위치 의존), tsup `define`으로 상수 주입(별도 전역 선언 필요). JSON import가 가장 표준적이고 짧다.

## D-7. `ref-knowledge-graph/`는 gitignore 처리

- **결정**: 저장소에 있던 `ref-knowledge-graph/`를 `.gitignore`에 추가한다.
- **근거**: 자체 `package.json`·`pnpm-lock.yaml`을 가진 별도 참조물이다. 이번 워크아이템에서 건드리지 말라는 지시가 있고, 실수로 커밋되지 않도록 추적에서 제외한다. 디스크에는 그대로 남으므로 이후 별도 워크아이템에서 조사 가능하다.
- **대안**: 그대로 두기(untracked 상태 유지). 하지만 실수 커밋 위험이 있어 명시적으로 무시한다.

## D-8. runner는 `shell: false`로 실행한다

- **결정**: `runner.run`은 `spawn`을 `shell: false`로 호출한다. 명령 문자열은 runner가 직접 토큰화해 `program`과 `args`로 나눈다.
- **근거**:
  - `shell: true`를 쓰면 명령 문자열이 사용자의 기본 셸(bash/zsh/PowerShell/cmd)로 넘어간다. 셸마다 인용·이스케이프·환경변수 문법이 달라 크로스 환경에서 동작이 갈린다. 특히 환경변수를 명령에 인라인하는 `NODE_ENV=test vitest`는 POSIX 셸에서만 동작하고 PowerShell에서 깨진다. 그래서 config는 `cmd`와 `env`를 분리하고, runner가 `env`를 `spawn`의 env 옵션으로 주입한다.
  - `shell: true`는 명령 문자열에 셸 메타문자가 들어오면 인젝션 위험이 생긴다. `shell: false`는 이 표면을 없앤다.
  - awl의 원칙(결정적·테스트 가능)에 맞다. 토큰화는 순수 함수라 단위 테스트가 가능하다.
- **대안**:
  - `shell: true`: 파이프(`|`)나 `&&` 같은 셸 기능을 쓸 수 있다. 하지만 검증 명령은 단일 프로그램 실행이면 충분하고, 셸 기능이 필요하면 config에서 스크립트 파일을 가리키게 하면 된다. 크로스 셸 위험을 감수할 이유가 없다.
  - `cross-spawn` 의존성 도입: Windows의 `.cmd` 래퍼 문제를 깔끔히 푼다. 다만 지금은 의존성을 최소로 유지하고, 실제 Windows 지원 강화는 별도 워크아이템에서 이 라이브러리 도입 여부와 함께 다룬다(아래 리스크 목록 참조).
- **한계 → WI-3에서 보강함**: `shell: false`이므로 Windows에서 npm으로 설치된 도구(`eslint`, `vitest` 등이 `.cmd` 래퍼로 깔림)를 이름만으로 `spawn`하면 실패한다. WI-2 시점에는 이 문제를 리스크 목록에만 남겼으나, WI-3 선행 확인에서 이것이 검증 실행(도구의 심장)을 Windows에서 완전히 막는 치명적 문제임을 확인하고 **D-10(cross-spawn 도입)으로 해결했다.** ENOENT는 여전히 `CommandNotFoundError`로 구분한다.

## D-9. 한글 폭 계산은 의존성 없이 직접 구현한다

- **결정**: 표시 폭 계산(`stringWidth`)을 `string-width` 같은 라이브러리 없이 CJK East Asian Width 범위를 직접 판정해 구현한다.
- **근거**: 이모지를 쓰지 않기로 했으므로 복잡한 이모지/결합문자 처리가 필요 없다. 다루는 문자는 사실상 ASCII + 한글/CJK뿐이라, 주요 wide 범위만 판정하면 결정적이고 테스트 가능하다. 의존성을 늘리지 않는다.
- **대안**: `string-width`(정확하지만 이모지·grapheme 처리로 의존성 트리가 커짐). 우리 용도에는 과하다.

## D-10. runner의 실제 spawn은 `cross-spawn`을 쓴다 (WI-3 선행 보강)

- **결정**: `runner.run`의 프로세스 생성을 `node:child_process`의 `spawn`에서 `cross-spawn`으로 교체한다. `shell: false` 원칙(D-8)은 유지하고, 명령 해석/실행만 cross-spawn에 위임한다.
- **왜 지금(WI-3 시작 전)인가**: D-8의 대비책은 ENOENT를 구분해 두는 것뿐이었다. WI-3 선행 확인에서 이것이 불충분함을 확인했다. 검증 실행은 이 도구의 심장인데, Windows에서 사용자가 config에 `eslint .`처럼 적으면 검증이 아예 안 돈다.
- **근거(직접 구현이 아니라 라이브러리를 택한 이유)**:
  1. Windows에서 npm 도구는 `eslint.cmd` 같은 배치 래퍼로 설치된다. 이름만으로 `spawn`하면 못 찾는다.
  2. 이름을 찾아 `foo.cmd` 절대경로로 바꿔도, **Node 보안 패치(CVE-2024-27980, Node 18.20/20.12/21.7+, 현재 실행 환경은 v22.22.2)가 `.bat`/`.cmd`를 `shell:false`로 spawn하는 것을 막아 EINVAL을 던진다.** 즉 `.cmd` 실행에는 `cmd.exe /c` 경유가 강제된다.
  3. `cmd.exe /c`로 감싸려면 Windows 인자 이스케이프(공백·따옴표·`^&|<>` 등)를 직접 처리해야 하는데, 이건 악명 높게 까다롭고 잘못하면 인젝션/오동작이 난다. `cross-spawn`이 정확히 이 탐색+이스케이프를 검증된 방식으로 처리한다.
  4. 직접 구현하면 이 위험 영역의 코드를 macOS에서 실증할 수 없다. "심장"에서 실증 불가한 버그를 안는 것보다, 의존성 하나로 정확성을 사는 편이 낫다.
- **테스트로 확인한 것**: 기존 runner 단위 테스트 12개가 cross-spawn 위에서 회귀 없이 통과(성공/실패, ENOENT 구분, 타임아웃 SIGTERM, AbortSignal 취소, env 주입). 추가로 절대경로가 아닌 이름(`node`)을 PATH에서 찾아 실행하는 케이스를 넣었다. Windows의 `.cmd` 실제 실행은 macOS에서 실증 불가하므로 cross-spawn의 검증된 동작에 위임하고, Windows 검증 시 아래 리스크 목록 2번으로 확인한다.
- **대안**: 순수 함수 `resolveCommand(program, {platform, PATHEXT, ...})`로 탐색만 직접 구현. 탐색은 순수 함수로 테스트 가능하지만, 위 (2)(3)의 `.cmd` 실행/이스케이프 문제는 여전히 남아 반쪽 해결이다. 그래서 택하지 않았다.

---

## D-11. doctor의 가정 (아직 확정 안 된 저장 위치)

- **가정 1 (교훈 저장 위치)**: doctor는 교훈 개수를 `~/.awl/lessons/` 의 파일 수로 센다. WI-2 `paths`에는 records/deltas/rules/templates/generations만 있고 "교훈(lessons)" 디렉토리는 아직 없다. 명세는 "교훈 개수(없으면 0)"를 요구하므로, 위치를 `~/.awl/lessons` 로 가정하고 없으면 0을 표시한다(크래시하지 않음).
  - **근거**: 규칙(rules)과 교훈(lessons)은 개념이 다르므로 deltas로 대체하지 않는다. `paths.ts`를 건드리지 않으려고(WI-3는 새 기반 코드 금지) doctor 내부에서 경로만 조합한다.
  - **대안/후속**: 교훈 디렉토리가 확정되면 doctor의 `lessonsDir` 조합을 그 위치로 바꾼다. 확정 시 `paths.ts`에 `lessonsDir()`를 추가하는 편이 낫다.
- **가정 2 (state 루프 위치)**: `state.json`의 스키마가 아직 없어, doctor는 `phase` / `step` / `position` 중 먼저 있는 문자열 필드를 "루프 위치"로 보여주고, 없으면 "있음"으로 표시한다. 스키마가 정해지면 이 판독을 맞춘다.
- **결정(status 분류)**: 문제로 세는 것은 `missing`(없어서 init 필요)과 `fail`(치명적 오류)뿐이다. `warn`(예: awl 스킬 미설치)과 `info`(예: Codex 없음)는 안내만 하고 종료 코드에 넣지 않는다. 명세 예시의 "문제 2개"(~/.awl 없음 + config 없음)와 일치한다.

## D-12. 패키지 매니저는 pnpm

- **결정**: 개발 패키지 매니저를 npm에서 pnpm으로 바꾼다. `package.json`에 `packageManager: "pnpm@10.33.4"`를 고정하고, lock 파일은 `pnpm-lock.yaml`을 쓴다(`package-lock.json`은 제거). README와 `prepublishOnly` 스크립트도 pnpm 기준으로 맞춘다.
- **근거**: 사용자 요청. pnpm은 디스크 효율(콘텐츠 주소 저장소·하드링크)과 엄격한 의존성 격리(유령 의존성 차단)가 장점이다. `packageManager` 필드로 corepack이 버전을 고정해 팀원 간 재현성이 좋아진다.
- **확인**: 전환 후 `pnpm install` → `pnpm run build` / `pnpm test`(57개) / `pnpm run typecheck` / `pnpm run lint` 모두 통과. 배포는 여전히 npm 레지스트리(`agent-work-loop`)를 대상으로 한다.
- **주의**: 앞으로 의존성 설치·스크립트 실행은 `npm` 대신 `pnpm`을 쓴다. `pnpm-lock.yaml`을 커밋하고 `package-lock.json`은 만들지 않는다.

## D-13. init 대화형은 readline 번호 입력 (화살표 raw-mode 아님)

- **결정**: `awl init`의 대화형 입력을 프롬프트 라이브러리(clack/inquirer 등) 없이 `node:readline`으로 직접 구현한다. 선택은 화살표/스페이스 raw-mode 대신 **번호 입력**을 쓴다. 화면 렌더는 tty.ts(sym/stringWidth/box 폴백)를 재사용한다.
- **근거**:
  - clack/inquirer 등은 자체 유니코드 기호·이모지·색을 쓴다. 우리의 ASCII 기본·이모지 금지·tty 폴백 정책과 충돌한다.
  - 화살표 raw-mode(키 이벤트)는 Windows conhost 등에서 깨지기 쉽고 단위 테스트가 불가능하다. 원칙 2(결정적·테스트 가능)·3(크로스 환경)과 배치된다.
  - 번호 입력은 결정적이고, 어느 터미널에서도 동작한다. 화면 텍스트는 `buildScreens` 순수 함수로 분리해 테스트/시연에서 실제 코드와 같은 화면을 렌더한다.
- **결정(프로젝트 루트)**: init은 `findProjectRoot`(상위로 .git 탐색)가 아니라 **현재 디렉토리(cwd)** 를 프로젝트 루트로 본다. "awl은 현재 디렉토리에서 실행하는 도구"라는 명세에 맞추고, 상위의 엉뚱한 .git으로 등록되는 것을 막는다. 프로젝트 이름은 디렉토리명.
- **가정(state 초기값)**: `state.json` 스키마가 아직 없어 `{ generation: 1, createdAt, loop: null }`로 시작한다. 스키마가 정해지면 맞춘다([[D-11]] 참조).
- **가정(비대화형)**: `--yes`는 감지된 기본값을 쓰고 성격은 빈 문자열. TTY가 아닌데 `--yes`가 없으면 안내 후 종료 코드 1. `stdin`과 `stdout`이 모두 TTY일 때만 대화형으로 본다.

## D-14. 접합(init→doctor)에서 발견해 고친 doctor 버그 2건

- **배경**: 명세의 "init 후 doctor가 정상인지" 검증이 실제 버그 2개를 드러냈다. 접합 테스트의 가치를 보여준 사례라 남긴다.
- **버그 1 (크래시)**: init이 만든 config는 설정하지 않은 검증을 `e2e: null`로 저장한다. doctor가 `verify`를 순회하며 `spec.cmd`에 접근하다 null에서 크래시했다. doctor는 크래시하면 안 된다(원칙). → 순회에서 null 스펙을 건너뛰도록 가드를 넣고, 타입도 `Record<string, VerifySpec | null>`로 고쳤다. 회귀 테스트(e2e: null 포함)를 추가했다.
- **버그 2 (부정확한 개수)**: doctor가 규칙 개수를 `~/.awl/rules` 직속 항목 수로 셌다. 그 디렉토리엔 `active/`·`index.json`·`graduated.md`가 있어 3으로 나왔고, init이 보고한 규칙 수(0)와 어긋났다. → 실제 규칙 저장소인 `rules/active`의 파일 수를 세도록 고쳤다.

## D-15. record 타입별 구조 (audit/spike/criteria/review/decision 가정)

- **결정**: record 는 타입별 필수 구조를 강제한다. 명세가 상세히 준 것은 attempt/blocked 뿐이라, 나머지는 다음과 같이 정의한다(자유 텍스트 필드 하나로 퉁치지 않는다).
  - audit: `scope`(무엇을 봤나) + `findings`(비어있지 않은 배열)
  - spike: `question`(무엇을 알아보려) + `found`(무엇을 알아냈나)
  - criteria: `items`(비어있지 않은 배열)
  - review: `target` + `verdict`
  - decision: `question` + `decision` + `rationale`
- **근거**: "사람이 못 읽는 기록은 기계(evolve)도 못 읽는다." 배열/명명 필드로 구조를 강제해야 evolve 가 "무엇이 막혔는가"를 찾을 수 있다. 필드가 바뀌어도 이 원칙(줄글 금지, 배열 강제)은 유지한다.
- **결정(project 자동 주입)**: record 데이터에 `project` 가 없으면 config 의 `project` 로 채운다. config 도 없으면(프로젝트 밖) 거부한다. 스킬이 매번 project 를 안 써도 되게 하되, 태그 없는 기록은 만들지 않는다.
- **결정(append only)**: 기록은 `~/.awl/records/YYYY-MM.jsonl` 에 append 만 한다. update/삭제 명령을 만들지 않는다. diff 는 `records/diffs/*.patch` 로 저장하고 레코드는 경로만 참조한다.

## D-16. WI-5 스킬용 명령들의 설계 선택

- **rules 필터(0.1.0 단순화)**: `scope` 로만 거른다(rule.scope 가 없거나 일치). "무태그(범용)는 항상 포함"이 지배 원칙이라, `character` 매칭은 규칙이 실제로 쌓이면 정교화한다. 0.1.0 은 규칙 0개이므로 이 단순화가 안전하다([[D-11]]).
- **config set 의 "실제 실행"**: 저장 전에 명령의 첫 토큰을 `--version` 으로 짧게 실행해(5초 타임아웃) 존재·기동을 확인한다. 테스트 스위트 전체를 돌리지 않는다(빨라야 함). ENOENT 면 경고하고 `--force` 없이는 저장하지 않는다. "파일 편집으로는 못 하는 검증"이라는 명세 취지를 지키면서 부작용을 줄인다.
- **state set 병합**: top-level 키를 얕게 병합한다(`{...current, ...patch}`). 배열/객체(criteria 등)는 통째로 대체한다. 부분 갱신을 깊게 병합하면 배열 원소 병합 규칙이 모호해지기 때문이다.
- **verify output**: stdout+stderr 를 전부 캡처해 결과에 담는다(스킬이 파싱). 사람용 렌더는 통과/실패와 소요 시간만 보여준다. 명령이 없으면 `error: "command_not_found"` 로 일반 실패와 구분한다.
- **config 명령(인자 없음)**: 현재 설정을 표로 보여주고, 수정은 `config set`(실행 검증 포함) 또는 `.awl/config.json` 직접 편집으로 안내한다. init 의 전체 대화형 재수행은 두지 않았다(수정 경로가 둘로 갈리는 혼란 방지).

## D-17. awl commit 은 스냅샷 + `git apply --cached` 로 격리한다 (방법 A)

- **결정**: "내 변경"을 식별하는 방법으로 **방법 A(스냅샷)** 를 택했다. 작업 시작 시 워킹트리를 `git stash create` 로 스냅샷 커밋으로 만들고 `refs/awl/baseline/<AC>` 로 고정한다. 커밋 시 `git diff <snapshot>` 으로 내 변경 patch 를 뽑아 `git apply --cached` 로 인덱스에만 적용한 뒤 커밋한다.
- **방법 B(git stash pop)를 거부한 이유**: stash 로 남의 변경을 격리했다가 복원(pop)하는 방식은, pop 이 충돌하면 남의 작업이 유실될 수 있다. 명세가 "이건 절대 있으면 안 된다"고 못 박았다.
- **방법 A 가 안전한 근거(실증함)**: `git apply --cached` 는 **인덱스에만** 적용하고 워킹트리를 전혀 건드리지 않는다. 그래서 어떤 경우에도 남의 미커밋 변경이 워킹트리에서 사라지지 않는다. 임시 repo 실증: 남의 변경(OTHER)은 커밋에 안 들어가고, 내 변경(MINE)만 커밋되며, 워킹트리에 OTHER 가 그대로 남았다.
- **불확실할 때 멈춘다**: 내 변경 hunk 가 남의 변경과 3줄(기본 컨텍스트) 이내로 겹치면 `git apply --cached` 가 실패한다. 그때는 커밋하지 않고 "사람이 확인하세요"로 알린다. `-U0`(컨텍스트 0) 같은 강제 적용은 잘못된 위치에 붙을 위험이 있어 쓰지 않는다. "불편한 게 남의 작업을 잃는 것보다 낫다."
- **자체 검증**: 커밋 후 `git show --name-only` 로 커밋된 파일이 내가 스테이징한 집합과 같은지 확인한다. 초과 파일이 있으면 경고한다.
- **`git add -A`/`commit -a` 금지, push 금지.** 스냅샷 SHA 는 `refs/awl` 로 고정해 gc 로 사라지지 않게 한다.

## D-18. review 조립 / proceduralErrors 구분 / 베이스 드리프트

- **review 는 자료만 만든다**: awl 은 리뷰하지 않는다. criteria + diff + verify + provenance + rules(scope=review) 를 조립해 넘긴다. 판단은 서브에이전트가 한다. 구현자의 대화 맥락은 넣지 않는다(신선한 눈).
- **provenance 가 핵심**: diff/verify 가 어떤 branch/commit/worktree 에서 나왔는지 함께 밝힌다. 없으면 리뷰어가 엉뚱한 cwd 에서 교차검증하다 낭비한다(드라이런 교훈).
- **proceduralErrors 구분**: 완료 조건에 `attempts`(구현 시도 실패 — 설계가 틀림)와 `proceduralErrors`(절차적 실수 — git 을 잘못 씀)를 나눠 기록한다. 전자만 3회 제한에 카운트하고, 후자는 고치고 넘어간다. 카운트 로직 자체는 WI-7(loop)의 몫이고, WI-5.5 는 필드 구조와 state 헬퍼만 제공한다.
- **베이스 드리프트**: 기준 브랜치는 `--base` 로 받거나 `@{upstream}` 으로 추정한다. 추정 실패 시 경고를 조용히 건너뛴다(에러가 아니다). merge-base 이후 기준 브랜치에 쌓인 커밋 수와, 내 파일과 겹치는 파일을 경고한다.

# Windows 리스크 목록 (macOS에서만 검증함 — Windows 검증 시 체크리스트로 사용)

이 프로젝트는 현재 macOS에서만 검증한다. 아래는 Windows에서 깨질 수 있는 지점과 대비다. 나중에 Windows에서 사람이 검증할 때 이 목록을 하나씩 확인한다.

1. **경로 구분자 (`/` vs `\`)**
   - 왜 위험: 문자열로 경로를 조합하면 Windows에서 `\`가 아닌 `/`가 섞여 깨지거나, 반대로 하드코딩된 `\`가 POSIX에서 깨진다.
   - 대비: `paths.ts`는 조합을 전부 `path.join`으로 한다. 문자열 연결(`+ "/" +`)을 쓰지 않는다. 테스트에 `path.win32.join`/`path.posix.join` 대조 단언을 넣어 문서화했다.
   - 확인법: Windows에서 `AWL_HOME`을 임시 폴더로 두고 각 경로 함수 출력이 `\` 구분자로 나오는지, `findProjectRoot`가 상위로 올라가며 찾는지.

2. **`.cmd`/`.bat` 래퍼 실행 — WI-3에서 cross-spawn으로 해결(D-10)**
   - 왜 위험: npm 전역/로컬로 설치된 CLI(`eslint`, `vitest`, `tsc` 등)는 Windows에서 `foo.cmd` 래퍼로 설치된다. `shell: false`인 `spawn('foo', ...)`는 확장자 없는 이름을 못 찾아 ENOENT로 실패하고, 이름을 `foo.cmd`로 바꿔도 Node 보안 패치가 `.cmd`의 `shell:false` spawn을 EINVAL로 막는다.
   - 대비: `runner`가 `cross-spawn`으로 실행한다(D-10). cross-spawn이 PATHEXT 탐색과 `cmd.exe /c` 경유·인자 이스케이프를 처리하므로 `run({ cmd: 'eslint', args: ['.'] })`가 Windows에서도 동작해야 한다.
   - 확인법(Windows에서): npm으로 로컬 설치된 도구를 이름만으로 `run({ cmd: 'vitest', args: ['run'] })` 했을 때 실제로 실행되는지, 존재하지 않는 이름은 여전히 `CommandNotFoundError`로 구분되는지.

3. **PowerShell의 환경변수 문법**
   - 왜 위험: `NODE_ENV=test vitest`는 POSIX 셸 문법이다. PowerShell은 `$env:NODE_ENV="test"; vitest`, cmd는 `set NODE_ENV=test && ...`로 완전히 다르다. 명령 문자열에 env를 인라인하면 셸마다 깨진다.
   - 대비: env를 명령 문자열에서 분리해 `config.verify.<name>.env`로 받고, runner가 `spawn`의 `env` 옵션으로 주입한다. 셸 문법에 의존하지 않는다.
   - 확인법: Windows PowerShell에서 `run({ cmd: node, args:[...], env:{ AWL_TEST_VAR:'x' } })`가 자식에 값을 전달하는지.

4. **콘솔 코드페이지와 한글 출력**
   - 왜 위험: 구식 Windows 콘솔(conhost/cmd.exe)은 기본 코드페이지가 UTF-8이 아니어서(예: 949/CP437) 유니코드 박스 문자와 한글이 깨진다.
   - 대비: `tty.ts`는 ASCII를 기본으로 두고, Windows에서는 Windows Terminal(`WT_SESSION`)이나 VS Code 터미널(`TERM_PROGRAM=vscode`)일 때만 유니코드를 켠다. 그 외 콘솔은 ASCII 폴백(`+ - |` 등). 박스 정렬은 표시 폭 기준이라 한글이 섞여도 깨지지 않는다.
   - 확인법: 구식 cmd.exe에서 박스가 ASCII로 나오고 정렬이 유지되는지, Windows Terminal에서 유니코드 박스가 나오는지.

5. **줄바꿈 (CRLF vs LF)**
   - 왜 위험: Windows는 CRLF, POSIX는 LF다. 자식 프로세스 출력이나 파일을 읽을 때 `\r`이 섞이면 문자열 비교·파싱이 어긋난다. git의 autocrlf 설정에 따라 소스 줄바꿈도 바뀔 수 있다.
   - 대비: `box`는 명시적으로 `\n`으로 조인한다. runner는 stdout/stderr를 그대로 캡처하므로, 이후 이 출력을 파싱하는 모듈에서 `\r?\n`으로 정규화해야 한다(다음 워크아이템의 몫으로 기록).
   - 확인법: Windows에서 runner가 캡처한 stdout에 `\r\n`이 섞이는지, 비교 로직이 이를 견디는지.

6. **`SIGTERM` 신호 처리(타임아웃)**
   - 왜 위험: runner는 타임아웃 시 `child.kill('SIGTERM')`을 보낸다. Windows에는 POSIX 신호 개념이 없어 SIGTERM이 기대대로 동작하지 않을 수 있다(프로세스가 즉시 죽지 않거나 트리의 자식이 남을 수 있다).
   - 대비: 지금은 macOS에서만 검증. Windows에서 문제가 되면 `taskkill /T` 또는 `tree-kill` 방식을 별도 워크아이템에서 검토한다.
   - 확인법: Windows에서 타임아웃 테스트가 `timedOut=true`로 끝나고 좀비 프로세스가 안 남는지.
