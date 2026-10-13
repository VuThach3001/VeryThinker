import test from 'node:test';
import assert from 'node:assert/strict';
import { createPrivateKey, randomUUID, sign } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { beginWorkflow } from '../dist/manager.js';
import { selectExecutionPolicy } from '../dist/fast-policy.js';
import { initialize, createRecord, updateRecord, hash, readConfig } from '../dist/storage.js';
import {
  canonicalJson, ensureRoutingPolicy, routingConfigurationHashes,
} from '../dist/routing.js';
import { sealFastSelection } from '../dist/native.js';
import {
  assertFastProducerReady, authorizeFastOperation, fastGrantProblems, fastOperations,
  fastPlanFingerprint, fastResponsibility, hasFastResponsibility, issueFastGrant,
} from '../dist/fast-grants.js';

const requirementText = 'Change the enabled default in the existing module.';
const integrity = 'sha512-NWZdi/kxyjv/8EUGFupziGU38YyleugZRM4JXgY5XFH7FUmaFA33NZS2Bmq0HPazf7S3jJQQWsZ/jAK9jsrV3Q==';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'verythinker-fast-signed-fixture-'));
  t.after(() => {
    assert.ok(relative(tmpdir(), resolve(root)).startsWith('verythinker-fast-signed-fixture-'));
    rmSync(root, { recursive: true, force: true });
  });
  initialize(root, { project_id: 'FAST-SIGNED-FIXTURE', profile: 'software' });
  ensureRoutingPolicy(root);
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src/module.mjs'), 'export const enabled = true;\n');
  writeFileSync(join(root, 'src/contract.json'), '{"enabled":true}\n');
  writeFileSync(join(root, '.verythinker/native-runtime.lock.json'), JSON.stringify({
    version: '0.162.1', integrity, protocol_sha256: hash('synthetic signed receipt protocol fixture'),
  }));
  writeFileSync(join(root, '.verythinker/fast-bindings.json'), JSON.stringify({ schema_version: 1, bindings: [{
    id: 'small-config-change', requirement: requirementText, classification: 'familiar',
    recipe_id: 'software-config-persistence', recipe_version: '1.0.0',
    parameters: { output_dir: 'src', schema_version: 1, fields: { enabled: { type: 'boolean', default: true } } },
    editable_paths: ['src/module.mjs'], protected_input_paths: ['src/contract.json'],
    risk_flags: { security: false, safety: false, interfaces: false, dependencies: false, environment: false },
  }] }));

  // This is the authoritative manager workflow shape used by Fast selection.
  const workflow = beginWorkflow(root, { requirement: requirementText, request_id: randomUUID(), execution_policy: 'fast' });
  const selection = selectExecutionPolicy(root, { workflow_id: workflow.meta.id, requirement: requirementText, policy: 'fast' }).fast;
  assert.ok(selection);
  updateRecord(root, workflow.meta.id, { data: { execution_policy: 'fast', execution_policy_selection: selection, fast_stage: 'planning' } });
  // Intake authority seals this exact selection with the local project receipt key.
  sealFastSelection(root, selection);
  const requirement = createRecord(root, {
    type: 'requirement', title: 'Enabled default', owner: 'requirements',
    data: { workflow_id: workflow.meta.id, acceptance_criteria: ['The default remains true.'] },
  });
  const task = createRecord(root, {
    type: 'task', title: 'Update enabled default', owner: 'developer', status: 'ready',
    links: [{ type: 'satisfies', target: requirement.meta.id }],
    data: { workflow_id: workflow.meta.id, requirements: [requirement.meta.id], allowed_paths: ['src/module.mjs'], documentation_paths: ['src/module.mjs'], acceptance_criteria: ['The default remains true.'] },
  });
  const check = createRecord(root, {
    type: 'check', title: 'Protect the contract', owner: 'verifier', status: 'approved',
    links: [{ type: 'verifies', target: requirement.meta.id }],
    data: { oracle_paths: ['src/contract.json'] },
  });
  updateRecord(root, workflow.meta.id, { data: { task_ids: [task.meta.id] } });
  const privateKey = createPrivateKey(readFileSync(join(root, '.verythinker/cache/native/private-key.pem')));
  const keyId = JSON.parse(readFileSync(join(root, '.verythinker/native/trust.json'), 'utf8')).keys[0];
  const publicKey = readFileSync(join(root, `.verythinker/native/keys/${keyId}.pem`), 'utf8');
  assert.equal(hash(publicKey), keyId);
  mkdirSync(join(root, '.verythinker/native/receipts'), { recursive: true });

  function signedReceipt(stage) {
    const role = stage === 'planner' ? 'manager' : 'developer';
    const id = randomUUID();
    const base = {
      schema_version: 1, issuer: 'verythinker-codex-app-server', execution_mode: 'native', id,
      receipt_path: `.verythinker/native/receipts/${id}.json`, project_id: readConfig(root).project_id,
      role, workflow_id: workflow.meta.id, task_id: stage === 'producer' ? task.meta.id : null,
      request_id: randomUUID(), prior_invocation_id: null,
      input_text: `Synthetic signed ${stage} authority test fixture; no native API call or inference occurred.`,
      input_sha256: hash(`Synthetic signed ${stage} authority test fixture; no native API call or inference occurred.`),
      requested_model: stage === 'planner' ? 'gpt-6-luna' : 'gpt-6-luna', confirmed_model: 'gpt-6-luna',
      model_provider: 'test-fixture', native_sandbox: 'readOnly', native_tool_scope: [], gateway_policy_sha256: null,
      reasoning_effort: stage === 'planner' ? 'max' : 'medium', confirmed_reasoning_effort: stage === 'planner' ? 'max' : 'medium',
      client_version: '0.162.1', runtime_integrity: integrity, protocol_sha256: hash('synthetic signed receipt protocol fixture'),
      routing_sha256: hash(canonicalJson(JSON.parse(readFileSync(join(root, '.verythinker/routing.json'), 'utf8')))),
      configuration_hashes: routingConfigurationHashes(root), effective_configuration_sha256: null,
      native_thread_id: `synthetic-${id}`, native_turn_id: `synthetic-turn-${id}`, state: 'completed',
      inference_completed: false, output: 'Synthetic signed receipt only.', error: null, fallback_evidence: null,
      reroutes: [], permissions: [], owner_pid: process.pid, server_pid: null,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(), key_id: keyId,
    };
    const receipt = { ...base, fast_grant: issueFastGrant(root, base, stage, stage === 'producer' ? task.meta.id : null) };
    receipt.signature = sign(null, Buffer.from(canonicalJson(receipt)), privateKey).toString('base64');
    writeFileSync(join(root, receipt.receipt_path), JSON.stringify(receipt));
    return receipt;
  }
  function freezePlan() {
    const fingerprint = fastPlanFingerprint(root, workflow.meta.id, [task.meta.id]);
    updateRecord(root, workflow.meta.id, { data: { fast_plan: {
      task_ids: [task.meta.id], fingerprint, summary: 'Synthetic fixture plan.',
    } } });
    return fingerprint;
  }
  function refreshReceipt(id, patch) {
    const path = join(root, `.verythinker/native/receipts/${id}.json`);
    const { signature, ...original } = JSON.parse(readFileSync(path, 'utf8'));
    const unsigned = { ...original, ...patch };
    writeFileSync(path, JSON.stringify({ ...unsigned,
      signature: sign(null, Buffer.from(canonicalJson(unsigned)), privateKey).toString('base64') }));
  }
  return { root, workflow, selection, requirement, task, check, signedReceipt, freezePlan, refreshReceipt };
}

