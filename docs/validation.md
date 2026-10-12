# Alpha.3 validation

## Intake hotfix: 0.1.0-alpha.3.1

The original installed alpha.3 MCP server reproduced the reported failure with a populated `requirement` and an unused empty `requirements` array: it returned "Provide requirement or requirements, rather than both" and created no records. Its published schema marked the fields optional but did not allow null placeholders. Strict client normalization can therefore expose a conflicting contract even though the original MCP schema does not require both fields.

The hotfix makes intake options nullable, explains the mutually exclusive meaningful inputs, and normalizes unused null, blank-string and empty-array placeholders in the shared core. New intake, legacy intake and managed resumption use the same rule. Two meaningful inputs, malformed/empty batches, and changed resumption requirements remain errors. Request-ID retries preserve the existing workflow.

Four focused intake regression tests passed; the surrounding manager, managed-routing and MCP-binding run passed 31 tests with no failures or skips. These tests exercised actual published MCP schemas and calls without native model inference. The following alpha.3 results remain historical observations, not a claim that the complete suite or authenticated workflow was rerun for this hotfix.

Validation was performed on Windows x64 with Node.js 24.18.0 and npm 12.0.2. Source and input hashes in the individual reports identify the tested working-tree inputs. The alpha.2 report is preserved separately in [historical validation](validation/alpha2.md); its results do not establish alpha.3 behavior.

## Engineering and boundary checks

The automated suite exercises stable record IDs, SQLite/FTS5 rebuilds, typed links, batch requirement coverage, dependencies, bounded context, interrupted work, evidence applicability, independent review, and documentation gates. Alpha.3 adds:

- Native model acknowledgment, completed inference, signed receipt integrity, reroute rejection, interruption/resumption, bounded waiting, ownership, unavailable-model fallback, and permission blockers.
- Strict source authorship and planning review before worker dispatch, current receipt requirements, repeated-repair Sol reassessment, migration of pending work, and preservation of historical acceptance.
- Invocation-bound role and task scope, approved pinned providers, isolated installs, transitive lock integrity, missing capabilities, and explicit optional substitutions.
- Exact project snapshot bytes, historical verification inputs, binary/deleted files, immutable references, publication recovery, concurrent baseline movement, sensitive-content blockers, and restoration.
- Cornell structure, sources, freshness, runnable practice, preservation of authored solutions, protected recipe inputs, independent expected values, reviewed replacements, workflow binding, and loaded-generator identity.
- Installer preservation of existing configuration, authored overrides, conflicts, managed resource updates, and checks that remain effective without hooks.
- Scoped Developer file writes with confirmed native capability, reviewed scope, expected hashes, immutable previous bytes, protected artifact rejection, and incomplete-history gate blockers. See the [editing contract](workspace.md).
- Rubric-based inspection evidence with exact source fingerprints, immutable captured inputs, bounded record projections, and independent semantic review. See the [inspection contract](inspection.md).

Protocol simulations and locally fabricated validation objects used by boundary tests establish rejection and gate mechanics. They do not authenticate an account or perform model inference. Production-injected transports remain labelled `protocol-fixture` and cannot authorize strict acceptance.

The final broad local run passed **224 tests**, without failures or skips, in 353.47 seconds at source commit `c6619118f84e3ca5499afe24e9b362fb3453d3b5`. Its log is `artifacts/alpha3-tests-workspace-inspection-final.txt`; [structured local observations](validation/local-alpha3-report.json) preserve the result. Earlier 201-test and 181-test runs remain historical observations. The final suite includes scoped file-edit recovery, inspection evidence, and bounded record projections.

The live workflow exposed repeated YAML parsing during record lookup. [Storage observations](validation/storage-alpha3-report.json) record a bounded process-local parse cache that still enumerates files, reads and compares exact bytes, checks configuration and duplicate IDs, and returns independent data. On an unchanged 126-record Windows corpus, a prototype reduced median warm lookup from 754 ms to 509 ms, with variance. The delivered count bound is 1,024 entries with a 32 MiB retained-payload bound; freshness, caller mutation, invalid input, and eviction receive regression checks. Fresh disk reads remain a cost, and these primitive timings do not establish whole-workflow or model-cost savings.

## Authenticated native execution

[Native model observations](validation/native-alpha3-report.json) record actual completed requirements and review invocations using `gpt-6.1-sol`, and a bounded developer invocation using `gpt-6-luna`, through the pinned Codex 0.162.1 App Server. Native model/provider acknowledgments, thread/turn identities, completion, and limitations are recorded. There were no fallback or reroute observations in that access demonstration.

The [managed increment report](validation/native-alpha3-managed-report.json) separately records the longer engineering demonstration, including its actual completion state, interruptions, failed gates, and specialist results. Read `increment_acceptance_demonstrated` before treating this run as accepted. Account access alone is insufficient to claim a completed increment, automatic archive publication, or measured routing efficiency.

