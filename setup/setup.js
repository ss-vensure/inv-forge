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
//   node setup.js [projectDir] --ci-example    also write an example CI step (checks are local by default)
//   node setup.js [projectDir] --except tdd --paths "api/src/**/Import*.cs" --reason "..." [--days 14]
//   node setup.js [projectDir] --exceptions    list them        --revoke <id>   remove one
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
const FORGE_SKILLS = ['forge-backend', 'forge-frontend', 'forge-review'];
const CONTROLS = ['skills', 'plan', 'tdd', 'suppressions', 'security', 'protected', 'architecture', 'deadCode', 'verify', 'review', 'changeSize', 'audit'];
// Controls that existed in an earlier version. Their keys are dropped from a project's config on update.
const RETIRED = ['mutation'];

// ---- arguments -------------------------------------------------------------

const argv = process.argv.slice(2);
const flags = { check: false, offline: false, baseline: false, preset: null, set: [], except: null, revoke: null, exceptions: false, ciExample: false };
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
  else if (a === '--except') flags.except = Object.assign(flags.except || {}, { control: argv[++i] });
  else if (a === '--paths') flags.except = Object.assign(flags.except || {}, { paths: argv[++i] });
  else if (a === '--reason') flags.except = Object.assign(flags.except || {}, { reason: argv[++i] });
  else if (a === '--days') flags.except = Object.assign(flags.except || {}, { days: Number(argv[++i]) });
  else if (a === '--revoke') flags.revoke = argv[++i];
  else if (a === '--exceptions') flags.exceptions = true;
  else if (a === '--ci-example') flags.ciExample = true;
  else if (a === '--local') flags.local = true;
  else if (a === '--shared') flags.shared = true;
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
  // Optional tools the project may already have. inv-forge uses them; it does not install them.
  d.hasKnip = !!deps.knip;
  return d;
}

// ---- default configuration -------------------------------------------------

const PLANS_DIR = 'docs/forge/plans';

// Which skills must be loaded before which files change. Ours carry the house rules; the official ones
// (Superpowers, the .NET plugins, Angular) carry the method and the framework. Names are the skill names
// as the plugins ship them; a session may invoke them as plugin:skill.
function defaultSkillRules(d, zones) {
  const rules = [];
  if (zones.backend) {
    rules.push({ paths: ['api/**'], skills: ['forge-backend', 'test-driven-development'], why: 'our backend rules; test first' });
    rules.push({ paths: ['api/**/*.Api/**', 'api/**/*Endpoints.cs', 'api/**/*Controller.cs'], skills: ['dotnet-webapi'], why: 'official ASP.NET Core API guidance' });
    rules.push({ paths: zones.backend.tests, skills: ['code-testing'], why: 'official .NET testing guidance' });
    if (d.usesEfCore) {
      rules.push({ paths: ['api/**/*.Infrastructure/**', 'api/**/*DbContext.cs', 'api/**/*Repository.cs'], skills: ['optimizing-ef-core-queries'], why: 'official EF Core guidance' });
    }
  }
  if (zones.frontend) {
    rules.push({ paths: ['src/**'], skills: ['forge-frontend', 'angular-developer', 'test-driven-development'], why: 'our frontend rules; official Angular guidance; test first' });
  }
  rules.push({ paths: [PLANS_DIR + '/**'], skills: ['brainstorming', 'writing-plans'], why: 'a plan starts from a design the user agreed to' });
  return rules;
}

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
      security: 'block',     // judges only added lines, so it is safe on legacy code too
      deadCode: strict ? 'block' : 'warn',
      plan: strict ? 'block' : 'warn',
      review: strict ? 'block' : 'warn',
      audit: 'warn',         // runs only with check.js --audit
    },
    plan: { requiredFromLines: 150, maxAgeDays: 14 },
    review: { requiredFromRisk: 'medium' },
    deadCode: { commands: d.hasKnip ? ['npx knip --no-config-hints'] : [] },
    audit: {
      commands: [
        ...(d.hasFrontend ? ['npm audit --omit=dev --audit-level=high'] : []),
        ...(d.solution ? [{ command: `dotnet list "${d.solution}" package --vulnerable --include-transitive`, failOn: 'has the following vulnerable packages' }] : []),
      ],
    },
    zones,
    ignore: ['**/*.md', '**/bin/**', '**/obj/**'],
    protected: ['.claude/forge/**', '.claude/settings.json', AGENT_FILES, 'node_modules/**'],
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
    plansDir: PLANS_DIR,
    skillRules: defaultSkillRules(d, zones),
    method: { beforeDone: ['verification-before-completion'] },
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
  SubagentStop: [{ hooks: [{ type: 'command', command: hookCmd('stop-verify.js'), timeout: 1800 }] }],
  UserPromptSubmit: [{ hooks: [{ type: 'command', command: hookCmd('prompt-route.js') }] }],
};
const WIRED_HOOKS = ['session-start.js', 'pre-edit.js', 'pre-bash.js', 'skill-log.js', 'post-edit.js', 'stop-verify.js', 'prompt-route.js'];