test('synthetic signed planner and producer grants route standard responsibility aliases and bound operations', async (t) => {
  const f = fixture(t);
  const planner = f.signedReceipt('planner');
  assert.deepEqual(fastGrantProblems(f.root, planner, { phase: 'planning' }), []);
  assert.equal(fastResponsibility(f.root, planner, 'requirement'), 'requirements');
  assert.equal(fastResponsibility(f.root, planner, 'design'), 'architect');
  assert.equal(fastResponsibility(f.root, planner, 'check'), 'verifier');
  for (const alias of ['requirements', 'architect', 'verifier']) assert.equal(hasFastResponsibility(f.root, planner, alias), true);
  assert.ok(authorizeFastOperation(f.root, planner, 'project_read', { path: 'src/module.mjs' }));
  assert.ok(authorizeFastOperation(f.root, planner, 'record_get', { record_id: f.task.meta.id }));
  assert.ok(authorizeFastOperation(f.root, planner, 'task_context', { record_id: f.task.meta.id }));
  assert.ok(authorizeFastOperation(f.root, planner, 'record_create', {
    workflow_id: f.workflow.meta.id, record_type: 'design',
    record_data: { workflow_id: f.workflow.meta.id },
    links: [{ type: 'satisfies', target: f.requirement.meta.id }],
  }));
  assert.throws(() => authorizeFastOperation(f.root, planner, 'native_dispatch'), /cannot use/);

  updateRecord(f.root, f.workflow.meta.id, { data: { fast_stage: 'production' } });
  f.freezePlan();
  const producer = f.signedReceipt('producer');
  assert.deepEqual(fastGrantProblems(f.root, producer, { phase: 'production' }), []);
  assert.equal(hasFastResponsibility(f.root, producer, 'developer'), true);
  assert.equal(hasFastResponsibility(f.root, producer, 'check-executor'), true);
  assert.ok(authorizeFastOperation(f.root, producer, 'task_start', { workflow_id: f.workflow.meta.id, task_id: f.task.meta.id }));
  assert.ok(authorizeFastOperation(f.root, producer, 'task_resume', { workflow_id: f.workflow.meta.id, task_id: f.task.meta.id }));
  assert.ok(authorizeFastOperation(f.root, producer, 'task_file_write', { path: 'src/module.mjs' }));
  assert.ok(authorizeFastOperation(f.root, producer, 'check_run', { check_id: f.check.meta.id }));
  assert.ok(authorizeFastOperation(f.root, producer, 'project_read', { path: 'src/contract.json' }));
  assert.deepEqual(fastOperations('producer').includes('native_dispatch'), false);
  await assertFastReadinessBlocked(f.root, f.task.meta.id);
});

