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

// Every skill that must be loaded before `rel` changes: all the rules whose paths match it.
function skillsFor(config, rel) {
  const out = [];
  for (const rule of (config && config.skillRules) || []) {
    if (!matchAny(rel, rule.paths)) continue;
    for (const s of rule.skills || []) if (!out.includes(s)) out.push(s);
  }
  return out;
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

// True when the uncommitted work declares at least one new test in the zone's tests.
// An empty test file does not count as "the test came first".
const TEST_DECLARATION = /\b(it|test)\s*\(|\[\s*(Fact|Theory|Test|TestMethod)\b/;

function hasNewTest(zone) {
  const tests = changedFiles().filter((f) => isTest(zone, f.path));
  const tracked = tests.filter((f) => f.status !== '??').map((f) => f.path);
  const patch = tracked.length ? git(['diff', '--unified=0', 'HEAD', '--', ...tracked]) || '' : '';
  const added = patch.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).join('\n');
  if (TEST_DECLARATION.test(added)) return true;
  return tests.filter((f) => f.status === '??').some((f) => {
    try { return TEST_DECLARATION.test(fs.readFileSync(path.join(ROOT, f.path), 'utf8')); } catch (_) { return false; }
  });
}

// ---- exceptions ------------------------------------------------------------
// The sanctioned way past a rule: granted by the maintainer, for named paths, with a reason and
// an expiry date. Kept in .claude/forge/exceptions.json, which a session cannot edit.
//   [{ id, control, paths, reason, expires: "YYYY-MM-DD", grantedAt }]
// `control` is a control name, or "architecture/<rule>" for a single structure rule.

function loadExceptions() {
  const list = readJson(path.join(FORGE_DIR, 'exceptions.json'), []);
  return Array.isArray(list) ? list : [];
}

const today = () => new Date().toISOString().slice(0, 10);
const isExpired = (e) => !e.expires || String(e.expires) < today();

// The exception that covers this control on this file today, or null.
function activeException(control, rel) {
  const family = String(control).split('/')[0];
  return loadExceptions().find((e) => !isExpired(e) && (e.control === control || e.control === family) && matchAny(rel, e.paths)) || null;
}

// ---- per-session state -----------------------------------------------------

function stateFile(sessionId) {
  const id = String(sessionId || 'no-session').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 120);
  return path.join(STATE_DIR, id + '.json');
}

function loadState(sessionId) {
  return Object.assign({ skills: [], warnings: [], exceptionsUsed: [], stopBlocks: 0 }, readJson(stateFile(sessionId), {}));
}

function saveState(sessionId, state) {
  writeJson(stateFile(sessionId), state);
}

// ---- agents ----------------------------------------------------------------

// The agents setup installs in .claude/agents/. `zone` is the only one an agent builds in (null: any).
// `skills` are the ones its definition preloads: they are in its context from the first turn, without
// passing through the Skill tool, so the skill log never sees them.
// A step of the work is done by one kind of agent, and a hook knows which agent is acting. So the skills
// of a step are tied to its agent: `needs` before it edits (optionally only some files), `beforeDone`
// before it may finish. `ifZone` skips a requirement in a project without that zone (its plugin is not
// installed there). `readOnly` agents review; they never edit.
const AGENTS = {
  'forge-backend-dev': { zone: 'backend', skills: ['forge-backend'] },
  'forge-frontend-dev': { zone: 'frontend', skills: ['forge-frontend', 'angular-developer'] },
  'forge-debugger': { zone: null, skills: [], needs: [{ skills: ['systematic-debugging'] }] },
  'forge-refactorer': { zone: null, skills: [], needs: [{ ifZone: 'backend', paths: ['**/*.cs'], skills: ['csharp-refactoring'] }] },
  'forge-test-reviewer': { zone: null, skills: [], readOnly: true,
    beforeDone: [{ ifZone: 'backend', skills: ['assertion-quality', 'test-anti-patterns'] }] },
};

function agentRequires(config, agentType, key, rel) {
  const out = [];
  for (const r of (AGENTS[agentType] || {})[key] || []) {
    if (r.ifZone && !(config.zones && config.zones[r.ifZone])) continue;
    if (r.paths && !(rel && matchAny(rel, r.paths))) continue;
    for (const s of r.skills) if (!out.includes(s)) out.push(s);
  }
  return out;
}

// A subagent has a context of its own: what the main conversation loaded is not in it, and the other
// way round. So the skills a hook counts as loaded are kept per agent.
const agentSkillsFile = (input) => stateFile(`${input.session_id || 'no-session'}_agent_${input.agent_id}`);

function loadedSkills(input, state) {
  if (!input.agent_id) return state.skills;
  const preloaded = (AGENTS[input.agent_type] || {}).skills || [];
  return preloaded.concat(readJson(agentSkillsFile(input), []) || []);
}

function recordSkills(input, names) {
  if (input.agent_id) {
    const own = readJson(agentSkillsFile(input), []) || [];
    writeJson(agentSkillsFile(input), [...new Set(own.concat(names))]);
    return;
  }
  const state = loadState(input.session_id);
  for (const n of names) if (!state.skills.includes(n)) state.skills.push(n);
  saveState(input.session_id, state);
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

// Karma looks for Chrome. On a Windows machine that only has Edge (also Chromium), point it there,
// otherwise `npm test` fails for a reason that has nothing to do with the code.
function browserEnv() {
  if (process.env.CHROME_BIN || process.platform !== 'win32') return {};
  const roots = [process.env.LOCALAPPDATA, process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)']].filter(Boolean);
  const find = (suffix) => roots.map((r) => path.join(r, suffix)).find((p) => fs.existsSync(p));
  if (find('Google\\Chrome\\Application\\chrome.exe')) return {};
  const edge = find('Microsoft\\Edge\\Application\\msedge.exe');
  return edge ? { CHROME_BIN: edge } : {};
}

function run(command, timeoutSec) {
  const started = Date.now();
  const r = cp.spawnSync(command, {
    cwd: ROOT, shell: true, encoding: 'utf8', timeout: (timeoutSec || 600) * 1000, maxBuffer: 64 * 1024 * 1024,
    env: Object.assign({}, process.env, browserEnv()),
  });
  // Terminal colour codes are noise once the output is quoted in a message or a file.
  const colour = new RegExp(String.fromCharCode(27) + '\\[[0-9;]*[A-Za-z]', 'g');
  const output = ((r.stdout || '') + (r.stderr || '')).replace(colour, '').trim();
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
  toPosix, relPath, globToRegex, matchAny, zoneOf, skillsFor, isTest, isTddProtected,
  git, isGitRepo, changedFiles, addedLines, fingerprint, hasNewTest, TEST_DECLARATION,
  loadExceptions, isExpired, activeException,
  AGENTS, agentRequires, loadedSkills, recordSkills,
  loadState, saveState, countSuppressions, newSuppressions, run,
};
