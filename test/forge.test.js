'use strict';
// End-to-end tests: build a throwaway project shaped like a RAiCE starter with an api/, install
// inv-forge into it, and drive the hooks exactly as Claude Code does (JSON on stdin, exit codes).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const { FORGE, PASS, FAIL, write, git, makeProject, setup, install, hook, edit, loadSkill, loadZone, settingsOf, configOf } = require('./helpers');

test('setup installs everything and keeps what the starter put there', () => {
  const root = makeProject();
  const r = install(root);
  assert.match(r.out, /RESULT: ok/);
  const s = settingsOf(root);
  assert.ok(s.hooks.SessionStart.some((g) => g.hooks[0].command.includes('welcome.js')), 'starter hook kept');
  assert.ok(s.permissions.allow.includes('Bash(npm install:*)'), 'starter permission kept');
  assert.ok(s.permissions.allow.includes('Bash(dotnet test:*)'));
  assert.ok(s.enabledPlugins['superpowers@claude-plugins-official']);
  assert.ok(s.enabledPlugins['dotnet@dotnet-agent-skills']);
  for (const f of ['lib.js', 'check.js', 'checks.js', 'hooks/pre-edit.js', 'config.json', 'forge.json', 'arch-baseline.json']) {
    assert.ok(fs.existsSync(path.join(root, '.claude', 'forge', f)), f);
  }
  // The checks are local by design: no CI file unless it is asked for.
  assert.ok(!fs.existsSync(path.join(root, '.claude', 'forge', 'ci-example.yml')));
  assert.doesNotMatch(r.out, /CI does not run/);
  assert.match(setup(root, '--ci-example').out, /A CI example was written/);
  assert.ok(fs.existsSync(path.join(root, '.claude', 'forge', 'ci-example.yml')));
  assert.strictEqual(setup(root).code, 0);
  assert.ok(!fs.existsSync(path.join(root, '.claude', 'forge', 'ci-example.yml')), 'removed again when not asked for');
  assert.ok(fs.existsSync(path.join(root, '.claude', 'skills', 'forge-backend', 'SKILL.md')));
  const claude = fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8');
  assert.match(claude, /^# CLAUDE\.md\n\n<!-- inv-forge:start/);
  assert.match(claude, /Starter guidance\./);
  assert.match(fs.readFileSync(path.join(root, '.gitignore'), 'utf8'), /\.claude\/forge\/\.state\//);
  assert.strictEqual(setup(root, '--check').code, 0);
});

test('running setup again duplicates nothing and keeps the project\'s config', () => {
  const root = makeProject();
  install(root);
  setup(root, '--set', 'controls.tdd=warn', '--set', 'changeSize.maxLines=250');
  const before = { settings: fs.readFileSync(path.join(root, '.claude', 'settings.json'), 'utf8'), claude: fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8') };
  assert.strictEqual(setup(root).code, 0);
  assert.strictEqual(fs.readFileSync(path.join(root, '.claude', 'settings.json'), 'utf8'), before.settings);
  assert.strictEqual(fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8'), before.claude);
  const c = configOf(root);
  assert.strictEqual(c.controls.tdd, 'warn');
  assert.strictEqual(c.changeSize.maxLines, 250);
  assert.deepStrictEqual(c.zones.backend.verify, [PASS]);
  assert.strictEqual(settingsOf(root).hooks.Stop.length, 1);
});

test('a starter upgrade that rewrites settings and CLAUDE.md is detected and repaired', () => {
  const root = makeProject();
  install(root);
  write(root, '.claude/settings.json', JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'node .raice/scripts/welcome.js' }] }] } }));
  write(root, 'CLAUDE.md', '# CLAUDE.md\n\nNew starter guidance.\n');
  const drift = setup(root, '--check');
  assert.strictEqual(drift.code, 1);
  assert.match(drift.out, /hook not wired.*pre-edit\.js/);
  assert.match(drift.out, /CLAUDE\.md has no inv-forge block/);
  const start = hook(root, 'session-start.js', {});
  assert.match(start.out, /partly uninstalled/);
  assert.strictEqual(setup(root).code, 0);
  assert.strictEqual(setup(root, '--check').code, 0);
  assert.deepStrictEqual(configOf(root).zones.backend.verify, [PASS], 'config survived');
});

