import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { initialize } from '../dist/storage.js';
import { ensureRoutingPolicy } from '../dist/routing.js';
import { createNativeBridge, shutdownNative } from '../dist/native.js';

const fixture = fileURLToPath(new URL('../resources/native/fake-app-server.mjs', import.meta.url));
const pendingPath = '.verythinker/cache/native/pending-initial-key.json';
const privatePath = '.verythinker/cache/native/private-key.pem';
const trustPath = '.verythinker/native/trust.json';
function project(t) {
  const root = mkdtempSync(join(tmpdir(), 'verythinker-provisioning-'));
  initialize(root, { project_id: 'PROVISIONING-TEST' });
  ensureRoutingPolicy(root);
  t.after(async () => {
    await shutdownNative();
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    rmSync(root, { recursive: true, force: true });
  });
  return root;
}
function bridge(provisioning_hook) {
  return createNativeBridge({
    provisioning_hook,
    runtime: async () => ({
      version: '0.162.1',
      command: process.execPath,
      args: [fixture, 'success'],
      integrity: 'protocol-fixture',
      protocol_sha256: 'protocol-fixture',
      executable_sha256: 'protocol-fixture',
      test_fixture: true,
    }),
  });
}
function bytesIfPresent(root, relativePath) {
  const path = join(root, relativePath);
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}
function receiptFiles(root) {
  const path = join(root, '.verythinker/native/receipts');
  return existsSync(path) ? readdirSync(path).filter((name) => name.endsWith('.json')) : [];
}

test('a staged signed first key recovers the same identity after each public-trust publication window', async (t) => {
  for (const stage of ['pending', 'public', 'trust']) {
    const root = project(t);
    const interrupted = bridge((current) => {
      if (current === stage) throw new Error(`simulated provisioning crash at ${stage}`);
    });
    await assert.rejects(
      interrupted.start(root, { role: 'manager', prompt: `Crash at ${stage}.` }),
      new RegExp(`simulated provisioning crash at ${stage}`),
    );
    const pending = JSON.parse(readFileSync(join(root, pendingPath), 'utf8'));
    const publicPath = `.verythinker/native/keys/${pending.key_id}.pem`;
    assert.equal(bytesIfPresent(root, privatePath), null);
    assert.deepEqual(receiptFiles(root), []);
    assert.equal(existsSync(join(root, publicPath)), stage !== 'pending');
    assert.equal(existsSync(join(root, trustPath)), stage === 'trust');

    const retried = await bridge().start(root, {
      role: 'manager',
      prompt: `Retry after ${stage}.`,
    });
    assert.equal(retried.key_id, pending.key_id);
    assert.equal(retried.execution_mode, 'protocol-fixture');
    assert.equal(bytesIfPresent(root, pendingPath), null);
    assert.ok(bytesIfPresent(root, privatePath));
    assert.ok(bytesIfPresent(root, '.verythinker/cache/native/trust-backup.json'));
  }
});

test('signed pending recovery refuses a project mismatch or changed trust without writing', async (t) => {
  for (const change of ['project', 'trust']) {
    const root = project(t);
    const stage = change === 'project' ? 'public' : 'trust';
    await assert.rejects(
      bridge((current) => {
        if (current === stage) throw new Error('simulated provisioning crash');
      }).start(root, { role: 'manager', prompt: `Prepare ${change} mismatch.` }),
      /simulated provisioning crash/,
    );
    const pending = JSON.parse(readFileSync(join(root, pendingPath), 'utf8'));
    if (change === 'project') {
      const configPath = join(root, '.verythinker/config.json');
      const config = JSON.parse(readFileSync(configPath, 'utf8'));
      config.project_id = 'DIFFERENT-PROJECT';
      writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
    } else {
      writeFileSync(join(root, trustPath), '{"schema_version":1,"keys":[]}\n');
    }
    const paths = [
      pendingPath,
      privatePath,
      trustPath,
      `.verythinker/native/keys/${pending.key_id}.pem`,
    ];
    const before = Object.fromEntries(paths.map((path) => [path, bytesIfPresent(root, path)]));
    await assert.rejects(
      bridge().start(root, { role: 'manager', prompt: `Retry with changed ${change}.` }),
    );
    const after = Object.fromEntries(paths.map((path) => [path, bytesIfPresent(root, path)]));
    assert.deepEqual(after, before);
    assert.deepEqual(receiptFiles(root), []);
  }
});
