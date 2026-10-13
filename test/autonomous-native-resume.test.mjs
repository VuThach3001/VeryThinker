import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { initialize, updateRecord } from '../dist/storage.js';
import { ensureRoutingPolicy, readInvocation } from '../dist/routing.js';
import { createNativeBridge, nativeResumeTarget, shutdownNative } from '../dist/native.js';
import { beginWorkflow } from '../dist/manager.js';
import { managedRun } from '../dist/managed.js';

const fixture = fileURLToPath(new URL('../resources/native/fake-app-server.mjs', import.meta.url));
function project(t) {
  const root = mkdtempSync(join(tmpdir(), 'verythinker-resume-'));
  initialize(root, { project_id: 'RESUME-TEST', name: 'Bounded native resume fixture' });
  ensureRoutingPolicy(root);
  t.after(async () => {
    await shutdownNative();
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    rmSync(root, { recursive: true, force: true });
  });
  return root;
}
function bridge(scenario) {
  return createNativeBridge({
    rpc_timeout_ms: 5000,
    runtime: async () => ({
      version: '0.162.1', command: process.execPath, args: [fixture, scenario],
      integrity: 'protocol-fixture', protocol_sha256: 'protocol-fixture',
      executable_sha256: 'protocol-fixture', test_fixture: true,
    }),
  });
}
async function completed(root, native, workflow_id = 'WF-1') {
  const receipt = await native.start(root, { role: 'manager', workflow_id, prompt: 'Coordinate an existing assignment.' });
  const done = await native.wait(root, receipt.id, 1000);
  assert.equal(done.state, 'completed');
  await new Promise((resolve) => setTimeout(resolve, 75));
  return readInvocation(root, receipt.id);
}
test('large saved conversation resumes without hydrating historical items', async (t) => {
  const root = project(t), native = bridge('large-resume');
  const original = await completed(root, native);
  const originalBytes = readFileSync(join(root, original.receipt_path));
  const next = await native.resume(root, original.id, { prompt: 'Continue the saved assignment.' });
  assert.equal(next.native_thread_id, original.native_thread_id);
  assert.equal((await native.wait(root, next.id, 1000)).state, 'completed');
  assert.deepEqual(readFileSync(join(root, original.receipt_path)), originalBytes);
});
test('failed pre-acknowledgment retry preserves immediate lineage and recovers the original thread', async (t) => {
  const root = project(t), good = bridge('large-resume');
  const original = await completed(root, good);
  const failed = await bridge('resume-pre-ack-failure').resume(root, original.id, { prompt: 'Continue after a temporary failure.' });
  assert.equal(failed.state, 'blocked');
  assert.equal(failed.native_thread_id, null);
  assert.equal(failed.prior_invocation_id, original.id);
  await new Promise((resolve) => setTimeout(resolve, 75));
  const failedBytes = readFileSync(join(root, failed.receipt_path));
  const next = await good.resume(root, failed.id, { prompt: 'Retry bounded resume.' });
  assert.equal(next.prior_invocation_id, failed.id);
  assert.equal(next.native_thread_id, original.native_thread_id);
  assert.equal((await good.wait(root, next.id, 1000)).state, 'completed');
  assert.deepEqual(readFileSync(join(root, failed.receipt_path)), failedBytes);
  assert.throws(() => nativeResumeTarget(root, { ...failed, workflow_id: 'another-workflow' }), /another assignment/);
});
test('managed intake retries a failed saved resume rather than starting a duplicate conversation', async (t) => {
  const root = project(t), native = bridge('large-resume');
  const workflow = beginWorkflow(root, { requirement: 'Produce the requested saved output.' });
  const original = await completed(root, native, workflow.meta.id);
  const failed = await bridge('resume-pre-ack-failure').resume(root, original.id);
  await new Promise((resolve) => setTimeout(resolve, 75));
  updateRecord(root, workflow.meta.id, { data: { native_manager_attempt_id: failed.id } });
  let resumed;
  const result = await managedRun(root, { workflow_id: workflow.meta.id, message: 'Continue the saved request.' }, undefined, {
    start: async () => { throw new Error('A duplicate new conversation must not start.'); },
    resume: async (...args) => { resumed = await native.resume(...args); return resumed; },
  });
  // The fixture proves routing mechanics, while core binding still rejects it
  // as proof of real authenticated execution.
  assert.match(result.blocker, /Protocol fixture receipts cannot establish authenticated/);
  assert.equal(resumed.prior_invocation_id, failed.id);
  assert.equal(resumed.native_thread_id, original.native_thread_id);
  assert.equal((await native.wait(root, resumed.id, 1000)).state, 'completed');
});
