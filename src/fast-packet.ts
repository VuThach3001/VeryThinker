import { existsSync, readFileSync } from 'node:fs';
import { validateFastSelection, type FastSelection } from './fast-policy.js';
import { executionScope, recordFingerprint } from './engineering.js';
import { hash, loadRecords, safePath } from './storage.js';
import type { ProjectRecord } from './types.js';

const maxPacketBytes = 56 * 1024;
const maxTextBytes = 16 * 1024;
const runLog =
  /^\.verythinker\/runs\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/output\.log$/;
type BoundedText = { text?: string; hash: string; omitted?: 'over-16k' | 'packet-limit' };
function text(bytes: Buffer): BoundedText {
  const digest = hash(bytes);
  return bytes.byteLength <= maxTextBytes
    ? { text: bytes.toString('utf8'), hash: digest }
    : { hash: digest, omitted: 'over-16k' };
}
export function reviewPacket(
  root: string,
  taskId: string,
  selection: FastSelection,
): Record<string, unknown> {
  validateFastSelection(root, selection);
  const records = loadRecords(root);
  const task = records.find((record) => record.meta.id === taskId && record.meta.type === 'task');
  if (!task || task.meta.data.workflow_id !== selection.workflow_id)
    throw new Error('Fast review packet task does not match its selected workflow.');
  const scope = new Set(executionScope(records, task));
  const checks = records.filter(
    (record) =>
      record.meta.type === 'check' &&
      record.meta.status !== 'superseded' &&
      record.meta.links.some((link) => link.type === 'verifies' && scope.has(link.target)),
  );
  const checkIds = new Set(checks.map((record) => record.meta.id));
  const evidence = records.filter(
    (record) =>
      record.meta.type === 'evidence' &&
      record.meta.data.task_id === taskId &&
      record.meta.links.some((link) => link.type === 'evidence-for' && checkIds.has(link.target)),
  );
  const submission = task.meta.data.submission as { work_record_id?: string } | undefined;
  const work = records.find(
    (record) =>
      record.meta.id === submission?.work_record_id &&
      record.meta.type === 'knowledge' &&
      record.meta.data.kind === 'work-record',
  );
  const included = records
    .filter(
      (record) =>
        scope.has(record.meta.id) && ['requirement', 'design', 'task'].includes(record.meta.type),
    )
    .concat(checks, evidence, ...(work ? [work] : []));
  const selectedRecords = [...new Map(included.map((record) => [record.meta.id, record])).values()];
  const packet: any = {
    context_notice:
      'Supplied core context supports review only; it is not acceptance proof. Current gates remain authoritative.',
    task_id: taskId,
    records: selectedRecords.map((record) => {
      const metadata = Buffer.from(JSON.stringify(record.meta));
      const bounded =
        metadata.byteLength <= maxTextBytes
          ? { metadata: record.meta }
          : { metadata_hash: hash(metadata), metadata_omitted: 'over-16k' };
      return {
        id: record.meta.id,
        type: record.meta.type,
        ...bounded,
        body: text(Buffer.from(record.body)),
        fingerprint: recordFingerprint(record),
      };
    }),
    files: [] as Array<Record<string, unknown>>,
    logs: [] as Array<Record<string, unknown>>,
    log_gaps: [] as string[],
    fetch_needed: false,
  };
  const selectedPaths = [
    ...new Set([...selection.editable_paths, ...Object.keys(selection.protected_inputs)]),
  ].sort();
  for (const path of selectedPaths) {
    const bytes = readFileSync(safePath(root, path));
    const expected = selection.protected_inputs[path];
    if (expected !== undefined && hash(bytes) !== expected)
      throw new Error(`Protected fast input changed: ${path}`);
    packet.files.push({ path, protected: expected !== undefined, ...text(bytes) });
  }
  for (const item of evidence) {
    const path = item.meta.data.log_path;
    const expected = item.meta.data.log_hash;
    if (typeof path !== 'string' || !runLog.test(path) || typeof expected !== 'string') { packet.log_gaps.push(item.meta.id); continue; }
    const absolute = safePath(root, path);
    if (!existsSync(absolute)) { packet.log_gaps.push(item.meta.id); continue; }
    const bytes = readFileSync(absolute);
    if (hash(bytes) !== expected) { packet.log_gaps.push(item.meta.id); continue; }
    packet.logs.push({ evidence_id: item.meta.id, path, ...text(bytes) });
  }
  packet.fetch_needed =
    packet.log_gaps.length > 0 || packet.records.some((entry: any) => entry.metadata_omitted || entry.body.omitted) ||
    packet.files.some((entry: any) => entry.omitted) ||
    packet.logs.some((entry: any) => entry.omitted);
  if (Buffer.byteLength(JSON.stringify(packet), 'utf8') > maxPacketBytes) {
    for (const collection of [packet.records, packet.files, packet.logs])
      for (const entry of collection)
        if (entry.text !== undefined) {
          delete entry.text;
          entry.omitted = 'packet-limit';
        }
    packet.fetch_needed = true;
  }
  if (Buffer.byteLength(JSON.stringify(packet), 'utf8') > maxPacketBytes) {
    for (const record of packet.records) {
      delete record.body.text;
      record.body.omitted = 'packet-limit';
    }
    packet.fetch_needed = true;
  }
  if (Buffer.byteLength(JSON.stringify(packet), 'utf8') > maxPacketBytes) {
    const omitted = { records: packet.records, files: packet.files, logs: packet.logs };
    packet.omitted = {
      sha256: hash(JSON.stringify(omitted)),
      records: packet.records.length,
      files: packet.files.length,
      logs: packet.logs.length,
    };
    packet.records = [];
    packet.files = [];
    packet.logs = [];
    packet.fetch_needed = true;
  }
  return packet;
}
