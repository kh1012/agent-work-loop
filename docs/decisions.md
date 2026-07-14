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

## D-19. awl-loop 스킬 경로와 자기 검증 방식 (WI-6)

- **스킬 경로**: 스킬 본문을 WI-4 에서 확정한 설치 경로에 채운다.
  - Claude Code: `engine/skills/claude/awl-loop/SKILL.md` → 설치 시 `<project>/.claude/skills/awl-loop/SKILL.md`
  - Codex: `engine/skills/codex/AGENTS.awl.md` → 설치 시 `<project>/AGENTS.md` 에 마커(`awl-loop:start/end`)로 감싸 추가
  - **근거**: 명세 WI-6 산출물은 `engine/skills/awl-loop/SKILL.md`·`engine/skills/awl-loop.agents.md` 로 표기했지만, WI-4 의 `installClaudeSkill`/`installCodexSkill` 과 그 단위 테스트가 이미 위 경로를 참조·검증한다. "자리표시자를 채운다"는 WI-6 지시에 맞추려면 init 이 실제로 설치하는 경로를 써야 한다. init 코드/테스트를 다시 건드리지 않는다(범위 최소).
- **게이트는 도구 호출로 못박음**: SKILL.md 는 게이트마다 "AskUserQuestion 도구를 호출한다"를 명시한다(Codex 는 "턴을 끝내고 사용자 입력을 받는다"). "승인을 기다립니다"라고 텍스트로 쓰고 넘어가는 것을 실패로 규정한다. 드라이런 교훈: 멈춤은 의지가 아니라 도구 호출로 구현돼야 실제로 멈춘다.
- **자기 검증(dogfooding)**: 실제 홈(`~/.awl`)을 건드리지 않도록 검증 세션은 `AWL_HOME` 을 저장소 내 임시 디렉토리(`.awl-verify/`)로 격리한다. 스킬 설치(`.claude/skills/awl-loop/`)와 프로젝트 설정(`.awl/config.json`)은 이 저장소에 실제로 만든다. 목표 "awl status 추가"로 파이프라인을 돌려 게이트 1에서 `AskUserQuestion` 호출로 멈추는지 확인한다.

## D-20. WI-6 자기 검증 결과 (dogfooding 이 실제 결함 3개를 잡았다)

- **게이트 실증**: 게이트 1·2 모두 `AskUserQuestion` 도구 호출로 실제로 멈췄다. 텍스트로 "승인 대기"라고 쓰고 넘어가지 않았다. 스킬이 Claude Code 에 실제 설치되어 로드됐다.
- **dogfooding 이 잡은 결함(스킬 루프 안에서)**:
  1. **lint 위반(useTemplate)** — WI-5.5 커밋 때 놓친 위반. `awl verify` 의 lint 가 잡았다. `useTemplate` 은 unsafe fix 라 `biome check --write` 로 안 고쳐진다(`--unsafe` 필요).
  2. **commit 이 untracked 새 파일을 커밋 못 함** — `git diff <snapshot>` 은 untracked 를 보지 않는다. `awl commit` 이 `status.ts`(신규 파일)를 빠뜨렸다. → `startBaseline` 이 시작 시점 untracked 목록을 기록하고, `isolatedCommit` 이 "새로 생긴 untracked 만" `git add` 하도록 고침(남의 새 파일은 제외). 회귀 테스트 추가.
  3. **비ASCII 파일명 무증상 누락** — 리뷰어(서브에이전트) 지적. `git ls-files --others` 가 `core.quotePath=true`(기본)에서 한글 경로를 `"\355..."` 로 인용하면 이후 `git add` 가 매칭 실패한다. → 파일명을 내는 git 호출을 전부 `-z`(NUL 구분)로 통일하고 `git add` 실패를 감지하도록 고침. quotePath=true 를 강제한 회귀 테스트 추가.
- **리뷰어가 실질적 지적을 냈다**: 부정행위 없음을 확인하면서 위 3번(무증상 누락)을 코드 근거(파일:라인)로 지목했다. 지적을 새 완료 조건 AC-05 로 편입해 고쳤다. 리뷰 → 새 완료 조건 → 루프의 실증.
- **세션 트레일러는 붙이지 않는 게 맞다(정정)**: `awl commit` 은 커밋 메시지에 `Claude-Session:` 트레일러를 붙이지 않는다. 이건 결함이 아니다. `Claude-Session` 은 Claude Code 하네스가 커밋을 대화 세션에 링크하는 관례로, 사람이 되짚는 용도이지 기계가 읽는 값이 아니다. awl 은 크로스 환경(Claude Code + Codex)이라, 하네스 전용 트레일러를 박으면 Codex 환경에선 무의미하다. **evolve 는 이 트레일러를 읽지 않는다. evolve 가 읽는 것은 `~/.awl/records/*.jsonl` 과 state 다.**
- **커밋 추적은 SHA 로 한다(별개 사안)**: 커밋 추적이 필요하면 `awl commit` 이 커밋 후 `state.criteria[<AC>].baseline` 에 남기는 커밋 SHA 를 쓴다(`commit.ts` 참조). 다만 record 자체에는 커밋 SHA 필드가 없고, `state set` 으로 criteria 를 통째 교체하면 `baseline` SHA 가 날아간다([[D-16]] 얕은 병합). **record ↔ 커밋 SHA 연결이 필요한지는 WI-7 에서 evolve 가 정확히 무엇을 읽는지 확정한 뒤 정한다.** 미리 만들면 evolve 가 안 쓰는 필드를 넣을 위험이 있다.
- **dogfooding 산물 처리**: `.awl/config.json` 은 커밋한다(이 저장소도 awl 을 쓰는 설정, 팀 공유 대상). `.claude/`(설치된 스킬 사본, 원본은 `engine/`)와 `.awl-verify/`(격리 홈), `.awl/state.json` 은 gitignore 한다.

## D-21. awl evolve — 배움의 흐름 (WI-7, 0.1.0 마지막)

- **record ↔ 커밋 연결은 blocked 에만**: `record blocked` 에만 `baseline` SHA 를 자동 첨부한다(state 의 현재 완료조건에서). 성공한 시도는 커밋이 남아 있고 workitem/criterion 태그로 추적되므로 SHA 가 필요 없다. 막힘은 코드를 버리므로 그때만 baseline 이 의미를 갖는다(출발점을 patch 와 짝지어 복원). 나머지 타입에는 넣지 않는다 — 안 쓰는 필드를 만들지 않는다. [[D-20]] 에서 미룬 결정을 여기서 확정.
- **state set 얕은 병합 버그 수정**: `mergeState` 가 criteria 배열만은 id 기준으로 병합해 기존 필드(baseline 등)를 보존한다. criteria 이외의 배열/객체는 여전히 통째 대체([[D-16]]).
- **evolve 는 LLM 을 호출하지 않는다(원칙)**: 교훈 추출은 판단이지만 awl 은 판단하지 않는다. `--collect`(모으기)와 `--record`(쓰기·세기) 두 단계로 나누고, 그 사이에서 에이전트가 스킬로 교훈을 추출한다. evolve 가 스스로 교훈을 만들어내는 코드는 없다.
- **락**: `~/.awl/.lock` 을 `openSync(..., 'wx')` 로 잡는다. records/deltas 는 append 라 대체로 안전하지만 deltas 의 count 갱신과 rules 수정은 아니다. collect/record/promote 가 락을 잡는다.
- **2회 반복이 최소, 그마저 사람이 확인**: `sameAs` 로 같은 교훈을 다시 기록하면 count 를 올리고, 2회면 알린다. **자동 승격하지 않는다.** 한 번 나온 델타를 바로 규칙으로 만들면 그 프로젝트의 우연을 다음 프로젝트에 강요한다.
- **promote 는 applies/counter 를 강제**: 둘 중 하나라도 없으면 거부한다. 적용 조건 없는 규칙은 다른 프로젝트로 잘못 끌려가고, 반증 조건 없는 규칙은 검증 불가능한 신념이 된다. 정적 검사로 만들 수 있으면 검사기를 안내한다(졸업). 상한 15는 전역이 아니라 **이 프로젝트에 로드되는 규칙** 기준.
- **세대 지표는 프로젝트별**: `~/.awl/generations/<project>/<workitem>.json`. 0.1.0 은 기록만, 대시보드 없음. blockedRatio 가 세대를 거쳐 안 내려가면 델타를 쌓는 게 아니라 모으고만 있는 것이다.

## D-22. `rules promote --scope` 가 부모 `rules --scope` 와 충돌 — 빌드된 CLI 실증이 잡은 결함

