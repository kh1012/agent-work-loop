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
