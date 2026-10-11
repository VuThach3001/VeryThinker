import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createRecord, hash, initialize, updateRecord } from '../dist/storage.js';
import {
  captureEvidenceInputs,
  evidenceInputArtifactPaths,
  evidenceRecordFingerprint,
  recoverLegacyEvidenceInputs,
  validateEvidenceInputs,
} from '../dist/evidence-inputs.js';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'verythinker-inputs-'));
  t.after(() => {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    assert.match(root, /verythinker-inputs-/);
    rmSync(root, { recursive: true, force: true });
  });
  initialize(root, { project_id: 'INPUTS' });
  mkdirSync(join(root, 'src'));
  mkdirSync(join(root, '.codex'));
  writeFileSync(join(root, '.codex/config.toml'), 'client_tag = "local-only"\n');
  const bytes = Buffer.from([0, 255, 17, 0, 128, 4]);
  writeFileSync(join(root, 'src/source.bin'), bytes);
  const requirement = createRecord(root, {
    type: 'requirement',
    title: 'Preserve the exact binary input',
    data: { acceptance_criteria: ['The stored byte sequence is preserved.'] },
  });
  const check = createRecord(root, {
    type: 'check',
    title: 'Inspect the immutable binary baseline',
    links: [{ type: 'verifies', target: requirement.meta.id }],
    data: { command: [process.execPath, '-e', 'process.exit(0)'], baseline_paths: ['src'] },
  });
  const files = { 'src/source.bin': hash(bytes) };
  const record_fingerprints = { [requirement.meta.id]: evidenceRecordFingerprint(requirement) };
  const evidence = createRecord(root, {
    type: 'evidence',
    title: 'Legacy validation input metadata',
    links: [{ type: 'evidence-for', target: check.meta.id }],
    data: {
      file_baseline: files,
      record_baseline: record_fingerprints,
      check_id: check.meta.id,
      check_fingerprint: evidenceRecordFingerprint(check),
    },
  });
  return {
    root,
    bytes,
    requirement,
    check,
    files,
    record_fingerprints,
    evidence,
    expected: {
      files,
      record_fingerprints,
      check_id: check.meta.id,
      check_fingerprint: evidenceRecordFingerprint(check),
    },
  };
}
test('captures original bytes and oracle records independently of later edits and deletions', (t) => {
  const work = fixture(t);
  const reference = captureEvidenceInputs(work.root, {
    files: work.files,
    records: [work.requirement, work.check],
    record_fingerprints: {
      ...work.record_fingerprints,
      [work.check.meta.id]: evidenceRecordFingerprint(work.check),
    },
  });
  const initial = validateEvidenceInputs(work.root, reference, work.expected);
  assert.equal(initial.provenance, 'captured-before-execution');
  assert.equal(initial.context_files['.codex/config.toml'], undefined);
  assert.equal(
    initial.configuration_hashes['.codex/config.toml'],
    hash(readFileSync(join(work.root, '.codex/config.toml'))),
  );
  writeFileSync(join(work.root, 'src/source.bin'), Buffer.from([1, 2, 3]));
  updateRecord(work.root, work.check.meta.id, { data: { expected_exit_code: 1 } });
  rmSync(join(work.root, 'src/source.bin'));
  const recovered = validateEvidenceInputs(work.root, reference, work.expected);
  assert.deepEqual(
    readFileSync(join(work.root, recovered.files['src/source.bin'].blob_path)),
    work.bytes,
  );
  assert.equal(recovered.records[work.check.meta.id].fingerprint, work.expected.check_fingerprint);
  assert.ok(evidenceInputArtifactPaths(work.root, reference).includes(reference.manifest_path));
  assert.throws(
    () =>
      validateEvidenceInputs(work.root, reference, {
        ...work.expected,
        files: { 'src/source.bin': hash('different version') },
      }),
    /differ from the evidence baseline/,
  );
});
test('tampered immutable blobs and manifests fail validation and are never silently rewritten', (t) => {
  const work = fixture(t);
  const reference = captureEvidenceInputs(work.root, {
    files: work.files,
    records: [work.requirement, work.check],
  });
  const captured = validateEvidenceInputs(work.root, reference, work.expected);
  const blob = captured.files['src/source.bin'].blob_path;
  writeFileSync(join(work.root, blob), Buffer.from([1, 2]));
  assert.throws(
    () => validateEvidenceInputs(work.root, reference, work.expected),
    /missing or modified/,
  );
  assert.throws(
    () =>
      captureEvidenceInputs(work.root, {
        files: work.files,
        records: [work.requirement, work.check],
      }),
    /Immutable evidence input blob was modified/,
  );
  assert.deepEqual(readFileSync(join(work.root, blob)), Buffer.from([1, 2]));
  writeFileSync(join(work.root, blob), work.bytes);
  writeFileSync(join(work.root, reference.manifest_path), '{}\n');
  assert.throws(
    () => validateEvidenceInputs(work.root, reference, work.expected),
    /manifest hash changed/,
  );
});
test('legacy recovery finds exact source and record versions without changing evidence metadata', (t) => {
  const work = fixture(t);
  const candidate = join(work.root, 'verified-baseline');
  for (const path of [
    '.verythinker/config.json',
    work.requirement.path,
    work.check.path,
    'src/source.bin',
  ]) {
    mkdirSync(dirname(join(candidate, path)), { recursive: true });
    writeFileSync(join(candidate, path), readFileSync(join(work.root, path)));
  }
  const evidenceBytes = readFileSync(join(work.root, work.evidence.path));
  writeFileSync(join(work.root, 'src/source.bin'), Buffer.from([9, 8]));
  updateRecord(work.root, work.check.meta.id, { data: { expected_exit_code: 2 } });
  const reference = recoverLegacyEvidenceInputs(work.root, work.evidence, [candidate]);
  const manifest = validateEvidenceInputs(work.root, reference, work.expected);
  assert.equal(manifest.provenance, 'legacy-recovered');
  assert.deepEqual(
    readFileSync(join(work.root, manifest.files['src/source.bin'].blob_path)),
    work.bytes,
  );
  assert.deepEqual(readFileSync(join(work.root, work.evidence.path)), evidenceBytes);
});
test('legacy input gaps report the exact missing source digest', (t) => {
  const work = fixture(t);
  writeFileSync(join(work.root, 'src/source.bin'), Buffer.from([9, 8]));
  assert.throws(
    () => recoverLegacyEvidenceInputs(work.root, work.evidence, []),
    (error) =>
      error.message.includes(work.evidence.meta.id) &&
      error.message.includes('src/source.bin') &&
      error.message.includes(work.files['src/source.bin']),
  );
});
test('capture excludes recursive, raw-session, and private runtime source baselines', (t) => {
  const work = fixture(t);
  const path = '.verythinker/cache/native/private-key.pem';
  mkdirSync(dirname(join(work.root, path)), { recursive: true });
  writeFileSync(join(work.root, path), 'private validation placeholder');
  assert.throws(
    () =>
      captureEvidenceInputs(work.root, {
        files: { [path]: hash(readFileSync(join(work.root, path))) },
        records: [],
      }),
    /excludes private runtime/,
  );
  assert.equal(existsSync(join(work.root, '.verythinker/evidence/inputs/blobs')), false);
});
