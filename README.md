# VeryThinker

VeryThinker turns one engineering requirement into a manager-led workflow in native **Codex, Claude Code, or GitHub Copilot**. The manager discusses with specialists, reports decisions, delivers implementation and documentation, verifies evidence, obtains independent review, finishes tasks, and prepares reviewed shared knowledge.

**Status: `0.1.0-alpha.2`, local prerelease.** This repository does not claim an npm publication. Generated native configuration and core workflow behavior are tested; authenticated skill discovery, effective model routing, MCP invocation, and hooks require recorded client conformance runs. See [compatibility](docs/compatibility.md) and [release criteria](docs/release.md).

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
npm install --save-dev D:/workspace/VeryThinker/artifacts/verythinker-0.1.0-alpha.2.tgz
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

Default project policy enables automatic creation of independently reviewed generalized documentation/knowledge draft PRs to the shared repository. Project-specific records and logs stay local. Human approval applies to merging the proposal. Read [the manager-first workflow](docs/autonomous-manager.md) for policy, resumption, and native execution limits.

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
| `mcp`                                | Start the local MCP server                                                 |

The manager uses MCP or the CLI internally. `npx verythinker --help` remains available for debugging and direct inspection; the user does not need to run each workflow step.

Ten [role contracts](docs/roles.md) cover manager, researcher, requirements engineer, architect, component owner, developer, verifier, reviewer, release engineer, and knowledge curator. Activate roles as needed. Model tiers `economy`, `balanced`, and `strong` are configurable requests; record actual model observations separately. Start with at most three workers and escalate repeated failure after one repair attempt.

## Persistent records and reusable knowledge

Each project stores authoritative Markdown/YAML records under `.verythinker/records`. Per-run JSONL events capture execution. SQLite/FTS5 is a rebuildable search index. Raw runs, cache, and prepared contributions are excluded from Git by default; preserve required execution logs separately when sharing verification records.

The manager archives required evidence logs/receipts under `.verythinker/evidence` before final review and inspects their contents before sharing.

Every assignment writes a substantive standard work record: Objective, Inputs and Sources, Decisions and Rationale, Results, Evidence, Limitations, and Lessons. Required project documentation is part of the reviewed deliverable. A new session resumes using current workflow/task records.

Knowledge packs carry provenance, applicability, assumptions, limitations, dependencies, and locked versions/hashes. Similarity suggests candidates; the manager assesses applicability. The built-in `engineering-basics` pack supplies a starting checklist.

The curator derives generalized candidates from reviewed project lessons and obtains a current separate generalization review. `.verythinker/automation.json` controls automatic draft PR creation and its upstream repository, defaulting to `VuThach3001/VeryThinker`. The manager submits qualified public-safe material under this saved policy and records the PR for recovery. Authentication and repository write access are required; failures remain explicit blockers. Submission never merges or publishes a package. Tests use a simulated GitHub API, and local packaging creates no real upstream PR.

The optional CodeGraph descriptor pins `@colbymchenry/codegraph@1.6.2` and is disabled/unverified by default. The recorded Windows fixture passed twelve checks. Explicit enablement accepts a matching conformance report and the exact server executable/arguments; see [CodeGraph setup](docs/codegraph.md). Code-context discovery complements reviewed requirements traceability.

## Pilots and validation

The [software pilot](examples/software/README.md) implements persistent validated configuration. The [embedded pilot](examples/embedded/README.md) supplies a hysteretic sensor/load controller, portable C firmware, a behavioral model, and a SPICE netlist.

```sh
npm test
node examples/verify.mjs
node scripts/evaluate.mjs matrix
```

Automated coverage includes record integrity, stale evidence/reviews, dependency handling, adapter preservation, MCP core operations, and pilot behavior. `examples/verify.mjs` records actual pilot results; compiler and ngspice checks require their tools to be supplied. Embedded results demonstrate their stated simulation/compilation environment, with physical testing recorded separately.

The evaluation matrix plans **18 native agent trials**: two pilots, three configurations, and three repetitions. One actual trial was blocked by native execution policy; seventeen remain unrecorded. Routing benefits remain unverified. See the [validation report](docs/validation.md) and [evaluation guidance](docs/release.md#agent-evaluation).

## Design basis and license

Read [research](docs/research.md), [CAMEL adoption research](docs/camel-research.md), and [architecture](docs/architecture.md) for decisions and primary sources. The project learns scoped context and memory practices from Trellis, task-graph/context-pointer practices from Matt Pocock, code-context ideas from CodeGraph, and role/task collaboration with coordinator-owned execution from CAMEL.

VeryThinker is [MIT licensed](LICENSE). Its code and templates are independently written; AGPL-licensed Trellis code/templates are not bundled. Third-party dependencies retain their own licenses.
