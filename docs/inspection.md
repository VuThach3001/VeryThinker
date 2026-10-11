# Inspection evidence

Command execution and source inspection are separate verification methods. A command check uses `check_run`. A reviewed inspection check uses `check_inspect`, with an inspection method, no executable command, and a rubric of unique items containing `id`, `criterion`, and `expected`. Sol owns that procedure and its independent planning review.

The assigned check executor supplies an observation for every item. Each observation identifies `pass`, `fail`, or `gap`, explains what was observed, and cites current file hashes or engineering-record fingerprints with useful locations. Expected outcomes come from the reviewed rubric. Missing, duplicate, unrelated, or stale sources are rejected. A failure or gap produces failing evidence. Explicit limitations are mandatory.

The Core captures the inspected implementation, referenced records, additional sources, environment, native invocation, and reviewed procedure in immutable input artifacts. The log and receipt retain all observations. Evidence is labelled `agent-observed-inspection`; it has no process exit code and does not establish the truth of semantic judgements by itself. Independent Sol review remains necessary for acceptance. Changes to the source, procedure, observations, or recorded execution receipt invalidate applicable evidence.

Strict collection requires a running native check-executor receipt that actually received `check_inspect`. Existing invocations without that capability cannot authorize it. `inspectCheck` and the administrative `check inspect` command use the same Core guards; no caller-written model name establishes authority.

Verification strategy names frozen verification scripts in `verification_artifact_paths` or the existing protected/oracle fields before implementation. Review snapshots hash those bytes, and the Developer's scoped writer rejects edits to them. Compiler source operands remain implementation inputs and may change within the reviewed assignment. A genuine oracle correction follows the reviewed change process and requires fresh evidence.

Use bounded `record_get` projections to inspect current rubric fields and obtain their fingerprints without repeatedly loading historical metadata. Source inspection never replaces required command results, circuit simulation, measurements, or acceptance review. See [native execution](native-runtime.md), [scoped edits](workspace.md), and [validation boundaries](validation.md).
