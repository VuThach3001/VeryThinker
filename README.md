# VeryThinker

VeryThinker provides a manager-led engineering workflow from one requirement. Alpha.3 strict execution uses native **Codex**; adapters are also generated for **Claude Code and GitHub Copilot**, with exact-model execution restricted until verified. The manager discusses with specialists, reports decisions, delivers implementation and documentation, verifies evidence, obtains independent review, finishes tasks, and prepares reviewed shared knowledge.

**Status: `0.1.0-alpha.3.2`, local prerelease.** Alpha.3 adds exact native Codex routing receipts, batch requirements, private project archives, Cornell knowledge, and reviewed parameterized recipes. Alpha.3.2 routes strong roles through Luna at max reasoning effort while workers retain Luna medium and evidence-gated Terra medium. Actual strong/worker model inference access is recorded separately from engineering-increment acceptance and full client conformance. See [compatibility](docs/compatibility.md), [validation](docs/validation.md), and [release criteria](docs/release.md).

All instructions, skills, documentation, CLI output, and generated records are in English.

## Install locally

Use **Node.js 24 LTS**. Build a tarball from this checkout:

```sh
npm ci
npm test
npm pack --pack-destination artifacts
npm run package:smoke
```

In a target project, install that tarball. The following PowerShell example uses this checkout's default path; replace it when needed:

```powershell
npm install --save-dev D:/workspace/VeryThinker/artifacts/verythinker-0.1.0-alpha.3.1.tgz
npx verythinker init --name "My project" --profile software --platforms codex,claude,copilot
```

Choose the platform or platforms you use, then use one native platform per session. Enable its native MCP/hook trust settings as required by that client. Installation preserves existing instructions and configuration. To upgrade an initialized project, install the new tarball and run the update once:

```sh
npx verythinker update
```

Keep the installed package available: generated adapters point to its local executable. After moving the project or package, run `update` and inspect changed paths.

## Give one requirement

Start a fresh native agent session in the initialized project and describe the outcome:

```text
Add persistent configuration for intervalMs (100–60000) and retries (0–5).
Reject invalid values without changing stored configuration.
Preserve configuration across application restarts.
```

The managed instructions automatically select the manager skill. The manager owns requirements, internal specialist discussion, final engineering decisions, bounded assignments, documentation, checks, review, task acceptance, and qualified knowledge contributions. It asks for missing product intent or an actual external blocker; routine decisions and record-management commands remain internal.

Give one requirement or several related requirements in the same request. The managed coordinator and strong roles use **`gpt-6-luna`** with max reasoning effort for requirements, design, verification strategy, and independent review. Bounded implementation, research, and routine checks use **`gpt-6-luna`** with medium reasoning; **`gpt-5.6-terra`** with medium reasoning is permitted only after native execution confirms Luna is unavailable. A signed receipt from the pinned Codex App Server binds each invocation to its actual selected model and native thread/turn. Unconfirmed routing blocks affected work.

Default project policy enables accepted increment snapshots in a private project namespace, and independently reviewed generalized knowledge draft PRs to the shared library. Project records, implementation, and verification inputs retain their original paths and hashes in the private snapshot. Shared knowledge merging remains a human decision. Read [the manager-first workflow](docs/autonomous-manager.md) for policy, resumption, and native execution limits.

The manager applies an iterative V-model:

```text
Requirement <-> Design <-> Implementation <-> Check <-> Evidence <-> Review
```

| Gate           | What it evaluates                                                             |
| -------------- | ----------------------------------------------------------------------------- |
| `ready`        | Measurable requirements, scope, dependencies, and checks                      |
| `design-ready` | Applicable design allocations, interfaces, and review                         |
| `verified`     | Passing evidence on the relevant source/configuration baseline                |
| `accepted`     | Submission, current independent review, traceability, and applicable evidence |

Workers submit substantive work records and affected project documentation; the core evaluates completion. Review uses a separate invocation from implementation and assesses the current implementation/documentation baseline. Hooks assist the process; the manager still validates completion through core operations when hooks fail or are disabled.

To resume in another session, use ordinary language:

```text
Continue the configuration requirement from its saved VeryThinker workflow.
```

The manager inspects saved state and actual baselines, resumes valid evidence, and handles repair or stronger internal escalation. Native session restrictions remain visible blockers; saved state does not imply a background process.

| Profile    | Use                                                                                             |
| ---------- | ----------------------------------------------------------------------------------------------- |
| `basic`    | Requirements, tasks, checks, evidence, review, and lessons                                      |
| `software` | Add architecture/interfaces and verification levels                                             |
| `embedded` | Add hardware/software allocation, hardware-software interfaces, and reproducible configurations |

The process mapping references **Automotive SPICE 4.1** and an iterative V-model. It provides engineering guidance; it does not establish an ASPICE capability rating. Read the [process guide](docs/process.md) for profile coverage and evidence limits.

## Core tools and roles

The CLI and local stdio MCP server share the same core. Commands return structured JSON; `--project` selects another project root.

| Command group                        | Purpose                                                                    |
| ------------------------------------ | -------------------------------------------------------------------------- |
| `init`, `doctor`, `update`           | Install, inspect capabilities, and update managed resources                |
| `record`, `task`, `context`          | Maintain engineering records and bounded assignments                       |
| `workflow`                           | Record manager intake, internal discussion, decisions, status, and closure |
| `check`, `review`, `trace`, `verify` | Execute checks, review, inspect impact, and evaluate gates                 |
| `memory`, `pack`, `index`            | Retrieve history, manage knowledge, and rebuild the index                  |
| `native`, `capability`               | Dispatch native roles, observe model receipts, and resolve approved tools  |
| `archive`                            | Prepare, publish, inspect, and restore private project increments          |
| `note`, `recipe`                     | Cornell knowledge and reviewed parameterized engineering procedures        |
| `mcp`                                | Start the local MCP server                                                 |

