import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { parse } from 'yaml';
import { recordFingerprint, strictRecord, strings, verify } from './engineering.js';
import { assertRouting, invocationIsActive, readInvocation, readRoutingPolicy } from './routing.js';
import {
  atomicWrite,
  getRecord,
  hash,
  loadRecords,
  now,
  readConfig,
  safePath,
  updateRecord,
  validateMetadata,
  withOperationLock,
} from './storage.js';
import type { ProjectRecord } from './types.js';

const digest = /^[a-f0-9]{64}$/;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const maxBytes = 128 * 1024;
const binaryControl = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;
export interface WorkspaceWriteInput {
  task_id: string;
  workflow_id: string;
  invocation_id: string;
  path: string;
  content: string;
  expected_hash: string | null;
  /** Reuse the same UUID and payload after an interrupted or lost response. */
  operation_id?: string;
}
export interface WorkspaceWriteResult {
  operation_id: string;
  path: string;
  previous_hash: string | null;
  sha256: string;
  history_paths: string[];
  task_revision: number;
  replayed: boolean;
}
export interface WorkspaceReplaceInput extends Omit<WorkspaceWriteInput, 'content' | 'expected_hash'> {
  /** Replacement is permitted only against existing bytes observed at expected_hash. */
  expected_hash: string;
  replacement: { before: string; after: string };
}
interface WriteIntent {
  schema_version: 1;
  operation_id: string;
  project_id: string;
  task_id: string;
  workflow_id: string;
  invocation_id: string;
  path: string;
  previous_hash: string | null;
  sha256: string;
  request_hash: string;
  created_at: string;
  task_revision: number;
  task_record_hash: string;
  task_fingerprint: string;
  mode: number;
}
interface WriteEntry {
  operation_id: string;
  path: string;
  previous_hash: string | null;
  sha256: string;
  request_hash: string;
  invocation_id: string;
  intent_path: string;
  intent_hash: string;
  history_hashes: Record<string, string>;
  completion_path?: string;
  completion_hash?: string;
  recovery_path?: string;
  recovery_hash?: string;
  recovery_invocation_id?: string;
  handoff?: { invocation_id: string; record_path: string; record_hash: string; manifest_path: string; manifest_hash: string };
}
function canonical(path: string): string {
  if (
    typeof path !== 'string' || !path || path.includes('\\') || path.includes(':') ||
    /[\x00-\x1f]/.test(path) || path.startsWith('/') ||
    path.split('/').some((part) => !part || part === '.' || part === '..' || /[. ]$/.test(part))
  ) throw new Error('File writes require a canonical project-relative path.');
  return path;
}
function fold(path: string): string { return path.toLowerCase(); }
function covers(reference: string, path: string): boolean {
  reference = fold(reference.replaceAll('\\', '/').replace(/\/$/, ''));
  path = fold(path);
  return reference === '.' || path === reference || path.startsWith(`${reference}/`);
}
function ordinaryPath(path: string): void {
  canonical(path);
  const lower = fold(path);
  if (
    lower.split('/').some((part) =>
      ['.git', '.verythinker', '.codex', '.claude', '.github', '.vscode', '.agents', '.cursor', '.gemini', 'node_modules'].includes(part) ||
      /^(?:\.env(?:\..*)?|credentials?|secrets?|id_rsa|id_ed25519)$/.test(part) ||
      /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/.test(part)) ||
    /(?:^|\/)(?:agents(?:\.override)?\.md|claude\.md|gemini\.md|skill\.md|copilot-instructions\.md|\.cursorrules|[^/]+\.(?:agent|instructions)\.md)$/.test(lower) ||
    /\.(?:pem|key|pfx|p12)$/.test(lower)
  ) throw new Error('File writes cannot change managed storage, agent instructions/configuration, tools, or credentials.');
}
function physical(root: string, path: string): string {
  const target = safePath(root, path);
  let cursor = target;
  while (cursor !== resolve(root)) {
    if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink())
      throw new Error(`File writes cannot follow symbolic links: ${path}`);
    if (existsSync(cursor) && fold(relative(resolve(root), cursor).replaceAll('\\', '/')) !==
        fold(relative(realpathSync(root), realpathSync(cursor)).replaceAll('\\', '/')))
      throw new Error(`File writes cannot use filesystem aliases: ${path}`);
    cursor = dirname(cursor);
  }
  return target;
}
function fileBytes(root: string, path: string): Buffer | null {
  const target = physical(root, path);
  if (!existsSync(target)) return null;
  const stat = lstatSync(target);
  if (!stat.isFile() || stat.size > maxBytes || stat.nlink > 1)
    throw new Error('File writes support only ordinary, unlinked UTF-8 files up to 128 KiB.');
  const bytes = readFileSync(target);
  if (binaryControl.test(bytes.toString('utf8')) || !Buffer.from(bytes.toString('utf8'), 'utf8').equals(bytes))
    throw new Error('File writes cannot replace binary or invalid UTF-8 content.');
  return bytes;
}
function expected(root: string, path: string, checksum: string | null): Buffer | null {
  const bytes = fileBytes(root, path);
  if ((bytes === null ? null : hash(bytes)) !== checksum)
    throw new Error(`File changed since it was read; preserve current edits and inspect a fresh hash: ${path}`);
  return bytes;
}
function protectedPath(root: string, path: string): void {
  for (const record of loadRecords(root)) {
    const data = record.meta.data;
    const protectedPaths = ['protected_paths', 'protected_acceptance_paths', 'oracle_paths', 'acceptance_paths', 'verification_artifact_paths']
      .flatMap((field) => strings(data[field]));
    for (const field of ['protected_files', 'protected_file_hashes'])
      if (data[field] && typeof data[field] === 'object') protectedPaths.push(...Object.keys(data[field] as object));
    if (protectedPaths.some((reference) => covers(reference, path)))
      throw new Error('File write would change a protected verification/recipe artifact.');
    if (data.format === 'cornell-v1') {
      const practice = data.practice as Record<string, unknown> | undefined;
      const owned = [data.artifact_path, ...Object.keys((data.artifact_hashes as object) ?? {}),
        practice?.exercise_path, practice?.answer_path, practice?.solution_path];
      if (owned.some((reference) => typeof reference === 'string' && covers(reference, path)))
        throw new Error('Cornell-owned files require the scoped note revision operation; user solutions stay preserved.');
    }
  }
}
function taskFor(root: string, input: WorkspaceWriteInput, pendingOperationId?: string): ProjectRecord {
  readConfig(root);
  if (!readRoutingPolicy(root)) throw new Error('Scoped file writes require an installed strict routing policy.');
  const task = getRecord(root, input.task_id);
  if (task.meta.type !== 'task' || task.meta.status !== 'in-progress' || !strictRecord(root, task))
    throw new Error('Scoped file writes require a strict, in-progress task.');
  if (task.meta.owner !== 'developer' || task.meta.data.invocation_id !== input.invocation_id ||
      task.meta.data.workflow_id !== input.workflow_id)
    throw new Error('Only the task current Developer producer may write its assigned files.');
  const workflow = getRecord(root, input.workflow_id);
  if (workflow.meta.data.kind !== 'manager-workflow' ||
      !strings(workflow.meta.data.task_ids).includes(task.meta.id))
    throw new Error('The task does not belong to the specified managed workflow.');
  const receipt = assertRouting(root, 'developer', input.invocation_id, {
    workflow_id: input.workflow_id, task_id: input.task_id, require_completed: false,
  });
  if (receipt?.state !== 'running') throw new Error('Scoped file writes require a currently running native Developer invocation.');
  if (!receipt.native_tool_scope.includes('task_file_write'))
    throw new Error('The native Developer receipt did not confirm the scoped task_file_write capability.');
  if (!strings(task.meta.data.allowed_paths).some((scope) => covers(scope, input.path)))
    throw new Error('File write is outside the task approved allowed_paths.');
  protectedPath(root, input.path);
  const gate = verify(root, task.meta.id, 'design-ready');
  const ownIncomplete = `File-write operation ${pendingOperationId} is incomplete; recover the same payload before verification.`;
  const findings = gate.findings.filter((finding) => !(pendingOperationId && finding.code === 'workspace-history' && finding.message === ownIncomplete));
  if (findings.length) throw new Error(`File write requires current reviewed design and verification plans: ${findings.map((finding) => finding.message).join(' ')}`);
  return task;
}
function immutable(root: string, path: string, bytes: Buffer): void {
  const target = physical(root, path);
  if (existsSync(target)) {
    if (!readFileSync(target).equals(bytes)) throw new Error(`Immutable file-write history changed: ${path}`);
  } else atomicWrite(target, bytes);
}
function historyBase(taskId: string, operationId: string): string {
  return `.verythinker/evidence/workspace-history/${taskId}/${operationId}`;
}
function entries(task: ProjectRecord): WriteEntry[] {
  const value = task.meta.data.workspace_writes;
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error('Task file-write history is malformed.');
  return value as WriteEntry[];
}
function capturedTask(bytes: Buffer, path: string): ProjectRecord {
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)([\s\S]*)$/.exec(bytes.toString('utf8').replaceAll('\r\n', '\n'));
  if (!match) throw new Error('Original file-write task snapshot has malformed metadata.');
  return { meta: validateMetadata(parse(match[1]!)), body: match[2]!, path };
}
function taskContract(task: ProjectRecord): string {
  const execution = new Set(['invocation_id', 'prior_invocation_ids', 'resumed_at', 'requested_model', 'confirmed_model']);
  return recordFingerprint({ ...task, meta: { ...task.meta,
    data: Object.fromEntries(Object.entries(task.meta.data).filter(([key]) => !execution.has(key))) } });
}
function resumeLineage(root: string, task: ProjectRecord, currentId: string, authorId: string): void {
  const seen = new Set<string>();
  let id: string | null = currentId;
  for (let depth = 0; depth < 32 && id; depth++) {
    if (seen.has(id)) throw new Error('Developer resume lineage contains a cycle.');
    seen.add(id);
    const receipt = readInvocation(root, id);
    if (receipt.execution_mode !== 'native' || receipt.role !== 'developer' ||
        receipt.task_id !== task.meta.id || receipt.workflow_id !== task.meta.data.workflow_id)
      throw new Error('File-write recovery needs signed Developer resume lineage for the same task and workflow.');
    if (id !== currentId && invocationIsActive(receipt))
      throw new Error('Prior file-write author must be settled before recovery.');
    if (id === authorId) return;
    id = receipt.prior_invocation_id;
  }
  throw new Error('File-write recovery does not reach the original author within its bounded resume lineage.');
}
/** The only incomplete-history readiness exceptions permitted during native task resume. */
export function workspaceResumeOperations(root: string, task: ProjectRecord, invocationId: string): string[] {
  const pending = entries(task).filter((entry) => !entry.completion_hash);
  if (!pending.length) return [];
  if (task.meta.type !== 'task' || !['in-progress', 'blocked'].includes(task.meta.status) || task.meta.owner !== 'developer' ||
      typeof task.meta.data.workflow_id !== 'string' || !strictRecord(root, task))
    throw new Error('Pending file-write recovery requires a strict, in-progress Developer task.');
  const current = assertRouting(root, 'developer', invocationId, {
    task_id: task.meta.id, workflow_id: task.meta.data.workflow_id, require_completed: false,
  });
  if (current?.state !== 'running' || !current.native_tool_scope.includes('task_file_write'))
    throw new Error('Recovery requires a running native Developer with the observed file-write capability.');
  const problems = workspaceHistoryProblems(root, task, pending.map((entry) => entry.operation_id));
  if (problems.length) throw new Error(problems.join('\n'));
  for (const entry of pending) {
    if (current.id !== entry.invocation_id) resumeLineage(root, task, current.id, entry.invocation_id);
    if (typeof task.meta.data.invocation_id !== 'string') throw new Error('The interrupted task producer is missing.');
    if (current.id !== task.meta.data.invocation_id) resumeLineage(root, task, current.id, task.meta.data.invocation_id);
    if (!strings(task.meta.data.allowed_paths).some((scope) => covers(scope, entry.path)))
      throw new Error('Pending file-write recovery is outside the current approved scope.');
    protectedPath(root, entry.path);
    const bytes = fileBytes(root, entry.path), checksum = bytes === null ? null : hash(bytes);
    if (checksum !== entry.previous_hash && checksum !== entry.sha256)
      throw new Error('Pending file-write recovery found unknown current bytes; preserve user edits.');
  }
  return pending.map((entry) => entry.operation_id);
}
/** Validates prior task-linked artifacts independently of mutable operation caches. */
export function workspaceHistoryProblems(root: string, task: ProjectRecord, pendingOperationId?: string | string[]): string[] {
  const problems: string[] = [];
  try {
    const seen = new Set<string>();
    for (const entry of entries(task)) {
      if (!uuid.test(entry.operation_id) || seen.has(entry.operation_id)) throw new Error('File-write history has an invalid or repeated operation ID.');
      seen.add(entry.operation_id);
      ordinaryPath(entry.path);
      const base = historyBase(task.meta.id, entry.operation_id);
      if (entry.intent_path !== `${base}/intent.json`) throw new Error('File-write history escapes its task namespace.');
      const intentBytes = readFileSync(physical(root, entry.intent_path));
      if (hash(intentBytes) !== entry.intent_hash) throw new Error('Immutable file-write intent was changed.');
      const intent = JSON.parse(intentBytes.toString('utf8')) as WriteIntent;
      if (intent.schema_version !== 1 || intent.task_id !== task.meta.id || intent.project_id !== readConfig(root).project_id ||
          intent.operation_id !== entry.operation_id || intent.path !== entry.path || intent.invocation_id !== entry.invocation_id ||
          intent.workflow_id !== task.meta.data.workflow_id || intent.request_hash !== entry.request_hash ||
          intent.previous_hash !== entry.previous_hash || intent.sha256 !== entry.sha256)
        throw new Error('File-write history differs from its task/author/content binding.');
      const required: Record<string, string> = {
        [`${base}/intent.json`]: entry.intent_hash,
        [`${base}/task.md`]: intent.task_record_hash,
        [`${base}/next.utf8`]: entry.sha256,
        ...(entry.previous_hash === null ? {} : { [`${base}/previous.utf8`]: entry.previous_hash }),
      };
      if (entry.handoff) {
        const handoff = entry.handoff;
        if (!uuid.test(handoff.invocation_id) || handoff.record_path !== `${base}/handoff-${handoff.invocation_id}.md` ||
            handoff.manifest_path !== `${base}/handoff-${handoff.invocation_id}.json`)
          throw new Error('File-write pre-link handoff escapes its original operation.');
        required[handoff.record_path] = handoff.record_hash;
        required[handoff.manifest_path] = handoff.manifest_hash;
        const oldTask = capturedTask(readFileSync(physical(root, `${base}/task.md`)), `${base}/task.md`);
        const nextTask = capturedTask(readFileSync(physical(root, handoff.record_path)), handoff.record_path);
        const manifest = JSON.parse(readFileSync(physical(root, handoff.manifest_path), 'utf8'));
        if (oldTask.meta.id !== task.meta.id || nextTask.meta.id !== task.meta.id ||
            oldTask.meta.data.invocation_id !== entry.invocation_id || nextTask.meta.data.invocation_id !== handoff.invocation_id ||
            taskContract(oldTask) !== taskContract(nextTask) || manifest.schema_version !== 1 ||
            manifest.kind !== 'scoped-file-write-prelink-handoff' || manifest.task_id !== task.meta.id ||
            manifest.original_invocation_id !== entry.invocation_id || manifest.recovery_invocation_id !== handoff.invocation_id ||
            manifest.original_record_hash !== intent.task_record_hash || manifest.handoff_record_hash !== handoff.record_hash ||
            manifest.contract_hash !== taskContract(oldTask) || manifest.request_hash !== entry.request_hash)
          throw new Error('File-write pre-link handoff changed the original task contract.');
        resumeLineage(root, task, handoff.invocation_id, entry.invocation_id);
      }
      if (entry.completion_path !== undefined || entry.completion_hash !== undefined) {
        if (entry.completion_path !== `${base}/completion.json` || !digest.test(entry.completion_hash ?? ''))
          throw new Error('File-write completion receipt binding is malformed.');
        required[entry.completion_path] = entry.completion_hash!;
        const completion = JSON.parse(readFileSync(physical(root, entry.completion_path), 'utf8'));
        if (completion.schema_version !== 1 || completion.kind !== 'completed-scoped-file-write' ||
            completion.operation_id !== entry.operation_id || completion.task_id !== task.meta.id ||
            completion.workflow_id !== intent.workflow_id || completion.invocation_id !== entry.invocation_id ||
            completion.path !== entry.path || completion.sha256 !== entry.sha256 ||
            completion.previous_hash !== entry.previous_hash || completion.request_hash !== entry.request_hash)
          throw new Error('File-write completion differs from its immutable intent.');
        if (completion.recovery_invocation_id !== null && completion.recovery_invocation_id !== undefined)
          resumeLineage(root, task, completion.recovery_invocation_id, entry.invocation_id);
        if (entry.recovery_path !== undefined || entry.recovery_hash !== undefined || entry.recovery_invocation_id !== undefined) {
          if (!uuid.test(entry.recovery_invocation_id ?? '') || !digest.test(entry.recovery_hash ?? '') ||
              entry.recovery_path !== `${base}/recovery-${entry.recovery_invocation_id}.json`)
            throw new Error('File-write recovery receipt binding is malformed.');
          required[entry.recovery_path] = entry.recovery_hash!;
          const recovery = JSON.parse(readFileSync(physical(root, entry.recovery_path), 'utf8'));
          if (recovery.schema_version !== 1 || recovery.kind !== 'scoped-file-write-recovery' ||
              recovery.operation_id !== entry.operation_id || recovery.task_id !== task.meta.id ||
              recovery.workflow_id !== intent.workflow_id || recovery.original_invocation_id !== entry.invocation_id ||
              recovery.recovery_invocation_id !== entry.recovery_invocation_id ||
              recovery.completion_hash !== entry.completion_hash || recovery.request_hash !== entry.request_hash)
            throw new Error('File-write recovery receipt differs from its original completion.');
          resumeLineage(root, task, entry.recovery_invocation_id!, entry.invocation_id);
        }
      } else if (!(Array.isArray(pendingOperationId) ? pendingOperationId : [pendingOperationId]).includes(entry.operation_id)) {
        problems.push(`File-write operation ${entry.operation_id} is incomplete; recover the same payload before verification.`);
      }
      if (JSON.stringify(entry.history_hashes) !== JSON.stringify(required)) throw new Error('File-write history membership differs from its immutable intent.');
      for (const [path, checksum] of Object.entries(required)) {
        if (!digest.test(checksum) || !strings(task.meta.data.output_paths).includes(path) ||
            hash(readFileSync(physical(root, path))) !== checksum)
          throw new Error(`Immutable file-write history is missing or changed: ${path}`);
      }
    }
  } catch (error) { problems.push(error instanceof Error ? error.message : String(error)); }
  return problems;
}

