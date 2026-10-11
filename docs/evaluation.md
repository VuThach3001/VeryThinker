# Pilot verification and agent evaluation

Automated pilot verification and agent evaluation are separate measurements. Passing the shipped examples proves their tested behavior on the recorded revision. It does not prove that an agent configuration implemented them successfully or economically.

## Current evidence

`examples/verification.json` records actual pilot and workflow-fixture test output, runtime, exact source hashes, optional ngspice operating points, optional C cross-compilation, and optional native C host execution compared against the JavaScript controller. Fixture review records validate the gate mechanics; they are explicitly separate from actual engineering review. Regenerate the snapshot after changing sources or templates:

```sh
node examples/verify.mjs --output examples/verification.json
```

Optional `--ngspice-library <path>`, `--python <executable>`, `--compiler <cross-gcc-executable>`, and `--host-compiler <host-compiler-executable>` enable locally installed tools. Missing tools are recorded as unavailable. The SPICE check uses an ideal DC switch model. C cross-compilation checks buildability, while host execution compares 8,215 cases with the behavioral model: 8,192 exhaustive ADC/prior-state pairs, 14 representative fault/calibration cases, and nine sequence samples. Neither establishes MCU execution or physical hardware behavior. The recorded local tools were ngspice 46, RISC-V GCC 14.2.0, and Digital Mars Compiler 8.42n; exact source and executable hashes are retained in evidence.

## Native agent experiment

The matrix contains two pilots, three configurations, and three trials each: 18 trials. Configurations are `strong-single`, `same-model-workers`, and `tiered-workers`. All use the same requirements and protected acceptance tests. A separate reviewer invocation is required in every configuration.

```sh
node scripts/evaluate.mjs matrix
node scripts/evaluate.mjs run --runner node --runner-args-json '["/absolute/path/to/native-runner.mjs"]' --platform codex --output .verythinker/cache/evaluation/trials.jsonl
node scripts/evaluate.mjs summarize --input .verythinker/cache/evaluation/trials.jsonl
```

The matrix command lists planned trials and marks them `not-run`. It never creates successful observations. The run command needs an explicitly supplied wrapper for a native platform; it does not add an API orchestrator or claim access to paid/free models. Use an absolute executable/script path so trial workspace changes do not alter command resolution. Arguments are passed directly without a shell.

The harness creates a fresh workspace for each trial, copies requirements and tests, and replaces the implementation with stubs. For embedded trials it also removes the completed C implementation. It sends the task packet on stdin, saves runner stdout/stderr, and independently executes the protected tests afterward. Editing requirements or tests fails the trial. It retains workspaces and logs for investigation. Rerunning skips already recorded trial IDs; use a new output file for a fresh experiment.

Optional `--pilot`, `--configuration`, and `--trial` selectors allow individual observations. `--timeout-ms` defaults to 30 minutes per invocation. The wrapper is responsible for enforcing the requested model/worker configuration and returning observed telemetry. The harness cannot verify a model identity that the platform does not expose.

## Runner result contract

The runner reads one task packet and emits one JSON object on stdout. Diagnostic output belongs on stderr. Its JSON fields are:

| Field                  | Contract                                                                                                                                                                   |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `implementation_actor` | Identity of the implementation invocation.                                                                                                                                 |
| `review`               | `{status, actor, artifact}`; actor differs from implementation actor and artifact refers to a nonempty review file inside the trial workspace.                             |
| `requested_models`     | Requested model IDs, or `"unavailable"`.                                                                                                                                   |
| `confirmed_models`     | Model IDs confirmed by platform telemetry, or `"unavailable"`; do not copy requested IDs when confirmation is absent.                                                      |
| `metrics`              | Nonnegative `retries`, `escalations`, `escaped_defects`, `human_correction_minutes`, `cost_amount`, `quota_consumed`, and `cost_currency`; use null for unobserved values. |
| `evidence`             | References to actual run artifacts and observations.                                                                                                                       |

`accepted` requires a successful runner result, passing unchanged tests, and a recorded separate review. Passing tests with missing review is `unverified`; failed runner/checks or modified protected inputs are `failed`. Presence of a separate review artifact verifies documentation of separation, not review quality. Firmware/hardware evidence outside the supplied behavioral tests requires explicit review and source-linked artifacts.

Elapsed time is measured by the harness. Other metrics come from observations supplied by the wrapper. Missing data stays unavailable; no missing cost, defect count, or correction effort is substituted with zero. Cost medians require one recorded currency. Quota consumption must use a consistent unit within one experiment; the generic scalar is not comparable across different providers.

## Imported observations

```sh
node scripts/evaluate.mjs import --input actual-native-trials.jsonl --output .verythinker/cache/evaluation/trials.jsonl
```

Imported JSONL follows the trial schema produced by `run`: schema version 1, a matrix trial ID, matching pilot/configuration/trial, status, elapsed time, provenance, metrics, and artifact references. Imports are marked `imported-record`, preserve original provenance, and reject duplicate trial IDs. These are reported observations, not independently authenticated telemetry. Keep the referenced logs, source revision, model observations, and review artifacts with them.

Summary output includes recorded and missing trials, counts for accepted/failed/unverified outcomes, and medians with observation counts. A partial matrix remains visibly partial. Compare routing only after reviewing errors, escaped defects, human effort, and acceptance quality. Two small pilots with three trials each provide feasibility evidence; they cannot establish a universal optimal multi-agent architecture.

## Evidence status

The implementation includes a runnable experiment harness. Actual native availability probes were executed on 2026-10-11 with installed `codex-cli 0.153.4`; both requested models, `gpt-6.1-sol` and `gpt-6-luna`, were rejected by the backend with HTTP 400 and the message that the model is not supported when using Codex with this ChatGPT account. `examples/native-model-probes.json` preserves the commands and diagnostics. No alternate model was silently substituted.

The [official model documentation](https://learn.chatgpt.com/docs/models) describes platform support, while these local observations establish the installed client's actual result. They do not establish the cause or availability in another client. The requested strong/economy mapping was unavailable through this CLI. A further probe of the configured default `gpt-6-astra` succeeded, so one bounded software `strong-single` trial was attempted with Astra explicitly requested. It failed because native command execution was rejected by policy before the agent could read requirements or modify the implementation. The protected acceptance tests then failed against the unchanged stubs. Actual logs and the failed trial are retained under `artifacts/evaluation`; a complete comparison remains unavailable.

`examples/native-codex-runner.mjs` supplies a minimal native wrapper for `strong-single`. It uses separate implementation and review invocations and does not substitute models. Supply `--strong-model <available-model-id>` as a runner argument. The other configurations require a wrapper that demonstrably uses the platform's native subagents; this wrapper rejects those requests explicitly. No actual native LLM trial results have been fabricated. Tiered routing remains a configurable candidate until recorded comparisons demonstrate preserved quality and lower cost or shorter completion time.

`docs/evaluation-results.json` is the public summary: three availability probes, one failed native trial, 17 unrecorded trials, actual observed token usage, and explicit remediation. Local machine paths and raw configuration are excluded. A permission failure cannot establish model capability or routing quality. Resolve permitted native read/write/check execution before retrying; do not bypass execution policy to obtain a passing benchmark.
