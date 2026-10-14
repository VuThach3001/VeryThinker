# Continuation recovery

When a user sends new input during a live manager invocation, intake saves it as a pending continuation. The saved message is durable history; it is not proof that the manager incorporated it. A prior workflow may also contain an obsolete instruction to update `data.applied_continuation_ids` with `record_update`; the current core rejects that field through the generic update API.

Resume the existing workflow and read `pending_continuations` from `manager_status`. Incorporate each message into the work, reassess affected requirements, design, decisions, and checks, and record the reassessment in the applicable decision or other authoritative records. Then call the signed manager-only operation:

```text
manager_apply_continuations({
  workflow_id,
  continuation_ids: ["<exact pending ID>"],
  rationale: "<what was incorporated and reassessed>",
  source_ids: ["<inspected decision or reassessment record ID>"]
})
```

The operation derives the caller from the signed bound manager receipt. It accepts explicit active pending IDs only, applies them all-or-nothing, and returns `applied_continuation_ids`, `pending_continuations`, `disposition_id`, and `revision`. Repeating the same application is idempotent and does not churn the revision. Messages arriving later remain pending and need their own incorporation and application. `manager_acknowledge` establishes invocation binding only; it does not apply messages. The CLI equivalent is `workflow apply-continuations <workflowId> --data JSON`, with `invocation_id` included in the JSON.

For example, if message `C-12` asks to support a second input format, first update the relevant requirement/design and reassess affected checks. Apply `C-12` with the inspected reassessment record as a source. If `C-13` arrives during that work, leave it pending and handle it in its own reassessment. Never mark every pending message applied as a recovery shortcut. Continuation disposition does not satisfy or weaken implementation evidence, independent review, or acceptance gates.

Expected outcomes remain distinct from observed outcomes: expect exactly the addressed, incorporated IDs to move to applied while other messages remain pending; observe the operation's returned applied/pending IDs, disposition ID, and revision. Preserve the disposition reference with the workflow record. If exact IDs or required reassessment sources are unavailable, preserve pending state and report the concrete blocker.
