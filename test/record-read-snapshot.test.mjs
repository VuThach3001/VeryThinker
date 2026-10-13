import test from 'node:test';
import assert from 'node:assert/strict';
import {
  copyFileSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createRecord,
  getRecord,
  initialize,
  loadRecords,
  sourceHash,
  withRecordReadSnapshot,
} from '../dist/storage.js';

function project(t) {
  const root = mkdtempSync(join(tmpdir(), 'verythinker-read-snapshot-'));
  initialize(root, { project_id: 'SNAPSHOT', name: 'Read snapshot fixture' });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function record(root) {
  return createRecord(root, {
    type: 'requirement',
    title: 'snapshot contract',
    owner: 'test',
    data: { nested: { items: ['original'] } },
  });
}

test('snapshot loads once and each caller receives an independent mutable copy', (t) => {
  const root = project(t);
  const item = record(root);
  const result = withRecordReadSnapshot(root, () => {
    const first = getRecord(root, item.meta.id);
    first.meta.data.nested.items.push('caller');
    const second = loadRecords(root)[0];
    assert.deepEqual(second.meta.data.nested.items, ['original']);
    return second;
  });
  result.meta.data.nested.items.push('returned');
  assert.deepEqual(getRecord(root, item.meta.id).meta.data.nested.items, ['original']);
  withRecordReadSnapshot(root, () => {
    const first = getRecord(root, item.meta.id);
    first.meta.data.nested.items.push('single-record caller');
    assert.deepEqual(getRecord(root, item.meta.id).meta.data.nested.items, ['original']);
  });
});

test('snapshot source hash matches the authoritative hash and refreshes in a new operation', (t) => {
  const root = project(t);
  const item = record(root);
  const initial = sourceHash(root);
  assert.equal(
    withRecordReadSnapshot(root, () => sourceHash(root)),
    initial,
  );
  const path = join(root, item.path);
  writeFileSync(path, readFileSync(path, 'utf8').replace('snapshot contract', 'updated contract'));
  const updated = sourceHash(root);
  assert.notEqual(updated, initial);
  assert.equal(
    withRecordReadSnapshot(root, () => sourceHash(root)),
    updated,
  );
});

test('snapshot detects same-mtime byte edits, added duplicates, and rename inventory changes', (t) => {
  const root = project(t);
  const item = record(root);
  const path = join(root, item.path);
  const original = readFileSync(path, 'utf8');
  assert.throws(
    () =>
      withRecordReadSnapshot(root, () => {
        writeFileSync(path, original.replace('snapshot contract', 'changed snapshot!'));
        return loadRecords(root);
      }),
    /changed during the read snapshot/,
  );
  writeFileSync(path, original);
  assert.throws(
    () =>
      withRecordReadSnapshot(root, () => {
        copyFileSync(path, join(root, '.verythinker/records/duplicate.md'));
      }),
    /Duplicate record ID/,
  );
  rmSync(join(root, '.verythinker/records/duplicate.md'));
  assert.throws(
    () =>
      withRecordReadSnapshot(root, () => {
        renameSync(path, join(root, '.verythinker/records/renamed.md'));
      }),
    /changed during the read snapshot/,
  );
});

test('snapshot detects configuration changes and invalid authoritative state', (t) => {
  const root = project(t);
  const config = join(root, '.verythinker/config.json');
  const original = readFileSync(config, 'utf8');
  assert.throws(
    () =>
      withRecordReadSnapshot(root, () => {
        writeFileSync(config, original.replace('Read snapshot fixture', 'Other fixture'));
      }),
    /changed during the read snapshot/,
  );
  assert.throws(
    () =>
      withRecordReadSnapshot(root, () => {
        writeFileSync(config, '{');
      }),
    /JSON|configuration/,
  );
});

test('nested reads work, writes and async callbacks fail, and errors always clear context', (t) => {
  const root = project(t);
  const item = record(root);
  assert.equal(
    withRecordReadSnapshot(root, () =>
      withRecordReadSnapshot(root, () => getRecord(root, item.meta.id).meta.title),
    ),
    'snapshot contract',
  );
  assert.throws(
    () =>
      withRecordReadSnapshot(root, () =>
        createRecord(root, { type: 'task', title: 'forbidden', owner: 'test' }),
      ),
    /prohibited/,
  );
  assert.throws(() => withRecordReadSnapshot(root, () => Promise.resolve()), /synchronous/);
  assert.throws(
    () =>
      withRecordReadSnapshot(root, () => {
        throw new Error('callback failure');
      }),
    /callback failure/,
  );
  assert.equal(getRecord(root, item.meta.id).meta.title, 'snapshot contract');
});