/**
 * Optimistic filesystem CAS: cooperative Core writes serialize, fresh bytes are
 * checked immediately before atomic replacement, and unknown bytes are never
 * rolled back. Node does not provide kernel CAS against noncooperating editors.
 * Durable history supports same-payload recovery, not a multi-file transaction.
 */
export function workspaceWrite(root: string, input: WorkspaceWriteInput): WorkspaceWriteResult {
  ordinaryPath(input.path);
  if (typeof input.content !== 'string' || binaryControl.test(input.content)) throw new Error('File content must be UTF-8 text.');
  const next = Buffer.from(input.content, 'utf8');
  if (next.length > maxBytes || next.toString('utf8') !== input.content) throw new Error('File content must be valid UTF-8 text up to 128 KiB.');
  if (input.expected_hash !== null && (typeof input.expected_hash !== 'string' || !digest.test(input.expected_hash)))
    throw new Error('expected_hash must be the current SHA-256, or null only for a new file.');
  const operationId = input.operation_id ?? randomUUID();
  if (!uuid.test(operationId)) throw new Error('File-write operation_id must be a lowercase UUID.');
  const requestIdentity = (authorId: string) => hash(JSON.stringify({ task_id: input.task_id, workflow_id: input.workflow_id,
    invocation_id: authorId, path: input.path, expected_hash: input.expected_hash, sha256: hash(next) }));
  return withOperationLock(root, `workspace-${hash(input.task_id).slice(0, 32)}`, () =>
    withOperationLock(root, `workspace-path-${hash(fold(input.path)).slice(0, 32)}`, () => {
      let task = taskFor(root, input, operationId);
      let requestHash = requestIdentity(input.invocation_id);
      const problems = workspaceHistoryProblems(root, task, operationId);
      if (problems.length) throw new Error(problems.join('\n'));
      const base = historyBase(task.meta.id, operationId), intentPath = `${base}/intent.json`;
      let entry = entries(task).find((item) => item.operation_id === operationId);
      let intent: WriteIntent;
      let replayed = false;
      if (existsSync(physical(root, intentPath))) {
        intent = JSON.parse(readFileSync(physical(root, intentPath), 'utf8')) as WriteIntent;
        if (intent.invocation_id !== input.invocation_id) {
          resumeLineage(root, task, input.invocation_id, intent.invocation_id);
          if (!strings(task.meta.data.prior_invocation_ids).includes(intent.invocation_id))
            throw new Error('Task handoff does not retain the original file-write author.');
          requestHash = requestIdentity(intent.invocation_id);
        }
        if (intent.schema_version !== 1 || intent.operation_id !== operationId || intent.request_hash !== requestHash ||
            intent.project_id !== readConfig(root).project_id || intent.task_id !== task.meta.id ||
            intent.workflow_id !== input.workflow_id ||
            intent.path !== input.path || intent.previous_hash !== input.expected_hash || intent.sha256 !== hash(next) ||
            !Number.isSafeInteger(intent.task_revision) || intent.task_revision < 1 ||
            !digest.test(intent.task_record_hash) || !digest.test(intent.task_fingerprint) ||
            !Number.isInteger(intent.mode) || intent.mode < 0 || intent.mode > 0o777)
          throw new Error('File-write retry changed its original operation payload.');
      } else {
        const prior = expected(root, input.path, input.expected_hash);
        const taskBytes = readFileSync(safePath(root, task.path));
        intent = { schema_version: 1, operation_id: operationId, project_id: readConfig(root).project_id,
          task_id: task.meta.id, workflow_id: input.workflow_id, invocation_id: input.invocation_id,
          path: input.path, previous_hash: input.expected_hash, sha256: hash(next), request_hash: requestHash,
          created_at: now(), task_revision: task.meta.revision, task_record_hash: hash(taskBytes),
          task_fingerprint: recordFingerprint(task), mode: prior === null ? 0o644 : lstatSync(physical(root, input.path)).mode & 0o777 };
        immutable(root, `${base}/task.md`, taskBytes);
        if (prior !== null) immutable(root, `${base}/previous.utf8`, prior);
        immutable(root, `${base}/next.utf8`, next);
        immutable(root, intentPath, Buffer.from(JSON.stringify(intent, null, 2) + '\n'));
      }
      const historyHashes = {
        [intentPath]: hash(readFileSync(physical(root, intentPath))),
        [`${base}/task.md`]: intent.task_record_hash,
        [`${base}/next.utf8`]: intent.sha256,
        ...(intent.previous_hash === null ? {} : { [`${base}/previous.utf8`]: intent.previous_hash }),
      };
      for (const [path, checksum] of Object.entries(historyHashes))
        if (!digest.test(checksum) || hash(readFileSync(physical(root, path))) !== checksum)
          throw new Error(`Immutable file-write recovery input was changed: ${path}`);
      if (!entry) {
        expected(root, input.path, input.expected_hash);
        let handoff: WriteEntry['handoff'];
        if (intent.invocation_id !== input.invocation_id) {
          const originalTask = capturedTask(readFileSync(physical(root, `${base}/task.md`)), `${base}/task.md`);
          if (originalTask.meta.id !== task.meta.id || originalTask.meta.data.invocation_id !== intent.invocation_id ||
              recordFingerprint(originalTask) !== intent.task_fingerprint || taskContract(originalTask) !== taskContract(task))
            throw new Error('Interrupted pre-link file write needs an unchanged reviewed task contract.');
          const recordPath = `${base}/handoff-${input.invocation_id}.md`;
          const manifestPath = `${base}/handoff-${input.invocation_id}.json`;
          immutable(root, recordPath, readFileSync(safePath(root, task.path)));
          const recordHash = hash(readFileSync(physical(root, recordPath)));
          if (!existsSync(physical(root, manifestPath)))
            immutable(root, manifestPath, Buffer.from(JSON.stringify({ schema_version: 1,
              kind: 'scoped-file-write-prelink-handoff', task_id: task.meta.id,
              original_invocation_id: intent.invocation_id, recovery_invocation_id: input.invocation_id,
              original_record_hash: intent.task_record_hash, handoff_record_hash: recordHash,
              contract_hash: taskContract(originalTask), request_hash: requestHash, captured_at: now(),
            }, null, 2) + '\n'));
          handoff = { invocation_id: input.invocation_id, record_path: recordPath, record_hash: recordHash,
            manifest_path: manifestPath, manifest_hash: hash(readFileSync(physical(root, manifestPath))) };
          historyHashes[recordPath] = handoff.record_hash;
          historyHashes[manifestPath] = handoff.manifest_hash;
        }
        entry = { operation_id: operationId, path: input.path, previous_hash: input.expected_hash,
          sha256: intent.sha256, request_hash: requestHash, invocation_id: intent.invocation_id,
          intent_path: intentPath, intent_hash: historyHashes[intentPath]!, history_hashes: historyHashes,
          ...(handoff ? { handoff } : {}) };
        const currentEntry = entry;
        const expectedRevision = handoff ? task.meta.revision : intent.task_revision;
        const expectedFingerprint = handoff ? recordFingerprint(task) : intent.task_fingerprint;
        task = updateRecord(root, task.meta.id, {
          data: { workspace_writes: [...entries(task), entry],
            output_paths: [...new Set([...strings(task.meta.data.output_paths), input.path, ...Object.keys(historyHashes)])] },
        }, undefined, (current) => {
          if (current.meta.revision !== expectedRevision || recordFingerprint(current) !== expectedFingerprint)
            throw new Error('Task changed during file-write preparation; preserve the intent and reassess before retry.');
          taskFor(root, input, operationId);
          expected(root, input.path, input.expected_hash);
          if (entries(current).some((item) => item.operation_id === currentEntry.operation_id))
            throw new Error('Concurrent task file-write history already exists.');
        });
      } else {
        if (entry.request_hash !== requestHash) throw new Error('File-write retry changed its original operation payload.');
        replayed = true;
      }
      const current = fileBytes(root, input.path);
      const currentHash = current === null ? null : hash(current);
      if (currentHash !== intent.sha256) {
        if (currentHash !== intent.previous_hash) throw new Error('File-write recovery found unknown current bytes; user edits were preserved.');
        const target = physical(root, input.path);
        mkdirSync(dirname(target), { recursive: true });
        const temporary = `${target}.${randomUUID()}.tmp`;
        try {
          writeFileSync(temporary, next, { flag: 'wx' });
          chmodSync(temporary, intent.mode);
          taskFor(root, input, operationId);
          expected(root, input.path, intent.previous_hash);
          renameSync(temporary, target);
        } catch (error) {
          throw new Error(`File-write I/O or optimistic-CAS operation failed; history retained and unknown edits will not be rolled back: ${error instanceof Error ? error.message : String(error)}`);
        } finally { if (existsSync(temporary)) rmSync(temporary); }
      }
      if (hash(fileBytes(root, input.path) ?? Buffer.alloc(0)) !== intent.sha256)
        throw new Error('File changed after atomic replacement; unknown current edits were preserved.');
      const completionPath = `${base}/completion.json`;
      if (!entry.completion_hash) {
        if (!existsSync(physical(root, completionPath)))
          immutable(root, completionPath, Buffer.from(JSON.stringify({ schema_version: 1,
            kind: 'completed-scoped-file-write', operation_id: operationId, task_id: task.meta.id,
            workflow_id: input.workflow_id, invocation_id: intent.invocation_id,
            recovery_invocation_id: input.invocation_id === intent.invocation_id ? null : input.invocation_id,
            path: input.path,
            previous_hash: intent.previous_hash, sha256: intent.sha256, request_hash: requestHash,
            completed_at: now() }, null, 2) + '\n'));
        const completionBytes = readFileSync(physical(root, completionPath));
        const completion = JSON.parse(completionBytes.toString('utf8'));
        if (completion.schema_version !== 1 || completion.kind !== 'completed-scoped-file-write' ||
            completion.operation_id !== operationId || completion.task_id !== task.meta.id ||
            completion.workflow_id !== input.workflow_id || completion.invocation_id !== intent.invocation_id ||
            completion.path !== input.path || completion.previous_hash !== intent.previous_hash ||
            completion.sha256 !== intent.sha256 || completion.request_hash !== requestHash)
          throw new Error('File-write recovery completion differs from its original intent; preserve the unknown receipt.');
        if (completion.recovery_invocation_id !== null && completion.recovery_invocation_id !== undefined)
          resumeLineage(root, task, completion.recovery_invocation_id, intent.invocation_id);
        const completionHash = hash(completionBytes);
        let recovery: Pick<WriteEntry, 'recovery_path' | 'recovery_hash' | 'recovery_invocation_id'> = {};
        if (input.invocation_id !== intent.invocation_id) {
          const recoveryPath = `${base}/recovery-${input.invocation_id}.json`;
          if (!existsSync(physical(root, recoveryPath)))
            immutable(root, recoveryPath, Buffer.from(JSON.stringify({ schema_version: 1,
              kind: 'scoped-file-write-recovery', operation_id: operationId, task_id: task.meta.id,
              workflow_id: input.workflow_id, original_invocation_id: intent.invocation_id,
              recovery_invocation_id: input.invocation_id, completion_hash: completionHash,
              request_hash: requestHash, recovered_at: now() }, null, 2) + '\n'));
          const value = JSON.parse(readFileSync(physical(root, recoveryPath), 'utf8'));
          if (value.kind !== 'scoped-file-write-recovery' || value.operation_id !== operationId ||
              value.task_id !== task.meta.id || value.workflow_id !== input.workflow_id ||
              value.original_invocation_id !== intent.invocation_id || value.recovery_invocation_id !== input.invocation_id ||
              value.completion_hash !== completionHash || value.request_hash !== requestHash)
            throw new Error('Immutable file-write recovery receipt was changed.');
          recovery = { recovery_path: recoveryPath, recovery_hash: hash(readFileSync(physical(root, recoveryPath))),
            recovery_invocation_id: input.invocation_id };
        }
        const completed = { ...entry, ...recovery, completion_path: completionPath, completion_hash: completionHash,
          history_hashes: { ...entry.history_hashes, [completionPath]: completionHash,
            ...(recovery.recovery_path ? { [recovery.recovery_path]: recovery.recovery_hash! } : {}) } };
        task = updateRecord(root, task.meta.id, { data: {
          workspace_writes: entries(task).map((item) => item.operation_id === operationId ? completed : item),
          output_paths: [...new Set([...strings(task.meta.data.output_paths), completionPath,
            ...(recovery.recovery_path ? [recovery.recovery_path] : [])])],
        } }, undefined, (current) => {
          if (current.meta.revision !== task.meta.revision || current.meta.data.invocation_id !== input.invocation_id)
            throw new Error('Task changed before file-write completion could be linked; retry the same operation.');
          taskFor(root, input, operationId);
          expected(root, input.path, intent.sha256);
        });
        const completionProblems = workspaceHistoryProblems(root, task);
        if (completionProblems.length) throw new Error(completionProblems.join('\n'));
        entry = completed;
      }
      return { operation_id: operationId, path: input.path, previous_hash: intent.previous_hash,
        sha256: intent.sha256, history_paths: Object.keys(entry.history_hashes), task_revision: task.meta.revision, replayed };
    }),
  );
}