- **배경**: WI-7 유닛 테스트(`buildRuleFile`/`validatePromoteOpts`/`checkRuleLoadLimit` 등 순수 함수)는 전부 통과하고 0.1.0 릴리스 커밋까지 나간 뒤, [[D-19]]와 같은 방식으로(WI-6 dogfooding 기록으로) `dist/cli.js` 를 격리 홈에서 직접 실행해 전체 파이프라인(collect→record→2회 반복 알림→promote→상한 경고→state set 병합)을 실증하는 과정에서 발견했다. 유닛 테스트는 `runRulesPromote`/CLI 파싱 계층을 거치지 않아 이 결함을 못 잡았다 — **CLI 인자 파싱 계층의 버그는 CLI 를 실제로 실행해야만 드러난다**는 사례.
- **증상**: `awl rules promote D-001 --scope implement --applies "..." --counter "..."` 를 실행하면 규칙은 만들어지지만 생성된 `.md` 의 frontmatter 에 `scope:` 줄이 아예 없다. `--scope` 값이 조용히 사라진다(에러 없음, 경고 없음).
- **원인(commander 12.1.0 최소 재현으로 확정)**: 부모 명령(`rules`, `--scope <scope>` 필터 옵션 보유)과 자식 명령(`rules promote`, 별도로 `--scope <scope>` 옵션 선언)이 **같은 플래그 이름**을 쓰면, 자식 액션의 `opts` 에서 그 값이 통째로 빠진다. `.enablePositionalOptions()` 를 부모에 걸어도(공식 문서가 이런 부모/자식 옵션 경계 문제의 해법으로 안내하는 방법) 이 특정 충돌은 안 풀린다 — 별개의 옵션 파싱 경로 문제로 보인다. 최소 재현:
  ```js
  const rules = program.command('rules').enablePositionalOptions();
  rules.option('--scope <scope>', 'parent').action((opts) => {});
  const promote = rules.command('promote <id>');
  promote.option('--scope <scope>', 'child').option('--applies <a>').action((id, opts) => {
    console.log(opts); // { applies: 'x' } — scope 없음. 이름을 --rule-scope 로 바꾸면 정상.
  });
  ```
- **결정**: `promote` 의 플래그만 `--rule-scope <scope>` 로 이름을 바꾼다(부모 `rules --scope` 필터는 [[D-16]] 이후 이미 쓰이고 스킬 문서([조사] 단계 `awl rules --scope audit --json`)에도 나와 있어, 바꾸면 파급이 더 크다 — 새로 추가하는 쪽만 바꾸는 게 최소 변경). `rules.ts` 내부 필드명(`scope`)과 규칙 파일 frontmatter(`scope:`)는 그대로 둔다 — CLI 플래그 문자열만 갈랐다.
- **재발 방지**: 부모/자식 명령이 옵션 이름을 공유해야 할 것 같으면, commander 로 실제로 최소 재현해 자식 opts 에 값이 들어오는지 먼저 확인한다. 이 문제는 타입체커도 린터도 못 잡는다(둘 다 `string | undefined` 타입은 맞고, 런타임에 값이 `undefined` 로 빠질 뿐이다) — **빌드된 CLI 를 실제로 실행하는 것만이 오라클이다.**
- **검증**: 회귀 격리 홈에서 `awl rules promote <id> --rule-scope implement --applies x --counter y` → frontmatter 에 `scope: implement` 확인. 부모 `awl rules --scope implement` 필터도 그대로 동작(무태그 규칙 + `implement` 태그 규칙만 노출) 확인 — 리네임이 부모 쪽을 깨지 않았다.

## D-23. readline 인터랙티브 루프를 테스트할 때: PTY 대신 question() 스크립팅

- **배경**: `awl config`(0.1.1, D-24)의 인터랙티브 메뉴를 검증하려고 실제 pty(`script` 명령, macOS)로 구동을 시도했다. 입력 전달이 들쭉날쭉했고(한 번은 cwd 를 지정하지 않아 이 저장소 자신의 커밋된 `.awl/config.json` 을 잘못 겨냥하기도 했다 — 실제 반영 전에 발견해 피해는 없었다), 신뢰할 수 없어 포기했다.
- **원인 규명(최소 재현)**: `readline.createInterface({input, output})` 에서, `question()` 이 걸려 있지 않은 시점에 도착한 줄은 그냥 버려진다. `input.write('a\nb\n')` 처럼 답을 미리 다 써 두면, `question()` 을 아직 한 번도 안 부른 시점에 두 줄 다 소비되어 사라진다(1회용 프롬프트-응답 대화가 전제라서다). 그래서 두 번째 `question()` 은 응답을 영원히 못 받고 멈춘다.
- **결정**: `rl.question` 을 감싸서, **호출될 때마다** 다음 답 하나를 `process.nextTick` 으로 그 직후에 흘려보낸다(질문이 실제로 걸린 뒤에만 답이 도착하도록 보장). PTY 없이, in-memory `PassThrough` 스트림만으로 결정적이고 빠르게(전체 스위트에서 밀리초 단위) 인터랙티브 루프를 끝까지 구동할 수 있다.
- **대안**: (1) 실제 pty(`node-pty`, `script`) — 의존성이 늘고 CI/로컬 간 재현성이 떨어진다(이번에 실측). (2) init.ts 처럼 인터랙티브 진입점 자체는 테스트하지 않고 순수 함수(`buildScreens` 등)만 테스트 — 안전하지만 실제 메뉴 분기(어떤 입력이 어떤 편집으로 이어지는가)는 미검증으로 남는다. 이번엔 새 인터랙티브 메뉴(`interactiveEditMenu`)가 이 워크아이템의 핵심 산출물이라 분기까지 검증하는 이 방식을 택했다.
- **재사용**: 앞으로 readline 기반 인터랙티브 루프(WI-D 의 `awl work switch` 등)를 테스트할 때 이 패턴(`question` 래핑 + nextTick 스크립팅)을 그대로 쓴다.

## D-24. `awl config set` 전체 키 지원 + 인터랙티브 편집 (0.1.1)

- **배경**: 실사용(maxflow 모노레포) 첫날, `awl config set mainLanguage typescript` 가 "지원하지 않는 키"로 거부됐다. init 의 언어 자동 감지가 TS 모노레포를 JS 로 오판했는데, 고칠 CLI 경로가 없어 `.awl/config.json` 을 손으로 고쳐야 했다. `awl config` 도 조회만 하고 안내 문구가 파일 직접 편집을 가리켰다.
- **결정**: `verify.*` 뿐 아니라 `project`/`mainLanguage`/`character`/`verify.*.cmd`/`verify.*.cwd`/`verify.*.env` 전부를 `config set` 이 다룬다. 키마다 검증 규칙이 다르다: `cmd` 는 실제로 실행해보고(기존 동작 유지), `cwd` 는 디렉토리 존재를 확인(상대경로는 프로젝트 루트 기준, 절대경로는 허용하되 경고), `mainLanguage` 는 알려진 값(`typescript`/`javascript`/`python`) 이 아니면 경고만 하고 저장은 허용, `character`/`project` 는 자유 텍스트(각각 검증 없음/빈 값만 거부).
- **`verify.<name>` (접미사 없음)은 하위 호환으로 `.cmd` 취급한다.** 기존 문서(renderConfig 의 안내 문구, WI-5 당시 예시)가 이 형태를 썼기 때문에, 형식을 통일하면서도 기존 사용자를 안 깨뜨렸다.
- **인터랙티브 편집은 init 의 `buildScreens` 를 재사용한다(새 화면 컴포넌트를 만들지 않는다).** 다만 "주 언어" 화면의 **기본 선택**은 `buildScreens` 가 만드는 auto-detect 결과가 아니라 **현재 config 값**으로 오버라이드한다 — 그렇지 않으면 오판을 고치러 온 사용자가 Enter 만 쳐서 같은 오판으로 되돌아가는 순환이 생긴다. 화면(시각적 표현)은 재사용하되, 실제 프롬프트의 기본값 파라미터는 호출자가 분리해서 넘긴다.
- **`config set [key] [value]` 로 둘 다 선택적**: 키 생략 시 설정 가능한 키 전체와 현재 값을 보여준다(스크립트 실수 방지 + 발견성). 키는 있는데 값이 없으면 같은 목록 + "값을 주세요" 안내.
- **`core/engine.ts` 로 `installedEngineVersion` 중복 제거**: doctor.ts 와 init.ts 가 각자 같은 함수를 갖고 있었다(WI-3, WI-4 에서 서로 모르고 중복 구현). `awl --version` 에도 필요해져 3번째 중복이 생기기 전에 공유 모듈로 뺐다.
- **검증**: `applyConfigValue` 단위 테스트 20개(키별 통과/거부/경고/보존), `interactiveEditMenu` 단위 테스트 5개(D-23 패턴), 실제 CLI로 "지원하지 않는 키" 오판 시나리오 재현 후 `config set mainLanguage typescript` 로 고쳐지는 것 확인.

## D-25. WI-A: `detectLanguage` 워크스페이스 멤버 tsconfig 확인 (0.1.2, awl-loop 로 진행한 첫 워크아이템)

