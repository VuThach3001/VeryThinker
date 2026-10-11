import test from 'node:test';
import assert from 'node:assert/strict';
import {
  copyFileSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createRecord, getRecord, initialize, loadRecords } from '../dist/storage.js';

function project(t) {
  const root = mkdtempSync(join(tmpdir(), 'verythinker-record-cache-'));
  initialize(root, { project_id: 'CACHE', name: 'Fresh record-byte cache fixture' });
  t.after(() => {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    rmSync(root, { recursive: true, force: true });
  });
  return root;
}
function record(root, data = {}) {
  return createRecord(root, {
    type: 'requirement',
    title: 'alpha contract',
    owner: 'requirements',
    data,
    body: 'The original record body remains measurable.\n',
  });
}

test('record memoization observes same-size edits with restored modification timestamps', (t) => {
  const root = project(t);
  const item = record(root);
  assert.equal(getRecord(root, item.meta.id).meta.title, 'alpha contract');
  const path = join(root, item.path);
  const original = readFileSync(path, 'utf8');
  const stamp = statSync(path);
  const edited = original.replace('alpha contract', 'omega contract');
  assert.equal(Buffer.byteLength(edited), Buffer.byteLength(original));
  writeFileSync(path, edited);
  utimesSync(path, stamp.atime, stamp.mtime);
  assert.equal(Math.round(statSync(path).mtimeMs), Math.round(stamp.mtimeMs));
  assert.equal(getRecord(root, item.meta.id).meta.title, 'omega contract');
});

test('cached content never hides duplicate IDs, fresh renamed paths, or deleted files', (t) => {
  const root = project(t);
  const item = record(root);
  getRecord(root, item.meta.id);
  const original = join(root, item.path);
  const duplicate = join(root, '.verythinker/records/copied.md');
  copyFileSync(original, duplicate);
  assert.throws(() => loadRecords(root), /Duplicate record ID/);
  rmSync(duplicate);
  const renamed = join(root, '.verythinker/records/renamed.md');
  renameSync(original, renamed);
  assert.equal(getRecord(root, item.meta.id).path, '.verythinker/records/renamed.md');
  rmSync(renamed);
  assert.deepEqual(loadRecords(root), []);
  assert.throws(() => getRecord(root, item.meta.id), /Record not found/);
});

test('cached record returns keep nested data independent and preserve allowed YAML value shapes', (t) => {
  const root = project(t);
  const shared = { count: 7, list: ['preserved'] };
  const cyclic = { label: 'cycle' };
  cyclic.self = cyclic;
  const item = record(root, {
    shared,
    alias: shared,
    cyclic,
    notANumber: NaN,
    positiveInfinity: Infinity,
  });
  const first = getRecord(root, item.meta.id);
  const second = getRecord(root, item.meta.id);
  assert.notEqual(first.meta, second.meta);
  assert.notEqual(first.meta.data.shared, second.meta.data.shared);
  assert.equal(first.meta.data.shared, first.meta.data.alias);
  assert.equal(second.meta.data.shared, second.meta.data.alias);
  assert.equal(second.meta.data.cyclic.self, second.meta.data.cyclic);
  assert.equal(Number.isNaN(second.meta.data.notANumber), true);
  assert.equal(second.meta.data.positiveInfinity, Infinity);
  first.meta.data.shared.list.push('caller mutation');
  first.meta.links.push({ type: 'references', target: item.meta.id });
  const fresh = getRecord(root, item.meta.id);
  assert.deepEqual(fresh.meta.data.shared.list, ['preserved']);
  assert.deepEqual(fresh.meta.links, []);
  second.meta.data.cyclic.label = 'another mutation';
  assert.equal(getRecord(root, item.meta.id).meta.data.cyclic.label, 'cycle');
});

test('invalid replacements and configuration remain fresh failures rather than cached results', (t) => {
  const root = project(t);
  const item = record(root);
  const path = join(root, item.path);
  const original = readFileSync(path);
  getRecord(root, item.meta.id);
  for (const invalid of [
    'No frontmatter is present.\n',
    original.toString('utf8').replace('revision: 1', 'revision: 0'),
  ]) {
    writeFileSync(path, invalid);
    assert.throws(() => getRecord(root, item.meta.id), /frontmatter|metadata/);
    writeFileSync(path, original);
    assert.equal(getRecord(root, item.meta.id).meta.revision, 1);
  }
  const configPath = join(root, '.verythinker/config.json');
  const config = readFileSync(configPath);
  writeFileSync(
    configPath,
    config.toString('utf8').replace('"schema_version": 1', '"schema_version": 2'),
  );
  assert.throws(() => getRecord(root, item.meta.id), /configuration/);
  writeFileSync(configPath, config);
  assert.equal(getRecord(root, item.meta.id).meta.id, item.meta.id);
});

test('record freshness and caller independence survive a collection exceeding the memo entry bound', (t) => {
  const root = project(t);
  const item = record(root);
  const original = readFileSync(join(root, item.path), 'utf8');
  for (let index = 2; index <= 1030; index++)
    writeFileSync(
      join(root, `.verythinker/records/entry-${index}.md`),
      original.replaceAll(item.meta.id, `CACHE-REQ-${String(index).padStart(4, '0')}`),
    );
  assert.equal(loadRecords(root).length, 1030);
  const loaded = loadRecords(root);
  loaded[0].meta.data.modifiedByCaller = true;
  assert.equal(
    loadRecords(root).every((entry) => entry.meta.data.modifiedByCaller === undefined),
    true,
  );
  const path = join(root, item.path);
  const stamp = statSync(path);
  writeFileSync(path, original.replace('alpha contract', 'omega contract'));
  utimesSync(path, stamp.atime, stamp.mtime);
  assert.equal(getRecord(root, item.meta.id).meta.title, 'omega contract');
});
