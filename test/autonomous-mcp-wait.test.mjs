import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../dist/mcp.js';
import { initialize, createRecord } from '../dist/storage.js';
import { beginWorkflow } from '../dist/manager.js';
import { ensureRoutingPolicy } from '../dist/routing.js';
import { createNativeBridge, nativeStatus, shutdownNative } from '../dist/native.js';

const fixture = fileURLToPath(new URL('../resources/native/fake-app-server.mjs', import.meta.url));

test('a bound MCP invocation rejects its own native wait and keeps status read-only', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'verythinker-autonomous-mcp-wait-'));
  initialize(root, { project_id: 'MCP-SELF-WAIT', name: 'MCP self-wait guard fixture' });
  ensureRoutingPolicy(root);
  const workflow = beginWorkflow(root, {
    requirement: 'A bound worker can report its assignment without waiting on its own completion.',
  });
  const task = createRecord(root, {
    type: 'task',
    title: 'Return a bounded work report',
    owner: 'developer',
    data: { workflow_id: workflow.meta.id },
    links: [{ type: 'documents', target: workflow.meta.id }],
  });
  const bridge = createNativeBridge({
    runtime: async () => ({
      version: '0.162.1',
      command: process.execPath,
      args: [fixture, 'hang'],
      integrity: 'protocol-fixture',
      protocol_sha256: 'protocol-fixture',
      executable_sha256: 'protocol-fixture',
    }),
  });
  const invocation = await bridge.start(root, {
    role: 'developer',
    workflow_id: workflow.meta.id,
    task_id: task.meta.id,
    prompt: 'Return a work report for the assigned task.',
  });
  const server = createMcpServer(root, { invocation_id: invocation.id });
  const client = new Client({ name: 'self-wait-guard-fixture', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  t.after(async () => {
    await client.close();
    await server.close();
    await shutdownNative();
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    rmSync(root, { recursive: true, force: true });
  });

  const before = nativeStatus(root, invocation.id);
  const refused = await client.callTool({
    name: 'native_wait',
    arguments: { invocation_id: invocation.id, wait_ms: 200 },
  });
  assert.equal(refused.isError, true);
  assert.match(
    refused.content.map((item) => item.text ?? '').join('\n'),
    /cannot wait for its own inference completion.*Submit your work report.*coordinator waits on other workers/s,
  );

  const statusTool = (await client.listTools()).tools.find((tool) => tool.name === 'native_status');
  assert.equal(statusTool.annotations.readOnlyHint, true);
  assert.deepEqual(nativeStatus(root, invocation.id), before);
});
