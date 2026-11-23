'use strict';
// A local history of check.js runs, so "is this working?" has numbers behind it.
// One JSON line per run in .claude/forge/.state/metrics.jsonl (per machine, not committed).
// The migration backlog itself is arch-baseline.json, which is committed: its history is in git.

const fs = require('fs');
const path = require('path');
const lib = require('./lib');
const rules = require('./rules');

const FILE = path.join(lib.STATE_DIR, 'metrics.jsonl');

const baselineTotals = () => Object.fromEntries(Object.entries(rules.loadBaseline())
  .map(([rule, perFile]) => [rule, Object.values(perFile).reduce((a, b) => a + b, 0)]));

function append(result) {
  const line = {
    ranAt: result.ranAt,
    passed: result.passed,
    risk: result.risk.tier,
    productionLines: result.productionLines,
    failed: result.findings.filter((f) => !f.ok && f.mode === 'block').map((f) => f.control),
    warned: result.findings.filter((f) => !f.ok && f.mode === 'warn').map((f) => f.control),
    exceptions: result.exceptionsUsed.length,
    baseline: baselineTotals(),
  };
  try {
    fs.mkdirSync(lib.STATE_DIR, { recursive: true });
    fs.appendFileSync(FILE, JSON.stringify(line) + '\n');
  } catch (_) { /* metrics never break a check */ }
}

function read() {
  try {
    return fs.readFileSync(FILE, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch (_) {
    return [];
  }
}

function summary(config) {
  const runs = read();
  const out = [];
  out.push(`inv-forge metrics: ${runs.length} run(s) of check.js recorded on this machine`);
  if (runs.length) {
    const passed = runs.filter((r) => r.passed).length;
    out.push(`  passed ${passed}, failed ${runs.length - passed} (${Math.round((100 * passed) / runs.length)}% pass)`);
    const count = (key) => {
      const totals = {};
      for (const r of runs) for (const c of r[key] || []) totals[c] = (totals[c] || 0) + 1;
      return Object.entries(totals).sort((a, b) => b[1] - a[1]).map(([c, n]) => `${c} ${n}`).join(', ') || 'none';
    };
    out.push(`  controls that failed a run: ${count('failed')}`);
    out.push(`  controls that warned:       ${count('warned')}`);
    const tiers = { high: 0, medium: 0, low: 0 };
    for (const r of runs) tiers[r.risk] = (tiers[r.risk] || 0) + 1;
    out.push(`  runs by risk: high ${tiers.high}, medium ${tiers.medium}, low ${tiers.low}`);
    out.push(`  runs that used an exception: ${runs.filter((r) => r.exceptions).length}`);
  }
  out.push('');
  out.push('Migration backlog (structure-rule baseline), first recorded run -> now:');
  const now = baselineTotals();
  const first = runs.length ? runs[0].baseline || {} : {};
  const names = [...new Set([...Object.keys(first), ...Object.keys(now)])].sort();
  if (!names.length) out.push('  clean: no tolerated violations');
  for (const rule of names) out.push(`  ${rule.padEnd(24)} ${String(first[rule] === undefined ? '-' : first[rule]).padStart(5)} -> ${now[rule] || 0}`);
  out.push('');
  const exceptions = lib.loadExceptions();
  out.push(`Exceptions: ${exceptions.filter((e) => !lib.isExpired(e)).length} active, ${exceptions.filter(lib.isExpired).length} expired`);
  const modes = Object.entries((config && config.controls) || {}).filter(([, m]) => m !== 'block').map(([c, m]) => `${c}=${m}`);
  out.push(`Controls not in block mode: ${modes.join(', ') || 'none'}`);
  return out.join('\n');
}

module.exports = { append, read, summary };