- **배경**: 실사용에서 `awl init` 의 언어 자동 감지가 TypeScript 모노레포를 JavaScript 로 오판했다고 보고됐다. 이 워크아이템은 Part 0(손으로 한 기반 작업) 이후 **처음으로 awl-loop 스킬을 통해 진행한** 워크아이템이다 — 게이트 1(완료 조건 승인) → 자율 반복(TDD) → 게이트 통과 → 리뷰 순으로 실제로 돌았다.
- **가정(원본 버그 재현 불명확)**: 명세의 maxflow 예시("tsconfig.json 있음, packages/*/tsconfig.json 있음")는 루트에 이미 tsconfig.json 이 있다고 서술돼 있어, 기존 코드의 첫 번째 체크(`exists(cwd/tsconfig.json)`)로 이미 잡혔어야 할 케이스처럼 읽힌다. 정확히 어느 `cwd`/상태에서 오판이 났는지는 명세에 없다. **재현을 정확히 복원하는 대신, 명세가 요구한 4가지 감지 규칙(루트 tsconfig/typescript dep/워크스페이스 멤버 tsconfig/애매하면 TypeScript)을 전부 구현하는 쪽을 택했다** — 어느 경로로 오판이 났든 이 4가지가 커버한다.
- **"애매하면 TypeScript" 는 이미 구현돼 있었다**: `detectLanguage` 가 `null` 을 반환하면 `buildScreens`(정확히는 `langDefaultIndex`)가 `detected ? LANG_VALUES.indexOf(detected) : 0` 로 index 0(`typescript`)을 기본 선택한다. 그래서 새로 손댈 곳은 **"package.json 은 있는데 TS 신호가 하나도 없을 때"** 뿐이었다 — 이 경우는 여전히 `javascript` 로 판정한다(순수 JS 프로젝트를 잘못 TS로 만들지 않기 위해; "애매함"은 신호가 전무한 경우에 한정되지, 명확한 부정 신호가 있는 경우까지 뒤집는 게 아니라고 해석했다).
- **워크스페이스 글롭은 새 의존성(glob 라이브러리) 없이 직접 구현했다.** `<dir>/*`(한 단계)와 `<dir>/**`(그 지점 자신 + 모든 깊이의 하위 디렉토리, 최대 6단계)만 지원한다. 브레이스 확장 등 풀 글롭 문법은 지원하지 않는다 — 워크스페이스 멤버의 tsconfig 유무만 확인하면 되는 좁은 용도라 이 정도로 충분하다고 판단했다.
- **pnpm-workspace.yaml 파싱은 라인 기반이다**(YAML 파서 의존성 없음). block-style 리스트(`- 'a'`)와 flow-style 배열(`packages: ['a']`) 둘 다 인식하고, 따옴표 밖의 `#` 이후는 주석으로 잘라낸다.
- **리뷰(서브에이전트, `awl review` 조립 자료만 보고 구현자 맥락 없이 진행)가 실제 재현된 결함 3건을 찾았다** — 전부 반영해 고쳤다:
  1. pnpm-workspace.yaml 항목에 인라인 `# 주석`이 있으면 옛 정규식이 `$` 앵커 매치에 실패해 워크스페이스 전체가 유실됨(높음). → `stripYamlComment` 로 따옴표 밖 `#` 만 잘라내도록 수정.
  2. flow-style 배열(`packages: ['a']`)을 아예 인식 못 함(중간). → 별도 파싱 분기 추가.
  3. **`**` 를 `*` 와 동일하게(1단계만) 확장한다고 최초 구현/주석에 적어놨지만, 실제로는 2단계 이상 중첩된 워크스페이스 멤버를 조용히 놓쳤다(높음) — 이 워크아이템이 고치려던 것과 같은 종류의 오탐이 `**` 패턴에서 재발한 것.** → `**` 를 진짜 재귀 확장(자신 + 모든 하위 디렉토리)으로 바꿨다.
  - 리뷰가 "약한 단언"으로 지적한 테스트 1건("워크스페이스 멤버 중 어느 것도 tsconfig 가 없으면 여전히 javascript")은 새 로직을 지워도 결과가 같아(음성 케이스라 구조적으로 불가피) 유지했다 — 다른 AC-03 테스트들이 이미 새 로직 존재를 판별한다.
  - 리뷰 결과에 첨부된 `verify` 블록이 `command_not_found`(lint/test)로 나온 것은 코드 결함이 아니라 그 리뷰 자료를 조립한 셸에 `node_modules/.bin` 이 PATH 에 없었던 것(이 세션에서 반복적으로 마주친 이슈). 별도로 PATH 를 잡고 `awl verify` 를 직접 돌려 `passed: true` 를 확인했다.
- **알려진 한계(후속 조사 필요)**: 같은 파일(`docs/decisions.md`)을 baseline 갱신 시점 전후로 두 번 손댔더니 `awl commit` 이 "hunk 가 남의 변경과 겹칠 수 있다"며 거부했다. `git status`/`git diff` 로 실제로는 그 파일 하나뿐이고 순수 추가 diff임을 직접 확인한 뒤 수동으로 `git add`+`git commit` 했다 — 도구가 "확신할 수 없으면 사람에게 알린다"고 정확히 설계된 대로 동작한 것이라 안전 원칙 위반은 아니지만, **연속된 자기 자신의 편집이 이렇게 자주 걸리면 실사용에서 마찰이 크다.** `awl commit --start` 를 매번 다시 부르지 않고 "같은 워크아이템 내에서 baseline 을 유지한 채 여러 파일을 여러 차례 고치는" 흐름을 더 부드럽게 만들 여지가 있는지는 별도 워크아이템에서 조사한다.

## D-26. WI-B: 검증 명령에 cwd 지원 (모노레포)

