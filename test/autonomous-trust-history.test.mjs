import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initialize } from '../dist/storage.js';
import {
  ensureRoutingPolicy,
  readInvocation,
  assertTerminalHistory,
  routingProblems,
} from '../dist/routing.js';
import { ensureNativeTrustFiles } from '../dist/trust.js';
import { createNativeBridge, shutdownNative } from '../dist/native.js';

const fixture = fileURLToPath(new URL('../resources/native/fake-app-server.mjs', import.meta.url));
async function project(t, scenario = 'success') {
  const root = mkdtempSync(join(tmpdir(), 'vt-trust-recovery-'));
  initialize(root, { project_id: 'TRUST-RECOVERY' });
  ensureRoutingPolicy(root);
  t.after(async () => {
    await shutdownNative(root);
    rmSync(root, { recursive: true, force: true });
  });
  const bridge = createNativeBridge({
    runtime: async () => ({
      version: '0.162.1',
      command: process.execPath,
      args: [fixture, scenario],
      integrity: 'protocol-fixture',
      protocol_sha256: 'protocol-fixture',
      executable_sha256: 'protocol-fixture',
      test_fixture: true,
    }),
  });
  const receipt = await bridge.start(root, {
    role: 'reviewer',
    prompt: 'Protocol mechanics only.',
    workflow_id: 'WF-RECOVERY',
  });
  return { root, bridge, receipt };
}

test('missing public trust files restore automatically and preserve receipt/private-key bytes', async (t) => {
  const { root, bridge, receipt } = await project(t);
  await bridge.wait(root, receipt.id, 1000);
  const receiptPath = join(root, receipt.receipt_path);
  const before = readFileSync(receiptPath);
  const privatePath = join(root, '.verythinker/cache/native/private-key.pem');
  const privateBefore = readFileSync(privatePath);
  const trustPath = join(root, '.verythinker/native/trust.json');
  const trustBefore = readFileSync(trustPath);
  const keyPath = join(root, `.verythinker/native/keys/${receipt.key_id}.pem`);
  for (const mode of ['key', 'trust', 'both']) {
    if (mode !== 'trust') rmSync(keyPath);
    if (mode !== 'key') rmSync(trustPath);
    assert.equal(readInvocation(root, receipt.id).state, 'completed');
    assert.deepEqual(readFileSync(receiptPath), before);
    assert.deepEqual(readFileSync(privatePath), privateBefore);
    assert.deepEqual(readFileSync(trustPath), trustBefore);
    assert.ok(existsSync(keyPath));
  }
  assert.match(routingProblems(root, 'reviewer', receipt.id).join(' '), /Protocol fixture/);
});

test('missing trust without corroborating backup is not an invitation to enroll a key', async (t) => {
  const { root, bridge, receipt } = await project(t);
  await bridge.wait(root, receipt.id, 1000);
  const trustPath = join(root, '.verythinker/native/trust.json');
  rmSync(trustPath);
  rmSync(join(root, '.verythinker/cache/native/trust-backup.json'));
  assert.throws(() => readInvocation(root, receipt.id), /no verified local backup/);
  assert.equal(existsSync(trustPath), false);
});

test('existing revoked, mismatched, malformed and tampered trust decisions are preserved', async (t) => {
  const { root, bridge, receipt } = await project(t);
  await bridge.wait(root, receipt.id, 1000);
  const trustPath = join(root, '.verythinker/native/trust.json');
  const keyPath = join(root, `.verythinker/native/keys/${receipt.key_id}.pem`);
  const trust = readFileSync(trustPath, 'utf8');
  const key = readFileSync(keyPath, 'utf8');
  for (const bad of ['{"schema_version":1,"keys":[]}', '{"keys":"malformed"}']) {
    writeFileSync(trustPath, bad);
    assert.throws(() => ensureNativeTrustFiles(root, true), /not trusted|malformed/);
    assert.equal(readFileSync(trustPath, 'utf8'), bad);
  }
  writeFileSync(trustPath, trust);
  writeFileSync(keyPath, 'mismatched-key');
  assert.throws(() => ensureNativeTrustFiles(root, true), /mismatched/);
  assert.equal(readFileSync(keyPath, 'utf8'), 'mismatched-key');
  writeFileSync(keyPath, key);
  const backupPath = join(root, '.verythinker/cache/native/trust-backup.json');
  const bad = JSON.parse(readFileSync(backupPath, 'utf8'));
  bad.project_id = 'FOREIGN-PROJECT';
  writeFileSync(backupPath, JSON.stringify(bad));
  rmSync(trustPath);
  assert.throws(() => readInvocation(root, receipt.id), /not a matching verified/);
  assert.equal(existsSync(trustPath), false);
  writeFileSync(trustPath, trust);
  assert.doesNotThrow(() => ensureNativeTrustFiles(root, true));
});

test('terminal history can be documented without turning an interrupted fixture into accepted evidence', async (t) => {
  const { root, bridge, receipt } = await project(t, 'hang');
  const binding = { workflow_id: 'WF-RECOVERY', task_id: null };
  assert.throws(
    () => assertTerminalHistory(root, 'reviewer', receipt.id, binding),
    /still running/,
  );
  await bridge.interrupt(root, receipt.id);
  const history = assertTerminalHistory(root, 'reviewer', receipt.id, binding);
  assert.equal(history.state, 'interrupted');
  assert.equal(history.execution_mode, 'protocol-fixture');
  assert.match(routingProblems(root, 'reviewer', receipt.id).join(' '), /not completed/);
  assert.throws(
    () => assertTerminalHistory(root, 'developer', receipt.id, binding),
    /another role/,
  );
  assert.throws(
    () => assertTerminalHistory(root, 'reviewer', receipt.id, { ...binding, workflow_id: 'OTHER' }),
    /another role/,
  );
  const path = join(root, history.receipt_path),
    original = readFileSync(path, 'utf8');
  const forged = JSON.parse(original);
  forged.error = 'forged history';
  writeFileSync(path, JSON.stringify(forged));
  assert.throws(() => assertTerminalHistory(root, 'reviewer', receipt.id, binding), /signature/);
  writeFileSync(path, original);
});

test('loss of the original private key never enrolls a replacement in an initialized project', async (t) => {
  const { root, bridge, receipt } = await project(t);
  await bridge.wait(root, receipt.id, 1000);
  const trustPath = join(root, '.verythinker/native/trust.json');
  const before = readFileSync(trustPath);
  const receiptBefore = readFileSync(join(root, receipt.receipt_path));
  const keyPath = join(root, '.verythinker/cache/native/private-key.pem');
  rmSync(keyPath);
  assert.equal(readInvocation(root, receipt.id).state, 'completed');
  await assert.rejects(
    bridge.start(root, { role: 'reviewer', prompt: 'Never re-enroll.' }),
    /original native signing key is missing/,
  );
  assert.deepEqual(readFileSync(trustPath), before);
  assert.deepEqual(readFileSync(join(root, receipt.receipt_path)), receiptBefore);
  assert.equal(existsSync(keyPath), false);
});
