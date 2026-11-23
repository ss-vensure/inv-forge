#!/usr/bin/env node
'use strict';
// PreToolUse (Bash). Closes the obvious way around pre-edit.js: changing the forge's own
// files or the hook wiring from the shell. Running the forge's checker stays allowed.

const lib = require('../lib');

const input = lib.readStdinJson();
const config = lib.loadConfig();
const command = String((input.tool_input || {}).command || '');
if (!config || lib.mode(config, 'protected') !== 'block' || !command) process.exit(0);

const touchesForge = /\.claude[\\/]+forge\b/.test(command);
const runsChecker = /^\s*node\s+["']?(\.[\\/])?\.claude[\\/]forge[\\/]check\.js\b[^;&|<>]*$/.test(command);
// Writing to settings.json from the shell would let the hooks be removed.
const writesSettings = /(>|\bsed\b[^|]*-i|\btee\b|\bmv\b|\bcp\b|\brm\b|Set-Content|Out-File)[^|;&]*\.claude[\\/]+settings\.json/.test(command);

if ((touchesForge && !runsChecker) || writesSettings) {
  process.stderr.write(
    'inv-forge blocked this command: it touches .claude/forge or the hook wiring in .claude/settings.json.\n' +
    'Read those files with the Read tool if you need to see them. Changing them is the maintainer\'s ' +
    'decision: stop and ask the user. The only forge command a session runs is `node .claude/forge/check.js`.\n');
  process.exit(2);
}
process.exit(0);
