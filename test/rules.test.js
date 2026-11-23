'use strict';
// Structure rules, their baseline, risk tiers and the review packet.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const { FORGE, write, git, makeProject, setup, install, hook, configOf } = require('./helpers');

const rules = require(path.join(FORGE, 'runtime', 'rules.js'));
const riskLib = require(path.join(FORGE, 'runtime', 'risk.js'));

const CONFIG = {
  ignore: ['**/*.md'],
  zones: {
    backend: { paths: ['api/**'], tests: ['api/**/*Tests/**'] },
    frontend: { paths: ['src/**'], tests: ['src/**/*.spec.ts'] },
  },
  limits: { maxFileLines: 50 },
};
const found = (rel, text) => rules.scanFile(CONFIG, rel, text).map((v) => v.rule);

test('the Api layer has no data access, and returns named records', () => {
  const endpoint = [
    'using Microsoft.EntityFrameworkCore;',
    'app.MapGet("/", async (AppDbContext db) => Results.Ok(new { a = 1 }));',
    'await db.SaveChangesAsync(ct);',
  ].join('\n');
  const hits = found('api/src/Demo.Api/Endpoints/PeopleEndpoints.cs', endpoint);
  assert.strictEqual(hits.filter((r) => r === 'api-data-access').length, 3);
  assert.ok(hits.includes('anonymous-response'));
  assert.deepStrictEqual(found('api/src/Demo.Api/Program.cs', 'builder.Services.AddDbContext<AppDbContext>();\n'), [], 'the composition root is exempt');
  assert.deepStrictEqual(found('api/src/Demo.Infrastructure/PeopleRepository.cs', 'using Microsoft.EntityFrameworkCore;\nclass R(AppDbContext db) {}\n'), []);
  assert.deepStrictEqual(found('api/src/Demo.Api/Endpoints/Ok.cs', '// the DbContext is not used here\nvar s = "DbContext";\n'), [], 'comments and strings do not count');
});

test('layers stay pure and reference inward only', () => {
  assert.deepStrictEqual(found('api/src/Demo.Domain/Price.cs', 'using Microsoft.EntityFrameworkCore;\n'), ['domain-purity']);
  assert.deepStrictEqual(found('api/src/Demo.Application/GetPrice.cs', 'using Microsoft.AspNetCore.Http;\n'), ['application-purity']);
  const ref = (to) => `<Project><ItemGroup><ProjectReference Include="..\\Demo.${to}\\Demo.${to}.csproj" /></ItemGroup></Project>`;
  assert.deepStrictEqual(found('api/src/Demo.Domain/Demo.Domain.csproj', ref('Infrastructure')), ['layer-references']);
  assert.deepStrictEqual(found('api/src/Demo.Application/Demo.Application.csproj', ref('Infrastructure')), ['layer-references']);
  assert.deepStrictEqual(found('api/src/Demo.Application/Demo.Application.csproj', ref('Domain')), []);
  assert.deepStrictEqual(found('api/src/Demo.Api/Demo.Api.csproj', ref('Infrastructure')), []);
  assert.deepStrictEqual(found('api/src/Demo.Data/Demo.Data.csproj', ref('Domain')), [], 'a legacy Data project counts as Infrastructure');
  assert.deepStrictEqual(found('api/src/Demo.Domain/Demo.Domain.csproj', '<PackageReference Include="Microsoft.EntityFrameworkCore" Version="10.0.0" />'), ['layer-references']);
});

test('a query inside a loop is an N+1', () => {
  const bad = 'foreach (var p in programs)\n{\n    var items = await db.Items.Where(i => i.ProgramId == p.Id).ToListAsync(ct);\n}\n';
  assert.deepStrictEqual(found('api/src/Demo.Infrastructure/Repo.cs', bad), ['query-in-loop']);
  assert.deepStrictEqual(found('api/src/Demo.Infrastructure/Repo.cs', 'foreach (var id in ids) await db.Items.FindAsync(id);\n'), ['query-in-loop']);
  const good = 'var items = await db.Items.Where(i => ids.Contains(i.ProgramId)).ToListAsync(ct);\nforeach (var i in items) { total += i.Value; }\n';
  assert.deepStrictEqual(found('api/src/Demo.Infrastructure/Repo.cs', good), []);
  const nested = 'foreach (var a in xs) { foreach (var b in a.Ys) { await db.SaveChangesAsync(ct); } }\n';
  assert.deepStrictEqual(found('api/src/Demo.Infrastructure/Repo.cs', nested), ['query-in-loop'], 'reported once, not once per enclosing loop');
  assert.deepStrictEqual(found('api/tests/Demo.Api.Tests/T.cs', bad), [], 'tests are not scanned');
});

