import test from 'node:test';
import assert from 'node:assert/strict';
import fs, { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, linkSync, symlinkSync } from 'node:fs';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { syncBuiltinESMExports } from 'node:module';
import { initialize, createRecord, updateRecord, getRecord, hash, readConfig } from '../dist/storage.js';
import { beginWorkflow } from '../dist/manager.js';
import { ensureRoutingPolicy, canonicalJson, routingConfigurationHashes, strongRoles } from '../dist/routing.js';
import { startTask, resumeTask, reviewRecord, verify } from '../dist/engineering.js';
import { workspaceWrite, workspaceReplace, workspaceHistoryProblems, workspaceResumeOperations } from '../dist/workspace.js';

// Private FABRICATED signed validation objects test production guards only.
// They demonstrate no account access or native inference; no fixture is packaged.
function receipt(work, role, { state = 'completed', task_id = null, scope = ['task_file_write'], workflow_id = work.workflow.meta.id, prior_invocation_id = null } = {}) {
  const policy = ensureRoutingPolicy(work.root);
  const integrity = 'sha512-NWZdi/kxyjv/8EUGFupziGU38YyleugZRM4JXgY5XFH7FUmaFA33NZS2Bmq0HPazf7S3jJQQWsZ/jAK9jsrV3Q==';
  const protocol = hash('FABRICATED WORKSPACE UNIT VALIDATION');
  writeFileSync(join(work.root, '.verythinker/native-runtime.lock.json'), JSON.stringify({ version: '0.162.1', integrity, protocol_sha256: protocol }));
  if (!work.key) {
    work.key = generateKeyPairSync('ed25519');
    const pem = work.key.publicKey.export({ type: 'spki', format: 'pem' });
    work.keyId = hash(pem);
    mkdirSync(join(work.root, '.verythinker/native/keys'), { recursive: true });
    mkdirSync(join(work.root, '.verythinker/native/receipts'), { recursive: true });
    writeFileSync(join(work.root, `.verythinker/native/keys/${work.keyId}.pem`), pem);
    writeFileSync(join(work.root, '.verythinker/native/trust.json'), JSON.stringify({ keys: [work.keyId] }));
  }
  const id = randomUUID(), strong = strongRoles.includes(role);
  const unsigned = {
    schema_version: 1, issuer: 'verythinker-codex-app-server', execution_mode: 'native',
    id, receipt_path: `.verythinker/native/receipts/${id}.json`, project_id: readConfig(work.root).project_id,
    role, workflow_id, task_id, request_id: null, prior_invocation_id,
    input_text: 'FABRICATED UNIT FIXTURE, not authenticated native proof.', input_sha256: hash('FABRICATED UNIT FIXTURE'),
    requested_model: 'gpt-6-luna', confirmed_model: 'gpt-6-luna',
    model_provider: 'fabricated-unit-provider', native_sandbox: strong ? 'readOnly' : 'workspaceWrite',
    native_tool_scope: scope, gateway_policy_sha256: null, reasoning_effort: strong ? 'max' : 'medium',
    confirmed_reasoning_effort: strong ? 'max' : 'medium', client_version: '0.162.1', runtime_integrity: integrity,
    protocol_sha256: protocol, routing_sha256: hash(canonicalJson(policy)), configuration_hashes: routingConfigurationHashes(work.root),
    effective_configuration_sha256: null, native_thread_id: `fabricated-${id}`, native_turn_id: `fabricated-turn-${id}`,
    state, inference_completed: state === 'completed', output: 'Not an observed inference.', error: null,
    fallback_evidence: null, reroutes: [], permissions: [], owner_pid: process.pid, server_pid: null,
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(), key_id: work.keyId,
  };
  writeFileSync(join(work.root, unsigned.receipt_path), JSON.stringify({ ...unsigned,
    signature: sign(null, Buffer.from(canonicalJson(unsigned)), work.key.privateKey).toString('base64') }));
  return unsigned;
}
function updateReceipt(work, id, patch) {
  const path = join(work.root, `.verythinker/native/receipts/${id}.json`);
  const { signature, ...original } = JSON.parse(readFileSync(path, 'utf8'));
  const unsigned = { ...original, ...patch };
  writeFileSync(path, JSON.stringify({ ...unsigned,
    signature: sign(null, Buffer.from(canonicalJson(unsigned)), work.key.privateKey).toString('base64') }));
}
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'verythinker-workspace-'));
  t.after(() => { assert.equal(dirname(resolve(root)), resolve(tmpdir())); rmSync(root, { recursive: true, force: true }); });
  initialize(root, { project_id: 'WORKSPACE', profile: 'software' });
  ensureRoutingPolicy(root);
  const workflow = beginWorkflow(root, { requirement: 'Export integer one and document the interface.' });
  const work = { root, workflow };
  const author = receipt(work, 'requirements');
  const requirement = updateRecord(root, workflow.meta.data.requirement_id, { data: { acceptance_criteria: ['The named export equals one.'], invocation_id: author.id } });
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src/value.mjs'), 'export const value = 1;\n');
  writeFileSync(join(root, 'README.md'), '# Interface\r\nOriginal user documentation.\r\n');
  const architect = receipt(work, 'architect');
  const design = createRecord(root, { type: 'design', title: 'Integer interface', owner: 'architect',
    links: [{ type: 'satisfies', target: requirement.meta.id }], data: { workflow_id: workflow.meta.id, invocation_id: architect.id, interfaces: ['value: integer'] } });
  const task = createRecord(root, { type: 'task', title: 'Implement and document integer interface', owner: 'developer',
    links: [{ type: 'satisfies', target: requirement.meta.id }, { type: 'implements', target: design.meta.id }],
    data: { routing_required: true, workflow_id: workflow.meta.id, acceptance_criteria: ['Export one.'], allowed_paths: ['src', 'README.md', 'docs'], outputs: ['src/value.mjs', 'README.md'] } });
  updateRecord(root, workflow.meta.id, { data: { task_ids: [task.meta.id] } });
  const strategist = receipt(work, 'verifier');
  const check = createRecord(root, { type: 'check', title: 'Verify integer', owner: 'verifier',
    links: [{ type: 'verifies', target: requirement.meta.id }], data: { workflow_id: workflow.meta.id, invocation_id: strategist.id, baseline_paths: ['src'],
      command: [process.execPath, '--input-type=module', '-e', 'import {value} from "./src/value.mjs"; if(value!==1) process.exit(1)'] } });
  const reviewer = receipt(work, 'reviewer');
  reviewRecord(root, check.meta.id, 'reviewer', 'pass', [], reviewer.id);
  reviewRecord(root, design.meta.id, 'reviewer', 'pass', [], reviewer.id);
  const worker = receipt(work, 'developer', { state: 'running', task_id: task.meta.id });
  startTask(root, task.meta.id, undefined, undefined, worker.id);
  Object.assign(work, { requirement, task, design, check, worker });
  work.write = (patch = {}) => workspaceWrite(root, { task_id: task.meta.id, workflow_id: workflow.meta.id,
    invocation_id: worker.id, path: 'README.md', content: '# Interface\nSee docs for the demonstrated integer interface.\n',
    expected_hash: hash(readFileSync(join(root, 'README.md'))), ...patch });
  work.replace = (replacement, patch = {}) => workspaceReplace(root, { task_id: task.meta.id, workflow_id: workflow.meta.id,
    invocation_id: worker.id, path: 'README.md', replacement,
    expected_hash: hash(readFileSync(join(root, 'README.md'))), ...patch });
  return work;
}

