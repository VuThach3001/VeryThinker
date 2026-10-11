import test from 'node:test';
import assert from 'node:assert/strict';
import fs, { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { initialize, createRecord, getRecord, updateRecord, hash } from '../dist/storage.js';
import {
  inspectCheck,
  runCheck,
  verify,
  reviewRecord,
  recordFingerprint,
  hasCurrentReview,
} from '../dist/engineering.js';

// These explicitly legacy fixtures test inspection mechanics, not account access,
// model inference, or the quality of semantic judgement.
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'verythinker-inspection-'));
  t.after(() => {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    rmSync(root, { recursive: true, force: true });
  });
  initialize(root, { project_id: 'INSPECTION' });
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src/value.txt'), 'Observed value: 1\n');
  const requirement = createRecord(root, {
    type: 'requirement',
    title: 'Display one',
    data: { acceptance_criteria: ['The stored value is one.'] },
  });
  const design = createRecord(root, {
    type: 'design',
    title: 'Text interface',
    owner: 'architect',
    links: [{ type: 'satisfies', target: requirement.meta.id }],
  });
  const task = createRecord(root, {
    type: 'task',
    title: 'Display one',
    owner: 'developer',
    links: [
      { type: 'satisfies', target: requirement.meta.id },
      { type: 'implements', target: design.meta.id },
    ],
    data: { acceptance_criteria: ['The stored value is one.'], allowed_paths: ['src'] },
  });
  const check = createRecord(root, {
    type: 'check',
    title: 'Inspect text interface',
    owner: 'verifier',
    links: [{ type: 'verifies', target: requirement.meta.id }],
    data: {
      method: 'manual-source-inspection',
      baseline_paths: ['src'],
      inspection_items: [
        { id: 'INS-01', criterion: 'Value', expected: 'The text states one.' },
        { id: 'INS-02', criterion: 'Allocation', expected: 'The requirement identifies one.' },
      ],
    },
  });
  reviewRecord(root, design.meta.id, 'reviewer', 'pass');
  reviewRecord(root, check.meta.id, 'reviewer', 'pass');
  const input = {
    observations: [
      {
        item_id: 'INS-01',
        outcome: 'pass',
        observation: 'Line one explicitly states the observed integer value one.',
        sources: [
          {
            kind: 'file',
            path: 'src/value.txt',
            sha256: hash(readFileSync(join(root, 'src/value.txt'))),
            locator: 'line 1',
          },
        ],
      },
      {
        item_id: 'INS-02',
        outcome: 'pass',
        observation: 'The current requirement criterion explicitly identifies stored value one.',
        sources: [
          {
            kind: 'record',
            record_id: requirement.meta.id,
            fingerprint: recordFingerprint(requirement),
            locator: 'acceptance_criteria[0]',
          },
        ],
      },
    ],
    limitations: [
      'Legacy fixture observations establish mechanics; semantic judgement requires independent review.',
    ],
  };
  return {
    root,
    requirement,
    design,
    task,
    check,
    input,
    collect: (value = input) => inspectCheck(root, check.meta.id, task.meta.id, value),
  };
}

test('inspection captures every authoritative expectation, source and explicit judgement without a process exit claim', (t) => {
  const work = fixture(t),
    evidence = work.collect();
  assert.equal(evidence.meta.data.result, 'pass');
  assert.equal(evidence.meta.data.exit_code, null);
  assert.deepEqual(evidence.meta.data.command, []);
  assert.equal(evidence.meta.data.inspection.claim_kind, 'agent-observed-inspection');
  assert.equal(evidence.meta.data.inspection.independent_semantic_review_required, true);
  assert.equal(evidence.meta.data.inspection.observations[0].expected, 'The text states one.');
  assert.ok(evidence.meta.data.input_snapshot.manifest_hash);
  assert.equal(verify(work.root, work.task.meta.id, 'verified').ok, true);
  assert.equal(verify(work.root, work.task.meta.id, 'accepted').ok, false);
  const receipt = JSON.parse(
    readFileSync(join(work.root, evidence.meta.data.receipt_path), 'utf8'),
  );
  assert.deepEqual(receipt.inspection, evidence.meta.data.inspection);
  assert.throws(
    () => runCheck(work.root, work.check.meta.id, work.task.meta.id),
    /non-empty executable/,
  );
});

