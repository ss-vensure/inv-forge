'use strict';
// The review packet: one page that lets a person review a change without reading every line.
// Everything a machine can know is filled in here. The author's section is left as explicit
// blanks, because only the author knows what was decided and what was not verified.

const lib = require('./lib');

// Names of tests the change adds or edits, read from the added lines of test files.
function testNames(config, addedText) {
  const names = [];
  for (const [file, text] of Object.entries(addedText || {})) {
    const zone = lib.zoneOf(config, file);
    if (!zone || !lib.isTest(zone, file)) continue;
    for (const m of text.matchAll(/\b(?:it|test)\(\s*(['"`])(.+?)\1/g)) names.push({ file, name: m[2] });
    for (const m of text.matchAll(/public\s+(?:async\s+)?(?:Task|void|ValueTask)\s+(\w+)\s*\(/g)) names.push({ file, name: m[1].replace(/_/g, ' ') });
  }
  return names;
}

function render({ config, base, files, counts, addedText, findings, risk, ci }) {
  const branch = (lib.git(['rev-parse', '--abbrev-ref', 'HEAD']) || '').trim() || 'unknown';
  const out = [];
  out.push(`# Review packet: ${branch}`);
  out.push('');
  out.push(`Compared against ${base ? '`' + base + '`' : 'the last commit (uncommitted work)'}. Generated ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC.`);
  out.push('');
  out.push(`## Risk: ${risk.tier.toUpperCase()}`);
  out.push('');
  const flagged = risk.files.filter((f) => f.tier !== 'low');
  if (!flagged.length) {
    out.push('No file is in a high- or medium-risk area. Reading the tests below is enough unless a check failed.');
  } else {
    out.push(risk.tier === 'high'
      ? 'Read the HIGH files line by line. For the rest, the tests and this page are enough.'
      : 'Read the tests below and skim the MEDIUM files.');
    out.push('');
    out.push('| Risk | File | Why | Added lines |');
    out.push('|---|---|---|---|');
    for (const f of flagged) out.push(`| ${f.tier.toUpperCase()} | \`${f.path}\` | ${f.reasons.join('; ')} | ${f.added} |`);
  }
  out.push('');
  out.push('## What changed');
  out.push('');
  const byZone = {};
  for (const f of files) {
    const zone = lib.zoneOf(config, f.path);
    const key = zone ? (lib.isTest(zone, f.path) ? `${zone.name} tests` : zone.name) : 'other';
    byZone[key] = byZone[key] || { files: 0, added: 0 };
    byZone[key].files++;
    byZone[key].added += (counts && counts[f.path]) || 0;
  }
  out.push('| Area | Files | Added lines |');
  out.push('|---|---|---|');
  for (const [k, v] of Object.entries(byZone)) out.push(`| ${k} | ${v.files} | ${v.added} |`);
  if (!files.length) out.push('| (nothing changed) | 0 | 0 |');
  out.push('');
  out.push('## The specification: tests added or changed');
  out.push('');
  out.push('These say what the change is supposed to do. If a behaviour you expected is missing here, it is not tested.');
  out.push('');
  const tests = testNames(config, addedText);
  if (tests.length) for (const t of tests) out.push(`- ${t.name}  \n  \`${t.file}\``);
  else out.push('- **No test was added or changed.**');
  out.push('');
  out.push('## Checks');
  out.push('');
  out.push('| Control | Mode | Result |');
  out.push('|---|---|---|');
  for (const f of findings) out.push(`| ${f.control} | ${f.mode} | ${f.ok ? 'pass' : f.mode === 'block' ? '**FAIL**' : 'warn'} |`);
  const problems = findings.filter((f) => !f.ok && f.detail);
  for (const f of problems) {
    out.push('');
    out.push(`**${f.control}**`);
    out.push('');
    out.push('```');
    out.push(f.detail);
    out.push('```');
  }
  out.push('');
  out.push('## Not verified by the machine');
  out.push('');
  const skipped = [];
  if (!ci) {
    for (const [name, z] of Object.entries(config.zones || {})) for (const c of z.verifyCi || []) skipped.push(`\`${c}\` (${name}; runs only in CI)`);
  }
  for (const f of findings.filter((x) => x.mode === 'warn')) skipped.push(`control \`${f.control}\` is in warn mode: its findings do not block`);
  for (const c of ['skills', 'tdd', 'suppressions', 'protected', 'architecture', 'verify', 'changeSize']) {
    if (lib.mode(config, c) === 'off') skipped.push(`control \`${c}\` is off`);
  }
  skipped.push('whether the design is right, and whether the tests cover the cases that matter');
  for (const s of skipped) out.push(`- ${s}`);
  out.push('');
  out.push('## From the author');
  out.push('');
  out.push('_The author completes this section. An empty answer is not acceptable; "none" must be a deliberate statement._');
  out.push('');
  out.push('- **Plan this implements** (file under `' + config.plansDir + '/`, and which acceptance criteria):');
  out.push('- **Decisions taken, and the alternatives discarded:**');
  out.push('- **What I did NOT verify:**');
  out.push('- **The three places a reviewer should look hardest:**');
  out.push('');
  return out.join('\n');
}

module.exports = { render, testNames };
