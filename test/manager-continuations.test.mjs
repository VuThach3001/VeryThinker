import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { initialize, createRecord, getRecord, hash, readConfig, updateRecord } from '../dist/storage.js';
import { beginWorkflow, applyManagerContinuations } from '../dist/manager.js';
import { canonicalJson, ensureRoutingPolicy, readRoutingPolicy, routingConfigurationHashes } from '../dist/routing.js';
import { createMcpServer } from '../dist/mcp.js';

function fixture(t, role = 'manager') {
  const root = mkdtempSync(join(tmpdir(), 'vt-manager-continuations-'));
  initialize(root);
  ensureRoutingPolicy(root);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const id = randomUUID();
  const workflow = beginWorkflow(root, { requirement: 'Preserve the existing behavior.', invocation_id: id });
  const pending = [
    { id: 'cont-a', message: 'Keep the old format.', received_at: new Date().toISOString() },
    { id: 'cont-b', message: 'Keep existing answers.', received_at: new Date().toISOString() },
  ];
  updateRecord(root, workflow.meta.id, { data: { pending_continuations: pending, applied_continuation_ids: ['prior-id'] } });
  const source = createRecord(root, { type: 'knowledge', title: 'Reassessment decision', owner: 'manager', data: { kind: 'manager-decision', workflow_id: workflow.meta.id }, body: 'Reviewed the changed request and its effects.' });
  const integrity = 'sha512-NWZdi/kxyjv/8EUGFupziGU38YyleugZRM4JXgY5XFH7FUmaFA33NZS2Bmq0HPazf7S3jJQQWsZ/jAK9jsrV3Q==';
  const protocol = hash('continuation signed fixture');
  writeFileSync(join(root, '.verythinker/native-runtime.lock.json'), JSON.stringify({ version: '0.162.1', integrity, protocol_sha256: protocol }));
  const pair = generateKeyPairSync('ed25519');
  const publicKey = pair.publicKey.export({ type: 'spki', format: 'pem' });
  const keyId = hash(publicKey);
  mkdirSync(join(root, '.verythinker/native/keys'), { recursive: true });
  mkdirSync(join(root, '.verythinker/native/receipts'), { recursive: true });
  writeFileSync(join(root, `.verythinker/native/keys/${keyId}.pem`), publicKey);
  writeFileSync(join(root, '.verythinker/native/trust.json'), JSON.stringify({ keys: [keyId] }));
  const routing = readRoutingPolicy(root);
  const unsigned = {
    schema_version: 1, issuer: 'verythinker-codex-app-server', execution_mode: 'native', id,
    receipt_path: `.verythinker/native/receipts/${id}.json`, project_id: readConfig(root).project_id,
    role, workflow_id: workflow.meta.id, task_id: null, request_id: null, prior_invocation_id: null,
    input_text: 'Signed test fixture; no native inference occurred.', input_sha256: hash('Signed test fixture; no native inference occurred.'),
    requested_model: 'gpt-6-luna', confirmed_model: 'gpt-6-luna', model_provider: 'unit-test',
    native_sandbox: 'readOnly', native_tool_scope: [], gateway_policy_sha256: null,
    reasoning_effort: 'max', confirmed_reasoning_effort: 'max', client_version: '0.162.1',
    runtime_integrity: integrity, protocol_sha256: protocol, routing_sha256: hash(canonicalJson(routing)),
    configuration_hashes: routingConfigurationHashes(root), effective_configuration_sha256: null,
    native_thread_id: `thread-${id}`, native_turn_id: `turn-${id}`, state: 'running',
    inference_completed: false, output: '', error: null, fallback_evidence: null, reroutes: [], permissions: [],
    owner_pid: process.pid, server_pid: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), key_id: keyId,
  };
  writeFileSync(join(root, unsigned.receipt_path), JSON.stringify({ ...unsigned, signature: sign(null, Buffer.from(canonicalJson(unsigned)), pair.privateKey).toString('base64') }));
  return { root, workflow, source, pending, id };
}

