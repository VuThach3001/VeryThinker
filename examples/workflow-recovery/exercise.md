# Exercise: recover the right verification scope

## Goal

Use a disposable legacy project to distinguish checks that apply to a bootstrap task from records it retains as provenance. Then observe how a parent change affects old evidence.

## Before you run it

1. Read the `requirementScope`, `verificationScope`, and `executionScope` implementations in [`src/engineering.ts`](../../src/engineering.ts#L307).
2. Read stale-record validation and baseline capture in [`src/engineering.ts`](../../src/engineering.ts#L488).
3. In the practice script, identify the parent requirement, child requirement, shared design, four checks, and child task. Predict the applicable-check counts for the child and parent.
4. Predict whether the child evidence should contain a fingerprint for the parent, and what should happen after the parent acceptance criterion changes.

## Run

From the repository root:

```powershell
node examples/workflow-recovery/practice.mjs
```

The script creates and removes a fresh temporary legacy project. It checks its assertions before printing a compact result. If it fails, preserve the failure output and use the questions below to locate the broken relationship; do not edit the repository's existing project records or erase authored solutions.

## Questions

1. Which two checks are eligible for the child task, and why?
2. Why do three checks apply to the parent requirement?
3. Why is the parent requirement fingerprint included even though the parent's direct final checks do not apply to the bootstrap task?
4. What finding appears after the parent changes, and what does that finding require the workflow to do?
5. Which conclusions would exceed the evidence provided by this legacy mechanical demonstration?
