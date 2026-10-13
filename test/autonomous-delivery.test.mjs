import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  initialize,
  beginWorkflow,
  discussWorkflow,
  decideWorkflow,
  workflowStatus,
  finishWorkflow,
  createRecord,
  updateRecord,
  getRecord,
  loadRecords,
  startTask,
  runCheck,
  archiveEvidence,
  submitTask,
  reviewTask,
  reviewRecord,
  ensureArchivePolicy,
  hash,
} from '../dist/index.js';

function delivered(t, archive = false) {
  const root = mkdtempSync(join(tmpdir(), 'verythinker-autonomous-delivery-'));
  t.after(() => {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    rmSync(root, { recursive: true, force: true });
  });
  initialize(root, { project_id: 'DELIVERY', profile: 'basic' });
  if (archive) {
    const policy = ensureArchivePolicy(root);
    writeFileSync(
      join(root, '.verythinker/archive.json'),
      JSON.stringify({ ...policy, repository: 'example/private' }, null, 2) + '\n',
    );
  }
  const parent = beginWorkflow(root, {
    requirement: 'Provide a documented module exporting integer one.',
    invocation_id: 'manager-fixture',
    request_id: 'delivery-fixture',
  });
  const requirement = updateRecord(root, parent.meta.data.requirement_id, {
    data: { acceptance_criteria: ['The named value export is integer one.'] },
  });
  mkdirSync(join(root, 'src'));
  mkdirSync(join(root, 'docs'));
  writeFileSync(join(root, 'src/value.mjs'), 'export const value = 1;\n');
  writeFileSync(join(root, 'docs/value.md'), '# Value\nThe module exports integer one.\n');
  const task = createRecord(root, {
    type: 'task',
    title: 'Deliver documented value',
    owner: 'developer',
    links: [{ type: 'satisfies', target: requirement.meta.id }],
    data: {
      acceptance_criteria: ['Export one and document its interface.'],
      allowed_paths: ['src', 'docs'],
      documentation_paths: ['docs/value.md'],
      outputs: ['src/value.mjs', 'docs/value.md'],
    },
  });
  const check = createRecord(root, {
    type: 'check',
    title: 'Verify exported value',
    owner: 'verifier',
    links: [{ type: 'verifies', target: requirement.meta.id }],
    data: {
      command: [
        process.execPath,
        '--input-type=module',
        '-e',
        'import {value} from "./src/value.mjs"; if(value!==1) process.exit(1)',
      ],
      baseline_paths: ['src'],
      method: 'unit',
    },
  });
  for (const role of ['requirements', 'verifier'])
    discussWorkflow(root, parent.meta.id, {
      role,
      invocation_id: `${role}-fixture`,
      summary: 'The module and its documented export have measurable outcomes.',
      rationale: 'A focused import assertion checks the bounded numeric contract.',
      source_ids: [requirement.meta.id],
    });
  decideWorkflow(root, parent.meta.id, {
    summary: 'Use a named export and a focused executable assertion.',
    rationale: 'The requested value requires no runtime dependency or external service.',
    task_ids: [task.meta.id],
  });
  const planned = workflowStatus(root, parent.meta.id);
  assert.equal(planned.phase, 'execution');
  assert.equal(planned.local_delivery, null);
  assert.match(planned.next_action, /Dispatch ready tasks/);
  startTask(root, task.meta.id, undefined, undefined, 'developer-fixture');
  const evidence = archiveEvidence(root, runCheck(root, check.meta.id, task.meta.id).meta.id);
  submitTask(
    root,
    task.meta.id,
    'Delivered and verified the documented numeric export.',
    `# Objective\nDeliver ${task.meta.id} with its documented numeric export.\n\n# Inputs and Sources\nInspected ${requirement.meta.id}, the module, and its documentation.\n\n# Decisions and Rationale\nUsed a named export because the requirement specifies one stable value.\n\n# Results\nThe module exports integer one and the documentation states the same interface.\n\n# Evidence\nRan ${check.meta.id} and archived evidence ${evidence.meta.id}.\n\n# Limitations\nThis fixture checks the module contract; native model identity is not inferred.\n\n# Lessons\nA focused import assertion provides repeatable evidence for a fixed export.\n`,
  );
  reviewTask(root, task.meta.id, 'reviewer', 'pass', [], 'reviewer-fixture');
  return { root, parent, task };
}

function reportFingerprint(root, status, expectedDeliveryStatus = 'complete') {
  assert.equal(status.local_delivery.status, expectedDeliveryStatus);
  assert.equal(status.final_report_id, status.local_delivery.report_id);
  assert.equal(status.final_report_path, status.local_delivery.report_path);
  assert.equal(status.final_report_hash, status.local_delivery.report_hash);
  const path = join(root, status.final_report_path);
  assert.ok(existsSync(path));
  assert.equal(hash(readFileSync(path)), status.final_report_hash);
  assert.equal(getRecord(root, status.final_report_id).body.includes('# Objective'), true);
  return {
    id: status.final_report_id,
    hash: status.final_report_hash,
    path: status.final_report_path,
  };
}

