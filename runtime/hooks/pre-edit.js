#!/usr/bin/env node
'use strict';
// PreToolUse (Edit | Write | MultiEdit). Decides whether an edit may happen.
// Exit 2 blocks the edit and feeds stderr back to Claude. Any other outcome lets it through.
// A control in "warn" mode never blocks: the finding is stored and reported when the turn ends.
// An exception granted by the maintainer lets the edit through and is reported the same way.

const lib = require('../lib');
const checks = require('../checks');
const diffchecks = require('../diffchecks');

const input = lib.readStdinJson();
const config = lib.loadConfig();
const ti = input.tool_input || {};
const rel = lib.relPath(ti.file_path);
if (!config || !rel) process.exit(0);

const edits = Array.isArray(ti.edits) ? ti.edits : [];
const before = [ti.old_string || '', ...edits.map((e) => e.old_string || '')].join('\n');
const after = [ti.content || '', ti.new_string || '', ...edits.map((e) => e.new_string || '')].join('\n');

const state = lib.loadState(input.session_id);
const blocks = [];

function enforce(control, message) {
  const m = lib.mode(config, control);
  if (m === 'off') return;
  const exception = control === 'protected' ? null : lib.activeException(control, rel);
  if (exception) {
    const note = `${control} on ${rel}: exception "${exception.reason}" until ${exception.expires}`;
    if (!state.exceptionsUsed.includes(note)) state.exceptionsUsed.push(note);
    return;
  }
  if (m === 'warn') {
    const note = `[${control}] ${rel}: ${message.split('\n')[0]}`;
    if (!state.warnings.includes(note)) state.warnings.push(note);
    return;
  }
  blocks.push(`[${control}] ${message}`);
}

// 1. Files nobody edits through Claude: the forge itself, its switchboard, vendor packages.
if (lib.matchAny(rel, config.protected) && !rel.startsWith('.claude/forge/.state/')) {
  enforce('protected',
    `${rel} is protected by inv-forge and is not edited from a Claude session.\n` +
    'Control modes and exceptions are the maintainer\'s decision: stop and ask the user. ' +
    'Third-party components (Prismatic, Syncfusion) are consumed as shipped, never patched.');
}

// 2. Silencing a check instead of fixing the cause.
const added = lib.newSuppressions(before, after);
if (added.length) {
  enforce('suppressions',
    `This edit adds ${added.join(', ')} in ${rel}.\n` +
    'Fix the cause instead of silencing the check. If an exception is truly needed, ' +
    'stop and ask the user: only they can authorise one.');
}

// 3. Secrets, and real personal data in tests or fixtures.
const had = diffchecks.securityIn(config, rel, before);
const sensitive = diffchecks.securityIn(config, rel, after).filter((n) => !had.includes(n));
if (sensitive.length) {
  enforce('security',
    `This edit would put a ${sensitive.join(' and a ')} in ${rel}.\n` +
    'Secrets come from user-secrets or environment variables, never from a file in the repository. ' +
    'Test data is invented: fake names, and addresses on example.test.');
}

// 4. A plan is approved by a person. Claude does not write the approval.
const plansDir = String(config.plansDir || '').replace(/\/+$/, '');
const APPROVAL = /^\s*Status:\s*approved\b/im;
if (plansDir && rel.startsWith(plansDir + '/') && APPROVAL.test(after) && !APPROVAL.test(before)) {
  enforce('plan',
    `"Status: approved" in ${rel} is written by the user, not by Claude.\n` +
    'Save the plan with "Status: proposed", show it to the user, and wait for them to approve it.');
}

// 5. The skills that govern this file (ours and the official ones) must have been loaded in
//    this session before it changes.
const loaded = lib.loadedSkills(input, state);
const unread = lib.skillsFor(config, rel).filter((s) => !loaded.includes(s));
if (unread.length) {
  enforce('skills',
    `Load ${unread.map((s) => `"${s}"`).join(', ')} before editing ${rel}.\n` +
    'Invoke each with the Skill tool, follow it, then retry the edit. If one of them does not exist in this ' +
    'session, its plugin is not installed: stop and tell the user to run /forge-setup again.');
}

const zone = lib.zoneOf(config, rel);

// 5b. An agent that builds one zone stays in it.
const own = (lib.AGENTS[input.agent_type] || {}).zone;
if (input.agent_id && own && zone && zone.name !== own) {
  blocks.push(`[agent] The ${input.agent_type} agent builds the ${own} zone only, and ${rel} is ${zone.name} code.\n` +
    'Report what this slice needs there instead of writing it.');
}

if (zone) {
  const production = !lib.isTest(zone, rel);
  const git = lib.isGitRepo();

  // 6. Test first: behaviour changes need a test already declared in the working tree.
  if (lib.isTddProtected(zone, rel)) {
    if (!git) {
      enforce('tdd', `Cannot check test-first for ${rel}: the project is not a git repository.`);
    } else if (!lib.hasNewTest(zone)) {
      enforce('tdd',
        `${rel} holds behaviour, and the uncommitted work declares no new ${zone.name} test yet (an empty test file does not count).\n` +
        'Write the failing test first (named as a readable specification), run it and watch it fail, ' +
        'then make this edit. If this is a refactor with no behaviour change, say so to the user and ask ' +
        'how to proceed; do not work around this check.');
    }
  }

  // 7. Past a certain size, a change needs a plan the user approved before the code is written.
  if (production && git && lib.mode(config, 'plan') !== 'off' && config.plan) {
    const files = lib.changedFiles();
    const size = checks.productionAdded(config, files, lib.addedLines(files));
    if (size >= config.plan.requiredFromLines && !checks.approvedPlan(config, files)) {
      enforce('plan',
        `This change already adds ${size} lines of production code and there is no approved plan for it.\n` +
        `Stop coding. Write the plan under ${plansDir}/ (acceptance criteria, data model, API contract) with ` +
        '"Status: proposed", show it to the user, and continue only after they change it to "Status: approved".');
    }
  }
}

lib.saveState(input.session_id, state);

if (blocks.length) {
  process.stderr.write('inv-forge blocked this edit (a rule doing its job, not a malfunction):\n\n' + blocks.join('\n\n') + '\n');
  process.exit(2);
}
process.exit(0);
