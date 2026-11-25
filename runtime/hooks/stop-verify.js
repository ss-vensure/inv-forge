#!/usr/bin/env node
'use strict';
// Stop and SubagentStop. Runs when Claude is about to end its turn, or one of the forge agents its job.
//   An agent is held to what it built: the cheap checks and the build and tests of its zone. What is
//   said to the user (risk, review, the finishing skill) belongs to the main conversation.
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

const agent = input.hook_event_name === 'SubagentStop' ? lib.AGENTS[input.agent_type] : null;
if (input.hook_event_name === 'SubagentStop' && !agent) process.exit(0); // not one of ours: nothing to hold it to

const state = lib.loadState(input.session_id);
const inZone = (name) => (f) => lib.matchAny(f.path, (config.zones[name] || {}).paths);
const all = lib.changedFiles();
const files = agent && agent.zone ? all.filter(inZone(agent.zone)) : all;
const fp = lib.fingerprint(all);
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
//    A zone is skipped when its files are byte-for-byte what already passed, whoever ran it.
state.verified = state.verified || {};
const zoneFp = (name) => lib.fingerprint(all.filter(inZone(name)));
const stale = zones.filter((name) => state.verified[name] !== zoneFp(name));
if (lib.mode(config, 'verify') !== 'off' && stale.length) {
  const results = checks.verify(config, stale);
  for (const name of stale) if (results.every((r) => r.zone !== name || r.ok)) state.verified[name] = zoneFp(name);
  const failed = checks.describeFailures(results);
  if (failed) report('verify', lib.mode(config, 'verify') === 'block' ? failed : 'Verification is failing:\n' + failed);
}

if (agent) {
  // The skills of this step: an agent does not report before it has loaded them.
  const mine = lib.loadedSkills(input, state);
  const owed = lib.agentRequires(config, input.agent_type, 'beforeDone').filter((s) => !mine.includes(s));
  if (owed.length && lib.mode(config, 'skills') === 'block') {
    failures.push(`Load ${owed.map((s) => `"${s}"`).join(', ')} with the Skill tool and apply them to what you reviewed before you report. ` +
      'If one does not exist in this session, say so in your report instead of finishing without it.');
  }
  const key = `agentStopBlocks_${input.agent_type}`;
  if (!failures.length) state.agentsDone = [...new Set((state.agentsDone || []).concat(input.agent_type))];
  if (!failures.length || (state[key] || 0) >= config.maxStopBlocks) {
    state[key] = 0;
    lib.saveState(input.session_id, state);
    if (failures.length) process.stderr.write('inv-forge: this agent stopped with failing checks. Its work is NOT done.\n');
    process.exit(0);
  }
  state[key] = (state[key] || 0) + 1;
  lib.saveState(input.session_id, state);
  process.stderr.write('inv-forge: this slice is not finished. Fix the cause (do not silence it), then finish again.\n\n' +
    failures.join('\n\n') + '\n');
  process.exit(2);
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

// 4b. Tests are what the human reads instead of the code, so a change to them is reviewed by the agent
//     that carries the test-quality skills, not by whoever wrote them.
const testsChanged = files.some((f) => { const z = lib.zoneOf(config, f.path); return z && lib.isTest(z, f.path); });
if (production > 0 && testsChanged && risk.TIERS.indexOf(riskReport.tier) >= risk.TIERS.indexOf(reviewFrom) &&
    !(state.agentsDone || []).includes('forge-test-reviewer')) {
  report('review', 'The tests of this change were not reviewed. Launch the "forge-test-reviewer" agent on the uncommitted ' +
    'changes (it is the Tests lens of forge-review), fix what it confirms, and include its result in your report.');
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
