'use strict';
// Checks shared by the hooks (only what was touched) and check.js (everything).

const fs = require('fs');
const path = require('path');
const lib = require('./lib');

// The plan this work is being done under: a file in plansDir that a person marked
// "Status: approved" and that belongs to current work (changed in the working tree, or last
// committed within plan.maxAgeDays). Returns its path, or null.
function approvedPlan(config, files) {
  const dir = String(config.plansDir || '').replace(/\/+$/, '');
  if (!dir) return null;
  let names;
  try { names = fs.readdirSync(path.join(lib.ROOT, dir)).filter((n) => n.endsWith('.md')); } catch (_) { return null; }
  const maxAge = ((config.plan && config.plan.maxAgeDays) || 14) * 86400;
  for (const name of names) {
    const rel = dir + '/' + name;
    let text;
    try { text = fs.readFileSync(path.join(lib.ROOT, rel), 'utf8'); } catch (_) { continue; }
    if (!/^\s*Status:\s*approved\b/im.test(text)) continue;
    if ((files || []).some((f) => f.path === rel)) return rel;
    const committed = Number((lib.git(['log', '-1', '--format=%ct', '--', rel]) || '').trim());
    if (committed && Date.now() / 1000 - committed <= maxAge) return rel;
  }
  return null;
}

// Zone names that the given files fall into.
function zonesTouched(config, files) {
  const names = new Set();
  for (const f of files) {
    const z = lib.zoneOf(config, f.path);
    if (z) names.add(z.name);
  }
  return [...names];
}

// Runs each zone's verify commands in order; a zone stops at its first failure.
// `ci` adds each zone's verifyCi commands: the ones that need a database or other service.
function verify(config, zoneNames, ci) {
  const results = [];
  for (const name of zoneNames) {
    const zone = config.zones[name] || {};
    for (const command of (zone.verify || []).concat(ci ? zone.verifyCi || [] : [])) {
      const r = lib.run(command, config.verifyTimeoutSec);
      results.push(Object.assign({ zone: name }, r));
      if (!r.ok) break;
    }
  }
  return results;
}

// Added lines of production code (tests and files outside the zones do not count).
function productionAdded(config, files, counts) {
  let total = 0;
  for (const f of files) {
    const z = lib.zoneOf(config, f.path);
    if (z && !lib.isTest(z, f.path)) total += counts[f.path] || 0;
  }
  return total;
}

function describeFailures(results) {
  return results.filter((r) => !r.ok).map((r) =>
    `FAILED (${r.zone}${r.timedOut ? ', timed out' : ''}, ${r.seconds}s): ${r.command}\n${r.tail}`).join('\n\n');
}

// Text of the added lines per file, from a unified diff.
function addedTextFromPatch(patch) {
  const added = {};
  let current = null;
  for (const line of String(patch || '').split('\n')) {
    const h = /^\+\+\+ b\/(.+)$/.exec(line);
    if (h) { current = lib.toPosix(h[1]); continue; }
    if (current && line.startsWith('+') && !line.startsWith('+++')) added[current] = (added[current] || '') + line.slice(1) + '\n';
  }
  return added;
}

module.exports = { approvedPlan, addedTextFromPatch, zonesTouched, verify, productionAdded, describeFailures };