test('data carriers are records', () => {
  assert.deepStrictEqual(found('api/src/Demo.Application/X.cs', 'public class CreatePersonRequest { }\n'), ['dto-record']);
  assert.deepStrictEqual(found('api/src/Demo.Application/X.cs', 'public sealed record CreatePersonRequest(string Name);\n'), []);
});

test('frontend components do not fetch, and libraries are used as shipped', () => {
  assert.deepStrictEqual(found('src/app/people/people.component.ts', 'constructor(private http: HttpClient) {}\n'), ['component-http']);
  assert.deepStrictEqual(found('src/app/people/people.service.ts', 'constructor(private http: HttpClient) {}\n'), []);
  assert.deepStrictEqual(found('src/app/people/people.component.scss', '.e-grid .e-rowcell { padding: 0; }\n'), ['library-style-override', 'library-style-override']);
  assert.deepStrictEqual(found('src/app/people/people.component.scss', '.panel { margin: 0 !important; }\n'), ['library-style-override']);
  assert.deepStrictEqual(found('src/app/people/people.component.scss', '.people-grid { padding: 0; }\n'), []);
  assert.deepStrictEqual(found('src/app/people/people.component.ts', "styles: ['.e-grid { color: red }'],\nencapsulation: ViewEncapsulation.None,\n"), ['library-style-override', 'library-style-override']);
  assert.deepStrictEqual(found('src/app/core/x.ts', 'const a: any = 1; const b = c as any;\n'), ['no-any', 'no-any']);
  assert.deepStrictEqual(found('src/app/core/x.ts', 'const company = many;\n'), []);
  assert.deepStrictEqual(found('package.json', '{"devDependencies":{"patch-package":"8.0.0"}}'), ['library-patched']);
});

test('file size limit, and a rule can be disabled per project', () => {
  const long = 'const a = 1;\n'.repeat(60);
  assert.deepStrictEqual(found('src/app/core/big.ts', long), ['file-size']);
  assert.deepStrictEqual(found('src/app/core/big.spec.ts', long), []);
  const cfg = Object.assign({}, CONFIG, { architecture: { disabledRules: ['file-size'] } });
  assert.deepStrictEqual(rules.scanFile(cfg, 'src/app/core/big.ts', long), []);
});

