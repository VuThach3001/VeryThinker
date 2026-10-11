# Role catalog

Roles identify responsibilities and output contracts. Activate the roles needed by the increment; small projects may combine responsibilities. The independent reviewer runs in a separate invocation from implementation. Installed contracts live under `.verythinker/roles/`.

| Role ID | Contract | Default tier |
| --- | --- | --- |
| `manager` | [Manager / Orchestrator](../resources/roles/manager.md) | strong |
| `researcher` | [Research Analyst](../resources/roles/researcher.md) | economy |
| `requirements` | [Requirements Engineer](../resources/roles/requirements.md) | balanced |
| `architect` | [System Designer / Architect](../resources/roles/architect.md) | strong |
| `component-owner` | [Package Responsible / Component Owner](../resources/roles/component-owner.md) | balanced |
| `developer` | [Functional Developer](../resources/roles/developer.md) | balanced |
| `verifier` | [Verification Engineer](../resources/roles/verifier.md) | strong |
| `reviewer` | [Independent Reviewer](../resources/roles/reviewer.md) | strong |
| `release` | [Configuration / Release Engineer](../resources/roles/release.md) | balanced |
| `curator` | [Knowledge Curator](../resources/roles/curator.md) | balanced |

Defaults are routing suggestions. Resolve each tier against the selected platform and escalate when the task's ambiguity or risk requires stronger judgment. Record unavailable model observations explicitly.

Every role writes the [standard work record](../resources/templates/work-record.md). Store it as a linked knowledge record with `kind: work-record`; history views retrieve these records by owner/role rather than maintaining a second independent journal.
