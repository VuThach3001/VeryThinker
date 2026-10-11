import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parse } from 'yaml';
import {
  atomicWrite,
  filesUnder,
  getRecord,
  hash,
  now,
  readConfig,
  safePath,
  validateMetadata,
  withOperationLock,
} from './storage.js';
import type { ProjectRecord } from './types.js';

const store = '.verythinker/evidence/inputs';
const digest = /^[a-f0-9]{64}$/;
const maxFileBytes = 32 * 1024 * 1024;
const maxSnapshotBytes = 128 * 1024 * 1024;
const maxArtifacts = 4096;
export interface EvidenceInputSnapshot {
  schema_version: 1;
  manifest_path: string;
  manifest_hash: string;
}
interface Artifact {
  hash: string;
  blob_path: string;
  bytes: number;
}
interface RecordArtifact extends Artifact {
  path: string;
  fingerprint: string;
  revision: number;
}
export interface EvidenceInputManifest {
  schema_version: 1;
  project_id: string;
  captured_at: string;
  provenance: 'captured-before-execution' | 'legacy-recovered';
  files: Record<string, Artifact>;
  records: Record<string, RecordArtifact>;
  context_files: Record<string, Artifact>;
  absent_context: string[];
  configuration_hashes: Record<string, string>;
}
export interface EvidenceInputExpectations {
  files: Record<string, string>;
  record_fingerprints: Record<string, string>;
  check_id?: string;
  check_fingerprint?: string;
}
function canonical(path: string): string {
  if (
    !path ||
    path.includes('\\') ||
    path.startsWith('/') ||
    /^[a-z]:/i.test(path) ||
    path.split('/').some((part) => !part || part === '.' || part === '..')
  )
    throw new Error(`Evidence input requires a canonical project-relative path: ${path}`);
  return path;
}
function bytesAt(root: string, path: string): Buffer {
  canonical(path);
  const target = safePath(root, path);
  let cursor = target;
  while (cursor !== resolve(root)) {
    if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink())
      throw new Error(`Evidence input is a symbolic link: ${path}`);
    cursor = dirname(cursor);
  }
  if (!existsSync(target) || !lstatSync(target).isFile())
    throw new Error(`Evidence input file is missing: ${path}`);
  if (lstatSync(target).size > maxFileBytes)
    throw new Error(`Evidence input exceeds the 32 MiB per-file limit: ${path}`);
  return readFileSync(target);
}
function excludeEphemeral(path: string): void {
  if (
    /^\.verythinker\/(?:cache|runs|raw|sessions|tools|operations|archives|capabilities|contributions|evidence\/inputs)\//.test(
      path,
    ) ||
    /(?:^|\/)\.git(?:\/|$)/.test(path) ||
    /(?:^|\/)private-key\.pem$/.test(path)
  )
    throw new Error(
      `Evidence capture excludes private runtime, recursive input storage, or raw sessions: ${path}`,
    );
}
/** Shared semantic identity; metadata status/revision changes do not rewrite input semantics. */
export function evidenceRecordFingerprint(record: ProjectRecord): string {
  const { submission, requested_model, confirmed_model, attempts, ...data } = record.meta.data;
  return hash(
    JSON.stringify({
      type: record.meta.type,
      title: record.meta.title,
      owner: record.meta.owner,
      links: record.meta.links,
      data,
      body: record.body,
    }),
  );
}
function recordFromBytes(bytes: Buffer, path: string): ProjectRecord {
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)([\s\S]*)$/.exec(
    bytes.toString('utf8').replace(/\r\n/g, '\n'),
  );
  if (!match) throw new Error(`Captured engineering record has no YAML metadata: ${path}`);
  return { meta: validateMetadata(parse(match[1]!)), body: match[2]!, path };
}
function put(root: string, bytes: Buffer, budget: { bytes: number; count: number }): Artifact {
  if (bytes.length > maxFileBytes)
    throw new Error('Evidence input exceeds the 32 MiB per-file limit.');
  budget.bytes += bytes.length;
  budget.count++;
  if (budget.bytes > maxSnapshotBytes || budget.count > maxArtifacts)
    throw new Error('Evidence input snapshot exceeds the 4096-artifact or 128 MiB limit.');
  const checksum = hash(bytes);
  const path = `${store}/blobs/${checksum}`;
  const target = safePath(root, path);
  let cursor = dirname(target);
  while (cursor !== resolve(root)) {
    if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink())
      throw new Error(`Evidence input storage is a symbolic link: ${path}`);
    cursor = dirname(cursor);
  }
  if (existsSync(target)) {
    if (hash(bytesAt(root, path)) !== checksum)
      throw new Error(`Immutable evidence input blob was modified: ${path}`);
  } else atomicWrite(target, bytes);
  return { hash: checksum, blob_path: path, bytes: bytes.length };
}
function writeManifest(root: string, value: EvidenceInputManifest): EvidenceInputSnapshot {
  const artifacts = [
    ...Object.values(value.files),
    ...Object.values(value.records),
    ...Object.values(value.context_files),
  ];
  if (
    artifacts.length > maxArtifacts ||
    artifacts.reduce((sum, item) => sum + item.bytes, 0) > maxSnapshotBytes
  )
    throw new Error('Evidence input snapshot exceeds the 4096-artifact or 128 MiB limit.');
  const bytes = Buffer.from(JSON.stringify(value, null, 2) + '\n');
  const checksum = hash(bytes);
  const path = `${store}/manifests/${checksum}.json`;
  let parent = dirname(safePath(root, path));
  while (parent !== resolve(root)) {
    if (existsSync(parent) && lstatSync(parent).isSymbolicLink())
      throw new Error(`Evidence input manifest storage is a symbolic link: ${path}`);
    parent = dirname(parent);
  }
  if (existsSync(safePath(root, path))) {
    if (hash(bytesAt(root, path)) !== checksum)
      throw new Error(`Immutable evidence input manifest was modified: ${path}`);
  } else atomicWrite(safePath(root, path), bytes);
  return { schema_version: 1, manifest_path: path, manifest_hash: checksum };
}
function expectedHash(checksum: unknown): asserts checksum is string {
  if (typeof checksum !== 'string' || !digest.test(checksum))
    throw new Error('Evidence input hash must be a SHA-256 digest.');
}
function configurationInputs(
  root: string,
  invocationId?: string | null,
  extras: string[] = [],
): {
  paths: string[];
  absent: string[];
} {
  const defaults = [
    '.verythinker/config.json',
    '.verythinker/routing.json',
    '.verythinker/tools.json',
    '.verythinker/pack-lock.json',
    '.verythinker/tool-lock.json',
    '.verythinker/recipe-lock.json',
    '.verythinker/native-runtime.lock.json',
  ];
  const paths = new Set(defaults.filter((path) => existsSync(safePath(root, path))));
  const absent = defaults.filter((path) => !existsSync(safePath(root, path)));
  for (const path of extras) {
    canonical(path);
    for (const file of lstatSync(safePath(root, path)).isDirectory()
      ? filesUnder(root, path)
      : [path])
      paths.add(file.replaceAll('\\', '/'));
  }
  const packs = safePath(root, '.verythinker/pack-lock.json');
  if (existsSync(packs))
    for (const pack of JSON.parse(readFileSync(packs, 'utf8')).packs ?? []) {
      if (typeof pack.path !== 'string')
        throw new Error('Evidence pack lock has no portable source path.');
      const contents = filesUnder(root, canonical(pack.path)).map((path) =>
        path.replaceAll('\\', '/'),
      );
      const fingerprint = hash(
        contents
          .map((path) => `${path.slice(pack.path.length + 1)}:${hash(bytesAt(root, path))}`)
          .join('\n'),
      );
      if (!contents.length || fingerprint !== pack.hash)
        throw new Error(`Evidence knowledge pack is missing or modified: ${pack.path}`);
      for (const file of contents) paths.add(file);
    }
  const tools = safePath(root, '.verythinker/tool-lock.json');
  if (existsSync(tools))
    for (const provider of JSON.parse(readFileSync(tools, 'utf8')).providers ?? []) {
      const path = canonical(provider.dependency_lock_path);
      expectedHash(provider.dependency_lock_hash);
      if (
        !path.startsWith('.verythinker/tool-locks/') ||
        hash(bytesAt(root, path)) !== provider.dependency_lock_hash
      )
        throw new Error(`Evidence tool dependency lock is missing or changed: ${path}`);
      paths.add(path);
    }
  if (invocationId) {
    if (!/^[a-f0-9-]{36}$/i.test(invocationId))
      throw new Error('Evidence execution invocation ID is invalid.');
    paths.add(`.verythinker/native/receipts/${invocationId}.json`);
    paths.add('.verythinker/native/trust.json');
    for (const path of filesUnder(root, '.verythinker/native/keys'))
      paths.add(path.replaceAll('\\', '/'));
  }
  for (const path of paths) excludeEphemeral(path);
  return { paths: [...paths].sort(), absent };
}
export function captureEvidenceInputs(
  root: string,
  input: {
    files: Record<string, string>;
    records: ProjectRecord[];
    record_fingerprints?: Record<string, string>;
    invocation_id?: string | null;
    additional_files?: string[];
  },
): EvidenceInputSnapshot {
  return withOperationLock(root, 'evidence-input-capture', () => {
    const budget = { bytes: 0, count: 0 };
    if (Object.keys(input.files).length + input.records.length > maxArtifacts)
      throw new Error('Evidence input snapshot exceeds the 4096-artifact limit.');
    const manifest: EvidenceInputManifest = {
      schema_version: 1,
      project_id: readConfig(root).project_id,
      captured_at: now(),
      provenance: 'captured-before-execution',
      files: {},
      records: {},
      context_files: {},
      absent_context: [],
      configuration_hashes: {},
    };
    for (const [path, checksum] of Object.entries(input.files)) {
      excludeEphemeral(path);
      expectedHash(checksum);
      const bytes = bytesAt(root, path);
      if (hash(bytes) !== checksum)
        throw new Error(`Evidence input changed before capture: ${path}`);
      manifest.files[canonical(path)] = put(root, bytes, budget);
    }
    for (const record of input.records) {
      if (manifest.records[record.meta.id])
        throw new Error(`Duplicate evidence input record: ${record.meta.id}`);
      const bytes = bytesAt(root, record.path);
      const captured = recordFromBytes(bytes, record.path);
      const fingerprint = evidenceRecordFingerprint(captured);
      if (
        captured.meta.id !== record.meta.id ||
        fingerprint !== evidenceRecordFingerprint(record) ||
        (input.record_fingerprints?.[record.meta.id] &&
          fingerprint !== input.record_fingerprints[record.meta.id])
      )
        throw new Error(`Engineering record changed before evidence capture: ${record.meta.id}`);
      manifest.records[record.meta.id] = {
        ...put(root, bytes, budget),
        path: record.path,
        fingerprint,
        revision: captured.meta.revision,
      };
    }
    for (const id of Object.keys(input.record_fingerprints ?? {}))
      if (!manifest.records[id])
        throw new Error(`Evidence capture omits required engineering record: ${id}`);
    const context = configurationInputs(root, input.invocation_id, input.additional_files);
    manifest.absent_context = context.absent;
    for (const path of context.paths)
      manifest.context_files[path] = put(root, bytesAt(root, path), budget);
    const nativeConfig = '.codex/config.toml';
    manifest.configuration_hashes[nativeConfig] = existsSync(safePath(root, nativeConfig))
      ? hash(bytesAt(root, nativeConfig))
      : 'absent';
    return writeManifest(root, manifest);
  });
}
export function validateEvidenceInputs(
  root: string,
  reference: EvidenceInputSnapshot,
  expected?: EvidenceInputExpectations,
): EvidenceInputManifest {
  if (!reference || reference.schema_version !== 1)
    throw new Error('Evidence input snapshot is missing or invalid.');
  expectedHash(reference.manifest_hash);
  if (reference.manifest_path !== `${store}/manifests/${reference.manifest_hash}.json`)
    throw new Error('Evidence input manifest path differs from its content identity.');
  const bytes = bytesAt(root, reference.manifest_path);
  if (hash(bytes) !== reference.manifest_hash)
    throw new Error('Immutable evidence input manifest hash changed.');
  const value = JSON.parse(bytes.toString('utf8')) as EvidenceInputManifest;
  if (
    value.schema_version !== 1 ||
    value.project_id !== readConfig(root).project_id ||
    !value.files ||
    !value.records ||
    !value.context_files ||
    !Array.isArray(value.absent_context) ||
    !value.configuration_hashes
  )
    throw new Error('Evidence input snapshot identity or collections are invalid.');
  const artifacts = [
    ...Object.entries(value.files),
    ...Object.entries(value.context_files),
    ...Object.entries(value.records),
  ];
  if (
    artifacts.length > maxArtifacts ||
    artifacts.reduce((sum, [, item]) => sum + item.bytes, 0) > maxSnapshotBytes
  )
    throw new Error('Evidence input snapshot exceeds its bounded limits.');
  for (const [path, item] of artifacts) {
    expectedHash(item.hash);
    if (
      item.blob_path !== `${store}/blobs/${item.hash}` ||
      !Number.isSafeInteger(item.bytes) ||
      item.bytes < 0
    )
      throw new Error(`Evidence input artifact identity is invalid: ${path}`);
    const content = bytesAt(root, item.blob_path);
    if (hash(content) !== item.hash || content.length !== item.bytes)
      throw new Error(
        `Immutable evidence input artifact is missing or modified: ${path} (${item.hash})`,
      );
  }
  for (const path of [
    ...Object.keys(value.files),
    ...Object.keys(value.context_files),
    ...value.absent_context,
  ])
    canonical(path);
  for (const [path, checksum] of Object.entries(value.configuration_hashes)) {
    canonical(path);
    if (checksum !== 'absent') expectedHash(checksum);
  }
  for (const [id, item] of Object.entries(value.records)) {
    const record = recordFromBytes(bytesAt(root, item.blob_path), canonical(item.path));
    if (
      record.meta.id !== id ||
      record.meta.revision !== item.revision ||
      evidenceRecordFingerprint(record) !== item.fingerprint
    )
      throw new Error(`Captured engineering record identity differs: ${id}`);
  }
  if (expected) {
    if (
      JSON.stringify(
        Object.fromEntries(
          Object.entries(value.files)
            .map(([path, item]) => [path, item.hash])
            .sort(),
        ),
      ) !== JSON.stringify(Object.fromEntries(Object.entries(expected.files).sort()))
    )
      throw new Error('Captured implementation inputs differ from the evidence baseline.');
    for (const [id, fingerprint] of Object.entries(expected.record_fingerprints))
      if (value.records[id]?.fingerprint !== fingerprint)
        throw new Error(`Captured record differs from the evidence baseline: ${id}`);
    if (
      expected.check_id &&
      value.records[expected.check_id]?.fingerprint !== expected.check_fingerprint
    )
      throw new Error(`Captured check differs from its recorded oracle: ${expected.check_id}`);
  }
  return value;
}
export function evidenceInputArtifactPaths(
  root: string,
  reference: EvidenceInputSnapshot,
  expected?: EvidenceInputExpectations,
): string[] {
  const value = validateEvidenceInputs(root, reference, expected);
  return [
    ...new Set([
      reference.manifest_path,
      ...[
        ...Object.values(value.files),
        ...Object.values(value.records),
        ...Object.values(value.context_files),
      ].map((item) => item.blob_path),
    ]),
  ];
}
/** Recover immutable versions without rewriting the historical evidence record. */
export function recoverLegacyEvidenceInputs(
  root: string,
  evidence: ProjectRecord,
  candidates: string[],
): EvidenceInputSnapshot {
  return withOperationLock(root, 'evidence-input-recovery', () => {
    const budget = { bytes: 0, count: 0 };
    const data = evidence.meta.data;
    const files = data.file_baseline as Record<string, string>;
    const expectedRecords = { ...(data.record_baseline as Record<string, string>) };
    if (typeof data.check_id === 'string' && typeof data.check_fingerprint === 'string')
      expectedRecords[data.check_id] = data.check_fingerprint;
    if (!files || typeof files !== 'object' || !data.record_baseline)
      throw new Error(`Historical evidence ${evidence.meta.id} has no recoverable input baseline.`);
    const manifest: EvidenceInputManifest = {
      schema_version: 1,
      project_id: readConfig(root).project_id,
      captured_at: now(),
      provenance: 'legacy-recovered',
      files: {},
      records: {},
      context_files: {},
      absent_context: [],
      configuration_hashes: {},
    };
    const roots = [...new Set([root, ...candidates])];
    const recoverFile = (path: string, checksum: string): Artifact => {
      expectedHash(checksum);
      for (const source of roots) {
        if (!existsSync(safePath(source, path))) continue;
        const bytes = bytesAt(source, path);
        if (hash(bytes) === checksum) return put(root, bytes, budget);
      }
      const cached = `${store}/blobs/${checksum}`;
      if (existsSync(safePath(root, cached)) && hash(bytesAt(root, cached)) === checksum)
        return put(root, bytesAt(root, cached), budget);
      throw new Error(
        `Historical evidence ${evidence.meta.id} is missing original input ${path} with SHA-256 ${checksum}; recover a verified baseline before export.`,
      );
    };
    for (const [path, checksum] of Object.entries(files))
      manifest.files[canonical(path)] = recoverFile(path, checksum);
    for (const [id, fingerprint] of Object.entries(expectedRecords)) {
      expectedHash(fingerprint);
      let found = false;
      for (const source of roots) {
        let record: ProjectRecord;
        try {
          record = getRecord(source, id);
        } catch {
          continue;
        }
        if (evidenceRecordFingerprint(record) !== fingerprint) continue;
        const bytes = bytesAt(source, record.path);
        manifest.records[id] = {
          ...put(root, bytes, budget),
          path: record.path,
          fingerprint,
          revision: record.meta.revision,
        };
        found = true;
        break;
      }
      if (!found)
        for (const source of roots) {
          for (const path of filesUnder(source, `${store}/manifests`)) {
            const portable = path.replaceAll('\\', '/');
            const checksum = portable
              .split('/')
              .at(-1)
              ?.replace(/\.json$/, '');
            if (!checksum || !digest.test(checksum)) continue;
            const version = validateEvidenceInputs(source, {
              schema_version: 1,
              manifest_path: portable,
              manifest_hash: checksum,
            }).records[id];
            if (version?.fingerprint !== fingerprint) continue;
            const bytes = bytesAt(source, version.blob_path);
            manifest.records[id] = {
              ...put(root, bytes, budget),
              path: version.path,
              fingerprint,
              revision: version.revision,
            };
            found = true;
            break;
          }
          if (found) break;
        }
      if (!found)
        throw new Error(
          `Historical evidence ${evidence.meta.id} is missing original engineering record ${id} with fingerprint ${fingerprint}; recover a verified baseline before export.`,
        );
    }
    for (const [field, path] of [
      ['pack_lock_hash', '.verythinker/pack-lock.json'],
      ['tool_lock_hash', '.verythinker/tool-lock.json'],
    ])
      if (typeof data[field!] === 'string')
        manifest.context_files[path!] = recoverFile(path!, data[field!] as string);
    const packLock = manifest.context_files['.verythinker/pack-lock.json'];
    if (packLock)
      for (const pack of JSON.parse(bytesAt(root, packLock.blob_path).toString('utf8')).packs ??
        []) {
        let found = false;
        for (const source of roots) {
          const paths = filesUnder(source, canonical(pack.path)).map((path) =>
            path.replaceAll('\\', '/'),
          );
          if (
            !paths.length ||
            hash(
              paths
                .map((path) => `${path.slice(pack.path.length + 1)}:${hash(bytesAt(source, path))}`)
                .join('\n'),
            ) !== pack.hash
          )
            continue;
          for (const path of paths)
            manifest.context_files[path] = put(root, bytesAt(source, path), budget);
          found = true;
          break;
        }
        if (!found)
          throw new Error(
            `Historical evidence ${evidence.meta.id} is missing original knowledge pack ${pack.path} with fingerprint ${pack.hash}.`,
          );
      }
    const toolLock = manifest.context_files['.verythinker/tool-lock.json'];
    if (toolLock)
      for (const provider of JSON.parse(bytesAt(root, toolLock.blob_path).toString('utf8'))
        .providers ?? []) {
        if (
          typeof provider.dependency_lock_path === 'string' &&
          typeof provider.dependency_lock_hash === 'string'
        )
          manifest.context_files[canonical(provider.dependency_lock_path)] = recoverFile(
            provider.dependency_lock_path,
            provider.dependency_lock_hash,
          );
        else
          throw new Error(
            `Historical evidence ${evidence.meta.id} has no pinned transitive dependency identity for ${provider.id}.`,
          );
      }
    const reference = writeManifest(root, manifest);
    validateEvidenceInputs(root, reference, {
      files,
      record_fingerprints: expectedRecords,
      check_id: String(data.check_id),
      check_fingerprint: String(data.check_fingerprint),
    });
    return reference;
  });
}
