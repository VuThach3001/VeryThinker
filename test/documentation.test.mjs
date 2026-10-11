import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  acceptTask,
  contextPacket,
  createRecord,
  getRecord,
  hasCurrentReview,
  initialize,
  loadRecords,
  requestRepair,
  requirementScope,
  resourceRoot,
  resumeTask,
  reviewRecord,
  reviewTask,
  runCheck,
  startTask,
  submitTask,
  updateRecord,
  verify,
} from '../dist/index.js';

function assignment(t, required = true, documentationPaths = ['docs/configuration.md']) {
  const root = mkdtempSync(join(tmpdir(), 'verythinker-documentation-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  initialize(root, { project_id: 'DOC', profile: 'software' });
  mkdirSync(join(root, 'src'));
  mkdirSync(join(root, 'docs'));
  writeFileSync(join(root, 'src/value.mjs'), 'export const value = 1;\n');
  writeFileSync(join(root, 'docs/configuration.md'), '# Configuration\nThe module exports one.\n');
  const requirement = createRecord(root, {
    type: 'requirement',
    title: 'Persistent configuration value',
    owner: 'requirements',
    data: { acceptance_criteria: ['The exported value equals one.'] },
    body: 'The exported configuration value is the integer one.',
  });
  const design = createRecord(root, {
    type: 'design',
    title: 'Configuration module interface',
    owner: 'architect',
    links: [{ type: 'satisfies', target: requirement.meta.id }],
    data: { interfaces: ['The value export contains the integer one.'] },
    body: 'The configuration module exposes a named numeric value export.',
  });
  reviewRecord(root, requirement.meta.id, 'reviewer', 'pass', [], 'requirements-review');
  reviewRecord(root, design.meta.id, 'reviewer', 'pass', [], 'design-review');
  const task = createRecord(root, {
    type: 'task',
    title: 'Deliver the configuration module',
    owner: 'developer',
    links: [{ type: 'satisfies', target: requirement.meta.id }],
    data: {
      acceptance_criteria: ['The module exports one and its interface is documented.'],
      allowed_paths: ['src', 'docs'],
      outputs: ['src/value.mjs'],
      ...(required
        ? {
            documentation_required: true,
            workflow_id: 'DOC-WORKFLOW-1',
            documentation_paths: documentationPaths,
          }
        : {}),
    },
    body: 'Implement and document the numeric configuration export.',
  });
  const check = createRecord(root, {
    type: 'check',
    title: 'Check the configuration export',
    owner: 'verifier',
    links: [{ type: 'verifies', target: requirement.meta.id }],
    data: {
      command: [
        process.execPath,
        '--input-type=module',
        '-e',
        'import { value } from "./src/value.mjs"; if (value !== 1) process.exit(1);',
      ],
      baseline_paths: ['src'],
      method: 'unit',
    },
    body: 'Load the module and compare its exported number with one.',
  });
  startTask(root, task.meta.id, 'requested', undefined, 'developer-invocation-1');
  const evidence = runCheck(root, check.meta.id, task.meta.id);
  return { root, task, requirement, design, check, evidence };
}

function workRecord(work) {
  return `# Objective
Developer delivered ${work.task.meta.id} for workflow DOC-WORKFLOW-1 with its configuration interface.

# Inputs and Sources
Inspected ${work.requirement.meta.id}, ${work.design.meta.id}, src/value.mjs, and the current Node execution environment.

# Decisions and Rationale
Kept one named numeric export because the requirement needs no configuration parser or runtime dependencies.

# Results
The module exports integer one and docs/configuration.md describes the public interface and expected value.

# Evidence
Check ${work.check.meta.id} passed as ${work.evidence.meta.id}; its execution log records the current source and environment.

# Limitations
The actual model observation is unavailable; the module check covers only the required numeric export.

# Lessons
For fixed numeric exports, a direct module assertion supplies evidence without adding a testing framework.
`;
}

function submit(work, body = workRecord(work)) {
  return submitTask(
    work.root,
    work.task.meta.id,
    'Delivered and checked the documented export.',
    body,
  );
}

function review(work, invocation = 'independent-task-review') {
  return reviewTask(work.root, work.task.meta.id, 'reviewer', 'pass', [], invocation);
}

test('required work records reject missing sections and empty prose before any mutation', (t) => {
  const work = assignment(t);
  const count = loadRecords(work.root).length;
  assert.throws(
    () => submitTask(work.root, work.task.meta.id, 'The implementation is complete.'),
    /seven-section work record/,
  );
  assert.throws(() => submit(work, workRecord(work).replace(/# Lessons\n[\s\S]*$/, '')), /Lessons/);
  const empty = [
    'Objective',
    'Inputs and Sources',
    'Decisions and Rationale',
    'Results',
    'Evidence',
    'Limitations',
    'Lessons',
  ]
    .map((section) => `# ${section}\nDone.\n`)
    .join('\n');
  assert.throws(() => submit(work, empty), /substantive content/);
  assert.equal(getRecord(work.root, work.task.meta.id).meta.status, 'in-progress');
  assert.equal(loadRecords(work.root).length, count);
});

test('both current bundled and installed template scaffolding are rejected', (t) => {
  const work = assignment(t);
  const template = readFileSync(join(resourceRoot, 'templates/work-record.md'), 'utf8');
  assert.throws(() => submit(work, template), /template scaffolding/);
  mkdirSync(join(work.root, '.verythinker/templates'));
  const placeholder =
    'Replace this paragraph with assignment-specific measurements and supporting execution log references.';
  writeFileSync(
    join(work.root, '.verythinker/templates/work-record.md'),
    `# Evidence\n${placeholder}\n`,
  );
  const body = workRecord(work).replace(
    /(# Evidence\n)[\s\S]*?(\n# Limitations)/,
    `$1${placeholder}\n$2`,
  );
  assert.throws(() => submit(work, body), /Evidence.*template scaffolding/);
  assert.equal(getRecord(work.root, work.task.meta.id).meta.status, 'in-progress');
});

test('submission preserves one owned linked work record and acceptance uses a separate current review', (t) => {
  const work = assignment(t);
  const body = workRecord(work);
  const submitted = submit(work, body);
  const record = getRecord(work.root, submitted.meta.data.submission.work_record_id);
  assert.equal(record.body, body);
  assert.equal(record.meta.owner, 'developer');
  assert.equal(record.meta.data.kind, 'work-record');
  assert.equal(record.meta.data.invocation_id, 'developer-invocation-1');
  assert.deepEqual(record.meta.links, [{ type: 'documents', target: work.task.meta.id }]);
  assert.equal(
    submitted.meta.data.submission.documentation_snapshot['docs/configuration.md'].length,
    64,
  );
  assert.equal(verify(work.root, work.task.meta.id, 'accepted').ok, false);
  assert.throws(
    () =>
      reviewTask(work.root, work.task.meta.id, 'reviewer', 'pass', [], 'developer-invocation-1'),
    /different owner and invocation/,
  );
  review(work);
  assert.equal(verify(work.root, work.task.meta.id, 'accepted').ok, true);
  assert.equal(acceptTask(work.root, work.task.meta.id).meta.status, 'accepted');
});

test('changed work-record bodies invalidate submission and review without invalidating code evidence', (t) => {
  const work = assignment(t);
  const submitted = submit(work);
  review(work);
  const amended = workRecord(work).replace(
    'no configuration parser',
    'no runtime configuration parser',
  );
  updateRecord(work.root, submitted.meta.data.submission.work_record_id, {}, amended);
  assert.equal(verify(work.root, work.task.meta.id, 'verified').ok, true);
  assert.equal(hasCurrentReview(work.root, work.task.meta.id), false);
  assert.equal(verify(work.root, work.task.meta.id, 'accepted').ok, false);
  assert.throws(() => review(work, 'premature-review'), /latest submitted documentation/);
  requestRepair(
    work.root,
    work.task.meta.id,
    'Resubmit the amended rationale with current evidence.',
  );
  startTask(work.root, work.task.meta.id, 'requested', undefined, 'developer-invocation-2');
  work.evidence = runCheck(work.root, work.check.meta.id, work.task.meta.id);
  const resubmitted = submit(work, amended);
  assert.notEqual(
    resubmitted.meta.data.submission.work_record_id,
    submitted.meta.data.submission.work_record_id,
  );
  assert.equal(verify(work.root, work.task.meta.id, 'accepted').ok, false);
  review(work, 'review-after-resubmission');
  assert.equal(acceptTask(work.root, work.task.meta.id).meta.status, 'accepted');
});

test('changed or missing documentation files invalidate submission and independent review', (t) => {
  const work = assignment(t);
  submit(work);
  review(work);
  writeFileSync(
    join(work.root, 'docs/configuration.md'),
    '# Configuration\nThe interface now also describes deployment.\n',
  );
  assert.equal(verify(work.root, work.task.meta.id, 'verified').ok, true);
  assert.equal(hasCurrentReview(work.root, work.task.meta.id), false);
  assert.throws(() => review(work, 'stale-document-review'), /Documentation files changed/);
  const report = verify(work.root, work.task.meta.id, 'accepted');
  assert.ok(report.findings.some((finding) => /Documentation files changed/.test(finding.message)));
  rmSync(join(work.root, 'docs/configuration.md'));
  assert.equal(verify(work.root, work.task.meta.id, 'accepted').ok, false);
});

test('missing documentation and recursive managed-record paths cannot be submitted', (t) => {
  const work = assignment(t);
  rmSync(join(work.root, 'docs/configuration.md'));
  assert.throws(() => submit(work), /Baseline input does not exist/);
  assert.equal(getRecord(work.root, work.task.meta.id).meta.status, 'in-progress');
  updateRecord(work.root, work.task.meta.id, {
    data: { documentation_paths: ['.verythinker/records'] },
  });
  assert.throws(() => submit(work), /cannot include managed records/);
  updateRecord(work.root, work.task.meta.id, {
    data: { documentation_paths: ['docs/../.verythinker/records'] },
  });
  assert.throws(() => submit(work), /cannot include managed records/);
  assert.equal(getRecord(work.root, work.task.meta.id).meta.status, 'in-progress');
});

test('an earlier work record cannot be reused for a later submission', (t) => {
  const work = assignment(t);
  const first = submit(work);
  requestRepair(
    work.root,
    work.task.meta.id,
    'Clarify the public interface rationale in documentation.',
  );
  startTask(work.root, work.task.meta.id, 'requested', undefined, 'developer-invocation-2');
  work.evidence = runCheck(work.root, work.check.meta.id, work.task.meta.id);
  const second = submit(work);
  const prior = first.meta.data.submission;
  updateRecord(work.root, work.task.meta.id, {
    data: {
      submission: {
        ...second.meta.data.submission,
        work_record_id: prior.work_record_id,
        work_record_fingerprint: prior.work_record_fingerprint,
      },
    },
  });
  const report = verify(work.root, work.task.meta.id, 'accepted');
  assert.ok(report.findings.some((finding) => /older work record/.test(finding.message)));
  assert.ok(report.findings.some((finding) => /task invocation/.test(finding.message)));
  assert.throws(() => review(work), /older work record/);
});

test('context explicitly supplies required documentation paths, sections, and work-record output', (t) => {
  const work = assignment(t);
  const packet = contextPacket(work.root, work.task.meta.id);
  assert.equal(packet.documentation.required, true);
  assert.equal(packet.documentation.sections.length, 7);
  assert.deepEqual(packet.documentation.paths, ['docs/configuration.md']);
  assert.ok(packet.outputs.includes('docs/configuration.md'));
  assert.ok(packet.outputs.some((output) => /seven-section knowledge work record/.test(output)));
});

test('legacy submission remains compatible and explicitly supplied legacy content is preserved', (t) => {
  const work = assignment(t, false);
  const submitted = submitTask(work.root, work.task.meta.id, 'Delivered the configuration export.');
  const generated = getRecord(work.root, submitted.meta.data.submission.work_record_id);
  assert.ok(generated.body.includes('# Lessons'));
  review(work);
  assert.equal(acceptTask(work.root, work.task.meta.id).meta.status, 'accepted');
  const second = assignment(t, false);
  const supplied =
    'Detailed legacy observations are preserved without requiring the new section contract.\n';
  const result = submitTask(second.root, second.task.meta.id, 'Delivered the export.', supplied);
  assert.equal(getRecord(second.root, result.meta.data.submission.work_record_id).body, supplied);
  review(second);
  assert.equal(acceptTask(second.root, second.task.meta.id).meta.status, 'accepted');
});

test('a distinct resume invocation records the handoff and invalidates prior task evidence', (t) => {
  const work = assignment(t);
  updateRecord(work.root, work.task.meta.id, {
    data: { confirmed_model: 'previous-observed-model' },
  });
  assert.equal(verify(work.root, work.task.meta.id, 'verified').ok, true);
  const resumed = resumeTask(work.root, work.task.meta.id, undefined, undefined, 'native-worker-2');
  assert.equal(resumed.meta.data.invocation_id, 'native-worker-2');
  assert.equal(resumed.meta.data.requested_model, 'requested');
  assert.equal(resumed.meta.data.confirmed_model, null);
  assert.deepEqual(resumed.meta.data.prior_invocation_ids, ['developer-invocation-1']);
  assert.ok(Number.isFinite(Date.parse(resumed.meta.data.resumed_at)));
  assert.equal(verify(work.root, work.task.meta.id, 'verified').ok, false);
  assert.equal(getRecord(work.root, work.evidence.meta.id).meta.data.result, 'pass');
  work.evidence = runCheck(work.root, work.check.meta.id, work.task.meta.id);
  assert.equal(verify(work.root, work.task.meta.id, 'verified').ok, true);
  const next = resumeTask(
    work.root,
    work.task.meta.id,
    'new-request',
    'new-observation',
    'native-worker-3',
  );
  assert.equal(next.meta.data.requested_model, 'new-request');
  assert.equal(next.meta.data.confirmed_model, 'new-observation');
  assert.deepEqual(next.meta.data.prior_invocation_ids, [
    'developer-invocation-1',
    'native-worker-2',
  ]);
});

test('legacy or matching-identity resumes preserve the in-progress task record', (t) => {
  const work = assignment(t, false);
  const original = getRecord(work.root, work.task.meta.id);
  const legacy = resumeTask(work.root, work.task.meta.id);
  assert.deepEqual(legacy, original);
  const matching = resumeTask(
    work.root,
    work.task.meta.id,
    'different-request',
    'different-observation',
    'developer-invocation-1',
  );
  assert.deepEqual(matching, original);
  const withoutIdentity = updateRecord(work.root, work.task.meta.id, {
    data: { invocation_id: null },
  });
  assert.deepEqual(resumeTask(work.root, work.task.meta.id), withoutIdentity);
});

test('blocked resumes forward the actual invocation and clear the previous model confirmation', (t) => {
  const work = assignment(t);
  updateRecord(work.root, work.task.meta.id, {
    status: 'blocked',
    data: {
      blocked_reason: 'The previous native worker was interrupted.',
      confirmed_model: 'old-observation',
    },
  });
  const resumed = resumeTask(
    work.root,
    work.task.meta.id,
    'resumed-request',
    undefined,
    'blocked-worker-2',
  );
  assert.equal(resumed.meta.status, 'in-progress');
  assert.equal(resumed.meta.data.invocation_id, 'blocked-worker-2');
  assert.equal(resumed.meta.data.requested_model, 'resumed-request');
  assert.equal(resumed.meta.data.confirmed_model, null);
  assert.deepEqual(resumed.meta.data.prior_invocation_ids, ['developer-invocation-1']);
  assert.ok(Number.isFinite(Date.parse(resumed.meta.data.resumed_at)));
});

test('explicit blank resume invocation identities are rejected before mutation', (t) => {
  const work = assignment(t);
  const active = getRecord(work.root, work.task.meta.id);
  for (const invocation of ['', ' ', '\t\n'])
    assert.throws(
      () => resumeTask(work.root, work.task.meta.id, undefined, undefined, invocation),
      /non-empty invocation identity/,
    );
  assert.deepEqual(getRecord(work.root, work.task.meta.id), active);
  const blocked = updateRecord(work.root, work.task.meta.id, { status: 'blocked' });
  assert.throws(
    () => resumeTask(work.root, work.task.meta.id, undefined, undefined, ' '),
    /non-empty invocation identity/,
  );
  assert.deepEqual(getRecord(work.root, work.task.meta.id), blocked);
});

test('global completeness excludes superseded tasks while explicit verification still rejects them', (t) => {
  const work = assignment(t, false);
  updateRecord(work.root, work.task.meta.id, { status: 'superseded' });
  const active = createRecord(work.root, {
    type: 'task',
    title: 'Current configuration assignment',
    owner: 'developer',
    links: work.task.meta.links,
    data: work.task.meta.data,
    body: 'Deliver the current documented configuration export.',
  });
  startTask(work.root, active.meta.id, 'requested', undefined, 'current-worker');
  runCheck(work.root, work.check.meta.id, active.meta.id);
  submitTask(work.root, active.meta.id, 'Delivered the current configuration export.');
  reviewTask(work.root, active.meta.id, 'reviewer', 'pass', [], 'current-review');
  acceptTask(work.root, active.meta.id);
  assert.equal(verify(work.root).ok, true);
  const historical = verify(work.root, work.task.meta.id, 'accepted');
  assert.equal(historical.ok, false);
  assert.ok(historical.findings.some((finding) => finding.code === 'not-submitted'));
  assert.equal(getRecord(work.root, work.evidence.meta.id).meta.data.result, 'pass');
});

test('a former implementation invocation cannot review the task after handing off to another worker', (t) => {
  const work = assignment(t);
  const originalInvocation = 'developer-invocation-1';
  resumeTask(work.root, work.task.meta.id, undefined, undefined, 'replacement-worker');
  work.evidence = runCheck(work.root, work.check.meta.id, work.task.meta.id);
  submit(work);
  assert.throws(
    () => reviewTask(work.root, work.task.meta.id, 'reviewer', 'pass', [], originalInvocation),
    /different owner and invocation/,
  );
  assert.throws(
    () => reviewRecord(work.root, work.task.meta.id, 'reviewer', 'pass', [], originalInvocation),
    /different owner and invocation/,
  );
  const independent = review(work, 'separate-reviewer');
  assert.equal(hasCurrentReview(work.root, work.task.meta.id), true);
  // Imported or amended review records must pass the same invocation-history gate.
  updateRecord(work.root, independent.meta.id, { data: { invocation_id: originalInvocation } });
  assert.equal(hasCurrentReview(work.root, work.task.meta.id), false);
  assert.equal(verify(work.root, work.task.meta.id, 'accepted').ok, false);
  review(work, 'another-separate-reviewer');
  assert.equal(acceptTask(work.root, work.task.meta.id).meta.status, 'accepted');
});

test('repair reassignment preserves the former implementer and prevents that invocation from reviewing', (t) => {
  const work = assignment(t);
  submit(work);
  requestRepair(
    work.root,
    work.task.meta.id,
    'A separate worker must clarify the submitted rationale.',
  );
  const restarted = startTask(
    work.root,
    work.task.meta.id,
    'repair-model',
    undefined,
    'repair-worker',
  );
  assert.deepEqual(restarted.meta.data.prior_invocation_ids, ['developer-invocation-1']);
  work.evidence = runCheck(work.root, work.check.meta.id, work.task.meta.id);
  submit(work);
  assert.throws(() => review(work, 'developer-invocation-1'), /different owner and invocation/);
  review(work, 'independent-repair-review');
  assert.equal(acceptTask(work.root, work.task.meta.id).meta.status, 'accepted');
});

test('multi-hop requirement ancestry is baselined and parent criteria or links invalidate evidence', (t) => {
  const work = assignment(t);
  const stakeholder = createRecord(work.root, {
    type: 'requirement',
    title: 'Documented application defaults',
    owner: 'requirements',
    data: { acceptance_criteria: ['Application defaults match their public documentation.'] },
    body: 'The application supplies documented defaults to downstream modules.',
  });
  const parent = createRecord(work.root, {
    type: 'requirement',
    title: 'Documented configuration defaults',
    owner: 'requirements',
    links: [{ type: 'derives-from', target: stakeholder.meta.id }],
    data: { acceptance_criteria: ['The configuration default is explicitly documented.'] },
    body: 'Configuration defaults derive from the documented application defaults.',
  });
  const unrelated = createRecord(work.root, {
    type: 'requirement',
    title: 'Unrelated rendering colors',
    data: { acceptance_criteria: ['The rendering theme uses its configured colors.'] },
  });
  updateRecord(work.root, work.requirement.meta.id, {
    links: [{ type: 'derives-from', target: parent.meta.id }],
  });
  assert.deepEqual(requirementScope(loadRecords(work.root), [work.requirement.meta.id]), [
    work.requirement.meta.id,
    parent.meta.id,
    stakeholder.meta.id,
  ]);
  reviewRecord(work.root, work.design.meta.id, 'reviewer', 'pass', [], 'ancestry-design-review');
  work.evidence = runCheck(work.root, work.check.meta.id, work.task.meta.id);
  for (const id of [work.requirement.meta.id, parent.meta.id, stakeholder.meta.id])
    assert.equal(typeof work.evidence.meta.data.record_baseline[id], 'string');
  assert.equal(work.evidence.meta.data.record_baseline[unrelated.meta.id], undefined);
  const packet = contextPacket(work.root, work.task.meta.id);
  assert.equal(typeof packet.baseline.record_fingerprints[stakeholder.meta.id], 'string');
  submit(work);
  review(work, 'ancestry-task-review');
  assert.equal(verify(work.root, work.task.meta.id, 'accepted').ok, true);
  updateRecord(work.root, stakeholder.meta.id, {
    data: {
      acceptance_criteria: ['Application defaults include their documented selection rationale.'],
    },
  });
  const changedCriteria = verify(work.root, work.task.meta.id, 'verified');
  assert.equal(changedCriteria.ok, false);
  assert.ok(
    changedCriteria.findings.some(
      (finding) =>
        finding.code === 'missing-valid-evidence' && finding.message.includes(stakeholder.meta.id),
    ),
  );
  assert.equal(hasCurrentReview(work.root, work.design.meta.id), false);
  assert.equal(hasCurrentReview(work.root, work.task.meta.id), false);
  reviewRecord(
    work.root,
    work.design.meta.id,
    'reviewer',
    'pass',
    [],
    'reassessed-ancestor-design',
  );
  work.evidence = runCheck(work.root, work.check.meta.id, work.task.meta.id);
  assert.equal(verify(work.root, work.task.meta.id, 'verified').ok, true);
  const newAncestor = createRecord(work.root, {
    type: 'requirement',
    title: 'Product configuration policy',
    data: { acceptance_criteria: ['Product configuration defaults follow recorded user needs.'] },
  });
  updateRecord(work.root, stakeholder.meta.id, {
    links: [{ type: 'derives-from', target: newAncestor.meta.id }],
  });
  const changedLinks = verify(work.root, work.task.meta.id, 'verified');
  assert.equal(changedLinks.ok, false);
  assert.ok(
    changedLinks.findings.some(
      (finding) =>
        finding.code === 'missing-valid-evidence' &&
        finding.message.includes(`Evidence baseline omits required record: ${newAncestor.meta.id}`),
    ),
  );
  assert.equal(getRecord(work.root, work.evidence.meta.id).meta.data.result, 'pass');
});

test('requirement ancestry rejects missing targets, non-requirements, and cycles without collecting evidence', (t) => {
  const work = assignment(t, false);
  const notRequirement = createRecord(work.root, {
    type: 'knowledge',
    title: 'A project observation',
  });
  updateRecord(work.root, work.requirement.meta.id, {
    links: [{ type: 'derives-from', target: notRequirement.meta.id }],
  });
  assert.throws(
    () => requirementScope(loadRecords(work.root), [work.requirement.meta.id]),
    /not a requirement/,
  );
  assert.throws(
    () => runCheck(work.root, work.check.meta.id, work.task.meta.id),
    /not a requirement/,
  );
  assert.ok(
    verify(work.root, work.task.meta.id, 'ready').findings.some(
      (finding) => finding.code === 'invalid-requirement-ancestry',
    ),
  );
  updateRecord(work.root, work.requirement.meta.id, {
    links: [{ type: 'derives-from', target: 'DOC-REQ-9999' }],
  });
  assert.throws(
    () => requirementScope(loadRecords(work.root), [work.requirement.meta.id]),
    /missing/,
  );
  const parent = createRecord(work.root, {
    type: 'requirement',
    title: 'Cyclic parent requirement',
    links: [{ type: 'derives-from', target: work.requirement.meta.id }],
    data: { acceptance_criteria: ['The parent must remain acyclic.'] },
  });
  updateRecord(work.root, work.requirement.meta.id, {
    links: [{ type: 'derives-from', target: parent.meta.id }],
  });
  assert.throws(
    () => requirementScope(loadRecords(work.root), [work.requirement.meta.id]),
    /cycle/,
  );
  assert.throws(() => runCheck(work.root, work.check.meta.id, work.task.meta.id), /cycle/);
  assert.ok(
    verify(work.root, work.task.meta.id, 'ready').findings.some(
      (finding) => finding.code === 'invalid-requirement-ancestry',
    ),
  );
  assert.equal(
    loadRecords(work.root).filter((record) => record.meta.type === 'evidence').length,
    1,
  );
});
