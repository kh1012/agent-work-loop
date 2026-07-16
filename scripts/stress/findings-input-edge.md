# stress-input-edge 발견 (관측 결과)

`tests/commands/input-edge.stress.test.ts` (vitest, 8 케이스) 관측. 발굴만.

## 요약: 이슈 0건 — 해당 입력까지 견고 ✅
| 대상 | 입력 | 결과 |
|---|---|---|
| buildRecord | 필수 누락·null·빈문자열 | ✅ 크래시 없이 `missing` 으로 거부 |
| buildRecord | 배열 필드에 문자열 | ✅ 거부(우회 없음) |
| buildRecord | 거대 payload 1MB | ✅ 크래시 없이 빌드 |
| buildRecord | 깊은 중첩 500단 | ✅ 크래시 없음 |
| buildRecord | criteria 에 BANNED "저위험" | ✅ 거부(질적표현 우회 없음) |
| runStateSet | 깨진 JSON `{"a":` | ✅ exit:1 안전 거부 |
| runStateSet | 비객체(배열·숫자) | ✅ exit:1 거부 |
| runStateSet | 거대 유효 JSON 1MB | ✅ 크래시 없이 적용 |

관측 결론: `buildRecord`(스키마 required/arrays·BANNED)·`runStateSet`(JSON 파싱·비객체 거부)의 입력 검증이 이 입력들까지 크래시·조용한 손상·검증 우회 없이 견고하다.

## 후속(범위 밖)
- **sanitizeRefComponent(commit.ts:107)·sanitizeForGit(work.ts:423) 는 private** 라 직접 테스트 못 함 — export 하거나 공개 경로(work new --worktree with `../` id)로 `..` 탈출·ref 위반을 검증하는 것은 후속 plan 일감. F-02 의 sanitize 경계는 이번에 간접(미검증)으로 남김.
- 더 극단(payload 100MB·중첩 10,000단): 상수 상향으로 확장.