test('scoped write preserves exact prior bytes, producer identity, completion and export references', (t) => {
  const work = fixture(t);
  const previous = readFileSync(join(work.root, 'README.md'));
  const original = getRecord(work.root, work.task.meta.id);
  const originalTaskBytes = readFileSync(join(work.root, original.path));
  const result = work.write();
  assert.equal(result.sha256, hash(readFileSync(join(work.root, 'README.md'))));
  assert.equal(result.previous_hash, hash(previous));
  assert.equal(result.replayed, false);
  const updated = getRecord(work.root, work.task.meta.id);
  assert.equal(updated.meta.data.invocation_id, work.worker.id);
  assert.equal(updated.meta.owner, 'developer');
  assert.equal(updated.meta.revision, original.meta.revision + 2);
  assert.deepEqual(workspaceHistoryProblems(work.root, updated), []);
  for (const path of result.history_paths) assert.ok(updated.meta.data.output_paths.includes(path));
  assert.deepEqual(readFileSync(join(work.root, result.history_paths.find((path) => path.endsWith('/previous.utf8')))), previous);
  assert.deepEqual(readFileSync(join(work.root, result.history_paths.find((path) => path.endsWith('/task.md')))), originalTaskBytes);
  const created = work.write({ path: 'docs/new.txt', content: 'A bounded demonstration.\n', expected_hash: null });
  assert.equal(created.previous_hash, null);
  assert.equal(readFileSync(join(work.root, 'docs/new.txt'), 'utf8'), 'A bounded demonstration.\n');
  assert.equal(created.history_paths.some((path) => path.endsWith('/previous.utf8')), false);
});

