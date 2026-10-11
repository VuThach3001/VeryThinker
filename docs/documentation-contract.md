# Task documentation contract

Autonomous manager assignments set `data.documentation_required: true` and record their `workflow_id`. They may declare `documentation_paths`, an array of project-relative files or nonempty directories. These paths identify documentation deliverables alongside implementation outputs. A task without the flag retains the legacy submission behavior.

`submitTask(root, id, summary, workRecordBody?)` accepts the worker's actual work record. A flagged task must supply substantive content under exactly one heading for each section:

1. Objective
2. Inputs and Sources
3. Decisions and Rationale
4. Results
5. Evidence
6. Limitations
7. Lessons

Headings may use Markdown levels one through six and optional numeric prefixes. Each section needs at least four words and 24 non-whitespace characters. Empty sections, explicit placeholders, completion-only phrases, bundled or installed template paragraphs, and the previous generic generated pointers are rejected before task status changes. These mechanical checks reject scaffolding; the independent reviewer still assesses factual accuracy, coverage, and evidence sufficiency. A concrete explanation of why no reusable lesson exists belongs in Lessons. Unavailable model observations and unverified claims belong in Limitations.

Submission creates one knowledge record with `kind: work-record`, owned by the assigned worker. Its only relationship documents the target task. It records the task baseline, workflow, worker invocation, submission identity, and submission time. Supplied content is preserved with the storage layer's normal line-ending and surrounding-whitespace normalization. The task submission stores the work-record ID and fingerprint, its task fingerprint, and a snapshot of declared documentation files. Documentation paths must exist, contain files, and stay inside the project. They cannot include managed record files; those records have their own fingerprints, and including them in file snapshots would create a recursive baseline.

The accepted gate requires the current owned work record, correct target and invocation, current task fingerprint, latest submitted work-record hash, and matching documentation file snapshots. Reusing an earlier work record, changing its body or ownership, changing a documentation file, adding a file inside a declared documentation directory, or deleting documentation requires reassessment. The current work record and actual documentation snapshots also form part of the independent review baseline. Passing code checks can remain valid after a documentation change while task acceptance and its previous review become invalid.

To amend submitted documentation, record repair feedback, restart the assignment, supply the corrected complete body when submitting again, and obtain a new independent review. A restarted invocation changes the task baseline; rerun any checks whose recorded task baseline is no longer current. Historical work records and evidence remain available. A passing review cannot be recorded for a flagged task with invalid or stale submitted documentation. Reviews still require a separate owner and invocation, current requirements/design/implementation/evidence, and no open findings. The actual model observation being unavailable does not itself block engineering acceptance.

`resumeTask(root, id, requestedModel?, confirmedModel?, invocationId?)` retains an in-progress record when the invocation argument is omitted or matches the recorded invocation. A distinct nonblank invocation records the new active worker, keeps prior invocation IDs and a resume timestamp, and clears the old confirmed model unless a current observation is supplied. Blocked resumes pass the actual invocation to task startup. The changed task fingerprint requires fresh evidence for the new invocation. Before a handoff, the manager must stop the previous native worker or transfer ownership; the core does not control running workers. Runtime invocation identities are recorded assertions, not authentication of a platform session or proof that two workers are independent.

Replanned tasks remain as `superseded` historical records with their evidence and reviews. Global completeness assesses tasks that have not been superseded. Explicit verification of a superseded task still reports that it is not a submitted or accepted current assignment.

Validation runs before record creation, and a final locked task-update precondition checks task state, baseline, and documentation snapshots again. If another writer changes inputs between record creation and the final update, submission fails and leaves the task unsubmitted; its newly written work record can be inspected as a checkpoint. This is not an atomic transaction spanning multiple records. A matching snapshot establishes integrity, not truth or review quality.

Context packets include declared documentation paths among required outputs, the seven section names, the workflow ID, and the current submitted work-record ID. Legacy tasks still receive a generated work record when no body is supplied; an explicitly supplied legacy body is honored without imposing the new seven-section requirement. Newly submitted legacy work records are bound to their review, while older submissions without a work-record reference remain compatible.
