# stress-concurrency 발견 (관측 결과)

`node scripts/stress/concurrency.mjs 8 3` (8 프로세스 × 3 라운드) 실행 관측. 이 일감은 **발굴만** 한다 — 수정은 후속 plan 일감.

## 요약
| 케이스 | 결과 | 판정 |
|---|---|---|
| A. 동시 state set | (수정 전) **성공 > 살아남은 키** → (수정 후) **성공 == 살아남은 키** | ✅ **[HIGH] F-A 수정 확인** (fix-lock-atomicity) |
| B. 동시 commit --start | 8/8 성공인데 baseline 은 1~5/8만 | ⚠ **[MEDIUM] 무락 lost update (예상대로, F-B 후속)** |
| C. 동시 record | 8/8, 깨진 줄 0 | ✅ 견고(appendFileSync O_APPEND 원자적) |

> **F-A 수정 완료**(fix-lock-atomicity, 커밋 ebc549e): 락 생성을 linkSync 로 원자화(빈 창 제거) + lockAgeAt mtime 폴백. 재실행 결과 Case A 가 성공 수 == 살아남은 키(예: 성공 1/키 1, 성공 3/키 3)로 lost update 소멸. F-B(commit --start 무락)는 별개 후속.

관측 예(N=8):
```
Case A r1: 성공 3 · 거부 5 · 유효 JSON=true · 살아남은 k키 2/8   ← 성공 3인데 키 2
Case B r3: 성공 8/8 · baseline 잡힌 criterion 1/8               ← 7개 baseline 유실
Case C   : 성공 8/8 · STRESS 레코드 8 · 깨진 줄 0
```

---

## [HIGH] F-A: state.lock 생성이 비원자 → 동시 acquirer 가 빈 파일을 stale 로 오판·steal → double-acquire → lost update
- **관측**: Case A 에서 `state set` 성공(exit 0) 프로세스 수보다 최종 state.json 에 살아남은 키가 적다(성공 3/키 2 등). 락이 직렬화하면 성공한 쓰기는 모두 누적돼야 하는데 유실됨 = 임계구역에 둘 이상 동시 진입.
- **확증된 근본원인**: `acquireStateLock`(`src/commands/state.ts`)의 `tryCreate` 는 `fs.openSync(p, 'wx')`(빈 파일 생성) **다음** `fs.writeSync(fd, {token,at})` 로 **2단계 비원자**. 그 사이 파일은 빈 상태. 동시 acquirer B 가 그 창에서:
  1. `openSync('wx')` → EEXIST(A의 빈 파일 존재)
  2. stale 검사 `Date.now() - lockAgeAt(p)` — `lockAgeAt` 가 빈 파일 `JSON.parse('')` 실패 → **0 반환**(= epoch 1970)
  3. `Date.now() - 0` ≫ 10s → **stale 판정** → rename-claim 으로 A 의 (아직 쓰는 중인) 락을 **steal**
  4. A·B 둘 다 임계구역 진입 → read-modify-write 겹침 → lost update
- **재현**: `node scripts/stress/concurrency.mjs 8 3` → Case A 에서 성공 수 > 살아남은 키(라운드마다 재현).
- **수정 방향(후속 plan 일감)**: 락 내용을 원자적으로 쓴다(temp+rename, writeState 처럼) — 락 파일이 "존재하면 항상 완전". 또는 `lockAgeAt` 가 parse 실패 시 0(=아주 오래됨) 대신 "방금 만들어지는 중(fresh)"으로 취급해 steal 을 미룬다. 전자가 근원 차단.

## [MEDIUM] F-B: commit --start 는 락이 없어 동시 실행 시 criterion baseline lost update
- **관측**: Case B 에서 8개 `commit --start`(다른 AC) 모두 exit 0 인데 최종 state.json 에 baseline 잡힌 criterion 은 1~4/8. 나머지는 유실.
- **근본원인**: `commit --start`(`src/commands/commit.ts:402-410`)는 `loadState→setCriterion→writeState`. writeState 는 원자적(concurrency-3 AC-01)이라 파일 손상은 없으나 **락이 없다**(락은 runStateSet 만). 동시 실행 시 모두 같은 base 를 읽고 각자 자기 AC 만 반영해 쓰므로 last-writer-wins → 다른 AC 의 baseline 유실.
- **재현**: `node scripts/stress/concurrency.mjs 8 3` → Case B 에서 성공 수 > baseline 수.
- **수정 방향(후속 plan 일감)**: F-A 의 락을 commit 의 read-modify-write 에도 적용(범위 밖에서 concurrency-3 이 "runStateSet 만" 이라 한 그 후속). 단 F-A 를 먼저 고쳐야 락 자체가 믿을 수 있다.

## ✅ 견고 확인: record append
- Case C 에서 8개 동시 `record`(작은 레코드) → 8줄 전부 유효, 깨진 줄 0. `appendFileSync`(`record.ts:485`)는 작은 레코드(<PIPE_BUF)에서 O_APPEND 원자적. **이 규모까지 견고**. (큰 레코드 >4KB 인터리빙은 stress-input-edge/bulk-data 범위.)

---
**정리**: concurrency-3 의 state.lock 이 **비원자 생성 창**에서 깨진다(F-A, HIGH) — 스트레스가 아니면 리뷰/valid 가 못 잡은 결함. commit --start 무락(F-B)은 알려진 범위 밖의 실증. 둘 다 **0.6.6 릴리스 전 후속 수정 권장**.
