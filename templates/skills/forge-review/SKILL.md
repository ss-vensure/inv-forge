---
name: forge-review
description: Independent review of the current change by agents that did not write it - one per lens (correctness, security, data and performance, architecture, simplicity), followed by an attempt to refute each finding. Use before presenting a medium- or high-risk change as done, when the Stop hook asks for it, or when the user asks for a review of the uncommitted work or a branch. The turn cannot end on a medium- or high-risk change until this skill has been loaded and run.
---

# Independent review (inv-forge)

You wrote the change, so you are the wrong reviewer: you will read what you meant, not what is there. This
skill hands the change to agents that have none of your context, and then tries to knock their findings down,
so the user receives a short list of confirmed problems instead of a long list of maybes.

If you cannot launch subagents in this session, say so to the user and do the lenses yourself, one at a time,
re-reading the diff from scratch for each. State in your report that the review was not independent.

## 1. Gather what the reviewers need

- The diff: `git diff HEAD` for uncommitted work, or `git diff <base>...HEAD` for a branch. Include new files.
- The approved plan under the project's plans folder, if there is one. It says what the change is for.
- The rules: `.claude/skills/forge-backend/SKILL.md` and `.claude/skills/forge-frontend/SKILL.md`.
- Run `node .claude/forge/check.js --packet` and read the packet. Its risk table tells you where to aim.

Give reviewers the diff, the plan and the rules. Do **not** give them your explanation of why the change is
correct, and do not tell them what you expect them to find.

## 2. One reviewer per lens, in parallel

Launch one agent per lens. Each gets the same material and exactly one question. Skip a lens only when the
change cannot touch it (no backend code: skip data; no UI: nothing to skip, the others still apply).

| Lens | The question |
|---|---|
| Correctness | Where does this do something other than what the plan and the tests say? Edge cases, error paths, off-by-one, null, concurrency. |
| Security | Who can now do or see something they should not? Missing or weakened authorization, input trusted without validation, secrets, personal data exposed or logged. |
| Data and performance | What gets slow or wrong with real volumes? Queries in loops, unbounded lists, missing indexes, tracking on read paths, migrations that lose or lock data. |
| Architecture | What breaks the layering or the component rules, including what the static rules cannot see: a use case hiding in the wrong layer, a hand-built component where a Prismatic or Syncfusion one exists. |
| Simplicity | What can be deleted or made simpler? Code nothing calls, abstractions with one use, duplicated logic, replaced code left behind. |
| Tests | Which behaviour in the diff has no test, and which tests would still pass if the code were wrong? |

Each reviewer returns findings as: file and line, what is wrong, a concrete scenario where it fails, and how
sure they are. "Looks fine" is a valid answer. Tell them not to pad.

## 3. Try to refute every finding

For each finding, launch a second agent whose job is to prove it **wrong**: it reads the code around the
finding and looks for the guard, the test or the constraint that makes the failure impossible. A finding
survives only if the refuter cannot knock it down, or confirms it. Drop the rest; do not keep them as
"possible".

High-risk files in the packet get this treatment for every finding. For low-risk files, you may confirm a
finding yourself by reading the code instead of launching a refuter.

## 4. Act and report

- Fix every confirmed finding, test first where it is behaviour. Do not fix by silencing.
- If a confirmed finding needs a decision (a trade-off, a change of plan), stop and put it to the user.
- Run `node .claude/forge/check.js --packet` again after the fixes.

Report to the user, briefly:

1. How many findings each lens raised and how many survived refutation.
2. Each confirmed finding: where, what, and what you did about it.
3. What the review did **not** cover (a lens skipped, files too large to read fully, no plan to compare to).

Never report a review you did not run, and never describe findings as fixed that you only noted.
