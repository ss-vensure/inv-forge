'use strict';
// End-to-end tests: build a throwaway project shaped like a RAiCE starter with an api/, install
// inv-forge into it, and drive the hooks exactly as Claude Code does (JSON on stdin, exit codes).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const FORGE = path.resolve(__dirname, '..');
const SETUP = path.join(FORGE, 'setup', 'setup.js');
const PASS = 'node -e "process.exit(0)"';
const FAIL = 'node -e "console.log(\'boom: 3 tests failed\');process.exit(1)"';

function write(root, rel, text) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function git(root, ...args) {
  return cp.execFileSync('git', ['-c', 'user.name=forge-test', '-c', 'user.email=forge@example.test', ...args],
    { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function makeProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-test-'));
  write(root, 'package.json', JSON.stringify({ name: 'demo', scripts: { build: 'ng build', test: 'ng test' }, dependencies: { '@angular/core': '22.1.6' } }));
  write(root, 'angular.json', '{}');
  write(root, 'raice.json', '{}');
  write(root, 'CLAUDE.md', '# CLAUDE.md\n\nStarter guidance.\n');
  write(root, '.gitignore', 'node_modules/\n');
  write(root, '.claude/settings.json', JSON.stringify({
    hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'node .raice/scripts/welcome.js' }] }] },
    permissions: { allow: ['Bash(npm install:*)'] },
  }));
  // Tests run with --offline, so the vendored Angular skill is provided up front.
  write(root, '.claude/skills/angular-developer/SKILL.md', '---\nname: angular-developer\n---\n');
  write(root, 'src/app/core/rules.ts', 'export const rule = 1;\n');
  write(root, 'src/app/people/people.component.ts', 'export class PeopleComponent {}\n');
  write(root, 'api/Demo.slnx', '<Solution />');
  write(root, 'api/src/Demo.Domain/Demo.Domain.csproj', '<Project />');
  write(root, 'api/src/Demo.Domain/Price.cs', 'public record Price(decimal Value);\n');
  write(root, 'api/tests/Demo.Domain.Tests/Demo.Domain.Tests.csproj', '<Project><PackageReference Include="xunit" /></Project>');
  git(root, 'init', '-q');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'init');
  return root;
}

function setup(root, ...args) {
  const r = cp.spawnSync('node', [SETUP, root, '--offline', ...args], { encoding: 'utf8' });
  return { code: r.status, out: r.stdout + r.stderr };
}

// Installs with trivially passing verify commands so tests never need dotnet or ng.
function install(root, ...extra) {
  const r = setup(root, '--preset', 'new',
    '--set', `zones.backend.verify=${JSON.stringify([PASS])}`,
    '--set', `zones.frontend.verify=${JSON.stringify([PASS])}`, ...extra);
  assert.strictEqual(r.code, 0, r.out);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'forge');
  return r;
}

function hook(root, name, input) {
  const r = cp.spawnSync('node', [path.join(root, '.claude', 'forge', 'hooks', name)],
    { input: JSON.stringify(Object.assign({ session_id: 's1' }, input)), encoding: 'utf8', cwd: os.tmpdir() });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

const edit = (root, rel, extra) => hook(root, 'pre-edit.js',
  { tool_name: 'Edit', tool_input: Object.assign({ file_path: path.join(root, rel), old_string: 'a', new_string: 'b' }, extra) });
const loadSkill = (root, skill) => hook(root, 'skill-log.js', { tool_name: 'Skill', tool_input: { skill } });
const settingsOf = (root) => JSON.parse(fs.readFileSync(path.join(root, '.claude', 'settings.json'), 'utf8'));
const configOf = (root) => JSON.parse(fs.readFileSync(path.join(root, '.claude', 'forge', 'config.json'), 'utf8'));

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
  for (const f of ['lib.js', 'check.js', 'checks.js', 'hooks/pre-edit.js', 'config.json', 'forge.json', 'ci-example.yml']) {
    assert.ok(fs.existsSync(path.join(root, '.claude', 'forge', f)), f);
  }
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

test('invalid settings are refused', () => {
  const root = makeProject();
  install(root);
  assert.strictEqual(setup(root, '--set', 'controls.tdd=sometimes').code, 1);
  assert.strictEqual(setup(root, '--set', 'controls.nope=off').code, 1);
});

test('skills: a zone cannot be edited until its skill is loaded', () => {
  const root = makeProject();
  install(root);
  const blocked = edit(root, 'src/app/people/people.component.ts');
  assert.strictEqual(blocked.code, 2);
  assert.match(blocked.err, /forge-frontend/);
  loadSkill(root, 'forge-frontend');
  assert.strictEqual(edit(root, 'src/app/people/people.component.ts').code, 0);
  assert.strictEqual(edit(root, 'api/src/Demo.Domain/Demo.Domain.csproj').code, 2, 'the other zone still needs its own skill');
  // Reading the SKILL.md counts as loading it.
  hook(root, 'skill-log.js', { tool_name: 'Read', tool_input: { file_path: path.join(root, '.claude', 'skills', 'forge-backend', 'SKILL.md') } });
  assert.strictEqual(edit(root, 'api/src/Demo.Domain/Demo.Domain.csproj').code, 0);
});

test('tdd: behaviour code needs a changed test first; components and docs do not', () => {
  const root = makeProject();
  install(root);
  loadSkill(root, 'forge-frontend');
  loadSkill(root, 'forge-backend');
  assert.strictEqual(edit(root, 'src/app/core/rules.ts').code, 2);
  assert.strictEqual(edit(root, 'api/src/Demo.Domain/Price.cs').code, 2);
  assert.strictEqual(edit(root, 'src/app/people/people.component.ts').code, 0);
  assert.strictEqual(edit(root, 'api/README.md').code, 0);
  write(root, 'src/app/core/rules.spec.ts', 'it("rejects a negative rule", () => {});\n');
  assert.strictEqual(edit(root, 'src/app/core/rules.ts').code, 0);
  assert.strictEqual(edit(root, 'api/src/Demo.Domain/Price.cs').code, 2, 'a frontend spec does not unlock the backend');
  write(root, 'api/tests/Demo.Domain.Tests/PriceTests.cs', 'public class PriceTests {}\n');
  assert.strictEqual(edit(root, 'api/src/Demo.Domain/Price.cs').code, 0);
});

test('suppressions: adding one is blocked, editing next to an existing one is not', () => {
  const root = makeProject();
  install(root);
  loadSkill(root, 'forge-frontend');
  const file = 'src/app/people/people.component.ts';
  for (const text of ['// eslint-disable-next-line', '// @ts-ignore', 'xit("later", () => {})', ':host ::ng-deep .e-grid { color: red }']) {
    assert.strictEqual(edit(root, file, { new_string: text }).code, 2, text);
  }
  assert.strictEqual(edit(root, file, { old_string: '// eslint-disable-next-line\nconst a = 1;', new_string: '// eslint-disable-next-line\nconst a = 2;' }).code, 0);
  loadSkill(root, 'forge-backend');
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
});

test('files outside the project are ignored', () => {
  const root = makeProject();
  install(root);
  assert.strictEqual(edit(root, path.join('..', 'elsewhere', 'x.ts')).code, 0);
});

test('warn mode never blocks an edit and is reported once when the turn ends', () => {
  const root = makeProject();
  install(root, '--set', 'controls.tdd=warn');
  loadSkill(root, 'forge-frontend');
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
  assert.strictEqual(result.schema, 1);
  assert.strictEqual(result.passed, false);
  assert.deepStrictEqual(result.findings.map((f) => f.control), ['suppressions', 'protected', 'tdd', 'changeSize', 'verify']);

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