- **핵심 전제를 스파이크로 실증**: `cross-spawn`(및 기저 OS exec 의미론)은 `cmd` 안의 **상대경로 실행파일**도 `spawn` 옵션의 `cwd` 기준으로 정확히 찾는다. 임시 디렉토리에 `packages/app` 와 `node_modules/.bin/fake-tool` 을 만들고 `run({cmd:"../../node_modules/.bin/fake-tool", cwd:.../packages/app})` 를 실제로 실행해 exitCode 0 을 확인했다 — maxflow 재현 시나리오(`cd packages/page-harness && ../../node_modules/.bin/tsc ...`) 그대로다. 이 덕분에 별도의 경로 재작성 로직 없이 `runner.ts` 의 기존 `RunSpec.cwd`(WI-2 부터 있었음)를 그대로 verify.ts 에서 쓰기만 하면 됐다.
- **cwd 스키마 자체는 Part 0/D-24 에서 이미 추가돼 있었다.** WI-B 는 그걸 실제로 **쓰는** 쪽(verify.ts/doctor.ts/init.ts)만 배선했다 — 그때 남겨둔 "런타임 배선은 WI-B 몫" 결정을 실행에 옮긴 것.
- **`AwlConfig`/`VerifyEntry` 타입이 config.ts/init.ts/doctor.ts 세 곳에 독립적으로 존재한다(3중 중복, 예전부터 있던 부채).** WI-B 는 이 통합을 시도하지 않고, 세 곳 각각의 로컬 타입에 `cwd?: string` 만 추가하는 최소 변경으로 갔다 — 타입 통합은 그 자체로 별도 워크아이템감이다.
- **doctor 의 검증-명령-존재-확인은 이제 cwd 존재도 먼저 확인한다.** cwd 가 없으면 `--version` 실행 자체를 시도하지 않고 `missing` + 어느 경로가 없는지 hint 로 알린다.
- **init 의 모노레포 감지는 WI-A 의 `workspaceGlobs`/`expandSimpleGlob` 을 그대로 재사용했다.** 언어 감지용으로 만든 워크스페이스 멤버 탐색이 검증 위치 찾기에도 동일하게 쓰인다 — 같은 개념(워크스페이스 멤버 디렉토리 목록)을 두 번 구현하지 않았다.
- **"판단이 어려우면 묻는다" 규칙**: 루트에 이미 검증 명령이 있으면(판단 쉬움) 묻지 않고 안내만 하고 루트를 유지한다. 루트에 신호가 전혀 없으면(판단 애매) 워크스페이스 패키지 목록을 보여주고 물어본다. `--yes`(비대화형)는 항상 루트를 유지한다 — 자동화 경로에서 "판단 어려우면 루트 기준"을 그대로 실현한다.
- **`interactiveInputs` 전체를 export 하는 대신, 모노레포 판단/질문 로직만 `promptVerifyLocation` 으로 분리해 export 했다.** D-23 의 readline 스크립팅 패턴으로 이 함수만 직접 테스트한다 — `interactiveInputs` 전체(언어·검증·규칙·성격·스킬 6단계)를 스크립팅하는 것보다 훨씬 가볍고 유지보수하기 쉽다.
- **알려진 한계(WI-D 로 미룸)**: `state.json` 의 `criteria` 배열이 워크아이템 경계 없이 flat 하다. WI-A 와 WI-B 가 같은 ID(AC-01~05)를 재사용하면서, id 기준 병합([[D-16]])이 겹치는 ID는 덮어쓰지만 안 겹치는 이전 워크아이템의 ID(WI-A 의 AC-06/07)는 그대로 남아 `awl status` 가 "5/5" 대신 "7/7" 처럼 잘못된 합계를 보여줬다. 지금은 `state.json`(gitignore 대상, 영구 기록 아님)을 손으로 정리했다. **이게 정확히 WI-D 가 고치려는 문제 그 자체다** — 이 워크아이템을 진행하며 실제로 겪은 것이라 WI-D 의 설계 근거로 남긴다.
- **서브에이전트 리뷰(AC-01~08 diff)가 지적한 3건을 AC-09/10/11 로 편입해 고쳤다.** (1) AC-09: init.ts 의 "검증 명령어" 화면 텍스트 배열이 `buildScreens`/`interactiveInputs` 두 곳에 리터럴로 중복 → `verifyStepLines()` 로 단일화. (2) AC-10: config.ts 가 AC-08 에서 만든 `resolveCwd()` 를 `verify.cwd` 설정 분기(같은 파일, 같은 diff)에서 안 쓰고 같은 로직(`isAbsolute ? v : path.join(...)`)을 인라인으로 재구현 → `resolveCwd()` 호출로 교체. (3) AC-11: 위 `applyVerifyCwd` 를 "순수 함수로 뽑았다"고 서술했는데 실제로는 인자를 mutate 한다 — **정정**: 순수 함수가 아니다. 테스트 가능하도록 별도 함수로 분리한 것이지, 인자 불변을 보장하지 않는다. 동작은 그대로 두고(의도된 설계) 주석과 이 문서의 서술만 정확하게 고쳤다. 리뷰가 "verify.ts/doctor.ts/config.ts 에 걸쳐 `isAbsolute?v:path.join` 패턴이 4번 중복된다"고도 지적했는데, 이건 이미 이 섹션 위에서 "타입 통합은 별도 워크아이템감"이라 기록한 것과 같은 종류의 부채라 WI-B 범위 밖으로 남겼다(AC-10 은 config.ts **내부** 중복만 고쳤다).
- **리뷰 지적 3건(AC-06/07/08)에서 D-25 가 남긴 "연속 자기편집 마찰" 이 실제로 재발했다(proceduralErrors 기록).** AC-06(`applyVerifyCwd` 분리) → AC-07(doctor `isDirectory` 통일) → AC-08(config `verifyCommandExists` cwd 순서 버그) 를 각각 `awl commit <AC> -m` 으로 닫지 않고 연속으로 편집해버려, 세 AC 의 변경이 한 워킹트리에 섞였다. `awl commit AC-06 -m ...` 을 그대로 불렀다면 baseline(AC-06 시작 시점) 대비 전체 diff — 즉 AC-07/AC-08 변경까지 — 를 통째로 AC-06 커밋으로 삼켰을 것이다(파일이 안 겹쳐 `git apply --cached` 가 순순히 성공하므로 도구의 자체 검증도 못 잡는다 — 이 실패 모드는 hunk 충돌이 아니라 **범위 오염**이라 별도다). 대신 `git diff -- <파일>` 로 각 AC 가 정확히 자기 파일 쌍(예: `config.ts`+`config.test.ts`)에만 있는지 직접 확인한 뒤 `git add <2개 파일> && git commit` 으로 수동 분리했다 — D-25 가 기록한 "확신할 수 없으면 사람이 확인" 원칙의 연장. 세 AC 모두 `proceduralErrors: 1` 로 기록했다. **교훈**: 완료 조건을 하나 끝내면 다음 것을 시작하기 전에 반드시 `awl commit <AC> -m` 으로 닫는다 — 이번처럼 "고치다 보니 다음 결함이 눈에 띄어 계속 고친" 흐름이 가장 위험하다. WI-D 가 워크아이템 경계를 state.json 에 도입하면, `commit`/`record` 가 "이전 AC 가 안 닫혔는데 다음 AC 를 시작하려 한다" 를 최소한 경고할 수 있을지도 검토 대상.
- **검증**: `pnpm run typecheck`/`lint`/`test` 전부 통과(200/200). AC-08 은 maxflow 재현 테스트(`../../node_modules/.bin/fake-tool`, cwd 기준 상대경로)로 수정 전 실패 → 수정 후 통과를 직접 확인했고, 기존 "cwd 보존" 테스트가 `/tmp` 를 프로젝트 루트로 쓰던 것도 실제 존재하는 임시 디렉토리로 고쳤다(수정 전엔 cwd 를 확인에 안 써서 우연히 통과하던 테스트였다).
- **발견(WI-B 범위 밖, `awl record audit` 로 기록 — WI-H 로 넘김): `awl review <range>` 가 이미 닫힌 완료 조건의 diff 를 통째로 빠뜨릴 수 있다.** `awl commit <AC> -m` 은 성공 후 그 AC 의 `baseline` 필드를 "시작 시점 커밋"에서 "그 AC 의 마지막 커밋"으로 덮어쓴다(다음 격리 커밋을 위한 정상 동작). 그런데 `review.ts` 의 `assembleReview` 는 범위의 **첫 완료 조건의 `baseline`** 을 diff 시작점으로 그대로 쓴다(`firstBaseline`). 범위의 첫 AC 가 이미 `-m` 으로 닫혀 있으면 그 `baseline` 은 더 이상 "범위 시작점"이 아니라 "그 AC 자신의 마지막 커밋"이라, `git diff <그 커밋>..HEAD` 가 그 AC 자신의 변경분을 제외해버린다. AC-09..AC-11 리뷰에서 실제로 재현했다 — AC-09 커밋(`a296c5c`)이 diff 시작점으로 쓰여 AC-09 자신의 diff 가 통째로 빠졌고, 서브에이전트 리뷰어가 저장소를 직접 열어 우회 확인했다. **이미 닫힌 AC 가 섞인 범위 리뷰에서 항상 재현되는 흔한 경로다(코너케이스 아님).** WI-H(review 자료 충분성)의 전제 자체가 이 버그로 최소 부분 설명될 수 있어, WI-H 착수 시 이 버그를 먼저 고치고 (a)/(b)/(c) 실측을 다시 해야 결과가 유효하다.

## D-27. WI-C: doctor 가 프로젝트 경로/브랜치를 안 보여주던 문제 (0.1.4)

- **배경**: 실사용에서 여러 프로젝트를 오가며 `awl doctor` 를 볼 때 지금 뭘 보고 있는지 헷갈렸다. 조사해보니 `collectProject` 는 `projectRoot` 를 **못 찾았을 때만** "프로젝트 루트" 체크를 push 했다 — 정상적으로 찾은 경우엔 그 체크 자체가 없었다(찾았을 때 안 보이고 못 찾았을 때만 보이는, 뒤바뀐 동작).
- **완료 조건 4개**: AC-01(프로젝트 루트를 찾았을 때도 항상 보여줌) + AC-02(브랜치 체크 추가 — `git symbolic-ref --short HEAD`, 실패는 전부 하나의 `try/catch` 로 흡수해 `null` 반환, git 아닌 프로젝트도 크래시 안 함) + 리뷰 지적 2건(AC-03: 실패 문구가 "git 저장소가 아니거나"로 원인을 단정해서 detached HEAD 등 다른 원인과 안 맞음 → "알 수 없음 (확인 실패)"로 일반화, AC-04: `projectRoot` 는 찾았지만 `config.json` 은 없는 조합의 전용 회귀 테스트 부재 → 코드 변경 없이 테스트만 추가, 첫 실행부터 green이라 기존 코드가 이미 안전했음을 확인).
- **리뷰 자료 조립 시 D-26 에서 발견한 `awl review` 의 baseline 오판정 버그가 그대로 재현됐다** — `--base` 를 명시적으로 지정해 우회했다(예: `awl review AC-01..AC-02 --base <WI-C 시작 커밋>`).
- **검증**: `pnpm run typecheck`/`lint`/`test` 전부 통과(208/208, doctor.test.ts 15개). AC-04 는 코드 변경 없이 테스트만 추가하는 케이스라 TDD red 단계가 없었다 — 리뷰가 지적한 "위험은 낮지만 테스트가 없다"는 지점을 정확히 커버하는 픽스처를 추가해 처음부터 green 으로 확인했다.
- 이번엔 D-26 이 남긴 교훈(완료 조건을 안 닫고 연속 편집하지 않기)을 지켜 `proceduralErrors` 0건으로 마쳤다.

## D-28. WI-D 설계: 워크아이템 동시성 — state.json 스키마 (0.2.0, MINOR)

