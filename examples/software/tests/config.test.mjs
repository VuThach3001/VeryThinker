import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { DEFAULT_CONFIG, loadConfig, saveConfig, validateConfig } from '../config.mjs';

test('SW-CHECK-001: valid boundaries and invalid inputs', () => {
  for (const port of [1, 8080, 65535]) {
    for (const logLevel of ['debug', 'info', 'warn', 'error']) {
      assert.deepEqual(validateConfig({ schemaVersion: 1, port, logLevel }), { schemaVersion: 1, port, logLevel });
    }
  }
  for (const value of [null, [], 'config', {}, { ...DEFAULT_CONFIG, extra: true },
    { ...DEFAULT_CONFIG, schemaVersion: 2 }, { ...DEFAULT_CONFIG, port: 0 },
    { ...DEFAULT_CONFIG, port: 65536 }, { ...DEFAULT_CONFIG, port: 1.5 },
    { ...DEFAULT_CONFIG, port: '8080' }, { ...DEFAULT_CONFIG, logLevel: 'silent' }]) {
    assert.throws(() => validateConfig(value));
  }
});

test('SW-CHECK-002: persistent configuration survives a new reader; invalid writes preserve it', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'verythinker-config-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'settings', 'config.json');
  assert.deepEqual(await loadConfig(file), DEFAULT_CONFIG);
  const config = { schemaVersion: 1, port: 3000, logLevel: 'debug' };
  await saveConfig(file, config);
  const before = await readFile(file, 'utf8');
  await assert.rejects(saveConfig(file, { ...config, port: 0 }));
  assert.equal(await readFile(file, 'utf8'), before);
  assert.deepEqual(await loadConfig(file), config);
  await saveConfig(file, { ...config, port: 4000 });
  assert.equal((await loadConfig(file)).port, 4000);
  await writeFile(file, '{broken JSON', 'utf8');
  await assert.rejects(loadConfig(file), SyntaxError);
  assert.equal(await readFile(file, 'utf8'), '{broken JSON');
});

test('SW-CHECK-003: CLI acceptance in separate processes', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'verythinker-config-cli-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'config.json');
  const cli = fileURLToPath(new URL('../cli.mjs', import.meta.url));
  const config = { schemaVersion: 1, port: 8088, logLevel: 'warn' };
  const set = spawnSync(process.execPath, [cli, 'set', file, JSON.stringify(config)], { encoding: 'utf8' });
  assert.equal(set.status, 0, set.stderr);
  const get = spawnSync(process.execPath, [cli, 'get', file], { encoding: 'utf8' });
  assert.equal(get.status, 0, get.stderr);
  assert.deepEqual(JSON.parse(get.stdout), config);
  const invalid = spawnSync(process.execPath, [cli, 'set', file, '{"port":0}'], { encoding: 'utf8' });
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /Configuration/);
  assert.deepEqual(await loadConfig(file), config);
});
