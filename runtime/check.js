#!/usr/bin/env node
'use strict';
// Every check, on demand. The hooks run the fast ones while Claude works; this runs all of them.
//   node .claude/forge/check.js                 build, tests and every diff check on uncommitted work
//   node .claude/forge/check.js --base main     the same, on everything this branch adds to `main`
//   node .claude/forge/check.js --packet        also write the one-page review packet
//   node .claude/forge/check.js --audit         also look for vulnerable packages (needs the network)
//   node .claude/forge/check.js --mutation      also run mutation testing (slow)
//   node .claude/forge/check.js --ci            also run the commands that need a database or service
//   node .claude/forge/check.js --out r.json    also write the result in a fixed format
//   node .claude/forge/check.js --metrics       print the history of past runs and exit
// Exit code 1 when a control in "block" mode fails. "warn" findings are printed and do not fail.

const fs = require('fs');
const path = require('path');
const lib = require('./lib');
const checks = require('./checks');
const rules = require('./rules');
const risk = require('./risk');
const packet = require('./packet');
const diffchecks = require('./diffchecks');
const metrics = require('./metrics');

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const has = (name) => args.includes(name);
const packetAt = args.indexOf('--packet');
const packetFile = packetAt < 0 ? null
  : path.resolve(lib.ROOT, args[packetAt + 1] && !args[packetAt + 1].startsWith('--') ? args[packetAt + 1] : '.claude/forge/.state/review-packet.md');
const ci = has('--ci');
const base = opt('--base');
const outFile = opt('--out');

const config = lib.loadConfig();
if (!config) {
  console.error('inv-forge: .claude/forge/config.json not found. Run /forge-setup.');
  process.exit(1);
}
if (has('--metrics')) {
  console.log(metrics.summary(config));
  process.exit(0);
}

const findings = []; // { control, mode, ok, detail }
const notRun = [];   // what this run did not check, for the review packet
function record(control, ok, detail) {
  findings.push({ control, mode: lib.mode(config, control), ok, detail });
}
const on = (control) => lib.mode(config, control) !== 'off';

// Files and added text under review: a branch diff, or uncommitted work.
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
const exceptionsUsed = [];
const noteExceptions = (control, list) => list.forEach((x) =>
  exceptionsUsed.push(`${control} on ${x.file}: "${x.exception.reason}" until ${x.exception.expires}`));

// suppressions: nothing in the change may silence a check.
if (on('suppressions')) {
  const hits = [];
  for (const [file, text] of Object.entries(addedText)) {
    if (!lib.zoneOf(config, file)) continue;
    const found = Object.keys(lib.countSuppressions(text));
    if (!found.length) continue;
    const exception = lib.activeException('suppressions', file);
    if (exception) noteExceptions('suppressions', [{ file, exception }]);
    else hits.push(`${file}: ${found.join(', ')}`);
  }
  record('suppressions', hits.length === 0, hits.join('\n'));
}

// protected: the forge and vendor packages do not change in a normal branch.
if (on('protected') && base) {
  const touched = files.map((f) => f.path).filter((p) => lib.matchAny(p, config.protected));
  record('protected', touched.length === 0, touched.length
    ? 'Changed protected files (needs the maintainer\'s explicit review):\n' + touched.join('\n') : '');
}

// security: secrets, and real personal data in tests.
if (on('security')) {
  const r = diffchecks.security(config, addedText);
  noteExceptions('security', r.excepted);
  record('security', r.hits.length === 0, diffchecks.describe(r.hits));
}

// tdd: behaviour changed without a new test in the same zone.
if (on('tdd')) {
  const missing = [];
  for (const [name, zone] of Object.entries(config.zones)) {
    const z = Object.assign({ name }, zone);
    const inZone = files.filter((f) => lib.matchAny(f.path, z.paths));
    const behaviour = inZone.filter((f) => lib.isTddProtected(z, f.path)).filter((f) => {
      const exception = lib.activeException('tdd', f.path);
      if (exception) noteExceptions('tdd', [{ file: f.path, exception }]);
      return !exception;
    });
    const declaresTest = inZone.some((f) => lib.isTest(z, f.path) && lib.TEST_DECLARATION.test(addedText[f.path] || ''));
    if (behaviour.length && !declaresTest) {
      missing.push(`${name}: ${behaviour.length} behaviour file(s) changed and no test was added (${behaviour[0].path}...)`);
    }
  }
  record('tdd', missing.length === 0, missing.join('\n'));
}

