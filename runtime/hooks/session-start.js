#!/usr/bin/env node
'use strict';
// SessionStart. Whatever this prints becomes context for the session: the working method,
// which skill governs which folder, and what the machine will refuse.

const fs = require('fs');
const path = require('path');
const lib = require('../lib');

const config = lib.loadConfig();
if (!config) process.exit(0);

const manifest = lib.readJson(path.join(lib.FORGE_DIR, 'forge.json'), {});
const out = [];
const m = (c) => lib.mode(config, c);

out.push(`# inv-forge ${manifest.version || ''} is active in this project`);
out.push('This is an Innovation-owned app. The rules below are checked by hooks on this machine; they are not suggestions.');
out.push('');
out.push('## How work is done here');
out.push('Every request is routed first: a note added to each user message lists the routes (question, small, feature, bug, ' +
  'refactor). You declare the route in the first line of your reply and follow it. The user never has to ask for it.');
out.push('1. New feature or behaviour change: use superpowers:brainstorming, then superpowers:writing-plans. ' +
  `Save the plan under ${config.plansDir}/ with a line "Status: proposed" and wait for the user to approve it before ` +
  'writing code. The plan states the acceptance criteria, the data model and the API contract. The user approves by ' +
  'changing that line to "Status: approved"; you never write the approval yourself.' +
  (config.plan ? ` Past ${config.plan.requiredFromLines} added lines of production code, edits are refused without an approved plan.` : ''));
out.push('2. Bug: use superpowers:systematic-debugging. Find the root cause before changing code.');
out.push('3. Test first (superpowers:test-driven-development). Tests are the specification a human reviews: ' +
  'name them as readable behaviour (given / when / then) and write one per acceptance criterion.');
out.push(`4. Work in vertical slices of at most ${config.changeSize.maxLines} added lines of production code. ` +
  'When a slice works, tell the user it is ready to commit before starting the next.');
out.push('5. Before saying anything is done: superpowers:verification-before-completion. ' +
  'Report what you ran, what passed, and explicitly what you did NOT verify.');
out.push(`6. A change of ${(config.review && config.review.requiredFromRisk) || 'medium'} risk or higher is reviewed by agents that did not write it: ` +
  'load the "forge-review" skill and run it before presenting the change as done.');
out.push('7. When a slice is ready for review, run `node .claude/forge/check.js --packet`, read the packet it writes, and give ' +
  'it to the user with the "From the author" section completed truthfully. High-risk files get a detailed review by the user.');
out.push('8. Clean as you go: delete what you replace in the same slice. No commented-out code, no TODO without an owner, ' +
  'no secret and no real personal data in any file.');
out.push('9. Never silence a check, skip a test, or edit .claude/forge. If a rule cannot be met, stop and tell the user why: ' +
  'only they can grant an exception, for named files, with a reason and an expiry date.');
out.push('');
out.push('If a skill named here (superpowers:*, the dotnet plugins, angular-developer) is not available in this session, ' +
  'say so to the user at once - the plugin is not installed and /forge-setup should be run again - and still follow ' +
  'the method above. Never pretend to have used a skill you could not load.');
out.push('');
out.push('## Skills you must load before editing (checked by a hook, per file)');
for (const rule of config.skillRules || []) {
  out.push(`- ${rule.paths.join(', ')} -> ${rule.skills.join(', ')}${rule.why ? ` (${rule.why})` : ''}`);
}
const beforeDone = (config.method && config.method.beforeDone) || [];
if (beforeDone.length) out.push(`- before ending a turn that changed production code -> ${beforeDone.join(', ')}`);
out.push('A skill of a plugin is invoked by its full name (superpowers:brainstorming, dotnet-aspnetcore:dotnet-webapi). ' +
  'Loading a skill is not the point; following it is. The other skills of those plugins are there to be used when they fit.');
out.push('');
out.push('## Controls (off / warn / block)');
out.push(`- skills: ${m('skills')} - the skills listed above must be loaded before the edit, or before the turn ends`);
out.push(`- tdd: ${m('tdd')} - a test must change before behaviour code changes`);
out.push(`- suppressions: ${m('suppressions')} - no pragma/NoWarn/eslint-disable/skipped tests/::ng-deep`);
out.push(`- protected: ${m('protected')} - .claude/forge, hook wiring and vendor packages are read-only`);
out.push(`- architecture: ${m('architecture')} - layers, no data access in the Api layer, no query in a loop, libraries used as shipped, file size (existing violations are in the baseline; adding one is refused)`);
out.push(`- verify: ${m('verify')} - build and tests of the touched zone must pass before the turn ends`);
out.push(`- changeSize: ${m('changeSize')} - slice size limit`);
out.push(`- plan: ${m('plan')} - an approved plan before a change grows past the size threshold`);
out.push(`- security: ${m('security')} - no secrets; no real personal data in tests or fixtures`);
out.push(`- deadCode: ${m('deadCode')} - no commented-out code or ownerless TODO in a change; unused-code tools when configured`);
out.push(`- review: ${m('review')} - independent review (forge-review) from ${(config.review && config.review.requiredFromRisk) || 'medium'} risk up`);
out.push(`- audit: ${m('audit')} - vulnerable packages, on request: check.js --audit`);

// Exceptions the maintainer has granted, and the ones that ran out.
const exceptions = lib.loadExceptions();
if (exceptions.length) {
  out.push('');
  out.push('## Exceptions granted by the maintainer');
  for (const e of exceptions) {
    out.push(`- ${lib.isExpired(e) ? 'EXPIRED' : 'active'}: ${e.control} on ${(e.paths || []).join(', ')} until ${e.expires} - ${e.reason}`);
  }
  if (exceptions.some(lib.isExpired)) out.push('Expired exceptions no longer apply: the rule is back in force. Tell the user they can be removed.');
}

// Drift: a starter /upgrade can rewrite .claude/settings.json and drop some of the wiring.
const settings = lib.readJson(path.join(lib.ROOT, '.claude', 'settings.json'), {});
const wired = JSON.stringify(settings.hooks || {});
const missing = ['pre-edit.js', 'pre-bash.js', 'skill-log.js', 'post-edit.js', 'stop-verify.js', 'prompt-route.js'].filter((f) => !wired.includes(f));
const lost = ['lib.js', 'check.js'].filter((f) => !fs.existsSync(path.join(lib.FORGE_DIR, f)));
if (missing.length || lost.length) {
  out.push('');
  out.push('## WARNING: inv-forge is partly uninstalled');
  out.push(`Missing: ${[...missing, ...lost].join(', ')}. Tell the user now and ask them to run /forge-setup again ` +
    '(this usually follows a starter /upgrade). Do not continue as if the checks were running.');
}

process.stdout.write(out.join('\n') + '\n');
process.exit(0);