test('local install: nothing the team commits is touched, and it stays local on update', () => {
  const root = makeProject();
  const before = ['.claude/settings.json', 'CLAUDE.md', '.gitignore'].map((f) => fs.readFileSync(path.join(root, f), 'utf8'));
  const r = setup(root, '--local', '--preset', 'new');
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, /Wiring: local/);
  const after = ['.claude/settings.json', 'CLAUDE.md', '.gitignore'].map((f) => fs.readFileSync(path.join(root, f), 'utf8'));
  assert.deepStrictEqual(after, before, 'shared files unchanged');
  assert.strictEqual(git(root, 'status', '--porcelain').trim(), '', 'nothing of inv-forge shows up in git');
  const local = JSON.parse(fs.readFileSync(path.join(root, '.claude', 'settings.local.json'), 'utf8'));
  assert.match(JSON.stringify(local.hooks), /prompt-route\.js/);
  assert.ok(configOf(root).protected.includes('.claude/settings.local.json'));
  assert.strictEqual(setup(root, '--check').code, 0, 'check looks at the local wiring');
  assert.doesNotMatch(hook(root, 'session-start.js', {}).out, /partly uninstalled/);
  // An update with no flag remembers the choice.
  assert.strictEqual(setup(root).code, 0);
  assert.deepStrictEqual(['.claude/settings.json', 'CLAUDE.md', '.gitignore'].map((f) => fs.readFileSync(path.join(root, f), 'utf8')), before);
  assert.strictEqual(JSON.stringify(local.hooks), JSON.stringify(JSON.parse(fs.readFileSync(path.join(root, '.claude', 'settings.local.json'), 'utf8')).hooks), 'no duplicates');
});

test('local install: moving a shared install to local takes our wiring out of the shared files', () => {
  const root = makeProject();
  install(root);
  assert.strictEqual(setup(root, '--local').code, 0);
  assert.doesNotMatch(JSON.stringify(settingsOf(root).hooks), /\.claude\/forge\//);
  assert.match(JSON.stringify(settingsOf(root).hooks), /welcome\.js/, 'the starter\'s own hook stays');
  const claude = fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8');
  assert.doesNotMatch(claude, /inv-forge/);
  assert.match(claude, /Starter guidance\./);
  assert.strictEqual(setup(root, '--check').code, 0);
  // And back.
  assert.strictEqual(setup(root, '--shared').code, 0);
  assert.match(JSON.stringify(settingsOf(root).hooks), /pre-edit\.js/);
  assert.doesNotMatch(fs.readFileSync(path.join(root, '.claude', 'settings.local.json'), 'utf8'), /\.claude\/forge\/hooks/);
  assert.strictEqual(setup(root, '--check').code, 0);
});

test('tools: the Angular MCP server is wired read-only, and a language server only where its program exists', () => {
  const root = makeProject();
  install(root);
  const mcp = JSON.parse(fs.readFileSync(path.join(root, '.mcp.json'), 'utf8')).mcpServers['angular-cli'];
  assert.deepStrictEqual(mcp.args.slice(-2), ['mcp', '--read-only']);
  assert.ok(settingsOf(root).enabledMcpjsonServers.includes('angular-cli'));
  fs.rmSync(path.join(root, '.mcp.json'));
  assert.match(setup(root, '--check').out, /\.mcp\.json has no angular-cli server/);

  // A machine that has the TypeScript language server but not the C# one.
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-bin-'));
  for (const ext of ['', '.cmd']) fs.writeFileSync(path.join(bin, 'typescript-language-server' + ext), '');
  const env = Object.assign({}, process.env, { PATH: bin, PATHEXT: '.CMD' });
  const r = cp.spawnSync(process.execPath, [path.join(FORGE, 'setup', 'setup.js'), root, '--offline'], { encoding: 'utf8', env });
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /typescript-language-server: found, plugin enabled/);
  assert.match(r.stdout, /csharp-ls: NOT on this machine/);
  assert.match(r.stdout, /dotnet tool install --global csharp-ls/);
  const plugins = settingsOf(root).enabledPlugins;
  assert.strictEqual(plugins['typescript-lsp@claude-plugins-official'], true);
  assert.ok(!('csharp-lsp@claude-plugins-official' in plugins));
});

