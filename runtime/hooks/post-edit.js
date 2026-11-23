#!/usr/bin/env node
'use strict';
// PostToolUse (Edit | Write | MultiEdit). Checks the structure rules on the file as it now is.
// Exit 2 does not undo the edit: it hands the finding straight back to Claude, which has to fix
// it. Anything left unfixed is caught again when the turn ends, and in CI.

const lib = require('../lib');
const rules = require('../rules');

const input = lib.readStdinJson();
const config = lib.loadConfig();
const rel = lib.relPath((input.tool_input || {}).file_path);
const mode = lib.mode(config, 'architecture');
if (!config || !rel || mode === 'off') process.exit(0);

const groups = rules.newViolations(config, [rel]);
if (!groups.length) process.exit(0);

if (mode === 'warn') {
  const state = lib.loadState(input.session_id);
  for (const g of groups) {
    const note = `[architecture/${g.rule}] ${g.file}: ${g.found - g.allowed} new`;
    if (!state.warnings.includes(note)) state.warnings.push(note);
  }
  lib.saveState(input.session_id, state);
  process.exit(0);
}

process.stderr.write(
  'inv-forge: the edit was applied, but it breaks a structure rule (a rule doing its job, not a malfunction).\n' +
  'Fix the code now; do not move the problem elsewhere or silence it.\n\n' + rules.describe(groups) + '\n');
process.exit(2);