async function assertFastReadinessBlocked(root, taskId) {
  await assert.rejects(assertFastProducerReady(root, taskId), /independently reviewed design-ready/i);
}

test('Fast planner and producer deny wrong workflow, task, paths, checks, phases, replay, and public dispatch', (t) => {
  const f = fixture(t);
  const planner = f.signedReceipt('planner');
  assert.throws(() => authorizeFastOperation(f.root, planner, 'record_create', { workflow_id: 'WF-WRONG', record_type: 'design' }), /escapes its workflow/);
  assert.throws(() => authorizeFastOperation(f.root, planner, 'task_file_write', { path: 'src/module.mjs' }), /cannot write project files/);
  updateRecord(f.root, f.workflow.meta.id, { data: { fast_stage: 'production' } });
  f.freezePlan();
  const producer = f.signedReceipt('producer');
  assert.throws(() => authorizeFastOperation(f.root, producer, 'task_start', { workflow_id: f.workflow.meta.id, task_id: 'TASK-WRONG' }), /exact assigned workflow and task/);
  assert.throws(() => authorizeFastOperation(f.root, producer, 'task_file_write', { path: 'src/contract.json' }), /outside its exact editable scope/);
  assert.throws(() => authorizeFastOperation(f.root, producer, 'task_file_write', { path: 'src/module.mjs', paths: ['src/module.mjs', 'src/contract.json'] }), /exact approved path/);
  assert.throws(() => authorizeFastOperation(f.root, producer, 'check_run', { check_id: 'CHECK-WRONG' }), /unapproved check/);
  assert.throws(() => authorizeFastOperation(f.root, producer, 'record_update', { record_id: f.requirement.meta.id }), /cannot author planning records/);
  assert.throws(() => authorizeFastOperation(f.root, producer, 'native_dispatch'), /cannot use/);
  assert.ok(fastGrantProblems(f.root, producer, { phase: 'planning' }).some((problem) => /outside its authorized phase/.test(problem)));
  updateRecord(f.root, f.workflow.meta.id, { data: { fast_stage: 'final-review' } });
  assert.throws(() => authorizeFastOperation(f.root, producer, 'task_file_write', { path: 'src/module.mjs' }), /outside the active production phase/);
});

