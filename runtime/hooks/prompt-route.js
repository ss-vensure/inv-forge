#!/usr/bin/env node
'use strict';
// UserPromptSubmit. Runs on every message the user sends, before Claude reads it. What it prints
// becomes context: the routes, so the kind of work decides the method without the user choosing one.
// It classifies nothing itself: Claude declares the route, in the open, where the user can correct it.

const lib = require('../lib');

const input = lib.readStdinJson();
const config = lib.loadConfig();
const prompt = String(input.prompt || '').trim();
// Slash commands carry their own instructions; a subagent already has its job.
if (!config || !prompt || prompt.startsWith('/') || input.agent_id) process.exit(0);

const agents = Object.entries(lib.AGENTS)
  .filter(([, a]) => !a.zone || (config.zones && config.zones[a.zone]))
  .map(([name]) => name);
const zoneAgents = agents.filter((a) => lib.AGENTS[a].zone);
const limit = (config.plan && config.plan.requiredFromLines) || 150;

const out = [
  'inv-forge: route this request before doing anything else. Start your reply with one line, ' +
    '"Route: <name> - <reason in a few words>", so the user can correct it. If it continues work already routed, ' +
    'write "Route: continuing <name>". Between two routes, take the heavier one.',
  '- question: explain or investigate; no file changes. Just answer.',
  `- small: one zone, a few files, well under ${limit} added lines. Do it yourself: test first, change, verify.`,
  '- feature: superpowers:brainstorming with the user, then superpowers:writing-plans; save the plan as "Status: proposed" ' +
    `and wait for the user to approve it. Then delegate each zone to its agent (${zoneAgents.join(', ') || 'none installed'}), ` +
    'one at a time, giving it the plan path and the slice to build. When they are done, run forge-review and report.',
  agents.includes('forge-debugger')
    ? '- bug: delegate to the forge-debugger agent with the symptom and how to reproduce it. It finds the root cause, ' +
      'writes the failing test, then fixes. Do not patch a symptom yourself.'
    : '- bug: superpowers:systematic-debugging. Root cause, failing test, then the fix.',
  '- refactor: no behaviour change. Tests green before and after; past "small", delegate to the zone agent.' +
    (config.zones && config.zones.backend ? ' For C#, whoever does it loads dotnet:csharp-refactoring first.' : ''),
  'The agents are born with their skills; you still check their work (the diff, the test output) before telling the user it is done.',
];
process.stdout.write(out.join('\n') + '\n');
process.exit(0);
