import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createRecord,
  executionScope,
  initialize,
  loadRecords,
  requirementScope,
  contextPacket,
  runCheck,
  updateRecord,
  verify,
} from '../dist/index.js';

test('task applicability includes its direct check and shared design integration while preserving ancestry as provenance', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'verythinker-autonomous-scope-'));
  initialize(root, { project_id: 'AUTONOMOUS-SCOPE', profile: 'software' });
  writeFileSync(
    join(root, 'README.md'),
    '# Bootstrap interface\nThe fixture records the source-reading stage independently of final teaching checks.\n',
  );
  t.after(() => {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    rmSync(root, { recursive: true, force: true });
  });
  const parent = createRecord(root, {
    type: 'requirement',
    title: 'Final teaching outcome',
    data: { acceptance_criteria: ['The final lesson meets its learning outcome.'] },
  });
  const child = createRecord(root, {
    type: 'requirement',
    title: 'Bootstrap implementation',
    links: [{ type: 'derives-from', target: parent.meta.id }],
    data: { acceptance_criteria: ['The bootstrap artifact is created.'] },
  });
  const sharedDesign = createRecord(root, {
    type: 'design',
    title: 'Shared course interface allocation',
    links: [
      { type: 'satisfies', target: parent.meta.id },
      { type: 'satisfies', target: child.meta.id },
    ],
    data: { allocation: 'The bootstrap stage prepares the final teaching interface.' },
  });
  for (let index = 0; index < 11; index++)
    createRecord(root, {
      type: 'check',
      title: `Ancestor final-teaching check ${index + 1}`,
      links: [{ type: 'verifies', target: parent.meta.id }],
      data: { command: [process.execPath, '-e', 'process.exit(0)'], baseline_paths: ['README.md'] },
    });
  const bootstrapCheck = createRecord(root, {
    type: 'check',
    title: 'Bootstrap requirement check',
    links: [{ type: 'verifies', target: child.meta.id }],
    data: { command: [process.execPath, '-e', 'process.exit(0)'], baseline_paths: ['README.md'] },
  });
  const task = createRecord(root, {
    type: 'task',
    title: 'Create the course bootstrap artifact',
    owner: 'developer',
    links: [{ type: 'satisfies', target: child.meta.id }],
    data: {
      requirements: [child.meta.id],
      acceptance_criteria: ['The bootstrap artifact is created.'],
      allowed_paths: ['README.md'],
    },
  });
  const integrationCheck = createRecord(root, {
    type: 'check',
    title: 'Shared bootstrap interface check',
    links: [{ type: 'verifies', target: sharedDesign.meta.id }],
    data: { command: [process.execPath, '-e', 'process.exit(0)'], baseline_paths: ['README.md'] },
  });
  const records = loadRecords(root);
  const scope = executionScope(records, task);
  const applicableChecks = records.filter(
    (record) =>
      record.meta.type === 'check' &&
      record.meta.links.some((link) => link.type === 'verifies' && scope.includes(link.target)),
  );
  assert.equal(applicableChecks.length, 2);
  assert.ok(scope.includes(child.meta.id));
  assert.ok(!scope.includes(parent.meta.id));
  assert.deepEqual(
    new Set(requirementScope(records, [child.meta.id])),
    new Set([child.meta.id, parent.meta.id]),
  );
  const finalTaskScope = executionScope(records, parent);
  assert.equal(
    records.filter(
      (record) =>
        record.meta.type === 'check' &&
        record.meta.links.some(
          (link) => link.type === 'verifies' && finalTaskScope.includes(link.target),
        ),
    ).length,
    12,
  );
  assert.equal(records.filter((record) => record.meta.type === 'check').length, 13);
  const packet = contextPacket(root, task.meta.id);
  assert.deepEqual(
    packet.verification_procedures.map((procedure) => procedure.id).sort(),
    [bootstrapCheck.meta.id, integrationCheck.meta.id].sort(),
  );
  const childEvidence = runCheck(root, bootstrapCheck.meta.id, task.meta.id);
  runCheck(root, integrationCheck.meta.id, task.meta.id);
  assert.ok(childEvidence.meta.data.record_baseline[parent.meta.id]);
  const captured = JSON.parse(
    readFileSync(join(root, childEvidence.meta.data.input_snapshot.manifest_path), 'utf8'),
  );
  assert.ok(captured.records[parent.meta.id].fingerprint);
  updateRecord(root, parent.meta.id, {
    data: { acceptance_criteria: ['The final course teaches the approved outcome.'] },
  });
  const afterAncestorChange = verify(root, task.meta.id, 'verified');
  assert.ok(
    afterAncestorChange.findings.some(
      (finding) =>
        finding.code === 'missing-valid-evidence' &&
        finding.message.includes(`Record requires reassessment: ${parent.meta.id}`),
    ),
  );
});

test('implicit context budget expands for necessary metadata while explicit limits remain enforced', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'verythinker-context-recovery-'));
  initialize(root, { project_id: 'CONTEXT-RECOVERY' });
  t.after(() => {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    rmSync(root, { recursive: true, force: true });
  });
  const task = createRecord(root, {
    type: 'task',
    title: 'Preserve a detailed context contract',
    owner: 'developer',
    data: { acceptance_criteria: ['Preserve all declared input constraints. '.repeat(600)] },
  });
  const packet = contextPacket(root, task.meta.id);
  assert.ok(JSON.stringify(packet).length > 18000);
  assert.ok(JSON.stringify(packet).length <= 100000);
  assert.deepEqual(packet.acceptance_criteria, task.meta.data.acceptance_criteria);
  assert.throws(() => contextPacket(root, task.meta.id, 18000), /metadata exceeds/);
});
