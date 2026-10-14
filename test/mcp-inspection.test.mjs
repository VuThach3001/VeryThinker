import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer, projectRead } from '../dist/mcp.js';
import { initialize, createRecord, getRecord, loadRecords, hash } from '../dist/storage.js';
import { recordFingerprint } from '../dist/engineering.js';
import { roleCapabilities } from '../dist/tools.js';
import { ensureRoutingPolicy } from '../dist/routing.js';
import { createNativeBridge, shutdownNative } from '../dist/native.js';

const fixture = fileURLToPath(new URL('../resources/native/fake-app-server.mjs', import.meta.url));
async function project(t, invocationId) {
  const root = mkdtempSync(join(tmpdir(), 'verythinker-inspection-mcp-'));
  initialize(root, { project_id: 'INSPECT-MCP', name: 'Inspection schema and context mechanics' });
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src/value.mjs'), 'export const value = 1;\n');
  t.after(async () => {
    await shutdownNative(root);
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    rmSync(root, { recursive: true, force: true });
  });
  return root;
}
async function clientFor(t, root, invocationId) {
  const server = createMcpServer(root, { invocation_id: invocationId });
  const client = new Client({ name: 'inspection-surface-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => {
    await client.close();
    await server.close();
  });
  return client;
}
test('intake can read review diagnostics before native execution without mutating the record', async t => {
  const root = await project(t);
  ensureRoutingPolicy(root);
  const target = createRecord(root, {type:'design',owner:'architect',title:'Review diagnostic intake'});
  const before = getRecord(root,target.meta.id);
  const client = await clientFor(t,root);
  const result = await client.callTool({name:'record_review_status',arguments:{id:target.meta.id}});
  assert.equal(result.isError,undefined);
  const status = JSON.parse(result.content.find(block=>block.type==='text').text);
  assert.equal(status.target_id,target.meta.id);
  assert.equal(status.disposition,'missing');
  assert.equal(status.current,false);
  assert.equal(getRecord(root,target.meta.id).meta.revision,before.meta.revision);
});
const result = (response) => JSON.parse(response.content[0].text);
function input(checkId, taskId) {
  return {
    id: checkId,
    task: taskId,
    observations: [
      {
        item_id: 'INS-01',
        outcome: 'pass',
        observation: 'The inspected module declares a named numeric export.',
        sources: [
          {
            kind: 'file',
            path: 'src/value.mjs',
            sha256: hash('export const value = 1;\n'),
            locator: 'line 1',
          },
        ],
      },
    ],
    limitations: ['Source inspection does not establish runtime behavior.'],
  };
}

test('inspection MCP exposes typed observed sources, unresolved outcomes and independent tool ownership', async (t) => {
  const root = await project(t),
    client = await clientFor(t, root);
  const tools = (await client.listTools()).tools;
  const tool = tools.find((item) => item.name === 'check_inspect');
  assert.ok(tool);
  assert.equal(tool.annotations.readOnlyHint, false);
  assert.deepEqual([...tool.inputSchema.required].sort(), [
    'id',
    'limitations',
    'observations',
    'task',
  ]);
  const observation = tool.inputSchema.properties.observations.items;
  assert.deepEqual(observation.properties.outcome.enum, ['pass', 'fail', 'gap']);
  assert.equal(observation.properties.sources.minItems, 1);
  assert.equal(observation.properties.sources.maxItems, 16);
  const sources = JSON.stringify(observation.properties.sources);
  assert.match(sources, /sha256/);
  assert.match(sources, /record_id/);
  assert.match(sources, /fingerprint/);
  for (const key of ['invocation_id', 'confirmed_model', 'result', 'expected'])
    assert.equal(tool.inputSchema.properties[key], undefined);
  assert.match(tool.description, /does not run an executable/);
  assert.ok(roleCapabilities('check-executor').operations.includes('check_inspect'));
  for (const role of [
    'manager',
    'requirements',
    'architect',
    'verifier',
    'reviewer',
    'developer',
    'curator',
  ])
    assert.ok(!roleCapabilities(role).operations.includes('check_inspect'), role);
});

test('record projections bound historical context while retaining complete fingerprint, metadata and default behavior', async (t) => {
  const root = await project(t),
    client = await clientFor(t, root);
  const record = createRecord(root, {
    type: 'knowledge',
    title: 'Observed record with retained history',
    owner: 'researcher',
    data: {
      topic: 'Named export',
      history: 'retained history\n'.repeat(4000),
      method: 'source-inspection',
    },
    body: '# Source analysis\nThe module declares the named export.\n',
  });
  const before = readFileSync(join(root, record.path));
  const full = result(
    await client.callTool({ name: 'record_get', arguments: { id: record.meta.id } }),
  );
  const projected = result(
    await client.callTool({
      name: 'record_get',
      arguments: {
        id: record.meta.id,
        data_fields: ['topic', 'method', 'unknown-key'],
        include_body: false,
      },
    }),
  );
  assert.equal(full.body, record.body);
  assert.equal(full.meta.data.history, record.meta.data.history);
  assert.equal(full.projection, undefined);
  assert.deepEqual(projected.meta.data, { topic: 'Named export', method: 'source-inspection' });
  assert.equal(projected.body, undefined);
  assert.equal(projected.path, record.path);
  assert.equal(projected.meta.id, record.meta.id);
  assert.equal(projected.meta.revision, record.meta.revision);
  assert.equal(projected.fingerprint, full.fingerprint);
  assert.equal(projected.fingerprint, recordFingerprint(getRecord(root, record.meta.id)));
  assert.deepEqual(projected.projection, {
    data_fields: ['topic', 'method', 'unknown-key'],
    include_body: false,
  });
  assert.ok(JSON.stringify(projected).length < JSON.stringify(full).length / 10);
  assert.deepEqual(readFileSync(join(root, record.path)), before);
  const empty = result(
    await client.callTool({
      name: 'record_get',
      arguments: { id: record.meta.id, data_fields: [] },
    }),
  );
  assert.deepEqual(empty.meta.data, {});
  assert.equal(empty.body, record.body);
  assert.equal(empty.fingerprint, full.fingerprint);
  const oversized = await client.callTool({
    name: 'record_get',
    arguments: { id: record.meta.id, data_fields: Array.from({ length: 65 }, (_, i) => String(i)) },
  });
  assert.equal(oversized.isError, true);
});

