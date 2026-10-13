# Fast workflow policy

Fast v1 is a policy-selected route for one exact requirement covered by a qualified existing warm procedure and a known, reviewed, versioned recipe binding. The plan contains exactly one bounded developer task. A core-issued composite manager grant compresses planning responsibilities, and a task-specific developer grant constrains production. Standard role policy, protected checks, independent review, actual evidence, and acceptance remain in force. Fast makes no fixed runtime or quality promise.

## Eligibility

The native controller selects Fast automatically only when `.verythinker/fast-bindings.json` resolves one exact requirement string to a supported reviewed recipe version and the request remains within one existing warm procedure. The binding includes the recipe parameters, up to five existing project-visible editable paths, existing protected-input paths, and false flags for security, safety, interfaces, dependencies, and environment. The plan is limited to one unstarted developer task with its documentation and reviewed checks inside the selected scope. The planner may leave it in draft; the independent plan reviewer and `design-ready` core gate establish readiness before production begins. Selection pins a fingerprint over the binding, recipe integrity, relevant configuration, protected inputs, and editable baseline. Validate the fingerprint and inputs at each stage boundary.

Unknown or multi-requirement requests, missing or ambiguous bindings, invalid schema or parameters, unavailable recipes, risky flags, protected or noncanonical paths, changed configuration, or a changed protected input fall back to Standard in automatic mode. An explicit invalid Fast request is rejected. The full policy and current schema are implemented in the core; do not invent bindings or relax risk flags to force selection.

## Stage contracts

The Fast planner grant is issued to the strong-role manager invocation and covers manager, requirements, architect, and verifier responsibilities for the selected plan. Its authority is workflow-scoped, permits only the intended requirement/design/check planning operations, and grants no project-file edits. The plan receives the usual separate strong-role independent review before implementation.

The Fast producer grant is issued to the standard developer role after a current `design-ready` result. It is bound to one workflow and task, the selected editable paths, exact protected check IDs, the reviewed task plan, and native configuration. It can edit only its assigned files and run only its protected checks. It cannot modify planning records or change the reviewed expectation. Revalidate grants, hashes, and protected inputs before use.

The successful path uses four principal native invocations: planning, independent planning review, production, and independent final review. The two reviewer invocations use one thread when native resume can issue a fresh receipt for final review; otherwise use a separate final-review thread. Keep repair, private-resume, and failed-run receipts as additional immutable history.

## Quality and reporting

Protected expectations, actual check results, evidence archives, fresh baseline review, independent final review, and core acceptance keep their Standard meaning. Advisory lifecycle hooks can assist but cannot replace mandatory core validation. Do not claim acceptance from a completed invocation, elapsed time, compact progress, or a passing partial check. Report model selections from signed observations. Describe Fast as reduced coordination overhead; make no fixed runtime or quality guarantee. On interruption, resume the same stage with a fresh private receipt. Save user follow-ups for plan reassessment and keep acceptance gated until affected requirements, design, task scope, and checks are reassessed. When failure or new risk exceeds the recipe or task scope, retain the evidence and route open work to Standard reassessment; never discard the Fast history.

For status-cost comparisons, run `scripts/benchmark-status.mjs` against an initialized project after building the current core. The benchmark calls the exported progress projection and full workflow status functions, records wall-clock samples and summary statistics, and emits no workflow contents. Treat measurements as observations for that machine and project snapshot, not as a service-level promise. An optional prior artifact can be compared without rereading or modifying it.

### Pilot timing

| Operation | Before | After |
| --- | ---: | ---: |
| `manager_status` | 28,646 ms (one sample) | 2,957.922 ms (median of three) |
| `manager_progress` | Not measured | 569.143 ms (median of three) |

These readings used the same hardware and historical project-state load. The before value is a single sample and the after values are three-sample medians, so they are descriptive pilot observations rather than a controlled before/after guarantee. The expanded 20-case authorization benchmark has not been run; these timings establish no authorization or native-execution result.
