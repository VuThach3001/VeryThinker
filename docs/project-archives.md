# Project archives

An archive preserves project engineering history in a confirmed private upstream repository. It contains the workflow's traceability closure, reviewed implementation inputs, records, evidence, public native receipt verification keys, and locked knowledge packs. Generalized knowledge proposals remain a separate reviewed contribution workflow.

## Identity and releases

The installer creates project-owned `.verythinker/archive.json`. Legacy projects without this policy retain their previous behavior. The initial namespace uses the project directory name and stable project ID; it is persisted and survives directory renaming. New policies use the user-authorized private upstream `VuThach3001/VeryThinker-Project-Archives`; updates preserve existing configured destinations and namespaces. Other repository owners must configure an accessible private destination. The manager checks current private visibility before preparing a new accepted publication intent, using the read-only destination preflight. Publication checks visibility again before creating blobs. A public, inaccessible, or uninitialized target is a recorded publication blocker.

Branches have these forms:

```text
codex/projects/<name>-<project-id>/baseline
codex/projects/<name>-<project-id>/increments/<increment-id>
codex/projects/<name>-<project-id>/releases/1.0.0
```

Working checkpoints append commits to an increment branch. Accepted snapshots advance the baseline through a fast-forward update, create an immutable release branch, and freeze the increment reference. The initial release is `1.0.0`; a reviewed `breaking-change`, `feature`, or `fix` advances major, minor, or patch respectively. These are project releases, independent of the VeryThinker npm package version.

## Frozen snapshot

Local preparation writes `.verythinker/archives/<snapshot-id>/manifest.json`, a manifest identity, and a workspace containing original relative paths. Repository publication places the workspace under `projects/<project-id>/workspace/`, retains each manifest under `projects/<project-id>/manifests/`, and updates the project's current manifest.

Markdown record bytes, stable IDs, revisions, and semantic fingerprints remain unchanged. The manifest identifies file hashes, byte lengths, executable modes, source commit, captured archive baseline, changed/deleted membership, omissions, and reproduction steps. Files referenced by evidence and current documentation reviews are included. Prior accepted files and relevant historical records remain in subsequent snapshots when still present; removed files receive explicit deletion entries. Older releases preserve the original files for assessing their historical evidence.

The snapshot includes project configuration, knowledge-pack contents and lockfiles, applicable recipe/tool locks, signed native receipt artifacts and their public trust keys. Tool installations, private signing keys, raw sessions, caches, derived SQL indexes, credentials, unrelated active records, and operation locks are excluded. Raw run evidence must be archived into persistent evidence storage before export. Every exported file receives a sensitive-content check; a detected credential blocks preparation without rewriting the source or its fingerprints.

Checks capture immutable input versions before execution under `.verythinker/evidence/inputs/`. Content-addressed blobs preserve exact implementation bytes, engineering records and check oracles, project configuration, locked pack content, pinned tool dependency locks, and applicable protected recipe inputs. The evidence receipt binds the snapshot manifest hash. Failed and repaired checks therefore retain different source versions even when a file is later deleted. The archive manifest maps each evidence ID to its original input snapshot; restoration preserves these artifacts alongside the current workspace. Active acceptance still requires fresh evidence matching the current inputs.

Capture is bounded to 32 MiB per artifact and 128 MiB or 4096 artifacts per invocation. Private runtime keys, raw sessions, recursive input-store capture, and caches are excluded. Native client configuration receives a hash observation rather than an automatic raw copy; external runtimes must be reprovisioned using recorded versions. Export checks original source paths and contents as well as blob identities, so a deleted `.env` file cannot bypass exclusions through a hash-named blob.

Historical evidence without a snapshot is recovered against its exact original file hashes and engineering fingerprints from current matching content, immutable stored versions, or verified cached archive workspaces. Recovery creates derived input metadata without changing the original evidence record. A missing original version blocks export with its evidence ID, source path or record ID, and required digest. Historical execution details that were never recorded remain limited to the original environment and tool observations; recovery does not fabricate them.

Symbolic links are rejected. Submodule commit identities are recorded; required submodule source must be reproduced as a reviewed export outside the submodule path. Direct in-place submodule export and remote submodule hydration are unsupported. Additional `source_paths` can only select already reviewed outputs or evidence inputs. A broad source directory is not an invitation to upload unrelated work.

Carried historical implementation and input files must retain their captured hashes unless the current increment explicitly covers them through reviewed source, evidence inputs, or assigned change scope. Substantive changes to historical engineering records outside the increment's traceability closure block export as well. Separate active increments sharing a requirement do not become archive members through their reviews or work records. A blocker preserves the unrelated local work and requires scoped reassessment; the exporter does not silently publish it.

