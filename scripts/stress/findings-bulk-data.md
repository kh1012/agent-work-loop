# stress-bulk-data 발견 (관측 결과)

`node scripts/stress/bulk-data.mjs 30000 300 3000` (records 3만·criteria 300·.awl-worktrees untracked 3천) 관측. 발굴만.

## 요약: 이슈 0건 — 해당 규모까지 견고 ✅
| 관측 | 수치 | 판정 |
|---|---|---|
| status | ~86ms | ✅ 빠름(30k records + 300 criteria) |
| status --json | ~86ms | ✅ |
| evolve --collect | ~80ms | ✅ readRecords 3만 전량 로드에도 빠름 |
| doctor | ~101ms | ✅ |
| commit --start | ~109ms | ✅ |
| **F-1 방어**: commit --start 후 state.json 증가 | **0KB** (untracked 3천 in .awl-worktrees/) | ✅ listUntracked 필터 유효 — 미스냅샷 |
| doctor state.json 크기 warn | 69KB(<1MB) → warn 없음 | ✅ 오탐 없음(임계 정상) |

- 픽스처: state.json 69KB(criteria 300), records 파일 3.4MB(3만 줄).
- 성능: 모든 명령 <110ms. 전량 로드(readRecords·loadState)가 이 규모에서 지연/OOM 없음.
- **F-1 방어 유효 확증**: `.awl-worktrees/` 하위 untracked 3천 개가 있어도 `commit --start` 가 state.json 을 0KB 증가로 유지(listUntracked 의 `.awl-worktrees/` 제외가 실제로 폭증을 막는다).

## 관측 중 확인(수정 아님)
- **게이트 가드가 대량 픽스처에서도 작동**: 처음엔 `commit --start` 가 exit 1 이었는데, 이는 버그가 아니라 0.6.3 의 `hasApprovedGate1` 가드가 BULK 워크아이템의 gate:1 승인 기록이 없어 정확히 막은 것. 하네스에 gate:1 승인 레코드를 심어 통과 → 정상 관측. (자기 저장소 도그푸딩에서 가드가 또 스스로 작동.)

## 후속(범위 밖)
- 더 극단(records 50만·untracked 10만·criteria 5천): 상수 상향으로 확장. 이 규모에서 readRecords 전량 로드/state 재직렬화의 한계가 드러날 수 있음 — 인덱싱/스트리밍 최적화는 후속 plan 일감.
