'use strict';
// Delivery 3: exceptions, security, leftovers, the approved plan, independent review, metrics.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const { FORGE, PASS, write, git, makeProject, setup, install, hook, edit, loadSkill, configOf } = require('./helpers');

const check = (root, ...args) => {
  const r = cp.spawnSync('node', [path.join(root, '.claude', 'forge', 'check.js'), ...args], { encoding: 'utf8' });
  return { code: r.status, out: r.stdout + r.stderr };
};
const stop = (root) => hook(root, 'stop-verify.js', {});
const exceptionsOf = (root) => JSON.parse(fs.readFileSync(path.join(root, '.claude', 'forge', 'exceptions.json'), 'utf8'));
const commit = (root, message) => { git(root, 'add', '-A'); git(root, 'commit', '-q', '-m', message); };

// ---- exceptions ------------------------------------------------------------

test('an exception lets one rule through on named files, and is reported, not hidden', () => {
  const root = makeProject();
  install(root);
  loadSkill(root, 'forge-frontend');
  assert.strictEqual(edit(root, 'src/app/core/rules.ts').code, 2, 'test-first applies');

  const granted = setup(root, '--except', 'tdd', '--paths', 'src/app/core/**', '--reason', 'Generated mapping table, no behaviour to test', '--days', '7');
  assert.strictEqual(granted.code, 0, granted.out);
  assert.match(granted.out, /Granted x\w+: tdd on src\/app\/core\/\*\* until \d{4}-\d{2}-\d{2}/);
  commit(root, 'exception');

  assert.strictEqual(edit(root, 'src/app/core/rules.ts').code, 0, 'the exception covers this file');
  assert.strictEqual(edit(root, 'src/app/other/logic.ts').code, 2, 'and only the named files');

  write(root, 'src/app/core/rules.ts', 'export const rule = 2;\n');
  const told = stop(root);
  assert.strictEqual(told.code, 2);
  assert.match(told.err, /Exceptions granted by the maintainer were used.*\n- tdd on src\/app\/core\/rules\.ts: exception "Generated mapping table/);
  assert.match(check(root).out, /\[exception\] tdd/);
  assert.match(hook(root, 'session-start.js', {}).out, /## Exceptions granted by the maintainer\n- active: tdd on src\/app\/core\/\*\*/);
});

test('an expired exception stops working, and one can be revoked', () => {
  const root = makeProject();
  install(root);
  loadSkill(root, 'forge-frontend');
  setup(root, '--except', 'tdd', '--paths', 'src/app/core/**', '--reason', 'Temporary while the import is rebuilt');
  const [granted] = exceptionsOf(root);
  assert.strictEqual(edit(root, 'src/app/core/rules.ts').code, 0);

  write(root, '.claude/forge/exceptions.json', JSON.stringify([Object.assign({}, granted, { expires: '2020-01-01' })]));
  assert.strictEqual(edit(root, 'src/app/core/rules.ts').code, 2, 'expired: the rule is back');
  assert.match(hook(root, 'session-start.js', {}).out, /EXPIRED: tdd/);
  assert.match(setup(root, '--exceptions').out, /EXPIRED/);

  assert.match(setup(root, '--revoke', granted.id).out, /Revoked/);
  assert.deepStrictEqual(exceptionsOf(root), []);
});

test('exceptions need a reason, named files and a short life; a session cannot grant one', () => {
  const root = makeProject();
  install(root);
  assert.strictEqual(setup(root, '--except', 'tdd', '--paths', 'src/**').code, 1, 'no reason');
  assert.strictEqual(setup(root, '--except', 'tdd', '--reason', 'Because it is a generated file').code, 1, 'no paths');
  assert.strictEqual(setup(root, '--except', 'protected', '--paths', '.claude/**', '--reason', 'Let the session edit the forge').code, 1, 'protected is never excepted');
  assert.strictEqual(setup(root, '--except', 'tdd', '--paths', 'src/**', '--reason', 'Because it is a generated file', '--days', '400').code, 1, 'too long');
  const bash = (command) => hook(root, 'pre-bash.js', { tool_name: 'Bash', tool_input: { command } }).code;
  assert.strictEqual(bash('node "C:/repos/inv-forge/setup/setup.js" . --except tdd --paths "src/**" --reason "I need to finish"'), 2);
  assert.strictEqual(bash('node "C:/repos/inv-forge/setup/setup.js" . --revoke x123'), 2);
  assert.strictEqual(bash('node "C:/repos/inv-forge/setup/setup.js" . --exceptions'), 0, 'listing is fine');
  assert.strictEqual(edit(root, '.claude/forge/exceptions.json').code, 2, 'and the file itself is protected');
});

test('an exception can target a single structure rule', () => {
  const root = makeProject();
  install(root);
  setup(root, '--except', 'architecture/component-http', '--paths', 'src/app/people/**', '--reason', 'Legacy screen scheduled for rewrite');
  commit(root, 'exception');
  const post = (text) => {
    write(root, 'src/app/people/people.component.ts', text);
    return hook(root, 'post-edit.js', { tool_name: 'Edit', tool_input: { file_path: path.join(root, 'src/app/people/people.component.ts') } });
  };
  assert.strictEqual(post('export class P { constructor(private http: HttpClient) {} }\n').code, 0, 'the excepted rule');
  const other = post('export class P { constructor(private http: HttpClient) {} a: any; }\n');
  assert.strictEqual(other.code, 2, 'every other rule still applies');
  assert.match(other.err, /\[no-any\]/);
  assert.doesNotMatch(other.err, /\[component-http\]/);
});

// ---- security --------------------------------------------------------------

test('secrets are refused in any file, real personal data in tests and fixtures', () => {
  const root = makeProject();
  install(root);
  loadSkill(root, 'forge-frontend');
  loadSkill(root, 'forge-backend');
  const writing = (rel, content) => hook(root, 'pre-edit.js', { tool_name: 'Write', tool_input: { file_path: path.join(root, rel), content } });

  const key = writing('src/app/people/people.component.ts', 'const apiKey = "sk_live_51H8xQ2LkT9bVc3Nw7PzR4Y";\n');
  assert.strictEqual(key.code, 2);
  assert.match(key.err, /\[security\].*hard-coded secret/);
  assert.strictEqual(writing('api/src/Demo.Api/appsettings.json', '{"ConnectionStrings":{"Db":"Server=x;Password=Sup3rS3cret!;"}}').code, 2);
  assert.strictEqual(writing('api/src/Demo.Api/appsettings.json', '{"ConnectionStrings":{"Db":"Server=x;Password=<set-in-user-secrets>;"}}').code, 0);
  assert.strictEqual(writing('src/app/people/people.component.ts', 'registerLicense("Ngo9BigBOggjHTQxAR8/V1NHaF5cWWdCf1FpRmJGdld5fUVHYVZUTXxaS00DNHVRdkdn");\n').code, 2);

  const spec = 'src/app/people/people.spec.ts';
  assert.strictEqual(writing(spec, 'it("finds a person", () => { find("maria.lopez@vensure.com"); });\n').code, 2);
  assert.strictEqual(writing(spec, 'it("finds a person", () => { find("maria.lopez@example.test"); });\n').code, 0);
  assert.strictEqual(writing(spec, 'it("masks", () => { mask("123-45-6789"); });\n').code, 2);
  assert.strictEqual(writing('src/app/people/people.component.ts', 'const support = "help@vensure.com";\n').code, 0, 'an address in app code is not test data');
  assert.strictEqual(writing('src/app/people/people.component.ts', '@Component({ selector: "app-people" })\nimport { A } from "@angular/core";\n').code, 0);

  // Whatever gets in another way is caught when the turn ends, and by check.js.
  write(root, 'src/app/people/keys.ts', 'export const token = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";\n');
  const s = stop(root);
  assert.strictEqual(s.code, 2);
  assert.match(s.err, /Secrets or real personal data.*\nsrc\/app\/people\/keys\.ts: GitHub token/);
  assert.match(check(root).out, /\[FAIL\] security/);
});

// ---- leftovers -------------------------------------------------------------

test('commented-out code and ownerless TODOs do not end a turn', () => {
  const root = makeProject();
  install(root);
  write(root, 'src/app/people/people.component.ts', 'export class PeopleComponent {\n  // const old = compute(a, b);\n  n = 1;\n}\n');
  const s = stop(root);
  assert.strictEqual(s.code, 2);
  assert.match(s.err, /Leftovers that become legacy.*\nsrc\/app\/people\/people\.component\.ts: commented-out code/);

  write(root, 'src/app/people/people.component.ts', 'export class PeopleComponent {\n  // TODO handle the empty list\n  n = 1;\n}\n');
  assert.match(stop(root).err, /TODO\/FIXME without an owner/);

  write(root, 'src/app/people/people.component.ts', 'export class PeopleComponent {\n  // The list is empty until the first sync finishes.\n  // TODO(sergio): page the list\n  /// <summary>Doc comment; with a semicolon.</summary>\n  n = 1;\n}\n');
  assert.strictEqual(stop(root).code, 0, 'prose, an owned TODO and doc comments are fine');
});

test('configured unused-code tools run in check.js', () => {
  const root = makeProject();
  install(root, '--set', `deadCode.commands=${JSON.stringify(['node -e "console.log(\'Unused exports: legacy.ts\');process.exit(1)"'])}`);
  const r = check(root);
  assert.match(r.out, /\[FAIL\] deadCode\n\s+FAILED.*\n\s+Unused exports: legacy\.ts/);
  assert.strictEqual(r.code, 1);
});

// ---- plan ------------------------------------------------------------------

test('past the size threshold, code needs a plan the user approved', () => {
  const root = makeProject();
  install(root, '--set', 'plan.requiredFromLines=10');
  loadSkill(root, 'forge-frontend');
  const component = 'src/app/people/people.component.ts';
  assert.strictEqual(edit(root, component).code, 0, 'small changes need no plan');

  write(root, 'src/app/people/big.component.ts', 'export const a = 1;\n'.repeat(15));
  const blocked = edit(root, component);
  assert.strictEqual(blocked.code, 2);
  assert.match(blocked.err, /\[plan\] This change already adds 16 lines of production code and there is no approved plan/);
  assert.strictEqual(edit(root, 'src/app/people/people.spec.ts').code, 0, 'tests can still be written');

  // Claude may write the plan, but not its approval.
  const plan = 'docs/forge/plans/people-list.md';
  const writing = (content) => hook(root, 'pre-edit.js', { tool_name: 'Write', tool_input: { file_path: path.join(root, plan), content } });
  assert.strictEqual(writing('# People list\n\nStatus: proposed\n').code, 0);
  const forged = writing('# People list\n\nStatus: approved\n');
  assert.strictEqual(forged.code, 2);
  assert.match(forged.err, /is written by the user, not by Claude/);

  write(root, plan, '# People list\n\nStatus: proposed\n');
  assert.strictEqual(edit(root, component).code, 2, 'a proposed plan is not an approved one');
  write(root, plan, '# People list\n\nStatus: approved\n'); // the user's own edit
  assert.strictEqual(edit(root, component).code, 0);
  assert.match(check(root).out, /\[pass\] plan/);
});

// ---- independent review ----------------------------------------------------

test('a medium-risk change cannot be presented until it has been independently reviewed', () => {
  const root = makeProject();
  install(root);
  write(root, 'src/app/people/people.component.ts', 'export class PeopleComponent { n = 2; }\n');
  assert.strictEqual(stop(root).code, 0, 'a low-risk change needs no review');

  write(root, 'src/app/people/people.service.ts', 'export class PeopleService { n = 1; }\n');
  const s = stop(root);
  assert.strictEqual(s.code, 2);
  assert.match(s.err, /is MEDIUM risk and has not been independently reviewed.*\nLoad the "forge-review" skill/);
  loadSkill(root, 'forge-review');
  assert.strictEqual(stop(root).code, 0);
  assert.ok(fs.existsSync(path.join(root, '.claude', 'skills', 'forge-review', 'SKILL.md')));
});

// ---- on-request checks and metrics ----------------------------------------

test('audit runs only when asked, and can fail on the output of a tool that exits 0', () => {
  const root = makeProject();
  const listing = 'node -e "console.log(\'Project Demo has the following vulnerable packages\')"';
  install(root, '--set', `audit.commands=${JSON.stringify([{ command: listing, failOn: 'has the following vulnerable packages' }])}`, '--set', 'controls.audit=block');
  assert.doesNotMatch(check(root).out, /audit/, 'not run by default');
  const r = check(root, '--audit', '--packet');
  assert.match(r.out, /\[FAIL\] audit/);
  assert.strictEqual(r.code, 1);
  const quiet = check(root, '--packet');
  assert.match(fs.readFileSync(path.join(root, '.claude', 'forge', '.state', 'review-packet.md'), 'utf8'), /vulnerable packages \(run with --audit\)/);
  assert.strictEqual(quiet.code, 0);
});

test('mutation testing runs only when asked and configured', () => {
  const root = makeProject();
  install(root, '--set', `mutation.commands=${JSON.stringify([PASS])}`);
  assert.doesNotMatch(check(root).out, /mutation/);
  assert.match(check(root, '--mutation').out, /\[pass\] mutation/);
});

test('metrics keep a local history of runs and show the migration backlog', () => {
  const root = makeProject();
  write(root, 'api/src/Demo.Api/Endpoints/LegacyEndpoints.cs', 'class E { void M(AppDbContext db) {} }\n');
  commit(root, 'legacy');
  install(root);
  assert.strictEqual(check(root).code, 0);
  write(root, 'src/app/people/keys.ts', 'export const token = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";\n');
  assert.strictEqual(check(root).code, 1);
  const m = check(root, '--metrics').out;
  assert.match(m, /2 run\(s\) of check\.js recorded/);
  assert.match(m, /passed 1, failed 1 \(50% pass\)/);
  assert.match(m, /controls that failed a run: security 1/);
  assert.match(m, /api-data-access\s+1 -> 1/);
  assert.match(m, /Controls not in block mode: audit=warn, mutation=warn/);
});

test('presets: a new project blocks on everything it can; an existing one starts gently', () => {
  const fresh = makeProject();
  setup(fresh, '--preset', 'new');
  const a = configOf(fresh).controls;
  for (const c of ['skills', 'plan', 'tdd', 'suppressions', 'security', 'protected', 'architecture', 'deadCode', 'verify', 'review', 'changeSize']) {
    assert.strictEqual(a[c], 'block', c);
  }
  const old = makeProject();
  setup(old, '--preset', 'existing');
  const b = configOf(old).controls;
  assert.deepStrictEqual([b.tdd, b.plan, b.review, b.deadCode, b.changeSize], ['warn', 'warn', 'warn', 'warn', 'warn']);
  assert.deepStrictEqual([b.security, b.architecture, b.suppressions, b.verify], ['block', 'block', 'block', 'block']);
});
