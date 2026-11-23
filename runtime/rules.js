'use strict';
// Structure rules: clean-architecture layering, data access, library components, size.
// Static and fast on purpose: they run after every edit. They catch the usual shapes of a
// violation, not every possible one; the query-count tests and human review cover the rest.
//
// A project's existing violations are recorded once in arch-baseline.json. From then on a file
// may never have MORE violations of a rule than its baseline, so legacy code keeps working while
// nothing new gets in, and the baseline only shrinks as code is migrated.

const fs = require('fs');
const path = require('path');
const lib = require('./lib');

const BASELINE_FILE = path.join(lib.FORGE_DIR, 'arch-baseline.json');

// ---- source text helpers ---------------------------------------------------

// Blanks out comments and string contents, keeping every character position and newline,
// so patterns do not match inside them and line numbers stay right.
function stripCode(text) {
  const out = text.split('');
  const blank = (from, to) => { for (let k = from; k < to; k++) if (out[k] !== '\n') out[k] = ' '; };
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    const next = text[i + 1];
    if (c === '/' && next === '/') {
      let j = text.indexOf('\n', i); if (j < 0) j = text.length;
      blank(i, j); i = j;
    } else if (c === '/' && next === '*') {
      let j = text.indexOf('*/', i + 2); j = j < 0 ? text.length : j + 2;
      blank(i, j); i = j;
    } else if (c === '"' || c === '\'' || c === '`') {
      let j = i + 1;
      while (j < text.length && text[j] !== c) { if (text[j] === '\\') j++; if (c !== '`' && text[j] === '\n') break; j++; }
      blank(i + 1, j); i = j + 1;
    } else {
      i++;
    }
  }
  return out.join('');
}

const lineOf = (text, index) => text.slice(0, index).split('\n').length;

function matches(text, re, message) {
  const found = [];
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
  let m;
  while ((m = g.exec(text)) !== null) {
    found.push({ line: lineOf(text, m.index), message: typeof message === 'function' ? message(m) : message });
    if (m.index === g.lastIndex) g.lastIndex++;
  }
  return found;
}

