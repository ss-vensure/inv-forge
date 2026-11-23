#!/usr/bin/env node
'use strict';
// Makes /forge-setup available in every Claude Code session of this user by installing the
// skill at ~/.claude/skills/forge-setup, pointing at this clone. Run again after moving the clone.
//
//   node install.js            install or refresh
//   node install.js --remove   uninstall

const fs = require('fs');
const os = require('os');
const path = require('path');

const home = path.resolve(__dirname);
const dest = path.join(os.homedir(), '.claude', 'skills', 'forge-setup');

if (process.argv.includes('--remove')) {
  fs.rmSync(dest, { recursive: true, force: true });
  console.log(`Removed ${dest}`);
  process.exit(0);
}

const source = fs.readFileSync(path.join(home, 'skills', 'forge-setup', 'SKILL.md'), 'utf8');
fs.mkdirSync(dest, { recursive: true });
fs.writeFileSync(path.join(dest, 'SKILL.md'), source.split('{{FORGE_HOME}}').join(home.replace(/\\/g, '/')));
console.log(`Installed /forge-setup at ${dest}\nIt runs inv-forge from ${home}\nRestart Claude Code to pick it up.`);