/** Replace one exact literal occurrence while preserving every other source byte. */
export function workspaceReplace(root: string, input: WorkspaceReplaceInput): WorkspaceWriteResult {
  ordinaryPath(input.path);
  if (!input || typeof input !== 'object' || !input.replacement ||
      typeof input.replacement.before !== 'string' || !input.replacement.before ||
      typeof input.replacement.after !== 'string' || binaryControl.test(input.replacement.before) ||
      binaryControl.test(input.replacement.after))
    throw new Error('Literal replacement requires non-empty UTF-8 before text and UTF-8 after text.');
  if (typeof input.expected_hash !== 'string' || !digest.test(input.expected_hash))
    throw new Error('Literal replacement requires the current SHA-256 of an existing file.');
  const operationId = input.operation_id ?? randomUUID();
  if (!uuid.test(operationId)) throw new Error('File-write operation_id must be a lowercase UUID.');
  // Run the same live task, receipt, path, verification, and protected-file gates before reading source bytes.
  const task = taskFor(root, {
    task_id: input.task_id, workflow_id: input.workflow_id, invocation_id: input.invocation_id,
    path: input.path, content: '', expected_hash: input.expected_hash, operation_id: operationId,
  }, operationId);
  const historyProblems = workspaceHistoryProblems(root, task, operationId);
  if (historyProblems.length) throw new Error(historyProblems.join('\n'));
  const base = historyBase(task.meta.id, operationId);
  const intentPath = physical(root, `${base}/intent.json`);
  let original: Buffer | null;
  if (existsSync(intentPath)) {
    const intent = JSON.parse(readFileSync(intentPath, 'utf8')) as WriteIntent;
    if (intent.schema_version !== 1 || intent.operation_id !== operationId ||
        intent.task_id !== task.meta.id || intent.workflow_id !== input.workflow_id ||
        intent.path !== input.path || intent.previous_hash !== input.expected_hash)
      throw new Error('File-write retry changed its original operation payload.');
    const previousPath = physical(root, `${base}/previous.utf8`);
    if (!existsSync(previousPath)) throw new Error('Literal replacement retry has no authenticated original bytes in write history.');
    original = readFileSync(previousPath);
    if (hash(original) !== input.expected_hash)
      throw new Error('Literal replacement history does not match the requested original file hash.');
  } else {
    original = expected(root, input.path, input.expected_hash);
    if (original === null) throw new Error('Literal replacement requires an existing file.');
  }
  const text = original.toString('utf8');
  const needle = input.replacement.before;
  let count = 0;
  for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + 1)) count++;
  if (count !== 1) throw new Error(`Literal replacement text must occur exactly once; found ${count} occurrences.`);
  const at = text.indexOf(needle);
  const content = text.slice(0, at) + input.replacement.after + text.slice(at + needle.length);
  return workspaceWrite(root, {
    task_id: input.task_id, workflow_id: input.workflow_id, invocation_id: input.invocation_id,
    path: input.path, content, expected_hash: input.expected_hash, operation_id: operationId,
  });
}