test('invalid settings are refused', () => {
  const root = makeProject();
  install(root);
  assert.strictEqual(setup(root, '--set', 'controls.tdd=sometimes').code, 1);
  assert.strictEqual(setup(root, '--set', 'controls.nope=off').code, 1);
});

test('skills: a file cannot be edited until our skill and the official ones for it are loaded', () => {
  const root = makeProject();
  install(root);
  const blocked = edit(root, 'src/app/people/people.component.ts');
  assert.strictEqual(blocked.code, 2);
  assert.match(blocked.err, /"forge-frontend", "angular-developer", "test-driven-development"/);
  loadSkill(root, 'forge-frontend');
  const partly = edit(root, 'src/app/people/people.component.ts');
  assert.strictEqual(partly.code, 2, 'our own skill is not enough');
  assert.doesNotMatch(partly.err, /forge-frontend/);
  loadSkill(root, 'angular-developer');
  loadSkill(root, 'superpowers:test-driven-development'); // a plugin skill counts under its short name
  assert.strictEqual(edit(root, 'src/app/people/people.component.ts').code, 0);

  const csproj = 'api/src/Demo.Domain/Demo.Domain.csproj';
  assert.match(edit(root, csproj).err, /Load "forge-backend" before/, 'the other zone still needs its own skill');
  // Reading the SKILL.md counts as loading it.
  hook(root, 'skill-log.js', { tool_name: 'Read', tool_input: { file_path: path.join(root, '.claude', 'skills', 'forge-backend', 'SKILL.md') } });
  assert.strictEqual(edit(root, csproj).code, 0);
});

test('skills: the official skill depends on what the file is', () => {
  const root = makeProject();
  install(root);
  loadSkill(root, 'forge-backend');
  loadSkill(root, 'superpowers:test-driven-development');
  assert.match(edit(root, 'api/src/Demo.Api/Endpoints/PriceEndpoints.cs').err, /Load "dotnet-webapi" before/);
  assert.match(edit(root, 'api/tests/Demo.Domain.Tests/PriceTests.cs').err, /Load "code-testing" before/);
  assert.match(edit(root, 'docs/forge/plans/prices.md').err, /Load "brainstorming", "writing-plans" before/);
  loadSkill(root, 'superpowers:brainstorming');
  loadSkill(root, 'superpowers:writing-plans');
  assert.strictEqual(edit(root, 'docs/forge/plans/prices.md').code, 0);
});

test('skills: production code is not presented as done before the finishing skill was loaded', () => {
  const root = makeProject();
  install(root);
  write(root, 'src/app/people/people.component.ts', 'export class PeopleComponent {\n  readonly title = "People";\n}\n');
  const fresh = { session_id: 's2' };
  const r = hook(root, 'stop-verify.js', fresh);
  assert.strictEqual(r.code, 2);
  assert.match(r.err, /"verification-before-completion" was not loaded/);
  hook(root, 'skill-log.js', Object.assign({ tool_name: 'Skill', tool_input: { skill: 'superpowers:verification-before-completion' } }, fresh));
  assert.doesNotMatch(hook(root, 'stop-verify.js', fresh).err, /verification-before-completion/);
});

test('skills: updating a project installed before skill rules existed gives it the rules', () => {
  const root = makeProject();
  install(root);
  const file = path.join(root, '.claude', 'forge', 'config.json');
  const old = configOf(root);
  delete old.skillRules;
  delete old.method;
  old.zones.frontend.requiredSkill = 'forge-frontend';
  old.zones.frontend.alsoUse = ['the angular-developer skill'];
  fs.writeFileSync(file, JSON.stringify(old, null, 1));
  setup(root);
  const now = configOf(root);
  assert.strictEqual(now.zones.frontend.requiredSkill, undefined);
  assert.strictEqual(now.zones.frontend.alsoUse, undefined);
  assert.ok(now.skillRules.some((r) => r.skills.includes('angular-developer')));
  assert.deepStrictEqual(now.method.beforeDone, ['verification-before-completion']);
});

