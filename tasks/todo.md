# WI-1. 저장소 골격과 이름 확보

publish 파이프라인이 실제로 도는지, 코드가 쌓이기 전에 확인한다.

## 계획

- [x] 사전 조사: 이름 확보 확인 (agent-work-loop 사용 가능, awl 선점됨)
- [x] `package.json` (name=agent-work-loop, bin.awl, files=[dist,engine], type=module, node>=18, MIT)
- [x] tsconfig (ESM, strict)
- [x] 빌드 도구 (tsup) — dist/cli.js + shebang
- [x] lint/format (biome)
- [x] 테스트 (vitest)
- [x] `src/cli.ts` — `--version`, `--help`만 동작. help에 배너, 스킬 명령은 숨김
- [x] `engine/version.json`
- [x] `.gitignore`
- [x] `README.md` 초안 (3문단)
- [x] `docs/decisions.md` — 인자 파서/빌드/lint 선택 근거

## 검증

- [x] `node dist/cli.js --version` → `0.0.0` 출력
- [x] `node dist/cli.js --help` → 배너 + Usage/Options 출력 (스킬 명령 숨김)
- [x] `npm pack` → dist, engine, README, package.json, LICENSE만 포함 (src/tasks/docs 제외)
- [x] `npm publish --dry-run` 통과 (exit 0, 403 없음)

## 리뷰

**결과: WI-1 완료. 배포 파이프라인이 실제로 돈다.**

- 이름 확보: `agent-work-loop`는 npm 미사용(404), `awl`은 선점됨(0.0.2). 명세대로 패키지명=`agent-work-loop`, bin=`awl`로 분리.
- 스택 선택: 인자 파서 commander, 빌드 tsup, lint/format biome, 테스트 vitest. 근거는 `docs/decisions.md`.
- 빌드 산출물: `dist/cli.js` (941 B, ESM). shebang `#!/usr/bin/env node` 보존, 실행권한 `-rwxr-xr-x`. commander는 런타임 의존성이라 external.
- `--help`는 배너 + 사람용 옵션(`-v/--version`, `-h/--help`)만 노출. 스킬 명령(verify/record/state/evolve)은 아직 없고, 추가 시 `{ hidden: true }`로 숨길 자리 마련.
- 검증 실행 로그: typecheck OK / vitest 4 tests pass / publish --dry-run exit 0.

**막힌 곳 / 처리한 이슈**
- npm publish 경고 `bin[awl] script name was cleaned`: bin 값의 `./` 접두사(`./dist/cli.js`)가 원인. `dist/cli.js`로 정규화하니 경고 사라짐.
- biome 포맷 vs `npm pkg fix` 포맷 충돌(배열 한 줄 vs 여러 줄): biome를 포맷 기준으로 채택. 이후 `npm pkg fix`는 재실행하지 않는다.
- 취약점 5건(npm audit)은 devDependencies 계열이며 WI-1 범위 밖. 별도로 다룬다.
