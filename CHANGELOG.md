# Changelog

## 0.3.1

- Removed the `mutation` control, `check.js --mutation` and the Stryker detection: a run takes too long on a
  real project to be used. Updating a project drops `mutation` from its `config.json`.

## 0.3.0

Continuous quality, and a decision: the checks run locally only.

- **Local by design.** Setup no longer writes a CI example or asks for a CI step; `--ci-example` writes one on
  request.
- **Exceptions.** `setup.js --except <control> --paths ... --reason ... [--days N]`, `--exceptions`, `--revoke`.
  For named files, with a reason, at most 90 days, never for `protected`. Only the maintainer grants them;
  every use is reported at the end of the turn, at session start and in the review packet.
- New controls:
  - `security`: secrets in any file, real personal data in tests and fixtures (on edit and at end of turn).
  - `deadCode`: commented-out code and ownerless TODOs in a change; unused-code tools when configured.
  - `plan`: past a size threshold, edits need a plan the user approved. Claude cannot write the approval.
  - `review`: from medium risk up, the turn cannot end before the `forge-review` skill has run.
  - `audit` (`check.js --audit`) and `mutation` (`check.js --mutation`), on request.
- New skill `forge-review`: one reviewer per lens, then an attempt to refute each finding.
- Metrics: every `check.js` run is recorded locally; `check.js --metrics` shows the history and the backlog.
- Scaffold wires the dev loop: `npm run api`, `npm run test:api` and the Angular dev-server proxy.
- Setup detects knip and Stryker, records the installed version of each plugin, and fills in tool commands for
  a project that gains a tool after it was installed.
- Result file schema is now 2 (adds `productionLines` and `exceptionsUsed`).

## 0.2.1

Refinements from the live test of the structure rules (every hook fired with the right rule).

- Test-first needs a test to be declared in the change: an empty test file no longer unlocks behaviour code.
- When a turn is refused, the structure rules are listed before the build output.
- Files in the Api layer are at least medium risk.
- Terminal colour codes are stripped from reported command output.
- The shell guard accepts `echo` next to a read-only command.

## 0.2.0

Structure and directed review.

- New control `architecture`: structure rules checked after every edit, when a turn ends and in CI.
  Backend: `layer-references`, `api-data-access`, `domain-purity`, `application-purity`, `query-in-loop`,
  `dto-record`, `anonymous-response`. Frontend: `component-http`, `library-style-override`, `library-patched`,
  `no-any`. Both: `file-size`.
- Baseline (`arch-baseline.json`): existing violations are tolerated, new ones are refused, so the control
  runs in `block` on legacy projects. `setup.js --baseline` re-records it; sessions are blocked from running it.
- Risk classification of every change (high / medium / low), reported when a turn ends and in `check.js`.
- Review packet: `check.js --packet`.
- Backend scaffold: `setup.js --scaffold-backend <Name> [--efcore]`. Four layers, zero warnings, dead-code and
  complexity analyzers; with `--efcore`, SQLite-backed endpoint tests and a query counter for N+1 tests.
- Setup fills in verify commands for a zone that was configured before its code existed.

## 0.1.2

Fixes from the first live session in a real project.

- Setup now installs the plugins through the Claude CLI; listing them in settings was not enough, so sessions started without Superpowers.
- `--check` reports plugins that are not installed on the machine.
- The shell guard allows read-only commands on .claude/forge and settings.json; it used to block any mention of them.
- Block messages say they are a rule working, not a hook malfunction.
- The session-start text tells Claude to report a missing skill instead of assuming it is there.

## 0.1.1

- Verify commands fall back to Edge when a Windows machine has no Chrome, so Karma tests can run.

## 0.1.0

First version: the base.

- `/forge-setup` skill and installer (`setup/setup.js`): idempotent, with `--check`, `--preset` and `--set`.
- Controls with `off` / `warn` / `block` modes: `skills`, `tdd`, `suppressions`, `protected`, `verify`, `changeSize`.
- Hooks: session start (method and rules), pre-edit, pre-bash, skill log, stop (verification).
- `check.js` for CI and manual runs, with a fixed-format result file.
- Skills `forge-backend` and `forge-frontend`.
- Installs Superpowers and the official .NET plugins; vendors the official Angular skill at a pinned commit.