- **배경**: `state.json` 의 `criteria` 배열이 워크아이템 경계 없이 flat 하다(D-26 이 실제로 겪은 문제 — WI-A/WI-B 가 같은 완료조건 ID 를 재사용하면서 안 겹치는 이전 항목이 남아 `awl status` 가 잘못된 합계를 보여줌). 지금까지는 매번 사람이 `state.json` 을 손으로 초기화해서 넘어갔다.
- **선택한 설계(부가형 — 기존 소비자 무변경)**: `state.json` 최상위의 `workitem`/`phase`/`loop`/`criteria` 필드는 그대로 두고 "**현재 워크아이템의 실시간 뷰**"라는 의미를 명시적으로 부여한다. 새 최상위 필드 `workitems: Record<WI-ID, {status, createdAt, branch?, criteria}>` 를 레지스트리로 추가한다. `awl work switch/new` 가 "현재 워크아이템을 레지스트리에 보관 → 대상 워크아이템을 최상위로 복원"을 수행한다.
  - **기각한 대안**: `criteria` 를 처음부터 `workitems[id].criteria` 아래로 완전히 옮기는 구조. `status.ts`/`commit.ts`/`review.ts`/`evolve.ts`/`record.ts` 5개 파일이 전부 `state.criteria`/`state.workitem` 을 직접 읽는데, 이 구조를 쓰면 5개 파일 전부를 고쳐야 한다. 부가형은 이 5개 파일을 **한 줄도 안 건드리고** 같은 결과(현재 워크아이템 기준 동작)를 낸다 — "현재 워크아이템이 무엇인지 알아내는 방법"이 바뀌는 게 아니라 "최상위 필드 자체가 항상 현재 워크아이템"이라는 불변식을 `work.ts` 가 유지하는 쪽으로 갔다. 리스크와 diff 크기가 훨씬 작다.
- **`migrateState(raw)` 는 순수 함수, `loadState()` 가 파싱 직후 항상 적용한다(파일에 즉시 다시 쓰지는 않는다 — 다음 `writeState()` 호출 때 자연히 반영).** 레거시 state(`workitems` 필드 없음)를 레지스트리에 편입하고, 이미 새 스키마면 그대로 통과시킨다(멱등). `awl init` 직후처럼 `workitem` 필드 자체가 없는 state 도 크래시 없이 빈 레지스트리로 처리해야 한다.
- **격리 커밋 baseline git ref(`refs/awl/baseline/<AC-ID>`)가 워크아이템으로 네임스페이스돼 있지 않다는 것도 조사에서 발견했다.** 이 ref 는 코드 어디서도 다시 안 읽는다(`git stash create` 가 만드는 dangling 커밋을 `git gc` 로부터 보호하는 용도로 추정 — 진짜 baseline 출처는 `state.criteria[].snapshot` 의 SHA 문자열이다). 서로 다른 워크아이템이 같은 AC-ID(관행상 AC-01, AC-02... 순번이라 흔히 겹친다)를 쓰면 이 ref 가 덮어써져, 보관된 워크아이템 쪽 dangling 커밋이 참조를 잃고 이론상 `git gc` 대상이 될 수 있다 — WI-D 가 만드는 시나리오(한 저장소에 여러 워크아이템 공존)에서 처음 생기는 위험이라 이번에 같이 고친다(`refs/awl/baseline/<workitem>/<AC-ID>`). `startBaseline`/`isolatedCommit` 의 **공개 시그니처는 바꾸지 않는다** — 내부에서 `loadState` 로 현재 워크아이템을 읽어 판단한다. 시그니처를 바꾸면 `commit.test.ts` 의 기존 호출부 다수가 깨진다(조사에서 확인).
- **스파이크는 생략했다**: git ref 경로에 `/` 를 여러 단계 넣는 것(`refs/awl/baseline/WI-D/AC-01`)은 `refs/heads/feature/x/y` 와 동일한 표준 git 동작이라 별도 실증이 불필요하다고 판단했다(WI-C 와 같은 이유로 스파이크를 생략 — 이 판단 자체가 근거).
- **완료 조건 8개**: AC-01(스키마+마이그레이션) → AC-02~05(`awl work list/new/switch/abandon`) → AC-06(baseline ref 네임스페이스) → AC-07(이 프로젝트 자신의 state.json 실제 마이그레이션 + 전체 회귀) → AC-08(CHANGELOG).

## D-29. WI-F 설계: 더러운 워크트리 진입 차단 + `awl work new --worktree` (0.2.2)

- **배경**: 실사고 — 다른 세션의 미커밋 변경 20개 파일이 있는 워크트리에서 루프를 시작했다. 구현/검증은 끝났는데 `awl commit` 이 hunk 충돌로 정당하게 거부했다. 문제는 그다음: 제시된 선택지가 "커밋 없이 계속 진행"뿐이라, 결국 내 변경이 나중에 다른 세션의 커밋에 통째로 묶여 들어갔다 — `awl commit` 이 막으려던 사고가 다른 경로로 그대로 일어났다. 게다가 시작 시점에 이 더러움을 몰랐다(환경이 준 git 상태 요약이 부정확했다).
- **핵심 설계 원칙: 거부만 하고 대안을 안 주면 안전장치는 우회당한다.** 이번 워크아이템은 세 곳에서 이 원칙을 적용한다: (1) 시작 전에 더러움을 미리 알린다(사후 대응이 아니라 사전 예방), (2) 격리가 필요하면 실제로 격리할 수단(`--worktree`)을 준다, (3) `awl commit` 이 거부해도 그 순간에 실행 가능한 대안을 안내한다.
- **AC-01(doctor 워킹트리 체크)**: `git status --porcelain` 을 awl 이 직접 호출한다 — WI-C 의 `gitBranch` 와 같은 이유(환경이 준 요약을 못 믿는다). doctor 는 이미 스킬의 첫 단계("시작 전 `awl doctor` 로 설치를 확인한다")에서 호출되므로, 여기 체크를 추가하면 스킬을 안 고쳐도 자연히 눈에 띈다.
- **AC-02(판단 지침)**: "더러우면 무엇을 할지"는 awl 이 판단하지 않는다 — SKILL.md 에 판단 기준(3가지 선택지)을 명시해 에이전트가 고르게 한다. Claude/Codex 두 문서 모두에 넣는다(WI-E 가 한쪽만 고쳤다가 리뷰에 지적당한 교훈을 처음부터 반영).
- **AC-03(`--worktree`) 스파이크로 실증**: `git worktree add <path> -b <새 브랜치>` 로 격리 디렉토리를 만드는 게 표준 동작임을 실제로 확인했다(같은 브랜치를 두 워크트리에서 동시에 체크아웃할 수 없어 새 브랜치가 필요하다). `WorkitemEntry` 에 `worktreePath` 필드를 추가한다 — WI-D 리뷰가 지적한 "보조 필드가 archive/restore 를 오갈 때 새는" 실수(currentFocus 사고, D-006)를 반복하지 않도록, 왕복 테스트로 직접 보존을 증명한다.
- **AC-04(commit 거부 시 대안) 스파이크로 실증**: `git stash push -u`(untracked 포함) → `git worktree add` → 새 워크트리에서 `git stash pop` 순서로 tracked/untracked 변경 전부가 안전하게 이동함을 실제로 확인했다. patch 추출 방식(diff 저장 후 다른 곳에 apply)보다 git 내장 기능만 쓰는 이 방식이 더 안전하다고 판단했다(patch 추출은 그 자체로 `awl commit` 이 겪는 hunk 분리 문제와 같은 종류의 실패를 겪을 수 있다). `awl commit` 이 hunk 충돌로 거부할 때만 이 안내를 붙인다("커밋할 변경 없음" 등 다른 거부 사유엔 안 붙인다 — 관련 없는 안내로 화면을 채우지 않는다).
- **자율 진행 기록**: 이 워크아이템은 사용자가 "게이트 없이 쭉 진행해달라"고 명시적으로 지시한 뒤(2026-07-14/15, 취침) 진행한다. 게이트 1/2 는 `AskUserQuestion` 호출 없이 이 설계 문서를 근거로 자율 승인 처리한다.
- **완료 — AC-06~09 (2차 리뷰가 잡은 것)**: AC-01~05 리뷰에서 나온 지적 3건(AC-06 orphan worktree 버그, AC-07 한글 파일명 파싱, AC-08 Codex 문서 드리프트)을 고친 뒤 2차 리뷰를 새 서브에이전트로 한 번 더 돌렸다. 2차 리뷰가 AC-06 의 수정에서 또 다른 좁은 레이스(precheck 통과 후 실제 `createGitWorktree` 가 끝나기까지의 구간에 동시 `awl` 프로세스가 state.json 을 바꾸면 orphan 이 다시 남을 수 있음)를 잡아 AC-09 로 편입해 고쳤다(`removeGitWorktree` 로 정리, 실패해도 무음으로 삼키지 않음). 같은 리뷰는 AC-06 의 note 문구("명시적 브랜치명 미sanitize 도 함께 고침")가 실제 커밋 diff 와 어긋난다는 점도 지적했다 — 코드 버그는 아니고 note 가 부정확했던 것이라 note 문구만 정정했다(실험으로 git 이 잘못된 ref 이름을 자체 거부해 기능적 orphan 위험이 없음을 확인). 최종 9/9 완료 조건 통과, 264개 테스트. 게이트 2 도 게이트 1 과 같은 근거로 자율 승인 처리한다.

