#!/usr/bin/env node
'use strict';
// PreToolUse (Edit | Write | MultiEdit). Decides whether an edit may happen.
// Exit 2 blocks the edit and feeds stderr back to Claude. Any other outcome lets it through.
// A control in "warn" mode never blocks: the finding is stored and reported when the turn ends.

const lib = require('../lib');

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

const zone = lib.zoneOf(config, rel);
if (zone) {
  // 3. The zone's rules must have been read in this session before code in it changes.
  if (zone.requiredSkill && !state.skills.includes(zone.requiredSkill)) {
    enforce('skills',
      `Load the "${zone.requiredSkill}" skill before editing ${zone.name} code (${rel}).\n` +
      `Invoke it with the Skill tool, follow it, then retry the edit.`);
  }

  // 4. Test first: behaviour changes need a test already in the working tree.
  if (lib.isTddProtected(zone, rel)) {
    if (!lib.isGitRepo()) {
      enforce('tdd', `Cannot check test-first for ${rel}: the project is not a git repository.`);
    } else {
      const hasTest = lib.changedFiles().some((f) => lib.isTest(zone, f.path));
      if (!hasTest) {
        enforce('tdd',
          `${rel} holds behaviour, and no ${zone.name} test has been added or changed yet.\n` +
          'Write the failing test first (named as a readable specification), run it and watch it fail, ' +
          'then make this edit. If this is a refactor with no behaviour change, say so to the user and ask ' +
          'how to proceed; do not work around this check.');
      }
    }
  }
}

lib.saveState(input.session_id, state);

if (blocks.length) {
  process.stderr.write('inv-forge blocked this edit:\n\n' + blocks.join('\n\n') + '\n');
  process.exit(2);
}
process.exit(0);