test('expected hashes and same-operation recovery preserve user edits and do not duplicate history', (t) => {
  const work = fixture(t);
  const originalHash = hash(readFileSync(join(work.root, 'README.md'))), operation_id = randomUUID();
  const first = work.write({ expected_hash: originalHash, operation_id });
  const revision = getRecord(work.root, work.task.meta.id).meta.revision;
  const recovered = work.write({ expected_hash: originalHash, operation_id });
  assert.equal(recovered.replayed, true);
  assert.equal(recovered.operation_id, first.operation_id);
  assert.equal(getRecord(work.root, work.task.meta.id).meta.revision, revision);
  assert.equal(getRecord(work.root, work.task.meta.id).meta.data.workspace_writes.length, 1);
  assert.throws(() => work.write({ expected_hash: originalHash, operation_id, content: 'Changed retry.' }), /original operation payload/);
  writeFileSync(join(work.root, 'README.md'), 'New user edits.\n');
  assert.throws(() => work.write({ expected_hash: originalHash, operation_id }), /unknown current bytes/);
  assert.equal(readFileSync(join(work.root, 'README.md'), 'utf8'), 'New user edits.\n');
  assert.throws(() => work.write({ expected_hash: originalHash }), /File changed since it was read/);
  assert.throws(() => work.write({ expected_hash: null }), /File changed since it was read/);
  assert.deepEqual(workspaceHistoryProblems(work.root, getRecord(work.root, work.task.meta.id)), []);
});

test('role, producer, workflow, observed capability, lifecycle and current design gates cannot be bypassed', (t) => {
  const work = fixture(t);
  const before = readFileSync(join(work.root, 'README.md'));
  for (const role of ['manager', 'reviewer', 'check-executor']) {
    const other = receipt(work, role, { state: 'running', task_id: work.task.meta.id });
    assert.throws(() => work.write({ invocation_id: other.id }), /current Developer producer/);
  }
  const mismatch = receipt(work, 'developer', { state: 'running', task_id: work.task.meta.id });
  assert.throws(() => work.write({ invocation_id: mismatch.id }), /current Developer producer/);
  assert.throws(() => work.write({ workflow_id: 'WORKSPACE-KNW-9999' }), /current Developer producer/);
  const noScope = receipt(work, 'developer', { state: 'running', task_id: work.task.meta.id, scope: [] });
  updateRecord(work.root, work.task.meta.id, { data: { invocation_id: noScope.id } });
  assert.throws(() => work.write({ invocation_id: noScope.id }), /did not confirm.*task_file_write/);
  const completed = receipt(work, 'developer', { task_id: work.task.meta.id });
  updateRecord(work.root, work.task.meta.id, { data: { invocation_id: completed.id } });
  assert.throws(() => work.write({ invocation_id: completed.id }), /currently running/);
  updateRecord(work.root, work.task.meta.id, { data: { invocation_id: work.worker.id } });
  updateRecord(work.root, work.requirement.meta.id, { data: { acceptance_criteria: ['Export two.'] } });
  assert.throws(() => work.write(), /current reviewed design and verification plans/);
  assert.deepEqual(readFileSync(join(work.root, 'README.md')), before);
});