## D-30. WI-G 설계: `awl verify --since-baseline` — 체크 단위 비교, 서브 테스트 단위 아님 (0.2.3)

- **배경**: 실사고 — e2e 검증이 71/74 였는데, 3건이 "무관한 사전 결함"인지 "내가 만든 회귀"인지 에이전트가 자의적으로 판단해야 했다. 판단은 실수를 낳는다. `--since-baseline` 은 이 판단을 기계적으로 만든다.
- **핵심 설계 제약(중요, AC-04): 이 기능은 체크(typecheck/lint/test/e2e) 단위로만 baseline 을 비교한다. e2e 안의 개별 서브 테스트(74개 케이스) 단위까지는 비교하지 않는다.** `runVerifyChecks` 는 `config.json` 의 `verify.<name>.cmd` 를 완전히 불투명한 셸 명령으로 실행하고 exitCode 로만 pass/fail 을 판정한다(WI-2 부터의 설계 — 특정 언어/러너에 종속되지 않기 위해서). 서브 테스트 단위 비교를 하려면 vitest/jest/playwright/pytest 등 러너마다 다른 출력 형식을 파싱해야 하는데, 이건 "검증 명령을 불투명하게 다룬다"는 이 프로젝트의 핵심 설계와 정면으로 충돌하고 크로스 언어 목표와도 안 맞는다. **기각한 대안**: 출력에서 실패 라인을 정규식으로 긁어모으는 휴리스틱 — 러너마다 형식이 달라 신뢰할 수 없는 "거짓 확신"을 줄 위험이 더 크다고 판단해 기각했다.
  - 이 제약의 실질적 함의: `verify.e2e.cmd` 하나에 서로 다른 성격의 테스트(예: 안정된 케이스 + 알려진 flaky 케이스)가 섞여 있으면, `--since-baseline` 은 "e2e 전체가 여전히 실패"로만 보고 그 안에서 무엇이 바뀌었는지는 못 알려준다. 더 정밀한 판정이 필요하면 **config 저자가** `verify.e2e-stable`/`verify.e2e-known-flaky` 처럼 검증 항목을 더 잘게 나눠야 한다 — 이건 awl 이 판단할 일이 아니라 프로젝트가 정할 일이다.
- **baseline 저장 위치**: `.awl/verify-baseline.json` (state.json 과 별도 파일, gitignore 대상). `state.json` 에 합치지 않은 이유: baseline 은 "이 워크아이템을 시작한 시점의 검증 상태"로 워크아이템에 종속된 개념인데, `state.json` 에 넣으면 WI-D 의 `workitems` 레지스트리 스냅샷/복원 로직(`archiveCurrent`/`restoreWorkitem`)에 또 다른 필드를 추가해야 하는 부담이 생긴다(D-006 이 지적한 "보조 필드가 archive/restore 를 오가며 새는" 실수의 재발 위험). 별도 파일로 두면 `awl work new` 때마다 자연히 새로 쓰여서 이 복잡도를 피한다.
- **캡처 시점**: `awl work new` — 워크아이템 시작 시점 1회. `awl commit --start` 마다는 안 한다(완료 조건마다 전체 verify 를 다시 도는 건 느리고,애초에 "이 워크아이템 전체의 사전 결함"이라는 개념과도 안 맞는다). 느린 프로젝트를 위해 `--skip-baseline` 으로 건너뛸 수 있다 — 건너뛰면 그 자리에서 "나중에 --since-baseline 을 못 쓴다"고 알린다.
- **--worktree 와의 상호작용(AC-01)**: `--worktree` 를 쓰면 베이스라인은 원래 루트가 아니라 새로 만든 워크트리 기준(`verifyRoot = worktreePath ?? root`)으로 캡처한다. 원래 루트에 캡처하면 gitignore 대상이라 새 워크트리 체크아웃에 안 따라오기 때문이다. `config.json` 은 git-tracked 라 워크트리 체크아웃에 실제로 따라온다(테스트로 확인, AC-08).
- **완료 — 1차 리뷰가 실질적 결함 1건 발견(AC-06)**: `.awl/verify-baseline.json` 이 프로젝트 루트 단일 파일이라 `work switch`/`work abandon` 이 이 파일을 안 건드리면, 워크아이템을 전환했을 때 이전 워크아이템의 낡은 베이스라인이 그대로 남아 무음으로 잘못 비교될 수 있었다 — D-28 이 고쳤던 것(unnamespaced 자원이 워크아이템 전환 시 새는 문제)과 같은 클래스의 버그가 재발한 것. 고친 방법: `VerifyBaseline` 에 캡처 당시 `workitem` 을 태그하고, `resolveSinceBaseline` 이 `baseline.workitem !== 현재workitem` 이면 베이스라인 없음과 똑같이 안전하게 폴백한다(`work switch`/`abandon` 자체는 손대지 않음 — 최소 변경). 같은 라운드에서 `--json --since-baseline` 폴백이 무신호였던 문제(스킬이 폴백 여부를 구분 못함)도 `sinceBaseline:{available,reason}` 을 JSON 출력에 명시하는 것으로 함께 고쳤다.
- **2차 리뷰는 지적 없음(사소함/커버리지 공백만)** — workitem 태그 비교의 null/null 케이스(도달 불가능한 방어적 코드), 대소문자 처리(실사용 흐름상 항상 원래 케이스가 보존돼 오탐 없음, 코드 추적으로 확인), 진짜 레거시 파일(workitem 필드 없음) 하위호환은 전부 실제로 안전했고, 회귀 방지 테스트만 추가로 보강했다(AC-10). 최종 10/10 완료 조건, 286개 테스트. 게이트 1/2 모두 WI-F 와 같은 자율 진행 근거(D-29 참고)로 자율 승인한다.

## D-31. WI-H 결정: review 자료 충분성 — 스킬 지시로 해결, 번들 조립은 안 바꾼다 (0.2.4)