test('tdd: behaviour code needs a changed test first; components and docs do not', () => {
  const root = makeProject();
  install(root);
  loadZone(root, 'frontend');
  loadZone(root, 'backend');
  assert.strictEqual(edit(root, 'src/app/core/rules.ts').code, 2);
  assert.strictEqual(edit(root, 'api/src/Demo.Domain/Price.cs').code, 2);
  assert.strictEqual(edit(root, 'src/app/people/people.component.ts').code, 0);
  assert.strictEqual(edit(root, 'api/README.md').code, 0);
  write(root, 'src/app/core/rules.spec.ts', 'it("rejects a negative rule", () => {});\n');
  assert.strictEqual(edit(root, 'src/app/core/rules.ts').code, 0);
  assert.strictEqual(edit(root, 'api/src/Demo.Domain/Price.cs').code, 2, 'a frontend spec does not unlock the backend');
  // Found in a live session: an empty test class used to unlock the edit.
  write(root, 'api/tests/Demo.Domain.Tests/PriceTests.cs', 'public class PriceTests {}\n');
  const empty = edit(root, 'api/src/Demo.Domain/Price.cs');
  assert.strictEqual(empty.code, 2, 'an empty test file is not a test');
  assert.match(empty.err, /an empty test file does not count/);
  write(root, 'api/tests/Demo.Domain.Tests/PriceTests.cs', 'public class PriceTests { [Fact] public void Given_a_negative_value_Then_it_is_rejected() {} }\n');
  assert.strictEqual(edit(root, 'api/src/Demo.Domain/Price.cs').code, 0);
});

test('suppressions: adding one is blocked, editing next to an existing one is not', () => {
  const root = makeProject();
  install(root);
  loadZone(root, 'frontend');
  const file = 'src/app/people/people.component.ts';
  for (const text of ['// eslint-disable-next-line', '// @ts-ignore', 'xit("later", () => {})', ':host ::ng-deep .e-grid { color: red }']) {
    assert.strictEqual(edit(root, file, { new_string: text }).code, 2, text);
  }
  assert.strictEqual(edit(root, file, { old_string: '// eslint-disable-next-line\nconst a = 1;', new_string: '// eslint-disable-next-line\nconst a = 2;' }).code, 0);
  loadZone(root, 'backend');
  assert.strictEqual(edit(root, 'api/src/Demo.Domain/Demo.Domain.csproj', { new_string: '<NoWarn>CS8618</NoWarn>' }).code, 2);
  const w = hook(root, 'pre-edit.js', { tool_name: 'Write', tool_input: { file_path: path.join(root, 'api/tests/Demo.Domain.Tests/T.cs'), content: '[Fact(Skip = "flaky")] public void T() {}' } });
  assert.strictEqual(w.code, 2);
});

test('protected: the forge, the hook wiring and vendor packages are read-only', () => {
  const root = makeProject();
  install(root);
  for (const f of ['.claude/forge/config.json', '.claude/forge/hooks/pre-edit.js', '.claude/settings.json', 'node_modules/@prismhr/components-ng-shared/index.js']) {
    assert.strictEqual(edit(root, f).code, 2, f);
  }
  const bash = (command) => hook(root, 'pre-bash.js', { tool_name: 'Bash', tool_input: { command } }).code;
  assert.strictEqual(bash('sed -i s/block/off/ .claude/forge/config.json'), 2);
  assert.strictEqual(bash('rm -rf .claude/forge'), 2);
  assert.strictEqual(bash('echo {} > .claude/settings.json'), 2);
  assert.strictEqual(bash('node .claude/forge/check.js --base origin/main'), 0);
  assert.strictEqual(bash('node .claude/forge/check.js; rm -rf .claude/forge'), 2);
  assert.strictEqual(bash('npm test'), 0);
  assert.strictEqual(bash('cat .claude/settings.json'), 0);
  // Found in the first live session: a read-only command was blocked just for naming the folder.
  assert.strictEqual(bash('tail -3 src/app/a.ts && grep -n maxLines .claude/forge/config.json 2>/dev/null'), 0);
  assert.strictEqual(bash('git diff .claude/settings.json | head -20'), 0);
  assert.strictEqual(bash('cat .claude/forge/config.json | tee .claude/forge/config.json'), 2);
  assert.strictEqual(bash('grep x $(rm -rf .claude/forge)'), 2);
  assert.strictEqual(bash('node -e "require(\'fs\').rmSync(\'.claude/forge\',{recursive:true})"'), 2);
});

test('files outside the project are ignored', () => {
  const root = makeProject();
  install(root);
  assert.strictEqual(edit(root, path.join('..', 'elsewhere', 'x.ts')).code, 0);
});

