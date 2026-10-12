import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import {
  initialize,
  createRecord,
  updateRecord,
  getRecord,
  hash,
  readConfig,
} from '../dist/storage.js';
import { beginWorkflow } from '../dist/manager.js';
import {
  startTask,
  resumeTask,
  reviewRecord,
  requestRepair,
  verify,
  hasCurrentReview,
} from '../dist/engineering.js';
import {
  ensureRoutingPolicy,
  canonicalJson,
  routingConfigurationHashes,
  strongRoles,
} from '../dist/routing.js';
import { invokeCapability } from '../dist/tools.js';

// Private fabricated validation objects exercise core guards, never native access.
// The production App Server factory still labels injected transports as fixtures.
function validationFixture(work, role, state = 'completed', taskId = null) {
  const { root } = work;
  const policy = ensureRoutingPolicy(root);
  const integrity =
    'sha512-NWZdi/kxyjv/8EUGFupziGU38YyleugZRM4JXgY5XFH7FUmaFA33NZS2Bmq0HPazf7S3jJQQWsZ/jAK9jsrV3Q==';
  const protocol = hash('FABRICATED UNIT VALIDATION FIXTURE');
  writeFileSync(
    join(root, '.verythinker/native-runtime.lock.json'),
    JSON.stringify({ version: '0.162.1', integrity, protocol_sha256: protocol }),
  );
  if (!work.key) {
    work.key = generateKeyPairSync('ed25519');
    const pem = work.key.publicKey.export({ type: 'spki', format: 'pem' });
    work.keyId = hash(pem);
    mkdirSync(join(root, '.verythinker/native/keys'), { recursive: true });
    mkdirSync(join(root, '.verythinker/native/receipts'), { recursive: true });
    writeFileSync(join(root, `.verythinker/native/keys/${work.keyId}.pem`), pem);
    writeFileSync(
      join(root, '.verythinker/native/trust.json'),
      JSON.stringify({ keys: [work.keyId] }),
    );
  }
  const id = randomUUID(),
    strong = strongRoles.includes(role);
  const receipt = {
    schema_version: 1,
    issuer: 'verythinker-codex-app-server',
    execution_mode: 'native',
    id,
    receipt_path: `.verythinker/native/receipts/${id}.json`,
    project_id: readConfig(root).project_id,
    role,
    workflow_id: work.parent.meta.id,
    task_id: taskId,
    request_id: null,
    prior_invocation_id: null,
    input_text: 'FABRICATED UNIT VALIDATION FIXTURE; no native account or inference.',
    input_sha256: hash('FABRICATED UNIT VALIDATION FIXTURE'),
    requested_model: 'gpt-6-luna',
    confirmed_model: 'gpt-6-luna',
    model_provider: 'fabricated-unit-provider',
    native_sandbox: strong ? 'readOnly' : 'workspaceWrite',
    native_tool_scope: [],
    gateway_policy_sha256: null,
    reasoning_effort: strong ? 'max' : 'medium',
    confirmed_reasoning_effort: strong ? 'max' : 'medium',
    client_version: '0.162.1',
    runtime_integrity: integrity,
    protocol_sha256: protocol,
    routing_sha256: hash(canonicalJson(policy)),
    configuration_hashes: routingConfigurationHashes(root),
    effective_configuration_sha256: null,
    native_thread_id: `fabricated-${id}`,
    native_turn_id: `fabricated-turn-${id}`,
    state,
    inference_completed: state === 'completed',
    output: 'Fabricated unit validation; not observed inference.',
    error: null,
    fallback_evidence: null,
    reroutes: [],
    permissions: [],
    owner_pid: process.pid,
    server_pid: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    key_id: work.keyId,
  };
  writeFileSync(
    join(root, receipt.receipt_path),
    JSON.stringify({
      ...receipt,
      signature: sign(null, Buffer.from(canonicalJson(receipt)), work.key.privateKey).toString(
        'base64',
      ),
    }),
  );
  return receipt;
}
function project(t) {
  const root = mkdtempSync(join(tmpdir(), 'verythinker-strict-boundary-'));
  t.after(() => {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    assert.match(root, /verythinker-strict-boundary-/);
    rmSync(root, { recursive: true, force: true });
  });
  initialize(root, { project_id: 'BOUNDARY', profile: 'software' });
  ensureRoutingPolicy(root);
  const parent = beginWorkflow(root, { requirement: 'Export the fixed integer one.' });
  const work = { root, parent };
  const author = validationFixture(work, 'requirements');
  const requirement = updateRecord(root, parent.meta.data.requirement_id, {
    data: {
      acceptance_criteria: ['The named export equals integer one.'],
      invocation_id: author.id,
    },
  });
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src/value.mjs'), 'export const value = 1;\n');
  const architect = validationFixture(work, 'architect');
  const design = createRecord(root, {
    type: 'design',
    title: 'Fixed export interface',
    owner: 'architect',
    links: [{ type: 'satisfies', target: requirement.meta.id }],
    data: {
      workflow_id: parent.meta.id,
      invocation_id: architect.id,
      interfaces: ['value: integer'],
    },
  });
  const task = createRecord(root, {
    type: 'task',
    title: 'Implement fixed export',
    owner: 'developer',
    links: [
      { type: 'satisfies', target: requirement.meta.id },
      { type: 'implements', target: design.meta.id },
    ],
    data: {
      workflow_id: parent.meta.id,
      acceptance_criteria: ['Export one.'],
      allowed_paths: ['src'],
      allowed_urls: ['https://example.com/approved'],
    },
  });
  const strategist = validationFixture(work, 'verifier');
  const check = createRecord(root, {
    type: 'check',
    title: 'Verify fixed export',
    owner: 'verifier',
    links: [{ type: 'verifies', target: requirement.meta.id }],
    data: {
      workflow_id: parent.meta.id,
      invocation_id: strategist.id,
      baseline_paths: ['src'],
      command: [
        process.execPath,
        '--input-type=module',
        '-e',
        'import {value} from "./src/value.mjs"; if(value!==1) process.exit(1)',
      ],
    },
  });
  Object.assign(work, { requirement, design, task, check });
  const reviewer = validationFixture(work, 'reviewer');
  reviewRecord(root, check.meta.id, 'reviewer', 'pass', [], reviewer.id);
  return work;
}

