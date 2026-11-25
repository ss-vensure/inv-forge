---
name: forge-frontend
description: Rules for the Angular frontend of an Innovation-owned app (anything under src/). Load before reading, designing, writing or reviewing frontend code - components, templates, styles, services, stores, routes or their specs - and before choosing any UI component. Editing src/ is blocked until this skill is loaded.
---

# Frontend rules (inv-forge)

Use the official `angular-developer` skill alongside this one for the framework itself (signals, standalone
components, control flow, forms, routing, testing). This file covers how *we* build. Where the two disagree
about UI components or styling, this file wins.

## Components: the order of choice

1. **Prismatic first.** If `@prismhr/components-ng-shared` has the element, use it as shipped, configured only
   through the inputs, outputs and variants it documents. Check the Prismatic Storybook for what exists and how
   it is configured; do not guess from memory.
2. **Syncfusion directly when Prismatic does not cover the need**, for example data grids and charts. Import
   only the modules you use. The starter's `CLAUDE.md` says never to import `@syncfusion/*` directly; that rule
   is written for RAiCEr tools, which have no licence. The Innovation team holds one, so in a forge project
   this file wins and the import is allowed. Do not fall back to hand-written HTML or an open-source control
   because of the starter's rule.
3. **Compose.** A screen component of ours that arranges Prismatic and Syncfusion elements without altering
   them is the normal way to build a page.
4. **A component built from scratch is the last resort.** Say why 1 to 3 do not work before writing it.

## Never modify Prismatic or Syncfusion

Never. This is the most important rule in this file.

- Do not edit or patch the packages (`node_modules`, `patch-package`).
- Do not restyle them from outside: no `::ng-deep`, no `!important` against their elements, no selectors that
  target their internal classes (for example `.e-*`), no `ViewEncapsulation.None` to reach into them.
- Do not copy a library component into the project to change it, and do not rebuild one that already exists.
- If an element cannot do what is needed, look for another variant or combination, then move down the order
  of choice above. If nothing fits, stop and tell the user; the answer is never to alter the library.

The Syncfusion licence key never goes in the repository.

## Structure

- Components present; they do not fetch. HTTP calls live in services, state in stores or signals-based services.
  A component never injects `HttpClient`.
- Keep logic out of templates and out of components where it can live in a plain function, service or store,
  so it can be tested without rendering anything.
- Standalone components, lazy-loaded routes, strict TypeScript, strict templates. No `any`; model the type.
- Release every subscription (`takeUntilDestroyed`, the `async` pipe, or signals).
- Keep the accessibility the libraries give you: labels, roles, keyboard paths. Composing must not break them.

## Ask the tools, do not guess

- If the `angular-cli` MCP server is connected, call its `get_best_practices` tool before your first Angular
  edit in a conversation, and its documentation search instead of answering an Angular API question from
  memory. It answers for the Angular version this project uses.
- If this session has a TypeScript language server (the LSP tool answers for `.ts` files), use it: find
  references before you rename, move or delete anything, and before you write a component, pipe or helper,
  look for the one that already exists. Reuse is found, not remembered.
- If neither is available, say so; do not present a guess as a fact.

## What the machine checks

After every edit, when the turn ends and in CI, inv-forge checks these and names the rule it found broken:

| Rule | Refuses |
|---|---|
| `component-http` | `HttpClient` in a component |
| `library-style-override` | selectors on a library's internal classes, `!important`, `ViewEncapsulation.None` |
| `library-patched` | `patch-package` in the project |
| `no-any` | `any` in TypeScript |
| `file-size` | a source file over the line limit |

Existing violations are recorded in a baseline; a file may never gain one. Choosing a from-scratch component
where a library one exists is not something a machine can see: that one is on you and on the reviewer.

## Tests

Tests are what the human reviewer reads instead of the implementation, so they are the specification.

- Write the spec first and watch it fail. Editing services, stores, guards, pipes and other logic files is
  blocked until a spec in the working tree has changed. Components, routes and config are exempt from the
  block, not from testing.
- Describe behaviour a user or caller can observe: `it('shows the empty state when the program has no projects')`.
  One acceptance criterion from the approved plan, at least one spec.
- Test logic in services and stores directly. Test components through what they render and emit, using
  component harnesses where the libraries provide them; do not assert on private fields or library internals.
- Never use `xit`, `xdescribe`, `fit` or `fdescribe`, and never leave a spec without an expectation.
- No real personal data in specs or fixtures.

## No debt

- Zero lint and build warnings. No `eslint-disable`, `@ts-ignore` or `@ts-nocheck`. These edits are blocked.
- No dead code: delete what you replace, in the same slice. No commented-out code, no unused exports or files.
- Respect the bundle budgets in `angular.json`; if a change breaks one, find out what grew.

## Before you say it is done

Run the build and the specs yourself and read the output. For a visual change, look at the screen in the
browser. State what you ran, what passed, and what you did **not** verify. The Stop hook runs the zone's verify
commands regardless; if it fails, the work is not finished.
