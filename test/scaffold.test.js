'use strict';
// The backend scaffold: what it generates and when it refuses. Building the generated solution
// needs the .NET SDK and the network, so that is checked by hand (see README), not here.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { write, git, makeProject, setup, hook, configOf } = require('./helpers');

function frontendOnlyProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-scaffold-'));
  write(root, 'package.json', JSON.stringify({ name: 'demo', scripts: { build: 'ng build', test: 'ng test' }, dependencies: { '@angular/core': '22.1.6' } }));
  write(root, 'angular.json', JSON.stringify({ projects: { demo: { architect: { serve: { builder: 'dev-server' } } } } }));
  write(root, 'raice.json', JSON.stringify({ project: { name: 'billing-tool' } }));
  write(root, '.claude/skills/angular-developer/SKILL.md', '---\nname: angular-developer\n---\n');
  write(root, 'src/app/app.component.ts', 'export class AppComponent {}\n');
  git(root, 'init', '-q');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'init');
  return root;
}

const read = (root, rel) => fs.readFileSync(path.join(root, rel), 'utf8');

test('scaffold creates four layers named after the project and served under its route slug', () => {
  const root = frontendOnlyProject();
  const r = setup(root, '--scaffold-backend', 'Acme.Billing');
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, /Scaffold: created 19 files under api\/ for Acme\.Billing, served at \/billing-tool\/api/);
  for (const layer of ['Domain', 'Application', 'Infrastructure', 'Api']) {
    assert.ok(fs.existsSync(path.join(root, `api/src/Acme.Billing.${layer}/Acme.Billing.${layer}.csproj`)), layer);
  }
  assert.match(read(root, 'api/src/Acme.Billing.Api/Program.cs'), /MapGroup\("\/billing-tool\/api"\)/);
  assert.match(read(root, 'api/src/Acme.Billing.Application/Status/GetStatus.cs'), /^namespace Acme\.Billing\.Application\.Status;/);
  assert.match(read(root, 'api/Directory.Build.props'), /<TreatWarningsAsErrors>true<\/TreatWarningsAsErrors>/);
  const all = [];
  (function walk(dir) { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const f = path.join(dir, e.name); if (e.isDirectory()) walk(f); else all.push(f); } })(path.join(root, 'api'));
  for (const f of all) {
    assert.ok(!/__NAME__|__SLUG__/.test(f + fs.readFileSync(f, 'utf8')), `placeholder left in ${f}`);
  }

  const c = configOf(root);
  assert.deepStrictEqual(c.zones.backend.verify, ['dotnet build "api/Acme.Billing.slnx" --nologo -v q -warnaserror', 'npm run test:api']);

  // The dev loop is wired: npm scripts, and the Angular dev server forwards the API route.
  assert.match(r.out, /dev loop wired: npm run api, npm run test:api, proxy\.conf\.json, angular\.json proxyConfig/);
  const pkg = JSON.parse(read(root, 'package.json'));
  assert.strictEqual(pkg.scripts.api, 'dotnet watch --project api/src/Acme.Billing.Api --no-hot-reload');
  assert.strictEqual(pkg.scripts['test:api'], 'dotnet test api/Acme.Billing.slnx --nologo');
  assert.strictEqual(pkg.scripts.build, 'ng build', 'existing scripts are kept');
  assert.strictEqual(JSON.parse(read(root, 'proxy.conf.json'))['/billing-tool/api'].target, 'http://localhost:5080');
  assert.strictEqual(JSON.parse(read(root, 'angular.json')).projects.demo.architect.serve.options.proxyConfig, 'proxy.conf.json');
  const baseline = JSON.parse(read(root, '.claude/forge/arch-baseline.json'));
  assert.deepStrictEqual(baseline, {}, 'the scaffold breaks none of its own rules');
});

test('scaffold with --efcore adds the DbContext and the query counter', () => {
  const root = frontendOnlyProject();
  const r = setup(root, '--scaffold-backend', 'Billing', '--efcore');
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, /created 23 files.*with EF Core and the query counter/);
  assert.match(read(root, 'api/src/Billing.Infrastructure/Persistence/AppDbContext.cs'), /class AppDbContext/);
  assert.match(read(root, 'api/tests/Billing.Api.Tests/Support/QueryCounter.cs'), /class QueryCounter : DbCommandInterceptor/);
  assert.match(read(root, 'api/src/Billing.Infrastructure/Billing.Infrastructure.csproj'), /EntityFrameworkCore\.SqlServer/);
  assert.deepStrictEqual(JSON.parse(read(root, '.claude/forge/arch-baseline.json')), {});
});

test('scaffold on a project installed before it had a backend fills in the verify commands', () => {
  const root = frontendOnlyProject();
  assert.strictEqual(setup(root, '--preset', 'new').code, 0);
  assert.deepStrictEqual(configOf(root).zones.backend.verify, []);
  assert.strictEqual(setup(root, '--scaffold-backend', 'Billing').code, 0);
  assert.strictEqual(configOf(root).zones.backend.verify.length, 2);
});

test('scaffold refuses an existing backend and a bad name', () => {
  const existing = makeProject();
  const r = setup(existing, '--scaffold-backend', 'Demo');
  assert.strictEqual(r.code, 1);
  assert.match(r.out, /already contains \.NET projects/);
  assert.strictEqual(setup(frontendOnlyProject(), '--scaffold-backend', 'billing tool').code, 1);
});

test('a session cannot re-record the baseline to forgive its own violations', () => {
  const root = makeProject();
  setup(root, '--preset', 'new');
  const bash = (command) => hook(root, 'pre-bash.js', { tool_name: 'Bash', tool_input: { command } }).code;
  assert.strictEqual(bash('node "C:/repos/inv-forge/setup/setup.js" . --baseline'), 2);
  assert.strictEqual(bash('node "C:/repos/inv-forge/setup/setup.js" . --check'), 0);
});
