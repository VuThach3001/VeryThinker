import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import {
  initialize,
  loadRecords,
  getRecord,
  createRecord,
  hash,
  readConfig,
} from '../dist/storage.js';
import { managedRun } from '../dist/managed.js';
import {
  canonicalJson,
  defaultRoutingPolicy,
  ensureRoutingPolicy,
  priorDefaultRoutingPolicy,
  readRoutingPolicy,
  roleModelPolicy,
  routingConfigurationHashes,
  routingBindingProblems,
  routingProblems,
  strongRoles,
  workerRoles,
} from '../dist/routing.js';
function project(t) {
  const root = mkdtempSync(join(tmpdir(), 'verythinker-routing-'));
  initialize(root);
  t.after(() => {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    rmSync(root, { recursive: true, force: true });
  });
  return root;
}
test('legacy core projects keep existing API compatibility until routing migration', (t) => {
  const root = project(t);
  assert.equal(readRoutingPolicy(root), null);
  assert.deepEqual(routingProblems(root, 'developer', 'legacy-invocation'), []);
  ensureRoutingPolicy(root);
  assert.match(
    routingProblems(root, 'developer', 'legacy-invocation').join(' '),
    /cannot be verified/,
  );
});
test('authored Codex model overrides block strict routing while other platform choices survive', (t) => {
  const root = project(t);
  ensureRoutingPolicy(root);
  const path = join(root, '.verythinker/config.json');
  const config = JSON.parse(readFileSync(path, 'utf8'));
  config.models.strong = { claude: 'authored-claude-model', codex: 'gpt-6-luna' };
  config.models.economy = { copilot: 'authored-copilot-model' };
  writeFileSync(path, JSON.stringify(config));
  assert.deepEqual(roleModelPolicy(root, 'reviewer').models, ['gpt-6-luna']);
  config.models.economy.codex = 'gpt-5.6-terra';
  writeFileSync(path, JSON.stringify(config));
  assert.throws(() => roleModelPolicy(root, 'developer'), /economy model mapping conflicts/);
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).models.economy.codex, 'gpt-5.6-terra');
});
test('approved provider installations do not invalidate routing policy fingerprints', (t) => {
  const root = project(t);
  ensureRoutingPolicy(root);
  const prior = routingConfigurationHashes(root);
  writeFileSync(
    join(root, '.verythinker/tool-lock.json'),
    JSON.stringify({ providers: ['codegraph'] }),
  );
  assert.deepEqual(routingConfigurationHashes(root), prior);
  writeFileSync(join(root, '.verythinker/tools.json'), JSON.stringify({ approved_providers: [] }));
  assert.notDeepEqual(routingConfigurationHashes(root), prior);
});
test('only exact legacy Sol/high and current Luna/max policies are accepted', (t) => {
  const root = project(t);
  const path = join(root, '.verythinker/routing.json');
  writeFileSync(path, JSON.stringify(priorDefaultRoutingPolicy(), null, 2));
  const legacy = roleModelPolicy(root, 'reviewer');
  assert.deepEqual(legacy.models, ['gpt-6.1-sol']);
  assert.equal(legacy.reasoning_effort, 'high');
  const unapprovedEffort = { ...defaultRoutingPolicy(), strong_effort: 'xhigh' };
  writeFileSync(path, JSON.stringify(unapprovedEffort, null, 2));
  assert.throws(() => readRoutingPolicy(root), /approved strategic Luna\/max policy/);
  writeFileSync(path, JSON.stringify(defaultRoutingPolicy(), null, 2));
  assert.deepEqual(roleModelPolicy(root, 'reviewer').models, ['gpt-6-luna']);
  assert.equal(roleModelPolicy(root, 'reviewer').reasoning_effort, 'max');
});
test('xhigh strategic acknowledgment is rejected by the Luna/max receipt gate', (t) => {
  const root = project(t);
  const policy = ensureRoutingPolicy(root);
  const integrity =
    'sha512-NWZdi/kxyjv/8EUGFupziGU38YyleugZRM4JXgY5XFH7FUmaFA33NZS2Bmq0HPazf7S3jJQQWsZ/jAK9jsrV3Q==';
  const protocol = hash('routing policy unit fixture');
  writeFileSync(
    join(root, '.verythinker/native-runtime.lock.json'),
    JSON.stringify({ version: '0.162.1', integrity, protocol_sha256: protocol }),
  );
  const keyPair = generateKeyPairSync('ed25519');
  const publicKey = keyPair.publicKey.export({ type: 'spki', format: 'pem' });
  const keyId = hash(publicKey);
  mkdirSync(join(root, '.verythinker/native/keys'), { recursive: true });
  mkdirSync(join(root, '.verythinker/native/receipts'), { recursive: true });
  writeFileSync(join(root, `.verythinker/native/keys/${keyId}.pem`), publicKey);
  writeFileSync(join(root, '.verythinker/native/trust.json'), JSON.stringify({ keys: [keyId] }));
  const id = randomUUID();
  const unsigned = {
    schema_version: 1,
    issuer: 'verythinker-codex-app-server',
    execution_mode: 'native',
    id,
    receipt_path: `.verythinker/native/receipts/${id}.json`,
    project_id: readConfig(root).project_id,
    role: 'reviewer',
    workflow_id: null,
    task_id: null,
    request_id: null,
    prior_invocation_id: null,
    input_text: 'Fabricated signature fixture for the receipt gate.',
    input_sha256: hash('Fabricated signature fixture for the receipt gate.'),
    requested_model: 'gpt-6-luna',
    confirmed_model: 'gpt-6-luna',
    model_provider: 'unit-test',
    native_sandbox: 'readOnly',
    native_tool_scope: [],
    gateway_policy_sha256: null,
    reasoning_effort: 'xhigh',
    confirmed_reasoning_effort: 'xhigh',
    client_version: '0.162.1',
    runtime_integrity: integrity,
    protocol_sha256: protocol,
    routing_sha256: hash(canonicalJson(policy)),
    configuration_hashes: routingConfigurationHashes(root),
    effective_configuration_sha256: null,
    native_thread_id: `unit-${id}`,
    native_turn_id: `turn-${id}`,
    state: 'completed',
    inference_completed: true,
    output: 'Fabricated unit fixture; no native inference occurred.',
    error: null,
    fallback_evidence: null,
    reroutes: [],
    permissions: [],
    owner_pid: process.pid,
    server_pid: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    key_id: keyId,
  };
  writeFileSync(
    join(root, unsigned.receipt_path),
    JSON.stringify({
      ...unsigned,
      signature: sign(null, Buffer.from(canonicalJson(unsigned)), keyPair.privateKey).toString(
        'base64',
      ),
    }),
  );
  assert.match(
    routingProblems(root, 'reviewer', id).join(' '),
    /reasoning effort does not match the role policy/,
  );
});
test('all strategic roles use exclusively Luna at max and routine roles use documented worker fallback', (t) => {
  const root = project(t);
  ensureRoutingPolicy(root);
  for (const role of strongRoles) {
    const policy = roleModelPolicy(root, role);
    assert.deepEqual(policy.models, ['gpt-6-luna']);
    assert.equal(policy.reasoning_effort, 'max');
  }
  for (const role of workerRoles) {
    const policy = roleModelPolicy(root, role);
    assert.deepEqual(policy.models, ['gpt-6-luna', 'gpt-5.6-terra']);
    assert.equal(policy.reasoning_effort, 'medium');
  }
  assert.throws(() => roleModelPolicy(root, 'unknown'), /Unsupported/);
  assert.match(routingProblems(root, 'reviewer', undefined).join(' '), /bridge-issued/);
});
test('migration preserves authored routing conflicts for review', (t) => {
  const root = project(t);
  ensureRoutingPolicy(root);
  const path = join(root, '.verythinker/routing.json');
  const original = JSON.parse(readFileSync(path, 'utf8'));
  original.strong_model = 'custom-model';
  writeFileSync(path, JSON.stringify(original));
  assert.throws(() => ensureRoutingPolicy(root), /approved strategic Luna\/max policy/);
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).strong_model, 'custom-model');
});
test('managed resumption preserves increment identity and reports policy blockers without launching inference', async (t) => {
  const root = project(t);
  const started = await managedRun(root, {
    requirements: [
      'Validate declared integer bounds.',
      'Persist accepted configuration atomically.',
    ],
  });
  assert.match(started.blocker, /Strict native routing must be installed/);
  assert.equal(started.invocation, undefined);
  const workflowId = started.workflow.workflow_id;
  const incrementId = started.workflow.increment_id;
  const resumed = await managedRun(root, { workflow_id: workflowId });
  assert.equal(resumed.workflow.increment_id, incrementId);
  assert.equal(
    loadRecords(root).filter((record) => record.meta.data.kind === 'manager-workflow').length,
    1,
  );
  await assert.rejects(
    managedRun(root, { workflow_id: workflowId, requirement: 'An unrelated new requirement.' }),
    /differ from the saved increment/,
  );
  assert.equal(getRecord(root, workflowId).meta.data.original_requirements.length, 2);
  ensureRoutingPolicy(root);
  const path = join(root, '.verythinker/config.json');
  const config = JSON.parse(readFileSync(path, 'utf8'));
  config.models.strong = 'unapproved-model';
  writeFileSync(path, JSON.stringify(config));
  const conflicted = await managedRun(root, { workflow_id: workflowId });
  assert.match(conflicted.blocker, /strong model mapping conflicts/);
  assert.equal(conflicted.invocation, undefined);
});
test('workflow-wide strategic binding covers only a target task in that explicitly bound workflow', (t) => {
  const root = project(t);
  const task = createRecord(root, {
    type: 'task',
    title: 'Review planned component',
    data: { workflow_id: 'workflow-a' },
  });
  const scope = { role: 'reviewer', task_id: null, workflow_id: 'workflow-a' };
  const target = { task_id: task.meta.id, workflow_id: 'workflow-a' };
  assert.deepEqual(routingBindingProblems(root, scope, target), []);
  assert.match(
    routingBindingProblems(root, { ...scope, role: 'developer' }, target).join(' '),
    /different task/,
  );
  assert.match(
    routingBindingProblems(root, scope, { task_id: task.meta.id }).join(' '),
    /different task/,
  );
  assert.match(
    routingBindingProblems(
      root,
      { ...scope, workflow_id: 'workflow-b' },
      { ...target, workflow_id: 'workflow-b' },
    ).join(' '),
    /different task/,
  );
  assert.match(
    routingBindingProblems(root, { ...scope, task_id: 'another-task' }, target).join(' '),
    /different task/,
  );
});
