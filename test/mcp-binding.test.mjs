import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, renameSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  createMcpServer,
  assertGenericRecordMutation,
  canAuthor,
  projectRead,
  assertTaskOutputPaths,
  taskAuthorData,
  assertRecordPreview,
} from '../dist/mcp.js';
import { initialize, createRecord, getRecord, updateRecord, hash } from '../dist/storage.js';
import { managedRun } from '../dist/managed.js';
import { captureEvidenceInputs, validateEvidenceInputs } from '../dist/evidence-inputs.js';
import { recordFingerprint } from '../dist/engineering.js';
import { beginWorkflow } from '../dist/manager.js';
import { ensureRoutingPolicy } from '../dist/routing.js';
import { createNativeBridge, shutdownNative, nativeStatus } from '../dist/native.js';
const fixture = fileURLToPath(new URL('../resources/native/fake-app-server.mjs', import.meta.url));
function project(t) {
  const root = mkdtempSync(join(tmpdir(), 'verythinker-mcp-bound-'));
  initialize(root, { project_id: 'MCP-BOUND', name: 'Bound MCP protocol fixture' });
  ensureRoutingPolicy(root);
  t.after(async () => {
    await shutdownNative();
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    rmSync(root, { recursive: true, force: true });
  });
  return root;
}
async function clientFor(t, root, invocationId) {
  const server = createMcpServer(root, { invocation_id: invocationId });
  const client = new Client({ name: 'scope-test', version: '1' });
  const [transportClient, transportServer] = InMemoryTransport.createLinkedPair();
  await server.connect(transportServer);
  await client.connect(transportClient);
  t.after(async () => {
    await client.close();
    await server.close();
  });
  return client;
}
async function invocation(root, role, workflowId, taskId) {
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
  return bridge.start(root, {
    role,
    prompt: 'Perform this assigned engineering role only.',
    workflow_id: workflowId,
    ...(taskId ? { task_id: taskId } : {}),
  });
}
const result = (response) => JSON.parse(response.content[0].text);
test('strict unbound MCP rejects arbitrary mutations and exposes natural requirement entrypoint', async (t) => {
  const root = project(t),
    client = await clientFor(t, root);
  const created = await client.callTool({
    name: 'record_create',
    arguments: { type: 'requirement', title: 'Injected requirement', owner: 'requirements' },
  });
  assert.equal(created.isError, true);
  assert.match(result(created).error, /invocation-bound/);
  const tools = (await client.listTools()).tools.map((tool) => tool.name);
  for (const name of [
    'manager_run',
    'native_dispatch',
    'native_wait',
    'capability_invoke',
    'archive_restore',
    'archive_reassess',
    'assignment_report',
    'note_create',
    'recipe_resolve',
  ])
    assert.ok(tools.includes(name));
  const updateSchema = (await client.listTools()).tools.find(
    (tool) => tool.name === 'record_update',
  ).inputSchema;
  assert.ok(updateSchema.properties.links);
});
test('project source reads enforce task paths, exclude credentials, and preserve a content hash', (t) => {
  const root = project(t),
    workflow = beginWorkflow(root, { requirement: 'Inspect only the assigned source module.' });
  const task = createRecord(root, {
    type: 'task',
    title: 'Assigned source inspection',
    owner: 'reviewer',
    data: { workflow_id: workflow.meta.id, allowed_paths: ['src/assigned.txt'] },
    links: [{ type: 'documents', target: workflow.meta.id }],
  });
  const sibling = createRecord(root, {
    type: 'task',
    title: 'Sibling source inspection',
    owner: 'reviewer',
    data: { workflow_id: workflow.meta.id, allowed_paths: ['src/sibling.txt'] },
    links: [{ type: 'documents', target: workflow.meta.id }],
  });
  createRecord(root, {
    type: 'check',
    title: 'Sibling source check',
    owner: 'verifier',
    data: { task_id: sibling.meta.id, baseline_paths: ['src/sibling.txt'] },
    links: [{ type: 'verifies', target: sibling.meta.id }],
  });
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src/assigned.txt'), 'first line\n' + 'a'.repeat(200));
  writeFileSync(join(root, 'src/sibling.txt'), 'Unrelated assignment input.');
  writeFileSync(join(root, '.env'), 'SECRET=not-a-real-credential');
  const scope = { task_id: task.meta.id, workflow_id: workflow.meta.id };
  const read = projectRead(
    root,
    { path: 'src/assigned.txt', start_line: 2, max_chars: 128 },
    scope,
  );
  assert.match(read.sha256, /^[a-f0-9]{64}$/);
  assert.equal(read.text, 'a'.repeat(128));
  assert.equal(read.truncated, true);
  assert.throws(
    () => projectRead(root, { path: 'src/sibling.txt' }, scope),
    /outside the assigned/,
  );
  assert.throws(() => projectRead(root, { path: '.env' }), /Private credentials/);
  assert.throws(
    () => projectRead(root, { path: '.verythinker/cache/native/private-key.pem' }),
    /Private credentials/,
  );
  assert.throws(
    () => projectRead(root, { path: '../outside.txt' }),
    /outside|escape|within|traversal/,
  );
  assert.throws(() => projectRead(root, { path: 'src/assigned.txt', max_chars: 127 }), /budget/);
  assert.doesNotThrow(() => assertTaskOutputPaths(root, scope, ['src/assigned.txt']));
  assert.throws(
    () => assertTaskOutputPaths(root, scope, ['docs/sibling.md']),
    /outside the assigned task scope/,
  );
  assert.throws(() => assertTaskOutputPaths(root, scope, [undefined]), /explicit output paths/);
});
test('developer cannot perform review or mutate unrelated task records', async (t) => {
  const root = project(t);
  const workflow = beginWorkflow(root, { requirement: 'Implement one bounded software feature.' });
  const task = createRecord(root, {
    type: 'task',
    title: 'Assigned implementation',
    owner: 'developer',
    data: { workflow_id: workflow.meta.id },
    links: [{ type: 'documents', target: workflow.meta.id }],
  });
  const outside = createRecord(root, {
    type: 'task',
    title: 'Other increment task',
    owner: 'developer',
  });
  const receipt = await invocation(root, 'developer', workflow.meta.id, task.meta.id);
  const client = await clientFor(t, root, receipt.id);
  const denied = await client.callTool({
    name: 'task_review',
    arguments: {
      id: task.meta.id,
      owner: 'reviewer',
      decision: 'pass',
      invocation_id: 'forged-reviewer',
    },
  });
  assert.equal(denied.isError, true);
  assert.match(result(denied).error, /Protocol fixture/);
  assert.equal(canAuthor('developer', 'review'), false);
  const outsideRead = await client.callTool({
    name: 'record_get',
    arguments: { id: outside.meta.id },
  });
  assert.equal(outsideRead.isError, true);
  assert.match(result(outsideRead).error, /Protocol fixture|different task/);
  const recursion = await client.callTool({
    name: 'manager_run',
    arguments: { requirement: 'Recursive manager request.' },
  });
  assert.equal(recursion.isError, true);
  assert.match(result(recursion).error, /recursive intake/);
});
test('protocol fixture cannot stamp trusted authorship or disable strict routing', async (t) => {
  const root = project(t),
    workflow = beginWorkflow(root, { requirement: 'Validate configuration with explicit bounds.' });
  const receipt = await invocation(root, 'requirements', workflow.meta.id);
  const client = await clientFor(t, root, receipt.id);
  const requirementId = getRecord(root, workflow.meta.id).meta.data.requirement_id;
  const updated = await client.callTool({
    name: 'record_update',
    arguments: {
      id: requirementId,
      data: {
        acceptance_criteria: ['Values outside the declared bounds are rejected.'],
        invocation_id: 'forged-sol',
        author_invocation_id: 'forged-sol',
        invocation_role: 'reviewer',
      },
    },
  });
  assert.equal(updated.isError, true);
  assert.match(result(updated).error, /Protocol fixture/);
  const record = getRecord(root, requirementId);
  assert.notEqual(record.meta.data.invocation_id, receipt.id);
  assert.notEqual(record.meta.data.invocation_role, 'reviewer');
  const check = await client.callTool({
    name: 'record_create',
    arguments: { type: 'check', title: 'Unauthorized oracle', owner: 'verifier' },
  });
  assert.equal(check.isError, true);
  assert.match(result(check).error, /Protocol fixture/);
  assert.equal(canAuthor('requirements', 'check'), false);
});
test('worker cannot rewrite coordinator decisions through generic knowledge operations', async (t) => {
  const root = project(t),
    workflow = beginWorkflow(root, { requirement: 'Research one bounded engineering question.' });
  const task = createRecord(root, {
    type: 'task',
    title: 'Assigned research',
    owner: 'researcher',
    data: { workflow_id: workflow.meta.id },
    links: [{ type: 'documents', target: workflow.meta.id }],
  });
  const decision = createRecord(root, {
    type: 'knowledge',
    title: 'Coordinator decision',
    owner: 'manager',
    data: { kind: 'manager-decision', workflow_id: workflow.meta.id },
    links: [{ type: 'documents', target: workflow.meta.id }],
  });
  const receipt = await invocation(root, 'researcher', workflow.meta.id, task.meta.id);
  const client = await clientFor(t, root, receipt.id);
  const updated = await client.callTool({
    name: 'record_update',
    arguments: { id: decision.meta.id, data: { task_ids: [], routing_required: false } },
  });
  assert.equal(updated.isError, true);
  assert.match(result(updated).error, /Protocol fixture/);
  assert.throws(() => assertGenericRecordMutation(decision, receipt), /Reserved workflow/);
  assert.equal(getRecord(root, decision.meta.id).meta.owner, 'manager');
  const parent = await client.callTool({
    name: 'record_update',
    arguments: { id: workflow.meta.id, data: { change_type: 'breaking-change' } },
  });
  assert.equal(parent.isError, true);
  assert.match(result(parent).error, /Protocol fixture/);
  assert.throws(() => assertGenericRecordMutation(workflow, receipt), /Only the manager/);
});
test('completion retry rejects protocol proof without launching another coordinator or changing frozen closure', async (t) => {
  const root = project(t),
    workflow = beginWorkflow(root, {
      requirement: 'Complete one increment with accepted evidence.',
    });
  const bridge = createNativeBridge({
    runtime: async () => ({
      version: '0.162.1',
      command: process.execPath,
      args: [fixture, 'success'],
      integrity: 'protocol-fixture',
      protocol_sha256: 'protocol-fixture',
      executable_sha256: 'protocol-fixture',
    }),
  });
  const started = await bridge.start(root, {
    role: 'manager',
    workflow_id: workflow.meta.id,
    prompt: 'Observe protocol completion only.',
  });
  const completed = await bridge.wait(root, started.id, 3000);
  assert.equal(completed.state, 'completed');
  updateRecord(root, workflow.meta.id, {
    data: {
      phase: 'awaiting-native-completion',
      native_manager_attempt_id: completed.id,
      invocation_id: completed.id,
    },
  });
  const revision = getRecord(root, workflow.meta.id).meta.revision;
  const resumed = await managedRun(root, { workflow_id: workflow.meta.id });
  assert.match(resumed.blocker, /Protocol fixture/);
  assert.equal(resumed.invocation, undefined);
  assert.equal(nativeStatus(root).length, 1);
  assert.equal(getRecord(root, workflow.meta.id).meta.revision, revision);
});
test('planning author metadata preserves execution identity and cannot forge repair or submission state', () => {
  const receipt = {
    id: 'actual-strategic-author',
    role: 'architect',
    workflow_id: 'workflow',
    task_id: null,
  };
  const authored = taskAuthorData(receipt, { allowed_paths: ['src'] });
  assert.equal(authored.author_invocation_id, receipt.id);
  assert.equal(authored.invocation_id, undefined);
  for (const field of [
    'invocation_id',
    'prior_invocation_ids',
    'attempts',
    'escalation_required',
    'submission',
    'workspace_writes',
    'status',
  ])
    assert.throws(
      () => taskAuthorData(receipt, { [field]: 'forged' }),
      /dedicated core operations/,
    );
  const task = {
    meta: {
      data: {
        attempts: 2,
        feedback: 'A recorded second repair failed to preserve the storage contract.',
      },
    },
  };
  const escalation = taskAuthorData(
    receipt,
    {
      escalation_reason: 'Diagnosed the interface mismatch after the recorded repair feedback.',
      escalation_invocation_id: 'forged-author',
    },
    task,
  );
  assert.equal(escalation.escalation_invocation_id, receipt.id);
  assert.equal(escalation.escalation_attempt, 2);
  assert.equal(escalation.escalation_feedback_sha256, hash(task.meta.data.feedback));
  assert.throws(
    () =>
      taskAuthorData(
        { ...receipt, role: 'developer' },
        { escalation_reason: 'Self-authorized escalation after worker failure is prohibited.' },
      ),
    /strategic author/,
  );
  assert.equal(canAuthor('manager', 'task'), true);
  assert.equal(canAuthor('manager', 'requirement'), false);
  assert.equal(canAuthor('manager', 'design'), false);
  assert.equal(canAuthor('manager', 'check'), false);
});
test('removed strict routing policy blocks native start, resume, reporting, and bound gateway mutation', async (t) => {
  const root = project(t),
    workflow = beginWorkflow(root, {
      requirement: 'Keep exact routing mandatory throughout the increment.',
    });
  const task = createRecord(root, {
    type: 'task',
    title: 'Bound implementation',
    owner: 'developer',
    data: { workflow_id: workflow.meta.id },
    links: [{ type: 'documents', target: workflow.meta.id }],
  });
  const started = await invocation(root, 'developer', workflow.meta.id, task.meta.id);
  const client = await clientFor(t, root, started.id);
  renameSync(
    join(root, '.verythinker/routing.json'),
    join(root, '.verythinker/routing.removed.json'),
  );
  const receiptBytes = readFileSync(join(root, started.receipt_path), 'utf8');
  const bridge = createNativeBridge({
    runtime: async () => {
      throw new Error('A missing-policy operation must not reach the native runtime.');
    },
  });
  await assert.rejects(
    bridge.start(root, { role: 'developer', prompt: 'Do not dispatch without policy.' }),
    /routing policy is missing/,
  );
  await assert.rejects(bridge.resume(root, started.id), /routing policy is missing/);
  const reported = await client.callTool({
    name: 'assignment_report',
    arguments: {
      target_ids: [task.meta.id],
      body: 'A reporting request cannot bypass a missing execution policy.',
    },
  });
  assert.equal(reported.isError, true);
  assert.match(result(reported).error, /routing policy is missing/);
  const mutated = await client.callTool({
    name: 'record_update',
    arguments: { id: task.meta.id, data: { allowed_paths: ['unauthorized'] } },
  });
  assert.equal(mutated.isError, true);
  assert.match(result(mutated).error, /routing policy is missing/);
  assert.equal(readFileSync(join(root, started.receipt_path), 'utf8'), receiptBytes);
  assert.equal(getRecord(root, task.meta.id).meta.data.allowed_paths, undefined);
});
test('MCP previews reject invalid typed links before writing and permit repair of existing invalid links', (t) => {
  const root = project(t),
    requirement = createRecord(root, { type: 'requirement', title: 'A measurable requirement' });
  const first = createRecord(root, {
    type: 'check',
    title: 'Existing valid procedure',
    links: [{ type: 'verifies', target: requirement.meta.id }],
  });
  const second = createRecord(root, {
    type: 'check',
    title: 'Historical invalid procedure',
    links: [{ type: 'depends-on', target: first.meta.id }],
  });
  const count = nativeStatus(root).length;
  assert.throws(
    () =>
      assertRecordPreview(root, {
        type: 'check',
        links: [{ type: 'depends-on', target: first.meta.id }],
      }),
    /Invalid depends-on/,
  );
  assert.throws(
    () =>
      assertRecordPreview(root, {
        type: 'check',
        links: [{ type: 'verifies', target: 'missing-record' }],
      }),
    /does not exist/,
  );
  assert.doesNotThrow(() =>
    assertRecordPreview(
      root,
      { type: 'check', links: [{ type: 'verifies', target: requirement.meta.id }] },
      second,
    ),
  );
  assert.equal(getRecord(root, second.meta.id).meta.links[0].type, 'depends-on');
  assert.equal(nativeStatus(root).length, count);
});
test('reviewer can inspect validated captured inputs for its task without reading another increment store', (t) => {
  const root = project(t),
    workflow = beginWorkflow(root, {
      requirement: 'Review the captured inputs for the assigned task only.',
    });
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src/assigned.txt'), 'Original assigned input.');
  writeFileSync(join(root, 'src/other.txt'), 'Another increment input.');
  writeFileSync(join(root, '.env'), 'A captured private value.');
  writeFileSync(join(root, 'src/public-alias.txt'), 'A captured private value.');
  const task = createRecord(root, {
    type: 'task',
    title: 'Assigned evidence review',
    data: { workflow_id: workflow.meta.id, allowed_paths: ['src/assigned.txt'] },
    links: [{ type: 'documents', target: workflow.meta.id }],
  });
  const check = createRecord(root, {
    type: 'check',
    title: 'Assigned check',
    links: [{ type: 'verifies', target: task.meta.id }],
  });
  const files = Object.fromEntries(
    ['src/assigned.txt', '.env', 'src/public-alias.txt'].map((path) => [
      path,
      hash(readFileSync(join(root, path))),
    ]),
  );
  const records = {
    [task.meta.id]: recordFingerprint(task),
    [check.meta.id]: recordFingerprint(check),
  };
  const snapshot = captureEvidenceInputs(root, {
    files,
    records: [task, check],
    record_fingerprints: records,
  });
  createRecord(root, {
    type: 'evidence',
    title: 'Scoped captured input reference',
    links: [{ type: 'evidence-for', target: check.meta.id }],
    data: {
      task_id: task.meta.id,
      check_id: check.meta.id,
      check_fingerprint: records[check.meta.id],
      file_baseline: files,
      record_baseline: records,
      input_snapshot: snapshot,
    },
  });
  const scope = { role: 'reviewer', task_id: task.meta.id, workflow_id: workflow.meta.id };
  assert.ok(
    projectRead(root, { path: snapshot.manifest_path }, scope).text.includes(
      'captured-before-execution',
    ),
  );
  const manifest = validateEvidenceInputs(root, snapshot);
  assert.equal(
    projectRead(root, { path: manifest.files['src/assigned.txt'].blob_path }, scope).text,
    'Original assigned input.',
  );
  assert.equal(manifest.files['.env'].blob_path, manifest.files['src/public-alias.txt'].blob_path);
  rmSync(join(root, '.env'));
  assert.throws(
    () => projectRead(root, { path: manifest.files['.env'].blob_path }, scope),
    /outside the assigned verified evidence scope/,
  );
  assert.throws(
    () => projectRead(root, { path: manifest.files['.env'].blob_path }),
    /outside the assigned verified evidence scope/,
  );
  assert.throws(
    () =>
      projectRead(
        root,
        { path: manifest.files['src/public-alias.txt'].blob_path },
        { ...scope, task_id: null },
      ),
    /outside the assigned verified evidence scope/,
  );
  const other = captureEvidenceInputs(root, {
    files: { 'src/other.txt': hash(readFileSync(join(root, 'src/other.txt'))) },
    records: [],
  });
  assert.throws(
    () => projectRead(root, { path: other.manifest_path }, scope),
    /outside the assigned verified evidence scope/,
  );
  assert.throws(
    () => projectRead(root, { path: other.manifest_path }, { ...scope, task_id: null }),
    /outside the assigned verified evidence scope/,
  );
});
