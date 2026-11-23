# Changelog

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
