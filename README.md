# inv-forge

Engineering toolkit for the apps the Innovation team builds and maintains itself: skills, hooks and CI gates
that enforce clean architecture, test-first development and zero technical debt.

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
| Runtime | `.claude/forge/` | Hooks, `check.js`, `config.json`, version manifest |
| Our skills | `.claude/skills/forge-backend`, `forge-frontend` | How we build: layers, data access, components, tests |
| Official skills | plugins in `.claude/settings.json`, `angular-developer` vendored | Superpowers, .NET, Angular (versions in `pins.json`) |
| Wiring | marked entries in `.claude/settings.json`, `CLAUDE.md`, `.gitignore` | Survives re-runs; re-run after a starter `/upgrade` |

## Controls

Each control is `off`, `warn` or `block` per project, in `.claude/forge/config.json`. A new project starts with
everything in `block`. An existing project starts with what it cannot pass yet in `warn` and moves to `block` as
it is migrated. The maintainer sets the modes; a Claude session cannot edit them.

| Control | Checks | When |
|---|---|---|
| `skills` | The zone's skill was loaded before its code is edited | on edit |
| `tdd` | A test changed before behaviour code changes | on edit, CI |
| `suppressions` | No `#pragma warning disable`, `NoWarn`, `eslint-disable`, `@ts-ignore`, skipped or focused tests, `::ng-deep` | on edit, CI |
| `protected` | `.claude/forge`, the hook wiring and `node_modules` are read-only | on edit, on shell command, CI |
| `architecture` | Structure rules: layers point inward, no data access in the Api layer, no query in a loop, records for data carriers, libraries used as shipped, no `any`, file size | after each edit, when a turn ends, CI (whole project) |
| `verify` | Build and tests of the touched zone pass | when a turn ends, CI (all zones) |
| `changeSize` | A slice stays under the line limit | when a turn ends (advisory), CI |

`node .claude/forge/check.js` runs the same checks outside a session; `--base origin/main` checks a pull
request's diff, `--ci` adds the commands that need a database, `--out file.json` writes the result in a fixed
format.

### Existing code: the baseline

The structure rules run in `block` even on a project full of old code. At install, every existing violation is
recorded in `.claude/forge/arch-baseline.json`; from then on a file may never have more violations of a rule
than its baseline. Old code keeps working, nothing new gets in, and the numbers are the migration backlog.
After migrating, the maintainer shrinks it with `node inv-forge/setup/setup.js <project> --baseline`. A Claude
session is blocked from running that.

### Review: where human attention goes

`check.js` classifies every change as high, medium or low risk, from where the file lives (migrations,
auth, CI, configuration) and what the added lines do (deleting data, changing access, money). High-risk files
are announced to the user when the turn ends.

`node .claude/forge/check.js --packet` writes a one-page review packet: the risk table, the tests the change
adds (they are the specification), the result of every check, what the machine did not verify, and a section
the author must complete: decisions taken, what was not verified, where to look hardest.

### New backend

```bash
node inv-forge/setup/setup.js <project> --scaffold-backend Acme.Billing            # no database
node inv-forge/setup/setup.js <project> --scaffold-backend Acme.Billing --efcore   # EF Core + query counter
```

Creates `api/` in four layers (Domain, Application, Infrastructure, Api) with warnings as errors, dead-code and
complexity analyzers, and one working use case tested at both levels. With `--efcore`, endpoint tests run on
in-memory SQLite and a `QueryCounter` counts SQL commands, which is how an N+1 is proven in a test. It only
runs where there is no backend, and does not yet wire `npm run api`, the dev proxy or the Dockerfile.

### What this does and does not guarantee

Hooks only run inside Claude Code, and a determined session has ways around a local hook. They exist to keep
honest work on the rails and to make bypassing deliberate and visible. **CI is the gate**: wire `check.js` into
the project's workflow and require it on the main branch. Nothing here judges whether a design is good or a test
is meaningful; that is what plan approval and human review of tests are for.

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

## Roadmap

1. **Base (done, 0.1):** skills, working method, test-first, slice size, verification, no suppressions, CI entry point.
2. **Structure (done, 0.2):** four-layer backend scaffold, structure rules with a baseline, N+1 static rule and
   query counter, library-override rules, risk classification, review packet, size and complexity limits.
   Not covered: detecting a hand-built component where a Prismatic one exists, and per-method complexity on
   the frontend (needs ESLint, which the starter does not ship).
3. **Continuous quality:** dead-code cleanup, independent reviewers, mutation testing, security scans, metrics.
