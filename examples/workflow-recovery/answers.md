# Exercise answers: recover the right verification scope

1. **The bootstrap deliverable check and shared interface integration check.** The child task's execution set contains its directly assigned child requirement and the active design that satisfies that child requirement. The two final-outcome checks verify only the parent, so they are not eligible for the child task.
2. **The parent has three applicable checks.** Its execution set contains the parent requirement and the shared design that satisfies it. That produces two checks linked directly to the parent plus the check linked to the shared design.
3. **Applicability and provenance answer different questions.** The parent is in the child's requirement ancestry, so `verificationScope` includes the parent in the evidence baseline. The fingerprint records which parent outcome the evidence was based on, without making the child task run every parent check.
4. **The observed finding is `missing-valid-evidence`.** Its detail says that a record requires reassessment. The old evidence no longer matches the current parent fingerprint; rerun the relevant check and reassess the child work against the changed basis before relying on it.
5. **Do not claim native execution, permission confirmation, independent review, task submission, acceptance, or publication.** The practice creates legacy-format records in a disposable local project and runs simple local commands. Its output is evidence only for the exercised applicability, fingerprint capture, and staleness mechanics.

## Actual practice result

One execution on 2026-10-13 printed:

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

The script asserts the counts, captured parent fingerprint, and reassessment finding before it prints this summary. It does not print generated keys, secrets, or native receipt identifiers.
