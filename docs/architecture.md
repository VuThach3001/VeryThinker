# Architecture decisions

Status: **v1 design baseline**. For current command arguments, use `verythinker --help`; for demonstrated behavior, read the project's verification report. [Research basis](research.md) separates source claims from implementation measurements.

## One package with one engineering core

The package contains a TypeScript core, CLI, local MCP server, platform adapters, portable role/skill resources, record templates, guides, packs, and pilots. CLI and MCP invoke the same operations; native clients execute their own agent runs. VeryThinker does not require a separate model API runtime for v1.

```mermaid
flowchart TD
    Client[Native agent client] --> Adapter[Instructions, roles, skills, hooks]
    Client --> CLI[CLI]
    Client --> MCP[Local MCP]
    CLI --> Core[Engineering core]
    MCP --> Core
    Core --> Records[Markdown and YAML records]
    Core --> Events[Per-run JSONL events]
    Core --> Index[Rebuildable SQLite and FTS5 index]
    Packs[Versioned knowledge packs] --> Core
    Graph[Optional code-context provider] --> Client
```

The provider assists source discovery. Reviewed requirements traceability remains in engineering records. Hooks assist execution, while gate decisions remain available through core operations when hooks are disabled.

## Autonomous native manager

Managed instructions route an ordinary engineering requirement to the manager skill. `src/manager.ts` persists intake, actual specialist contributions, the integrated decision, bounded assignments, and closure. The active native manager dispatches agents and operates MCP or CLI; the package does not introduce a second model runtime. [CAMEL research](camel-research.md) supplies the source-backed coordination patterns adopted independently.

Assignments carry a mandatory documentation contract. Submission captures substantive seven-section work records and affected documentation hashes; acceptance requires current execution evidence and review from an invocation that has never implemented that assignment. Requirement baselines include transitive allocation ancestry. Replanning preserves superseded tasks, evidence, reports, and publication history.

Project-owned `.verythinker/automation.json` controls the manager and automatic draft PRs. Closure prepares only independently reviewed generalized candidates, records real publication results or blockers, and never merges. Operation locks serialize intake, decision/closure, and candidate publication; record preconditions and final gate checks prevent a slow publication from overwriting changed work. An explicit candidate retirement with rationale preserves obsolete publication history while allowing a corrected reviewed replacement.

## Authoritative records and query index

Markdown records with YAML metadata are readable, reviewable, and version controlled. Their stable ID survives a file rename. Metadata identifies schema version, type, title, owner, status, revision, timestamps, typed links, and type-specific data. Bodies use the packaged templates.

Record types are requirement, design, task, check, evidence, review, change, problem, and knowledge. Work records are knowledge records with `kind: work-record`. A task identifies implementation artifacts and links to the requirements and designs it implements.

SQLite indexes records, text, and relationships. Run references remain in record data and JSONL events. The index is a derived artifact, excluded from Git, and rebuilt from authoritative inputs. Index freshness is checked before queries that support acceptance. Duplicate IDs, malformed records, invalid links, and dependency cycles are reported as integrity findings.

Store each directed link once. Reverse query views permit navigation without independently maintaining inverse edges. Requirement/interface changes identify affected records for reassessment; old evidence retains its original baseline.

## Native adapters and upgrade ownership

Portable resources describe responsibilities and process. Adapters render the configuration supported by each native client. Platform/client/version entries state supported, restricted, or unverified capability. Model tiers map to available model identifiers; requested and observed identifiers are different observations.

Installed content carries version and content hashes. Upgrade unchanged managed content, preserve unrelated settings, and write reviewable candidates when a managed file was edited by its user. Existing instructions and tool configuration remain under user control.

## Knowledge boundary

Project records hold project-specific knowledge. Shared packs contain generalized lessons with provenance, applicability, assumptions, limitations, and dependencies. Projects select multiple packs and lock identity, version, and content hash. Similarity suggests candidates; applicability requires an engineering decision.

An upstream contribution remains a separate reviewed candidate. Human approval precedes merging it into the shared library. A project branch is a delivery mechanism for changes rather than an identity for its knowledge.

## Failure and evidence boundaries

Interrupted sessions resume by task ID, current records, working tree, and evidence. A worker submits outputs; a separate reviewer invocation assesses them. The core evaluates applicable gates and reports missing or stale evidence. Tests demonstrate their actual environments; embedded simulation results do not establish board-level behavior.

Runtime assumptions are Node.js 24 LTS, local SQLite/FTS5, and Windows as the primary verification environment. The MIT package uses independently written templates. Optional tools and source-inspired design decisions retain their own license obligations.
