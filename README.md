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

### Only for me: `--local`

In a project where inv-forge is optional (other people work on it without it), install it for yourself only:

```bash
node inv-forge/setup/setup.js <project> --local
```

Hooks and plugins go to `.claude/settings.local.json`. `.claude/settings.json`, `CLAUDE.md` and `.gitignore`
are not touched, and inv-forge's files are ignored through `.git/info/exclude`, so nothing of it reaches a
commit. The choice is remembered: updating later needs no flag. `--shared` moves the project back to the
committed wiring. The cost is the obvious one: whoever has not installed it works with no controls.

## What a project gets

| Piece | Where | Purpose |
|---|---|---|
| Runtime | `.claude/forge/` | Hooks (including the router that runs on every message), `check.js`, `config.json`, baseline, exceptions, version manifest |
| Our skills | `.claude/skills/forge-backend`, `forge-frontend`, `forge-review` | How we build, and how a change is reviewed |
| Agents | `.claude/agents/forge-backend-dev`, `forge-frontend-dev`, `forge-debugger`, `forge-refactorer`, `forge-test-reviewer` | One agent per step of the work, each held to the skills of its step |
| Official skills | plugins in `.claude/settings.json`, `angular-developer` vendored | Superpowers, .NET, Angular (versions in `pins.json` and `forge.json`) |
| Wiring | marked entries in `.claude/settings.json`, `CLAUDE.md`, `.gitignore` | Survives re-runs; re-run after a starter `/upgrade` |

## Nothing to remember

After `/forge-setup` there is no command to learn. A hook runs on every message the user sends and makes
Claude decide what kind of request it is, say so in the first line of its reply (`Route: bug - ...`), and
follow that route:

| Route | What happens |
|---|---|
| question | An answer. Nothing else starts. |
| small | One zone, a few files: test first, change, verify. No plan, no agents. |
| feature | Design with the user, a plan the user approves, each zone built by its agent, independent review. |
| bug | The debugger agent: root cause with evidence, a test that fails because of it, then the fix. |
| refactor | No behaviour change; tests green before and after. |

The agents are how the official skills reach the code. Each one starts with our rules for its zone already in
its context and loads the official skills for the files it touches; it works in a context of its own, so a
long conversation does not wear its instructions away. The same hooks apply inside an agent, an agent cannot
edit outside its zone, and it cannot finish while the build or the tests of its zone fail.

Claude does the classifying, and could call a feature "small" to skip the plan. Two things answer that: the
route is stated where the user sees it, and the `plan` control refuses edits past the size threshold whatever
the route was called.

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
| `skills` | The skills that govern a file, ours and the official ones, were loaded before it is edited; the finishing skill before the turn ends | on edit, end of turn |
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

`node .claude/forge/check.js` runs every check on the uncommitted work. `--base main` checks everything a branch
adds, `--packet` writes the review packet, `--audit` looks for vulnerable packages, `--ci` adds commands
that need a database, `--out file.json` writes the result in a fixed format, `--metrics` shows the history.

### Skills: which ones, and when

Installing a skill does not make Claude read it. `skillRules` in `config.json` says which skills must be loaded
before which files change, and a hook refuses the edit until they are. The defaults:

| Files | Skills that must be loaded first | From |
|---|---|---|
| `api/**` | `forge-backend`, `test-driven-development` | ours, Superpowers |
| the Api layer, endpoints, controllers | `dotnet-webapi` | .NET (`dotnet-aspnetcore`) |
| backend tests | `code-testing` | .NET (`dotnet-test`) |
| Infrastructure, `DbContext`, repositories (projects with EF Core) | `optimizing-ef-core-queries` | .NET (`dotnet-data`) |
| `src/**` | `forge-frontend`, `angular-developer`, `test-driven-development` | ours, Angular, Superpowers |
| a plan under `docs/forge/plans/` | `brainstorming`, `writing-plans` | Superpowers |
| ending a turn that changed production code | `verification-before-completion` | Superpowers |

A skill is asked for once per conversation (and once per agent, whose context is its own) and only when a file
of its kind is touched, so a frontend-only session never loads the .NET ones. The maintainer edits the rules; a Claude session cannot.

#### By step, not only by file

A file says what kind of code is being touched, not what is being done to it: building, fixing, restructuring
and reviewing can all touch the same file. A hook cannot see intent, but it does know which agent is acting,
and each step has its agent. So the skills of a step are tied to the agent that does it:

| Step | Who does it | Skills a hook holds it to |
|---|---|---|
| Design and plan | the main conversation | `brainstorming`, `writing-plans` (to write the plan) |
| Build | `forge-backend-dev`, `forge-frontend-dev` | ours for the zone, test-first, the official one for the file |
| Fix a bug | `forge-debugger` | `systematic-debugging` before its first edit, plus the build ones |
| Restructure or clean up | `forge-refactorer` | `csharp-refactoring` before it touches C#, plus the build ones |
| Review the tests | `forge-test-reviewer` | `assertion-quality`, `test-anti-patterns` before it may report; it cannot edit |
| Present as done | the main conversation | `verification-before-completion`; `forge-review` from medium risk; the test reviewer when tests changed |

What still rests on Claude is choosing the route. If it does a refactor itself instead of delegating it, the
file rules apply and the step rules do not; the route line at the top of each reply is where that shows.

What this proves is that the skill was loaded, not that it was followed. Where following it can be checked,
another control does it: `tdd` for test-first, `plan` for the approved plan, `verify` for the evidence.
`systematic-debugging` is the method for bugs, but nothing can tell a bug fix from a feature, so it stays an
instruction.

### Tools that answer instead of a guess

Setup also connects two kinds of tool, both official, so that Claude asks instead of remembering:

- **Language servers** (`csharp-lsp`, `typescript-lsp` from Anthropic's marketplace): the compiler's own errors
  after an edit, and "who uses this" before a rename, a deletion or a new helper that may already exist. Each
  plugin is only a pointer to a program on the machine (`csharp-ls`, `typescript-language-server`), so setup
  enables it only where that program is installed and prints the install command where it is not. inv-forge
  never installs them: they are global tools.
- **The Angular CLI's MCP server**, read-only tools only (`ng mcp --read-only`): best practices and
  documentation for the Angular version the project uses. Angular marks it experimental.

Nothing forces their use: the skills tell Claude to use them when present and to say so when they are not.

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

inv-forge uses knip when the project already has it (`knip` in `package.json`) to find unused files, exports
and dependencies in the frontend, and says so when it does not. It never installs it.

Mutation testing is deliberately not part of the toolkit: on a real project a run takes far longer than anyone
will wait for, so the check would never be used. Whether a test is worth having is judged in review.

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
   packages, metrics.

Known gaps: the agents preload only the skills that live in the project; whether a plugin skill can be
preloaded by name is not documented by Claude Code, so they load those as their first step, and a hook holds
them to it; a hand-built component where a Prismatic one exists is only caught by review; per-method
complexity on the frontend needs ESLint, which the starter does not ship; the plugins from the .NET marketplace
install at their latest version (the installed version is recorded, not pinned); the single-image Dockerfile
for a project with a backend is still set up by hand.
