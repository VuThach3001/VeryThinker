import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createRecord, initialize, updateRecord } from '../dist/storage.js';
import { selectExecutionPolicy } from '../dist/fast-policy.js';
import {
  authorizeFastOperation,
  fastGrantProblems,
  fastOperations,
  fastPlanFingerprint,
  fastResponsibility,
  validateFastSelection,
} from '../dist/fast-grants.js';
import { canonicalJson, routingConfigurationHashes } from '../dist/routing.js';
import { hash } from '../dist/storage.js';
import { roleCapabilities } from '../dist/tools.js';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'verythinker-fast-authority-'));
  t.after(() => {
    assert.ok(relative(tmpdir(), resolve(root)).startsWith('verythinker-fast-authority-'));
    rmSync(root, { recursive: true, force: true });
  });
  initialize(root, { project_id: 'FGA', profile: 'software' });
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src/module.mjs'), 'export const enabled = true;\n');
  writeFileSync(join(root, 'src/contract.json'), '{"enabled":true}\n');
  const binding = {
    id: 'small-config-change',
    requirement: 'Change the enabled default in the existing module.',
    classification: 'familiar',
    recipe_id: 'software-config-persistence',
    recipe_version: '1.0.0',
    parameters: { output_dir: 'src', schema_version: 1, fields: { enabled: { type: 'boolean', default: true } } },
    editable_paths: ['src/module.mjs'],
    protected_input_paths: ['src/contract.json'],
    risk_flags: { security: false, safety: false, interfaces: false, dependencies: false, environment: false },
  };
  writeFileSync(join(root, '.verythinker/fast-bindings.json'), JSON.stringify({ schema_version: 1, bindings: [binding] }));
  const workflow = createRecord(root, {
    type: 'knowledge', title: 'Fast workflow', owner: 'manager', status: 'in-progress',
    data: { kind: 'manager-workflow', original_requirement: binding.requirement, original_requirements: [binding.requirement], task_ids: [], fast_stage: 'planning' },
  });
  const selection = selectExecutionPolicy(root, {
    workflow_id: workflow.meta.id, requirement: binding.requirement, policy: 'fast',
  }).fast;
  assert.ok(selection);
  updateRecord(root, workflow.meta.id, { data: { execution_policy_selection: selection } });
  const requirement = createRecord(root, {
    type: 'requirement', title: 'Enable default', owner: 'requirements',
    data: { workflow_id: workflow.meta.id, acceptance_criteria: ['The default remains true.'] },
  });
  const task = createRecord(root, {
    type: 'task', title: 'Update default', owner: 'developer', status: 'ready',
    links: [{ type: 'satisfies', target: requirement.meta.id }],
    data: { workflow_id: workflow.meta.id, requirements: [requirement.meta.id], allowed_paths: ['src/module.mjs'], acceptance_criteria: ['The default remains true.'] },
  });
  const check = createRecord(root, {
    type: 'check', title: 'Check default', owner: 'verifier', status: 'approved',
    links: [{ type: 'verifies', target: requirement.meta.id }],
    data: { oracle_paths: ['src/contract.json'] },
  });
  updateRecord(root, workflow.meta.id, { data: { task_ids: [task.meta.id] } });
  return { root, workflow, selection, task, requirement, check };
}

test('Fast stage contracts preserve the old standard role table and separate planner from producer powers', () => {
  assert.throws(() => roleCapabilities('planner'), /unknown engineering role/i);
  assert.throws(() => roleCapabilities('producer'), /unknown engineering role/i);
  const planner = fastOperations('planner');
  assert.ok(planner.includes('record_create'));
  assert.ok(planner.includes('fast_plan_submit'));
  assert.ok(!planner.includes('task_file_write'));
  assert.ok(!planner.includes('check_run'));
  assert.ok(!planner.includes('native_dispatch'));
  const producer = fastOperations('producer');
  assert.ok(producer.includes('task_file_write'));
  assert.ok(producer.includes('check_run'));
  assert.ok(producer.includes('check_inspect'));
  assert.ok(producer.includes('task_start'));
  assert.ok(producer.includes('task_resume'));
  assert.ok(!producer.includes('capability_resolve'));
  assert.ok(!producer.includes('capability_invoke'));
  assert.ok(!producer.includes('record_create'));
  assert.ok(!producer.includes('record_update'));
  assert.ok(!producer.includes('fast_plan_submit'));
});

test('grant selection must be the persisted workflow selection and the fast plan hash tracks contracts', (t) => {
  const { root, workflow, selection, task, check } = fixture(t);
  validateFastSelection(root, selection);
  assert.throws(() => validateFastSelection(root, { ...selection, workflow_id: 'other' }), /not found/i);
  const before = fastPlanFingerprint(root, workflow.meta.id);
  updateRecord(root, check.meta.id, {}, '# Modified check oracle\n');
  assert.notEqual(fastPlanFingerprint(root, workflow.meta.id), before);
  assert.equal(task.meta.data.workflow_id, workflow.meta.id);
});

test('protocol fixtures cannot establish fast authority or responsibility', (t) => {
  const { root, workflow, selection, task, check } = fixture(t);
  const receipt = {
    schema_version: 1,
    issuer: 'verythinker-codex-app-server',
    execution_mode: 'protocol-fixture',
    id: '87654321-1234-4234-8234-123456789abc',
    role: 'developer',
    owner_pid: process.pid,
    workflow_id: workflow.meta.id,
    task_id: task.meta.id,
    created_at: new Date().toISOString(),
    fast_grant: {
      schema_version: 1,
      grant_id: 'fast-grant-fixture',
      stage: 'producer',
      phase: 'production',
      invocation_id: '87654321-1234-4234-8234-123456789abc',
      owner_pid: process.pid,
      workflow_id: workflow.meta.id,
      task_id: task.meta.id,
      allowed_operations: fastOperations('producer'),
      allowed_paths: [...selection.editable_paths],
      protected_check_ids: [check.meta.id],
      configuration_hashes: routingConfigurationHashes(root),
      selection_sha256: hash(canonicalJson(selection)),
      plan_sha256: fastPlanFingerprint(root, workflow.meta.id),
      issued_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    },
  };
  const problems = fastGrantProblems(root, receipt, { phase: 'production' });
  assert.ok(problems.some((problem) => /protocol fixture/i.test(problem)));
  assert.equal(fastResponsibility(root, receipt, 'task'), null);
  assert.throws(() => authorizeFastOperation(root, receipt, 'task_file_write', {
    operation: 'task_file_write', workflow_id: workflow.meta.id, task_id: task.meta.id,
    path: 'src/module.mjs',
  }), /protocol fixture/i);
  updateRecord(root, workflow.meta.id, { data: { execution_policy_selection: { ...selection, selection_fingerprint: 'forged' } } });
  assert.throws(() => validateFastSelection(root, { ...selection, selection_fingerprint: 'forged' }), /fingerprint/i);
});