test('scope, protected expectations, Cornell ownership, configuration, aliases and binary inputs are rejected', (t) => {
  const work = fixture(t);
  for (const path of ['outside.txt', '../README.md', 'src/../README.md', 'src\\value.mjs', 'src/name.', 'src/NUL.txt', '.verythinker/config.json', 'src/.GIT/config', 'src/node_modules/tool.js', 'src/AGENTS.md', 'src/CLAUDE.md', 'src/SKILL.md', 'src/.codex/config.toml', 'src/.env', 'src/file.key'])
    assert.throws(() => work.write({ path, expected_hash: null }), /outside|canonical|managed storage/);
  writeFileSync(join(work.root, 'src/oracle.mjs'), 'export const expectation = 1;\n');
  createRecord(work.root, { type: 'knowledge', title: 'Protected expectations', data: { protected_files: { 'src/oracle.mjs': hash(readFileSync(join(work.root, 'src/oracle.mjs'))) } } });
  assert.throws(() => work.write({ path: 'src/ORACLE.mjs', expected_hash: null }), /protected verification/);
  createRecord(work.root, { type: 'knowledge', title: 'Owned Cornell artifacts', data: { format: 'cornell-v1', artifact_path: 'docs/note.md', artifact_hashes: { 'docs/note.md': hash('note') }, practice: { exercise_path: 'docs/exercise.mjs', answer_path: 'docs/answer.mjs', solution_path: 'docs/my-solution.mjs' } } });
  for (const path of ['docs/note.md', 'docs/EXERCISE.mjs', 'docs/answer.mjs', 'docs/my-solution.mjs'])
    assert.throws(() => work.write({ path, expected_hash: null }), /Cornell-owned/);
  linkSync(join(work.root, 'src/oracle.mjs'), join(work.root, 'src/linked.mjs'));
  assert.throws(() => work.write({ path: 'src/linked.mjs', expected_hash: hash(readFileSync(join(work.root, 'src/oracle.mjs'))) }), /unlinked UTF-8/);
  const link = join(work.root, 'src/alias');
  mkdirSync(join(work.root, 'docs'));
  try {
    symlinkSync(join(work.root, 'docs'), link, process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => work.write({ path: 'src/alias/answer.mjs', expected_hash: null }), /symbolic links/);
  } catch (error) { if (error.code !== 'EPERM' && error.code !== 'ENOENT') throw error; }
  writeFileSync(join(work.root, 'src/binary.txt'), Buffer.from([0xff, 0x00, 0xaa]));
  assert.throws(() => work.write({ path: 'src/binary.txt', expected_hash: hash(Buffer.from([0xff, 0x00, 0xaa])) }), /binary|invalid UTF-8/);
  assert.throws(() => work.write({ content: '\ud800' }), /valid UTF-8/);
  assert.throws(() => work.write({ content: '\u0001\u0002' }), /UTF-8 text/);
  assert.throws(() => work.write({ content: 'x'.repeat(128 * 1024 + 1) }), /128 KiB/);
});