// The agents a routed request is delegated to, and the zone each one needs (null: any project).
// Keep in step with AGENTS in runtime/lib.js; a test checks it.
const FORGE_AGENTS = { 'forge-backend-dev': 'backend', 'forge-frontend-dev': 'frontend', 'forge-debugger': null, 'forge-refactorer': null, 'forge-test-reviewer': null };
const AGENT_FILES = '.claude/agents/forge-*.md';
const LOCAL_EXCLUDES = ['.claude/forge/', AGENT_FILES, '.claude/skills/forge-*/', '.claude/skills/angular-developer/', '.claude/settings.local.json'];
const agentFile = (name) => path.join(ROOT, '.claude', 'agents', name + '.md');
const wantedAgents = (zones) => Object.keys(FORGE_AGENTS).filter((a) => !FORGE_AGENTS[a] || zones[FORGE_AGENTS[a]]);
const isForgeGroup = (g) => ((g && g.hooks) || []).some((h) => /\.claude\/forge\//.test(h.command || ''));

// A language server gives Claude the compiler's own errors and "who uses this", instead of a guess.
// Its plugin is only a pointer to a program on the machine, so it is enabled only where that program is.
function onPath(bin) {
  const exts = process.platform === 'win32' ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';') : [''];
  return (process.env.PATH || '').split(path.delimiter).some((dir) => dir && exts.some((e) =>
    fs.existsSync(path.join(dir, bin + e)) || fs.existsSync(path.join(dir, bin + e.toLowerCase()))));
}
const languageServers = (d) => PINS.languageServers
  .filter((s) => (s.zone === 'backend' ? d.hasBackend : d.hasFrontend))
  .map((s) => Object.assign({ found: onPath(s.binary) }, s));

function wantedPlugins(d) {
  const plugins = Object.assign({}, PINS.plugins.always);
  if (d.hasBackend) Object.assign(plugins, PINS.plugins.backend);
  if (d.usesEfCore) Object.assign(plugins, PINS.plugins.efcore);
  for (const s of languageServers(d)) if (s.found) plugins[s.plugin] = true;
  return plugins;
}

