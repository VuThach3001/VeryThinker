import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { initialize, loadRecords } from '../dist/storage.js';
import { beginWorkflow } from '../dist/manager.js';
import { managedRun } from '../dist/managed.js';
import { createMcpServer } from '../dist/mcp.js';

const requirement = 'Reject invalid configuration without changing stored values.';
function project(t) {
  const root = mkdtempSync(join(tmpdir(), 'verythinker-intake-'));
  initialize(root, { project_id: 'INTAKE' });
  t.after(() => {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    rmSync(root, { recursive: true, force: true });
  });
  return root;
}
async function connect(t, root) {
  const server = createMcpServer(root),
    client = new Client({ name: 'intake-regression', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  await client.connect(a);
  t.after(async () => {
    await client.close();
    await server.close();
  });
  return client;
}
test('intake accepts one meaningful field with null, blank or empty unused-field placeholders', (t) => {
  const root = project(t);
  for (const [index, input] of [
    { requirement, requirements: [] },
    { requirement, requirements: null },
    { requirement: null, requirements: [requirement] },
    { requirement: '  ', requirements: [requirement] },
  ].entries()) {
    const workflow = beginWorkflow(root, { ...input, request_id: `placeholder-${index}` });
    assert.deepEqual(workflow.meta.data.original_requirements, [requirement]);
    const retry = beginWorkflow(root, {
      requirement: null,
      requirements: [requirement],
      request_id: `placeholder-${index}`,
    });
    assert.equal(retry.meta.id, workflow.meta.id);
  }
});
test('intake keeps ambiguity and malformed-batch rejection before record creation', (t) => {
  const root = project(t);
  for (const input of [
    { requirement, requirements: [requirement] },
    { requirement: null, requirements: [] },
    { requirement: ' ', requirements: null },
    { requirements: [' '] },
    { requirements: [null] },
  ])
    assert.throws(() => beginWorkflow(root, input));
  assert.equal(loadRecords(root).length, 0);
});
test('managed resumption treats placeholders as absent and still rejects changed requirements', async (t) => {
  const root = project(t),
    workflow = beginWorkflow(root, { requirement, request_id: 'saved' });
  const resumed = await managedRun(root, {
    workflow_id: workflow.meta.id,
    requirement: null,
    requirements: [],
  });
  assert.equal(resumed.workflow.workflow_id, workflow.meta.id);
  assert.match(resumed.blocker, /Strict native routing/);
  const count = loadRecords(root).length;
  await assert.rejects(
    managedRun(root, {
      workflow_id: workflow.meta.id,
      requirement: 'A different measurable requirement.',
      requirements: [],
    }),
    /requirements differ/,
  );
  assert.equal(loadRecords(root).length, count);
});
test('published MCP intake accepts nullable placeholders without native execution', async (t) => {
  const root = project(t),
    client = await connect(t, root);
  const tools = (await client.listTools()).tools;
  for (const name of ['manager_run', 'manager_begin']) {
    const schema = tools.find((tool) => tool.name === name).inputSchema;
    for (const key of ['requirement', 'requirements']) {
      assert.ok(
        JSON.stringify(schema.properties[key]).includes('null'),
        `${name}.${key} must allow an explicit unused placeholder`,
      );
      assert.ok(!(schema.required ?? []).includes(key));
    }
    const result = await client.callTool({
      name,
      arguments: {
        requirement,
        requirements: null,
        title: null,
        request_id: `mcp-${name}`,
        ...(name === 'manager_run'
          ? { workflow_id: null, message: null, change_type: null, providers: null }
          : { invocation_id: null }),
      },
    });
    assert.notEqual(result.isError, true, JSON.stringify(result.content));
  }
  assert.equal(loadRecords(root).filter((r) => r.meta.data.kind === 'manager-workflow').length, 2);
  const batch = await client.callTool({
    name: 'manager_run',
    arguments: { requirement: null, requirements: [requirement], request_id: 'mcp-batch' },
  });
  assert.notEqual(batch.isError, true, JSON.stringify(batch.content));
  const count = loadRecords(root).length;
  const ambiguous = await client.callTool({
    name: 'manager_run',
    arguments: { requirement, requirements: [requirement] },
  });
  assert.equal(ambiguous.isError, true);
  assert.match(JSON.stringify(ambiguous.content), /rather than both/);
  assert.equal(loadRecords(root).length, count);
});