test('manager continuation disposition is explicit, atomic, idempotent, and preserves later arrivals', async (t) => {
  const f = fixture(t);
  const apply = (continuation_ids) => applyManagerContinuations(f.root, f.workflow.meta.id, f.id, {
    continuation_ids, rationale: 'Reassessed the request and confirmed both constraints remain in scope.', source_ids: [f.source.meta.id],
  });
  assert.throws(() => apply(['cont-a', 'missing']), /known and pending/);
  assert.deepEqual(getRecord(f.root, f.workflow.meta.id).meta.data.applied_continuation_ids, ['prior-id']);
  const server = createMcpServer(f.root, { invocation_id: f.id });
  const client = new Client({ name: 'continuation-scope-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => { await client.close(); await server.close(); });
  const original = await client.callTool({ name: 'record_update', arguments: { id: f.workflow.meta.id, data: { applied_continuation_ids: ['cont-a'] } } });
  assert.equal(original.isError, true);
  assert.match(JSON.parse(original.content[0].text).error, /Generic workflow updates support only/);
  const discovery = (await client.listTools()).tools.map((tool) => tool.name);
  assert.ok(discovery.includes('manager_apply_continuations'));
  const response = await client.callTool({ name: 'manager_apply_continuations', arguments: { workflow_id: f.workflow.meta.id, continuation_ids: ['cont-a'], rationale: 'Reassessed the request and confirmed the constraint remains in scope.', source_ids: [f.source.meta.id] } });
  assert.equal(response.isError, undefined);
  const first = JSON.parse(response.content[0].text);
  assert.deepEqual(first.applied_continuation_ids, ['prior-id', 'cont-a']);
  assert.deepEqual(first.pending_continuations.map((entry) => entry.id), ['cont-b']);
  const revision = getRecord(f.root, f.workflow.meta.id).meta.revision;
  const retryResponse = await client.callTool({ name: 'manager_apply_continuations', arguments: { workflow_id: f.workflow.meta.id, continuation_ids: ['cont-a'], rationale: 'Reassessed the request and confirmed the constraint remains in scope.', source_ids: [f.source.meta.id] } });
  const retry = JSON.parse(retryResponse.content[0].text);
  assert.equal(retry.disposition_id, first.disposition_id);
  assert.equal(getRecord(f.root, f.workflow.meta.id).meta.revision, revision);
  updateRecord(f.root, f.workflow.meta.id, { data: { pending_continuations: [...f.pending, { id: 'cont-new', message: 'Newer input.' }] } });
  const second = apply(['cont-b']);
  assert.deepEqual(second.pending_continuations.map((entry) => entry.id), ['cont-new']);
});

test('continuation retries must match the complete recorded batch', (t) => {
  const f = fixture(t);
  const input = { rationale: 'Reassessed both constraints.', source_ids: [f.source.meta.id] };
  const first = applyManagerContinuations(f.root, f.workflow.meta.id, f.id, { ...input, continuation_ids: ['cont-a', 'cont-b'] });
  const before = getRecord(f.root, f.workflow.meta.id).meta.revision;
  assert.throws(() => applyManagerContinuations(f.root, f.workflow.meta.id, f.id, { ...input, continuation_ids: ['cont-a'] }), /already applied/);
  assert.equal(getRecord(f.root, f.workflow.meta.id).meta.revision, before);
  const retry = applyManagerContinuations(f.root, f.workflow.meta.id, f.id, { ...input, continuation_ids: ['cont-b', 'cont-a'] });
  assert.equal(retry.disposition_id, first.disposition_id);
  assert.equal(retry.revision, before);
});

test('continuation sources reject an unprotected reassessment record kind', (t) => {
  const f = fixture(t);
  const source = createRecord(f.root, { type: 'knowledge', title: 'Unprotected source', owner: 'researcher', data: { kind: 'manager-reassessment', workflow_id: f.workflow.meta.id } });
  const before = getRecord(f.root, f.workflow.meta.id).meta.revision;
  assert.throws(() => applyManagerContinuations(f.root, f.workflow.meta.id, f.id, { continuation_ids: ['cont-a'], rationale: 'Reassessed constraints.', source_ids: [source.meta.id] }), /not a decision or reassessment/);
  assert.equal(getRecord(f.root, f.workflow.meta.id).meta.revision, before);
});

test('manager continuation disposition rejects unsigned role/workflow and closed workflow receipts', (t) => {
  const f = fixture(t, 'reviewer');
  assert.throws(() => applyManagerContinuations(f.root, f.workflow.meta.id, f.id, { continuation_ids: ['cont-a'], rationale: 'Because.', source_ids: [f.source.meta.id] }), /different engineering role/);
  const manager = fixture(t);
  const before = getRecord(manager.root, manager.workflow.meta.id);
  assert.throws(() => applyManagerContinuations(manager.root, manager.workflow.meta.id, 'unsigned', { continuation_ids: ['cont-a'], rationale: 'Because.', source_ids: [manager.source.meta.id] }), /cannot be verified|receipt/);
  const other = beginWorkflow(manager.root, { requirement: 'A distinct workflow.', request_id: 'other-workflow' });
  assert.throws(() => applyManagerContinuations(manager.root, other.meta.id, manager.id, { continuation_ids: ['cont-a'], rationale: 'Because.', source_ids: [manager.source.meta.id] }), /different workflow/);
  updateRecord(manager.root, manager.workflow.meta.id, { data: { phase: 'completed' } });
  assert.throws(() => applyManagerContinuations(manager.root, manager.workflow.meta.id, manager.id, { continuation_ids: ['cont-a'], rationale: 'Because.', source_ids: [manager.source.meta.id] }), /closed workflow/);
  assert.deepEqual(getRecord(manager.root, manager.workflow.meta.id).meta.data.applied_continuation_ids, before.meta.data.applied_continuation_ids);
});