// plan: a change past the size threshold was approved before it was written.
const production = checks.productionAdded(config, files, counts);
if (on('plan') && config.plan) {
  const needed = production >= config.plan.requiredFromLines;
  const plan = needed ? checks.approvedPlan(config, files) : null;
  record('plan', !needed || !!plan, needed && !plan
    ? `${production} added lines of production code and no approved plan under ${config.plansDir}/`
    : plan ? `approved plan: ${plan}` : 'below the size that needs a plan');
}

// architecture: the whole project against its baseline, not only the change.
if (on('architecture')) {
  const groups = rules.newViolations(config, rules.allFiles()).filter((g) => {
    const exception = lib.activeException('architecture/' + g.rule, g.file);
    if (exception) noteExceptions('architecture/' + g.rule, [{ file: g.file, exception }]);
    return !exception;
  });
  record('architecture', groups.length === 0, rules.describe(groups));
}

// deadCode: leftovers in the change, plus the project's unused-code tools.
if (on('deadCode')) {
  const r = diffchecks.deadCode(config, addedText);
  noteExceptions('deadCode', r.excepted);
  const runs = diffchecks.runCommands(config, config.deadCode && config.deadCode.commands);
  const detail = [diffchecks.describe(r.hits), diffchecks.describeRuns(runs)].filter(Boolean).join('\n\n');
  record('deadCode', r.hits.length === 0 && runs.every((x) => x.ok), detail);
  if (!(config.deadCode && config.deadCode.commands || []).length) notRun.push('unused files, exports and dependencies: no unused-code tool is configured (`deadCode.commands`)');
}

// changeSize
if (on('changeSize')) {
  record('changeSize', production <= config.changeSize.maxLines,
    production > config.changeSize.maxLines ? `${production} added lines of production code; limit ${config.changeSize.maxLines}` : `${production} lines`);
}

// verify: every zone, not only the touched ones.
if (on('verify')) {
  const results = checks.verify(config, Object.keys(config.zones), ci);
  record('verify', results.every((r) => r.ok), checks.describeFailures(results));
  if (!ci) for (const [name, z] of Object.entries(config.zones)) for (const c of z.verifyCi || []) notRun.push(`\`${c}\` (${name}; runs only with --ci)`);
}

// audit: known-vulnerable packages. Needs the network, so only on request.
if (on('audit')) {
  const commands = (config.audit && config.audit.commands) || [];
  if (has('--audit')) {
    const runs = diffchecks.runCommands(config, commands);
    record('audit', runs.every((x) => x.ok), diffchecks.describeRuns(runs));
  } else if (commands.length) {
    notRun.push('vulnerable packages (run with --audit)');
  }
}

// mutation: do the tests notice when the code is changed on purpose? Slow, so only on request.
if (on('mutation')) {
  const commands = (config.mutation && config.mutation.commands) || [];
  if (has('--mutation') && commands.length) {
    const runs = diffchecks.runCommands(config, commands);
    record('mutation', runs.every((x) => x.ok), diffchecks.describeRuns(runs));
  } else {
    notRun.push(commands.length ? 'mutation testing (run with --mutation)' : 'mutation testing: no tool is configured (`mutation.commands`)');
  }
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
for (const e of exceptionsUsed) console.log(`[exception] ${e}`);

if (packetFile) {
  fs.mkdirSync(path.dirname(packetFile), { recursive: true });
  fs.writeFileSync(packetFile, packet.render({ config, base, files, counts, addedText, findings, risk: riskReport, notRun, exceptionsUsed }));
  console.log(`Review packet written to ${lib.toPosix(path.relative(lib.ROOT, packetFile))}`);
}

const result = {
  schema: 2,
  forgeVersion: lib.readJson(path.join(lib.FORGE_DIR, 'forge.json'), {}).version || null,
  ranAt: new Date().toISOString(),
  base: base || null,
  passed: !failed,
  productionLines: production,
  risk: { tier: riskReport.tier, files: riskReport.files.filter((f) => f.tier !== 'low').map((f) => ({ path: f.path, tier: f.tier, reasons: f.reasons })) },
  exceptionsUsed,
  findings: findings.map((f) => ({ control: f.control, mode: f.mode, ok: f.ok, detail: f.detail || '' })),
};
metrics.append(result);
if (outFile) lib.writeJson(outFile, result);

process.exit(failed ? 1 : 0);
