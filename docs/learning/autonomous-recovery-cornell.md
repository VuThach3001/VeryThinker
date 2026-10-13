# Autonomous workflow recovery: applicability scope and evidence provenance

<p align="center"><strong><em>"DO NOT JUST TALK ABOUT IT — SHOW IT"</em></strong></p>

**Topic:** Separating a bootstrap task's executable checks from its parent requirement's final checks while retaining ancestor provenance.  
**Context date:** 2026-10-13.  
**Source retrieval:** Local source and built-module inspection in the recovery-fix checkout on 2026-10-13.  
**Boundary:** This note describes the legacy mechanical project path demonstrated by the standalone practice. It does not establish native invocation, strict managed-task, review, acceptance, or publication behavior.

| Cue / question                                      | Main notes                                                                                                                                                                                                                                                                                                         |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| What are the two scopes for?                        | `executionScope` selects records whose checks and local gates apply to the current assignment. `verificationScope` selects traceability records whose fingerprints must stay current for evidence. These answer different questions.                                                                               |
| What does a child task inherit for execution?       | A task linked to a child requirement executes against that child requirement and any active design that satisfies it. The function validates the requirement ancestry but does not add parent requirements to this execution set. A check that verifies only the parent is therefore excluded from the child task. |
| How can a shared-interface check still apply?       | An active design linked as satisfying the child requirement is included in the child execution set. A check verifying that design is eligible, even when the same design also satisfies the parent.                                                                                                                |
| What is retained from the parent?                   | Evidence provenance uses `verificationScope`, which includes requirement ancestry and designs satisfying those requirements. The evidence record captures their fingerprints, including the parent requirement's fingerprint.                                                                                      |
| What happens after the parent changes?              | Evidence validation compares captured record fingerprints with current records. A changed parent produces a reassessment finding, so prior evidence cannot silently stand in for a decision against the updated outcome.                                                                                           |
| Why not make the child task run every parent check? | Parent final-outcome checks belong to work that owns that outcome. Pulling them into a bootstrap task would make the child appear responsible for acceptance of the entire parent outcome. Provenance still retains the parent so the child evidence becomes stale when its basis changes.                         |
| What does the practice prove?                       | It creates a disposable project, links a child requirement to a parent, defines two parent checks, one child check, and a shared-interface check, then runs only the two checks applicable to the child task. It changes the parent and confirms that the old child evidence is no longer valid.                   |
| What does it not prove?                             | It is a legacy mechanical demonstration using local records and executable checks. It does not use a native worker, demonstrate required tool permissions, create a separately reviewed plan, or satisfy task acceptance.                                                                                          |

## Demonstration

Run from the repository root with Node.js:

```powershell
node examples/workflow-recovery/practice.mjs
```

The program creates one temporary legacy project under the operating system's temporary directory. It validates the intended cleanup path before recursively removing only that generated directory. It does not touch the user's project records or authored solution files.

Observed output from one execution on 2026-10-13:

```json
{
  "mode": "legacy-mechanical-demonstration",
  "checks": {
    "total": 4,
    "bootstrapTask": 2,
    "finalRequirement": 3
  },
  "provenance": {
    "parentFingerprintCaptured": true,
    "parentChangeInvalidatesOldEvidence": true
  },
  "finding": "missing-valid-evidence"
}
```

The counts mean that the child task receives the direct child check and the shared-interface check. The parent has two direct final-outcome checks plus that shared-interface check. After the parent criterion changes, `verify(..., 'verified')` reports stale evidence for the child task. The demonstration asserts these results; it prints counts and booleans rather than generated record keys.

## Failure cases to recognize

- If a parent-only final check appears in the child's applicable set, inspect which record the check verifies and which requirements/designs are actually in `executionScope`.
- If the shared-interface check disappears, inspect whether its design is active and linked to satisfy the child's requirement. A design linked only to the parent does not enter the child's execution scope.
- If old evidence remains valid after an ancestor change, inspect whether the evidence captured the ancestor fingerprint and whether evidence validation compares that captured value with the current record.
- Do not respond to stale evidence by deleting the parent link, weakening fingerprint validation, or describing old results as fresh. Reassess and rerun the evidence against the changed basis.
- A passing local command is not native-managed acceptance. Keep execution evidence, independent review, native lifecycle observations, and acceptance claims distinct.

## Summary

Keep execution applicability narrow enough to match the assigned child work, include shared interfaces that the child actually uses, and retain the parent as fingerprinted provenance. That combination excludes parent-final checks from bootstrap execution while ensuring an ancestor change invalidates evidence collected under the earlier parent outcome.

## Sources and provenance

| Provenance   | Source and locator                                                                                                                                        | Use                                                                                                                      |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| **Observed** | [`src/engineering.ts` — `requirementScope` and `executionScope`](../../src/engineering.ts#L307)                                                           | Requirement ancestry validation and the direct requirement/design execution set.                                         |
| **Observed** | [`src/engineering.ts` — `verificationScope` and `executionScope`](../../src/engineering.ts#L452)                                                          | Parent ancestry and associated designs retained as verification provenance while execution applicability stays narrower. |
| **Observed** | [`src/engineering.ts` — stale-record validation](../../src/engineering.ts#L488) and [baseline capture](../../src/engineering.ts#L1690)                    | Fingerprint capture and comparison that marks evidence requiring reassessment after a record changes.                    |
| **Observed** | [`src/engineering.ts` — `verify`](../../src/engineering.ts#L892) and [`runCheck`](../../src/engineering.ts#L1626)                                         | Applicable-check selection, evidence validation, and the check execution entry point.                                    |
| **Observed** | [`src/storage.ts` — initializer](../../src/storage.ts#L121), [record creation](../../src/storage.ts#L425), and [record update](../../src/storage.ts#L494) | The project and record APIs used by the practice.                                                                        |
| **Observed** | [`examples/workflow-recovery/practice.mjs`](../../examples/workflow-recovery/practice.mjs)                                                                | Runnable demonstration, assertions, and path-checked cleanup.                                                            |
| **Observed** | [`examples/workflow-recovery/exercise.md`](../../examples/workflow-recovery/exercise.md) and [`answers.md`](../../examples/workflow-recovery/answers.md)  | Separate practice prompts and worked answers.                                                                            |

Source locators refer to the source observed on the context date; no claim is made about a later build or native-runtime state. The expected behavior was independently exercised by running the practice once against the checkout's then-current `dist` modules. The design rationale above is an **inference** from the separation of these two scopes and the observed stale-evidence result.