test('real I/O failure leaves an incomplete gate blocker and same payload recovers without losing old bytes', (t) => {
  const work = fixture(t), operation_id = randomUUID();
  const previous = readFileSync(join(work.root, 'README.md')), expected_hash = hash(previous);
  const originalRename = fs.renameSync;
  fs.renameSync = (source, target) => {
    if (resolve(target) === resolve(work.root, 'README.md')) { const error = new Error('Injected unit-only filesystem failure'); error.code = 'EACCES'; throw error; }
    return originalRename(source, target);
  };
  syncBuiltinESMExports();
  try { assert.throws(() => work.write({ operation_id, expected_hash }), /I\/O or optimistic-CAS/); }
  finally { fs.renameSync = originalRename; syncBuiltinESMExports(); }
  assert.deepEqual(readFileSync(join(work.root, 'README.md')), previous);
  const pending = getRecord(work.root, work.task.meta.id);
  assert.match(workspaceHistoryProblems(work.root, pending).join('\n'), /is incomplete/);
  assert.ok(verify(work.root, work.task.meta.id, 'design-ready').findings.some((finding) =>
    finding.code === 'workspace-history' && /is incomplete/.test(finding.message)));
  const completed = work.write({ operation_id, expected_hash });
  assert.equal(completed.replayed, true);
  assert.deepEqual(workspaceHistoryProblems(work.root, getRecord(work.root, work.task.meta.id)), []);
  assert.equal(getRecord(work.root, work.task.meta.id).meta.data.workspace_writes.length, 1);
  const old = completed.history_paths.find((path) => path.endsWith('/previous.utf8'));
  assert.deepEqual(readFileSync(join(work.root, old)), previous);
  writeFileSync(join(work.root, old), 'Tampered old history.');
  assert.match(workspaceHistoryProblems(work.root, getRecord(work.root, work.task.meta.id)).join('\n'), /missing or changed/);
  assert.ok(verify(work.root, work.task.meta.id, 'design-ready').findings.some((finding) =>
    finding.code === 'workspace-history' && /missing or changed/.test(finding.message)));
  assert.throws(() => work.write({ path: 'src/second.mjs', content: 'export const second = 2;\n', expected_hash: null }), /missing or changed/);
});

test('completion metadata failure recovers the actual write, then later writes preserve historical outcomes', (t) => {
  const work = fixture(t), operation_id = randomUUID();
  const previous = readFileSync(join(work.root, 'README.md')), expected_hash = hash(previous);
  const taskPath = resolve(work.root, getRecord(work.root, work.task.meta.id).path);
  const originalRename = fs.renameSync;
  let recordWrites = 0;
  fs.renameSync = (source, target) => {
    if (resolve(target) === taskPath && ++recordWrites === 2)
      throw new Error('Injected unit-only completion metadata failure');
    return originalRename(source, target);
  };
  syncBuiltinESMExports();
  try { assert.throws(() => work.write({ operation_id, expected_hash }), /completion metadata failure/); }
  finally { fs.renameSync = originalRename; syncBuiltinESMExports(); }
  assert.equal(readFileSync(join(work.root, 'README.md'), 'utf8'), '# Interface\nSee docs for the demonstrated integer interface.\n');
  assert.match(workspaceHistoryProblems(work.root, getRecord(work.root, work.task.meta.id)).join('\n'), /incomplete/);
  const recovered = work.write({ operation_id, expected_hash });
  assert.equal(recovered.replayed, true);
  assert.deepEqual(workspaceHistoryProblems(work.root, getRecord(work.root, work.task.meta.id)), []);
  const later = work.write({ content: '# Interface\nA later scoped update retains prior verified write history.\n' });
  assert.notEqual(later.operation_id, recovered.operation_id);
  assert.deepEqual(workspaceHistoryProblems(work.root, getRecord(work.root, work.task.meta.id)), []);
  const completionPath = recovered.history_paths.find((path) => path.endsWith('/completion.json'));
  const raw = readFileSync(join(work.root, completionPath));
  writeFileSync(join(work.root, completionPath), Buffer.concat([raw, Buffer.from('\n')]));
  assert.match(workspaceHistoryProblems(work.root, getRecord(work.root, work.task.meta.id)).join('\n'), /missing or changed/);
  assert.ok(verify(work.root, work.task.meta.id, 'design-ready').findings.some((finding) => finding.code === 'workspace-history'));
});

