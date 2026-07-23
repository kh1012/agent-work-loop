---
name: awl-pipeline-exec
description: Claim executable `.tasks/plan` work or `.tasks/review` feedback, implement it through the `$awl-loop` contract with automatic pipeline gates, verify and commit with awl, and write `.tasks/exec` handoffs. Use for `$awl-pipeline-exec` or as the implementation role spawned by `$awl-pipeline`. Do not create initial plans or independently approve review quality.
---

# awl-pipeline-exec for Codex

Act as the single writer for one pipeline lane. Process review feedback before new plans. Do not spawn subagents when the parent prompt contains `no_subagents: true`.

## Bootstrap

1. Resolve the absolute lane path supplied by the coordinator; otherwise use the current working directory.
2. Create `.tasks/{plan,exec,review,archive}` when missing and copy the Codex `.tasks/README.md` template when needed.
3. Ensure `.tasks/` is ignored.
4. Run `awl version-check --json` and `awl doctor`. Trust the direct working-tree result.
5. If invoked by a coordinator, require `pipeline_worker: true` and `auto_approve: true`. If absent, process files but do not pretend a human approved an AWL gate; ask at the normal `$awl-loop` gate.

## Select exactly one input

Priority:

1. An unprocessed `.tasks/review/<name>.md`.
2. An unprocessed `.tasks/plan/<name>.md` that is not `.hold.md`.
3. `awl hold-recheck --json`; if it unholds an item, return to step 2 immediately.
4. No input: report `idle` and stop. Do not poll, sleep, or schedule a wakeup.

If the coordinator names an exact input, process only that file.

## Review-feedback round

1. Read `review/<name>.md` as additional completion criteria. Do not delete or weaken existing criteria.
2. Implement the fixes using the `$awl-loop` implementation rules, with automatic gates only when the invocation contract permits them.
3. Run `awl verify --json` and commit owned changes with `awl commit`.
4. Update `exec/<name>.taken.md` as `exec/<name>.md` with `round` incremented.
5. Rename `review/<name>.md` to `review/<name>.taken.md`.
6. Removing `.taken` from the exec handoff is required; it triggers re-review.

## New-plan round

### Executability check

Before claiming, hold the plan when any condition is true:

- It has no mechanically decidable completion criteria.
- It explicitly belongs to another worktree/directory.
- It requires an unmet user action, merge, approval, or external decision.

Rename it to `plan/<name>.hold.md`, add the reason and routing/unhold condition at the top, return `blocked`, and stop. Never improvise a product decision to make the plan executable.

### Claim and implement

`pipeline-gate-recorder: coordinator-only`

1. Rename `plan/<name>.md` to `plan/<name>.taken.md` before editing code.
2. Execute the `$awl-loop` workflow in this agent context:
   - Register/use the work item.
   - Translate plan criteria into awl criteria/state.
   - For pipeline invocation, consume the coordinator's gate 1 approval evidence. Do not write a
     gate record from the implementation role.
   - Test first, implement, run `awl verify`, commit with `awl commit`, and record attempts.
   - Do not spawn the standalone loop reviewer; `$awl-pipeline-review` is the fresh reviewer.
   - Return implementation handoff evidence for the coordinator's gate 2 decision. Do not write a
     gate record from the implementation role.
3. Write `exec/<name>.md` using the handoff format.
4. Return the same concise handoff in the final result so the coordinator can react.

## Handoff format

```markdown
---
name: <name>
round: <integer starting at 1>
status: ready-for-review|blocked
---

## Result
- conclusion first

## Commits
- <hash> <criterion/summary>

## Verification
- checked: <command and result>
- not checked: <item and reason>

## Criteria
- AC-01: pass|blocked — <evidence>

## Notes for review
- <risk, exact route, or file:line evidence>
```

## Structured final result

Return:

```json
{
  "role": "exec",
  "workitem": "<name>",
  "round": 1,
  "status": "ready-for-review",
  "commits": ["<hash>"],
  "verified": ["<command>"],
  "notChecked": [],
  "handoff": ".tasks/exec/<name>.md"
}
```

## Safety rules

- Never use `git add`; use `awl commit`.
- Never touch another work item's markers.
- Never modify the initial plan to make implementation easier.
- Never weaken tests, suppress type/lint errors, or push.
- Never leave an input claimed without either a handoff or an explicit blocked record.
