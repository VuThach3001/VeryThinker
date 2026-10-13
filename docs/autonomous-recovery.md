# Autonomous intake and worker recovery

## Objective

Keep an intake request moving through bounded local engineering work when recoverable implementation faults or optional service failures occur. Prevent a bound native worker from waiting for its own inference completion.

## Inputs and Sources

- `src/mcp.ts` defines the invocation-bound `native_wait` and `native_status` MCP tools.
- `resources/guides/manager.md`, `resources/guides/workflow.md`, and `resources/skills/verythinker-manager/SKILL.md` describe coordinator and worker recovery behavior.
- `test/mcp-binding.test.mjs` establishes the in-memory MCP client and protocol-fixture test pattern.
- A reproduced reviewer control loop attempted to wait for its own invocation and timed out.

## Decisions and Rationale

Keep self-wait prevention at the MCP boundary: after loading the bound receipt, reject only when the requested ID is that same receipt, before any wait or authorization work. This unconditional denial exposes no receipt data and lets all other waits retain their existing authorization and scope checks. `native_status` remains read-only for the worker's own receipt. The error directs a worker to report its current work and return so the coordinator can collect it and wait on other workers.

Recovery guidance favors bounded fixes for deterministic core, schema, configuration, and environment issues. Historical interrupted outcomes remain historical; fresh claims need current applicable evidence. Old output text alone does not justify interrupting a live worker while task records continue to progress. Requested local deliverables remain the first output when optional providers or publication services fail, and actual access requirements remain recorded blockers.

Windows verification commands keep their reviewed argument array and run without a shell. For `npm`/`npm.cmd`, the resolver locates the matching installed `npm-cli.js` from the explicit executable path, npm's reported executable path, the Node installation, or `PATH`; if it cannot find the CLI, it reports the local installation problem instead of falling back to shell evaluation.

Signed reports may include a prior invocation only after its signed receipt proves terminal history and matches the current role, workflow, and task. The report captures the earlier state, inference-completion flag, execution mode, model observations, and error. This lets the coordinator document failed or interrupted work without converting it into a completed result or accepted evidence.

Missing public trust metadata may be restored only from a verified project-bound local backup signed by the original local private key and matching the current project and key identity. The repair validates the registry and every listed public key before writing. It preserves the private key and receipts, never enrolls or re-enrolls a key, and does not replace an existing malformed registry, mismatched public key, or other trust decision. Without corroborating backup for a missing registry, the missing-trust condition remains an external recovery requirement.

Local closure output is saved before optional publication work. The workflow records the final report's path and hash separately from publication disposition, so an upstream credential or service failure can remain visible without discarding the requested local report.

First-time key creation stages a signed project-bound recovery intent before publishing trust metadata. Interrupted initialization resumes with that same key. Losing an established private key does not enroll a replacement.

User continuations received during a live coordinator invocation are saved idempotently and surfaced in status. After native completion, pending input resumes coordinator reassessment before closure. If a snapshot is already frozen, follow-ups receive a new increment that references the prior workflow; the frozen snapshot is preserved. Queuing and transfer never claim native incorporation. Necessary task metadata can expand an implicit context budget up to 100000 characters; explicit budgets remain enforced.

Native resumption requests thread metadata without hydrating the complete saved conversation, then retrieves the most recent 100 turn summaries without item bodies to reconcile unfinished work. The resumed thread identity must match the requested identity. If a resume fails before acknowledgment, a retry may recover the nearest signed, completed, same-assignment ancestor thread while retaining the failed attempt as its immediate predecessor. Existing receipts remain unchanged.

## Results

The MCP wrapper rejects a bound invocation's self-wait before authorization or the native wait operation; all other waits retain their existing authorization and scope checks. `native_status` remains annotated read-only. The focused test uses the repository's protocol fixture, which does not authenticate or perform inference, to check the rejection message, the read-only annotation, and unchanged persisted receipt state. Coordinator and worker guidance now describes the same completion and recovery path.

## Evidence

The release suite passed 255 tests. After the final native-resume correction, 20 focused native, continuation, provisioning, and resume tests passed. The packaged installation smoke test exercises 26 checks. A separate Luna/max reviewer inspected the recovery and resume changes; its review is an independent code review, not a signed project acceptance record.

The resume fixtures cover a conversation that would otherwise exceed the transport buffer, preservation of original and failed receipts, same-assignment ancestry checks, and manager retry without a duplicate conversation. Protocol fixtures exercise local code paths; they do not establish real account access or project acceptance. Authenticated project resumption is evaluated separately from these fixtures.

## Limitations

Native transport ownership, approval requirements, routing proof, acceptance gates, and publication authorization remain enforced. Recovery does not fabricate evidence or replace an existing trust decision.

## Lessons

A worker that waits for its own inference cannot produce the output the coordinator is waiting to collect. Rejecting that wait at the bound MCP operation gives the worker an immediate next action while preserving the coordinator's normal worker-wait path.