test('an edit arriving after intent linkage is preserved at the last hash check', (t) => {
  const work = fixture(t), operation_id = randomUUID();
  const expected_hash = hash(readFileSync(join(work.root, 'README.md')));
  const taskPath = resolve(work.root, getRecord(work.root, work.task.meta.id).path);
  const originalRename = fs.renameSync;
  let injected = false;
  fs.renameSync = (source, target) => {
    const result = originalRename(source, target);
    if (!injected && resolve(target) === taskPath) {
      injected = true;
      writeFileSync(join(work.root, 'README.md'), 'A concurrent user edit must survive.\n');
    }
    return result;
  };
  syncBuiltinESMExports();
  try { assert.throws(() => work.write({ operation_id, expected_hash }), /unknown current bytes/); }
  finally { fs.renameSync = originalRename; syncBuiltinESMExports(); }
  assert.equal(readFileSync(join(work.root, 'README.md'), 'utf8'), 'A concurrent user edit must survive.\n');
  assert.match(workspaceHistoryProblems(work.root, getRecord(work.root, work.task.meta.id)).join('\n'), /incomplete/);
  assert.throws(() => work.write({ operation_id, expected_hash }), /unknown current bytes/);
  assert.equal(readFileSync(join(work.root, 'README.md'), 'utf8'), 'A concurrent user edit must survive.\n');
});

test('an interrupted write resumes only through signed same-assignment lineage and preserves original authorship', (t) => {
  const work = fixture(t), operation_id = randomUUID();
  const expected_hash = hash(readFileSync(join(work.root, 'README.md')));
  const originalRename = fs.renameSync;
  fs.renameSync = (source, target) => {
    if (resolve(target) === resolve(work.root, 'README.md')) throw new Error('Injected interrupted write');
    return originalRename(source, target);
  };
  syncBuiltinESMExports();
  try { assert.throws(() => work.write({ operation_id, expected_hash }), /interrupted write/); }
  finally { fs.renameSync = originalRename; syncBuiltinESMExports(); }
  updateReceipt(work, work.worker.id, { state: 'interrupted', inference_completed: false });
  const foreign = receipt(work, 'developer', { state: 'running', task_id: work.task.meta.id });
  assert.throws(() => resumeTask(work.root, work.task.meta.id, undefined, undefined, foreign.id), /original author|resume lineage/);
  assert.equal(getRecord(work.root, work.task.meta.id).meta.data.invocation_id, work.worker.id);
  const wrongTask = receipt(work, 'developer', { state: 'running', task_id: 'WORKSPACE-TASK-9999', prior_invocation_id: work.worker.id });
  assert.throws(() => resumeTask(work.root, work.task.meta.id, undefined, undefined, wrongTask.id), /different task/);
  const resumed = receipt(work, 'developer', { state: 'running', task_id: work.task.meta.id, prior_invocation_id: work.worker.id });
  updateRecord(work.root, work.task.meta.id, { status: 'blocked' });
  assert.deepEqual(workspaceResumeOperations(work.root, getRecord(work.root, work.task.meta.id), resumed.id), [operation_id]);
  resumeTask(work.root, work.task.meta.id, undefined, undefined, resumed.id);
  assert.throws(() => work.write({ operation_id, expected_hash, invocation_id: resumed.id, content: 'Changed resumed payload.' }), /original operation payload/);
  const recovered = work.write({ operation_id, expected_hash, invocation_id: resumed.id });
  const task = getRecord(work.root, work.task.meta.id), entry = task.meta.data.workspace_writes[0];
  assert.equal(entry.invocation_id, work.worker.id);
  assert.equal(task.meta.data.invocation_id, resumed.id);
  assert.ok(task.meta.data.prior_invocation_ids.includes(work.worker.id));
  assert.equal(entry.recovery_invocation_id, resumed.id);
  const recovery = JSON.parse(readFileSync(join(work.root, entry.recovery_path), 'utf8'));
  assert.equal(recovery.original_invocation_id, work.worker.id);
  assert.equal(recovery.recovery_invocation_id, resumed.id);
  const completion = JSON.parse(readFileSync(join(work.root, entry.completion_path), 'utf8'));
  assert.equal(completion.invocation_id, work.worker.id);
  assert.equal(completion.recovery_invocation_id, resumed.id);
  assert.deepEqual(workspaceHistoryProblems(work.root, task), []);
  assert.equal(recovered.replayed, true);
  assert.equal(JSON.parse(readFileSync(join(work.root, work.worker.receipt_path), 'utf8')).state, 'interrupted');
});

