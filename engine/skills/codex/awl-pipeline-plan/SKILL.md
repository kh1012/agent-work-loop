---
name: awl-pipeline-plan
description: Convert a user goal into one or more `.tasks/plan` work-item documents with verified background, measurable acceptance criteria, exclusions, dependencies, and review hints. Use for `$awl-pipeline-plan` or when the AWL pipeline needs planning only. Do not implement or review code.
---

# awl-pipeline-plan for Codex

Create executable work-item documents. Do not implement or review.

## Bootstrap

1. Treat `.tasks/` as relative to the target lane/current working directory.
2. Create `.tasks/{plan,exec,review,archive}` when missing.
3. If `.tasks/README.md` is missing, copy `.agents/skills/awl-pipeline/templates/README.md` from the installed repository skill.
4. Ensure `.tasks/` is ignored and report if it is not.

## Workflow

1. If no goal was supplied, state that setup is ready and stop. Do not manufacture a question.
2. Read relevant source files and existing patterns. Keep checked and unchecked facts separate.
3. When investigation is large and this is a top-level invocation, one bounded read-only `spawn_agent` may inspect a narrow area and return only file/line facts. Do not delegate when the parent prompt contains `no_subagents: true`.
4. Split independent concerns into separate plan files. Keep dependent changes together or express `dependsOn`.
5. Choose a unique kebab-case `<name>` after scanning plan/exec/review for collisions.
6. Write `.tasks/plan/<name>.md` with the format below.
7. Report `created: plan/<name>.md` and the criteria count.

## Plan document

```markdown
---
name: <name>
title: <one-line title>
priority: high|medium|low
---

## Goal
<What and why, one paragraph.>

## Verified background
- F-01: <file:line and observed fact>
- F-02: <fact>

## Completion criteria
- [ ] AC-01: <binary condition> — scope: <exact files/commands/behavior> (addresses F-01)
- [ ] AC-02: <condition> — scope: <...> (dependsOn AC-01; addresses F-02)

## Out of scope
- F-03: <excluded finding and reason>

## Verification hints
- AC-01: <command, test, or exact UI route>
```

## Criterion rules

- Include scope and verification evidence for every criterion.
- Make pass/fail mechanically decidable.
- Link relevant findings with `addresses`.
- State ordering with `dependsOn`.
- Avoid vague qualifiers: 저위험, 주요한, 적절한, 가능한 만큼, 필요시.
- Do not hide a discovered issue by omitting it; put it in criteria or out of scope.
- For UI work, identify the exact route/state and rendered context to verify.

## File-state contract

- `plan/<name>.md`: pending.
- `plan/<name>.taken.md`: claimed by exec.
- `plan/<name>.hold.md`: not executable without user/coordinator action.
- Plan owns only creation of the initial plan file.
