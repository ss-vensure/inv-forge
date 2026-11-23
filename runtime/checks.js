'use strict';
// Checks shared by the Stop hook (local, only what was touched) and check.js (CI, everything).

const lib = require('./lib');

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

module.exports = { addedTextFromPatch, zonesTouched, verify, productionAdded, describeFailures };
