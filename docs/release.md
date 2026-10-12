# Prerelease and stable release criteria

The package version is `0.1.0-alpha.3.2`. Strong roles now request `gpt-6-luna` with `max` reasoning; routine workers remain Luna with `medium` reasoning and Terra only after observed worker-model unavailability. The intake placeholder fix and engineering gates remain in effect. Build and distribute a local tarball while recorded native conformance and agent evaluation remain release evidence requirements. Prior Sol/high receipts remain historical evidence; they do not satisfy the new policy for pending work. This document does not claim registry publication or complete engineering-workflow verification.

## Local validation and packaging

From the repository checkout:

```sh
npm ci
npm test
npm pack --dry-run --json
npm pack --pack-destination artifacts
```

Record the source revision and relevant working-tree hashes, Node/npm versions, test results, packaged file inventory, and tarball SHA-256. Install the resulting tarball into a separate temporary project and exercise `init`, `doctor`, a complete requirement/task/check/review lifecycle, a new-session resumption, and `update`. Confirm that generated resources and the MCP executable resolve from the installed package.

Package smoke uses two clearly labelled environments: installed alpha.3 verifies twelve roles, all three recipes, scoped/native/archive/Cornell MCP discovery, configuration preservation, and rejection of unconfirmed invocations; a separately initialized legacy-policy fixture exercises record, documentation, evidence, review, closure, and resume mechanics. The latter never establishes authenticated native routing. Record actual model and effort execution separately through the pinned bridge.

Exercise `task resume TASK_ID` after interruption and `task repair TASK_ID --summary FEEDBACK` after review. The first repair returns work to readiness; repeated failure requires documented coordinator escalation and an explicit selected model for resumption. Confirm that a new implementation baseline requires fresh evidence and review.

CI runs dependency installation, tests, and packaging on Windows and Ubuntu with Node 24. A saved workflow defines checks; only an observed successful run supplies CI evidence. Local Windows results must remain distinct from Ubuntu or remote results.

## Verification boundaries

| Evidence                          | Supported claim                                                       | Additional evidence needed                                                            |
| --------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Core/adapter automated tests      | Tested record operations, gate behavior, generation, and preservation | Relevant environment-specific and authenticated client conformance                    |
| MCP protocol tests                | Tested discovery and invocation through the local transport           | Native clients invoking the configured server                                         |
| Software pilot tests              | Exercised validation, persistence, errors, and restart behavior       | Production environment and power-loss guarantees if required                          |
| Embedded behavioral/SPICE results | The stated simulation and ideal-circuit conditions                    | Actual board, component, timing, thermal, EMC, and HIL testing as applicable          |
| C compilation                     | Firmware compiles under the recorded compiler/options                 | Executed firmware/target behavior and model equivalence                               |
| Native host C/model comparison    | Recorded firmware cases execute and agree with the reference model    | MCU execution, hardware timing/interfaces, and independent specification verification |
| Evaluation matrix                 | Planned workload and result schema                                    | Actual native agent runs and observations                                             |

Preserve logs and execution receipts needed to validate evidence. Raw runs are excluded from Git by default; provide them as explicit evidence artifacts when another machine must reassess a baseline. Run results remain tied to their source hashes and configuration.

`check archive EVIDENCE_ID` copies selected logs and the execution receipt into `.verythinker/evidence` and updates their references. Review their contents before committing or sharing them. Archive evidence before final acceptance review because relocating its artifacts changes the reviewed record.

## Agent evaluation

The runner harness creates **18 planned trials** across software/embedded, strong-single/same-model-workers/tiered-workers, and three repetitions:

```sh
node scripts/evaluate.mjs matrix
node scripts/evaluate.mjs run --runner PATH_TO_RUNNER --runner-args-json '[]' --platform CLIENT_NAME --output artifacts/evaluation.jsonl
node scripts/evaluate.mjs summarize --input artifacts/evaluation.jsonl
```

The runner receives one JSON task on stdin and returns one JSON result on stdout. It must implement the pilot, preserve provided requirements/tests, record implementation and separate review identities, write a review artifact, and return observed metrics/model information. Inspect the harness help for selectors and the exact response contract. Supply a real native runner for the selected client; the harness does not implement platform authentication or fabricate model activity.

