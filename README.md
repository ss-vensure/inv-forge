# inv-forge

Engineering toolkit for the apps the Innovation team builds and maintains itself: skills and hooks that enforce
clean architecture, test-first development and zero technical debt while Claude writes the code.

The RAiCE starter is the mould RAiCErs use. inv-forge is for what the mould does not fit: more complex apps,
deployed to their own Azure web service, that we own end to end. A project still starts from the starter;
`/forge-setup` then turns it into a forge project. The starter's commands, including `/upgrade`, keep working.

## Why

Claude can write more code than a person can read. So the toolkit does two things: it makes wrong code hard to
produce (rules checked by a machine, not by Claude's word), and it moves human review to where it pays off
(plans, tests and high-risk changes) instead of line-by-line reading.

## Use

```bash
git clone https://github.com/ss-vensure/inv-forge
node inv-forge/install.js          # once per machine: adds the /forge-setup skill
```

Then, in a project, after the starter's `/setup`: run **`/forge-setup`** in Claude Code and restart the session.

Without Claude: `node inv-forge/setup/setup.js <project>` installs, `--check` reports drift.

## What a project gets

| Piece | Where | Purpose |
|---|---|---|
| Runtime | `.claude/forge/` | Hooks, `check.js`, `config.json`, baseline, exceptions, version manifest |
| Our skills | `.claude/skills/forge-backend`, `forge-frontend`, `forge-review` | How we build, and how a change is reviewed |
| Official skills | plugins in `.claude/settings.json`, `angular-developer` vendored | Superpowers, .NET, Angular (versions in `pins.json` and `forge.json`) |
| Wiring | marked entries in `.claude/settings.json`, `CLAUDE.md`, `.gitignore` | Survives re-runs; re-run after a starter `/upgrade` |

## It runs locally, on purpose

Everything here runs on the developer's machine: hooks while Claude works, and `check.js` on demand. Nothing is
added to CI. These projects are in a trial phase, and a workflow full of checks that the next owner of the repo
cannot run would be a liability, not a safeguard. The consequence is stated plainly: an edit made outside a
Claude session passes through none of this unless someone runs `check.js`.

If a project later wants a CI gate, `setup.js --ci-example` writes an example step.

## Controls

Each control is `off`, `warn` or `block` per project, in `.claude/forge/config.json`. A new project starts with
everything in `block`. An existing project starts with what it cannot pass yet in `warn` and moves to `block` as
it is migrated. The maintainer sets the modes; a Claude session cannot edit them.

| Control | Checks | When |
|---|---|---|
| `skills` | The zone's skill was loaded before its code is edited | on edit |
| `plan` | Past a size threshold, a plan the user marked `Status: approved` exists. Claude cannot write the approval | on edit |
| `tdd` | A new test is declared before behaviour code changes | on edit |
| `suppressions` | No `#pragma warning disable`, `NoWarn`, `eslint-disable`, `@ts-ignore`, skipped or focused tests, `::ng-deep` | on edit |
| `security` | No secrets in any file; no real personal data in tests or fixtures | on edit, end of turn |
| `protected` | `.claude/forge`, the hook wiring and `node_modules` are read-only | on edit, on shell command |
| `architecture` | Structure rules: layers point inward, no data access in the Api layer, no query in a loop, records for data carriers, libraries used as shipped, no `any`, file size | after each edit, end of turn |
| `deadCode` | No commented-out code or ownerless TODO in a change; unused-code tools (knip) when the project has them | end of turn, `check.js` |
| `verify` | Build and tests of the touched zone pass | end of turn |
| `review` | From medium risk up, the change was reviewed by agents that did not write it (`forge-review`) | end of turn |
| `changeSize` | A slice stays under the line limit | end of turn (advisory) |
| `audit` | No known-vulnerable packages | `check.js --audit` |
| `mutation` | The tests notice when the code is changed on purpose (Stryker) | `check.js --mutation` |

`node .claude/forge/check.js` runs every check on the uncommitted work. `--base main` checks everything a branch
adds, `--packet` writes the review packet, `--audit` and `--mutation` add the slow ones, `--ci` adds commands
that need a database, `--out file.json` writes the result in a fixed format, `--metrics` shows the history.

### Existing code: the baseline

The structure rules run in `block` even on a project full of old code. At install, every existing violation is
recorded in `.claude/forge/arch-baseline.json`; from then on a file may never have more violations of a rule
than its baseline. Old code keeps working, nothing new gets in, and the numbers are the migration backlog.
After migrating, the maintainer shrinks it with `node inv-forge/setup/setup.js <project> --baseline`. A Claude
session is blocked from running that. `security` and `deadCode` judge only added lines, so they need no baseline.

### Exceptions

Sometimes a rule cannot be met: a hotfix, a generated file, a screen scheduled for rewrite. The alternative to
switching the control off for the whole project is an exception: one control (or one structure rule), on named
files, with a reason, for a limited time.

```bash
node inv-forge/setup/setup.js <project> --except tdd --paths "api/src/**/Import*.cs" --reason "Hotfix for the March import, tests follow in the same week" --days 7
node inv-forge/setup/setup.js <project> --except architecture/query-in-loop --paths "api/src/**/BatchWriter.cs" --reason "Saves in chunks of 500 on purpose"
node inv-forge/setup/setup.js <project> --exceptions        # list
node inv-forge/setup/setup.js <project> --revoke <id>
```

Only the maintainer grants one, from their own terminal: a session is blocked from running these commands and
from editing `exceptions.json`. An exception lasts at most 90 days, never covers `protected`, and is not silent:
every use is reported to the user when the turn ends, listed at the start of each session, and printed in the
review packet. When it expires the rule is simply back.

### Review: where human attention goes

Every change is classified as high, medium or low risk, from where the file lives (migrations, auth, CI,
configuration) and what the added lines do (deleting data, changing access, money). High-risk files are
announced to the user when the turn ends.

- **Before the code:** past `plan.requiredFromLines` added lines, edits are refused until the user has approved
  a plan. Reviewing one page of intent is cheaper than reviewing a thousand lines of result.
- **Independent review:** from medium risk up, the turn cannot end until `forge-review` has run: one agent per
  lens (correctness, security, data, architecture, simplicity, tests), then an attempt to refute each finding,
  so only confirmed problems reach the user.
- **The packet:** `check.js --packet` writes one page: the risk table, the tests the change adds (they are the
  specification), the result of every check, what the machine did not verify, exceptions in force, and a section
  the author must complete: decisions taken, what was not verified, where to look hardest.

### Metrics

Every `check.js` run adds a line to a local history. `check.js --metrics` shows pass rate, which controls fail
most, runs by risk tier, use of exceptions, and the migration backlog from the first recorded run to now. The
history is per machine; the backlog itself is `arch-baseline.json`, whose history is in git.

### New backend

```bash
node inv-forge/setup/setup.js <project> --scaffold-backend Acme.Billing            # no database
node inv-forge/setup/setup.js <project> --scaffold-backend Acme.Billing --efcore   # EF Core + query counter
```

Creates `api/` in four layers (Domain, Application, Infrastructure, Api) with warnings as errors, dead-code and
complexity analyzers, and one working use case tested at both levels. With `--efcore`, endpoint tests run on
in-memory SQLite and a `QueryCounter` counts SQL commands, which is how an N+1 is proven in a test. It wires
the dev loop (`npm run api`, `npm run test:api`, the Angular dev-server proxy). It only runs where there is no
backend, and it does not change the Dockerfile: the starter owns that file and its `/upgrade` overwrites it.

### Optional tools

inv-forge uses these when the project already has them, and says so when it does not. It never installs them.

| Tool | Used for | Detected from |
|---|---|---|
| knip | unused files, exports and dependencies in the frontend | `knip` in `package.json` |
| dotnet-stryker | mutation testing of the backend | a .NET tool manifest listing `dotnet-stryker` |
| Stryker (JS) | mutation testing of the frontend | `@stryker-mutator/core` in `package.json` |

### What this does and does not guarantee

Hooks only run inside Claude Code, and a determined session has ways around a local hook. They exist to keep
honest work on the rails and to make bypassing deliberate and visible, not to be a security boundary. Nothing
here judges whether a design is good; that is what plan approval, the independent review and the human reading
the tests are for. Static rules catch the usual shape of a problem, not every shape: the N+1 rule sees a query
in a loop, and only a query-count test proves there is none.

## Repository layout

```
runtime/     copied into a project at .claude/forge/ (hooks, checks, CLI)
setup/       the installer
templates/   our skills, the backend scaffold (and its EF Core overlay) and the CI example
skills/      the /forge-setup skill (installed per user by install.js)
pins.json    every external dependency and its version
test/        node --test
```

## Development

```bash
npm test
```

Bump `version` in `package.json` and add a `CHANGELOG.md` entry with every change that reaches projects.
Projects record the version they have in `.claude/forge/forge.json`; `--check` reports when they are behind.

## Status

1. **Base (0.1):** skills, working method, test-first, slice size, verification, no suppressions.
2. **Structure (0.2):** four-layer backend scaffold, structure rules with a baseline, N+1 static rule and query
   counter, library-override rules, risk classification, review packet, size and complexity limits.
3. **Continuous quality (0.3):** exceptions, security, leftovers, approved plan, independent review, vulnerable
   packages, mutation testing, metrics.

Known gaps: a hand-built component where a Prismatic one exists is only caught by review; per-method
complexity on the frontend needs ESLint, which the starter does not ship; the plugins from the .NET marketplace
install at their latest version (the installed version is recorded, not pinned); the single-image Dockerfile
for a project with a backend is still set up by hand.
