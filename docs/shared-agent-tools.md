# Shared agent access and review diagnostics

<p align="center"><strong><em>"DO NOT JUST TALK ABOUT IT — SHOW IT"</em></strong></p>

## Objective

Enable each engineering role to read, edit assigned artifacts, and use project-approved tools without replacing engineering validation with unrestricted record mutation.

## Inputs and Sources

The user's October 14, 2026 request identifies unnecessary agent restrictions and confusing review/workflow errors. Implementation builds on alpha.3.4. `tools.ts`, native/adapters, workspace authorization and MCP handlers together determine usable access. The installed development checkout and release runtime can differ; inspect the actual runtime before diagnosing a historical review.

## Decisions and Rationale

| Cue                                            | Main notes                                                                                                                                |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| What is core?                                  | The software rules and authoritative records, not an additional person.                                                                   |
| What is shared?                                | Read/search, scoped documentation/file operations, review diagnostics, and project-approved provider resolution/invocation.               |
| What authorizes an edit?                       | The current assigned role and signed invocation, a reviewed task, allowed paths, current hashes and unchanged protected inputs.           |
| What preserves review?                         | A separate invocation reviews the current artifacts. A reviewer inspecting another producer's task receives read-only native access.      |
| Why can a review exist but fail applicability? | Its target, dependency baseline, decision, findings or native observations differ from current inputs. Historical passes remain readable. |
| How is acknowledgment updated?                 | The manager binds its own confirmed same-workflow invocation through a dedicated operation; acceptance remains separate.                  |

## Results

All twelve roles share the basic tool surface while retaining specialized engineering responsibilities. Exact Luna/max and Luna/medium routing, including observed-unavailability Terra fallback, remains unchanged. Generic record editing does not create evidence, review decisions, submissions or acceptance. The agent guide is `resources/guides/agent-tools.md`.

## Evidence

Regression tests cover role capabilities, assigned-role writes, stale hashes and protected paths, review-currentness diagnostics, and same-workflow manager acknowledgment. Release test results are recorded with the delivery artifact; protocol fixtures demonstrate guards rather than authenticated model execution.

## Limitations

Native workspace writing itself is broader than a task's allowed paths. The core gateway enforces those paths; direct native editing additionally depends on client permissions and assignment instructions. Existing stale reviews do not become current simply because tools are exposed. Model/provider access still requires real native observations.

## Lessons and Practice

Demonstration: assign a researcher-owned documentation task, read its current file hash, and edit through `task_file_write`. Inspect a design with `record_review_status`, change its contract through the responsible author, and observe the earlier review become stale. Obtain a fresh separate review before acceptance.

Practice: repeat with an out-of-scope path, stale hash or protected expectation and confirm rejection. Keep the original failed attempts and expected criteria unchanged. These are practice instructions; actual executed tests are identified separately in the release report.
