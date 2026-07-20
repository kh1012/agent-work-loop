#!/usr/bin/env bash
# awl-pipeline review watcher — single-owner via atomic mkdir role lock. ONE-SHOT (pipeline-self-pace-loop AC-02):
# checks .tasks/exec exactly once, prints the result, and exits immediately — no internal polling
# loop, no blocking wait. The caller (SKILL self-pace) schedules the NEXT check itself via /loop or
# ScheduleWakeup — 2-stage backoff (240s/1500s) keyed off EMPTY_COUNT below
# (pipeline-self-pace-adaptive-backoff); this script never waits.
# A *.md WITHOUT the .taken postfix = not yet verified.
# The mkdir lock now means "the right to run this one check right now", not long-lived ownership —
# if another LIVE instance is mid-check this instant, prints ALREADY_OWNED and exits 0.
# ROOT resolves to the script's PHYSICAL directory (symlinks fully followed via cd -P/pwd -P),
# so this is correct whether invoked via a symlinked .tasks/ path or the real physical path
# (e.g. .tasks -> .awl/lanes/<lane>). See pipeline-watcher-symlink-invoke-fix.
set -uo pipefail
ROOT="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
EXEC="$ROOT/exec"; PLAN="$ROOT/plan"; REVIEW="$ROOT/review"
if [ ! -d "$PLAN" ] || [ ! -d "$EXEC" ] || [ ! -d "$REVIEW" ]; then
  echo "ERROR: expected plan/exec dirs not found under $ROOT (resolved from ${BASH_SOURCE[0]})" >&2
  exit 1
fi
LOCKS="$ROOT/.locks"; LOCK="$LOCKS/review"
# COUNTFILE persists the consecutive-empty-check count across self-pace ticks (and session
# restarts, since it's a plain file under .tasks/.locks — not tied to session/context memory).
# pipeline-self-pace-adaptive-backoff: SKILL self-pace uses this to pick 240s (stage1, 0-1) vs
# 1500s (stage2, 2+) for the next ScheduleWakeup/loop. Reset to 0 whenever UNVERIFIED_READY fires.
COUNTFILE="$LOCKS/review-empty-count"
STABLE_SECS=8; STALE=60

own(){ echo $$ > "$LOCK/pid"; date +%s > "$LOCK/beat"; }
fresh(){ # 0 if lock held by a live, recently-heartbeating owner
  local p b n; p=$(cat "$LOCK/pid" 2>/dev/null) || return 1
  { [ -n "$p" ] && kill -0 "$p" 2>/dev/null; } || return 1
  b=$(cat "$LOCK/beat" 2>/dev/null || echo 0); n=$(date +%s)
  [ $(( n - b )) -lt "$STALE" ]
}
acquire(){
  mkdir -p "$LOCKS" 2>/dev/null
  if mkdir "$LOCK" 2>/dev/null; then own; return 0; fi
  fresh && return 1
  # stale: reap atomically (only one stealer wins the rename), then re-create
  if mv "$LOCK" "$LOCK.reap.$$" 2>/dev/null; then rm -rf "$LOCK.reap.$$" 2>/dev/null; fi
  if mkdir "$LOCK" 2>/dev/null; then own; return 0; fi
  return 1
}

acquire || { echo "ALREADY_OWNED"; exit 0; }
trap 'rm -rf "$LOCK" 2>/dev/null' EXIT

# single pass — no internal poll loop, no sleep. Caller reschedules the next check (/loop or ScheduleWakeup).
now=$(date +%s); ready=""
while IFS= read -r f; do
  [ -z "$f" ] && continue
  m=$(stat -f %m "$f" 2>/dev/null || echo "$now")
  if [ $(( now - m )) -ge "$STABLE_SECS" ]; then ready="${ready}${f}"$'\n'; fi
done < <(find "$EXEC" -type f -name '*.md' ! -name '*.taken.md' 2>/dev/null | sort)
if [ -n "$ready" ]; then
  echo 0 > "$COUNTFILE" 2>/dev/null
  printf 'UNVERIFIED_READY\n%s' "$ready"; exit 0
fi
n=$(( $(cat "$COUNTFILE" 2>/dev/null || echo 0) + 1 ))
echo "$n" > "$COUNTFILE" 2>/dev/null
echo "EMPTY_COUNT:$n"
exit 0
