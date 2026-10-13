import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { initialize, createRecord, updateRecord } from '../dist/storage.js';
import { workflowProgress } from '../dist/progress.js';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'verythinker-progress-'));
  initialize(root, { project_id: 'PROGRESS', profile: 'basic' });
  t.after(() => {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    rmSync(root, { recursive: true, force: true });
  });
  const task = createRecord(root, { type: 'task', title: 'Bounded task', owner: 'developer', status: 'ready' });
  const workflow = createRecord(root, {
    type: 'knowledge', title: 'Workflow: bounded task', owner: 'manager', status: 'in-progress',
    data: {
      kind: 'manager-workflow', phase: 'planning', task_ids: [task.meta.id],
      pending_continuations: [{ id: 'continuation-1', message: 'sensitive body', message_hash: 'abc', received_at: '2026-10-13T00:00:00Z' }],
      publication_disposition: { status: 'pending', blockers: ['remote unavailable'] },
    },
  });
  return { root, task, workflow };
}

test('progress is compact, compatible with legacy records, and never proves acceptance', (t) => {
  const { root, task, workflow } = fixture(t);
  const progress = workflowProgress(root, workflow.meta.id);
  assert.equal(progress.schema_version, 1);
  assert.equal(progress.workflow_id, workflow.meta.id);
  assert.equal(progress.phase, 'planning');
  assert.equal(progress.status, 'in-progress');
  assert.deepEqual(progress.task_metadata, [{ id: task.meta.id, owner: 'developer', status: 'ready' }]);
  assert.deepEqual(progress.pending_continuations, [{ id: 'continuation-1', received_at: '2026-10-13T00:00:00Z' }]);
  assert.equal(JSON.stringify(progress).includes('sensitive body'), false);
  assert.deepEqual(progress.validation, { status: 'not-evaluated', acceptance_proof: false });
  assert.ok(progress.blockers.includes('Publication is pending.'));
  assert.equal(progress.native_current_state, null);
  assert.deepEqual(workflowProgress(root).map((item) => item.workflow_id), [workflow.meta.id]);
});

test('each request sees changed and deleted records without a process cache', (t) => {
  const { root, task, workflow } = fixture(t);
  updateRecord(root, workflow.meta.id, { data: { phase: 'execution' } });
  updateRecord(root, task.meta.id, { status: 'blocked' });
  assert.equal(workflowProgress(root, workflow.meta.id).phase, 'execution');
  assert.equal(workflowProgress(root, workflow.meta.id).task_metadata[0].status, 'blocked');
  unlinkSync(join(root, task.path));
  assert.deepEqual(workflowProgress(root, workflow.meta.id).task_metadata, []);
  assert.throws(() => workflowProgress(root, 'WF-missing'), /not found/);
});

test('missing and tampered native receipts are surfaced without accepted proof', (t) => {
  const { root, workflow } = fixture(t);
  const missingId = '10000000-0000-4000-8000-000000000001';
  updateRecord(root, workflow.meta.id, { data: { invocation_id: missingId } });
  let progress = workflowProgress(root, workflow.meta.id);
  assert.equal(progress.native_current_state.observation, 'missing');
  assert.equal(progress.validation.acceptance_proof, false);

  const tamperedId = '20000000-0000-4000-8000-000000000002';
  updateRecord(root, workflow.meta.id, { data: { invocation_id: tamperedId } });
  mkdirSync(join(root, '.verythinker/native/receipts'), { recursive: true });
  mkdirSync(join(root, '.verythinker/native/keys'), { recursive: true });
  const keyId = 'a'.repeat(64);
  writeFileSync(join(root, '.verythinker/native/trust.json'), JSON.stringify({ keys: [keyId] }));
  writeFileSync(join(root, `.verythinker/native/keys/${keyId}.pem`), 'tampered-key');
  writeFileSync(join(root, `.verythinker/native/receipts/${tamperedId}.json`), JSON.stringify({
    schema_version: 1, issuer: 'verythinker-codex-app-server', id: tamperedId,
    project_id: 'PROGRESS', receipt_path: `.verythinker/native/receipts/${tamperedId}.json`,
    key_id: keyId, signature: 'invalid',
  }));
  progress = workflowProgress(root, workflow.meta.id);
  assert.equal(progress.native_current_state.observation, 'invalid');
  assert.equal(progress.validation.acceptance_proof, false);
});
