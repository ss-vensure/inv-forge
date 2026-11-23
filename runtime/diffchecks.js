'use strict';
// Checks on the lines a change ADDS: secrets, personal data in tests, and leftovers that turn
// into legacy (commented-out code, notes nobody owns). Only added lines are judged, so old code
// does not have to be clean before a project can turn these on.

const lib = require('./lib');

const SECRETS = [
  { name: 'private key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: 'AWS access key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'GitHub token', re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { name: 'npm token', re: /\bnpm_[A-Za-z0-9]{36}\b/ },
  { name: 'connection string with a password', re: /\b(Password|Pwd)\s*=\s*(?![<{$%*])[^;"'\s]{6,}/i },
  { name: 'hard-coded secret', re: /\b(api[_-]?key|secret|token|passwd|password|client[_-]?secret)\b["']?\s*[:=]\s*["'][A-Za-z0-9+/_\-=]{16,}["']/i },
  { name: 'Syncfusion licence key', re: /registerLicense\(\s*["'][^"']{20,}["']/ },
];

// Real-looking personal data. Checked in tests and fixtures, where it tends to get pasted.
const PERSONAL = [
  { name: 'US social security number', re: /\b(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b/ },
  { name: 'email address on a real domain (use example.test)', re: /\b[A-Za-z0-9._%+-]+@(?!example\.(test|com|org|net)\b)(?!localhost\b)[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/ },
];

const LEFTOVERS = [
  { name: 'commented-out code (delete it; git keeps the history)', re: /^\s*\/\/(?!\/)\s*[^\s/].*[;{}]\s*$/m },
  { name: 'TODO/FIXME without an owner (write TODO(name) or do it now)', re: /\b(TODO|FIXME|HACK)\b(?!\s*\()/ },
];

const isFixture = (rel) => /(^|\/)(fixtures?|seeds?|testdata|test-data|mocks?)\//i.test(rel);

function inTests(config, rel) {
  const zone = lib.zoneOf(config, rel);
  return (!!zone && lib.isTest(zone, rel)) || isFixture(rel);
}

// Names of the patterns found in a piece of text.
function namesIn(patterns, text) {
  return patterns.filter((p) => p.re.test(String(text || ''))).map((p) => p.name);
}

// What a single file's new text adds: secrets anywhere, personal data in tests and fixtures.
function securityIn(config, rel, text) {
  if (lib.matchAny(rel, config.ignore)) return [];
  return namesIn(SECRETS, text).concat(inTests(config, rel) ? namesIn(PERSONAL, text) : []);
}

function leftoversIn(config, rel, text) {
  if (!lib.zoneOf(config, rel) || !/\.(cs|ts|scss|css)$/.test(rel)) return [];
  return namesIn(LEFTOVERS, text);
}

// Findings over a whole change: [{ file, what }]. Paths with an active exception are skipped
// and returned separately so they can be reported, not hidden.
function scan(config, addedText, control, finder) {
  const hits = [];
  const excepted = [];
  for (const [file, text] of Object.entries(addedText || {})) {
    const found = finder(config, file, text);
    if (!found.length) continue;
    const exception = lib.activeException(control, file);
    if (exception) excepted.push({ file, exception });
    else hits.push({ file, what: found.join('; ') });
  }
  return { hits, excepted };
}

const security = (config, addedText) => scan(config, addedText, 'security', securityIn);
const deadCode = (config, addedText) => scan(config, addedText, 'deadCode', leftoversIn);
const describe = (hits) => hits.map((h) => `${h.file}: ${h.what}`).join('\n');

// Runs configured commands. An entry is a string, or { command, failOn } where failOn is a
// regular expression that marks failure in the output of a tool that always exits 0.
function runCommands(config, entries) {
  return (entries || []).map((entry) => {
    const command = typeof entry === 'string' ? entry : entry.command;
    const r = lib.run(command, config.verifyTimeoutSec);
    if (r.ok && entry.failOn && new RegExp(entry.failOn, 'i').test(r.tail)) r.ok = false;
    return r;
  });
}

const describeRuns = (runs) => runs.filter((r) => !r.ok)
  .map((r) => `FAILED (${r.seconds}s${r.timedOut ? ', timed out' : ''}): ${r.command}\n${r.tail}`).join('\n\n');

module.exports = { SECRETS, PERSONAL, LEFTOVERS, securityIn, leftoversIn, security, deadCode, describe, runCommands, describeRuns };
