# Role catalog

Roles identify responsibilities and output contracts. Activate the roles needed by the increment; small projects may combine responsibilities. The independent reviewer runs in a separate invocation from implementation. Installed contracts live under `.verythinker/roles/`.

| Role ID            | Contract                                                                       | Strict Codex model |
| ------------------ | ------------------------------------------------------------------------------ | ------------------ |
| `manager`          | [Manager / Orchestrator](../resources/roles/manager.md)                        | `gpt-6.1-sol`      |
| `researcher`       | [Research Analyst](../resources/roles/researcher.md)                           | Luna → Terra       |
| `codebase-analyst` | [Codebase Analyst](../resources/roles/codebase-analyst.md)                     | Luna → Terra       |
| `requirements`     | [Requirements Engineer](../resources/roles/requirements.md)                    | `gpt-6.1-sol`      |
| `architect`        | [System Designer / Architect](../resources/roles/architect.md)                 | `gpt-6.1-sol`      |
| `component-owner`  | [Package Responsible / Component Owner](../resources/roles/component-owner.md) | `gpt-6.1-sol`      |
| `developer`        | [Functional Developer](../resources/roles/developer.md)                        | Luna → Terra       |
| `verifier`         | [Verification Strategy](../resources/roles/verifier.md)                        | `gpt-6.1-sol`      |
| `check-executor`   | [Prescribed Check Executor](../resources/roles/check-executor.md)              | Luna → Terra       |
| `reviewer`         | [Independent Reviewer](../resources/roles/reviewer.md)                         | `gpt-6.1-sol`      |
| `release`          | [Configuration / Release Engineer](../resources/roles/release.md)              | Luna → Terra       |
| `curator`          | [Knowledge Curator](../resources/roles/curator.md)                             | Luna → Terra       |

Sol roles use high reasoning. Worker roles use `gpt-6-luna` with medium reasoning; `gpt-5.6-terra` is allowed only after recorded native Luna unavailability. Exact selection requires signed native acknowledgments and successful inference where completion is required. Unconfirmed observations block strict work. One repair is permitted before the coordinator diagnoses and re-scopes consequential failures.

Each role has required/optional capabilities and a scoped gateway contract. Requirements and architecture use sources and design/verification artifacts; reviewers inspect without implementing; developers edit assigned outputs; check executors run prescribed procedures; release roles publish validated artifacts. Doctor distinguishes enforced restrictions from instruction-only limits. Claude/Copilot exact-model execution remains restricted until separately verified.

Every role writes the [standard work record](../resources/templates/work-record.md). Store it as a linked knowledge record with `kind: work-record`; history views retrieve these records by owner/role rather than maintaining a second independent journal.

Substantive findings are consolidated into [Cornell notes](cornell.md), linked to requirements, tasks, problems, and actual evidence. Notes preserve readable guidance and learning; work records preserve what an invocation did and its limitations.
