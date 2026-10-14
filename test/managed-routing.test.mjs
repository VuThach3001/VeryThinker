import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  initialize,
  createRecord,
  beginWorkflow,
  bindManagerInvocation,
  ensureRoutingPolicy,
  getRecord,
  loadRecords,
  startTask,
  runCheck,
  verify,
  roleCapabilities,
  describeCapabilities,
  authorizeOperation,
  toolCatalog,
  routingProblems,
  updateRecord,
  decideWorkflow,
  finishWorkflow,
} from '../dist/index.js';
import { createNativeBridge, shutdownNative } from '../dist/native.js';
import { expectedNativeSandbox } from '../dist/routing.js';
const transport = fileURLToPath(
  new URL('../resources/native/fake-app-server.mjs', import.meta.url),
);
function project(t) {
  const root = mkdtempSync(join(tmpdir(), 'verythinker-managed-routing-'));
  initialize(root, { project_id: 'MANAGED', profile: 'software' });
  ensureRoutingPolicy(root);
  t.after(async () => {
    await shutdownNative();
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    rmSync(root, { recursive: true, force: true });
  });
  const native = createNativeBridge({
    rpc_timeout_ms: 5000,
    runtime: async () => ({
      version: '0.162.1',
      command: process.execPath,
      args: [transport, 'success'],
      integrity: 'protocol-fixture',
      protocol_sha256: 'protocol-fixture',
      executable_sha256: 'protocol-fixture',
      test_fixture: true,
    }),
  });
  return { root, native };
}
test('batch preserves individual requirements and neither agent strings nor signed simulations authorize production work', async (t) => {
  const { root, native } = project(t);
  const wf = beginWorkflow(root, {
    requirements: ['Export integer one.', 'Explain the module interface.'],
    request_id: 'batch',
  });
  assert.equal(wf.meta.data.requirement_ids.length, 2);
  assert.equal(
    beginWorkflow(root, {
      requirements: ['Export integer one.', 'Explain the module interface.'],
      request_id: 'batch',
    }).meta.id,
    wf.meta.id,
  );
  assert.equal(loadRecords(root).filter((r) => r.meta.type === 'requirement').length, 3);
  assert.throws(
    () =>
      beginWorkflow(root, {
        requirement: '1. Export integer one.\n2. Explain the module interface.',
        request_id: 'batch',
      }),
    /different requirement/,
  );
  assert.equal(getRecord(root, wf.meta.id).meta.data.requirement_ids.length, 2);
  for (const id of wf.meta.data.requirement_ids) {
    const requirement = getRecord(root, id);
    assert.equal(requirement.meta.links[0].target, wf.meta.data.requirement_id);
    updateRecord(root, id, {
      data: { acceptance_criteria: ['The reviewed value and documentation agree.'] },
    });
  }
  const task = createRecord(root, {
    type: 'task',
    title: 'Implement bounded module',
    owner: 'developer',
    links: wf.meta.data.requirement_ids.map((target) => ({ type: 'satisfies', target })),
    data: {
      workflow_id: wf.meta.id,
      requirements: wf.meta.data.requirement_ids,
      acceptance_criteria: ['The named export is integer one.'],
      allowed_paths: ['src'],
    },
  });
  const check = createRecord(root, {
    type: 'check',
    title: 'Inspect named export',
    owner: 'verifier',
    links: wf.meta.data.requirement_ids.map((target) => ({ type: 'verifies', target })),
    data: { command: [process.execPath, '-e', 'process.exit(0)'], baseline_paths: ['src'] },
  });
  assert.equal(task.meta.data.documentation_required, true);
  assert.deepEqual(task.meta.data.documentation_paths, []);
  assert.throws(
    () => startTask(root, task.meta.id, 'gpt-6-luna', 'gpt-6-luna', 'agent-written-confirmation'),
    /receipt|verified/,
  );
  for (const [role, task_id] of [
    ['manager', undefined],
    ['developer', task.meta.id],
    ['check-executor', task.meta.id],
  ]) {
    const start = await native.start(root, {
      role,
      workflow_id: wf.meta.id,
      ...(task_id ? { task_id } : {}),
      prompt: 'Protocol simulation only; no authentication or inference.',
    });
    const completed = await native.wait(root, start.id, 5000);
    assert.equal(completed.state, 'completed');
    assert.equal(completed.execution_mode, 'protocol-fixture');
    assert.match(routingProblems(root, role, completed.id).join(' '), /fixture|simulat/i);
    if (role === 'manager')
      assert.throws(
        () => bindManagerInvocation(root, wf.meta.id, completed.id),
        /fixture|simulat/i,
      );
    if (role === 'developer')
      assert.throws(
        () => startTask(root, task.meta.id, undefined, undefined, completed.id),
        /fixture|simulat/i,
      );
    if (role === 'check-executor')
      assert.throws(
        () => runCheck(root, check.meta.id, task.meta.id, completed.id),
        /fixture|simulat/i,
      );
  }
  assert.equal(getRecord(root, task.meta.id).meta.status, 'draft');
  assert.equal(verify(root, task.meta.id, 'accepted').ok, false);
  assert.throws(
    () => updateRecord(root, task.meta.id, { data: { routing_required: null } }),
    /cannot be removed/,
  );
});
test('gateway never grants a simulated caller publication and pins explicit role contracts', async (t) => {
  const { root, native } = project(t);
  const start = await native.start(root, {
    role: 'researcher',
    workflow_id: 'WF-READ',
    prompt: 'Protocol retrieval simulation.',
  });
  const invocation = await native.wait(root, start.id, 5000);
  assert.throws(() =>
    authorizeOperation(root, invocation.id, 'archive_publish', { workflow_id: 'WF-READ' }),
  );
  assert.throws(() =>
    authorizeOperation(root, invocation.id, 'record_get', { workflow_id: 'WF-OTHER' }),
  );
  assert.equal(roleCapabilities('reviewer').operations.includes('record_update'), true);
  assert.equal(roleCapabilities('check-executor').operations.includes('check_run'), true);
  assert.deepEqual(
    toolCatalog.map((tool) => tool.version),
    ['1.6.2', '4.3.0', '0.0.83'],
  );
  for (const tool of toolCatalog) assert.match(tool.integrity, /^sha512-[A-Za-z0-9+/]+=*$/);
});

