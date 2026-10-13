import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createRecord, initialize, loadRecords, updateRecord } from '../../dist/storage.js';
import { executionScope, runCheck, verify } from '../../dist/engineering.js';

const temporaryParent = resolve(tmpdir());
const root = mkdtempSync(join(temporaryParent, 'verythinker-recovery-practice-'));

try {
  initialize(root, { project_id: 'RECOVERY-PRACTICE', profile: 'software' });
  writeFileSync(join(root, 'README.md'), 'Disposable baseline input for the recovery practice.\n');

  const parentRequirement = createRecord(root, {
    type: 'requirement',
    title: 'Final learner outcome',
    data: { acceptance_criteria: ['The complete course meets the learner outcome.'] },
  });
  const childRequirement = createRecord(root, {
    type: 'requirement',
    title: 'Bootstrap deliverable',
    links: [{ type: 'derives-from', target: parentRequirement.meta.id }],
    data: { acceptance_criteria: ['The bootstrap deliverable is created.'] },
  });
  const sharedDesign = createRecord(root, {
    type: 'design',
    title: 'Shared learner interface',
    links: [
      { type: 'satisfies', target: parentRequirement.meta.id },
      { type: 'satisfies', target: childRequirement.meta.id },
    ],
    data: { allocation: 'The bootstrap creates the interface used by the final course.' },
  });

  const makeCheck = (title, target) =>
    createRecord(root, {
      type: 'check',
      title,
      links: [{ type: 'verifies', target }],
      data: {
        command: [process.execPath, '-e', 'process.exit(0)'],
        baseline_paths: ['README.md'],
      },
    });

  makeCheck('Final outcome check A', parentRequirement.meta.id);
  makeCheck('Final outcome check B', parentRequirement.meta.id);
  const childCheck = makeCheck('Bootstrap deliverable check', childRequirement.meta.id);
  const sharedInterfaceCheck = makeCheck(
    'Shared interface integration check',
    sharedDesign.meta.id,
  );
  const task = createRecord(root, {
    type: 'task',
    title: 'Build the bootstrap deliverable',
    owner: 'developer',
    links: [{ type: 'satisfies', target: childRequirement.meta.id }],
    data: {
      requirements: [childRequirement.meta.id],
      acceptance_criteria: ['The bootstrap deliverable is created.'],
      allowed_paths: ['README.md'],
    },
  });

  const records = loadRecords(root);
  const applicableIds = new Set(executionScope(records, task));
  const checks = records.filter((record) => record.meta.type === 'check');
  const childApplicableChecks = checks.filter((check) =>
    check.meta.links.some((link) => link.type === 'verifies' && applicableIds.has(link.target)),
  );
  const parentApplicableIds = new Set(executionScope(records, parentRequirement));
  const parentApplicableChecks = checks.filter((check) =>
    check.meta.links.some(
      (link) => link.type === 'verifies' && parentApplicableIds.has(link.target),
    ),
  );

  assert.equal(checks.length, 4);
  assert.equal(childApplicableChecks.length, 2);
  assert.equal(parentApplicableChecks.length, 3);
  assert.ok(childApplicableChecks.some((check) => check.meta.id === childCheck.meta.id));
  assert.ok(childApplicableChecks.some((check) => check.meta.id === sharedInterfaceCheck.meta.id));
  assert.ok(!childApplicableChecks.some((check) => check.meta.title.startsWith('Final outcome')));

  runCheck(root, childCheck.meta.id, task.meta.id);
  runCheck(root, sharedInterfaceCheck.meta.id, task.meta.id);
  const evidence = loadRecords(root).find(
    (record) =>
      record.meta.type === 'evidence' &&
      record.meta.data.check_id === childCheck.meta.id &&
      record.meta.data.task_id === task.meta.id,
  );
  assert.ok(evidence, 'The child check should leave an evidence record.');
  assert.ok(
    evidence.meta.data.record_baseline[parentRequirement.meta.id],
    'The parent fingerprint should be captured as provenance.',
  );

  updateRecord(root, parentRequirement.meta.id, {
    data: { acceptance_criteria: ['The complete course teaches the approved learner outcome.'] },
  });
  const afterParentChange = verify(root, task.meta.id, 'verified');
  const staleFinding = afterParentChange.findings.find(
    (finding) =>
      finding.code === 'missing-valid-evidence' &&
      finding.message.includes('Record requires reassessment:'),
  );
  assert.ok(staleFinding, 'Changing the parent must make old child evidence stale.');

  process.stdout.write(
    `${JSON.stringify(
      {
        mode: 'legacy-mechanical-demonstration',
        checks: {
          total: checks.length,
          bootstrapTask: childApplicableChecks.length,
          finalRequirement: parentApplicableChecks.length,
        },
        provenance: { parentFingerprintCaptured: true, parentChangeInvalidatesOldEvidence: true },
        finding: 'missing-valid-evidence',
      },
      null,
      2,
    )}\n`,
  );
} finally {
  const resolvedRoot = resolve(root);
  const resolvedParent = resolve(dirname(resolvedRoot));
  assert.ok(isAbsolute(resolvedRoot), 'Temporary project path must be absolute.');
  assert.equal(
    resolvedParent,
    temporaryParent,
    'Cleanup target must be a direct child of the temp directory.',
  );
  assert.ok(resolvedRoot.split(/[\\/]/).at(-1).startsWith('verythinker-recovery-practice-'));
  rmSync(resolvedRoot, { recursive: true, force: true });
}
