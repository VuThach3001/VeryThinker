import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { hostname, tmpdir } from 'node:os';
import { initialize, beginWorkflow, getRecord, updateRecord, hash } from '../dist/index.js';
import {
  claimFastController,
  releaseFastController,
  enqueueFastContinuation,
  assertNoPendingFastContinuation,
  classifyFastControllerOwner,
} from '../dist/fast-controller.js';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'verythinker-fast-controller-'));
  t.after(() => {
    assert.ok(relative(tmpdir(), resolve(root)).startsWith('verythinker-fast-controller-'));
    rmSync(root, { recursive: true, force: true });
  });
  initialize(root, { project_id: 'FASTCTL', profile: 'software' });
  const workflow = beginWorkflow(root, { requirement: 'Preserve the selected fast workflow contract.', request_id: 'fast-controller-test' });
  updateRecord(root, workflow.meta.id, { data: { execution_policy: 'fast', fast_stage: 'planning' } });
  return { root, id: workflow.meta.id };
}

test('controller lease uses pid and token compare-and-set on acquisition and release', (t) => {
  const { root, id } = fixture(t);
  const first = claimFastController(root, id);
  assert.equal(typeof first, 'string');
  assert.equal(claimFastController(root, id), undefined);
  assert.equal(releaseFastController(root, id, 'wrong-token'), false);
  let current = getRecord(root, id);
  assert.equal(current.meta.data.fast_controller_owner_pid, process.pid);
  assert.equal(current.meta.data.fast_controller_owner_token, first);
  assert.equal(releaseFastController(root, id, first), true);
  const second = claimFastController(root, id);
  assert.notEqual(second, first);
  assert.equal(releaseFastController(root, id, first), false);
  assert.equal(getRecord(root, id).meta.data.fast_controller_owner_token, second);
  assert.equal(releaseFastController(root, id, second), true);
  updateRecord(root, id, { data: {
    fast_controller_owner_pid: 2147483647,
    fast_controller_owner_token: 'abandoned',
    fast_controller_owner_host: hostname().trim().toLowerCase(),
    fast_controller_owner_start_epoch_ms: 1000,
    fast_controller_owner_start_identity: 'test:old-process',
  } });
  const recovered = claimFastController(root, id);
  assert.equal(typeof recovered, 'string');
  assert.notEqual(recovered, 'abandoned');
  assert.equal(releaseFastController(root, id, 'abandoned'), false);
  assert.equal(getRecord(root, id).meta.data.fast_controller_owner_token, recovered);
  assert.equal(releaseFastController(root, id, recovered), true);
});

test('stale PID classification requires a matching host and a certain process-start observation', () => {
  const owner = { pid: 42, host: 'host-a', start_epoch_ms: 1000, start_identity: 'proc:old' };
  const current = { pid: 99, host: 'host-a', start_epoch_ms: 5000 };
  assert.equal(classifyFastControllerOwner(owner, current, { state: 'present', identity: 'proc:old' }), 'same-owner');
  assert.equal(classifyFastControllerOwner(owner, current, { state: 'present', identity: 'proc:new' }), 'stale');
  assert.equal(classifyFastControllerOwner(owner, current, { state: 'absent' }), 'stale');
  assert.equal(classifyFastControllerOwner(owner, current, { state: 'unknown' }), 'blocked');
  assert.equal(classifyFastControllerOwner(owner, { ...current, pid: owner.pid, start_epoch_ms: owner.start_epoch_ms }, { state: 'present', identity: owner.start_identity }), 'same-owner');
  assert.equal(classifyFastControllerOwner(owner, { ...current, pid: owner.pid, start_epoch_ms: owner.start_epoch_ms + 1 }, { state: 'present', identity: 'proc:reused-pid' }), 'stale');
  assert.equal(classifyFastControllerOwner(owner, { ...current, pid: owner.pid }, { state: 'unknown' }), 'blocked');
  assert.equal(classifyFastControllerOwner(owner, { ...current, host: 'host-b' }, { state: 'absent' }), 'blocked');
  assert.equal(classifyFastControllerOwner({ ...owner, host: '' }, current, { state: 'absent' }), 'blocked');
  assert.equal(classifyFastControllerOwner({ ...owner, start_identity: '' }, current, { state: 'absent' }), 'blocked');
});

test('Fast continuation queue is idempotent, immutable by id, and blocks the acceptance boundary', (t) => {
  const { root, id } = fixture(t);
  const input = { id: 'continuation-1', request: 'change request', message: 'Please also preserve the existing file format.', invocation_id: 'user-turn-1' };
  const saved = enqueueFastContinuation(root, id, input);
  assert.equal(saved.id, input.id);
  assert.deepEqual(enqueueFastContinuation(root, id, input), saved);
  assert.throws(() => enqueueFastContinuation(root, id, { ...input, message: 'Different payload.' }), /different user input/i);
  assert.throws(() => assertNoPendingFastContinuation(root, id), /pending.*Standard reassessment/i);
  updateRecord(root, id, { data: { applied_continuation_ids: [input.id] } });
  assert.doesNotThrow(() => assertNoPendingFastContinuation(root, id));
  assert.throws(() => enqueueFastContinuation(root, id, input), /already been consumed/i);
});

test('continuation cannot be appended after Fast completion or to a non-Fast workflow', (t) => {
  const { root, id } = fixture(t);
  updateRecord(root, id, { data: { fast_stage: 'completed' } });
  assert.throws(() => enqueueFastContinuation(root, id, { id: 'late', request: 'new', message: 'new intent' }), /already complete/i);
  const normal = beginWorkflow(root, { requirement: 'Keep standard behavior.', request_id: 'standard-workflow' });
  updateRecord(root, normal.meta.id, { data: { execution_policy: 'standard' } });
  assert.throws(() => enqueueFastContinuation(root, normal.meta.id, { id: 'wrong', request: 'new', message: 'new intent' }), /only on a Fast/i);
});

test('managed continuation signature derives a stable id from request id and message', (t) => {
  const { root, id } = fixture(t);
  const message = 'Preserve prior receipts and reassess this request.';
  const saved = enqueueFastContinuation(root, id, message, 'client-request-22');
  assert.equal(saved.id, hash(`client-request-22\n${message}`));
  assert.equal(enqueueFastContinuation(root, id, message, 'client-request-22').id, saved.id);
});