The harness re-executes acceptance tests and checks protected inputs. Review-artifact presence establishes recorded separation, not review quality. Imported observations retain their reported-data provenance. Unknown cost, quota, or model observations remain unavailable.

Compare acceptance rate, elapsed time, retries, escalations, escaped defects, human correction effort, and observed cost/quota. Alpha.3.2 enables the user-selected strict Luna/max strategic policy with medium-effort Luna/Terra workers. Claim cost/time improvements for a task category only when measured quality is preserved and efficiency improves. Three repetitions per group provide a pilot comparison, not a general optimization guarantee. The historical eighteen-trial matrix remains incomplete until actual results replace pending entries.

## Stable release blockers

Before calling v1 stable:

1. Resolve all required automated checks and verify installation from the actual packaged tarball.
2. Record conformance for the intended Codex, Claude Code, and Copilot client surfaces/versions: instructions/skills, agents, effective model observations, MCP, hooks, hook-disabled gates, and new-session resumption.
3. Complete both engineering pilots with traceability, current evidence/review, and qualified lessons.
4. Record the 18 native evaluation trials, their unavailable observations, and reviewed conclusions before claiming demonstrated routing savings.
5. Validate the pinned optional CodeGraph artifact before claiming its Windows/C/C++/freshness support. Its disabled descriptor alone is insufficient.
6. Review generated knowledge contribution material and exercise the upstream human-review process.
7. Verify npm package-name availability, release credentials, licensing, and publication authorization immediately before publishing.

Unavailable authenticated clients or runners are external verification gaps. Keep the corresponding capabilities unverified and the package prerelease until the required evidence exists. The V-model/ASPICE mapping remains workflow guidance; a formal capability assessment needs the official process outcomes and competent assessment.

Alpha.3 acceptance also requires batch traceability, stale/rerouted receipt rejection, applicable tool failures, frozen expectation mutation rejection, Cornell source/artifact freshness, repeatable recipes with multiple parameters, private archive recovery/concurrency/immutability, and restoration preserving fingerprints/evidence. An actual authenticated native demonstration is required for the routing claim; protocol fixtures and generated files cannot establish account/model access.

## Publication and maintenance

Normal use starts with one natural-language requirement. The native manager operates record management and publication internally. `manager_finish` applies the saved `.verythinker/automation.json` policy to independently reviewed generalized candidates and creates **draft PRs** automatically when enabled. It requires authenticated `gh` write access to the configured upstream and never merges. Human approval applies to merging shared knowledge. Publication failures remain specific persisted blockers; corrected candidates require a preserved retirement/replacement rationale.

Private project increments use a stable namespace with append-only checkpoint branches, a fast-forward accepted baseline, and immutable SemVer release branches beginning at `1.0.0`. Project release numbers are separate from the npm alpha version. Freeze source records, implementation, verification inputs, and locks before publication; retain transport receipts outside the snapshot to avoid circular hashes. Required sensitive material or a non-private archive target blocks export. Generalized shared-library PRs retain their separate review boundary.

For explicit administrative use, `memory contribute KNOWLEDGE_ID` prepares generalized material locally, and `memory contribute KNOWLEDGE_ID --upstream OWNER/REPO` submits it. Inspect public content before sharing. Per-candidate locks and saved operation identity support concurrent callers and retry recovery. Mock GitHub transactions verify these mechanics; they do not by themselves establish a live upstream contribution.

Publish only the reviewed artifact under an approved prerelease tag, then verify that consumers install that artifact and its resources. Registry access, npm name availability, and a publish command are separate from local packaging. CI does not publish automatically.

Template upgrades preserve user edits and expose conflicts for review. Compatibility claims identify their tested client/version. Pack changes require a new version when content changes; update project locks through a recorded decision. Keep historical evidence and knowledge provenance when baselines change.

VeryThinker retains MIT licensing and independently authored code/templates. Trellis is design inspiration under its own AGPL license; its code/templates are not included. Record any later third-party reuse and compatible attribution explicitly.