function reviewedCandidate(work) {
  const lesson = createRecord(work.root, {
    type: 'knowledge',
    title: 'Focused verification for fixed module exports',
    owner: 'curator',
    links: [{ type: 'references', target: work.task.meta.id }],
    data: {
      kind: 'generalized-candidate',
      workflow_id: work.parent.meta.id,
      invocation_id: 'curator-fixture',
      generalization: 'A focused import assertion can verify a fixed module export value.',
      applicability: ['Small deterministic module contracts'],
      provenance: ['https://nodejs.org/api/assert.html'],
      assumptions: ['The export value is the observable contract.'],
      limitations: ['This does not assess production reliability.'],
    },
    body: 'A narrowly generalized verification technique for fixed module exports.',
  });
  reviewRecord(work.root, lesson.meta.id, 'reviewer', 'pass', [], 'generalization-fixture', true);
  return lesson;
}

test('archive publisher failure preserves the local report and retries the same snapshot', (t) => {
  const work = delivered(t, true);
  const input = {
    no_lesson_reason:
      'This bounded fixture verifies local delivery recovery and adds no distinct reusable lesson.',
  };
  const snapshotIds = [];
  const fail = (_root, snapshotId) => {
    snapshotIds.push(snapshotId);
    throw new Error('Private archive service unavailable.');
  };
  const first = finishWorkflow(work.root, work.parent.meta.id, input, undefined, fail);
  assert.equal(first.phase, 'completed-with-blockers');
  const firstStatus = workflowStatus(work.root, work.parent.meta.id);
  const report = reportFingerprint(work.root, firstStatus);
  assert.equal(firstStatus.publication_disposition.status, 'blocked');
  assert.match(
    firstStatus.publication_disposition.blockers.join('\n'),
    /archive service unavailable/i,
  );
  assert.equal(firstStatus.archive, null);
  const sequence = readFileSync(join(work.root, '.verythinker/id-sequence.json'));
  const intentPath = join(
    work.root,
    '.verythinker/archive-intents',
    `${hash(work.parent.meta.id)}.json`,
  );
  const intentBytes = readFileSync(intentPath);
  const snapshotId = JSON.parse(intentBytes.toString()).snapshot_id;
  const snapshotManifestPath = join(
    work.root,
    '.verythinker/archives',
    snapshotId,
    'manifest.json',
  );
  const snapshotBytes = readFileSync(snapshotManifestPath);
  assert.throws(
    () =>
      finishWorkflow(
        work.root,
        work.parent.meta.id,
        {
          no_lesson_reason:
            'Changed closure input must never rewrite a report inside a frozen snapshot retry.',
        },
        undefined,
        fail,
      ),
    /frozen archive snapshot is bound to different closure inputs/i,
  );
  assert.deepEqual(readFileSync(join(work.root, '.verythinker/id-sequence.json')), sequence);
  assert.deepEqual(readFileSync(intentPath), intentBytes);
  assert.deepEqual(readFileSync(snapshotManifestPath), snapshotBytes);
  assert.deepEqual(
    reportFingerprint(work.root, workflowStatus(work.root, work.parent.meta.id)),
    report,
  );
  assert.equal(snapshotIds.length, 1);

  const reportPath = join(work.root, firstStatus.final_report_path);
  const reportBytes = readFileSync(reportPath);
  writeFileSync(
    reportPath,
    Buffer.concat([reportBytes, Buffer.from('\nUnpublished explanatory edit.\n')]),
  );
  const editedReport = readFileSync(reportPath);
  assert.throws(
    () => finishWorkflow(work.root, work.parent.meta.id, input, undefined, fail),
    /frozen archive snapshot no longer matches/i,
  );
  assert.deepEqual(readFileSync(reportPath), editedReport);
  assert.equal(snapshotIds.length, 1);
  writeFileSync(reportPath, reportBytes);

  updateRecord(work.root, work.parent.meta.id, { data: { archive: { snapshot_id: snapshotId } } });
  rmSync(intentPath);
  assert.throws(
    () =>
      finishWorkflow(
        work.root,
        work.parent.meta.id,
        {
          no_lesson_reason:
            'A changed retry must not rewrite the frozen report when its intent file was lost.',
        },
        undefined,
        fail,
      ),
    /legacy frozen archive snapshot/i,
  );
  assert.deepEqual(readFileSync(reportPath), reportBytes);
  assert.equal(snapshotIds.length, 1);
  updateRecord(work.root, work.parent.meta.id, { data: { archive: null } });
  writeFileSync(intentPath, intentBytes);

  const retry = finishWorkflow(work.root, work.parent.meta.id, input, undefined, fail);
  assert.equal(retry.phase, 'completed-with-blockers');
  const secondStatus = workflowStatus(work.root, work.parent.meta.id);
  assert.deepEqual(reportFingerprint(work.root, secondStatus), report);
  assert.equal(new Set(snapshotIds).size, 1);
  assert.equal(
    loadRecords(work.root).filter((record) => record.meta.title === 'Manager final report').length,
    1,
  );
  assert.equal(secondStatus.archive, null);
});

