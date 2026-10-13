import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initialize, updateRecord, getRecord, hash, loadRecords } from '../dist/storage.js';
import { beginWorkflow, workflowStatus } from '../dist/manager.js';
import { managedRun } from '../dist/managed.js';
import { ensureRoutingPolicy } from '../dist/routing.js';
import { createNativeBridge, shutdownNative } from '../dist/native.js';

test('active intake saves user continuation once without duplicating or claiming native incorporation', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'vt-continuation-'));
  initialize(root, { project_id: 'CONTINUATION' });
  const workflow = beginWorkflow(root, { requirement: 'Deliver the documented behavior.' });
  ensureRoutingPolicy(root);
  t.after(async () => {
    await shutdownNative(root);
    rmSync(root, { recursive: true, force: true });
  });
  const bridge = createNativeBridge({
    runtime: async () => ({
      version: '0.162.1',
      command: process.execPath,
      args: [
        fileURLToPath(new URL('../resources/native/fake-app-server.mjs', import.meta.url)),
        'hang',
      ],
      integrity: 'protocol-fixture',
      protocol_sha256: 'protocol-fixture',
      executable_sha256: 'protocol-fixture',
      test_fixture: true,
    }),
  });
  const invocation = await bridge.start(root, {
    role: 'manager',
    prompt: 'Protocol mechanics only.',
    workflow_id: workflow.meta.id,
  });
  updateRecord(root, workflow.meta.id, { data: { native_manager_attempt_id: invocation.id } });
  const receiptBefore = readFileSync(join(root, invocation.receipt_path));
  const input = {
    workflow_id: workflow.meta.id,
    message: 'Preserve existing learner answers.',
    request_id: 'same-user-continuation',
  };
  const first = await managedRun(root, input);
  assert.equal(first.invocation.id, invocation.id);
  assert.equal(first.continuation.status, 'queued');
  assert.match(first.continuation.observation, /not yet acknowledged/);
  assert.equal(first.workflow.pending_continuations.length, 1);
  assert.equal(first.workflow.pending_continuations[0].message, input.message);
  assert.equal(first.workflow.phase, 'reassessment-required');
  const revision = getRecord(root, workflow.meta.id).meta.revision;
  const retry = await managedRun(root, input);
  assert.equal(retry.continuation.id, first.continuation.id);
  assert.equal(getRecord(root, workflow.meta.id).meta.revision, revision);
  assert.deepEqual(readFileSync(join(root, invocation.receipt_path)), receiptBefore);
  updateRecord(root, workflow.meta.id, {
    data: { applied_continuation_ids: [first.continuation.id] },
  });
  assert.deepEqual(workflowStatus(root, workflow.meta.id).pending_continuations, []);
  assert.equal(invocation.execution_mode, 'protocol-fixture');

  updateRecord(root, workflow.meta.id, {
    data: { applied_continuation_ids: [], phase: 'awaiting-native-completion' },
  });
  await bridge.interrupt(root, invocation.id);
  const completedBridge = createNativeBridge({
    runtime: async () => ({
      version: '0.162.1',
      command: process.execPath,
      args: [
        fileURLToPath(new URL('../resources/native/fake-app-server.mjs', import.meta.url)),
        'success',
      ],
      integrity: 'protocol-fixture',
      protocol_sha256: 'protocol-fixture',
      executable_sha256: 'protocol-fixture',
      test_fixture: true,
    }),
  });
  const resumed = await completedBridge.resume(root, invocation.id);
  await completedBridge.wait(root, resumed.id, 1000);
  updateRecord(root, workflow.meta.id, { data: { native_manager_attempt_id: resumed.id } });
  let continuationPrompt;
  const observed = await managedRun(root, { workflow_id: workflow.meta.id }, undefined, {
    start: async () => {
      throw new Error('Unexpected duplicate coordinator.');
    },
    resume: async (_root, id, options) => {
      assert.equal(id, resumed.id);
      continuationPrompt = options.prompt;
      throw new Error('Fixture intentionally stops before inference.');
    },
  });
  assert.match(observed.blocker, /intentionally stops/);
  assert.match(continuationPrompt, /Preserve existing learner answers/);
  assert.match(continuationPrompt, new RegExp(first.continuation.id));
  assert.equal(workflowStatus(root, workflow.meta.id).pending_continuations.length, 1);

  const intentPath = join(root, '.verythinker/archive-intents', `${hash(workflow.meta.id)}.json`);
  mkdirSync(join(root, '.verythinker/archive-intents'), { recursive: true });
  // A control-plane fixture marker exercises the boundary; it is not a real accepted snapshot.
  writeFileSync(intentPath, JSON.stringify({ snapshot_id: 'protocol-fixture-boundary' }));
  const intentBefore = readFileSync(intentPath);
  let nextWorkflow;
  const forwarded = await managedRun(root, { workflow_id: workflow.meta.id }, undefined, {
    start: async (_root, packet) => {
      nextWorkflow = packet.workflow_id;
      throw new Error('Fixture follow-up stops before inference.');
    },
    resume: async () => {
      throw new Error('Frozen coordinator must not be resumed.');
    },
  });
  assert.match(forwarded.blocker, /follow-up stops/);
  assert.notEqual(nextWorkflow, workflow.meta.id);
  assert.equal(getRecord(root, nextWorkflow).meta.data.prior_workflow_id, workflow.meta.id);
  assert.deepEqual(readFileSync(intentPath), intentBefore);
  assert.deepEqual(workflowStatus(root, workflow.meta.id).pending_continuations, []);
  assert.equal(
    loadRecords(root).filter((record) => record.meta.data.kind === 'manager-workflow').length,
    2,
  );
});