## Validation and recovery

An accepted snapshot requires resolved questions, a current manager requirement decision, and passing acceptance gates for every assigned task. Strict alpha.3 workflows also require a signed receipt proving the Sol manager completed its invocation, and substantive seven-section assignment reports for every completed nonmanager native invocation. Preparation and publication enforce these conditions directly, including when called outside the manager's finish operation. Publication rechecks those gates and frozen source hashes before remote creation and immediately before advancing the baseline. Changes require a new snapshot and applicable reassessment.

Publication intent and stage receipts are stored outside the frozen workspace. Blob identities, tree identity, fixed commit attribution/date, commit identity, and reference stages are persisted. Retries reuse the same immutable content, including after a successful GitHub response is lost. The baseline is advanced before the release is exposed. Publication recovers a commit already at, or already included in, the current baseline without rewinding it. A conflicting release or moved baseline blocks continuation and requires internal reassessment. Existing references are updated with `force: false`.

### Reassess an unpublished intent

Use `reassessArchive` when the captured baseline or source inputs changed and repeating the old snapshot would remain invalid. It requires a currently independently reviewed change linked to the workflow, with `archive_snapshot_id` naming the pending snapshot and `reason` matching the requested substantive explanation. This prevents a generic approval from retiring another operation.

The operation confirms private upstream visibility and reads baseline, release, increment, and applicable ancestry. An accepted commit already included in the baseline, a frozen release/increment, or accepted publication history prevents retirement. No remote reference is forced or deleted.

A narrow recovery exception handles a snapshot prepared for a public destination before the manager's preflight was available. The original destination must still match the frozen manifest. A current independent change review is required, `publication.json` must be absent, and the remote project baseline, release, and increment references must all be absent. Any publication receipt or project reference blocks this exception. The operation preserves the frozen snapshot and report ID while retiring the never-started pointer; only afterward can the project policy select a private destination for fresh preparation. It never uploads project content to the public repository or retargets existing publication history.

For an unpublished intent, an immutable reassessment receipt preserves the original snapshot, publication state, review identity, reason, and observed baseline. The active pointer is cleared while retaining its manager report ID. Fresh preparation still requires current requirements, task acceptance, checks, and independent reviews; the reassessment operation does not waive those gates. Repeated calls recover the same receipt.

When the baseline advanced to a verified completed same-project snapshot already cached locally, the operation reconciles the project baseline and release metadata. Unchanged inputs must still match that known snapshot. A reviewed change may identify `affected_paths` within assigned task scope and `affected_records` within the workflow closure; those intentional divergences require fresh affected verification before completion. Unknown remote baselines or unreviewed local differences preserve the current intent and record a precise integration/revalidation blocker. Remote archive hydration is not implemented by this operation.

Restore accepts a verified local snapshot and a new empty destination outside the source project. It checks manifest identity, exact file membership, hashes, record IDs, revisions, and fingerprints. Existing user content is never overwritten. A completed accepted publication additionally restores its frozen snapshot cache and writes a separate derived restoration receipt. Policy reads and doctor use that verified receipt to recover the published baseline/version while preserving the original frozen record and configuration bytes. A later publication advances normal project policy and supersedes that overlay. A moved remote baseline still requires reassessment. Rebuild the derived index, provision the recorded runtime and tools, and reassess evidence when the execution environment differs. Local restore does not fetch arbitrary remote branches; obtain a trusted archive checkout or recover the local prepared snapshot first.

Content scanning catches explicit credential patterns; it is not a comprehensive data classification service. Independent review must inspect the task's evidence, outputs, and applicability before acceptance. Native receipt identity verifies the observed client interaction; archived public keys do not provide an external trust authority.

## Core interfaces

- `ensureArchivePolicy` installs missing project-owned policy; `readArchivePolicy` reports its absence for legacy projects.
- `assertPrivateArchiveDestination` checks current private visibility without preparing a snapshot or writing publication state.
- `prepareArchive` creates a working or accepted snapshot from one workflow.
- `publishArchive` publishes the frozen snapshot with persisted stage recovery.
- `archiveStatus` reports snapshots and publication status.
- `restoreArchive` validates and restores a prepared snapshot into a new empty directory.
- `reassessArchive` retires only a reviewed, demonstrably unpublished intent and reconciles a known cached baseline; accepted references and historical snapshots remain frozen.

CLI and MCP adapters call these same operations. The manager performs routine preparation and publication internally and reports a precise blocker if credentials, private visibility, trust, or acceptance conditions are missing.
