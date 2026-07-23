# awl-loop conditional reference

Read only for failure classification, review, or narrative recording.

## Failure classification

Classify a failed verification before retrying:

- Implementation failure: the code does not satisfy the criterion. Change the approach and increment the attempt.
- Test failure: the test encodes the wrong contract. Correct it only when repository evidence proves the mistake; record why.
- Environment failure: toolchain, port, service, fixture, or concurrent-edit issue. Record a procedural error rather than pretending the implementation failed.
- Criterion failure: the approved criterion is impossible or wrong. Do not edit it silently; record blocked and return to the user or pipeline coordinator.

After three different failed approaches:

```bash
awl record blocked --diff --json '{"tried":["approach 1: failure","approach 2: failure","approach 3: failure"],"lesson":"..."}'
```

Keep the worktree intact unless the awl command explicitly identifies which owned changes may be discarded. Never use broad destructive git cleanup.

## Reviewer checklist

Give this checklist to a fresh reviewer:

1. Cheating: new `any`, ignore/disable directives, removed or weakened tests, `skip`, weak assertions, hardcoded stubs, criterion/spec edits, timing sleeps, or unrelated hunks.
2. Completion: verify every AC against the actual diff, worktree, and command output. Do not trust the implementer's summary.
3. Quality: cite concrete file/line evidence for unnecessary abstraction, duplicated reusable logic, inconsistent patterns, or mixed responsibilities.
4. Executability: open source files when a diff is insufficient; rerun focused verification when safe.
5. Visual changes: verify the exact rendered DOM context. Functional behavior is not evidence that computed visual properties are correct.

Expected result:

```json
{
  "verdict": "pass",
  "findings": [],
  "checked": ["what and how"],
  "notChecked": [{"what": "...", "why": "..."}],
  "cheatingDetected": []
}
```

## Narrative evidence

Record a counterfactual only at the moment it becomes known:

- `gate-caught`
- `reviewer-caught`
- `spike-prevented`
- `blocked-discarded`
- `tool-failed`

```bash
awl record narrative --json '{"kind":"reviewer-caught","counterfactual":"If missed, ..."}'
```

Do not invent narrative events after the fact.

## Record style

- Put the conclusion first.
- Use lists for multiple facts.
- Separate checked and unchecked work; explain why something was not checked.
- Avoid filler such as "성공적으로" or "~을 통해".
