---
name: forge-backend
description: Rules for the .NET backend of an Innovation-owned app (anything under api/). Load before reading, designing, writing or reviewing backend code - endpoints, use cases, domain logic, EF Core queries, migrations or their tests. Editing api/ is blocked until this skill is loaded.
---

# Backend rules (inv-forge)

These rules exist so the code stays cheap to review and to change. A human cannot read everything you write, so
structure has to make wrong code hard to write and easy to spot. Where a rule and the existing code disagree,
the rule wins for anything you add or touch; say what you found instead of copying the old pattern.

Use the official .NET skills alongside this one. A hook asks for the main ones by file: `dotnet-webapi` for
endpoints, `code-testing` for tests, `optimizing-ef-core-queries` for data access. The plugins have more
(`run-tests`, `test-anti-patterns`, `assertion-quality`, `csharp-refactoring`); use them when they fit. They
cover the framework; this file covers how *we* build. Do not rely on memory for API details that those skills
or the docs can confirm.

## Layers (Clean Architecture)

Dependencies point inward only. The compiler enforces it through project references, so never add a reference
that points outward to make something compile.

| Layer | Holds | May reference |
|---|---|---|
| `*.Domain` | Entities, value objects, business rules. No I/O, no framework. | nothing |
| `*.Application` | Use cases, the ports (interfaces) they need, request/response records. | Domain |
| `*.Infrastructure` | EF Core, external services: implementations of the ports. | Application, Domain |
| `*.Api` | Endpoints, auth, wiring. | Application (and Infrastructure only to register it) |

- **Endpoints are thin.** Read the request, call one use case, map the result to a response. No business rules,
  no `DbContext`, no queries, no `SaveChanges` in an endpoint.
- **Business rules live in Domain or Application**, where they can be tested without a database or a web host.
- Some projects predate this layout (three layers, services inside `*.Api`). New code follows the table above;
  moving old code is done as its own planned slice, not mixed into a feature.

## Types

- Requests, responses and other data carriers are `record`s, immutable, one per use.
- Never return an EF entity or an anonymous object from an endpoint; return a named response record.
- Nullable reference types stay enabled. Do not reach for `!` to quiet the compiler; model the absence.

## Data access

- **No N+1.** Never run a query inside a loop. Load what a use case needs in one query (projection with
  `Select`, or `Include` with `AsSplitQuery` when collections fan out), or in a fixed number of queries.
- Read paths use `AsNoTracking` and project to the response shape; do not load whole entities to read two columns.
- Lazy loading stays off.
- Every query that returns a list is bounded (paging or an explicit limit).
- Pass the `CancellationToken` through every async call.
- Schema changes are EF migrations, generated, never hand-edited after they have shipped.

### Proving there is no N+1

A static rule flags a query inside a loop as soon as you write it. That catches the usual shape, not every
one, so any endpoint that returns a list also gets a query-count test. Projects scaffolded by inv-forge have
`tests/*.Api.Tests/Support/QueryCounter.cs` and an `ApiFactory` that counts every SQL command:

```csharp
var few = await factory.Queries.CountAsync(() => client.GetAsync(url));   // with one row
// ...add twenty more rows...
var many = await factory.Queries.CountAsync(() => client.GetAsync(url));
Assert.Equal(few, many);   // the number of queries must not grow with the data
```

In a project without that support folder, add the same interceptor to its test host
(`options.AddInterceptors(counter)`) rather than skipping the test.

## Ask the tools, do not guess

- If this session has a C# language server (the LSP tool answers for `.cs` files), use it: find references
  before you rename, move or delete anything, and before you write a helper, look for the one that already
  exists. Read its diagnostics after an edit instead of waiting for the build.
- A refactor (no behaviour change) starts by loading `dotnet:csharp-refactoring`.
- If neither is available, say so; do not present a guess about who calls what as a fact.

## What the machine checks

After every edit, when the turn ends and in CI, inv-forge checks these and names the rule it found broken:

| Rule | Refuses |
|---|---|
| `layer-references` | a project or package reference that points outward |
| `api-data-access` | `DbContext`, EF Core or `SaveChanges` in the Api layer (outside `Program.cs`) |
| `domain-purity`, `application-purity` | framework or I/O namespaces in Domain or Application |
| `query-in-loop` | an EF query or `SaveChanges` inside a loop |
| `dto-record` | a `*Request`, `*Response` or `*Dto` declared as a class or struct |
| `anonymous-response` | an endpoint returning `new { ... }` |
| `file-size` | a source file over the line limit |

Existing violations are recorded in a baseline; a file may never gain one. When a check fires, fix the code.
Do not move the offending line somewhere the rule does not look, and do not restructure only to hide it.

## Tests

Tests are what the human reviewer reads instead of the implementation, so they are the specification.

- Write the test first and watch it fail for the right reason. Editing Domain, Application or `*Service.cs`
  files is blocked until a test in the working tree has changed.
- Name tests as behaviour: `Given_<state>_When_<action>_Then_<outcome>` or an equivalent readable sentence.
  One acceptance criterion from the approved plan, at least one test.
- Domain and Application tests are pure and fast: no database, no HTTP. Fake the ports.
- Endpoint tests are integration tests. Any endpoint that returns a list gets a test that proves its query count
  does not grow with the number of rows.
- Never skip a test, never weaken an assertion to make it pass, never assert on nothing.
- No real personal data in tests or fixtures. Invent it, and use obviously fake domains such as `example.test`.

## No debt

- Zero warnings. A warning is fixed, not suppressed: no `#pragma warning disable`, `<NoWarn>` or
  `SuppressMessage`. These edits are blocked.
- No dead code. When you replace something, delete what it replaced in the same slice. No commented-out code,
  no unused parameters, no "kept just in case".
- No speculative abstraction. An interface exists because a port needs it or a second implementation exists,
  not because one might someday.
- Keep methods and files small enough to read in one sitting; split by responsibility, not by line count.

## Before you say it is done

Run the build and the tests yourself and read the output. State what you ran, what passed, and what you did
**not** verify (for example: "endpoint tests need SQL Server and were not run here"). The Stop hook runs the
zone's verify commands regardless; if it fails, the work is not finished.