- **선행 수정(AC-01)**: 착수 전 D-26/D-28 이 지적했던 review baseline 오판정 버그를 먼저 고쳤다. 완료조건의 `baseline` 필드가 "다음 격리 커밋의 diff 기준점"(격리 커밋이 닫힐 때마다 그 AC 자신의 최종 커밋으로 갱신됨)과 "review 범위의 시작점"(AC 가 처음 시작된 시점으로 고정돼야 함)이라는 서로 다른 수명의 두 목적을 겸용한 게 근본 원인이었다. `firstBaseline` 필드를 새로 추가해(AC 가 처음 `--start` 될 때만 기록, 이후 절대 안 덮어씀) 분리했다. `setCriterion` 이 얕은 병합이라 closing 패치에 안 넣으면 자동 보존된다.
- **실측 방법**: 같은 diff(WI-G AC-01..10, 5파일 663줄)를 세 변형(a: diff+전체파일 임베딩, b: diff -U20 컨텍스트 확대, c: 기본 diff + "판단 안 서면 직접 읽으라"는 명시적 프롬프트 지시)으로 만들어, 신선한 서브에이전트 3개에 동일한 리뷰 과제로 병렬 실행했다. 각자 발견/확신도/추가 파일 접근 여부를 자기보고하게 했다.
- **핵심 발견: 데이터 가용성보다 "적극적으로 검증해도 된다"는 명시적 허가가 더 중요했다.** (a)와 (c)는 사실상 같은 파일 내용(verify.ts/work.ts/program.ts 전체)에 접근 가능했는데, (c)만 교차 파일 행동 버그(아래 AC-04)를 찾았다 — (a)는 파일이 이미 주어졌는데도 그 파일들 사이의 상호작용을 능동적으로 추적하지 않았다. (c)는 또한 (a)/(b) 둘 다 낸 잘못된 긍정오류(AC-04 문서화 diff 부재를 결함으로 오판)를 실제로 `docs/decisions.md` 를 열어 확인함으로써 피했다.
- **비용**: (b) 52.4k 토큰(최저, confidence 3/5 최저) < (a) 69.7k 토큰(confidence 4/5) < (c) 100.9k 토큰(confidence 4/5, 가장 실질적인 버그 발견). (c) 가 (a) 의 약 1.4배 비싸지만, awl 이 diff 를 조립하는 것 이상(전체 파일 임베딩, 컨텍스트 폭 조정)을 구현할 필요가 없다 — 스킬 프롬프트에 한 문장 추가하는 구현 비용은 0에 가깝다.
- **결정**: `review.ts` 의 번들 조립 로직(diff 컨텍스트 폭, 파일 임베딙)은 그대로 둔다. `awl-loop` 스킬(Claude/Codex 둘 다)의 리뷰어 절에 "diff 컨텍스트만으로 판단이 안 서면 주저하지 말고 프로젝트 파일을 직접 읽으라"는 지시를 추가한다(AC-02). **기각한 대안**: (a) 전체 파일 자동 임베딩 — 구현 비용(git show 로 각 변경 파일의 최신 내용을 가져와야 함)이 있고, 실측 결과 데이터가 있어도 능동적 검증을 안 하면 소용없었다. (b) 컨텍스트 폭 확대 — 가장 저렴하지만 가장 얕았다(confidence 최저).
- **부수 성과**: 이 스파이크 자체가 실제 결함 3건을 찾았다(AC-03: `writeVerifyBaseline` 이 try/catch 없이 실패하면 `awl work new` 전체가 크래시함. AC-04: `--since-baseline` 의 workitem_mismatch 폴백 메시지가 실행하면 항상 실패하는 조치를 안내함 — `createWorkitem` 은 이미 존재하는 ID 를 항상 거부하는데 메시지는 "다시 `awl work new`" 를 권함. AC-05: 체크 pass/fail 판정 로직이 `verify.ts`/`work.ts` 에 4곳 중복 구현됨). 이 발견 자체가 "적극적 검증이 실제 결함을 잡는다"는 결정의 근거를 강화한다.
- **2차 리뷰가 잡은 운영 사고(코드 결함 아님)**: `dist/cli.js` 를 AC-01(firstBaseline 수정) 이후 재빌드하지 않은 채 AC-02~05 를 전부 `node dist/cli.js` 로 진행해, `.awl/state.json` 에 `firstBaseline` 이 한 번도 실제로 기록되지 않았다 — AC-01 이 고치려던 바로 그 버그가 review 번들 조립에서 재현됐다(리뷰어가 `state.json`/`git diff` 를 직접 대조해 발견). 소스 코드 자체는 1차 리뷰에서 이미 정확함이 검증됐고, 유닛 테스트(vitest, TS 소스를 직접 실행)는 항상 정상 통과했다 — 실제 CLI 명령만 낡은 빌드로 실행된 것. 즉시 재빌드하고 `npm run dev`(tsup --watch)를 백그라운드로 띄워 재발을 막았고, git 커밋 체인으로 각 완료조건의 진짜 `firstBaseline` 값을 역산해 `state.json` 을 소급 복구했다. 재검증 결과 review 번들이 AC-01 자신의 변경 파일(`commit.ts`/`review.ts`)까지 정확히 포함함을 확인했다.

## D-32. WI-I 설계: 엔지니어링 상식 내장 — 대원칙에 따른 4갈래 분류 (0.2.5)

