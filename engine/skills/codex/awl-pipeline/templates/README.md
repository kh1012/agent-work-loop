# .tasks pipeline contract

Codex roles coordinate through files in this directory. File names are the durable state.

| plan/ | exec/ | review/ | state |
|---|---|---|---|
| `<name>.md` | - | - | pending |
| `<name>.hold.md` | - | - | blocked; user/coordinator action required |
| `<name>.taken.md` | `<name>.md` | - | reviewing |
| `<name>.taken.md` | `<name>.taken.md` | - | complete |
| `<name>.taken.md` | `<name>.taken.md` | `<name>.md` | review failed; exec must respond |
| `<name>.taken.md` | `<name>.md` | `<name>.taken.md` | revised; re-review pending |

Ownership:

- plan creates `plan/<name>.md`.
- exec claims plan/review inputs, implements, and creates or updates `exec/<name>.md`.
- review claims exec handoffs and creates `review/<name>.md` only on failure.
- `.taken` means processed, not approved.

Codex orchestration uses `wait_agent` for active work and `followup_task` for new input to an idle
role. Optional `$awl-pipeline <lane명> <mode> --poll <interval>` uses the current chat's native
Scheduled task for future plan arrival; `--poll 30m` is the canonical 30-minute example. If the
Scheduled capability is unavailable, do not emulate it with a goal, sleep, shell watcher, or cron.