test('existing violations are baselined; new ones are refused right after the edit', () => {
  const root = makeProject();
  write(root, 'api/src/Demo.Api/Endpoints/LegacyEndpoints.cs', 'class E { void M(AppDbContext db) {} }\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'legacy');
  const r = install(root);
  assert.match(r.out, /api-data-access\s+1/);
  const post = (rel) => hook(root, 'post-edit.js', { tool_name: 'Edit', tool_input: { file_path: path.join(root, rel) } });

  assert.strictEqual(post('api/src/Demo.Api/Endpoints/LegacyEndpoints.cs').code, 0, 'what was already there is tolerated');
  write(root, 'api/src/Demo.Api/Endpoints/LegacyEndpoints.cs', 'class E { void M(AppDbContext db) {} void N(AppDbContext db) {} }\n');
  const worse = post('api/src/Demo.Api/Endpoints/LegacyEndpoints.cs');
  assert.strictEqual(worse.code, 2);
  assert.match(worse.err, /\[api-data-access\].*2 found, 1 already there before \(baseline\), so 1 new/);

  write(root, 'api/src/Demo.Api/Endpoints/NewEndpoints.cs', 'class E { void M(AppDbContext db) {} }\n');
  assert.strictEqual(post('api/src/Demo.Api/Endpoints/NewEndpoints.cs').code, 2, 'a new file starts from zero');

  const stop = hook(root, 'stop-verify.js', {});
  assert.strictEqual(stop.code, 2);
  assert.match(stop.err, /Structure rules broken/);

  // After migrating, the maintainer re-records the baseline, and it shrinks.
  fs.rmSync(path.join(root, 'api/src/Demo.Api/Endpoints/NewEndpoints.cs'));
  write(root, 'api/src/Demo.Api/Endpoints/LegacyEndpoints.cs', 'class E { }\n');
  assert.strictEqual(setup(root, '--baseline').code, 0);
  const baseline = JSON.parse(fs.readFileSync(path.join(root, '.claude', 'forge', 'arch-baseline.json'), 'utf8'));
  assert.strictEqual(baseline['api-data-access'], undefined);
});

test('architecture in warn mode reports instead of blocking', () => {
  const root = makeProject();
  install(root, '--set', 'controls.architecture=warn');
  write(root, 'src/app/people/people.component.ts', 'export class PeopleComponent { constructor(private http: HttpClient) {} }\n');
  const post = hook(root, 'post-edit.js', { tool_name: 'Edit', tool_input: { file_path: path.join(root, 'src/app/people/people.component.ts') } });
  assert.strictEqual(post.code, 0);
  const stop = hook(root, 'stop-verify.js', {});
  assert.strictEqual(stop.code, 2);
  assert.match(stop.err, /component-http/);
  assert.strictEqual(hook(root, 'stop-verify.js', {}).code, 0, 'reported once');
});

test('risk tiers follow where a file lives and what the change does', () => {
  const root = makeProject();
  install(root);
  const cfg = configOf(root);
  const tier = (rel, added) => riskLib.classifyFile(cfg, rel, added).tier;
  assert.strictEqual(tier('api/src/Demo.Infrastructure/Migrations/20260101_Init.cs'), 'high');
  assert.strictEqual(tier('src/app/auth/role.guard.ts'), 'high');
  assert.strictEqual(tier('.github/workflows/ci.yml'), 'high');
  assert.strictEqual(tier('api/src/Demo.Application/People/GetPeople.cs'), 'medium');
  assert.strictEqual(tier('api/src/Demo.Application/People/DeletePerson.cs', 'db.People.Remove(person);'), 'high');
  assert.strictEqual(tier('src/app/people/people.service.ts'), 'medium');
  assert.strictEqual(tier('src/app/people/people.component.ts'), 'low');
  assert.strictEqual(tier('src/app/people/people.component.ts', 'group.MapGet("/x").AllowAnonymous();'), 'high');
});

test('review packet: risk, the tests as specification, checks, and what was not verified', () => {
  const root = makeProject();
  install(root, '--set', `zones.backend.verifyCi=${JSON.stringify(['dotnet test --filter Integration'])}`);
  git(root, 'checkout', '-q', '-b', 'feature');
  write(root, 'src/app/auth/role.guard.ts', 'export const guard = () => true;\n');
  write(root, 'src/app/auth/role.guard.spec.ts', 'it("denies a user without the Admin role", () => {});\n');
  write(root, 'api/tests/Demo.Domain.Tests/PriceTests.cs', 'public class PriceTests { [Fact] public void Given_a_negative_value_When_created_Then_it_is_rejected() {} }\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'guard');
  const base = git(root, 'rev-parse', 'HEAD~1').trim();
  const r = cp.spawnSync('node', [path.join(root, '.claude', 'forge', 'check.js'), '--base', base, '--packet'], { encoding: 'utf8' });
  assert.match(r.stdout, /\[risk\] HIGH/);
  const packet = fs.readFileSync(path.join(root, '.claude', 'forge', '.state', 'review-packet.md'), 'utf8');
  assert.match(packet, /^# Review packet: feature/);
  assert.match(packet, /## Risk: HIGH/);
  assert.match(packet, /\| HIGH \| `src\/app\/auth\/role\.guard\.ts` \| authentication or authorization/);
  assert.match(packet, /- denies a user without the Admin role/);
  assert.match(packet, /- Given a negative value When created Then it is rejected/);
  assert.match(packet, /\| verify \| block \| pass \|/);
  assert.match(packet, /dotnet test --filter Integration.*runs only with --ci/);
  assert.match(packet, /What I did NOT verify/);
});