test('interruption before task linkage recovers only an unchanged contract and archives a separate handoff', (t) => {
  const work = fixture(t), operation_id = randomUUID();
  const previous = readFileSync(join(work.root, 'README.md')), expected_hash = hash(previous);
  const originalTaskBytes = readFileSync(join(work.root, getRecord(work.root, work.task.meta.id).path));
  const taskPath = resolve(work.root, getRecord(work.root, work.task.meta.id).path);
  const originalRename = fs.renameSync;
  fs.renameSync = (source, target) => {
    if (resolve(target) === taskPath) throw new Error('Injected pre-link metadata failure');
    return originalRename(source, target);
  };
  syncBuiltinESMExports();
  try { assert.throws(() => work.write({ operation_id, expected_hash }), /pre-link metadata failure/); }
  finally { fs.renameSync = originalRename; syncBuiltinESMExports(); }
  assert.equal(getRecord(work.root, work.task.meta.id).meta.data.workspace_writes, undefined);
  assert.deepEqual(readFileSync(join(work.root, 'README.md')), previous);
  const base = `.verythinker/evidence/workspace-history/${work.task.meta.id}/${operation_id}`;
  const frozenIntent = readFileSync(join(work.root, base, 'intent.json'));
  updateReceipt(work, work.worker.id, { state: 'interrupted', inference_completed: false });
  const resumed = receipt(work, 'developer', { state: 'running', task_id: work.task.meta.id, prior_invocation_id: work.worker.id });
  resumeTask(work.root, work.task.meta.id, undefined, undefined, resumed.id);
  updateRecord(work.root, work.task.meta.id, { data: { allowed_paths: ['src', 'README.md', 'docs', 'extra'] } });
  assert.throws(() => work.write({ operation_id, expected_hash, invocation_id: resumed.id }), /unchanged reviewed task contract/);
  updateRecord(work.root, work.task.meta.id, { data: { allowed_paths: ['src', 'README.md', 'docs'] } });
  const handoffTaskBytes = readFileSync(taskPath);
  const recovered = work.write({ operation_id, expected_hash, invocation_id: resumed.id });
  const updated = getRecord(work.root, work.task.meta.id), entry = updated.meta.data.workspace_writes[0];
  assert.equal(entry.invocation_id, work.worker.id);
  assert.equal(entry.handoff.invocation_id, resumed.id);
  assert.deepEqual(readFileSync(join(work.root, entry.handoff.record_path)), handoffTaskBytes);
  assert.deepEqual(readFileSync(join(work.root, base, 'task.md')), originalTaskBytes);
  assert.deepEqual(readFileSync(join(work.root, base, 'intent.json')), frozenIntent);
  assert.ok(recovered.history_paths.includes(entry.handoff.record_path));
  assert.ok(recovered.history_paths.includes(entry.handoff.manifest_path));
  assert.deepEqual(workspaceHistoryProblems(work.root, updated), []);
});

test('literal replacement preserves unrelated bytes, CRLF and literal backslash-n sequences', (t) => {
  const work = fixture(t);
  const original = '# Interface\r\nKeep literal \\n marker. Original user documentation.\r\n';
  writeFileSync(join(work.root, 'README.md'), original);
  const result = work.replace({ before: 'Original user documentation.', after: 'Updated documentation.' });
  assert.equal(result.replayed, false);
  assert.equal(readFileSync(join(work.root, 'README.md'), 'utf8'),
    '# Interface\r\nKeep literal \\n marker. Updated documentation.\r\n');
});

