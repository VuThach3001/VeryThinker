# Research basis for VeryThinker v1

Reviewed on **2026-10-11**. This report records primary-source inspection and design decisions. Repository claims and published evaluations are identified as source-reported; they are not VeryThinker performance measurements or live client validation. Mutable repository links represent the reviewed documentation, not a dependency version lock.

## Conclusions

The inspected implementation snapshots were Trellis `f089cb3286071199e84118dee86b6d76aab032f1` (npm `0.6.17`, AGPL-3.0-only), Matt Pocock skills `49dd158d1076134a641b33efb035946536778336` (MIT), and the published CodeGraph `1.6.2` artifact with git head `6560052a6f856855d3f71eee838fd66ccfa4285d` (MIT). Repository main branches can differ from those published snapshots. The [pinned CodeGraph experiment](codegraph.md) separately records measured package behavior.

VeryThinker should install a small engineering core around the user's existing native agent client. Portable role and skill content can be shared, while model selection, tool restrictions, hooks, and native agent definitions require client-specific adapters. Requirements and verified outcomes need stable records beyond the current conversation. Local project history and generalized reusable knowledge have different promotion and review needs.

An intelligent coordinator with bounded workers is a promising routing strategy, but efficiency must be measured on accepted tasks. A larger roster of always-active agents would add coordination cost without establishing better outcomes. Logical roles can be combined for small increments and separated when expertise, independence, or ownership requires it.

## Trellis: task context and durable memory