test('warn mode never blocks an edit and is reported once when the turn ends', () => {
  const root = makeProject();
  install(root, '--set', 'controls.tdd=warn');
  loadZone(root, 'frontend');
  assert.strictEqual(edit(root, 'src/app/core/rules.ts').code, 0);
  write(root, 'src/app/core/rules.ts', 'export const rule = 2;\n');
  const first = hook(root, 'stop-verify.js', {});
  assert.strictEqual(first.code, 2);
  assert.match(first.err, /\[tdd\] src\/app\/core\/rules\.ts/);
  assert.strictEqual(hook(root, 'stop-verify.js', {}).code, 0, 'reported once, then the turn may end');
});

test('stop: a failing verify blocks, then releases loudly instead of looping forever', () => {
  const root = makeProject();
  install(root, '--set', `zones.frontend.verify=${JSON.stringify([FAIL])}`);
  assert.strictEqual(hook(root, 'stop-verify.js', {}).code, 0, 'nothing changed, nothing to verify');
  write(root, 'src/app/people/people.component.ts', 'export class PeopleComponent { n = 1; }\n');
  for (let i = 0; i < 3; i++) {
    const r = hook(root, 'stop-verify.js', {});
    assert.strictEqual(r.code, 2, `attempt ${i + 1}`);
    assert.match(r.err, /boom: 3 tests failed/);
  }
  const released = hook(root, 'stop-verify.js', {});
  assert.strictEqual(released.code, 0);
  assert.match(JSON.parse(released.out).systemMessage, /STILL FAILING/);
});

test('stop: only the touched zone is verified, and a tree that already passed is not re-run', () => {
  const root = makeProject();
  const marker = path.join(os.tmpdir(), `forge-marker-${process.pid}-${Date.now()}`);
  const touch = `node -e "require('fs').appendFileSync(process.argv[1],'x')" "${marker.replace(/\\/g, '/')}"`;
  install(root, '--set', `zones.backend.verify=${JSON.stringify([FAIL])}`, '--set', `zones.frontend.verify=${JSON.stringify([touch])}`);
  write(root, 'src/app/people/people.component.ts', 'export class PeopleComponent { n = 1; }\n');
  assert.strictEqual(hook(root, 'stop-verify.js', {}).code, 0, 'backend (failing) was not touched');
  assert.strictEqual(hook(root, 'stop-verify.js', {}).code, 0);
  assert.strictEqual(fs.readFileSync(marker, 'utf8'), 'x', 'frontend verify ran exactly once');
  fs.rmSync(marker);
});

test('stop: an oversized slice is reported once', () => {
  const root = makeProject();
  install(root, '--set', 'changeSize.maxLines=5');
  write(root, 'src/app/people/big.component.ts', 'export const a = 1;\n'.repeat(20));
  const r = hook(root, 'stop-verify.js', {});
  assert.strictEqual(r.code, 2);
  assert.match(r.err, /added lines of uncommitted production code; the limit is 5/);
  assert.strictEqual(hook(root, 'stop-verify.js', {}).code, 0);
});