test('literal replacement rejects absent, repeated, stale, protected and escaping targets', (t) => {
  const work = fixture(t);
  assert.throws(() => work.replace({ before: 'not present', after: 'replacement' }), /exactly once; found 0/);
  writeFileSync(join(work.root, 'README.md'), 'same same');
  assert.throws(() => work.replace({ before: 'same', after: 'different' }), /exactly once; found 2/);
  writeFileSync(join(work.root, 'README.md'), '# Interface\r\nOriginal user documentation.\r\n');
  const staleHash = hash(readFileSync(join(work.root, 'README.md')));
  writeFileSync(join(work.root, 'README.md'), '# Interface\r\nConcurrent user edit.\r\n');
  assert.throws(() => work.replace({ before: 'Concurrent user edit.', after: 'replacement' }, { expected_hash: staleHash }), /File changed since it was read/);
  createRecord(work.root, { type: 'knowledge', title: 'Protected README', data: { protected_files: { 'README.md': hash(readFileSync(join(work.root, 'README.md'))) } } });
  assert.throws(() => work.replace({ before: 'Concurrent user edit.', after: 'replacement' }), /protected verification/);
  assert.throws(() => work.replace({ before: 'Concurrent user edit.', after: 'replacement' }, { path: '../README.md' }), /canonical project-relative/);
});

test('literal replacement recovers lost responses from authenticated old bytes and rejects changed payloads', (t) => {
  const work = fixture(t), operation_id = randomUUID();
  const original = readFileSync(join(work.root, 'README.md'));
  const expected_hash = hash(original);
  const replacement = { before: 'Original user documentation.', after: 'Recovered documentation.' };
  const originalRename = fs.renameSync;
  fs.renameSync = (source, target) => {
    if (resolve(target) === resolve(work.root, 'README.md')) {
      const error = new Error('Injected unit-only filesystem failure'); error.code = 'EACCES'; throw error;
    }
    return originalRename(source, target);
  };
  syncBuiltinESMExports();
  try {
    assert.throws(() => work.replace(replacement, { operation_id, expected_hash }), /I\/O or optimistic-CAS/);
  } finally { fs.renameSync = originalRename; syncBuiltinESMExports(); }
  assert.deepEqual(readFileSync(join(work.root, 'README.md')), original);
  assert.throws(() => work.replace({ ...replacement, after: 'Different payload.' }, { operation_id, expected_hash }), /original operation payload/);
  const recovered = work.replace(replacement, { operation_id, expected_hash });
  assert.equal(recovered.replayed, true);
  assert.equal(readFileSync(join(work.root, 'README.md'), 'utf8'), '# Interface\r\nRecovered documentation.\r\n');
  assert.deepEqual(readFileSync(join(work.root, recovered.history_paths.find((path) => path.endsWith('/previous.utf8')))), original);
});

test('compiler source operands stay editable while explicitly reviewed verification artifacts stay protected', (t) => {
  const work = fixture(t);
  writeFileSync(join(work.root, 'src/controller.c'), 'int controller(void) { return 1; }\n');
  const strategist = receipt(work, 'verifier');
  const compilerCheck = createRecord(work.root, { type: 'check', title: 'Compile the editable controller source', owner: 'verifier',
    links: [{ type: 'verifies', target: work.requirement.meta.id }], data: {
      workflow_id: work.workflow.meta.id, invocation_id: strategist.id, baseline_paths: ['src'],
      command: ['gcc', 'src/controller.c', '-c', '-o', 'controller.o'],
    } });
  const reviewer = receipt(work, 'reviewer');
  reviewRecord(work.root, compilerCheck.meta.id, 'reviewer', 'pass', [], reviewer.id);
  work.write({ path: 'src/controller.c', content: 'int controller(void) { return 2; }\n',
    expected_hash: hash(readFileSync(join(work.root, 'src/controller.c'))) });
  assert.equal(readFileSync(join(work.root, 'src/controller.c'), 'utf8'), 'int controller(void) { return 2; }\n');
  writeFileSync(join(work.root, 'src/verification.mjs'), 'if (2 !== 2) process.exit(1);\n');
  createRecord(work.root, { type: 'knowledge', title: 'Reviewed frozen verification procedure',
    data: { verification_artifact_paths: ['src/verification.mjs'] } });
  assert.throws(() => work.write({ path: 'src/verification.mjs', content: 'process.exit(0);\n',
    expected_hash: hash(readFileSync(join(work.root, 'src/verification.mjs'))) }), /protected verification/);
  assert.equal(readFileSync(join(work.root, 'src/verification.mjs'), 'utf8'), 'if (2 !== 2) process.exit(1);\n');
});