test('all twelve roles discover shared documentation, assigned editing, lifecycle, and approved provider tools', (t) => {
  const { root } = project(t);
  const roles = [
    'manager',
    'requirements',
    'architect',
    'component-owner',
    'verifier',
    'reviewer',
    'researcher',
    'codebase-analyst',
    'curator',
    'developer',
    'check-executor',
    'release',
  ];
  const allProviders = toolCatalog.map((tool) => tool.id);
  for (const role of roles) {
    const contract = roleCapabilities(role);
    for (const operation of [
      'project_read',
      'record_list',
      'record_get',
      'record_trace',
      'record_create',
      'record_update',
      'note_create',
      'note_validate',
      'task_file_write',
      'task_start',
      'task_resume',
      'task_submit',
      'capability_resolve',
      'capability_invoke',
      'record_review_status',
    ])
      assert.ok(contract.operations.includes(operation), `${role} lacks ${operation}`);
    assert.deepEqual(contract.providers, allProviders, `${role} provider catalog`);
    assert.deepEqual(roleCapabilities(role, ['context7']).providers, ['context7']);
    assert.ok(contract.native_tools.includes('search'), `${role} lacks native search`);
  }
  for (const role of roles.filter((role) => role !== 'reviewer')) {
    const tools = roleCapabilities(role).native_tools;
    assert.ok(tools.includes('edit'), `${role} lacks basic native editing`);
    assert.ok(tools.includes('execute-prescribed'), `${role} lacks prescribed execution`);
  }
  const reviewer = roleCapabilities('reviewer');
  assert.ok(!reviewer.native_tools.includes('edit'));
  assert.ok(reviewer.operations.includes('record_update'));
  assert.ok(!reviewer.operations.includes('manager_acknowledge'));
  assert.ok(!reviewer.operations.includes('task_accept'));
  assert.ok(!reviewer.operations.includes('archive_publish'));
  assert.ok(roleCapabilities('manager').operations.includes('manager_acknowledge'));
  for (const role of roles.filter((role) => role !== 'manager'))
    assert.ok(!roleCapabilities(role).operations.includes('manager_acknowledge'), role);
  writeFileSync(
    join(root, '.verythinker/tools.json'),
    JSON.stringify({
      schema_version: 1,
      automatic_install: false,
      approved_providers: ['context7'],
    }),
  );
  assert.deepEqual(
    describeCapabilities(root, 'manager').providers.map((provider) => provider.id),
    ['context7'],
  );
});

test('reviewer native editing depends on owning a task, while review and unbound receipts remain read-only', (t) => {
  const { root } = project(t);
  const workflow = beginWorkflow(root, { requirement: 'Scope reviewer documentation authority.' });
  const task = (owner, title) =>
    createRecord(root, {
      type: 'task',
      title,
      owner,
      links: workflow.meta.data.requirement_ids.map((target) => ({ type: 'satisfies', target })),
      data: {
        workflow_id: workflow.meta.id,
        requirements: workflow.meta.data.requirement_ids,
        acceptance_criteria: ['The assigned documentation remains within scope.'],
        allowed_paths: ['docs'],
      },
    });
  const ownTask = task('reviewer', 'Write scoped review guidance');
  const targetTask = task('developer', 'Implementation being reviewed');
  assert.equal(
    expectedNativeSandbox(root, {
      id: 'reviewer-producer',
      role: 'reviewer',
      task_id: ownTask.meta.id,
    }),
    'workspaceWrite',
  );
  assert.equal(
    expectedNativeSandbox(root, {
      id: 'reviewer-reviewer',
      role: 'reviewer',
      task_id: targetTask.meta.id,
    }),
    'readOnly',
  );
  assert.equal(
    expectedNativeSandbox(root, { id: 'reviewer-unbound', role: 'reviewer', task_id: null }),
    'readOnly',
  );
});

test('an unmigrated pending legacy workflow cannot plan or close after routing installation', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'verythinker-pending-migration-'));
  t.after(() => {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    rmSync(root, { recursive: true, force: true });
  });
  initialize(root, { project_id: 'PENDING' });
  const wf = beginWorkflow(root, { requirement: 'Preserve the saved pending requirement.' });
  ensureRoutingPolicy(root);
  assert.throws(
    () =>
      decideWorkflow(root, wf.meta.id, {
        summary: 'Continue planning.',
        rationale: 'The original requirement remains applicable.',
        task_ids: [],
      }),
    /migration and strategic reassessment/,
  );
  assert.throws(
    () => finishWorkflow(root, wf.meta.id, {}),
    /migration and confirmed strategic coordination/,
  );
  assert.equal(getRecord(root, wf.meta.id).meta.data.phase, 'intake');
});
