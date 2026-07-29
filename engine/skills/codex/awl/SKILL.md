---
name: awl
description: >-
  Select this before any other awl skill or command — it is the ADK 0.8.0 entry point.
  EXPLICIT: a user-written `$awl`, or a request already opened with `awl run`, always
  selects it. AUTO-EXCLUDE-FIRST: otherwise skip bounded one-or-two-file radius, color
  token, spacing, copy, or class changes, plus simple questions, explanations,
  investigations, or reviews. Do not auto-trigger examples: "Dialog에 pilled radius를
  적용하고 내부 영역도 동일하게 바꿔줘"; "이 버튼의 rounded-md를 rounded-full로 바꿔줘";
  "레이블을 '저장'으로 바꿔줘". AUTO-INCLUDE-AFTER-EXCLUSIONS: only if not excluded,
  select non-simple features needing investigation or design for scope or done state,
  intertwined behaviors or states, or complex bugs with unclear cause and scope.
  Auto-trigger examples: "페이지 생성 플로우를 개선하자"; "이 편집기에 자동 저장 기능을
  구현해줘"; "권한별 페이지 관리 기능을 만들자"; "간헐적으로 저장이 실패하는데 원인과 수정
  범위를 찾아 고쳐줘". Instructions come from `awl next`; this
  skill only follows its output. Command boundary: PRE-SELECTION-AWL=none;
  POST-SELECTION-FIRST-AWL=awl version-check --json;
  OTHER-SKILL-ONLY-AWL-VERSION-CHECK=forbidden. Do not select when the user explicitly
  wrote `$awl-loop` (legacy criterion-level flow) or wants a single awl command run.
---

# awl for Codex

The CLI writes the instructions. This skill is three lines (adk-prototype.md:330-332).

1. Given a goal, call `awl next`.
2. Its output says what to do next and how. Follow it. When the `skill` line is filled,
   read that file; when it is empty (`skill (없음)`), work from the contract alone.
3. When done, record the result with `awl record` (finding/clarification/attempt — whichever
   type fits) and call `awl next` again.

## Gates are where a human stops

When `awl next` prints a filled "게이트 N 에 도달하려면" list, check `state.json`'s
**`loopMode`** (`awl state get`; absent means `semi-auto`) before writing the matching
`awl record gate --json '{...}'`.

> ⚠ It is `loopMode`, not `mode`. `state.json`'s `mode` already holds the pipeline gate
> density (`gate-high`/`gate-medium`/`gate-low`), so reading `mode` yields values like
> `gate-low` that are not loop modes at all.

```
strict      Stop at all four gates — ask for approval each time.
semi-auto   Gates 2 and 3 self-approve with "auto":true. Gates 1 and 4 still ask. (default)
auto        All four gates self-approve. Gate 4 (closing the request) still expands the
            done tickets, conditions, verifications, and self-approval count as a summary
            — shown, not asked.
```

Whenever a gate is approved without a human actually answering, `"auto": true` must be in
the record. Never hide an autonomous approval.

## You are not instructed step by step

Investigate first, read code first, or ask the user first — it does not matter. What matters
is that when you reach a gate, the shape `awl next` asked for (finding / clarification /
verification, or a commit) is satisfied.

## Before gate 1 — grill

Read the **모드** block in `awl next` output before writing a spec. Its "캐묻기" line states
exactly how hard this mode wants you to push.

```
strict      Keep asking until zero open questions. Do not reach gate 1 with any left.
semi-auto   Ask once, record what is left as a clarification, move on.
auto        Skip — grilling contradicts a mode whose point is removing the human.
```

How to ask follows the skill in `profile.json`'s `spec`/`clarification` slots (grill-with-docs
and grill-me by default). If you cannot read it, proceed without it — what you ask matters,
not which skill you asked with.

**Grilling can distort the request.** Digging can drift away from the original intent, so never
edit the user's words in `Request`. What you settle goes into `Instruction` and `Conditions`.

## At gate 4 — closing explanation

The mode also decides what the human gets when the request closes.

```
strict      Explain what changed and why, in a form a human reads. Include comprehension checks.
semi-auto   Explain what changed and why, in a form a human reads.
auto        Expanded summary only — done tickets, conditions, verifications, self-approval count.
```

`profile.json`'s `close` slot points at the format (explain-diff by default: background,
intuition, code, comprehension checks). **This is not review.** Review is another pair of eyes
hunting defects (`review` slot); this is the human catching up on what the agent did. The more
autonomous the run, the larger that debt.

## No ticket yet? Make one first

With no tickets, `awl next` prints a spec-stage view — not an error. Its "다음" block
names what you can do right now, with real ids filled in; follow it. To move a goal into
a spec: `awl doc new spec <제목> --request "<원문>"` → fill `## Conditions` as
`### condition-N` blocks (EARS phrasing) → `awl tickets derive <spec-id>` → `awl next`.

> Conditions written as bullets (`- 언제 …`) pass `awl doc lint` but make
> `awl tickets derive` produce zero tickets. One condition is one `### condition-N`.

## Commit documents immediately

When you create or edit a spec or ticket, commit it right there with plain git
(`git add docs/ && git commit -m "..."`), not `awl commit` — these are documents, not
criterion diffs. Do not defer: `awl commit <ticket-id> --start` snapshots every uncommitted
change at that moment as "someone else's", so a spec left uncommitted before that point can
never be included by any later ticket commit.

## Whole pipeline

`awl stages` (full) or `awl stages --short` (five lines). This file does not repeat it.