test('strict dispatch requires reviewed design and a resumed invocation rechecks changed contracts', (t) => {
  const work = project(t),
    { root, task } = work;
  const worker = validationFixture(work, 'developer', 'running', task.meta.id);
  assert.throws(
    () => startTask(root, task.meta.id, undefined, undefined, worker.id),
    /Design needs a current independent review/,
  );
  const reviewer = validationFixture(work, 'reviewer');
  reviewRecord(root, work.design.meta.id, 'reviewer', 'pass', [], reviewer.id);
  startTask(root, task.meta.id, undefined, undefined, worker.id);
  updateRecord(root, work.requirement.meta.id, {
    data: { acceptance_criteria: ['The named export equals integer two.'] },
  });
  const resumed = validationFixture(work, 'developer', 'running', task.meta.id);
  assert.throws(() => resumeTask(root, task.meta.id, undefined, undefined, resumed.id), /review/i);
  assert.equal(getRecord(root, task.meta.id).meta.data.invocation_id, worker.id);
});

test('repeated repairs require a completed strategic diagnosis covering the current feedback', (t) => {
  const work = project(t),
    { root, task } = work;
  const reviewer = validationFixture(work, 'reviewer');
  reviewRecord(root, work.design.meta.id, 'reviewer', 'pass', [], reviewer.id);
  startTask(
    root,
    task.meta.id,
    undefined,
    undefined,
    validationFixture(work, 'developer', 'running', task.meta.id).id,
  );
  requestRepair(root, task.meta.id, 'The first implementation violated the declared export value.');
  startTask(
    root,
    task.meta.id,
    undefined,
    undefined,
    validationFixture(work, 'developer', 'running', task.meta.id).id,
  );
  requestRepair(
    root,
    task.meta.id,
    'The repaired implementation still violated the same interface.',
  );
  const next = validationFixture(work, 'developer', 'running', task.meta.id);
  assert.throws(
    () => startTask(root, task.meta.id, undefined, undefined, next.id),
    /strategic reassessment|strategic diagnosis/,
  );
  const diagnosis = validationFixture(work, 'architect');
  const blocked = getRecord(root, task.meta.id);
  updateRecord(root, task.meta.id, {
    data: {
      escalation_reason:
        'Diagnosed incorrect generated interface assumptions; reuse the reviewed export contract and its unchanged check.',
      escalation_invocation_id: diagnosis.id,
      escalation_attempt: blocked.meta.data.attempts,
      escalation_feedback_sha256: hash(blocked.meta.data.feedback),
    },
  });
  assert.equal(
    startTask(root, task.meta.id, undefined, undefined, next.id).meta.status,
    'in-progress',
  );
  updateRecord(root, task.meta.id, {
    data: { feedback: 'A different failure requires fresh strategic diagnosis.' },
  });
  assert.ok(
    verify(root, task.meta.id, 'ready').findings.some(
      (finding) => finding.code === 'missing-sol-reassessment',
    ),
  );
});

test('capability invocation derives task scope when callers omit it and blocks browser escape before installation', async (t) => {
  const work = project(t);
  const worker = validationFixture(work, 'developer', 'running', work.task.meta.id);
  await assert.rejects(
    invokeCapability(work.root, {
      invocation_id: worker.id,
      provider: 'playwright',
      tool: 'browser_navigate',
      arguments: { url: 'https://example.com/outside' },
    }),
    /exact URL.*assigned task/,
  );
  assert.equal(existsSync(join(work.root, '.verythinker/tools/playwright')), false);
});

test('removing installed routing cannot turn strict review or dispatch into legacy authorization', (t) => {
  const work = project(t);
  assert.equal(hasCurrentReview(work.root, work.check.meta.id), true);
  const worker = validationFixture(work, 'developer', 'running', work.task.meta.id);
  rmSync(join(work.root, '.verythinker/routing.json'));
  assert.equal(hasCurrentReview(work.root, work.check.meta.id), false);
  assert.throws(
    () => startTask(work.root, work.task.meta.id, undefined, undefined, worker.id),
    /routing policy is missing/i,
  );
  assert.equal(getRecord(work.root, work.task.meta.id).meta.status, 'draft');
  assert.ok(
    verify(work.root, work.task.meta.id, 'accepted').findings.some(
      (finding) => finding.code === 'native-routing-missing',
    ),
  );
});
