# Workflow reference

The packaged [workflow guide](../resources/guides/workflow.md) is the authoritative agent-facing procedure. Installation places it at `.verythinker/guides/workflow.md` in each target project. Portable skills disclose that guide and the appropriate role contract when needed.

The execution sequence is:

1. Inspect capabilities, project state, requirements, and task dependencies.
2. Generate a bounded worker context packet and assess readiness.
3. Execute within ownership, run agreed checks, and submit artifacts/evidence.
4. Review in a separate invocation and disposition findings.
5. Assess the applicable completion gate through the core.
6. Record a resumable work history and curate qualifying lessons.

Use `verythinker --help` to inspect command arguments. The `task`, `context`, `record`, `check`, `trace`, `verify`, `memory`, and `pack` groups support the process. Equivalent MCP operations use the same core logic.

When a native capability is unavailable, use the CLI path and record the limitation. When a worker cannot complete within scope, return a concrete blocker or decision request to the manager. A submitted result becomes accepted only after its applicable checks and review are evaluated.
