#!/usr/bin/env node
'use strict';
// PreToolUse (Bash). Closes the obvious way around pre-edit.js: changing the forge's own files
// or the hook wiring from the shell. Reading them, and running the forge's checker, stay allowed.
// It is an allowlist on purpose: a command that mentions those paths passes only when every
// part of it is a known read-only command.

const lib = require('../lib');

const input = lib.readStdinJson();
const config = lib.loadConfig();
const command = String((input.tool_input || {}).command || '');
if (!config || lib.mode(config, 'protected') !== 'block' || !command) process.exit(0);

const guarded = /\.claude[\\/]+(forge\b|settings\.json)/;
if (!guarded.test(command)) process.exit(0);

const READ_ONLY = new RegExp('^(' + [
  'cat', 'head', 'tail', 'grep', 'rg', 'ls', 'dir', 'wc', 'type', 'stat', 'file', 'jq', 'diff',
  'git\\s+(status|diff|log|show|ls-files|blame)',
  'node\\s+["\']?(\\.[\\\\/])?\\.claude[\\\\/]forge[\\\\/]check\\.js',
].join('|') + ')(\\s|$)');

const plain = command.replace(/\s2>(&1|\/dev\/null|\$null)/g, ' ');
const segments = plain.split(/&&|\|\||[;|\n]/).map((s) => s.trim()).filter(Boolean);
const readOnly = !/[<>`]|\$\(/.test(plain) && segments.every((s) => READ_ONLY.test(s));

if (!readOnly) {
  process.stderr.write(
    'inv-forge blocked this command (this is the "protected" control working, not a malfunction): ' +
    'it could change .claude/forge or the hook wiring in .claude/settings.json.\n' +
    'Reading those files is fine (Read tool, or cat/grep/git diff on their own). Changing them is the ' +
    'maintainer\'s decision: stop and ask the user. The only forge command a session runs is ' +
    '`node .claude/forge/check.js`.\n');
  process.exit(2);
}
process.exit(0);
