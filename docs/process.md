# Process reference

The packaged [process guide](../resources/guides/process.md) is the authoritative agent-facing definition of profiles, gates, traceability, evidence, and knowledge promotion. Installation places it at `.verythinker/guides/process.md` in the target project.

Use the **basic** profile for bounded work with requirement/check/evidence/review coverage, **software** for explicit architecture and verification levels, and **embedded** for hardware/software allocation and reproducible configurations. Document why an item is non-applicable.

The Automotive SPICE mapping is navigational guidance to version 4.1. It does not establish a capability rating; a formal assessment requires the official process outcomes and competent assessment. Detailed source-inspection limits are recorded in the [research report](research.md).

For implementation, use the CLI or MCP to create records and typed relationships, then evaluate a gate through `verify`. Review the findings before accepting a task. Preserve historical evidence and reassess applicability after requirement, interface, source, or environment changes.

Alpha.3 begins with one natural-language request or a batch of requirements. Sol clarifies measurable requirements, architecture/interfaces, and verification strategy before cheaper bounded implementation. Each requirement retains its own coverage within a stable increment. Sol performs the independent review using a separate native invocation; strict gates verify signed model-selection receipts.

Use a [reviewed recipe](recipes.md) when its applicability matches. Freeze coverage classes, boundaries/faults, parameters, expected outcomes, oracle rationale, and tolerances before implementation. The developer produces artifacts; the check executor runs the frozen procedure. Genuine specification corrections proceed through a reviewed change and fresh evidence.

Research, codebase analysis, guidance, root causes, and durable lessons use [Cornell notes](cornell.md) with concrete demonstrations and runnable practice. Actual checks support observed claims; source-reported, expected, and inferred claims retain their labels. The seven-section work record remains the assignment history.

After final validation, the manager publishes a private accepted snapshot and advances project release history under its captured baseline. Records, implementation, verification inputs, and protected artifacts stay traceable. Generalized shared lessons follow the separate reviewed draft-PR process. Archives establish engineering history, and formal ASPICE capability claims still require competent assessment.
