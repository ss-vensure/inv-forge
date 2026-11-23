#!/usr/bin/env node
'use strict';
// inv-forge installer. Deterministic and safe to run again: it never duplicates wiring and
// never overwrites a project's own choices in .claude/forge/config.json.
//
//   node setup.js [projectDir]                 install or update
//   node setup.js [projectDir] --check         report drift only (exit 1 if anything is missing)
//   node setup.js [projectDir] --preset new|existing
//   node setup.js [projectDir] --set controls.tdd=warn --set changeSize.maxLines=300
//   node setup.js [projectDir] --offline       skip anything that needs the network
//   node setup.js [projectDir] --scaffold-backend Acme.Billing   create api/ in four layers (only if there is none)
//                              --efcore        ...with EF Core, SQLite-backed endpoint tests and the query counter
//   node setup.js [projectDir] --baseline     re-record today's structure-rule violations (after a migration)
//
// Everything it owns in the project lives in .claude/forge/ and .claude/skills/forge-*/.
// In shared files (.claude/settings.json, CLAUDE.md, .gitignore) it only adds marked entries,
// so the RAiCE starter's /upgrade keeps working and this can be re-run after it.

const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const FORGE_HOME = path.resolve(__dirname, '..');
const VERSION = require(path.join(FORGE_HOME, 'package.json')).version;
const PINS = require(path.join(FORGE_HOME, 'pins.json'));
const MODES = ['off', 'warn', 'block'];
const CONTROLS = ['skills', 'tdd', 'suppressions', 'protected', 'architecture', 'verify', 'changeSize'];

// ---- arguments -------------------------------------------------------------

const argv = process.argv.slice(2);
const flags = { check: false, offline: false, baseline: false, preset: null, set: [] };
let target = null;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--check') flags.check = true;
  else if (a === '--offline') flags.offline = true;
  else if (a === '--baseline') flags.baseline = true;
  else if (a === '--scaffold-backend') flags.scaffold = argv[++i];
  else if (a === '--efcore') flags.efcore = true;
  else if (a === '--preset') flags.preset = argv[++i];
  else if (a === '--set') flags.set.push(argv[++i]);
  else if (a.startsWith('--')) fail(`Unknown option ${a}`);
  else target = a;
}
const ROOT = path.resolve(target || process.cwd());
const FORGE_DIR = path.join(ROOT, '.claude', 'forge');

function fail(message) {
  console.error('inv-forge: ' + message);
  console.log('\nRESULT: failed');
  process.exit(1);
}

// ---- small helpers ---------------------------------------------------------

const posix = (p) => p.replace(/\\/g, '/');
const exists = (...p) => fs.existsSync(path.join(ROOT, ...p));
const readText = (file) => { try { return fs.readFileSync(file, 'utf8'); } catch (_) { return null; } };
const readJson = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return fallback; } };
function writeText(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}
const writeJson = (file, value) => writeText(file, JSON.stringify(value, null, 2) + '\n');

