# Local validation of 0.1.0-alpha.2

Observed on **2026-10-11**, Windows x64, Node.js **24.18.0**, npm **12.0.2**. The package is a local prerelease. Source hashes in the saved evidence identify the tested inputs, including working-tree changes at verification time. No npm publication is claimed. Remote Windows and Ubuntu checks also passed at commit `aebdb5cb39910ca617800834bc66424c973e58eb`; see the recorded run below.

## Automated engineering and adapter checks

`npm test` passed **89 tests**, with no failures or skips. Coverage includes:

- Stable IDs after rename/deletion, schema validation, duplicate IDs, broken/invalid links, and dependency cycles.
- SQLite/FTS5 refresh/rebuild, bounded serialized context, three-worker limits, interrupted task recovery, dead/live writer locks, and one repair before escalation.
- Current requirements/design/source baselines, independent reviews, added source files, newer failed checks/reviews, tampered/unreadable/missing logs and mismatched receipts.
- Evidence archiving, new-process resumption, public/private knowledge boundaries, exact pack versions/binary assets, reviewed pack upgrades, and draft-PR retry recovery.
- Existing instruction/configuration preservation, JSONC comments, alternate TOML layouts, user edits/deletions, conflict candidates, role/model metadata, and locally executed generated hook commands.
- Actual MCP stdio initialization, tool discovery, record mutation, gate invocation, software/embedded workflow fixtures, pilot checks, and evaluation harness integrity.
- Automatic manager instruction routing on all adapters, idempotent intake, current specialist contributions, decision/allocation baselines, mandatory substantive documentation, closure, publication blockers, and preserved replacement-plan history.
- Former implementer exclusion after handoff and repair reassignment, intermediate derived requirement changes, documentation/work-record mutation, and rejection of closure when inputs change during publication.
- Two competing publication processes creating one branch/PR through a mock API, stable publication identity before mutations, lost-response recovery, and explicit candidate retirement with preserved publication history.

Review identities in automated fixtures establish gate behavior; they do not measure engineering review quality or authenticate a human reviewer. Owner identity is a recorded engineering assertion, rather than an access-control service.

## Installed npm artifact

`npm run package:smoke` builds a tarball and installs it into a fresh temporary project. It checks resource resolution, generation for all three platforms, preservation of existing instructions, an actual check, evidence archive, fixture review/acceptance, interrupted and new-process resumption, index rebuild, user-edit preservation, and MCP discovery/invocation from the installed package. The alpha.2 procedure additionally invokes all five manager operations through the installed stdio MCP server, checks specialist decision fixtures, required documentation, handoff, missing-review rejection, closure/report idempotency, and persisted resumption. The resulting smoke report records the observed result and exact artifact hash.

The local deliverable is `artifacts/verythinker-0.1.0-alpha.2.tgz`. The smoke report in `artifacts/package-smoke.json` records its SHA-256 and verification environment. The installed-package smoke passed. The package excludes generated Python bytecode and object files. [CI run 38116332997](https://github.com/VuThach3001/VeryThinker/actions/runs/38116332997) passed tests, packaging, and installed-package lifecycle/MCP checks on both Windows and Ubuntu at the recorded commit. An earlier Windows run exposed a CRLF-sensitive test assertion; that assertion was corrected before this successful run.

NeoLearning was upgraded from alpha.1 to alpha.2. The upgrade installed six new managed resources and updated 59 managed resources with **zero conflicts**. Project instructions and unrelated dirty work were preserved. `doctor` reported the three adapters configured, the manager and automatic draft PR policy enabled, and no warnings. Native discovery/routing/MCP/hook capabilities remain unverified; a configured adapter is not an observed native session.

## Pilot and optional-provider measurements

- [Pilot evidence](../examples/verification.json) records software behavior/persistence, embedded normal/fault cases, the actual ngspice 46 simulation, and RISC-V GCC 14.2.0 compilation with warnings treated as errors. The installed Digital Mars 8.42n compiler also built and executed the C firmware harness: **8,215 comparisons** against the JavaScript reference model passed, covering ADC/prior-state combinations, fault/calibration boundaries, and sequential recovery/hysteresis. This is host execution and simulation evidence; embedded acceptance is limited to the demonstrated environments.
- [CodeGraph evidence](validation/codegraph-report.json) records all **12 passing** checks for `@colbymchenry/codegraph@1.6.2` on a small Windows C/C++ fixture, including cross-file callers, edit/add/delete sync, MCP, reconnect and live-watch freshness. The optional integration defaults to disabled; explicit enablement validates and hash-locks the report. Its native-client invocation remains unverified.
- A fresh invocation of the finish skill correctly rejected stale evidence and missing independent review, preserved unavailable model observations, and declined to claim measured tiered-routing benefits. Its ambiguous gate wording was tightened to `verify --gate accepted` followed by `task accept`.

## Native evaluation and remaining release gates

[Recorded native observations](evaluation-results.json) contain rejected model probes and one failed software trial. The installed Codex client/account rejected `gpt-6.1-sol` and `gpt-6-luna`. A configured Astra availability probe succeeded, but the implementation trial's read commands were rejected with `blocked by policy`; no implementation or independent review completed. The report records observed token usage and leaves backend model identity, price and quota consumption unavailable.

**Seventeen planned trials remain unrecorded.** Native skill discovery, effective model routing, configured MCP and lifecycle hook invocation still need client conformance. The execution policy was not disabled or bypassed. This environmental failure does not establish the model's engineering ability or compare routing efficiency.

Automated draft-PR tests use mock GitHub transactions, including concurrent publication, retry recovery and privacy. Those tests alone do not establish a live upstream submission or human approval. Physical hardware/HIL, board ratings, thermal/EMC/timing, power-loss durability, formal ASPICE assessment, authenticated client conformance and npm publication are outside the demonstrated evidence. These boundaries remain [stable release criteria](release.md).

## Observed draft PR delivery

[Implementation PR #1](https://github.com/VuThach3001/VeryThinker/pull/1) contains the engineering package and autonomous native manager. [Knowledge PR #2](https://github.com/VuThach3001/VeryThinker/pull/2) was created through the actual contribution publisher after a separate agent reviewed the generalized lesson, applicability, limitations, privacy, and finalized provenance. It contains only the versioned pack manifest and lesson. Retrying the publisher returned the same branch and PR; neither proposal was merged.

The shared repository is private. These PRs and the lesson's immutable implementation source require repository access. The lesson records that restriction and does not claim anonymous source accessibility. This live publisher check establishes authenticated draft creation and persisted retry recovery, not autonomous native-client execution or human merge approval.

[CAMEL research](camel-research.md) records the inspected source snapshot and coordination mechanisms adopted independently. No CAMEL Python runtime, source, or prompts are bundled. Native clients remain responsible for actual delegation; deterministic manager tests prove core policy/gate behavior rather than model decision quality.