- **원문 스펙 재해석**: "기본값은 템플릿(`engine/templates/`)으로"는 별도의 6번째 기능이 아니라 대원칙 자체의 일부다 — 강제 가능한 것=검사기(doctor/verify), 판단이 필요한 것=리뷰어(SKILL.md), 프로젝트 사실=config(config.json), 그리고 그 세 가지 중 "기본값이 필요한 지점"에서만 템플릿(`engine/templates/`, `~/.awl/templates/` 로 오버라이드)을 쓴다. 따라서 실질 기능은 4갈래(I-1 네이밍/I-2 복잡도/I-3 구조판정/I-4 관련테스트, I-5 성능 alternatives)이고, 템플릿은 그중 I-4(`relatedCmd` 설정 예시)에서 구체화한다.
- **I-1 네이밍 컨벤션(config에 감지·기록)**: `awl doctor` 가 `src/` 아래 파일명 패턴(kebab-case/camelCase/snake_case/PascalCase)을 세어 뚜렷한 다수(예: 80% 이상)가 있으면 `config.json` 에 `namingConvention` 필드로 기록한다(정보성, 강제 아님). 다수가 없으면(혼재) "혼재"로만 보고하고 강제로 하나를 고르지 않는다. **lint 중복 금지**: 이미 존재하는 이름을 검사/거부하지 않는다 — 그건 biome/eslint 의 몫이다. awl 은 "이 프로젝트의 관행이 무엇인가"라는 사실만 센다.
- **I-2 복잡도(warn only, 임계값은 실제 분포에서 도출)**: 크로스 언어 목표상 AST 기반 순환복잡도는 기각 — 파싱이 언어마다 다르고 특정 러너에 종속된다(D-30 과 같은 이유). 대신 **파일당 줄 수**를 언어에 안 종속되는 프록시로 쓴다. 임계값은 하드코딩하지 않고 실행 시점에 그 프로젝트의 실제 파일 크기 분포에서 계산한다. **최초엔 90th percentile 인덱스 방식으로 설계했으나, 최댓값 자신이 그 인덱스 값이 돼버려 "임계값보다 큰 파일" 조건을 절대 못 만족하는 구조적 결함을 테스트로 발견해 IQR(Q3 + 1.5×IQR, Tukey's fences)로 교체했다** — 통계학의 표준 이상치 판정법이라 균일한 분포에선 자연히 outlier 가 0 이 되고, 진짜 이상치만 잡는다. 프로젝트가 커지면 임계값도 자동으로 따라간다. 절대 실패시키지 않는다(warn 만) — 코드 복잡도는 사람의 판단 없이 기계가 "나쁘다"고 확정할 수 없다.
- **I-3 재사용-추상화(리뷰어 임무, 숫자로 강제 금지)**: SKILL.md/AGENTS.awl.md 의 리뷰어 절에 A(부정행위 탐지)/B(품질 판정)에 이어 **C. 구조 판정**을 신설한다 — 불필요한 추상화, 기존 패턴과의 일관성, 재사용 가능한 로직의 중복을 코드 근거로 지목하되, 숫자 임계값(예: "함수가 30줄 넘으면 안 됨")으로 환원하지 않는다. 판단이 필요한 영역이라 검사기가 아니라 리뷰어의 몫이다.
- **I-4 관련 테스트만 실행**: `awl verify --related` — 변경된 파일 목록(git diff)을 `config.json` 의 새 `relatedCmd` 템플릿 문자열(예: `"vitest related {files}"`, `{files}` 는 변경 파일 목록으로 치환)에 대입해 실행한다. `relatedCmd` 가 없으면 **폴백**: 전체 테스트를 그대로 돌리고 "관련 테스트만 실행하려면 relatedCmd 를 설정하세요"라고 안내한다(무음 스킵 금지 — 아무것도 안 돌리는 것보다 전체를 도는 게 안전). `engine/templates/related-cmd-examples.md` 에 vitest/jest/pytest 등 흔한 러너별 `relatedCmd` 예시를 담아 `~/.awl/templates/` 로 개인화 오버라이드 가능하게 한다 — 이게 "기본값은 템플릿으로"의 구체적 사례다.
- **I-5 성능 재검토(design record 에 alternatives 필수)**: `awl record decision` 에 선택적 `performanceSensitive: boolean` 필드를 추가한다. `true` 면 `alternatives`(비어있지 않은 배열)가 필수가 되고 비어있으면 거부한다. `false`/미지정이면 기존과 동일(하위호환, 기존 decision 기록 전부 그대로 유효).
- **대원칙 확인**: 다섯 갈래 전부 `rules/active/` 에는 아무것도 안 넣는다 — `RULE_LOAD_LIMIT=15`(rules.ts) 를 잡아먹지 않도록, 기계적으로 셀 수 있는 건 검사기/config로, 판단이 필요한 건 리뷰어 임무 문서로 흡수한다.
- **리뷰가 실질적 결함 1건 발견(AC-07)**: `substituteRelatedCmd` 가 변경 파일 경로를 공백으로만 join 했는데, `run()` 은 `shell:false` + `tokenize()` 로 실행되고 `tokenize` 는 따옴표 없는 공백을 그대로 토큰 분리한다 — 경로에 공백이 있으면 `relatedCmd` 가 조용히 잘못된 인자를 받는 문제였다(셸 인젝션은 아님, 인자 분리만 깨짐). 각 경로를 큰따옴표로 감싸 고쳤다(`tokenize` 가 이미 따옴표 문자열을 한 토큰으로 파싱함). 그 외 지적(AC-06: 주석이 옛 90th percentile 방식을 언급 — 위 I-2 설명과 함께 정정)은 사소함. 부정행위 없음. 최종 7/7 완료 조건, 326개 테스트. 게이트 1/2 는 이전 워크아이템들과 같은 자율 진행 근거(D-29 참고)로 자율 승인한다.
- **0.2.x 로드맵 완료**: 이로써 WI-F(0.2.2)~WI-I(0.2.5) 가 전부 끝났다. 다음은 0.3.x(WI-O: delta→gotcha 개명+마이그레이션, WI-P: 계측/metrics) — 사용자가 로드맵 전체를 끝까지 진행하라고 명시적으로 지시했으므로 이어서 착수한다. 다만 릴리스(`release:patch`/`minor`, `npm publish`, `git push`)는 이 세션 내내 지켜온 규칙대로 사용자 확인 없이 하지 않는다.

## D-33. WI-O 설계: `delta` → `gotcha` 전면 개명 + 마이그레이션 (0.3.0)

- **범위 확정**: 코드에서 delta/Delta 를 참조하는 파일 9개 — `src/core/paths.ts`(`deltasDir`), `src/commands/evolve.ts`(`Delta` 타입/`loadDeltaList`/`writeDelta`/`nextDeltaId`/`recordDelta`/`RecordDeltaInput`/`RecordDeltaResult`/`existingDeltas`), `src/commands/deltas.ts`(전체, `gotchas.ts` 로 파일명도 바꿈), `src/commands/rules.ts`(`Delta` 타입/`deltaId` 파라미터), `src/commands/init.ts`(`scaffoldGlobal` 의 디렉토리 목록), `src/program.ts`(`promote <deltaId>`, `deltas` 명령), `tests/core/paths.test.ts`, `tests/commands/rules.test.ts`, `tests/commands/evolve.test.ts`, 스킬 문서 둘 다.
- **번호 체계 혼동 주의**: `docs/decisions.md` 의 `D-1`~`D-32` 는 완전히 다른 번호 체계(설계 결정 문서, 패딩 없음)라 이번 개명과 무관하다. `evolve` 의 `Delta` 는 `D-001` 처럼 3자리 0패딩이라 정규식(`/^D-\d{3}$/`)으로 구분 가능 — 혼동해서 건드리지 않는다.
- **실제 데이터 규모**: 원문 스펙은 "5건"이라 가정했지만 실제로 `~/.awl/deltas/` 에 15개(D-001~D-015, 이 세션에서 쌓임) 있다. 마이그레이션은 실제 개수를 세어서 처리해야지 하드코딩하면 안 된다.
- **records 로그는 안 건드림**: `~/.awl/records/*.jsonl`(attempt/review 등)에 "D-006" 같은 언급이 자유 텍스트로 남아있지만, `record.ts` 자체가 "기록은 append only. 수정/삭제하지 않는다"는 원칙을 명시한다(회고적 사실이라 그 시점엔 정확했다). 마이그레이션 대상은 `~/.awl/deltas/*.json` 파일 자체의 구조화된 `id`/`sameAs`/`history` 필드뿐이다.
- **마이그레이션 방식**: `state.ts` 의 `migrateState()`(레거시 스키마를 자동으로, 무손실·멱등적으로 최신에 맞춤)와 같은 패턴을 그대로 따른다 — `~/.awl/gotchas/` 가 없고 `~/.awl/deltas/` 만 있으면, 로드 시점에 자동으로(1) `~/.awl/deltas.backup-<타임스탬프>/` 로 백업 (2) 각 `D-0XX.json` 을 읽어 `id`/`sameAs` 필드의 `D-`를 `G-`로 바꾸고 `G-0XX.json` 으로 `~/.awl/gotchas/` 에 쓴다 (3) 원본 `~/.awl/deltas/` 는 그대로 둔다(삭제 안 함 — 백업과 별개로 원본도 보존, 완전히 무손실). 이미 `~/.awl/gotchas/` 가 있으면(이미 마이그레이션됨) 아무것도 안 한다(멱등).
- **하위 호환**: `awl deltas` 명령은 0.4.0 까지 유지하되, 실행 시 "`awl gotchas` 를 대신 쓰세요" 경고를 출력하고 동일한 로직(이제는 gotchas 를 읽음)으로 동작한다.
- **한국어 표기**: "gotcha" 는 외래어로 번역하지 않고 그대로 쓴다(예: "기존 gotcha(existingGotchas)와 같으면").
- **완료 — AC-05 에서 실제 결함 1건 발견**: 실제 `~/.awl/deltas/` 15개를 마이그레이션해 검증하다가 `awl gotchas --json` 이 빈 배열을 내는 버그를 발견했다. `gotchas.ts`(옛 `deltas.ts`)가 자체적으로 `fs.readdirSync` 를 부르는 별도 파일 읽기 로직을 그대로 남겨둬, `evolve.ts` 의 `migrateDeltasToGotchas` 트리거를 가진 `loadGotchaList()` 를 안 거쳤다 — AC-01(리네임) 때 이 중복을 놓쳤다. `gotchas.ts` 가 `loadGotchaList` 를 그대로 재사용하도록 고쳐 중복 자체를 없앴다(회귀 방지 테스트 신설). 재빌드 관련 사고도 하나 더 있었다: `npm run dev`(tsup --watch) 를 세션 내내 띄워뒀는데도 `git mv` 직후의 편집 하나를 워치가 놓쳐 `dist/cli.js` 가 낡은 채로 남았다 — mtime 비교로 발견, 수동 `npm run build` 로 해결. 15/15 내용 무손실을 python 스크립트로 대조 확인.
- **2차 리뷰가 사소한 결함 2건 발견**: `program.ts` 의 `evolve --record` 옵션 도움말 문구가 여전히 "deltas" 를 언급(AC-01 grep 스코프에서 놓침) — 정정. `README.md` 가 AC-04 스코프(스킬 문서만) 밖이라 여전히 `awl deltas`/"교훈(delta)" 를 대표 예시로 소개하고 있어, 실사용자가 폐기 예정 별칭을 정식 명령으로 오인할 위험이 있었다 — 정정. 그 외(번호 체계 혼동, 마이그레이션 완전성, 별칭 동작, git rename 미탐지, 테스트 품질)는 전부 지적 없음. 최종 7/7 완료 조건, 338개 테스트. 게이트 1/2 는 이전 워크아이템들과 같은 자율 진행 근거(D-29 참고)로 자율 승인한다.

## D-34. `record.ts` 워크아이템 자동 태깅 — WI-P 착수 전 선행 수정

- **발견 경위**: WI-O 를 닫으며 `awl evolve --collect --workitem WI-O` 로 이번 워크아이템의 기록을 모았더니 `reviews`/`blocked` 가 실제로는 12건/여러 건 있었는데도 빈 배열로 나왔다. 원인은 `readRecords({ workitem })` 이 `r.workitem === filter.workitem` 으로 정확히 거르는데, 정작 `runRecord`(record.ts) 가 `record.workitem` 을 채우는 코드 자체가 없었다는 것 — 스킬이 `--json` 데이터에 `"workitem": "WI-x"` 를 직접 적어 넣어야만 태깅됐고, SKILL.md 의 실제 예시들(`record criteria`/`record attempt`/`record blocked`/`record audit` 등)은 전부 그 필드를 안 적는다. 결과적으로 이 세션 내내 쌓인 기록 대부분이 워크아이템 태그 없이 저장됐다(과거분은 append-only 원칙상 소급 수정하지 않는다 — D-33 참고).
- **왜 지금 고치나**: WI-P(계측/metrics)의 P-1(`gotcha-applied`/`gotcha-missed`/`narrative` 기록, 워크아이템별 auto-metrics)이 정확히 이 워크아이템 태그에 의존한다. 태그가 새는 채로 WI-P 를 시작하면 계측 기능 자체가 처음부터 조용히 틀린 숫자를 낸다 — 그래서 WI-P 의 완료조건이 아니라 그 이전 선행 수정으로 분리했다.
- **고친 내용**: `project` 필드와 같은 패턴으로, `buildRecord` 가 `data.workitem` 이 없으면 `defaults.workitem` 을 쓰게 하고, `runRecord` 가 `resolveProjectRoot()` 로 찾은 프로젝트의 `state.json` 을 읽어 현재 `state.workitem` 을 `defaults.workitem` 으로 주입한다. `project` 와 달리 **필수로 강제하지는 않는다** — `work new` 이전 시점(아직 워크아이템이 없는 조사 등)의 기록도 유효해야 하기 때문이다. 워크아이템이 전혀 없으면 필드 자체를 안 만든다(안 쓰는 필드 금지, D-21 과 같은 원칙).
- **G-006 3회째 반복**: 이 버그의 근본 패턴 — "여러 호출부가 채워야 하는 보조 필드를 각자에게 맡기면 조용히 샌다" — 은 WI-D/WI-G 에서 이미 두 번 나온 G-006 과 본질적으로 같다. `sameAs: G-006` 으로 묶었다(3회째 반복 — 규칙 승격은 사람이 판단할 몫이라 자동 승격하지 않았고, 여기 기록해 사용자에게 전달한다).
- **범위**: `src/commands/record.ts` 만 수정(`RecordDefaults.workitem` 추가, `buildRecord`/`runRecord`). WI-O/WI-P 완료조건 목록 어디에도 속하지 않는 독립 수정이라 `awl commit` (AC 단위 격리 커밋)이 아니라 일반 git 커밋으로 남긴다.

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