function walk(dir, visit, depth = 0) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
  for (const e of entries) {
    if (['node_modules', 'bin', 'obj', '.git', 'dist', '.vs', '.angular'].includes(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { if (depth < 8) walk(full, visit, depth + 1); } else visit(full);
  }
}

function copyDir(from, to) {
  const copied = [];
  walk(from, (file) => {
    const rel = path.relative(from, file);
    writeText(path.join(to, rel), fs.readFileSync(file));
    copied.push(posix(rel));
  });
  return copied;
}

// Defaults fill gaps; whatever the project already set wins.
function mergeDefaults(defaults, existing) {
  if (existing === undefined) return defaults;
  if (!defaults || typeof defaults !== 'object' || Array.isArray(defaults)) return existing;
  if (!existing || typeof existing !== 'object' || Array.isArray(existing)) return existing;
  const out = Object.assign({}, existing);
  for (const k of Object.keys(defaults)) out[k] = mergeDefaults(defaults[k], existing[k]);
  return out;
}

// ---- detection -------------------------------------------------------------

function detect() {
  const pkg = readJson(path.join(ROOT, 'package.json'), null);
  const deps = Object.assign({}, pkg && pkg.dependencies, pkg && pkg.devDependencies);
  const scripts = (pkg && pkg.scripts) || {};
  const d = {
    isGit: exists('.git'),
    starterSetUp: exists('raice.json'),
    angular: deps['@angular/core'] || null,
    hasFrontend: exists('angular.json') && exists('src'),
    hasBackend: false,
    solution: null,
    testProjects: [],
    usesEfCore: false,
    scripts,
    sourceFiles: 0,
    ciRunsForge: false,
    workflows: [],
  };
  const apiDir = path.join(ROOT, 'api');
  if (fs.existsSync(apiDir)) {
    walk(apiDir, (file) => {
      const rel = posix(path.relative(ROOT, file));
      if (/\.slnx?$/.test(file) && !d.solution) d.solution = rel;
      if (file.endsWith('.csproj')) {
        d.hasBackend = true;
        const text = readText(file) || '';
        if (/EntityFrameworkCore/.test(text)) d.usesEfCore = true;
        if (/Microsoft\.NET\.Test\.Sdk|xunit|NUnit|MSTest/i.test(text)) d.testProjects.push(rel);
      }
      if (file.endsWith('.cs') && !/Tests?[\\/]/.test(file)) d.sourceFiles++;
    });
  }
  walk(path.join(ROOT, 'src', 'app'), (file) => {
    if (file.endsWith('.ts') && !file.endsWith('.spec.ts')) d.sourceFiles++;
  });
  walk(path.join(ROOT, '.github', 'workflows'), (file) => {
    d.workflows.push(posix(path.relative(ROOT, file)));
    if (/\.claude\/forge\/check\.js/.test(readText(file) || '')) d.ciRunsForge = true;
  });
  return d;
}

// ---- default configuration -------------------------------------------------

function defaultConfig(d, preset) {
  const strict = preset === 'new';
  const zones = {};
  if (d.hasBackend || strict) {
    const verify = [];
    if (d.solution) verify.push(`dotnet build "${d.solution}" --nologo -v q${strict ? ' -warnaserror' : ''}`);
    if (d.scripts['test:api']) verify.push('npm run test:api');
    else for (const p of d.testProjects) verify.push(`dotnet test "${p}" --nologo`);
    zones.backend = {
      paths: ['api/**'],
      tests: ['api/**/*Tests/**', 'api/**/tests/**'],
      requiredSkill: 'forge-backend',
      alsoUse: ['the dotnet, dotnet-aspnetcore and dotnet-test plugin skills' + (d.usesEfCore ? ', and dotnet-data for EF Core' : '')],
      tdd: {
        protected: ['api/**/*.Domain/**/*.cs', 'api/**/*.Application/**/*.cs', 'api/**/*Service.cs'],
        exempt: ['**/Migrations/**'],
      },
      verify,
      verifyCi: [],
    };
  }
  if (d.hasFrontend) {
    const verify = ['npm run build', 'npm test'];
    if (d.scripts.lint && strict) verify.splice(1, 0, 'npm run lint -- --max-warnings 0');
    zones.frontend = {
      paths: ['src/**'],
      tests: ['src/**/*.spec.ts'],
      requiredSkill: 'forge-frontend',
      alsoUse: ['the angular-developer skill'],
      tdd: {
        protected: ['src/app/**/*.ts'],
        exempt: ['src/app/**/*.component.ts', 'src/app/**/*.routes.ts', 'src/app/**/*.config.ts', 'src/app/**/*.model.ts', 'src/app/**/*.types.ts'],
      },
      verify,
      verifyCi: [],
    };
  }
  return {
    controls: {
      skills: 'block',
      tdd: strict ? 'block' : 'warn',
      suppressions: 'block',
      protected: 'block',
      architecture: 'block', // safe on legacy code: the baseline allows what is already there
      verify: 'block',
      changeSize: strict ? 'block' : 'warn',
    },
    zones,
    ignore: ['**/*.md', '**/bin/**', '**/obj/**'],
    protected: ['.claude/forge/**', '.claude/settings.json', 'node_modules/**'],
    changeSize: { maxLines: 400 },
    limits: { maxFileLines: 400 },
    frontend: { libraryClassPrefixes: ['e-'] },
    architecture: { disabledRules: [] },
    risk: {
      high: {
        'database schema': ['**/Migrations/**'],
        'authentication or authorization': ['**/*Auth*/**', '**/*Auth*.*', '**/auth/**', '**/Identity/**', '**/Access/**', '**/*Permission*', '**/*.guard.ts'],
        'build, deployment or CI': ['.github/**', '.docker/**', '**/Dockerfile', '**/*.csproj', '**/Directory.*.props', 'package.json', 'angular.json'],
        'runtime configuration': ['**/appsettings*.json', '**/Program.cs', 'public/config.json', 'src/app/app.config.ts'],
        'inv-forge or Claude configuration': ['.claude/**'],
      },
      medium: {
        'use cases and business rules': ['api/**/*.Application/**', 'api/**/*.Domain/**', 'api/**/*Service.cs'],
        'data access': ['api/**/*.Infrastructure/**', 'api/**/*.Data/**'],
        'endpoints and the API contract': ['api/**/*.Api/**'],
        'frontend logic and HTTP': ['src/app/**/*.service.ts', 'src/app/**/*.store.ts', 'src/app/**/*.interceptor.ts'],
      },
    },
    plansDir: 'docs/forge/plans',
    verifyTimeoutSec: 600,
    maxStopBlocks: 3,
  };
}

function applySet(config, assignment) {
  const eq = String(assignment || '').indexOf('=');
  if (eq < 1) fail(`--set expects key=value, got "${assignment}"`);
  const keys = assignment.slice(0, eq).split('.');
  const raw = assignment.slice(eq + 1);
  let value;
  try { value = JSON.parse(raw); } catch (_) { value = raw; }
  if (keys[0] === 'controls') {
    if (!CONTROLS.includes(keys[1])) fail(`Unknown control "${keys[1]}". Controls: ${CONTROLS.join(', ')}`);
    if (!MODES.includes(value)) fail(`A control is one of: ${MODES.join(', ')}`);
  }
  let node = config;
  for (const k of keys.slice(0, -1)) {
    if (!node[k] || typeof node[k] !== 'object') node[k] = {};
    node = node[k];
  }
  node[keys[keys.length - 1]] = value;
}

// ---- .claude/settings.json -------------------------------------------------

const hookCmd = (file) => `node "\${CLAUDE_PROJECT_DIR:-.}/.claude/forge/hooks/${file}"`;
const FORGE_HOOKS = {
  SessionStart: [{ hooks: [{ type: 'command', command: hookCmd('session-start.js') }] }],
  PreToolUse: [
    { matcher: 'Edit|Write|MultiEdit', hooks: [{ type: 'command', command: hookCmd('pre-edit.js') }] },
    { matcher: 'Bash', hooks: [{ type: 'command', command: hookCmd('pre-bash.js') }] },
  ],
  PostToolUse: [
    { matcher: 'Skill|Read', hooks: [{ type: 'command', command: hookCmd('skill-log.js') }] },
    { matcher: 'Edit|Write|MultiEdit', hooks: [{ type: 'command', command: hookCmd('post-edit.js') }] },
  ],
  Stop: [{ hooks: [{ type: 'command', command: hookCmd('stop-verify.js'), timeout: 1800 }] }],
};
const isForgeGroup = (g) => ((g && g.hooks) || []).some((h) => /\.claude\/forge\//.test(h.command || ''));

function wantedPlugins(d) {
  const plugins = Object.assign({}, PINS.plugins.always);
  if (d.hasBackend) Object.assign(plugins, PINS.plugins.backend);
  if (d.usesEfCore) Object.assign(plugins, PINS.plugins.efcore);
  return plugins;
}

function mergeSettings(settings, d) {
  const s = settings || {};
  s.hooks = s.hooks || {};
  for (const [event, groups] of Object.entries(FORGE_HOOKS)) {
    s.hooks[event] = (s.hooks[event] || []).filter((g) => !isForgeGroup(g)).concat(groups);
  }
  s.permissions = s.permissions || {};
  const allow = new Set(s.permissions.allow || []);
  for (const p of PINS.permissions) allow.add(p);
  s.permissions.allow = [...allow];
  s.extraKnownMarketplaces = Object.assign({}, s.extraKnownMarketplaces, PINS.marketplaces);
  s.enabledPlugins = Object.assign({}, s.enabledPlugins, wantedPlugins(d));
  return s;
}

// ---- plugins ---------------------------------------------------------------
// Listing a plugin in enabledPlugins does not install it: a session then starts without those
// skills. The Claude CLI installs it for this project; nothing here needs a login.

const samePath = (a, b) => path.resolve(String(a)).toLowerCase() === path.resolve(String(b)).toLowerCase();

function pluginState() {
  const dir = path.join(os.homedir(), '.claude', 'plugins');
  return {
    marketplaces: readJson(path.join(dir, 'known_marketplaces.json'), {}) || {},
    installed: (readJson(path.join(dir, 'installed_plugins.json'), {}) || {}).plugins || {},
  };
}

function isInstalledHere(state, id) {
  return (state.installed[id] || []).some((e) => e.scope === 'user' || (e.projectPath && samePath(e.projectPath, ROOT)));
}

function claude(args) {
  // One command string: every argument here is a fixed word or an id from pins.json.
  const r = cp.spawnSync('claude ' + args.join(' '), { cwd: ROOT, shell: true, encoding: 'utf8', timeout: 300000 });
  return { ok: r.status === 0, text: ((r.stdout || '') + (r.stderr || '')).trim().split(/\r?\n/).pop() || '' };
}

function installPlugins(d) {
  const ids = Object.keys(wantedPlugins(d));
  let state = pluginState();
  const missing = ids.filter((id) => !isInstalledHere(state, id));
  if (!missing.length) return ids.map((id) => `${id}: installed`);
  if (flags.offline) return missing.map((id) => `${id}: NOT installed (--offline)`);
  if (!claude(['--version']).ok) return missing.map((id) => `${id}: NOT installed (the claude CLI is not on PATH)`);
  for (const [name, m] of Object.entries(PINS.marketplaces)) {
    if (!state.marketplaces[name]) claude(['plugin', 'marketplace', 'add', m.source.repo]);
  }
  const results = missing.map((id) => ({ id, r: claude(['plugin', 'install', id, '--scope', 'project']) }));
  state = pluginState();
  return ids.map((id) => {
    if (isInstalledHere(state, id)) return `${id}: installed`;
    const failed = results.find((x) => x.id === id);
    return `${id}: NOT installed (${failed ? failed.r.text : 'unknown reason'})`;
  });
}

// ---- CLAUDE.md block -------------------------------------------------------

const BLOCK_START = '<!-- inv-forge:start (managed by /forge-setup; edit the source in inv-forge, not here) -->';
const BLOCK_END = '<!-- inv-forge:end -->';

function claudeBlock() {
  return [
    BLOCK_START,
    '## This project is built with inv-forge',
    '',
    'It is an Innovation-owned app, held to a stricter standard than a starter project. The working method and',
    'the active controls are printed at the start of every session; the rules live in the `forge-backend` and',
    '`forge-frontend` skills. Hooks and CI enforce them, so a rule that is in the way is a reason to stop and',
    'ask the maintainer, never something to work around.',
    '',
    '- After a starter `/upgrade`, run `/forge-setup` again: the upgrade can drop the hook wiring.',
    '- `node .claude/forge/check.js` runs the same checks as CI.',
    '- `.claude/forge/config.json` holds each control\'s mode (off / warn / block). Only the maintainer changes it.',
    BLOCK_END,
  ].join('\n');
}

function upsertBlock(text, block) {
  const start = text.indexOf(BLOCK_START.slice(0, 20));
  const end = text.indexOf(BLOCK_END);
  if (start >= 0 && end > start) return text.slice(0, start) + block + text.slice(end + BLOCK_END.length);
  const lines = text.split('\n');
  const h1 = lines.findIndex((l) => /^# /.test(l));
  if (h1 < 0) return block + '\n\n' + text;
  lines.splice(h1 + 1, 0, '', block);
  return lines.join('\n');
}

// ---- vendored Angular skill ------------------------------------------------

function vendorAngularSkill() {
  const dest = path.join(ROOT, '.claude', 'skills', 'angular-developer');
  if (fs.existsSync(dest)) return 'already present (left untouched)';
  if (flags.offline) return 'skipped (--offline)';
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-angular-'));
  const git = (args) => cp.execFileSync('git', args, { cwd: tmp, stdio: 'ignore', timeout: 120000 });
  try {
    git(['init', '-q']);
    git(['remote', 'add', 'origin', PINS.angularSkill.repo]);
    git(['fetch', '-q', '--depth', '1', 'origin', PINS.angularSkill.commit]);
    git(['checkout', '-q', 'FETCH_HEAD']);
    const n = copyDir(path.join(tmp, 'angular-developer'), dest).length;
    if (!n) throw new Error('skill folder not found at the pinned commit');
    return `installed at ${PINS.angularSkill.commit.slice(0, 8)} (${n} files)`;
  } catch (e) {
    return `NOT installed (${e.message.split('\n')[0]}); run setup again with network access`;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ---- backend scaffold ------------------------------------------------------
// Four layers, zero warnings, one working use case tested at both levels. It is the starting
// structure, not sample code: the status endpoint is real and stays.

function scaffoldBackend(name) {
  if (!/^[A-Z][A-Za-z0-9]*(\.[A-Z][A-Za-z0-9]*)*$/.test(String(name))) {
    fail('--scaffold-backend expects a .NET name such as Billing or Acme.Billing');
  }
  let hasProjects = false;
  walk(path.join(ROOT, 'api'), (file) => { if (file.endsWith('.csproj')) hasProjects = true; });
  if (hasProjects) fail('api/ already contains .NET projects. The scaffold only creates a backend where there is none.');
  const raice = readJson(path.join(ROOT, 'raice.json'), {}) || {};
  const pkg = readJson(path.join(ROOT, 'package.json'), {}) || {};
  const slug = String((raice.project && raice.project.name) || pkg.name || name).toLowerCase().replace(/[^a-z0-9-]+/g, '-');
  let from = null;
  const fill = (s) => s.split('__NAME__').join(name).split('__SLUG__').join(slug);
  const created = [];
  const visit = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { visit(full); continue; }
      const rel = fill(path.relative(from, full));
      writeText(path.join(ROOT, 'api', rel), fill(fs.readFileSync(full, 'utf8')));
      created.push(posix(rel));
    }
  };
  const visitFrom = (dir) => { from = dir; visit(dir); };
  visitFrom(path.join(FORGE_HOME, 'templates', 'backend'));
  if (flags.efcore) visitFrom(path.join(FORGE_HOME, 'templates', 'backend-efcore'));
  return { name, slug, files: new Set(created).size, efcore: !!flags.efcore };
}

// ---- drift check -----------------------------------------------------------

function drift(d) {
  const problems = [];
  walk(path.join(FORGE_HOME, 'runtime'), (file) => {
    const rel = posix(path.relative(path.join(FORGE_HOME, 'runtime'), file));
    const installed = readText(path.join(FORGE_DIR, rel));
    if (installed === null) problems.push(`missing .claude/forge/${rel}`);
    else if (installed !== readText(file)) problems.push(`outdated or modified .claude/forge/${rel}`);
  });
  if (!exists('.claude', 'forge', 'config.json')) problems.push('missing .claude/forge/config.json');
  const wired = JSON.stringify((readJson(path.join(ROOT, '.claude', 'settings.json'), {}) || {}).hooks || {});
  if (!exists('.claude', 'forge', 'arch-baseline.json')) problems.push('missing .claude/forge/arch-baseline.json');
  for (const f of ['session-start.js', 'pre-edit.js', 'pre-bash.js', 'skill-log.js', 'post-edit.js', 'stop-verify.js']) {
    if (!wired.includes(`.claude/forge/hooks/${f}`)) problems.push(`hook not wired in .claude/settings.json: ${f}`);
  }
  for (const s of ['forge-backend', 'forge-frontend']) {
    if (!exists('.claude', 'skills', s, 'SKILL.md')) problems.push(`missing skill ${s}`);
  }
  if (d.hasFrontend && !exists('.claude', 'skills', 'angular-developer', 'SKILL.md')) problems.push('missing skill angular-developer');
  if (!(readText(path.join(ROOT, 'CLAUDE.md')) || '').includes(BLOCK_END)) problems.push('CLAUDE.md has no inv-forge block');
  if (!flags.offline) {
    const state = pluginState();
    for (const id of Object.keys(wantedPlugins(d))) {
      if (!isInstalledHere(state, id)) problems.push(`plugin not installed on this machine: ${id}`);
    }
  }
  const installedVersion = (readJson(path.join(FORGE_DIR, 'forge.json'), {}) || {}).version;
  if (installedVersion && installedVersion !== VERSION) problems.push(`installed version ${installedVersion}, available ${VERSION}`);
  return problems;
}

// ---- main ------------------------------------------------------------------

if (!fs.existsSync(path.join(ROOT, 'package.json'))) fail(`${ROOT} has no package.json. Run this in the project root.`);
const scaffolded = flags.scaffold && !flags.check ? scaffoldBackend(flags.scaffold) : null;
const d = detect();
if (!d.isGit) fail('The project is not a git repository. The controls compare against git, so run `git init` and commit first.');

if (flags.check) {
  const problems = drift(d);
  if (!problems.length) { console.log(`inv-forge ${VERSION} is fully installed.\n\nRESULT: ok`); process.exit(0); }
  console.log('inv-forge drift:\n- ' + problems.join('\n- ') + '\n\nRESULT: drift');
  process.exit(1);
}

const previous = readJson(path.join(FORGE_DIR, 'forge.json'), null);
const preset = flags.preset || (previous && previous.preset) || (d.sourceFiles > 40 ? 'existing' : 'new');
if (!['new', 'existing'].includes(preset)) fail('--preset is "new" or "existing"');

// 1. runtime (always replaced: it is versioned with inv-forge)
fs.rmSync(path.join(FORGE_DIR, 'hooks'), { recursive: true, force: true });
copyDir(path.join(FORGE_HOME, 'runtime'), FORGE_DIR);

// 2. config (the project's own values survive; only missing keys are added)
const configFile = path.join(FORGE_DIR, 'config.json');
const hadConfig = fs.existsSync(configFile);
const defaults = defaultConfig(d, preset);
const config = mergeDefaults(defaults, readJson(configFile, undefined));
// A zone created before its code existed has no verify commands yet: give it the detected ones.
for (const [name, zone] of Object.entries(config.zones)) {
  if (!zone.verify.length && defaults.zones[name]) zone.verify = defaults.zones[name].verify;
}
for (const a of flags.set) applySet(config, a);
writeJson(configFile, config);

// 2b. structure-rule baseline: recorded once, then only when the maintainer asks for it
const baselineFile = path.join(FORGE_DIR, 'arch-baseline.json');
const hadBaseline = fs.existsSync(baselineFile);
if (!hadBaseline || flags.baseline) {
  writeJson(baselineFile, require(path.join(FORGE_DIR, 'rules.js')).buildBaseline(config));
}
const baseline = readJson(baselineFile, {});

// 3. skills
for (const s of ['forge-backend', 'forge-frontend']) {
  copyDir(path.join(FORGE_HOME, 'templates', 'skills', s), path.join(ROOT, '.claude', 'skills', s));
}
const angular = d.hasFrontend ? vendorAngularSkill() : 'not needed (no Angular app found)';

// 4. plugins first (the CLI rewrites settings.json), then settings.json, .gitignore, CLAUDE.md
const plugins = installPlugins(d);
const settingsFile = path.join(ROOT, '.claude', 'settings.json');
writeJson(settingsFile, mergeSettings(readJson(settingsFile, {}), d));

const ignoreFile = path.join(ROOT, '.gitignore');
const ignore = readText(ignoreFile) || '';
if (!ignore.includes('.claude/forge/.state/')) {
  writeText(ignoreFile, ignore.replace(/\n*$/, '\n') + '\n# inv-forge per-session state\n.claude/forge/.state/\n');
}

const claudeFile = path.join(ROOT, 'CLAUDE.md');
writeText(claudeFile, upsertBlock(readText(claudeFile) || '# CLAUDE.md\n', claudeBlock()));

// 5. CI example and manifest
writeText(path.join(FORGE_DIR, 'ci-example.yml'), readText(path.join(FORGE_HOME, 'templates', 'ci-example.yml')));
writeJson(path.join(FORGE_DIR, 'forge.json'), {
  version: VERSION,
  preset,
  installedAt: new Date().toISOString(),
  previousVersion: previous ? previous.version : null,
  pins: { angularSkill: PINS.angularSkill.commit, plugins: Object.keys(wantedPlugins(d)) },
});

// ---- report ----------------------------------------------------------------

const lines = [];
lines.push(`inv-forge ${VERSION} ${previous ? 'updated' : 'installed'} in ${ROOT}`);
lines.push('');
lines.push(`Preset: ${preset}${flags.preset ? '' : previous ? ' (kept from the previous install)' : ` (auto-detected from ${d.sourceFiles} source files)`}`);
lines.push(`Frontend: ${d.hasFrontend ? 'Angular ' + d.angular : 'not found'}`);
lines.push(`Backend:  ${d.hasBackend ? (d.solution || 'projects under api/') + (d.usesEfCore ? ', EF Core' : '') : 'not found (the 4-layer scaffold arrives in delivery 2)'}`);
if (scaffolded) lines.push(`Scaffold: created ${scaffolded.files} files under api/ for ${scaffolded.name}, served at /${scaffolded.slug}/api${scaffolded.efcore ? ', with EF Core and the query counter' : ''}`);
lines.push(`Angular skill: ${angular}`);
lines.push('Plugins:');
for (const p of plugins) lines.push(`  ${p}`);
lines.push(`Config: ${hadConfig ? 'kept the project\'s values, added any new keys' : 'created with defaults'}`);
lines.push('');
lines.push('Controls:');
for (const c of CONTROLS) lines.push(`  ${c.padEnd(13)} ${config.controls[c]}`);
lines.push('');
const totals = Object.entries(baseline).map(([rule, perFile]) => [rule, Object.values(perFile).reduce((a, b) => a + b, 0)]).sort((a, b) => b[1] - a[1]);
lines.push(`Structure-rule baseline (${!hadBaseline ? 'recorded now' : flags.baseline ? 're-recorded now' : 'kept'}): ` +
  (totals.length ? 'existing violations that are tolerated until migrated' : 'clean, no existing violations'));
for (const [rule, n] of totals) lines.push(`  ${rule.padEnd(24)} ${n}`);
lines.push('');
lines.push('Verify commands (run when a turn ends, only for the zone that was touched):');
for (const [name, z] of Object.entries(config.zones)) {
  lines.push(`  ${name}:`);
  for (const c of z.verify) lines.push(`    ${c}`);
  if (!z.verify.length) lines.push('    (none: add them to .claude/forge/config.json)');
}
lines.push('');
lines.push('Needs a human:');
if (!d.starterSetUp) lines.push('  - raice.json not found: the starter\'s /setup has not been run in this project.');
if (plugins.some((p) => p.includes('NOT installed'))) lines.push('  - Some plugins are not installed (see above). Sessions will start without those skills until they are.');
if (!d.ciRunsForge) lines.push('  - CI does not run the forge checks yet. See .claude/forge/ci-example.yml' + (d.workflows.length ? ` and add the step to ${d.workflows.join(', ')}.` : '.'));
lines.push('  - Restart the Claude session: hooks and plugins load when a session starts.');
lines.push('  - Confirm the verify commands above pass today and need no external service (database, VPN).');
console.log(lines.join('\n') + '\n\nRESULT: ok');
