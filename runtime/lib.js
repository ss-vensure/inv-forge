'use strict';
// inv-forge runtime library. Copied into a project at .claude/forge/lib.js.
// No dependencies: it must run on a bare Node install, inside a hook, in well under a second.

const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const crypto = require('crypto');

// This file lives at <project>/.claude/forge/lib.js, so the project root is two levels up.
// Resolving from __dirname (not cwd) keeps hooks correct when the shell has changed directory.
const ROOT = process.env.FORGE_ROOT || path.resolve(__dirname, '..', '..');
const FORGE_DIR = path.join(ROOT, '.claude', 'forge');
const STATE_DIR = path.join(FORGE_DIR, '.state');

const MODES = ['off', 'warn', 'block'];

// Ways of making a check pass without fixing anything. Adding one is what gets blocked;
// lines that already exist are left alone so legacy files stay editable.
const SUPPRESSION_PATTERNS = [
  { name: '#pragma warning disable', re: /#pragma\s+warning\s+disable/g },
  { name: '<NoWarn>', re: /<NoWarn>/g },
  { name: 'SuppressMessage attribute', re: /\bSuppressMessage\s*\(/g },
  { name: 'skipped .NET test', re: /\bSkip\s*=\s*"/g },
  { name: 'eslint-disable', re: /eslint-disable/g },
  { name: '@ts-ignore / @ts-nocheck', re: /@ts-(ignore|nocheck)/g },
  { name: 'skipped or focused spec', re: /\b(xit|xdescribe|fit|fdescribe)\s*\(/g },
  { name: 'style override (::ng-deep)', re: /::ng-deep/g },
];

function readStdinJson() {
  try {
    const raw = fs.readFileSync(0, 'utf8');
    return raw.trim() ? JSON.parse(raw) : {};
  } catch (_) {
    return {};
  }
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}

function loadConfig() {
  return readJson(path.join(FORGE_DIR, 'config.json'), null);
}

function mode(config, control) {
  const m = config && config.controls && config.controls[control];
  return MODES.includes(m) ? m : 'block';
}

// ---- paths and globs -------------------------------------------------------

function toPosix(p) {
  return String(p).replace(/\\/g, '/');
}

// Project-relative posix path, or null when the file is outside the project.
function relPath(file) {
  if (!file) return null;
  let abs = String(file);
  const msys = /^\/([a-zA-Z])\/(.*)$/.exec(abs); // /c/Users/... from Git Bash
  if (msys) abs = msys[1] + ':/' + msys[2];
  abs = path.resolve(ROOT, abs);
  let rel = path.relative(ROOT, abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return toPosix(rel);
}

function globToRegex(glob) {
  let re = '';
  const g = toPosix(glob);
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        if (g[i + 2] === '/') { re += '(?:.*/)?'; i += 2; } else { re += '.*'; i += 1; }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if ('\\^$+.()|{}[]'.includes(c)) {
      re += '\\' + c;
    } else {
      re += c;
    }
  }
  return new RegExp('^' + re + '$', process.platform === 'win32' ? 'i' : '');
}

function matchAny(rel, globs) {
  return (globs || []).some((g) => globToRegex(g).test(rel));
}

function zoneOf(config, rel) {
  if (matchAny(rel, config && config.ignore)) return null;
  for (const [name, zone] of Object.entries((config && config.zones) || {})) {
    if (matchAny(rel, zone.paths)) return Object.assign({ name }, zone);
  }
  return null;
}

function isTest(zone, rel) {
  return matchAny(rel, zone.tests);
}

// A file where behaviour lives: a test must exist before it changes.
function isTddProtected(zone, rel) {
  const tdd = zone.tdd || {};
  return matchAny(rel, tdd.protected) && !matchAny(rel, tdd.exempt) && !isTest(zone, rel);
}

// ---- git -------------------------------------------------------------------

function git(args) {
  try {
    return cp.execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });
  } catch (_) {
    return null;
  }
}

function isGitRepo() {
  return git(['rev-parse', '--is-inside-work-tree']) !== null;
}

// Uncommitted work: [{ status, path }], deletions excluded.
function changedFiles() {
  const out = git(['status', '--porcelain', '-z', '-uall']);
  if (!out) return [];
  const entries = out.split('\0').filter(Boolean);
  const files = [];
  for (let i = 0; i < entries.length; i++) {
    const status = entries[i].slice(0, 2);
    const file = toPosix(entries[i].slice(3));
    if (/[RC]/.test(status)) i++; // the next entry is the rename source
    if (status.includes('D')) continue;
    files.push({ status, path: file });
  }
  return files;
}

// Added lines of uncommitted work per file (tracked edits plus whole untracked files).
function addedLines(files) {
  const counts = {};
  const numstat = git(['diff', '--numstat', 'HEAD']) || git(['diff', '--numstat', '--cached']) || '';
  for (const line of numstat.split('\n')) {
    const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
    if (m && m[1] !== '-') counts[toPosix(m[3])] = Number(m[1]);
  }
  for (const f of files) {
    if (f.status !== '??') continue;
    try {
      counts[f.path] = fs.readFileSync(path.join(ROOT, f.path), 'utf8').split('\n').length;
    } catch (_) { /* binary or unreadable: not counted */ }
  }
  return counts;
}

function fingerprint(files) {
  const h = crypto.createHash('sha1');
  for (const f of files.slice().sort((a, b) => a.path.localeCompare(b.path))) {
    let stamp = 'gone';
    try {
      const s = fs.statSync(path.join(ROOT, f.path));
      stamp = s.size + ':' + Math.floor(s.mtimeMs);
    } catch (_) { /* deleted since status ran */ }
    h.update(f.path + '|' + stamp + '\n');
  }
  return h.digest('hex');
}

// ---- per-session state -----------------------------------------------------

function stateFile(sessionId) {
  const id = String(sessionId || 'no-session').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
  return path.join(STATE_DIR, id + '.json');
}

function loadState(sessionId) {
  return Object.assign({ skills: [], warnings: [], stopBlocks: 0 }, readJson(stateFile(sessionId), {}));
}

function saveState(sessionId, state) {
  writeJson(stateFile(sessionId), state);
}

// ---- suppressions ----------------------------------------------------------

function countSuppressions(text) {
  const found = {};
  for (const p of SUPPRESSION_PATTERNS) {
    const n = (String(text || '').match(p.re) || []).length;
    if (n) found[p.name] = n;
  }
  return found;
}

// Names of suppressions that `after` has more of than `before`.
function newSuppressions(before, after) {
  const a = countSuppressions(before);
  const b = countSuppressions(after);
  return Object.keys(b).filter((k) => b[k] > (a[k] || 0));
}

// ---- running commands ------------------------------------------------------

function run(command, timeoutSec) {
  const started = Date.now();
  const r = cp.spawnSync(command, { cwd: ROOT, shell: true, encoding: 'utf8', timeout: (timeoutSec || 600) * 1000, maxBuffer: 64 * 1024 * 1024 });
  const output = ((r.stdout || '') + (r.stderr || '')).trim();
  const timedOut = !!(r.error && r.error.code === 'ETIMEDOUT');
  return {
    command,
    ok: r.status === 0 && !r.error,
    timedOut,
    seconds: Math.round((Date.now() - started) / 1000),
    tail: output.split(/\r?\n/).slice(-40).join('\n'),
  };
}

module.exports = {
  ROOT, FORGE_DIR, STATE_DIR, MODES, SUPPRESSION_PATTERNS,
  readStdinJson, readJson, writeJson, loadConfig, mode,
  toPosix, relPath, globToRegex, matchAny, zoneOf, isTest, isTddProtected,
  git, isGitRepo, changedFiles, addedLines, fingerprint,
  loadState, saveState, countSuppressions, newSuppressions, run,
};