Trellis documents task directories containing requirements, design, research, status, and context manifests. Its parent/child structure groups work; the documentation explicitly distinguishes this from dependency scheduling. Workspace journals preserve session history, while project specs preserve reusable conventions. These concepts support resumption and targeted context loading. [Task system](https://raw.githubusercontent.com/mindfold-ai/Trellis/main/.agents/skills/trellis-meta/references/local-architecture/task-system.md), [workspace memory](https://raw.githubusercontent.com/mindfold-ai/Trellis/main/.agents/skills/trellis-meta/references/local-architecture/workspace-memory.md).

**Adoption:** keep scoped task records, context pointers, work history, and reviewed lessons. Add explicit dependency validation and typed engineering links. Markdown/YAML records remain authoritative; SQLite becomes a rebuildable query index rather than a competing authority. The inspected task/journal documentation does not describe SQL as the authoritative task store.

Trellis publishes an npm installation route and multi-platform generated setup. Its repository declares AGPL-3.0 licensing. VeryThinker retains MIT and implements the selected patterns independently; no Trellis templates or code are bundled. [Repository and license](https://github.com/mindfold-ai/Trellis).

## Matt Pocock: task graphs and context pointers

The inspected `implement-spec` skill uses a task graph, a ready frontier, bounded implementer work, context pointers, integration, and final review. It describes worktrees for parallel implementers. [Primary skill](https://raw.githubusercontent.com/mattpocock/skills/main/skills/engineering/implement-spec/SKILL.md).

**Adoption:** packets point to specifications and research instead of repeating them. Dependencies are explicit. Parallel assignments need ownership boundaries. A task's outputs and criteria determine completion. Worktrees are useful when independent Git changes require isolation, while shared working-tree execution needs disjoint ownership. VeryThinker does not inherit destructive reset operations or mandate that every small change create a branch and worktree.

## Code-context providers

The candidate comparison concerns installation fit and exposed capabilities. It is not a speed or accuracy benchmark.

| Candidate | Primary-source finding | v1 decision |
| --- | --- | --- |
| [Colby McHenry CodeGraph](https://github.com/colbymchenry/codegraph) | Documents local indexing, CLI/MCP queries, SQLite/FTS5, C/C++ parsing, and freshness handling. | First optional adapter; pin the plan's `1.6.2` version and validate that artifact. |
| [CodeGraphContext](https://github.com/CodeGraphContext/CodeGraphContext) | Documents Python/pip installation, CLI/MCP, and graph-database indexing. | Viable alternative with a separate runtime; keep behind the provider boundary. |
| [GitNexus](https://github.com/abhigyanpatwari/GitNexus) | Documents npm installation, indexing, an MCP server, and client setup. | Viable npm alternative; defer a second adapter until comparative fixtures justify it. |

The selected provider's current README describes capabilities of its current repository. Those capabilities must be tested against the pinned artifact; a newer README does not establish older-version support. Windows startup, C/C++ symbol relationships, source edits/deletes, and query freshness require fixture verification.

**Adoption:** use code graphs to discover implementation relationships and likely change impact. A call graph cannot independently prove a requirement is satisfied. Store requirement/design/check/evidence links in VeryThinker records and review their meaning. The optional provider must leave the core workflow usable when unavailable.

## Native platform portability

The [Agent Skills specification](https://agentskills.io/specification) defines a skill directory with `SKILL.md`, required name/description metadata, Markdown instructions, and optional resources. It encourages progressive disclosure. It does not standardize every client's model routing, subagent configuration, hooks, or permission behavior.

Codex documents native subagent configuration; Claude Code documents subagent definitions and model resolution; Copilot documents agent frontmatter with environment-specific support. Treat these as separate adapter targets and maintain a compatibility matrix by client/version. [Codex subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents), [Claude Code subagents](https://code.claude.com/docs/en/sub-agents), [Copilot custom agents](https://docs.github.com/en/copilot/reference/custom-agents-configuration).

**Adoption:** author each role and skill once, generate the native form, and mark unsupported or unverified capabilities explicitly. Preserve existing configuration. CLI/MCP core operations provide the fallback when hooks or native delegation cannot run. Native instruction discovery, chosen model, hook invocation, and client trust behavior need live smoke tests; generating syntactically valid files alone does not verify them.

## Multi-agent routing and evaluation

Anthropic describes a coordinator/worker research system using a more capable lead and less costly subagents. It reports improved performance on its internal research evaluation and also substantial token use. Its practical lessons include precise objectives, output formats, task boundaries, effort limits, tool design, durable state, and outcome-based evaluation. These observations apply to the reported research workload; they do not establish that every coding task benefits from multi-agent execution. [Anthropic engineering report](https://www.anthropic.com/engineering/multi-agent-research-system).

Research on scaling agent systems reports that architecture-task alignment matters, including degraded performance on sequential planning with unsuitable coordination. [Towards a Science of Scaling Agent Systems](https://arxiv.org/abs/2512.08296).

**Adoption:** use configurable model tiers, bounded workers, clear ownership, one repair attempt, and explicit escalation. Compare the same pilot requirements/checks across a strong single agent, same-model coordinator/workers, and tiered coordinator/workers. Record unavailable telemetry honestly. Adopt a routing policy only for task categories where accepted outcomes retain quality and observed time or cost improves.

Agent evaluations should assess the final artifact, actual checks, operational limits, and repeated trials. Human review covers gaps that automatic graders miss. [Anthropic evaluation guidance](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents).

## V-model, process evidence, and reuse

VDA's publication page lists Automotive SPICE 4.1, dated August 2026, as its process reference and assessment model. VeryThinker uses this version for process navigation. The detailed PAM PDF could not be retrieved through the browsing tool during this inspection; the mapping is guidance and must be checked against the official outcomes before a formal assessment. [VDA publications](https://vda-qmc.de/en/automotive-spice/automotive-spice-veroeffentlichungen/).

NASA describes iterative realization, verification against design specifications, validation against stakeholder expectations, and reassessment of reused products in the new system. Its management guidance addresses requirements, configuration, interfaces, and technical data. [Product realization](https://www.nasa.gov/reference/5-0-product-realization/), [crosscutting management](https://www.nasa.gov/reference/6-0-crosscutting-technical-management/).

**Adoption:** define checks with requirements, preserve typed links and baseline-specific evidence, and distinguish simulation from physical testing. Review requirements/interfaces and reassess downstream records after change. Project knowledge is generalized into candidates and reviewed before upstream sharing. Versioned packs compose reusable lessons; Git branches carry the contribution changes. Profiles and gates are VeryThinker design decisions, not a certification claim.

## Remaining verification work

- Exercise native discovery, model routing, MCP, and hooks in each supported client/version.
- Validate the pinned CodeGraph adapter with Windows and C/C++ freshness fixtures.
- Execute both pilots and inspect complete traceability and resumption.
- Run the repeated agent comparison; no routing savings are claimed before measurement.
- Audit any process-assessment claim against the complete official PAM.
- Verify npm name availability and publication credentials immediately before publication.

The current research supports the architecture choices and test plan. Release evidence must be recorded separately from this report.