test('inspection unbound and protocol-fixture requests cannot persist evidence or bypass native proof with projections', async (t) => {
  const root = await project(t),
    client = await clientFor(t, root);
  const check = createRecord(root, {
    type: 'check',
    title: 'Reviewed inspection mechanics',
    owner: 'verifier',
    data: {
      method: 'inspection',
      inspection_items: [
        { id: 'INS-01', criterion: 'Named export', expected: 'The source declares value.' },
      ],
      baseline_paths: ['src/value.mjs'],
    },
  });
  const task = createRecord(root, {
    type: 'task',
    title: 'Inspection mechanics',
    owner: 'developer',
  });
  const count = loadRecords(root).length;
  const unbound = await client.callTool({
    name: 'check_inspect',
    arguments: input(check.meta.id, task.meta.id),
  });
  assert.equal(unbound.isError, true);
  assert.match(result(unbound).error, /invocation-bound/);
  const malformed = input(check.meta.id, task.meta.id);
  malformed.observations[0].sources = [];
  const rejected = await client.callTool({ name: 'check_inspect', arguments: malformed });
  assert.equal(rejected.isError, true);
  ensureRoutingPolicy(root);
  const native = createNativeBridge({
    rpc_timeout_ms: 5000,
    runtime: async () => ({
      version: '0.162.1',
      command: process.execPath,
      args: [fixture, 'hang'],
      integrity: 'protocol-fixture',
      protocol_sha256: 'protocol-fixture',
      executable_sha256: 'protocol-fixture',
      test_fixture: true,
    }),
  });
  const receipt = await native.start(root, {
    role: 'check-executor',
    task_id: task.meta.id,
    prompt: 'Observe inspection mechanics without claiming account access.',
  });
  assert.ok(receipt.native_tool_scope.includes('check_inspect'));
  const bound = await clientFor(t, root, receipt.id);
  const refused = await bound.callTool({
    name: 'check_inspect',
    arguments: input(check.meta.id, task.meta.id),
  });
  assert.equal(refused.isError, true);
  assert.match(result(refused).error, /Protocol fixture/);
  const projected = await bound.callTool({
    name: 'record_get',
    arguments: { id: check.meta.id, data_fields: ['inspection_items'], include_body: false },
  });
  assert.equal(projected.isError, true);
  assert.match(result(projected).error, /Protocol fixture/);
  assert.equal(loadRecords(root).length, count);
  const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
  const help = spawnSync(process.execPath, [cli, '--help'], { encoding: 'utf8' });
  assert.match(help.stdout, /check inspect ID/);
});

test('declared inspection artifacts expose exact same-task files outside implementation paths while foreign/private/subtree files stay excluded', async (t) => {
  const root = await project(t);
  mkdirSync(join(root, 'verification/directory'), { recursive: true });
  writeFileSync(join(root, 'verification/check-a.mjs'), 'console.log("observed check");\n');
  writeFileSync(join(root, 'verification/oracle-a.json'), '{"expected":1}\n');
  writeFileSync(join(root, 'verification/check-b.mjs'), 'console.log("foreign check");\n');
  writeFileSync(
    join(root, 'verification/directory/unlisted.mjs'),
    'console.log("unlisted child");\n',
  );
  writeFileSync(join(root, '.env'), 'PRIVATE_FIXTURE=not-a-credential\n');
  const task = createRecord(root, {
    type: 'task',
    title: 'Assigned inspection',
    owner: 'developer',
    data: { allowed_paths: ['src/value.mjs'] },
  });
  const other = createRecord(root, { type: 'task', title: 'Other inspection', owner: 'developer' });
  createRecord(root, {
    type: 'check',
    title: 'Assigned verification artifacts',
    owner: 'verifier',
    data: {
      task_id: task.meta.id,
      verification_artifact_paths: ['verification/check-a.mjs', 'verification/directory'],
      oracle_paths: ['verification/oracle-a.json', '.env'],
    },
    links: [{ type: 'verifies', target: task.meta.id }],
  });
  createRecord(root, {
    type: 'check',
    title: 'Foreign verification artifact',
    owner: 'verifier',
    data: { task_id: other.meta.id, verification_artifact_paths: ['verification/check-b.mjs'] },
    links: [{ type: 'verifies', target: other.meta.id }],
  });
  const scope = { task_id: task.meta.id, workflow_id: null };
  assert.equal(
    projectRead(root, { path: 'verification/check-a.mjs' }, scope).sha256,
    hash(readFileSync(join(root, 'verification/check-a.mjs'))),
  );
  assert.equal(
    projectRead(root, { path: 'verification/oracle-a.json' }, scope).sha256,
    hash(readFileSync(join(root, 'verification/oracle-a.json'))),
  );
  for (const path of ['verification/check-b.mjs', 'verification/directory/unlisted.mjs'])
    assert.throws(() => projectRead(root, { path }, scope), /outside the assigned/);
  assert.throws(
    () => projectRead(root, { path: '.env' }, scope),
    /Private runtime|credentials|private/,
  );
});
