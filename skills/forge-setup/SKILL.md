---
name: forge-setup
description: Equip an Innovation-owned app with inv-forge - the skills, hooks and CI gates that enforce clean architecture, test-first development and zero technical debt. Use when the user runs /forge-setup, asks to set up or update inv-forge in a project, or when a session reports that inv-forge is partly uninstalled (typically after a starter /upgrade). Only for apps the Innovation team builds and maintains itself; never for RAiCE starter projects owned by RAiCErs.
---

# /forge-setup

inv-forge lives at `{{FORGE_HOME}}`. The installer does the work; your job is to run it, tune the result to this
project with the user, and report honestly. Do not hand-edit anything under `.claude/forge/`.

## 1. Check this is the right project

- It must be an app the Innovation team owns. If it looks like a RAiCEr's starter project, stop and ask.
- It must be a git repository with a `package.json`. A fresh starter needs its own `/setup` first
  (`raice.json` exists afterwards).
- If the working tree has uncommitted changes, tell the user: setup edits `.claude/settings.json`, `CLAUDE.md`
  and `.gitignore`, and a clean tree makes its diff easy to review.

## 2. Run the installer

```bash
node "{{FORGE_HOME}}/setup/setup.js" .
```

It is safe to run again: it replaces its own runtime, keeps the project's `config.json` values, and never
duplicates wiring. It auto-detects the preset (`new`: every control blocks; `existing`: `tdd` and `changeSize`
start in `warn`). Pass `--preset new|existing` only if the user disagrees with the detection.

Read the whole report. It ends with `RESULT: ok` or `RESULT: failed`.

### If the project has no backend yet

Ask the user whether this app needs one. If it does, create it in four layers (Domain, Application,
Infrastructure, Api) instead of writing it by hand:

```bash
node "{{FORGE_HOME}}/setup/setup.js" . --scaffold-backend Acme.Billing            # no database
node "{{FORGE_HOME}}/setup/setup.js" . --scaffold-backend Acme.Billing --efcore   # EF Core + query counter
```

The name is the .NET root namespace; ask the user for it. The scaffold builds with zero warnings and its tests
pass as generated: run `dotnet build` and `dotnet test` on the new solution and confirm before going on. It does
not wire `npm run api`, the dev proxy or the Dockerfile; say so.

## 3. Tune it with the user

Change settings only through the installer, and only with the user's explicit agreement for each one:

```bash
node "{{FORGE_HOME}}/setup/setup.js" . --set controls.tdd=warn
node "{{FORGE_HOME}}/setup/setup.js" . --set 'zones.backend.verify=["dotnet build \"api/App.slnx\" --nologo -v q"]'
```

Go through these with them:

1. **Verify commands.** Run each one listed in the report now. A command that fails today, or needs a
   database or other service that is not always available locally, must not stay in `verify`: move it to that
   zone's `verifyCi` (CI only) and say so. Verification that blocks on something unrelated to the change gets
   switched off, which is worse than not having it.
2. **Test-first zones.** Show the `tdd.protected` and `tdd.exempt` globs of each zone and check they match where
   behaviour really lives in this project.
3. **Control modes.** For an existing project, name each control that is in `warn` and what has to be migrated
   before it can move to `block`. The user decides every mode; never lower one yourself.
4. **Structure-rule baseline.** The report lists existing violations per rule. These are tolerated, and nothing
   new is. Read the numbers to the user: they are the migration backlog. After code is migrated, the maintainer
   shrinks the baseline with `--baseline`; never run that yourself to make a failing check pass.
5. **CI.** If the report says CI does not run the forge checks, show `.claude/forge/ci-example.yml` and propose
   the exact step to add to the project's existing workflow. Add it only if the user agrees.

## 4. Confirm

```bash
node "{{FORGE_HOME}}/setup/setup.js" . --check
```

Then tell the user, plainly:

- what was installed and which controls are in which mode;
- which verify commands you ran and whether they passed;
- what is **not** done or not verified (CI not wired, a command moved to CI-only, a skill that failed to download);
- that they must **restart the Claude session** for the hooks and plugins to load, and review and commit the diff.

## After a starter /upgrade

The upgrade can rewrite `.claude/settings.json` and `CLAUDE.md`. Run step 2 again, then step 4. Nothing else is
needed: the project's `config.json` is untouched by both tools.
