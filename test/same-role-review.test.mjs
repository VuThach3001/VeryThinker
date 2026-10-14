import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../dist/mcp.js';
import {
  initialize,
  createRecord,
  updateRecord,
  ensureRoutingPolicy,
  hash,
  canonicalJson,
  routingConfigurationHashes,
  reviewRecord,
  hasCurrentReview,
  getRecord,
  beginWorkflow,
  bindManagerInvocation,
} from '../dist/index.js';

function fixture(t, strict = true) {
  const root = mkdtempSync(join(tmpdir(), 'verythinker-independent-same-role-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  initialize(root, { project_id: 'SAME-ROLE', profile: 'basic' });
  const workflow = createRecord(root, {
    type: 'knowledge',
    title: 'Fixture workflow',
    owner: 'manager',
    data: { kind: 'manager-workflow', task_ids: [] },
  });
  const target = createRecord(root, {
    type: 'task',
    title: 'Reviewer documentation assignment',
    owner: 'reviewer',
    status: 'submitted',
    data: { workflow_id: workflow.meta.id, routing_required: strict },
  });
  updateRecord(root, workflow.meta.id, { data: { task_ids: [target.meta.id] } });
  if (!strict) return { root, workflow, target };
  const policy = ensureRoutingPolicy(root);
  const keys = generateKeyPairSync('ed25519');
  const pem = keys.publicKey.export({ type: 'spki', format: 'pem' }),
    keyId = hash(pem);
  mkdirSync(join(root, '.verythinker/native/keys'), { recursive: true });
  mkdirSync(join(root, '.verythinker/native/receipts'), { recursive: true });
  writeFileSync(join(root, `.verythinker/native/keys/${keyId}.pem`), pem);
  writeFileSync(join(root, '.verythinker/native/trust.json'), JSON.stringify({ keys: [keyId] }));
  const integrity =
      'sha512-NWZdi/kxyjv/8EUGFupziGU38YyleugZRM4JXgY5XFH7FUmaFA33NZS2Bmq0HPazf7S3jJQQWsZ/jAK9jsrV3Q==',
    protocol = hash('same role protocol fixture');
  writeFileSync(
    join(root, '.verythinker/native-runtime.lock.json'),
    JSON.stringify({ version: '0.162.1', integrity, protocol_sha256: protocol }),
  );
  // Deliberately fabricated signed unit fixtures: never account/inference evidence.
  const receipt = (taskId, overrides = {}) => {
    const id = randomUUID();
    const data = {
      schema_version: 1,
      issuer: 'verythinker-codex-app-server',
      execution_mode: 'native',
      id,
      receipt_path: `.verythinker/native/receipts/${id}.json`,
      project_id: 'SAME-ROLE',
      role: 'reviewer',
      workflow_id: workflow.meta.id,
      task_id: taskId,
      request_id: null,
      prior_invocation_id: null,
      input_text: 'FABRICATED UNIT FIXTURE; no authenticated model execution.',
      input_sha256: hash('fixture'),
      requested_model: 'gpt-6-luna',
      confirmed_model: 'gpt-6-luna',
      model_provider: 'unit-fixture',
      native_sandbox: 'readOnly',
      native_shell_policy: 'read-only',
      native_shell_policy_confirmed: true,
      native_tool_scope: ['record_review'],
      gateway_policy_sha256: null,
      reasoning_effort: 'max',
      confirmed_reasoning_effort: 'max',
      client_version: '0.162.1',
      runtime_integrity: integrity,
      protocol_sha256: protocol,
      routing_sha256: hash(canonicalJson(policy)),
      configuration_hashes: routingConfigurationHashes(root),
      effective_configuration_sha256: null,
      native_thread_id: `unit-thread-${id}`,
      native_turn_id: `unit-turn-${id}`,
      state: 'completed',
      inference_completed: true,
      output: 'Fabricated unit state.',
      error: null,
      fallback_evidence: null,
      reroutes: [],
      permissions: [],
      owner_pid: process.pid,
      server_pid: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      key_id: keyId,
      ...overrides,
    };
    writeFileSync(
      join(root, data.receipt_path),
      JSON.stringify({
        ...data,
        signature: sign(null, Buffer.from(canonicalJson(data)), keys.privateKey).toString('base64'),
      }),
    );
    return data;
  };
  const producer = receipt(target.meta.id);
  updateRecord(root, target.meta.id, { data: { invocation_id: producer.id } });
  return { root, workflow, target, receipt, producer };
}
test('a different signed taskless reviewer thread can review a reviewer-owned assignment', (t) => {
  const f = fixture(t),
    reviewer = f.receipt(null);
  reviewRecord(f.root, f.target.meta.id, 'reviewer', 'pass', [], reviewer.id);
  assert.equal(hasCurrentReview(f.root, f.target.meta.id), true);
});
test('same producer thread, resumed producer lineage and task-bound reviewer cannot self-review', (t) => {
  const f = fixture(t);
  for (const candidate of [
    f.producer,
    f.receipt(null, { native_thread_id: f.producer.native_thread_id }),
    f.receipt(null, {
      native_thread_id: f.producer.native_thread_id,
      prior_invocation_id: f.producer.id,
    }),
    f.receipt(f.target.meta.id),
  ]) {
    assert.throws(
      () => reviewRecord(f.root, f.target.meta.id, 'reviewer', 'pass', [], candidate.id),
      /different owner|independent/,
    );
  }
});
test('legacy same-owner review still has no independent native proof', (t) => {
  const f = fixture(t, false);
  assert.throws(
    () => reviewRecord(f.root, f.target.meta.id, 'reviewer', 'pass', [], 'invented-review'),
    /different owner|independent/,
  );
});
test('manager invocation acknowledgment is idempotent after validation', (t) => {
  const f = fixture(t),
    coordinator = f.receipt(null, {
      role: 'manager',
      state: 'running',
      inference_completed: false,
    });
  bindManagerInvocation(f.root, f.workflow.meta.id, coordinator.id);
  const before = getRecord(f.root, f.workflow.meta.id);
  const acknowledged = bindManagerInvocation(f.root, f.workflow.meta.id, coordinator.id);
  assert.equal(acknowledged.meta.revision, before.meta.revision);
});
test('a taskless reviewer cannot create or update its scoped review documentation through MCP', async (t) => {
  const f = fixture(t);
  const document = createRecord(f.root, {
    type: 'knowledge',
    owner: 'reviewer',
    title: 'Protected review target',
    data: { workflow_id: f.workflow.meta.id, task_id: f.target.meta.id },
    links: [{ type: 'documents', target: f.target.meta.id }],
  });
  const inspector = f.receipt(null, {
    state: 'running',
    inference_completed: false,
    native_tool_scope: ['record_create', 'record_update', 'record_review'],
  });
  const server = createMcpServer(f.root, { invocation_id: inspector.id });
  const client = new Client({ name: 'same-role-review-fixture', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    for (const request of [
      { name: 'record_update', arguments: { id: document.meta.id, body: 'Altered review target' } },
      {
        name: 'record_create',
        arguments: {
          type: 'knowledge',
          title: 'Unassigned review mutation',
          owner: 'reviewer',
          data: {},
        },
      },
    ]) {
      const result = await client.callTool(request);
      assert.equal(result.isError, true);
      const error = JSON.parse(result.content.find((block) => block.type === 'text').text).error;
      assert.match(error, /read-only artifact access/);
    }
    assert.equal(getRecord(f.root, document.meta.id).meta.revision, document.meta.revision);
  } finally {
    await client.close();
    await server.close();
  }
});
