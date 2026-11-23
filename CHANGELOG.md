# Changelog

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
