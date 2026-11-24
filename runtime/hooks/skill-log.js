#!/usr/bin/env node
'use strict';
// PostToolUse (Skill | Read). Records which skills this session has actually loaded, so
// pre-edit.js can require a zone's skill before code in that zone changes.
// Reading a skill's SKILL.md counts too: it is the same content by another route.
// Inside a subagent the record is that agent's own: its context is not the main conversation's.

const lib = require('../lib');

const input = lib.readStdinJson();
const ti = input.tool_input || {};
const names = [];

if (input.tool_name === 'Skill' && ti.skill) {
  const full = String(ti.skill);
  names.push(full, full.split(':').pop()); // "plugin:skill" also counts as "skill"
} else if (input.tool_name === 'Read' && ti.file_path) {
  const m = /[\\/]skills[\\/]([^\\/]+)[\\/]SKILL\.md$/i.exec(String(ti.file_path));
  if (m) names.push(m[1]);
}

if (names.length) lib.recordSkills(input, names);
process.exit(0);
