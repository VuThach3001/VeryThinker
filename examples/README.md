# VeryThinker pilots

The software and embedded directories contain independently runnable implementations, requirements, interfaces, and named checks. `verification.json` captures actual checks with exact source hashes. The evidence includes local ngspice simulation, C cross-compilation, and C host execution against the behavioral model when those tools are supplied; its limitations remain explicit.

## Generate legacy core-mechanics fixtures

These scripts are explicitly **legacy policy fixtures** for learning and testing persistence, traceability, collected evidence, and review gates. They do not install native adapters or alpha.3 routing, authenticate a model, or demonstrate an autonomous engineering increment. Script-authored invocation identities are rejected by installed alpha.3 projects.

After building the npm package, run:

```sh
node examples/workflow.mjs software ./artifacts/software-workflow
node examples/workflow.mjs embedded ./artifacts/embedded-workflow
```

Use new or empty output directories. Existing content is preserved. Each command copies the example, initializes a legacy core project and baseline knowledge pack, creates requirements/design/task/check records, executes the checks, collects logs and receipts, records the submission, and creates a generalized lesson candidate. `workflow-report.json` labels `execution_mode: "legacy-policy-fixture"` and contains record IDs, gates, a context packet, reverse traceability, and review commands.

Generation stops at submission. A real reviewer must inspect design, interfaces, implementation, check coverage, and evidence before approving records. The generated review commands show how to record that decision; they do not establish that a review happened. After reviews pass, use `task accept`. Review the lesson separately before `memory contribute` prepares a knowledge-pack and PR proposal. Human approval and an actual upstream PR are still required for sharing.

Raw check logs and receipts remain in the generated project's `.verythinker/runs`. Keep them when moving the working project; verification correctly rejects missing evidence. No model request or confirmation is invented for the script-driven run.

For production alpha.3 work, install VeryThinker into your own project and give its manager a requirement. The managed native workflow requires confirmed Sol planning/review and Luna or permitted Terra execution; a fixture report or manually entered identity cannot replace those receipts. See [native runtime](../docs/native-runtime.md).

## Agent evaluation

See `docs/evaluation.md` for the 18-trial matrix and native-runner contract. The harness builds fresh implementation tasks from these requirements rather than benchmarking the completed examples. Model availability probes are recorded in `native-model-probes.json`; they are not benchmark trials.