// The Angular CLI's own MCP server: best practices and documentation for the version this project uses,
// read-only tools only. Shared wiring puts it in .mcp.json; local wiring registers it for this developer.
const MCP = PINS.angularMcp;
const wantsAngularMcp = (d) => d.hasFrontend && parseInt(String(d.angular).replace(/^\D+/, ''), 10) >= MCP.minAngular;
function wireAngularMcp(d) {
  if (!wantsAngularMcp(d)) return 'not needed (no Angular ' + MCP.minAngular + '+ app)';
  if (WIRING === 'shared') {
    const file = path.join(ROOT, '.mcp.json');
    const json = readJson(file, {}) || {};
    json.mcpServers = Object.assign({}, json.mcpServers, { [MCP.name]: MCP.server });
    writeJson(file, json);
    return `${MCP.name} in .mcp.json (read-only tools)`;
  }
  if (flags.offline) return `${MCP.name}: NOT connected (--offline)`;
  if (!claude(['--version']).ok) return `${MCP.name}: NOT connected (the claude CLI is not on PATH)`;
  if (claude(['mcp', 'get', MCP.name]).ok) return `${MCP.name} connected for this developer (read-only tools)`;
  const r = claude(['mcp', 'add', '--scope', 'local', MCP.name, '--', MCP.server.command, ...MCP.server.args]);
  return r.ok ? `${MCP.name} connected for this developer (read-only tools)` : `${MCP.name}: NOT connected (${r.text})`;
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
  if (WIRING === 'shared' && wantsAngularMcp(d)) s.enabledMcpjsonServers = [...new Set([...(s.enabledMcpjsonServers || []), MCP.name])];
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
  const results = missing.map((id) => ({ id, r: claude(['plugin', 'install', id, '--scope', WIRING === 'local' ? 'local' : 'project']) }));
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

function removeBlock(text) {
  const start = text.indexOf(BLOCK_START.slice(0, 20));
  const end = text.indexOf(BLOCK_END);
  if (start < 0 || end < start) return text;
  return text.slice(0, start).replace(/\n+$/, '\n') + text.slice(end + BLOCK_END.length).replace(/^\n+/, '\n');
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
  return { name, slug, files: new Set(created).size, efcore: !!flags.efcore, wired: wireDevLoop(name, slug) };
}

// Makes `npm run api` + `npm start` work together: the Angular dev server forwards the API's
// route to the .NET process on port 5080. Existing entries are left as they are.
function wireDevLoop(name, slug) {
  const done = [];
  const pkgFile = path.join(ROOT, 'package.json');
  const pkg = readJson(pkgFile, null);
  if (pkg) {
    pkg.scripts = pkg.scripts || {};
    const wanted = {
      api: `dotnet watch --project api/src/${name}.Api --no-hot-reload`,
      'test:api': `dotnet test api/${name}.slnx --nologo`,
    };
    for (const [script, command] of Object.entries(wanted)) {
      if (!pkg.scripts[script]) { pkg.scripts[script] = command; done.push(`npm run ${script}`); }
    }
    writeJson(pkgFile, pkg);
  }
  const proxyFile = path.join(ROOT, 'proxy.conf.json');
  const proxy = readJson(proxyFile, {}) || {};
  if (!proxy[`/${slug}/api`]) {
    proxy[`/${slug}/api`] = { target: 'http://localhost:5080', secure: false, changeOrigin: false, logLevel: 'warn' };
    writeJson(proxyFile, proxy);
    done.push('proxy.conf.json');
  }
  const angularFile = path.join(ROOT, 'angular.json');
  const angular = readJson(angularFile, null);
  if (angular && angular.projects) {
    let changed = false;
    for (const project of Object.values(angular.projects)) {
      const serve = project.architect && project.architect.serve;
      if (!serve) continue;
      serve.options = serve.options || {};
      if (!serve.options.proxyConfig) { serve.options.proxyConfig = 'proxy.conf.json'; changed = true; }
    }
    if (changed) { writeJson(angularFile, angular); done.push('angular.json proxyConfig'); }
  }
  return done;
}

// ---- exceptions ------------------------------------------------------------
// Granted and revoked here, by the maintainer, in their own terminal. A session cannot.

function manageExceptions() {
  const file = path.join(FORGE_DIR, 'exceptions.json');
  if (!fs.existsSync(path.join(FORGE_DIR, 'config.json'))) fail('inv-forge is not installed in this project yet.');
  let list = readJson(file, []) || [];
  const today = new Date().toISOString().slice(0, 10);
  const out = [];
  if (flags.except) {
    const e = flags.except;
    const family = String(e.control || '').split('/')[0];
    if (!CONTROLS.includes(family) || family === 'protected') fail(`--except needs a control (not "protected"): ${CONTROLS.filter((c) => c !== 'protected').join(', ')}, or architecture/<rule>`);
    if (!e.paths) fail('--except needs --paths "glob[,glob]": an exception is always for named files');
    if (!e.reason || e.reason.trim().length < 10) fail('--except needs --reason "why this rule cannot be met here" (at least a sentence)');
    const days = e.days || 14;
    if (!(days >= 1 && days <= 90)) fail('--days is between 1 and 90: an exception is temporary by definition');
    const expires = new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
    const id = 'x' + Date.now().toString(36);
    list.push({ id, control: e.control, paths: e.paths.split(',').map((p) => p.trim()).filter(Boolean), reason: e.reason.trim(), grantedAt: today, expires });
    out.push(`Granted ${id}: ${e.control} on ${e.paths} until ${expires}`);
  }
  if (flags.revoke) {
    const before = list.length;
    list = list.filter((e) => e.id !== flags.revoke);
    out.push(before === list.length ? `No exception with id ${flags.revoke}` : `Revoked ${flags.revoke}`);
  }
  if (flags.except || flags.revoke) writeJson(file, list);
  out.push('');
  out.push(list.length ? 'Exceptions:' : 'No exceptions.');
  for (const e of list) {
    out.push(`  ${e.id}  ${e.expires < today ? 'EXPIRED' : 'active '}  ${e.control}  ${e.paths.join(', ')}  until ${e.expires}  "${e.reason}"`);
  }
  console.log(out.join('\n') + '\n\nRESULT: ok');
  process.exit(0);
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
  const wired = JSON.stringify((readJson(path.join(ROOT, '.claude', SETTINGS_NAME), {}) || {}).hooks || {});
  if (!exists('.claude', 'forge', 'arch-baseline.json')) problems.push('missing .claude/forge/arch-baseline.json');
  for (const f of WIRED_HOOKS) {
    if (!wired.includes(`.claude/forge/hooks/${f}`)) problems.push(`hook not wired in .claude/${SETTINGS_NAME}: ${f}`);
  }
  const zones = (readJson(path.join(FORGE_DIR, 'config.json'), {}) || {}).zones || {};
  for (const a of wantedAgents(zones)) {
    if (readText(agentFile(a)) !== readText(path.join(FORGE_HOME, 'templates', 'agents', a + '.md'))) problems.push(`missing or modified agent ${a}`);
  }
  for (const s of FORGE_SKILLS) {
    if (!exists('.claude', 'skills', s, 'SKILL.md')) problems.push(`missing skill ${s}`);
  }
  if (d.hasFrontend && !exists('.claude', 'skills', 'angular-developer', 'SKILL.md')) problems.push('missing skill angular-developer');
  if (WIRING === 'shared' && !(readText(path.join(ROOT, 'CLAUDE.md')) || '').includes(BLOCK_END)) problems.push('CLAUDE.md has no inv-forge block');
  if (WIRING === 'shared' && wantsAngularMcp(d) && !((readJson(path.join(ROOT, '.mcp.json'), {}) || {}).mcpServers || {})[MCP.name]) problems.push(`.mcp.json has no ${MCP.name} server`);
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
if (flags.except || flags.revoke || flags.exceptions) manageExceptions();
const scaffolded = flags.scaffold && !flags.check ? scaffoldBackend(flags.scaffold) : null;
const d = detect();
if (!d.isGit) fail('The project is not a git repository. The controls compare against git, so run `git init` and commit first.');

// Where the wiring lives. shared: the files the team commits (settings.json, CLAUDE.md, .gitignore).
// local: this developer only (settings.local.json, .git/info/exclude), for a project where inv-forge is
// optional. The choice is remembered, so updates and --check need no flag.
const previous = readJson(path.join(FORGE_DIR, 'forge.json'), null);
if (flags.local && flags.shared) fail('--local and --shared are opposites; pass one.');
const WIRING = flags.local ? 'local' : flags.shared ? 'shared' : (previous && previous.wiring) || 'shared';
const SETTINGS_NAME = WIRING === 'local' ? 'settings.local.json' : 'settings.json';
const OTHER_SETTINGS = WIRING === 'local' ? 'settings.json' : 'settings.local.json';
const LOCAL_SETTINGS = '.claude/settings.local.json';

if (flags.check) {
  const problems = drift(d);
  if (!problems.length) { console.log(`inv-forge ${VERSION} is fully installed (${WIRING} wiring).\n\nRESULT: ok`); process.exit(0); }
  console.log('inv-forge drift:\n- ' + problems.join('\n- ') + '\n\nRESULT: drift');
  process.exit(1);
}

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
// The same for optional tools: an empty list picks up a tool that was installed since.
for (const key of ['deadCode', 'audit']) {
  if (!config[key].commands.length) config[key].commands = defaults[key].commands;
}
// Skill rules: a project keeps its own, and gains any default rule for a skill it does not mention yet
// (EF Core guidance once the project uses EF Core; everything, for a project installed before 0.4).
const mentioned = new Set(config.skillRules.flatMap((r) => r.skills));
for (const rule of defaults.skillRules) {
  if (!rule.skills.some((s) => mentioned.has(s))) config.skillRules.push(rule);
}
for (const zone of Object.values(config.zones)) {
  delete zone.requiredSkill;
  delete zone.alsoUse;
}
if (!config.protected.includes(AGENT_FILES)) config.protected.push(AGENT_FILES);
config.protected = config.protected.filter((p) => p !== LOCAL_SETTINGS).concat(WIRING === 'local' ? [LOCAL_SETTINGS] : []);
for (const key of RETIRED) {
  delete config[key];
  delete config.controls[key];
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
for (const s of FORGE_SKILLS) {
  copyDir(path.join(FORGE_HOME, 'templates', 'skills', s), path.join(ROOT, '.claude', 'skills', s));
}
const angular = d.hasFrontend ? vendorAngularSkill() : 'not needed (no Angular app found)';

// 3b. agents: the ones this project has a zone for; one whose zone is gone is removed
const agents = wantedAgents(config.zones);
for (const a of Object.keys(FORGE_AGENTS)) {
  if (agents.includes(a)) writeText(agentFile(a), readText(path.join(FORGE_HOME, 'templates', 'agents', a + '.md')));
  else fs.rmSync(agentFile(a), { force: true });
}

// 4. plugins first (the CLI rewrites settings.json), then settings.json, .gitignore, CLAUDE.md
const plugins = installPlugins(d);
const settingsFile = path.join(ROOT, '.claude', SETTINGS_NAME);
writeJson(settingsFile, mergeSettings(readJson(settingsFile, {}), d));
const angularMcp = wireAngularMcp(d);
// One place only: hooks wired in both files would run twice.
const otherFile = path.join(ROOT, '.claude', OTHER_SETTINGS);
const other = readJson(otherFile, null);
if (other && other.hooks && JSON.stringify(other.hooks).includes('.claude/forge/hooks/')) {
  for (const event of Object.keys(other.hooks)) {
    other.hooks[event] = other.hooks[event].filter((g) => !isForgeGroup(g));
    if (!other.hooks[event].length) delete other.hooks[event];
  }
  writeJson(otherFile, other);
}

const claudeFile = path.join(ROOT, 'CLAUDE.md');
let localIgnore = null;
if (WIRING === 'local') {
  // Nothing the team commits is touched: our files are ignored for this clone only.
  const gitDir = path.join(ROOT, '.git');
  if (fs.existsSync(gitDir) && fs.statSync(gitDir).isDirectory()) {
    const excludeFile = path.join(gitDir, 'info', 'exclude');
    const exclude = readText(excludeFile) || '';
    const missingLines = LOCAL_EXCLUDES.filter((l) => !exclude.split(/\r?\n/).includes(l));
    if (missingLines.length) {
      fs.mkdirSync(path.dirname(excludeFile), { recursive: true });
      writeText(excludeFile, exclude.replace(/\n*$/, '\n') + (exclude.includes('# inv-forge') ? '' : '# inv-forge (local install)\n') + missingLines.join('\n') + '\n');
    }
    localIgnore = true;
  } else localIgnore = false;
  const claudeText = readText(claudeFile);
  if (claudeText && claudeText.includes(BLOCK_END)) writeText(claudeFile, removeBlock(claudeText));
} else {
  const ignoreFile = path.join(ROOT, '.gitignore');
  const ignore = readText(ignoreFile) || '';
  if (!ignore.includes('.claude/forge/.state/')) {
    writeText(ignoreFile, ignore.replace(/\n*$/, '\n') + '\n# inv-forge per-session state\n.claude/forge/.state/\n');
  }
  writeText(claudeFile, upsertBlock(readText(claudeFile) || '# CLAUDE.md\n', claudeBlock()));
}

// 5. manifest. The checks run locally by design; a CI example is written only on request,
//    so a project is never left with a workflow its next owner cannot run.
const ciExampleFile = path.join(FORGE_DIR, 'ci-example.yml');
if (flags.ciExample) writeText(ciExampleFile, readText(path.join(FORGE_HOME, 'templates', 'ci-example.yml')));
else fs.rmSync(ciExampleFile, { force: true });

// The version of each plugin as installed here, so a change of version is visible in the diff.
const installedPlugins = pluginState().installed;
const pluginVersions = {};
for (const id of Object.keys(wantedPlugins(d))) {
  const entry = (installedPlugins[id] || []).find((e) => e.scope === 'user' || (e.projectPath && samePath(e.projectPath, ROOT)));
  pluginVersions[id] = entry ? `${entry.version || '?'} (${String(entry.gitCommitSha || 'unknown').slice(0, 8)})` : 'not installed';
}
writeJson(path.join(FORGE_DIR, 'forge.json'), {
  version: VERSION,
  preset,
  wiring: WIRING,
  installedAt: new Date().toISOString(),
  previousVersion: previous ? previous.version : null,
  pins: { angularSkill: PINS.angularSkill.commit, plugins: pluginVersions },
});

// ---- report ----------------------------------------------------------------

const lines = [];
lines.push(`inv-forge ${VERSION} ${previous ? 'updated' : 'installed'} in ${ROOT}`);
lines.push('');
lines.push(`Preset: ${preset}${flags.preset ? '' : previous ? ' (kept from the previous install)' : ` (auto-detected from ${d.sourceFiles} source files)`}`);
lines.push(WIRING === 'local'
  ? `Wiring: local. Hooks and plugins are in .claude/${SETTINGS_NAME}; CLAUDE.md and .gitignore are not touched; ` +
    (localIgnore ? 'inv-forge\'s files are ignored through .git/info/exclude, so nothing of it is committed.' : 'could NOT write .git/info/exclude (worktree?): ignore inv-forge\'s files by hand.')
  : 'Wiring: shared (.claude/settings.json, CLAUDE.md, .gitignore). Use --local to install for this developer only.');
lines.push(`Frontend: ${d.hasFrontend ? 'Angular ' + d.angular : 'not found'}`);
lines.push(`Backend:  ${d.hasBackend ? (d.solution || 'projects under api/') + (d.usesEfCore ? ', EF Core' : '') : 'not found (create one with --scaffold-backend <Name>)'}`);
if (scaffolded) {
  lines.push(`Scaffold: created ${scaffolded.files} files under api/ for ${scaffolded.name}, served at /${scaffolded.slug}/api${scaffolded.efcore ? ', with EF Core and the query counter' : ''}`);
  lines.push(`          dev loop wired: ${scaffolded.wired.join(', ') || 'nothing to add'}. The Dockerfile is NOT changed: the image still serves only the Angular build.`);
}
const exceptionList = readJson(path.join(FORGE_DIR, 'exceptions.json'), []) || [];
const isoToday = new Date().toISOString().slice(0, 10);
lines.push(`Exceptions: ${exceptionList.filter((e) => e.expires >= isoToday).length} active, ${exceptionList.filter((e) => e.expires < isoToday).length} expired`);
lines.push(`Angular skill: ${angular}`);
lines.push(`Agents: ${agents.join(', ')} (in .claude/agents/; requests are routed to them automatically)`);
lines.push(`Angular MCP: ${angularMcp}`);
lines.push('Language servers (the compiler\'s errors and find-references for Claude):');
for (const s of languageServers(d)) lines.push(`  ${s.binary}: ${s.found ? 'found, plugin enabled' : 'NOT on this machine'}`);
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
if (flags.ciExample) lines.push('  - A CI example was written to .claude/forge/ci-example.yml. Nothing runs in CI until its step is added to a workflow.');
if (!config.deadCode.commands.length) lines.push('  - No unused-code tool found (knip). Leftovers in a change are still checked; unused files and exports are not.');
for (const s of languageServers(d)) {
  if (!s.found) lines.push(`  - No ${s.binary} on this machine, so Claude works on ${s.zone} code without a language server. To add it: \`${s.install}\`, then run setup again.`);
}
if (angularMcp.includes('NOT connected')) lines.push('  - The Angular MCP server is not connected (see above): Angular questions are answered from the skill alone.');
lines.push('  - Restart the Claude session: hooks and plugins load when a session starts.');
lines.push('  - Confirm the verify commands above pass today and need no external service (database, VPN).');
console.log(lines.join('\n') + '\n\nRESULT: ok');
