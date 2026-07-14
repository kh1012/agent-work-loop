# relatedCmd 설정 예시

`awl verify --related` 는 `config.json` 의 `relatedCmd` 를 실행합니다. `{files}` 는
변경된 파일 목록(공백 구분)으로 치환됩니다. `relatedCmd` 가 없으면 `awl verify --related`
는 조용히 건너뛰지 않고 전체 `test` 체크로 폴백합니다.

이 파일은 기본값(default) 예시입니다. 개인화하려면 `~/.awl/templates/related-cmd-examples.md`
에 같은 이름으로 파일을 두면 이 기본값 대신 그 파일이 쓰입니다.

## vitest

```
"relatedCmd": "vitest related {files} --run"
```

## jest

```
"relatedCmd": "jest --findRelatedTests {files}"
```

## pytest (pytest-testmon 사용)

```
"relatedCmd": "pytest --testmon {files}"
```

## go test

go 는 파일 단위가 아니라 패키지 단위로 테스트를 돌립니다 — `{files}` 를 그대로 쓰면
안 맞을 수 있으니, 셸 스크립트로 패키지 경로를 뽑아내는 걸 권장합니다.

```
"relatedCmd": "scripts/related-go-test.sh {files}"
```

설정하기: `awl config set relatedCmd "vitest related {files} --run"`