test('a re-reviewed changed candidate cannot alter a frozen closure before publication', (t) => {
  const work = delivered(t, true);
  const lesson = reviewedCandidate(work);
  const input = { knowledge_ids: [lesson.meta.id] };
  finishWorkflow(
    work.root,
    work.parent.meta.id,
    input,
    (_root, id) => ({
      knowledge_id: id,
      status: 'draft-pr-created',
      upstream_pr: 'https://example.invalid/pull/2',
    }),
    () => {
      throw new Error('Offline frozen snapshot fixture.');
    },
  );
  const before = workflowStatus(work.root, work.parent.meta.id);
  const reportBytes = readFileSync(join(work.root, before.final_report_path));
  updateRecord(work.root, lesson.meta.id, {
    data: {
      generalization:
        'A changed generalized assertion needs a new reviewed increment after freezing.',
    },
  });
  reviewRecord(work.root, lesson.meta.id, 'reviewer', 'pass', [], 'replacement-review', true);
  let publications = 0;
  assert.throws(
    () =>
      finishWorkflow(
        work.root,
        work.parent.meta.id,
        input,
        () => {
          publications++;
        },
        () => {
          publications++;
        },
      ),
    /frozen archive snapshot no longer matches/i,
  );
  assert.equal(publications, 0);
  assert.deepEqual(readFileSync(join(work.root, before.final_report_path)), reportBytes);
});

test('contribution publisher failure keeps local delivery visible and retries without replacing the report', (t) => {
  const work = delivered(t);
  const lesson = reviewedCandidate(work);
  const invocationId = '01234567-89ab-cdef-8123-456789abcdef';
  updateRecord(work.root, work.parent.meta.id, { data: { invocation_id: invocationId } });
  mkdirSync(join(work.root, '.verythinker/native/completion'), { recursive: true });
  const completionPath = join(work.root, '.verythinker/native/completion', `${invocationId}.json`);
  writeFileSync(
    completionPath,
    JSON.stringify({ error: 'Prior completion response was delayed.' }),
  );
  const intentPath = join(
    work.root,
    '.verythinker/archive-intents',
    `${hash(work.parent.meta.id)}.json`,
  );
  mkdirSync(join(work.root, '.verythinker/archive-intents'), { recursive: true });
  writeFileSync(
    intentPath,
    JSON.stringify({ workflow_id: work.parent.meta.id, error: 'Prior archive attempt failed.' }),
  );
  const completionHistory = readFileSync(completionPath);
  const intentHistory = readFileSync(intentPath);
  const input = { knowledge_ids: [lesson.meta.id] };
  let attempts = 0;
  const fail = () => {
    attempts++;
    throw new Error('Contribution service unavailable.');
  };
  const first = finishWorkflow(work.root, work.parent.meta.id, input, fail);
  assert.equal(first.phase, 'completed-with-blockers');
  const firstStatus = workflowStatus(work.root, work.parent.meta.id);
  const report = reportFingerprint(work.root, firstStatus);
  assert.equal(firstStatus.publication_disposition.status, 'blocked');
  assert.equal(firstStatus.publication_disposition.publications[0].status, 'blocked');

  const retry = finishWorkflow(work.root, work.parent.meta.id, {}, (_root, id) => {
    attempts++;
    return {
      knowledge_id: id,
      status: 'draft-pr-created',
      upstream_pr: 'https://example.invalid/pull/1',
    };
  });
  assert.equal(retry.phase, 'completed');
  const secondStatus = workflowStatus(work.root, work.parent.meta.id);
  assert.deepEqual(reportFingerprint(work.root, secondStatus), report);
  assert.equal(secondStatus.publication_disposition.status, 'published');
  assert.equal(secondStatus.publication_disposition.publications[0].status, 'draft-pr-created');
  assert.deepEqual(secondStatus.closure_blockers, []);
  assert.deepEqual(readFileSync(completionPath), completionHistory);
  assert.deepEqual(readFileSync(intentPath), intentHistory);
  assert.equal(attempts, 2);
  assert.equal(
    loadRecords(work.root).filter((record) => record.meta.title === 'Manager final report').length,
    1,
  );
});

test('publisher race preserves its report and exposes stale local delivery without completion', (t) => {
  const work = delivered(t);
  const lesson = reviewedCandidate(work);
  assert.throws(
    () =>
      finishWorkflow(work.root, work.parent.meta.id, { knowledge_ids: [lesson.meta.id] }, () => {
        writeFileSync(
          join(work.root, 'docs/value.md'),
          '# Changed value\nThe module documentation changed during publication.\n',
        );
        return {
          status: 'draft-pr-created',
          upstream_pr: 'https://example.invalid/pull/1',
        };
      }),
    /Documentation files changed/,
  );
  const status = workflowStatus(work.root, work.parent.meta.id);
  assert.notEqual(status.final_report_id, null);
  reportFingerprint(work.root, status, 'stale');
  assert.equal(status.local_delivery.status, 'stale');
  assert.match(status.local_delivery.stale_findings.join('\n'), /documentation/i);
  assert.notEqual(status.phase, 'completed');
  assert.equal(status.tasks[0].accepted.ok, false);
});