// Bodies of for / foreach / while loops, as { start, text }.
function loopBodies(code) {
  const bodies = [];
  const re = /\b(foreach|for|while)\s*\(/g;
  let m;
  while ((m = re.exec(code)) !== null) {
    let i = re.lastIndex;
    let depth = 1;
    while (i < code.length && depth > 0) { if (code[i] === '(') depth++; else if (code[i] === ')') depth--; i++; }
    while (i < code.length && /\s/.test(code[i])) i++;
    let end;
    if (code[i] === '{') {
      let d = 1; end = i + 1;
      while (end < code.length && d > 0) { if (code[end] === '{') d++; else if (code[end] === '}') d--; end++; }
    } else {
      end = code.indexOf(';', i); end = end < 0 ? code.length : end + 1;
    }
    bodies.push({ start: i, text: code.slice(i, end) });
  }
  return bodies;
}

const QUERY_CALL = /\b(ToListAsync|ToArrayAsync|ToDictionaryAsync|FirstAsync|FirstOrDefaultAsync|SingleAsync|SingleOrDefaultAsync|AnyAsync|AllAsync|CountAsync|LongCountAsync|SumAsync|MaxAsync|MinAsync|AverageAsync|FindAsync|LoadAsync|SaveChangesAsync|ExecuteUpdateAsync|ExecuteDeleteAsync)\s*\(/g;

// ---- rules -----------------------------------------------------------------
// files / except are globs on the project-relative path. `scan` receives the raw text and the
// stripped code and returns [{ line, message }].

const RULES = [
  {
    id: 'api-data-access',
    why: 'The Api layer only receives the request, calls a use case and maps the response. Queries and SaveChanges belong behind a port, implemented in Infrastructure.',
    files: ['api/**/*.Api/**/*.cs'],
    except: ['**/Program.cs', '**/DependencyInjection.cs', '**/*HostingExtensions.cs'],
    scan: (text, code) => matches(code, /\busing\s+Microsoft\.EntityFrameworkCore\b|\b\w*DbContext\b|\bSaveChanges(Async)?\s*\(/, 'data access in the Api layer'),
  },
  {
    id: 'anonymous-response',
    why: 'An endpoint returns a named response record, so the contract is visible and reviewable.',
    files: ['api/**/*.Api/**/*.cs'],
    scan: (text, code) => matches(code, /\bResults\.(Ok|Json|Created)\(\s*new\s*\{/, 'anonymous object returned from an endpoint'),
  },
  {
    id: 'domain-purity',
    why: 'Domain has no I/O and no framework: it must be testable with nothing but the language.',
    files: ['api/**/*.Domain/**/*.cs'],
    scan: (text, code) => matches(code, /\busing\s+(Microsoft\.EntityFrameworkCore|Microsoft\.AspNetCore|System\.Net\.Http|System\.Data)\b/, 'framework or I/O namespace used in Domain'),
  },
  {
    id: 'application-purity',
    why: 'Application defines ports and use cases; it does not know EF Core or ASP.NET.',
    files: ['api/**/*.Application/**/*.cs'],
    scan: (text, code) => matches(code, /\busing\s+Microsoft\.(EntityFrameworkCore|AspNetCore)\b/, 'EF Core or ASP.NET namespace used in Application'),
  },
  {
    id: 'query-in-loop',
    why: 'A query inside a loop is an N+1: the number of round trips grows with the data. Load what is needed in one query.',
    files: ['api/**/*.cs'],
    scan: (text, code) => {
      const found = [];
      for (const body of loopBodies(code)) {
        for (const hit of matches(body.text, QUERY_CALL, (m) => `${m[1]} inside a loop`)) {
          found.push({ line: lineOf(code, body.start) + hit.line - 1, message: hit.message });
        }
      }
      // Nested loops report the same call once per enclosing loop; keep one per line.
      return found.filter((f, i) => found.findIndex((x) => x.line === f.line) === i);
    },
  },
  {
    id: 'dto-record',
    why: 'Requests, responses and DTOs are immutable records.',
    files: ['api/**/*.cs'],
    scan: (text, code) => matches(code, /\b(class|struct)\s+\w+(Request|Response|Dto)\b/, 'data carrier declared as class or struct'),
  },
  {
    id: 'component-http',
    why: 'Components present; services fetch. A component never talks HTTP directly.',
    files: ['src/**/*.component.ts'],
    scan: (text, code) => matches(code, /\bHttpClient\b/, 'HttpClient used in a component'),
  },
  {
    id: 'library-style-override',
    why: 'Prismatic and Syncfusion are used as shipped. Styling their internals or forcing rules over them is modifying them.',
    files: ['src/**/*.scss', 'src/**/*.css', 'src/**/*.ts', 'src/**/*.html'],
    scan: (text, code, ctx) => {
      const prefixes = (ctx.config.frontend && ctx.config.frontend.libraryClassPrefixes) || ['e-'];
      const cls = new RegExp('(^|[\\s,>+~(\'"`])\\.(' + prefixes.map((p) => p.replace(/[^\w-]/g, '')).join('|') + ')[a-z][\\w-]*', 'm');
      // Selectors live in strings inside .ts files, so those are checked on the raw text.
      const source = ctx.rel.endsWith('.ts') ? text : code;
      return [
        ...matches(source, cls, 'selector targets a library\'s internal class'),
        ...matches(source, /!important/, '!important'),
        ...matches(code, /\bViewEncapsulation\.None\b/, 'ViewEncapsulation.None'),
      ];
    },
  },
  {
    id: 'no-any',
    why: 'any switches the type checker off. Model the type.',
    files: ['src/**/*.ts'],
    scan: (text, code) => matches(code, /:\s*any\b|\bas\s+any\b|<any>/, 'any'),
  },
  {
    id: 'file-size',
    why: 'A file too long to read in one sitting hides its problems. Split it by responsibility.',
    files: ['api/**/*.cs', 'src/**/*.ts'],
    scan: (text, code, ctx) => {
      const max = (ctx.config.limits && ctx.config.limits.maxFileLines) || 400;
      const lines = text.split('\n').length;
      return lines > max ? [{ line: max + 1, message: `${lines} lines; the limit is ${max}` }] : [];
    },
  },
];

// ---- project-level rules ---------------------------------------------------

const LAYERS = { Domain: 'Domain', Application: 'Application', Infrastructure: 'Infrastructure', Data: 'Infrastructure', Api: 'Api' };
const MAY_REFERENCE = { Domain: [], Application: ['Domain'], Infrastructure: ['Application', 'Domain'], Api: ['Application', 'Infrastructure', 'Domain'] };
const FORBIDDEN_PACKAGES = {
  Domain: /EntityFrameworkCore|AspNetCore|^Azure\.|^System\.Data|Dapper/i,
  Application: /EntityFrameworkCore|AspNetCore|Dapper/i,
};
const layerOf = (csproj) => { const m = /\.(\w+)\.csproj$/.exec(csproj); return m ? LAYERS[m[1]] || null : null; };

function scanProjectFile(rel, text) {
  const found = [];
  if (rel.endsWith('.csproj') && !/Tests?\.csproj$/.test(rel)) {
    const layer = layerOf(rel);
    if (layer) {
      for (const m of text.matchAll(/<ProjectReference\s+Include="([^"]+)"/g)) {
        const target = layerOf(m[1].replace(/\\/g, '/'));
        if (target && !MAY_REFERENCE[layer].includes(target)) {
          found.push({ rule: 'layer-references', line: lineOf(text, m.index), message: `${layer} references ${target}: dependencies point inward only` });
        }
      }
      for (const m of text.matchAll(/<PackageReference\s+Include="([^"]+)"/g)) {
        if (FORBIDDEN_PACKAGES[layer] && FORBIDDEN_PACKAGES[layer].test(m[1])) {
          found.push({ rule: 'layer-references', line: lineOf(text, m.index), message: `${layer} references package ${m[1]}` });
        }
      }
    }
  }
  if (rel === 'package.json' && /"patch-package"/.test(text)) {
    found.push({ rule: 'library-patched', line: lineOf(text, text.indexOf('"patch-package"')), message: 'patch-package is installed: library packages are never patched' });
  }
  return found;
}

const WHY = Object.assign({
  'layer-references': 'Dependencies point inward only: Domain <- Application <- Infrastructure, and Api on top.',
  'library-patched': 'Prismatic and Syncfusion are consumed as shipped, never patched.',
}, Object.fromEntries(RULES.map((r) => [r.id, r.why])));

// ---- scanning --------------------------------------------------------------

function isTestFile(config, rel) {
  const zone = lib.zoneOf(config, rel);
  return !!zone && lib.isTest(zone, rel);
}

// Violations in one file: [{ rule, line, message }].
function scanFile(config, rel, text) {
  if (lib.matchAny(rel, config.ignore)) return [];
  const disabled = (config.architecture && config.architecture.disabledRules) || [];
  const found = scanProjectFile(rel, text).filter((v) => !disabled.includes(v.rule));
  if (isTestFile(config, rel)) return found;
  let code = null;
  for (const rule of RULES) {
    if (disabled.includes(rule.id) || !lib.matchAny(rel, rule.files) || lib.matchAny(rel, rule.except)) continue;
    if (code === null) code = /\.(cs|ts)$/.test(rel) ? stripCode(text) : text;
    for (const v of rule.scan(text, code, { config, rel })) found.push(Object.assign({ rule: rule.id }, v));
  }
  return found;
}

function scanPath(config, rel) {
  let text;
  try { text = fs.readFileSync(path.join(lib.ROOT, rel), 'utf8'); } catch (_) { return []; }
  return scanFile(config, rel, text);
}

// Every file the rules could apply to: tracked plus untracked-but-not-ignored.
function allFiles() {
  const out = lib.git(['ls-files', '-co', '--exclude-standard', '-z']) || '';
  return out.split('\0').filter(Boolean).map(lib.toPosix)
    .filter((f) => /\.(cs|csproj|ts|scss|css|html)$/.test(f) || f === 'package.json');
}

function countByRule(violations) {
  const counts = {};
  for (const v of violations) counts[v.rule] = (counts[v.rule] || 0) + 1;
  return counts;
}

function loadBaseline() {
  return lib.readJson(BASELINE_FILE, {});
}

// { rule: { file: count } } for the whole project as it is now.
function buildBaseline(config) {
  const baseline = {};
  for (const rel of allFiles()) {
    for (const [rule, n] of Object.entries(countByRule(scanPath(config, rel)))) {
      (baseline[rule] = baseline[rule] || {})[rel] = n;
    }
  }
  return baseline;
}

// Violations beyond the baseline, grouped: [{ file, rule, allowed, found, why, hits }].
function newViolations(config, files, baseline) {
  const base = baseline || loadBaseline();
  const result = [];
  for (const rel of files) {
    const violations = scanPath(config, rel);
    for (const [rule, found] of Object.entries(countByRule(violations))) {
      const allowed = (base[rule] && base[rule][rel]) || 0;
      if (found > allowed) {
        result.push({ file: rel, rule, allowed, found, why: WHY[rule], hits: violations.filter((v) => v.rule === rule) });
      }
    }
  }
  return result;
}

function describe(groups) {
  return groups.map((g) => {
    const head = `[${g.rule}] ${g.file}: ${g.found} found` + (g.allowed ? `, ${g.allowed} already there before (baseline), so ${g.found - g.allowed} new` : '');
    const hits = g.hits.slice(0, 8).map((h) => `    line ${h.line}: ${h.message}`).join('\n');
    return `${head}\n${hits}\n    Why: ${g.why}`;
  }).join('\n\n');
}

module.exports = { RULES, BASELINE_FILE, stripCode, loopBodies, scanFile, scanPath, allFiles, loadBaseline, buildBaseline, newViolations, describe };
