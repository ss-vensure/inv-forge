#!/usr/bin/env node
'use strict';
// Stop. Runs when Claude is about to end its turn.
//   - "block" failures: exit 2, Claude has to keep working. After maxStopBlocks attempts in a
//     row the turn is released with a loud message to the user, so a session can never loop forever.
//   - advisories ("warn" findings, slice too large): reported back once per state of the
//     working tree, so Claude tells the user, and then the turn may end.
// Verification is skipped when the working tree is byte-for-byte what already passed.

const lib = require('../lib');
const checks = require('../checks');

const input = lib.readStdinJson();
const config = lib.loadConfig();
if (!config || !lib.isGitRepo()) process.exit(0);

const state = lib.loadState(input.session_id);
const files = lib.changedFiles();
const fp = lib.fingerprint(files);
const zones = checks.zonesTouched(config, files);

const failures = [];
const advisories = [];

// 1. Build and tests of what was touched.
const verifyMode = lib.mode(config, 'verify');
if (verifyMode !== 'off' && zones.length && state.lastVerified !== fp) {
  const failed = checks.describeFailures(checks.verify(config, zones));
  if (!failed) state.lastVerified = fp;
  else if (verifyMode === 'block') failures.push(failed);
  else advisories.push('Verification is failing (control "verify" is in warn mode):\n' + failed);
}

// 2. Slice size. Advisory locally (Claude cannot commit on its own); CI enforces it per PR.
if (lib.mode(config, 'changeSize') !== 'off') {
  const added = checks.productionAdded(config, files, lib.addedLines(files));
  if (added > config.changeSize.maxLines) {
    advisories.push(`This slice has ${added} added lines of uncommitted production code; the limit is ` +
      `${config.changeSize.maxLines}. Tell the user it is time to review and commit this slice before continuing.`);
  }
}

// 3. Findings collected in warn mode while editing.
if (state.warnings.length) {
  advisories.push('Rules broken during this turn (in warn mode, so not blocked):\n- ' + state.warnings.join('\n- '));
}

function finish(code, message) {
  lib.saveState(input.session_id, state);
  if (message) process.stderr.write(message + '\n');
  process.exit(code);
}

if (failures.length) {
  state.stopBlocks = (state.stopBlocks || 0) + 1;
  if (state.stopBlocks > config.maxStopBlocks) {
    state.stopBlocks = 0;
    lib.saveState(input.session_id, state);
    process.stdout.write(JSON.stringify({
      systemMessage: `inv-forge: verification is STILL FAILING after ${config.maxStopBlocks} attempts. ` +
        'The turn was released to avoid a loop. This work is not done.',
    }) + '\n');
    process.exit(0);
  }
  finish(2, 'inv-forge: this work is not finished. Fix the cause (do not silence it), then stop again.\n\n' + failures.join('\n\n'));
}

state.stopBlocks = 0;
if (advisories.length && state.lastAdvised !== fp) {
  state.lastAdvised = fp;
  state.warnings = [];
  finish(2, 'inv-forge: before ending the turn, report the following to the user in plain words:\n\n' + advisories.join('\n\n'));
}
finish(0);
