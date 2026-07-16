# stress-commit-isolation 발견 (관측 결과)

`tests/commands/commit-isolation.stress.test.ts` (vitest, 4 케이스) 관측. 발굴만 — 수정은 후속.

## 요약: 이슈 0건 — 해당 극한까지 격리 정확 ✅
| 케이스 | 규모 | 결과 |
|---|---|---|
| 대량 사전 untracked 보존 | 500개(.awl-worktrees/ 10 포함) | ✅ 내 tracked 1개만 커밋, 남의 500개 워킹트리 보존, `.awl-worktrees/` 필터됨 |
| 비ASCII 경로 격리 | 한글·이모지·제어·공백 파일명 | ✅ `-z` 기반이라 원본 그대로 매칭, 전부 정확 포함 |
| 큰 diff | 5,000줄 추가 | ✅ 격리 커밋 성공 |
| 인접 hunk 충돌 | 60쌍 남/나 교차 | ✅ 안전 분리 불가 → 커밋 거부 + 워킹트리 보존 |

관측 결론: `isolatedCommit` 의 격리(내 변경만 커밋·남의 미커밋 보존·hunk 충돌 시 거부·비ASCII 정확)가 이 규모까지 정확하다. **누출·누락·손상 0건.**

## 검증 중 확인한 사실(수정 아님)
- **untrackedAtStart 스레딩이 격리의 핵심**: `isolatedCommit` 에 `startBaseline` 의 `untracked`(untrackedAtStart)를 안 넘기면 사전 untracked(남의 것)를 "내 새 파일"로 오판해 커밋한다. `runCommit`(`commit.ts`)은 `crit.untrackedAtStart` 를 그대로 넘겨 정상 — 이 계약을 어기는 새 호출부가 생기면 격리가 깨지므로, 호출 규약으로 주의. (테스트 작성 중 이 스레딩을 빠뜨려 재현했고, 실제 flow 는 정상임을 확인.)

## 후속(범위 밖)
- 더 큰 규모(untracked 만·hunk 수백·diff 수만 줄): 상수(UNTRACKED/DIFF_LINES/HUNK_PAIRS) 상향으로 확장 가능. 스위트 속도 vs 깊이 트레이드오프.
- hunk 분리 알고리즘 개선(인접 충돌을 더 잘게 분리): 이 일감은 발굴만, 개선은 후속.
