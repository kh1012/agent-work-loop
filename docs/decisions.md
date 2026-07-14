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
- **한계(의식적으로 남김)**: `shell: false`이므로 Windows에서 npm으로 설치된 도구(`eslint`, `vitest` 등이 `.cmd` 래퍼로 깔림)를 이름만으로 `spawn`하면 실패할 수 있다. 이 워크아이템은 macOS에서만 검증하므로, 이 문제는 아래 Windows 리스크 목록에 체크리스트로 남긴다. 대신 ENOENT를 `CommandNotFoundError`로 구분해, 나중에 "명령을 찾을 수 없습니다" 안내와 `.cmd` 힌트를 붙일 자리를 마련했다.

## D-9. 한글 폭 계산은 의존성 없이 직접 구현한다

- **결정**: 표시 폭 계산(`stringWidth`)을 `string-width` 같은 라이브러리 없이 CJK East Asian Width 범위를 직접 판정해 구현한다.
- **근거**: 이모지를 쓰지 않기로 했으므로 복잡한 이모지/결합문자 처리가 필요 없다. 다루는 문자는 사실상 ASCII + 한글/CJK뿐이라, 주요 wide 범위만 판정하면 결정적이고 테스트 가능하다. 의존성을 늘리지 않는다.
- **대안**: `string-width`(정확하지만 이모지·grapheme 처리로 의존성 트리가 커짐). 우리 용도에는 과하다.

---

# Windows 리스크 목록 (macOS에서만 검증함 — Windows 검증 시 체크리스트로 사용)

이 프로젝트는 현재 macOS에서만 검증한다. 아래는 Windows에서 깨질 수 있는 지점과 대비다. 나중에 Windows에서 사람이 검증할 때 이 목록을 하나씩 확인한다.

1. **경로 구분자 (`/` vs `\`)**
   - 왜 위험: 문자열로 경로를 조합하면 Windows에서 `\`가 아닌 `/`가 섞여 깨지거나, 반대로 하드코딩된 `\`가 POSIX에서 깨진다.
   - 대비: `paths.ts`는 조합을 전부 `path.join`으로 한다. 문자열 연결(`+ "/" +`)을 쓰지 않는다. 테스트에 `path.win32.join`/`path.posix.join` 대조 단언을 넣어 문서화했다.
   - 확인법: Windows에서 `AWL_HOME`을 임시 폴더로 두고 각 경로 함수 출력이 `\` 구분자로 나오는지, `findProjectRoot`가 상위로 올라가며 찾는지.

2. **`.cmd`/`.bat` 래퍼 실행**
   - 왜 위험: npm 전역/로컬로 설치된 CLI(`eslint`, `vitest`, `tsc` 등)는 Windows에서 `foo.cmd` 래퍼로 설치된다. `shell: false`인 `spawn('foo', ...)`는 확장자 없는 이름을 못 찾아 ENOENT(또는 EINVAL)로 실패한다.
   - 대비: 지금은 ENOENT를 `CommandNotFoundError`로 구분만 해 둔다. Windows에서 이 에러가 자주 나면, (a) config에서 `cmd`에 `.cmd` 확장자를 명시하거나 `node_modules/.bin` 절대경로를 쓰거나, (b) `cross-spawn` 도입(별도 워크아이템)으로 해결한다.
   - 확인법: Windows에서 `run({ cmd: 'vitest', args: ['run'] })`가 ENOENT인지, `run({ cmd: 'vitest.cmd', ... })`나 `.bin` 절대경로면 되는지.

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