The manager uses MCP or the CLI internally. `npx verythinker --help` remains available for debugging and direct inspection; the user does not need to run each workflow step.

Twelve [role contracts](docs/roles.md) include a dedicated codebase analyst and check executor. Verification strategy belongs to the strong-role verifier; prescribed execution belongs to a worker. Run at most three workers and escalate repeated failure after one repair attempt. Strict Codex routing is the alpha.3 default. Claude/Copilot adapters retain their resources while exact-model execution remains restricted until verified.

## Persistent records and reusable knowledge

Each project stores authoritative Markdown/YAML records under `.verythinker/records`. Per-run JSONL events capture execution. SQLite/FTS5 is a rebuildable search index. Raw runs, cache, and prepared contributions are excluded from Git by default; preserve required execution logs separately when sharing verification records.

The manager archives required evidence logs/receipts under `.verythinker/evidence` before final review and inspects their contents before sharing.

Each request batch receives a stable increment ID and individually traceable requirement IDs. Accepted releases use project SemVer, initially `1.0.0`, under `codex/projects/<name>-<project-id>/baseline`, `increments/<increment-id>`, and `releases/<version>`. Working checkpoints append to increment history; accepted release snapshots are immutable. A private archive includes related records, changed implementation, verification inputs, and pack/tool/recipe locks. Sensitive content and inaccessible private upstreams produce explicit publication blockers.

Every assignment writes a substantive standard work record: Objective, Inputs and Sources, Decisions and Rationale, Results, Evidence, Limitations, and Lessons. Required project documentation is part of the reviewed deliverable. A new session resumes using current workflow/task records.

Knowledge packs carry provenance, applicability, assumptions, limitations, dependencies, and locked versions/hashes. Similarity suggests candidates; the manager assesses applicability. The built-in `engineering-basics` pack supplies a starting checklist.

[Cornell notes](docs/cornell.md) turn research, analysis, guidance, root causes, and lessons into visible source-backed documents with concrete demonstrations and separate runnable practice/answer artifacts. The quote **“DO NOT JUST TALK ABOUT IT — SHOW IT”** appears in every note. Generated knowledge records reference the authoritative narrative and its hashes; user-written practice solutions are preserved.

[Versioned recipes](docs/recipes.md) provide Cornell evidence notes, scalar configuration persistence, and embedded hysteresis load control. The responsible strong roles review and freeze parameters, coverage, expected outcomes, oracle rationale, and tolerances before a worker executes them. A developer generates implementation; an independent check executor records actual checks. Changed acceptance artifacts require reviewed reassessment.

The curator derives generalized candidates from reviewed project lessons and obtains a current separate generalization review. `.verythinker/automation.json` controls automatic draft PR creation and its upstream repository, defaulting to `VuThach3001/VeryThinker`. The manager submits qualified public-safe material under this saved policy and records the PR for recovery. Authentication and repository write access are required; failures remain explicit blockers. Submission never merges or publishes a package. Tests use a simulated GitHub API, and local packaging creates no real upstream PR.

The role-scoped gateway installs only applicable approved providers into an isolated tool cache: CodeGraph `1.6.2`, Context7 `4.3.0`, and Playwright MCP `0.0.83`, with version/integrity locks. Required missing capabilities block dispatch; optional substitutions are recorded. Existing CodeGraph conformance remains a twelve-check Windows fixture; project freshness and native tool discovery still need applicable evidence. Code-context discovery complements reviewed requirements traceability.

## Pilots and validation

The [software pilot](examples/software/README.md) implements persistent validated configuration. The [embedded pilot](examples/embedded/README.md) supplies a hysteretic sensor/load controller, portable C firmware, a behavioral model, and a SPICE netlist.

```sh
npm test
node examples/verify.mjs
node scripts/evaluate.mjs matrix
```

Automated coverage includes record integrity, stale evidence/reviews, dependency handling, adapter preservation, MCP core operations, and pilot behavior. `examples/verify.mjs` records actual pilot results; compiler and ngspice checks require their tools to be supplied. Embedded results demonstrate their stated simulation/compilation environment, with physical testing recorded separately.

The historical evaluation matrix plans **18 native agent trials**: two pilots, three configurations, and three repetitions. One alpha.2 trial was blocked by native execution policy; seventeen remain unrecorded. Alpha.3's selected routing default is an engineering policy; measured cost/time benefits remain unverified. See the [validation report](docs/validation.md) and [evaluation guidance](docs/release.md#agent-evaluation).

## Design basis and license

Read [research](docs/research.md), [CAMEL adoption research](docs/camel-research.md), and [architecture](docs/architecture.md) for decisions and primary sources. The project learns scoped context and memory practices from Trellis, task-graph/context-pointer practices from Matt Pocock, code-context ideas from CodeGraph, and role/task collaboration with coordinator-owned execution from CAMEL.

VeryThinker is [MIT licensed](LICENSE). Its code and templates are independently written; AGPL-licensed Trellis code/templates are not bundled. Third-party dependencies retain their own licenses.
