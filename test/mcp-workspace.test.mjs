import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../dist/mcp.js';
import { initialize, createRecord, updateRecord } from '../dist/storage.js';
import { beginWorkflow } from '../dist/manager.js';
import { ensureRoutingPolicy } from '../dist/routing.js';
import { roleCapabilities } from '../dist/tools.js';
import { createNativeBridge, shutdownNative } from '../dist/native.js';

const fixture = fileURLToPath(new URL('../resources/native/fake-app-server.mjs', import.meta.url));
const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
function project(t, strict = false) {
  const root = mkdtempSync(join(tmpdir(), 'verythinker-workspace-mcp-'));
  initialize(root, { project_id: 'WORKSPACE-MCP', name: 'Scoped editing mechanics' });
  if (strict) ensureRoutingPolicy(root);
  t.after(async () => {
    await shutdownNative(root);
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    rmSync(root, { recursive: true, force: true });
  });
  return root;
}
async function clientFor(t, root, invocationId) {
  const server = createMcpServer(root, { invocation_id: invocationId });
  const client = new Client({ name: 'workspace-mcp-mechanics', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => {
    await client.close();
    await server.close();
  });
  return client;
}
const result = (response) => JSON.parse(response.content[0].text);

test('workspace MCP discovery declares CAS, task scope and recovery without caller model/receipt claims', async (t) => {
  const root = project(t),
    client = await clientFor(t, root);
  const tool = (await client.listTools()).tools.find((item) => item.name === 'task_file_write');
  assert.ok(tool);
  assert.equal(tool.annotations.readOnlyHint, false);
  assert.equal(tool.annotations.openWorldHint, false);
  const schema = tool.inputSchema;
  assert.deepEqual([...schema.required].sort(), ['expected_hash', 'path', 'task_id']);
  assert.match(JSON.stringify(schema.properties.content), /string/);
  assert.match(JSON.stringify(schema.properties.content), /null/);
  const replacement = schema.properties.replacement.anyOf?.find(item => item.type === 'object') ?? schema.properties.replacement;
  assert.deepEqual([...replacement.required].sort(), ['after', 'before']);
  assert.equal(replacement.properties.before.minLength, 1);
  assert.match(JSON.stringify(schema.properties.operation_id), /uuid/);
  assert.match(JSON.stringify(schema.properties.operation_id), /null/);
  assert.match(JSON.stringify(schema.properties.expected_hash), /null/);
  assert.equal(schema.properties.invocation_id, undefined);
  assert.equal(schema.properties.confirmed_model, undefined);
  assert.match(tool.description, /immutable history/);
  assert.ok(roleCapabilities('developer').operations.includes('task_file_write'));
  for (const role of [
    'manager',
    'requirements',
    'architect',
    'verifier',
    'reviewer',
    'researcher',
    'curator',
    'check-executor',
    'release',
  ])
    assert.ok(!roleCapabilities(role).operations.includes('task_file_write'), role);
});

test('workspace MCP rejects unbound legacy/strict and protocol-fixture writes without changing outputs', async (t) => {
  for (const strict of [false, true]) {
    const root = project(t, strict),
      client = await clientFor(t, root);
    const refused = await client.callTool({
      name: 'task_file_write',
      arguments: {
        task_id: 'WORKSPACE-MCP-TASK-0001',
        path: 'src/new.mjs',
        content: 'export const value = 1;\n',
        expected_hash: null,
      },
    });
    assert.equal(refused.isError, true);
    assert.match(result(refused).error, /invocation-bound/);
    assert.equal(existsSync(join(root, 'src/new.mjs')), false);
  }
  const root = project(t, true);
  const workflow = beginWorkflow(root, {
    requirement: 'Inspect the scoped editing mechanics only.',
  });
  const task = createRecord(root, {
    type: 'task',
    title: 'Bound implementation',
    owner: 'developer',
    data: {
      workflow_id: workflow.meta.id,
      allowed_paths: ['src/new.mjs'],
    },
  });
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
    role: 'developer',
    workflow_id: workflow.meta.id,
    task_id: task.meta.id,
    prompt: 'Inspect the scoped editing mechanics only.',
  });
  // Privileged fixture setup reaches the receipt rejection boundary; it never establishes an accepted workflow.
  updateRecord(root, workflow.meta.id, { data: { task_ids: [task.meta.id] } });
  updateRecord(root, task.meta.id, { status: 'in-progress', data: { invocation_id: receipt.id } });
  assert.ok(receipt.native_tool_scope.includes('task_file_write'));
  const client = await clientFor(t, root, receipt.id);
  const refused = await client.callTool({
    name: 'task_file_write',
    arguments: {
      task_id: task.meta.id,
      path: 'src/new.mjs',
      content: 'export const value = 1;\n',
      expected_hash: null,
    },
  });
  assert.equal(refused.isError, true);
  assert.match(result(refused).error, /Protocol fixture/);
  assert.equal(existsSync(join(root, 'src/new.mjs')), false);
  const administrative = spawnSync(
    process.execPath,
    [
      cli,
      'workspace',
      'write',
      '--project',
      root,
      '--data',
      JSON.stringify({
        task_id: task.meta.id,
        workflow_id: workflow.meta.id,
        invocation_id: receipt.id,
        path: 'src/new.mjs',
        content: 'export const value = 1;\n',
        expected_hash: null,
      }),
    ],
    { encoding: 'utf8', timeout: 15000 },
  );
  assert.equal(administrative.status, 1);
  assert.match(administrative.stderr, /Protocol fixture/);
  assert.equal(existsSync(join(root, 'src/new.mjs')), false);
});

test('workspace CLI discovery and explicit CAS validation retain the shared guarded core', (t) => {
  const root = project(t),
    help = spawnSync(process.execPath, [cli, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /workspace write --data JSON/);
  const malformed = spawnSync(
    process.execPath,
    [
      cli,
      'workspace',
      'write',
      '--project',
      root,
      '--data',
      JSON.stringify({
        task_id: 'TASK',
        workflow_id: 'WF',
        invocation_id: 'not-native',
        path: 'new.txt',
        content: 'test',
      }),
    ],
    { encoding: 'utf8' },
  );
  assert.equal(malformed.status, 1);
  assert.match(malformed.stderr, /expected_hash/);
  assert.equal(existsSync(join(root, 'new.txt')), false);
});