test('Fast signed authority rejects receipt tampering, changed protected/config inputs, stale workflow selection, and replay', (t) => {
  const f = fixture(t);
  const planner = f.signedReceipt('planner');
  const tampered = { ...planner, fast_grant: { ...planner.fast_grant, allowed_operations: [...planner.fast_grant.allowed_operations, 'native_dispatch'] } };
  assert.ok(fastGrantProblems(f.root, tampered).some((problem) => /signed persisted native receipt|operation contract/i.test(problem)));
  writeFileSync(join(f.root, '.verythinker/config.json'), readFileSync(join(f.root, '.verythinker/config.json'), 'utf8') + '\n');
  assert.ok(fastGrantProblems(f.root, planner).some((problem) => /configuration changed/i.test(problem)));

  const g = fixture(t);
  const grant = g.signedReceipt('planner');
  writeFileSync(join(g.root, 'src/contract.json'), '{"enabled":false}\n');
  assert.ok(fastGrantProblems(g.root, grant).some((problem) => /Protected fast input changed/i.test(problem)));

  const h = fixture(t);
  const stale = h.signedReceipt('planner');
  updateRecord(h.root, h.workflow.meta.id, { data: { execution_policy_selection: { ...h.selection, selection_fingerprint: '0'.repeat(64) } } });
  assert.ok(fastGrantProblems(h.root, stale).some((problem) => /selection/i.test(problem)));
});

test('Fast authority tolerates only bridge output, timestamp and signature refreshes', (t) => {
  const f = fixture(t);
  const planner = f.signedReceipt('planner');
  f.refreshReceipt(planner.id, { output: 'Native bridge persisted its actual output.', updated_at: new Date(Date.now() + 1000).toISOString() });
  assert.deepEqual(fastGrantProblems(f.root, planner, { phase: 'planning' }), []);
  for (const mutation of [
    { state: 'blocked' },
    { confirmed_model: 'gpt-5.6-terra' },
    { permissions: [{ method: 'approval/request', request_id: 'request-1', reason: 'unexpected', at: new Date().toISOString() }] },
  ]) {
    const changed = { ...planner, ...mutation };
    assert.ok(fastGrantProblems(f.root, changed).some((problem) => /signed persisted native receipt/i.test(problem)));
  }
  const changedGrant = { ...planner, fast_grant: { ...planner.fast_grant, task_id: 'other-task' } };
  assert.ok(fastGrantProblems(f.root, changedGrant).some((problem) => /signed persisted native receipt|another invocation/i.test(problem)));
});

test('rehashed intake edits and a changed frozen plan cannot mint Fast authority', (t) => {
  const f = fixture(t);
  const changedCore = { ...f.selection, baseline_inputs: { ...f.selection.baseline_inputs, 'src/module.mjs': hash('forged baseline') } };
  delete changedCore.selection_fingerprint;
  const changedSelection = { ...changedCore, selection_fingerprint: hash(canonicalJson(changedCore)) };
  updateRecord(f.root, f.workflow.meta.id, { data: { execution_policy_selection: changedSelection } });
  assert.throws(() => f.signedReceipt('planner'), /signed intake snapshot/);

  const g = fixture(t);
  g.freezePlan();
  updateRecord(g.root, g.task.meta.id, { data: { acceptance_criteria: ['Changed after plan freeze.'] } });
  updateRecord(g.root, g.workflow.meta.id, { data: { fast_stage: 'production' } });
  assert.throws(() => g.signedReceipt('producer'), /changed independently reviewed plan/);
});

