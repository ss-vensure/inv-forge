'use strict';
// Risk of a change, so human attention goes where a mistake is expensive.
// Tiers come from where a file lives and from what the added lines do. This ranks attention;
// it does not prove a low-risk change is correct.

const lib = require('./lib');

const TIERS = ['low', 'medium', 'high'];

const CONTENT_SIGNALS = [
  { re: /\bExecuteDelete(Async)?\s*\(|\.Remove(Range)?\s*\(|\bDELETE\s+FROM\b|\bDROP\s+(TABLE|COLUMN)\b|\bTRUNCATE\b/i, reason: 'deletes data' },
  { re: /AllowAnonymous|RequireAuthorization|\[Authorize|\bIsInRole\s*\(|canActivate|canMatch/, reason: 'changes who can access something' },
  { re: /\bdecimal\b[^;\n]*\b(amount|price|rate|commission|total|fee|salary|pay)\w*/i, reason: 'money calculation' },
];

// { tier, reasons: [..] } for one changed file.
function classifyFile(config, rel, addedText) {
  const risk = config.risk || {};
  const reasons = [];
  let tier = 'low';
  const raise = (t, reason) => {
    if (TIERS.indexOf(t) > TIERS.indexOf(tier)) tier = t;
    if (!reasons.includes(reason)) reasons.push(reason);
  };
  for (const [reason, globs] of Object.entries(risk.high || {})) if (lib.matchAny(rel, globs)) raise('high', reason);
  for (const s of CONTENT_SIGNALS) if (s.re.test(addedText || '')) raise('high', s.reason);
  if (tier !== 'high') {
    for (const [reason, globs] of Object.entries(risk.medium || {})) if (lib.matchAny(rel, globs)) raise('medium', reason);
  }
  return { tier, reasons };
}

// { tier, files: [{ path, tier, reasons, added }] }, highest risk first.
function classify(config, files, addedText, counts) {
  const out = files.map((f) => Object.assign({ path: f.path, added: (counts && counts[f.path]) || 0 },
    classifyFile(config, f.path, addedText && addedText[f.path])));
  out.sort((a, b) => TIERS.indexOf(b.tier) - TIERS.indexOf(a.tier) || b.added - a.added);
  const tier = out.reduce((t, f) => (TIERS.indexOf(f.tier) > TIERS.indexOf(t) ? f.tier : t), 'low');
  return { tier, files: out };
}

module.exports = { TIERS, classifyFile, classify };