After the user reported signing in, the last managed coordinator invocation acknowledged `gpt-6.1-sol` but failed with an account usage-limit response before successful inference. The report is frozen with acceptance and publication false. No later inference attempt is claimed after the stated reset time. The added scoped editing and inspection operations pass boundary tests; their use by a completed authenticated worker remains unverified. Operator interventions and source changes mean the demonstration does not establish unassisted completion.

The [ordinary-request run](validation/native-alpha3-final-report.json) generated configuration and Cornell artifacts and executed a passing preliminary Luna check, but remained unaccepted when Windows native editing failed. Missing supplemental verification, submission, and final review remain explicit. Its controller-triggered extra resumption and interruption are recorded separately from model behavior. This run started before the final Cornell fixes; initial and later source hashes remain distinct.

[Read-only runtime diagnosis](validation/native-alpha3-windows-runtime.json) correlated the Windows failure with OS error 32 during native sandbox ACL refresh on an existing Node REPL executable. Installed helpers were present. No global configuration, permissions, setup state, or user process was changed. Scoped MCP execution and generic native shell/edit compatibility are separate observations.

The native acknowledgment reports the client's selected model; it is not independent backend attestation. Local receipt signatures detect accidental or unauthorized changes within the documented local boundary. They do not defend against a process with unrestricted access to the project and private signing cache. Native permission refusals remain blockers; the bridge never grants a pending approval on the user's behalf.

## Providers and engineering pilots

[Provider observations](validation/tools-alpha3-report.json) record pinned package integrity, actual discovery, availability, and invocation results. CodeGraph Windows C/C++ analysis and freshness were exercised. Context7 performed an actual library lookup without an API key; returned source suitability still needs review. Playwright tool discovery was observed; browser execution is unverified. Exact URL checks cover explicit navigation only; actions and redirects inherit the provider/client network permissions.

[Current pilot evidence](validation/pilots-alpha3-report.json) records twelve passing JavaScript checks, ngspice 46 DC simulation, RISC-V GCC 14.2.0 compilation, and **8,215** executed firmware/reference comparisons using Digital Mars. Source hashes identify the inputs. The embedded demonstration uses ideal circuit simulation and host execution; it does not establish MCU execution, physical board performance, HIL, thermal/EMC behavior, timing, or power-loss durability.

## Packaged installation and consumer upgrade

The local deliverable is `artifacts/verythinker-0.1.0-alpha.3.tgz`. Installed-package smoke verifies resource resolution, all three generated adapters, twelve roles, three recipes, MCP discovery/invocation, strict missing-receipt rejection, and preservation of user edits. A separate explicitly labelled legacy-policy fixture exercises the complete record lifecycle and new-process resumption. The legacy fixture does not establish native model execution.

The smoke report records the exact final tarball hash. Consumer migration preserves authored model/configuration changes as reviewable conflicts and keeps accepted legacy evidence attached to its original baseline. Existing running MCP processes retain the previously loaded package until their owning client reloads them.

[Windows and Ubuntu CI](https://github.com/VuThach3001/VeryThinker/actions/runs/38156198458) passed dependency installation, the full 224-test suite, package inspection/build, and installed-package smoke at source commit `c6619118f84e3ca5499afe24e9b362fb3453d3b5`. Windows passed 223 tests with one optional host-C check skipped; Ubuntu passed 220 with the Windows file-lock and three Windows CodeGraph checks skipped. There were no failures. [Structured CI observations](validation/ci-alpha3-report.json) preserve those limits and the preceding source run. An earlier Windows failure exposed the returned-versus-persisted body mismatch; storage now returns canonical persisted bodies, with a regression test covering CRLF and missing terminal newlines. The live workflow exposed opaque Cornell input discovery and draft-repair gaps; typed fields, rejection before file creation, learner scaffolds, immutable revision history, and interruption recovery now have focused regression coverage. Local packaging is not npm registry publication.

## Remaining compatibility and evaluation boundaries

Strict execution targets the demonstrated Codex App Server surface first. Claude Code and Copilot resources are generated, but exact Sol/Luna/Terra execution remains restricted until independently verified on those clients. Generated skill/hook files do not establish native picker discovery or hook trust. Core acceptance checks remain mandatory when hooks are disabled.

The eighteen comparative agent trials remain incomplete. Alpha.3 implements the user-selected routing policy; it does not claim demonstrated cost/time savings or a general quality advantage over one strong agent. The V-model and Automotive SPICE mapping are workflow guidance, not a capability rating or formal assessment.

Shared knowledge produces reviewed draft PRs with human merge approval. Private project archives preserve project records and reproducible inputs separately. No automatic merge, public project disclosure, or registry publication is claimed.

The user-authorized archive destination, `VuThach3001/VeryThinker-Project-Archives`, was created and independently queried as private, with an initialized `main` branch. New installations use this target; existing configured destinations remain preserved. Repository setup alone does not establish accepted snapshot publication: the native reports retain their actual publication state.