test('producer plan freezes task and direct-design oracles plus material repair feedback', (t) => {
  const f = fixture(t);
  const design = createRecord(f.root, {
    type: 'design', title: 'Storage contract', owner: 'architect',
    links: [{ type: 'satisfies', target: f.requirement.meta.id }],
    data: { workflow_id: f.workflow.meta.id, interfaces: ['The contract file remains readable.'] },
  });
  const implementedDesign = createRecord(f.root, {
    type: 'design', title: 'Task implementation detail', owner: 'architect',
    data: { workflow_id: f.workflow.meta.id, interfaces: ['The task preserves the stored default.'] },
  });
  updateRecord(f.root, f.task.meta.id, {
    links: [...f.task.meta.links, { type: 'implements', target: implementedDesign.meta.id }],
  });
  const taskOracle = createRecord(f.root, {
    type: 'check', title: 'Task-specific oracle', owner: 'verifier',
    links: [{ type: 'verifies', target: f.task.meta.id }],
    data: { oracle_paths: ['src/contract.json'] },
  });
  const designOracle = createRecord(f.root, {
    type: 'check', title: 'Design-specific oracle', owner: 'verifier',
    links: [{ type: 'verifies', target: design.meta.id }],
    data: { oracle_paths: ['src/contract.json'] },
  });
  const implementedDesignOracle = createRecord(f.root, {
    type: 'check', title: 'Implemented design oracle', owner: 'verifier',
    links: [{ type: 'verifies', target: implementedDesign.meta.id }],
    data: { oracle_paths: ['src/contract.json'] },
  });
  updateRecord(f.root, f.workflow.meta.id, { data: { fast_stage: 'production' } });
  f.freezePlan();
  const producer = f.signedReceipt('producer');
  assert.deepEqual(
    producer.fast_grant.protected_check_ids,
    [f.check.meta.id, taskOracle.meta.id, designOracle.meta.id, implementedDesignOracle.meta.id].sort(),
  );
  assert.deepEqual(fastGrantProblems(f.root, producer, { phase: 'production' }), []);

  const priorFingerprint = producer.fast_grant.plan_sha256;
  updateRecord(f.root, designOracle.meta.id, {}, '# Changed direct-design oracle\n');
  assert.ok(fastGrantProblems(f.root, producer).some((problem) => /plan changed after approval/i.test(problem)));
  assert.notEqual(fastPlanFingerprint(f.root, f.workflow.meta.id), priorFingerprint);

  const implementedFingerprint = fastPlanFingerprint(f.root, f.workflow.meta.id);
  updateRecord(f.root, implementedDesign.meta.id, {}, '# Changed task-implemented design\n');
  assert.notEqual(fastPlanFingerprint(f.root, f.workflow.meta.id), implementedFingerprint);

  const g = fixture(t);
  updateRecord(g.root, g.workflow.meta.id, { data: { fast_stage: 'production' } });
  g.freezePlan();
  const grant = g.signedReceipt('producer');
  updateRecord(g.root, g.task.meta.id, { data: { feedback: 'Repair must retain the protected storage contract.' } });
  assert.ok(fastGrantProblems(g.root, grant).some((problem) => /plan changed after approval/i.test(problem)));
});

test('Fast plan fingerprints require applicable oracle coverage for every protected input', (t) => {
  const f = fixture(t);
  updateRecord(f.root, f.check.meta.id, { data: { oracle_paths: [], baseline_paths: [] } });
  assert.throws(
    () => fastPlanFingerprint(f.root, f.workflow.meta.id, [f.task.meta.id]),
    /no applicable check oracle or baseline.*src\/contract\.json/i,
  );
});
