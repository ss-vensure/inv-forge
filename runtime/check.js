#!/usr/bin/env node
'use strict';
// The same checks the hooks run, for CI and for a manual run:
//   node .claude/forge/check.js                 every zone's build and tests, plus the diff checks
//   node .claude/forge/check.js --base origin/main   diff checks against a branch (use in pull requests)
//   node .claude/forge/check.js --packet             also write the one-page review packet
//   node .claude/forge/check.js --ci                 also run the commands that need a database or service
//   node .claude/forge/check.js --out result.json    also write the result in a fixed format
// Exit code 1 when a control in "block" mode fails. "warn" findings are printed and do not fail.

const fs = require('fs');
const path = require('path');
const lib = require('./lib');
const checks = require('./checks');
const rules = require('./rules');
const risk = require('./risk');
const packet = require('./packet');

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
// --packet [file]: write the review packet (default: .claude/forge/.state/review-packet.md)
const packetAt = args.indexOf('--packet');
const packetFile = packetAt < 0 ? null
  : path.resolve(lib.ROOT, args[packetAt + 1] && !args[packetAt + 1].startsWith('--') ? args[packetAt + 1] : '.claude/forge/.state/review-packet.md');
const ci = args.includes('--ci'); // also run each zone's verifyCi commands
const base = opt('--base');
const outFile = opt('--out');

const config = lib.loadConfig();
if (!config) {
  console.error('inv-forge: .claude/forge/config.json not found. Run /forge-setup.');
  process.exit(1);
}

const findings = []; // { control, mode, ok, detail }
function record(control, ok, detail) {
  findings.push({ control, mode: lib.mode(config, control), ok, detail });
}

// Files and added text under review: a branch diff in CI, uncommitted work otherwise.
let files;
let addedText = {};
let counts = {};
if (base) {
  const names = lib.git(['diff', '--name-only', '--diff-filter=d', `${base}...HEAD`]) || '';
  files = names.split('\n').filter(Boolean).map((p) => ({ status: 'M', path: lib.toPosix(p) }));
  const numstat = lib.git(['diff', '--numstat', `${base}...HEAD`]) || '';
  for (const line of numstat.split('\n')) {
    const m = /^(\d+)\t\d+\t(.+)$/.exec(line);
    if (m) counts[lib.toPosix(m[2])] = Number(m[1]);
  }
  addedText = checks.addedTextFromPatch(lib.git(['diff', '--unified=0', `${base}...HEAD`]));
} else {
  files = lib.changedFiles();
  counts = lib.addedLines(files);
  addedText = checks.addedTextFromPatch(lib.git(['diff', '--unified=0', 'HEAD']));
  for (const f of files.filter((x) => x.status === '??')) {
    try { addedText[f.path] = fs.readFileSync(path.join(lib.ROOT, f.path), 'utf8'); } catch (_) { /* unreadable */ }
  }
}

// suppressions: nothing in the diff may silence a check.
if (lib.mode(config, 'suppressions') !== 'off') {
  const hits = [];
  for (const [file, text] of Object.entries(addedText)) {
    if (!lib.zoneOf(config, file)) continue;
    const found = Object.keys(lib.countSuppressions(text));
    if (found.length) hits.push(`${file}: ${found.join(', ')}`);
  }
  record('suppressions', hits.length === 0, hits.join('\n'));
}

// protected: the forge and vendor packages do not change in a normal pull request.
if (lib.mode(config, 'protected') !== 'off' && base) {
  const touched = files.map((f) => f.path).filter((p) => lib.matchAny(p, config.protected));
  record('protected', touched.length === 0, touched.length
    ? 'Changed protected files (needs the maintainer\'s explicit review):\n' + touched.join('\n') : '');
}

// tdd: production behaviour changed without any test changing in the same zone.
if (lib.mode(config, 'tdd') !== 'off') {
  const missing = [];
  for (const [name, zone] of Object.entries(config.zones)) {
    const z = Object.assign({ name }, zone);
    const inZone = files.filter((f) => lib.matchAny(f.path, z.paths));
    const behaviour = inZone.filter((f) => lib.isTddProtected(z, f.path));
    if (behaviour.length && !inZone.some((f) => lib.isTest(z, f.path))) {
      missing.push(`${name}: ${behaviour.length} behaviour file(s) changed and no test did (${behaviour[0].path}...)`);
    }
  }
  record('tdd', missing.length === 0, missing.join('\n'));
}

// architecture: the whole project against its baseline, not only the diff.
if (lib.mode(config, 'architecture') !== 'off') {
  const groups = rules.newViolations(config, rules.allFiles());
  record('architecture', groups.length === 0, rules.describe(groups));
}

// changeSize
if (lib.mode(config, 'changeSize') !== 'off') {
  const added = checks.productionAdded(config, files, counts);
  record('changeSize', added <= config.changeSize.maxLines,
    added > config.changeSize.maxLines ? `${added} added lines of production code; limit ${config.changeSize.maxLines}` : `${added} lines`);
}

// verify: every zone, not only the touched ones.
if (lib.mode(config, 'verify') !== 'off') {
  const results = checks.verify(config, Object.keys(config.zones), ci);
  record('verify', results.every((r) => r.ok), checks.describeFailures(results));
}

let failed = false;
for (const f of findings) {
  const status = f.ok ? 'pass' : (f.mode === 'block' ? 'FAIL' : 'warn');
  if (!f.ok && f.mode === 'block') failed = true;
  console.log(`[${status}] ${f.control}${!f.ok && f.detail ? '\n' + f.detail.replace(/^/gm, '    ') : ''}`);
}

const riskReport = risk.classify(config, files, addedText, counts);
console.log(`[risk] ${riskReport.tier.toUpperCase()}` + riskReport.files.filter((f) => f.tier !== 'low').slice(0, 15)
  .map((f) => `\n    ${f.tier}: ${f.path} (${f.reasons.join('; ')})`).join(''));

if (packetFile) {
  fs.mkdirSync(path.dirname(packetFile), { recursive: true });
  fs.writeFileSync(packetFile, packet.render({ config, base, files, counts, addedText, findings, risk: riskReport, ci }));
  console.log(`Review packet written to ${lib.toPosix(path.relative(lib.ROOT, packetFile))}`);
}

if (outFile) {
  lib.writeJson(outFile, {
    schema: 1,
    forgeVersion: lib.readJson(path.join(lib.FORGE_DIR, 'forge.json'), {}).version || null,
    ranAt: new Date().toISOString(),
    base: base || null,
    passed: !failed,
    risk: { tier: riskReport.tier, files: riskReport.files.filter((f) => f.tier !== 'low').map((f) => ({ path: f.path, tier: f.tier, reasons: f.reasons })) },
    findings: findings.map((f) => ({ control: f.control, mode: f.mode, ok: f.ok, detail: f.detail || '' })),
  });
}

process.exit(failed ? 1 : 0);