test('missing, repeated, extra, unsupported and stale observations are rejected before evidence creation', (t) => {
  const work = fixture(t);
  for (const observations of [
    work.input.observations.slice(0, 1),
    [work.input.observations[0], work.input.observations[0]],
    [...work.input.observations, { ...work.input.observations[0], item_id: 'INS-03' }],
  ])
    assert.throws(
      () => work.collect({ ...work.input, observations }),
      /every reviewed|exact unique/,
    );
  const mutate = (patch) => ({
    ...work.input,
    observations: [{ ...work.input.observations[0], ...patch }, work.input.observations[1]],
  });
  assert.throws(() => work.collect(mutate({ observation: 'Pass.' })), /substantive/);
  assert.throws(() => work.collect(mutate({ sources: [] })), /bounded sources/);
  assert.throws(
    () =>
      work.collect(
        mutate({ sources: [{ kind: 'file', path: 'src/value.txt', sha256: hash('old bytes') }] }),
      ),
    /changed/,
  );
  writeFileSync(join(work.root, 'outside.txt'), 'Outside the verification input scope.');
  assert.throws(
    () =>
      work.collect(
        mutate({
          sources: [
            {
              kind: 'file',
              path: 'outside.txt',
              sha256: hash(readFileSync(join(work.root, 'outside.txt'))),
            },
          ],
        }),
      ),
    /outside/,
  );
  const other = createRecord(work.root, { type: 'knowledge', title: 'Unrelated private context' });
  assert.throws(
    () =>
      work.collect(
        mutate({
          sources: [
            { kind: 'record', record_id: other.meta.id, fingerprint: recordFingerprint(other) },
          ],
        }),
      ),
    /outside/,
  );
  assert.throws(() => work.collect({ ...work.input, limitations: [] }), /explicit limitations/);
});

test('failed or gap observations stay failed and current source or inspection tampering invalidates gates', (t) => {
  const work = fixture(t);
  for (const outcome of ['fail', 'gap']) {
    const evidence = work.collect({
      ...work.input,
      observations: [{ ...work.input.observations[0], outcome }, work.input.observations[1]],
    });
    assert.equal(evidence.meta.data.result, 'fail');
    assert.equal(verify(work.root, work.task.meta.id, 'verified').ok, false);
  }
  const evidence = work.collect();
  assert.equal(verify(work.root, work.task.meta.id, 'verified').ok, true);
  updateRecord(work.root, evidence.meta.id, {
    data: { inspection: { ...evidence.meta.data.inspection, observations: [] } },
  });
  assert.ok(
    verify(work.root, work.task.meta.id, 'verified').findings.some((finding) =>
      /collected execution receipt/.test(finding.message),
    ),
  );
  work.collect();
  writeFileSync(join(work.root, 'src/value.txt'), 'Observed value: 2\n');
  assert.equal(verify(work.root, work.task.meta.id, 'verified').ok, false);
});

test('explicit verification artifacts freeze review bytes without freezing ordinary implementation operands', (t) => {
  const work = fixture(t);
  writeFileSync(join(work.root, 'verification.mjs'), 'export const expected = 1;\n');
  updateRecord(work.root, work.check.meta.id, {
    data: { verification_artifact_paths: ['verification.mjs'] },
  });
  reviewRecord(work.root, work.check.meta.id, 'reviewer', 'pass');
  assert.equal(hasCurrentReview(work.root, work.check.meta.id), true);
  const input = {
    ...work.input,
    observations: [
      {
        ...work.input.observations[0],
        sources: [
          {
            kind: 'file',
            path: 'verification.mjs',
            sha256: hash(readFileSync(join(work.root, 'verification.mjs'))),
          },
        ],
      },
      work.input.observations[1],
    ],
  };
  assert.equal(work.collect(input).meta.data.result, 'pass');
  writeFileSync(join(work.root, 'verification.mjs'), 'export const expected = 2;\n');
  assert.equal(hasCurrentReview(work.root, work.check.meta.id), false);
  assert.equal(getRecord(work.root, work.check.meta.id).meta.data.inspection_items.length, 2);
});

test('an external observed source must match the bytes captured even if an edit races the input snapshot', (t) => {
  const work = fixture(t),
    path = 'analysis.txt',
    observed = 'Observed independent analysis.\n';
  writeFileSync(join(work.root, path), observed);
  createRecord(work.root, {
    type: 'knowledge',
    title: 'Task analysis',
    data: { task_id: work.task.meta.id, artifact_path: path },
  });
  const input = {
    ...work.input,
    observations: [
      {
        ...work.input.observations[0],
        sources: [{ kind: 'file', path, sha256: hash(observed), locator: 'line 1' }],
      },
      work.input.observations[1],
    ],
  };
  const originalRead = fs.readFileSync;
  let triggered = false;
  fs.readFileSync = (...args) => {
    const bytes = originalRead(...args);
    if (
      !triggered &&
      typeof args[0] === 'string' &&
      resolve(args[0]) === resolve(work.root, path)
    ) {
      triggered = true;
      writeFileSync(
        join(work.root, path),
        'Concurrent analysis bytes captured after validation.\n',
      );
    }
    return bytes;
  };
  syncBuiltinESMExports();
  try {
    assert.throws(() => work.collect(input), /differs from its immutable captured input/);
  } finally {
    fs.readFileSync = originalRead;
    syncBuiltinESMExports();
  }
  assert.equal(triggered, true);
  writeFileSync(join(work.root, path), observed);
  assert.equal(verify(work.root, work.task.meta.id, 'verified').ok, false);
  assert.equal(work.collect(input).meta.data.result, 'pass');
});
