import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  initialize,
  createRecord,
  updateRecord,
  startTask,
  submitTask,
  runCheck,
  reviewTask,
  acceptTask,
  verify,
  installPack,
  listPacks,
} from '../dist/index.js';

function project(t, profile = 'basic') {
  const root = mkdtempSync(join(tmpdir(), 'verythinker-adversarial-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  initialize(root, { project_id: 'ADV', profile });
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src/app.mjs'), 'export const value = 1;\n');
  return root;
}

function assignment(root, title = 'Positive configuration', dependencies = []) {
  const requirement = createRecord(root, {
    type: 'requirement',
    title,
    owner: 'requirements',
    body: 'Configuration values must be positive.',
    data: { acceptance_criteria: ['The stored configuration value is positive.'] },
  });
  const task = createRecord(root, {
    type: 'task',
    title,
    owner: 'developer',
    body: 'Deliver the positive configuration value and verification.',
    links: [
      { type: 'satisfies', target: requirement.meta.id },
      ...dependencies.map((target) => ({ type: 'depends-on', target })),
    ],
    data: {
      acceptance_criteria: ['The stored value passes the positivity check.'],
      allowed_paths: ['src'],
      outputs: ['src/app.mjs'],
      tools: ['node'],
    },
  });
  const check = createRecord(root, {
    type: 'check',
    title: `Check ${title}`,
    owner: 'verifier',
    links: [{ type: 'verifies', target: requirement.meta.id }],
    body: 'Load the module and check the configured value.',
    data: {
      command: [
        process.execPath,
        '--input-type=module',
        '-e',
        'import { value } from "./src/app.mjs"; if (value <= 0) throw new Error("Configuration is not positive");',
      ],
      baseline_paths: ['src'],
      method: 'test',
    },
  });
  return { requirement, task, check };
}

function submitted(root, assignment) {
  startTask(root, assignment.task.meta.id, 'requested', 'observed', 'developer-invocation');
  runCheck(root, assignment.check.meta.id, assignment.task.meta.id);
  submitTask(root, assignment.task.meta.id, 'Positive configuration implemented and checked.');
}

test('a new implementation file within a snapshotted directory invalidates prior evidence', (t) => {
  const root = project(t);
  const work = assignment(root);
  submitted(root, work);
  assert.equal(verify(root, work.task.meta.id, 'verified').ok, true);
  writeFileSync(join(root, 'src/new-input.mjs'), 'export const newBehavior = true;\n');
  assert.equal(
    verify(root, work.task.meta.id, 'verified').ok,
    false,
    'Directory baseline must cover added files as well as modified existing files.',
  );
});

test('a review of one implementation revision cannot accept another revision after checks rerun', (t) => {
  const root = project(t);
  const work = assignment(root);
  submitted(root, work);
  reviewTask(root, work.task.meta.id, 'reviewer', 'pass', [], 'reviewer-invocation');
  assert.equal(verify(root, work.task.meta.id, 'accepted').ok, true);
  writeFileSync(join(root, 'src/app.mjs'), 'export const value = 2;\n');
  runCheck(root, work.check.meta.id, work.task.meta.id);
  assert.equal(
    verify(root, work.task.meta.id, 'verified').ok,
    true,
    'The new positive value still meets verification.',
  );
  assert.equal(
    verify(root, work.task.meta.id, 'accepted').ok,
    false,
    'Passing checks do not substitute for reviewing the changed implementation.',
  );
});

test('software design-ready requires review of the allocated design', (t) => {
  const root = project(t, 'software');
  const work = assignment(root);
  createRecord(root, {
    type: 'design',
    title: 'Configuration architecture',
    owner: 'architect',
    links: [{ type: 'satisfies', target: work.requirement.meta.id }],
    body: 'The configuration module exports a positive stored value.',
    data: { interfaces: ['A positive numeric value.'] },
  });
  assert.equal(
    verify(root, work.task.meta.id, 'design-ready').ok,
    false,
    'Design existence alone must not establish reviewed design readiness.',
  );
});

test('stale accepted dependencies do not satisfy downstream readiness', (t) => {
  const root = project(t);
  const prerequisite = assignment(root, 'Prerequisite positive configuration');
  submitted(root, prerequisite);
  reviewTask(root, prerequisite.task.meta.id, 'reviewer', 'pass', [], 'prerequisite-review');
  acceptTask(root, prerequisite.task.meta.id);
  const downstream = assignment(root, 'Downstream configuration use', [prerequisite.task.meta.id]);
  assert.equal(verify(root, downstream.task.meta.id, 'ready').ok, true);
  updateRecord(root, prerequisite.requirement.meta.id, {
    data: { acceptance_criteria: ['The value must be positive and below ten.'] },
  });
  assert.equal(
    verify(root, prerequisite.task.meta.id, 'accepted').ok,
    false,
    'The prerequisite evidence needs reassessment after its requirement changes.',
  );
  assert.equal(
    verify(root, downstream.task.meta.id, 'ready').ok,
    false,
    'An accepted status is insufficient when the dependency acceptance is stale.',
  );
});

test('knowledge pack installation preserves binary asset bytes and locked integrity', (t) => {
  const root = project(t);
  const source = mkdtempSync(join(tmpdir(), 'verythinker-asset-pack-'));
  t.after(() => rmSync(source, { recursive: true, force: true }));
  writeFileSync(
    join(source, 'pack.json'),
    JSON.stringify({
      schema_version: 1,
      id: 'diagram-pack',
      version: '0.1.0',
      description: 'A generalized diagram asset.',
      domains: ['engineering'],
      technologies: [],
      applicability: ['Engineering diagrams.'],
      assumptions: [],
      limitations: [],
      provenance: ['https://example.org/diagram-source'],
      dependencies: [],
    }),
  );
  const asset = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe, 0x80, 0x42]);
  writeFileSync(join(source, 'diagram.png'), asset);
  const installed = installPack(root, source);
  assert.deepEqual(
    readFileSync(join(root, installed.path, 'diagram.png')),
    asset,
    'Knowledge assets must be copied without text decoding.',
  );
  const result = listPacks(root);
  assert.equal(result.installed.find((pack) => pack.id === 'diagram-pack').integrity, 'valid');
});
