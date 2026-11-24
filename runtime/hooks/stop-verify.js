#!/usr/bin/env node
'use strict';
// Stop. Runs when Claude is about to end its turn.
//   - "block" failures: exit 2, Claude has to keep working. After maxStopBlocks attempts in a
//     row the turn is released with a loud message to the user, so a session can never loop forever.
//   - advisories ("warn" findings, high-risk files, exceptions used, slice too large): reported
//     back once per state of the working tree, so Claude tells the user, and then the turn may end.
// Build and tests are skipped when the working tree is byte-for-byte what already passed.

const fs = require('fs');
const path = require('path');
const lib = require('../lib');
const checks = require('../checks');
const rules = require('../rules');
const risk = require('../risk');
const diffchecks = require('../diffchecks');

const input = lib.readStdinJson();
const config = lib.loadConfig();
if (!config || !lib.isGitRepo()) process.exit(0);

const state = lib.loadState(input.session_id);
const files = lib.changedFiles();
const fp = lib.fingerprint(files);
const zones = checks.zonesTouched(config, files);

const failures = [];
const advisories = [];
// A finding blocks or is merely reported, depending on its control's mode.
function report(control, text) {
  const m = lib.mode(config, control);
  if (m === 'block') failures.push(text);
  else if (m === 'warn') advisories.push(text + `\n(control "${control}" is in warn mode)`);
}

// Added text of the uncommitted work, including whole new files.
const addedText = checks.addedTextFromPatch(lib.git(['diff', '--unified=0', 'HEAD']));
for (const f of files.filter((x) => x.status === '??')) {
  try { addedText[f.path] = fs.readFileSync(path.join(lib.ROOT, f.path), 'utf8'); } catch (_) { /* unreadable */ }
}

// 1. Cheap checks first, so they are read before any long build output.
if (files.length) {
  const groups = rules.newViolations(config, files.map((f) => f.path))
    .filter((g) => !lib.activeException('architecture/' + g.rule, g.file));
  if (groups.length) report('architecture', 'Structure rules broken by the uncommitted changes:\n\n' + rules.describe(groups));

  const security = diffchecks.security(config, addedText);
  if (security.hits.length) {
    report('security', 'Secrets or real personal data in the uncommitted changes. Remove them (and rotate any real secret):\n' + diffchecks.describe(security.hits));
  }

  const dead = diffchecks.deadCode(config, addedText);
  if (dead.hits.length) {
    report('deadCode', 'Leftovers that become legacy. Delete them or finish them now:\n' + diffchecks.describe(dead.hits));
  }
}

// 2. Build and tests of what was touched.
if (lib.mode(config, 'verify') !== 'off' && zones.length && state.lastVerified !== fp) {
  const failed = checks.describeFailures(checks.verify(config, zones));
  if (!failed) state.lastVerified = fp;
  else report('verify', lib.mode(config, 'verify') === 'block' ? failed : 'Verification is failing:\n' + failed);
}

// 3. What the user has to hear about, whatever the modes.
const riskReport = risk.classify(config, files, addedText, lib.addedLines(files));
const high = riskReport.files.filter((f) => f.tier === 'high');
if (high.length) {
  advisories.push('This change touches HIGH-RISK areas. Tell the user these need their own detailed review:\n' +
    high.map((f) => `- ${f.path} (${f.reasons.join('; ')})`).join('\n'));
}

// 4. Independent review: from a given risk tier up, the change is reviewed by agents that did
//    not write it before it is presented as done.
const production = checks.productionAdded(config, files, lib.addedLines(files));
const reviewFrom = (config.review && config.review.requiredFromRisk) || 'medium';
if (production > 0 && risk.TIERS.indexOf(riskReport.tier) >= risk.TIERS.indexOf(reviewFrom) && !state.skills.includes('forge-review')) {
  report('review', `This change is ${riskReport.tier.toUpperCase()} risk and has not been independently reviewed in this session.\n` +
    'Load the "forge-review" skill and run it on the uncommitted changes, fix what it confirms, and include its result in your report.');
}

// 5. Work is not presented as done before the skills for finishing it were loaded.
const beforeDone = ((config.method && config.method.beforeDone) || []).filter((s) => !state.skills.includes(s));
if (production > 0 && beforeDone.length) {
  report('skills', `Production code changed and ${beforeDone.map((s) => `"${s}"`).join(', ')} was not loaded in this session.
` +
    'Load it with the Skill tool and follow it before presenting this work as done.');
}

if (lib.mode(config, 'changeSize') !== 'off' && production > config.changeSize.maxLines) {
  advisories.push(`This slice has ${production} added lines of uncommitted production code; the limit is ` +
    `${config.changeSize.maxLines}. Tell the user it is time to review and commit this slice before continuing.`);
}

if (state.warnings.length) {
  advisories.push('Rules broken during this turn (in warn mode, so not blocked):\n- ' + state.warnings.join('\n- '));
}
if (state.exceptionsUsed.length) {
  advisories.push('Exceptions granted by the maintainer were used in this turn. Tell the user which ones:\n- ' + state.exceptionsUsed.join('\n- '));
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
      systemMessage: `inv-forge: checks are STILL FAILING after ${config.maxStopBlocks} attempts. ` +
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
  state.exceptionsUsed = [];
  finish(2, 'inv-forge: before ending the turn, report the following to the user in plain words:\n\n' + advisories.join('\n\n'));
}
finish(0);
