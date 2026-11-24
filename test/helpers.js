'use strict';
// Shared by the test files: a throwaway project shaped like a RAiCE starter with an api/,
// and the hooks driven exactly as Claude Code drives them (JSON on stdin, exit codes).

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
  // The default test session (s1) may end a turn; the test of that rule uses another session.
  loadSkill(root, 'superpowers:verification-before-completion');
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
// Loads every skill a zone's files can require.
const ZONE_SKILLS = {
  frontend: ['forge-frontend', 'angular-developer', 'superpowers:test-driven-development'],
  backend: ['forge-backend', 'superpowers:test-driven-development', 'dotnet-aspnetcore:dotnet-webapi', 'dotnet-test:code-testing'],
};
const loadZone = (root, zone) => ZONE_SKILLS[zone].forEach((s) => loadSkill(root, s));
const settingsOf = (root) => JSON.parse(fs.readFileSync(path.join(root, '.claude', 'settings.json'), 'utf8'));
const configOf = (root) => JSON.parse(fs.readFileSync(path.join(root, '.claude', 'forge', 'config.json'), 'utf8'));

module.exports = { FORGE, PASS, FAIL, write, git, makeProject, setup, install, hook, edit, loadSkill, loadZone, settingsOf, configOf };