test('check.js applies the same rules to a branch diff and writes a fixed-format result', () => {
  const root = makeProject();
  install(root);
  git(root, 'checkout', '-q', '-b', 'feature');
  write(root, 'src/app/core/rules.ts', '// eslint-disable-next-line\nexport const rule = 3;\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'change');
  const base = git(root, 'rev-parse', 'HEAD~1').trim();
  const out = path.join(root, 'result.json');
  const r = cp.spawnSync('node', [path.join(root, '.claude', 'forge', 'check.js'), '--base', base, '--out', out], { encoding: 'utf8' });
  assert.strictEqual(r.status, 1, r.stdout);
  assert.match(r.stdout, /\[FAIL\] suppressions/);
  assert.match(r.stdout, /\[FAIL\] tdd/);
  assert.match(r.stdout, /\[pass\] verify/);
  const result = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.strictEqual(result.schema, 2);
  assert.strictEqual(result.passed, false);
  assert.deepStrictEqual(result.findings.map((f) => f.control),
    ['suppressions', 'protected', 'security', 'tdd', 'plan', 'architecture', 'deadCode', 'changeSize', 'verify']);

  write(root, 'src/app/core/rules.ts', 'export const rule = 3;\n');
  write(root, 'src/app/core/rules.spec.ts', 'it("keeps rule 3", () => {});\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'fix');
  const ok = cp.spawnSync('node', [path.join(root, '.claude', 'forge', 'check.js'), '--base', base], { encoding: 'utf8' });
  assert.strictEqual(ok.status, 0, ok.stdout);
});

test('globs', () => {
  const { globToRegex } = require(path.join(FORGE, 'runtime', 'lib.js'));
  const m = (g, p) => globToRegex(g).test(p);
  assert.ok(m('api/**', 'api/src/A/B.cs'));
  assert.ok(m('api/**/*Tests/**', 'api/Demo.Api.Tests/T.cs'));
  assert.ok(m('api/**/*Tests/**', 'api/tests/Demo.Domain.Tests/Sub/T.cs'));
  assert.ok(m('api/**/*.Domain/**/*.cs', 'api/src/Demo.Domain/Price.cs'));
  assert.ok(m('src/**/*.spec.ts', 'src/app/a/b.spec.ts'));
  assert.ok(m('**/*.md', 'README.md'));
  assert.ok(!m('src/app/**/*.component.ts', 'src/app/core/rules.ts'));
  assert.ok(!m('api/**', 'apix/a.cs'));
});

// ---- routing and agents ----------------------------------------------------

test('every user message gets the routes; commands and subagents do not', () => {
  const root = makeProject();
  install(root);
  const routed = hook(root, 'prompt-route.js', { prompt: 'add a filter to the people list' });
  assert.strictEqual(routed.code, 0);
  assert.match(routed.out, /Start your reply with one line, "Route: <name>/);
  assert.match(routed.out, /forge-backend-dev, forge-frontend-dev/);
  assert.match(routed.out, /forge-debugger/);
  assert.strictEqual(hook(root, 'prompt-route.js', { prompt: '/forge-setup' }).out, '');
  assert.strictEqual(hook(root, 'prompt-route.js', { prompt: 'build the slice', agent_id: 'a1', agent_type: 'forge-backend-dev' }).out, '');
});

test('setup installs the agents, wires their hooks and protects their files', () => {
  const root = makeProject();
  install(root);
  const lib = require(path.join(root, '.claude', 'forge', 'lib.js'));
  for (const name of Object.keys(lib.AGENTS)) {
    const text = fs.readFileSync(path.join(root, '.claude', 'agents', name + '.md'), 'utf8');
    assert.match(text, new RegExp(`^---\nname: ${name}\n`));
    for (const skill of lib.AGENTS[name].skills) assert.match(text, new RegExp(`^  - ${skill}$`, 'm'), `${name} preloads ${skill}`);
  }
  const hooks = settingsOf(root).hooks;
  assert.match(JSON.stringify(hooks.UserPromptSubmit), /prompt-route\.js/);
  assert.match(JSON.stringify(hooks.SubagentStop), /stop-verify\.js/);
  assert.strictEqual(edit(root, '.claude/agents/forge-debugger.md').code, 2);
  assert.match(setup(root, '--check').out, /fully installed/);
  fs.appendFileSync(path.join(root, '.claude', 'agents', 'forge-debugger.md'), 'be lenient\n');
  assert.match(setup(root, '--check').out, /missing or modified agent forge-debugger/);
});

test('an agent has its own skills: preloaded ones count, the main conversation\'s do not', () => {
  const root = makeProject();
  install(root);
  loadZone(root, 'frontend'); // the main conversation loaded everything
  const agent = { agent_id: 'a1', agent_type: 'forge-frontend-dev' };
  const blocked = edit(root, 'src/app/people/people.component.ts', undefined, agent);
  assert.strictEqual(blocked.code, 2);
  assert.match(blocked.err, /Load "test-driven-development" before/, 'only the skill its definition does not preload');
  hook(root, 'skill-log.js', Object.assign({ tool_name: 'Skill', tool_input: { skill: 'superpowers:test-driven-development' } }, agent));
  assert.strictEqual(edit(root, 'src/app/people/people.component.ts', undefined, agent).code, 0);
  const outside = edit(root, 'api/src/Demo.Domain/Demo.Domain.csproj', undefined, agent);
  assert.match(outside.err, /builds the frontend zone only/);
});

test('a forge agent cannot finish while its zone fails; other subagents are left alone', () => {
  const root = makeProject();
  install(root, '--set', `zones.frontend.verify=${JSON.stringify([FAIL])}`);
  write(root, 'src/app/people/people.component.ts', 'export class PeopleComponent {\n  readonly title = "People";\n}\n');
  const stop = (agent_type) => hook(root, 'stop-verify.js', { hook_event_name: 'SubagentStop', agent_id: 'a1', agent_type });
  assert.strictEqual(stop('Explore').code, 0);
  assert.strictEqual(stop('forge-backend-dev').code, 0, 'the backend agent is not held to frontend work');
  const held = stop('forge-frontend-dev');
  assert.strictEqual(held.code, 2);
  assert.match(held.err, /this slice is not finished/);
  assert.match(held.err, /boom: 3 tests failed/);
  assert.doesNotMatch(held.err, /verification-before-completion|HIGH-RISK/, 'what is said to the user is not the agent\'s job');
});

test('each step has its skills: the agent doing it cannot skip them', () => {
  const root = makeProject();
  install(root);
  const as = (agent_type, agent_id) => ({ agent_id, agent_type });
  const load = (who, skill) => hook(root, 'skill-log.js', Object.assign({ tool_name: 'Skill', tool_input: { skill } }, who));
  const file = 'api/src/Demo.Domain/Price.cs';

  // Fixing: the debugger loads the debugging method before it edits.
  const dbg = as('forge-debugger', 'd1');
  for (const s of ['forge-backend', 'superpowers:test-driven-development']) load(dbg, s);
  assert.match(edit(root, file, undefined, dbg).err, /Load "systematic-debugging" before/);
  load(dbg, 'superpowers:systematic-debugging');
  assert.doesNotMatch(edit(root, file, undefined, dbg).err, /systematic-debugging/);

  // Restructuring: the refactorer loads the refactoring skill before it touches C#, not for TypeScript.
  const ref = as('forge-refactorer', 'r1');
  for (const s of ['forge-backend', 'superpowers:test-driven-development']) load(ref, s);
  assert.match(edit(root, file, undefined, ref).err, /Load "csharp-refactoring" before/);
  load(ref, 'dotnet:csharp-refactoring');
  assert.doesNotMatch(edit(root, file, undefined, ref).err, /csharp-refactoring/);
  assert.doesNotMatch(edit(root, 'src/app/core/rules.ts', undefined, ref).err, /csharp-refactoring/);

  // Reviewing tests: the reviewer never edits, and does not report before loading the test-quality skills.
  const rev = as('forge-test-reviewer', 't1');
  assert.match(edit(root, file, undefined, rev).err, /reviews; it does not edit/);
  const stopAs = (who) => hook(root, 'stop-verify.js', Object.assign({ hook_event_name: 'SubagentStop' }, who));
  const held = stopAs(rev);
  assert.strictEqual(held.code, 2);
  assert.match(held.err, /Load "assertion-quality", "test-anti-patterns"/);
  load(rev, 'dotnet-test:assertion-quality');
  load(rev, 'dotnet-test:test-anti-patterns');
  assert.strictEqual(stopAs(rev).code, 0);
});

test('changed tests are reviewed by the test reviewer before the turn ends', () => {
  const root = makeProject();
  install(root);
  write(root, 'src/app/people/people.service.ts', 'export class PeopleService { n = 1; }\n');
  write(root, 'src/app/people/people.service.spec.ts', 'it("counts", () => { expect(1).toBe(1); });\n');
  loadSkill(root, 'forge-review');
  const s = hook(root, 'stop-verify.js', {});
  assert.strictEqual(s.code, 2, s.err);
  assert.match(s.err, /tests of this change were not reviewed.*forge-test-reviewer/s);
  const rev = { agent_id: 't1', agent_type: 'forge-test-reviewer' };
  for (const skill of ['dotnet-test:assertion-quality', 'dotnet-test:test-anti-patterns']) {
    hook(root, 'skill-log.js', Object.assign({ tool_name: 'Skill', tool_input: { skill } }, rev));
  }
  assert.strictEqual(hook(root, 'stop-verify.js', Object.assign({ hook_event_name: 'SubagentStop' }, rev)).code, 0);
  assert.strictEqual(hook(root, 'stop-verify.js', {}).code, 0);
});
