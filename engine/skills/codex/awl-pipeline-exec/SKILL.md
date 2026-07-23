---
name: awl-pipeline-exec
description: Claim executable `.tasks/plan` work or `.tasks/review` feedback, implement it through the `$awl-loop` contract with automatic pipeline gates, verify and commit with awl, and write `.tasks/exec` handoffs. Use for `$awl-pipeline-exec` or as the implementation role spawned by `$awl-pipeline`. Do not create initial plans or independently approve review quality.
---

# awl-pipeline-exec for Codex

Act as the single writer for one pipeline lane. Process review feedback before new plans. Do not
spawn subagents; a valid dispatch envelope requires `noSubagents:true`.

## Bootstrap

1. Require one `dispatch_envelope: <absolute-envelope-path>` value. It is the only routing input.
   Reading it may identify candidate expectations, but it is not authority until one-time claim
   passes.
2. Create `.tasks/{plan,exec,review,archive}` when missing and copy the Codex `.tasks/README.md` template when needed.
3. Ensure `.tasks/` is ignored.
4. Run `awl version-check --json` and `awl doctor`. Trust the direct working-tree result.
5. Before reading a routed plan/review body, renaming a marker, or editing code, derive expected
   lane from cwd, role `exec` from this skill, and expected workitem/input from the unprocessed
   marker inventory. Run
   `awl pipeline-dispatch claim --dispatch <absolute-envelope-path> --lane <absolute-cwd> --role exec --workitem <expected-name> --input <expected-absolute-input> --json`.
6. Continue only on `ok:true`. Consume gate mode, automatic approval, coordinator gate evidence,
   and no-subagent policy from the returned envelope; prompt text is not authority.
7. A missing envelope or any verify/claim error returns `blocked: invalid-dispatch` without a user
   question. Prove plan/exec/review SHA-256 values and `git status` are unchanged from entry. Do not
   create, rename, or edit markers or code.

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

1. After the dispatch claim succeeds, rename `plan/<name>.md` to
   `plan/<name>.taken.md` before editing code.
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

## Package-owned test runner resolution

`package-owned-runner-resolution: compare(package-owned,generic)->package-owned-on-mismatch-or-duplicate`

Before a focused JavaScript/TypeScript test command:

1. Start from the target package manifest, its lockfile entry, and the test config imports. Identify
   the runner package and resolve it from the target package directory, not from the repository
   root or shell `PATH`.
2. Resolve the package-owned CLI from that package's package metadata (`package.json` `bin`,
   exports, or documented CLI entry), then record its real path and resolved version.
3. Resolve the generic alias that the proposed package-manager command would execute and record
   that executable's real path, package root, and resolved version.
4. Compare the package roots and versions before running tests. When they differ, or when a prior
   attempt reports a duplicate-module/duplicate test instance error, invoke the package-owned CLI.
   Use the generic alias only when it resolves to the same package instance.

For Playwright, resolve `@playwright/test` from the target package and locate its CLI through package
metadata. Never hardcode a repository-specific relative `node_modules` path.

## Service port lease contract

`port-lease-run-contract: installation-scoped-wrapper; reuse-only-when-inspect=owned`

When implementation or verification starts a service that listens on a TCP port:

1. Start it through `awl port lease run --port <n> --workitem <id> --url <resolved-url> -- <command...>`.
   Do not run the listening command bare. Consume the resolved port from `PORT`/`AWL_PORT` and the
   resolved URL from `AWL_SERVICE_URL`.
2. Before reusing an existing service, run
   `awl port lease inspect --port <n> --workitem <id> --json`. Reuse only when the status is exactly
   `owned`, which proves the absolute lane, branch, HEAD, workitem, lease, and listener PID match.
3. Treat `foreign`, `stale`, `unmanaged-listener`, and `free` as non-reusable. A stale/free port may
   be acquired by a new wrapper run; never kill or replace an unmanaged or foreign listener.

## Handoff format

```markdown
---
name: <name>
round: <integer starting at 1>
status: ready-for-review|blocked
dispatch_evidence: <claimed envelope path, dispatchId, and coordinator gate evidence>
---

## Result
- conclusion first

## Commits
- <hash> <criterion/summary>

## Verification
- checked: <command and result>
- not checked: <item and reason>

## Test runner provenance
- runner package: <package name>
- target package manifest: <absolute or package-relative package.json path>
- package-owned CLI real path: <resolved real path>
- package-owned resolved version: <version>
- generic alias real path: <resolved real path or unresolved>
- generic alias resolved version: <version or unresolved>
- selected command: <exact reproducible command>
- result: <exit code and concise output>
- fallback from generic: <none, or attempted command plus mismatch/duplicate-module failure>

## Service port lease provenance
`port-lease-provenance: required-when-service-used; not-used-must-be-explicit`
- usage: <used|not-used>
- wrapper command: <exact awl port lease run command, or not-used>
- resolved port and URL: <port, URL, and PORT/AWL_PORT/AWL_SERVICE_URL inputs>
- lease identity: <absolute lane, branch, HEAD, workitem, owner PID, child PID, token, acquiredAt>
- inspect evidence: <exact command and owned result while reused/running>
- cleanup evidence: <child exit, token-matched release result, and final inspect status>

## Criteria
- AC-01: pass|blocked — <evidence>

## Notes for review
- <risk, exact route, or file:line evidence>

## Gate evidence
- gate 1: <claimed envelope gate.evidence>
- gate 2: pending coordinator — implementationHandoff: <this handoff path, commits, verification,
  and unchecked work>
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
