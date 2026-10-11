# Manager-first workflow

After installation, give the native agent one engineering requirement in ordinary language. Managed instructions automatically route engineering intent to `verythinker-manager`. You do not need to choose specialist roles, maintain documentation, or run record-management commands.

For example:

```text
Add persistent configuration for intervalMs (100–60000) and retries (0–5).
Reject invalid values without changing the stored configuration.
Preserve configuration across application restarts.
```

The manager owns the increment through requirements, internal specialist discussion, design decisions, implementation, documentation, checks, independent review, task acceptance, and qualified knowledge contribution. It asks for clarification when product intent cannot be inferred. It reports the chosen approach and material tradeoffs, then continues within the authorized scope.

## What happens internally

| Stage   | Manager responsibility                                                                                                                     | Persisted result                                                    |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| Intake  | Read project state, profile, capabilities, constraints, and the requirement; resume matching unfinished work                               | Workflow and measurable requirement records                         |
| Discuss | Obtain current contributions from two specialist roles in distinct native invocations; resolve conflicts against requirements and evidence | Role/invocation discussion summaries, sources, risks                |
| Decide  | Select the approach, rationale, verification strategy, ownership, and dependencies                                                         | Manager decision and child task IDs                                 |
| Execute | Review applicable designs, delegate changes, integrate results, update project documentation, run checks                                   | Implementation/documents, substantive work records, actual evidence |
| Accept  | Obtain separate reviewer invocation, resolve findings, validate current baselines and accepted gates                                       | Current review and accepted task records                            |
| Curate  | Consolidate qualified lessons, generalize public-safe content, obtain independent generalization review                                    | Reviewed project knowledge and contribution candidate               |
| Close   | Apply contribution policy, create the draft PR when enabled, and validate closure                                                          | Contribution disposition, closure state, final user report          |

Internal discussion means concise specialist recommendations with rationale and evidence. It is not a generated transcript claiming agents that never ran. Requested and observed models are recorded separately; unavailable observations stay explicitly unavailable.

The iterative V-model links specification/design to corresponding verification levels. Automotive SPICE 4.1 references guide engineering and cross-cutting responsibilities; these records do not establish an ASPICE capability rating. Read the installed [manager procedure](../resources/guides/manager.md) and [process mapping](../resources/guides/process.md) for the actual contracts.

## Documentation and knowledge are deliverables

The manager declares documentation outputs when assigning work. Workers update affected specifications, designs, interfaces, project guides, and seven-section work records. Submission stores substantive content, and review assesses the current implementation/documentation baseline. Missing required documentation keeps the workflow open.

Project records remain under `.verythinker`. Shared contributions contain only independently reviewed generalized content with public-safe provenance, applicability, assumptions, and limitations. Work that yields no reusable conclusion records a concrete no-lesson reason rather than inventing a lesson.

## Automatic draft PR policy

Installation creates `.verythinker/automation.json`. The default enables automatic reviewed documentation/knowledge PR creation to `VuThach3001/VeryThinker`. Set another upstream or disable automatic PR creation through project policy when appropriate. Managed installation preserves user edits; update conflicts produce candidates for review.

The manager reads the policy and performs routine submission after the generalization review, without another permission question. The contribution core creates a draft PR and records it for recovery; it never merges a PR or publishes an npm package. Human approval remains the merge decision. GitHub authentication and repository write access must already be available for submission.

An authentication, access, native execution-policy, or service failure produces a recorded blocker with the required external action. The manager reports the blocker; it does not invent a PR, broaden native permissions, or replace the user's work with repeated CLI instructions.

## Native execution and honest limits

The package uses native Codex, Claude Code, or Copilot workers. It does not include a separate model API runtime. MCP exposes manager operations and the engineering core. Agent-operated CLI fallback provides the same workflow when MCP is unavailable; user operation of each command is not part of normal use.

At most three workers run concurrently. Discussion is bounded to three rounds. One repair is permitted before stronger internal escalation or a documented blocker. Independent review uses a separate invocation from implementation. If the native client cannot provide that invocation, acceptance remains open and the manager reports the limitation.

An active native session performs the work. Interruption persists resumable state; automatic background execution requires a separately configured native facility. Generated adapters and deterministic workflow checks do not prove live native skill discovery, effective routing, or successful delegation on every client version. See [compatibility](compatibility.md) and [validation](validation.md).

## Resumption and final response

In a fresh session, say `Continue the configuration requirement`. The manager inspects workflow state, actual files, current evidence and reviews, then resumes the next valid action. It reassesses stale baselines before accepting prior results.

The final response contains decisions and rationale, delivered behavior, actual verification and limits, documentation/record locations, accepted status, and draft PR links. Open blockers are stated precisely. The user receives an outcome they can assess without reconstructing the internal discussion.

## Design basis

VeryThinker retains its native clients and adopts CAMEL's separation of role/task context, explicit multi-agent collaboration, coordinator-owned task execution, and recorded lifecycle/termination. The implementation is independent TypeScript; it does not bundle a Python CAMEL runtime. See [CAMEL research](camel-research.md) for source-backed adoption boundaries and licensing.
