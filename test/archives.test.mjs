import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  renameSync,
  existsSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import {
  initialize,
  createRecord,
  updateRecord,
  getRecord,
  hash,
  loadRecords,
  readConfig,
} from '../dist/storage.js';
import {
  startTask,
  runCheck,
  archiveEvidence,
  submitTask,
  reviewTask,
  reviewRecord,
  recordFingerprint,
  verify,
} from '../dist/engineering.js';
import { canonicalJson, ensureRoutingPolicy, routingConfigurationHashes } from '../dist/routing.js';
import { validateEvidenceInputs } from '../dist/evidence-inputs.js';
import {
  ensureArchivePolicy,
  readArchivePolicy,
  assertPrivateArchiveDestination,
  prepareArchive,
  publishArchive,
  archiveStatus,
  restoreArchive,
  acceptedArchiveForWorkflow,
  reassessArchive,
} from '../dist/archives.js';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'verythinker-archive-'));
  const restore = `${root}-restored`;
  t.after(() => {
    for (const target of [root, restore, `${root}-renamed`]) {
      assert.equal(dirname(resolve(target)), resolve(tmpdir()));
      assert.match(target, /verythinker-archive-/);
      rmSync(target, { recursive: true, force: true });
    }
  });
  initialize(root, { project_id: 'ARCHIVE', profile: 'basic' });
  const policy = ensureArchivePolicy(root);
  writeFileSync(
    join(root, '.verythinker/archive.json'),
    JSON.stringify({ ...policy, repository: 'example/private' }, null, 2) + '\n',
  );
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src/value.mjs'), 'export const value = 1;\n');
  writeFileSync(join(root, 'src/image.bin'), Buffer.from([0, 255, 130, 0, 12]));
  const requirement = createRecord(root, {
    type: 'requirement',
    title: 'Export a fixed integer',
    data: { acceptance_criteria: ['The value is integer one.'] },
  });
  const parent = createRecord(root, {
    type: 'knowledge',
    title: 'Deliver a fixed integer',
    data: {
      kind: 'manager-workflow',
      increment_id: randomUUID(),
      requirement_id: requirement.meta.id,
      requirement_ids: [requirement.meta.id],
      change_type: 'feature',
      task_ids: [],
      open_questions: [],
    },
    links: [{ type: 'documents', target: requirement.meta.id }],
  });
  const task = createRecord(root, {
    type: 'task',
    title: 'Implement fixed integer',
    owner: 'developer',
    links: [{ type: 'satisfies', target: requirement.meta.id }],
    data: {
      workflow_id: parent.meta.id,
      acceptance_criteria: ['Export integer one.'],
      allowed_paths: ['src'],
      outputs: ['src/value.mjs', 'src/image.bin'],
    },
  });
  const check = createRecord(root, {
    type: 'check',
    title: 'Check exported integer',
    links: [{ type: 'verifies', target: requirement.meta.id }],
    data: {
      command: [
        process.execPath,
        '--input-type=module',
        '-e',
        'import {value} from "./src/value.mjs"; if(value!==1) process.exit(1)',
      ],
      baseline_paths: ['src'],
    },
  });
  startTask(root, task.meta.id, undefined, undefined, 'worker-fixture');
  const evidence = archiveEvidence(root, runCheck(root, check.meta.id, task.meta.id).meta.id);
  submitTask(root, task.meta.id, 'Implemented the fixed integer and checked its exported value.');
  reviewTask(root, task.meta.id, 'reviewer', 'pass', [], 'reviewer-fixture');
  const decision = createRecord(root, {
    type: 'knowledge',
    title: 'Fixed integer decision',
    links: [{ type: 'documents', target: parent.meta.id }],
    data: {
      kind: 'manager-decision',
      workflow_id: parent.meta.id,
      requirement_baseline: { [requirement.meta.id]: recordFingerprint(requirement) },
    },
  });
  updateRecord(root, parent.meta.id, {
    data: { task_ids: [task.meta.id], decision_id: decision.meta.id },
  });
  return {
    root,
    restore,
    parent: getRecord(root, parent.meta.id),
    task,
    requirement,
    evidence,
    check,
  };
}
function github({ privateRepo = true, loseReference = false, loseCommit = false } = {}) {
  const calls = [];
  const branches = new Map([['main', 'base']]);
  const commits = new Map([['base', { sha: 'base', tree: { sha: 'base-tree' }, parents: [] }]]);
  const payloads = new Map();
  const ancestor = (older, newer) =>
    older === newer ||
    (commits.get(newer)?.parents ?? []).some((parent) => ancestor(older, parent.sha));
  const request = (method, endpoint, body) => {
    calls.push({ method, endpoint, body });
    if (endpoint === 'repos/example/private')
      return { private: privateRepo, default_branch: 'main' };
    if (endpoint.includes('/git/ref/heads/')) {
      const branch = decodeURIComponent(endpoint.split('/git/ref/heads/')[1]);
      if (branches.has(branch)) return { object: { sha: branches.get(branch) } };
      const error = new Error('HTTP 404');
      error.status = 404;
      throw error;
    }
    if (endpoint.includes('/git/commits/') && method === 'GET')
      return commits.get(endpoint.split('/git/commits/')[1]);
    if (endpoint.includes('/compare/')) {
      const [older, newer] = endpoint.split('/compare/')[1].split('...');
      return {
        status: older === newer ? 'identical' : ancestor(older, newer) ? 'ahead' : 'diverged',
      };
    }
    if (endpoint.endsWith('/git/blobs')) return { sha: hash(JSON.stringify(body)) };
    if (endpoint.endsWith('/git/trees')) return { sha: hash(JSON.stringify(body)) };
    if (endpoint.endsWith('/git/commits')) {
      const sha = hash(JSON.stringify(body));
      commits.set(sha, {
        sha,
        tree: { sha: body.tree },
        parents: body.parents.map((parent) => ({ sha: parent })),
      });
      payloads.set(sha, body);
      if (loseCommit) {
        loseCommit = false;
        throw new Error('Lost response after creating commit.');
      }
      return { sha };
    }
    if (endpoint.endsWith('/git/refs') || endpoint.includes('/git/refs/heads/')) {
      const branch =
        method === 'POST'
          ? body.ref.replace('refs/heads/', '')
          : decodeURIComponent(endpoint.split('/git/refs/heads/')[1]);
      if (method === 'PATCH') {
        assert.equal(body.force, false);
        assert.ok(ancestor(branches.get(branch), body.sha));
      }
      branches.set(branch, body.sha);
      if (loseReference) {
        loseReference = false;
        throw new Error('Lost response after updating archive reference.');
      }
      return {};
    }
    throw new Error(`Unexpected GitHub request: ${method} ${endpoint}`);
  };
  return { request, calls, branches, commits, payloads };
}
function nextIncrement(work, root = work.root, outputs = ['src/value.mjs', 'src/image.bin']) {
  const parent = createRecord(root, {
    type: 'knowledge',
    title: 'Follow-up project increment',
    data: {
      kind: 'manager-workflow',
      increment_id: randomUUID(),
      requirement_id: work.requirement.meta.id,
      requirement_ids: [work.requirement.meta.id],
      change_type: 'fix',
      task_ids: [],
      open_questions: [],
    },
    links: [{ type: 'documents', target: work.requirement.meta.id }],
  });
  const task = createRecord(root, {
    type: 'task',
    title: 'Verify follow-up implementation',
    owner: 'developer',
    links: [{ type: 'satisfies', target: work.requirement.meta.id }],
    data: {
      workflow_id: parent.meta.id,
      acceptance_criteria: ['The exported value remains integer one.'],
      allowed_paths: ['src'],
      outputs,
    },
  });
  startTask(root, task.meta.id, undefined, undefined, 'worker-follow-up-fixture');
  archiveEvidence(root, runCheck(root, work.check.meta.id, task.meta.id).meta.id);
  submitTask(root, task.meta.id, 'Delivered and verified the bounded follow-up implementation.');
  reviewTask(root, task.meta.id, 'reviewer', 'pass', [], 'reviewer-follow-up-fixture');
  const decision = createRecord(root, {
    type: 'knowledge',
    title: 'Follow-up project decision',
    links: [{ type: 'documents', target: parent.meta.id }],
    data: {
      kind: 'manager-decision',
      workflow_id: parent.meta.id,
      requirement_baseline: {
        [work.requirement.meta.id]: recordFingerprint(getRecord(root, work.requirement.meta.id)),
      },
    },
  });
  return updateRecord(root, parent.meta.id, {
    data: { task_ids: [task.meta.id], decision_id: decision.meta.id },
  });
}

// Fabricated, privately signed validation fixtures exercise archive gates only.
// They are never native execution evidence and establish no account/model access.
function validationReceiptFixture(work, role, state = 'completed') {
  const root = work.root;
  const policy = ensureRoutingPolicy(root);
  const integrity =
    'sha512-NWZdi/kxyjv/8EUGFupziGU38YyleugZRM4JXgY5XFH7FUmaFA33NZS2Bmq0HPazf7S3jJQQWsZ/jAK9jsrV3Q==';
  const protocol = hash('fabricated archive gate validation protocol');
  writeFileSync(
    join(root, '.verythinker/native-runtime.lock.json'),
    JSON.stringify({ version: '0.162.1', integrity, protocol_sha256: protocol }),
  );
  if (!work.validationKey) {
    work.validationKey = generateKeyPairSync('ed25519');
    const pem = work.validationKey.publicKey.export({ type: 'spki', format: 'pem' });
    work.validationKeyId = hash(pem);
    mkdirSync(join(root, '.verythinker/native/keys'), { recursive: true });
    mkdirSync(join(root, '.verythinker/native/receipts'), { recursive: true });
    writeFileSync(join(root, `.verythinker/native/keys/${work.validationKeyId}.pem`), pem);
    writeFileSync(
      join(root, '.verythinker/native/trust.json'),
      JSON.stringify({ keys: [work.validationKeyId] }),
    );
  }
  const id = randomUUID();
  const model = role === 'manager' ? 'gpt-6.1-sol' : 'gpt-6-luna';
  const effort = role === 'manager' ? 'high' : 'medium';
  const receipt = {
    schema_version: 1,
    issuer: 'verythinker-codex-app-server',
    execution_mode: 'native',
    id,
    receipt_path: `.verythinker/native/receipts/${id}.json`,
    project_id: readConfig(root).project_id,
    role,
    workflow_id: work.parent.meta.id,
    task_id: null,
    request_id: null,
    prior_invocation_id: null,
    input_text: 'FABRICATED UNIT VALIDATION FIXTURE: no native account or inference was used.',
    input_sha256: hash('fabricated validation fixture'),
    requested_model: model,
    confirmed_model: model,
    model_provider: 'fabricated-validation-provider',
    native_sandbox: role === 'manager' ? 'readOnly' : 'workspaceWrite',
    native_tool_scope: [],
    gateway_policy_sha256: null,
    reasoning_effort: effort,
    confirmed_reasoning_effort: effort,
    client_version: '0.162.1',
    runtime_integrity: integrity,
    protocol_sha256: protocol,
    routing_sha256: hash(canonicalJson(policy)),
    configuration_hashes: routingConfigurationHashes(root),
    effective_configuration_sha256: null,
    native_thread_id: `fabricated-${id}`,
    native_turn_id: `fabricated-turn-${id}`,
    state,
    inference_completed: state === 'completed',
    output: 'Fabricated archive gate validation output; not an observed inference.',
    error: null,
    fallback_evidence: null,
    reroutes: [],
    permissions: [],
    owner_pid: process.pid,
    server_pid: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    key_id: work.validationKeyId,
  };
  writeFileSync(
    join(root, receipt.receipt_path),
    JSON.stringify({
      ...receipt,
      signature: sign(
        null,
        Buffer.from(canonicalJson(receipt)),
        work.validationKey.privateKey,
      ).toString('base64'),
    }),
  );
  return receipt;
}
test('archive policy is absent for legacy projects and preserves a stable namespace after rename', (t) => {
  const work = fixture(t);
  const original = readArchivePolicy(work.root);
  renameSync(work.root, `${work.root}-renamed`);
  assert.equal(ensureArchivePolicy(`${work.root}-renamed`).namespace, original.namespace);
  assert.equal(ensureArchivePolicy(`${work.root}-renamed`).repository, original.repository);
  const fresh = join(`${work.root}-renamed`, 'legacy');
  mkdirSync(fresh);
  initialize(fresh, { project_id: 'LEGACY' });
  assert.equal(readArchivePolicy(fresh), null);
  assert.equal(
    ensureArchivePolicy(fresh).repository,
    'VuThach3001/VeryThinker-Project-Archives',
  );
});
test('accepted snapshot preserves record bytes, binary files, and evidence when restored', (t) => {
  const work = fixture(t);
  const unrelated = createRecord(work.root, {
    type: 'task',
    title: 'Unrelated active work',
    data: { requirements: [work.requirement.meta.id], allowed_paths: ['elsewhere'] },
  });
  const snapshot = prepareArchive(work.root, work.parent.meta.id);
  assert.equal(snapshot.manifest.release, '1.0.0');
  assert.ok(!snapshot.manifest.records.some((record) => record.id === unrelated.meta.id));
  assert.ok(snapshot.manifest.files.some((file) => file.path.endsWith('/receipt.json')));
  const result = restoreArchive(work.root, snapshot.snapshot_id, work.restore);
  assert.equal(result.files, snapshot.manifest.files.length);
  assert.deepEqual(
    readFileSync(join(work.restore, 'src/image.bin')),
    Buffer.from([0, 255, 130, 0, 12]),
  );
  for (const record of snapshot.manifest.records)
    assert.deepEqual(
      readFileSync(join(work.root, record.path)),
      readFileSync(join(work.restore, record.path)),
    );
  assert.equal(verify(work.restore, work.task.meta.id, 'accepted').ok, true);
  assert.throws(
    () => restoreArchive(work.root, snapshot.snapshot_id, work.restore),
    /empty directory/,
  );
});
test('archive cannot export arbitrary inputs, raw logs, credentials, or duplicate record IDs', (t) => {
  const work = fixture(t);
  writeFileSync(join(work.root, 'unreviewed.md'), 'Unreviewed unrelated text.');
  assert.throws(
    () => prepareArchive(work.root, work.parent.meta.id, { source_paths: ['unreviewed.md'] }),
    /outside reviewed/,
  );
  const log = getRecord(work.root, work.evidence.meta.id).meta.data.log_path;
  writeFileSync(join(work.root, log), 'ghp_' + '123456789012345678901234567890123456');
  assert.throws(() => prepareArchive(work.root, work.parent.meta.id), /gate failed/);
  // Working checkpoints still inspect source content even before acceptance.
  assert.throws(
    () => prepareArchive(work.root, work.parent.meta.id, { disposition: 'working' }),
    /Sensitive content/,
  );
  writeFileSync(
    join(work.root, log),
    JSON.stringify({ Authorization: 'Bearer ' + 'synthetic-private-sample-value' }),
  );
  assert.throws(
    () => prepareArchive(work.root, work.parent.meta.id, { disposition: 'working' }),
    /Sensitive content/,
  );
  writeFileSync(
    join(work.root, '.verythinker/records/duplicate.md'),
    readFileSync(join(work.root, work.task.path)),
  );
  assert.throws(() => prepareArchive(work.root, work.parent.meta.id), /Duplicate record ID/);
});
test('private publication advances baseline then freezes release and increment without a PR', (t) => {
  const work = fixture(t);
  const snapshot = prepareArchive(work.root, work.parent.meta.id);
  const remote = github();
  const state = publishArchive(work.root, snapshot.snapshot_id, { request: remote.request });
  assert.equal(state.status, 'completed');
  const references = remote.calls
    .filter((call) => call.endpoint.endsWith('/git/refs'))
    .map((call) => call.body.ref);
  assert.deepEqual(references, [
    `refs/heads/${snapshot.manifest.namespace}/baseline`,
    `refs/heads/${snapshot.manifest.namespace}/releases/1.0.0`,
    `refs/heads/${snapshot.manifest.namespace}/increments/${snapshot.manifest.increment_id}`,
  ]);
  assert.equal(
    remote.calls.some((call) => call.endpoint.includes('/pulls')),
    false,
  );
  assert.equal(readArchivePolicy(work.root).last_release, '1.0.0');
  const tree = remote.calls.find((call) => call.endpoint.endsWith('/git/trees')).body.tree;
  assert.ok(tree.some((entry) => entry.path === 'projects/ARCHIVE/workspace/src/image.bin'));
  assert.equal(archiveStatus(work.root, snapshot.snapshot_id).publication.commit, state.commit);
});
test('public upstream and stale local inputs block upload before blob creation', (t) => {
  const work = fixture(t);
  const snapshot = prepareArchive(work.root, work.parent.meta.id);
  const publicRemote = github({ privateRepo: false });
  assert.throws(
    () => publishArchive(work.root, snapshot.snapshot_id, { request: publicRemote.request }),
    /confirmed private/,
  );
  assert.equal(publicRemote.calls.length, 1);
  writeFileSync(join(work.root, 'src/image.bin'), 'Changed binary baseline.');
  const remote = github();
  assert.throws(
    () => publishArchive(work.root, snapshot.snapshot_id, { request: remote.request }),
    /input changed/,
  );
  assert.equal(
    remote.calls.some((call) => call.endpoint.endsWith('/git/blobs')),
    false,
  );
});
test('private destination preflight is read-only and rejects public or unconfirmed visibility before preparation', (t) => {
  const work = fixture(t);
  const policyPath = join(work.root, '.verythinker/archive.json');
  const originalPolicy = readFileSync(policyPath);
  const publicRemote = github({ privateRepo: false });
  assert.throws(
    () => assertPrivateArchiveDestination(work.root, { request: publicRemote.request }),
    /confirmed private/,
  );
  assert.equal(publicRemote.calls.length, 1);
  assert.equal(publicRemote.calls[0].method, 'GET');
  assert.equal(existsSync(join(work.root, '.verythinker/archives')), false);
  assert.equal(existsSync(join(work.root, '.verythinker/archive-intents')), false);
  assert.deepEqual(readFileSync(policyPath), originalPolicy);
  assert.throws(
    () => assertPrivateArchiveDestination(work.root, { request: () => ({}) }),
    /confirmed private/,
  );
  const privateRemote = github();
  assert.deepEqual(
    assertPrivateArchiveDestination(work.root, { request: privateRemote.request }),
    readArchivePolicy(work.root),
  );
  assert.equal(privateRemote.calls.length, 1);
  assert.deepEqual(readFileSync(policyPath), originalPolicy);
});
test('lost commit and baseline update responses recover the same publication identities', (t) => {
  const work = fixture(t);
  const snapshot = prepareArchive(work.root, work.parent.meta.id);
  const remote = github({ loseCommit: true, loseReference: true });
  assert.throws(
    () => publishArchive(work.root, snapshot.snapshot_id, { request: remote.request }),
    /Lost response.*commit/,
  );
  assert.throws(
    () => publishArchive(work.root, snapshot.snapshot_id, { request: remote.request }),
    /Lost response.*reference/,
  );
  const state = publishArchive(work.root, snapshot.snapshot_id, { request: remote.request });
  assert.equal(remote.commits.size, 2);
  assert.equal(state.status, 'completed');
  const before = remote.calls.length;
  assert.equal(
    publishArchive(work.root, snapshot.snapshot_id, { request: remote.request }).commit,
    state.commit,
  );
  assert.equal(remote.calls.length, before + 1);
});
test('concurrent prepared increments cannot overwrite an advanced baseline or reuse a release', (t) => {
  const work = fixture(t);
  const one = prepareArchive(work.root, work.parent.meta.id);
  const two = prepareArchive(work.root, work.parent.meta.id);
  const remote = github();
  publishArchive(work.root, one.snapshot_id, { request: remote.request });
  assert.throws(
    () => publishArchive(work.root, two.snapshot_id, { request: remote.request }),
    /Immutable archive release/,
  );
  const frozen = prepareArchive(work.root, work.parent.meta.id, { disposition: 'working' });
  assert.throws(
    () => publishArchive(work.root, frozen.snapshot_id, { request: remote.request }),
    /frozen/,
  );
});
test('working checkpoints append commits and accepted commit preserves their ancestry', (t) => {
  const work = fixture(t);
  const remote = github();
  const first = prepareArchive(work.root, work.parent.meta.id, { disposition: 'working' });
  const firstState = publishArchive(work.root, first.snapshot_id, { request: remote.request });
  const second = prepareArchive(work.root, work.parent.meta.id, { disposition: 'working' });
  const secondState = publishArchive(work.root, second.snapshot_id, { request: remote.request });
  assert.ok(remote.payloads.get(secondState.commit).parents.includes(firstState.commit));
  const final = prepareArchive(work.root, work.parent.meta.id);
  const finalState = publishArchive(work.root, final.snapshot_id, { request: remote.request });
  assert.ok(remote.payloads.get(finalState.commit).parents.includes(secondState.commit));
});
test('frozen workspace corruption and added membership are rejected by status and restore', (t) => {
  const work = fixture(t);
  const snapshot = prepareArchive(work.root, work.parent.meta.id);
  writeFileSync(join(work.root, snapshot.path, 'workspace/extra.md'), 'Undeclared file.');
  assert.throws(() => archiveStatus(work.root, snapshot.snapshot_id), /membership/);
  assert.throws(() => restoreArchive(work.root, snapshot.snapshot_id, work.restore), /membership/);
  assert.equal(existsSync(work.restore), false);
});

test('restore recovers a known published baseline without rewriting frozen configuration', (t) => {
  const work = fixture(t);
  const snapshot = prepareArchive(work.root, work.parent.meta.id);
  const remote = github();
  const publication = publishArchive(work.root, snapshot.snapshot_id, { request: remote.request });
  const result = restoreArchive(work.root, snapshot.snapshot_id, work.restore);
  assert.equal(result.reconciliation, 'published-baseline-restored');
  assert.deepEqual(
    readFileSync(join(work.restore, '.verythinker/archive.json')),
    readFileSync(join(work.root, snapshot.path, 'workspace/.verythinker/archive.json')),
  );
  const policy = readArchivePolicy(work.restore);
  assert.equal(policy.baseline_commit, publication.commit);
  assert.equal(policy.last_release, '1.0.0');
  assert.equal(policy.last_snapshot_id, snapshot.snapshot_id);
  const recovered = acceptedArchiveForWorkflow(work.restore, work.parent.meta.id);
  assert.equal(recovered.publication.commit, publication.commit);
  assert.equal(recovered.derived, true);
  createRecord(work.restore, {
    type: 'knowledge',
    title: 'Unrelated learning record',
    body: 'Independent source reading unrelated to this delivered increment.',
  });
  assert.equal(
    acceptedArchiveForWorkflow(work.restore, work.parent.meta.id).publication.commit,
    publication.commit,
  );
  const followUp = nextIncrement(work, work.restore);
  const resumed = prepareArchive(work.restore, followUp.meta.id);
  assert.equal(resumed.manifest.captured_baseline, publication.commit);
  assert.equal(resumed.manifest.release, '1.0.1');
  assert.equal(
    publishArchive(work.restore, resumed.snapshot_id, { request: remote.request }).status,
    'completed',
  );
  assert.equal(readArchivePolicy(work.restore).last_release, '1.0.1');
});

test('accepted archive replay rejects changed implementation and workflow contracts', (t) => {
  const work = fixture(t);
  const snapshot = prepareArchive(work.root, work.parent.meta.id);
  const remote = github();
  const publication = publishArchive(work.root, snapshot.snapshot_id, { request: remote.request });
  assert.equal(
    acceptedArchiveForWorkflow(work.root, work.parent.meta.id).publication.commit,
    publication.commit,
  );
  writeFileSync(
    join(work.root, 'src/value.mjs'),
    'export const value = 1; // reassessed implementation\n',
  );
  assert.throws(
    () => acceptedArchiveForWorkflow(work.root, work.parent.meta.id),
    /implementation, evidence, or lock changed/,
  );
  writeFileSync(join(work.root, 'src/value.mjs'), 'export const value = 1;\n');
  updateRecord(work.root, work.parent.meta.id, { data: { change_type: 'fix' } });
  assert.throws(
    () => acceptedArchiveForWorkflow(work.root, work.parent.meta.id),
    /workflow contract changed/,
  );
});

test('a reviewed subsequent increment preserves deletions and patch SemVer history', (t) => {
  const work = fixture(t);
  const first = prepareArchive(work.root, work.parent.meta.id);
  const remote = github();
  publishArchive(work.root, first.snapshot_id, { request: remote.request });
  rmSync(join(work.root, 'src/image.bin'));
  const followUp = nextIncrement(work, work.root, ['src/value.mjs']);
  const second = prepareArchive(work.root, followUp.meta.id);
  assert.equal(second.manifest.release, '1.0.1');
  assert.ok(second.manifest.deleted_paths.includes('src/image.bin'));
  const state = publishArchive(work.root, second.snapshot_id, { request: remote.request });
  const tree = remote.calls.filter((call) => call.endpoint.endsWith('/git/trees')).at(-1).body.tree;
  assert.ok(
    tree.some(
      (entry) => entry.path === 'projects/ARCHIVE/workspace/src/image.bin' && entry.sha === null,
    ),
  );
  assert.equal(readArchivePolicy(work.root).last_release, '1.0.1');
  assert.equal(
    remote.branches.get(`${first.manifest.namespace}/releases/1.0.0`),
    remote.payloads.has(state.commit)
      ? remote.calls.find((call) => call.body?.ref?.endsWith('/releases/1.0.0')).body.sha
      : null,
  );
});

function reassessment(work, snapshot, reviewed = true) {
  const reason =
    'Reassess the unpublished snapshot after reviewed source and archive baseline changes.';
  const change = createRecord(work.root, {
    type: 'change',
    title: 'Reassess pending archive',
    owner: 'manager',
    links: [{ type: 'references', target: work.parent.meta.id }],
    data: { archive_snapshot_id: snapshot.snapshot_id, reason },
  });
  if (reviewed)
    reviewRecord(
      work.root,
      change.meta.id,
      'reviewer',
      'pass',
      [],
      'reassessment-reviewer-fixture',
    );
  mkdirSync(join(work.root, '.verythinker/archive-intents'), { recursive: true });
  const intentPath = join(
    work.root,
    `.verythinker/archive-intents/${hash(work.parent.meta.id)}.json`,
  );
  writeFileSync(
    intentPath,
    JSON.stringify(
      {
        workflow_id: work.parent.meta.id,
        snapshot_id: snapshot.snapshot_id,
        report_id: 'stable-report-reference',
      },
      null,
      2,
    ) + '\n',
  );
  return { change, reason, intentPath };
}

test('reviewed public-target recovery retires only a never-started intent and preserves its frozen history', (t) => {
  const work = fixture(t);
  const snapshot = prepareArchive(work.root, work.parent.meta.id);
  const publicRemote = github({ privateRepo: false });
  assert.throws(
    () => publishArchive(work.root, snapshot.snapshot_id, { request: publicRemote.request }),
    /confirmed private/,
  );
  const publicationPath = join(work.root, snapshot.path, 'publication.json');
  assert.equal(existsSync(publicationPath), false);
  const approval = reassessment(work, snapshot, false);
  const originalManifest = readFileSync(join(work.root, snapshot.path, 'manifest.json'));
  assert.throws(
    () =>
      reassessArchive(work.root, work.parent.meta.id, {
        change_id: approval.change.meta.id,
        reason: approval.reason,
        request: publicRemote.request,
      }),
    /current independent review/,
  );
  reviewRecord(
    work.root,
    approval.change.meta.id,
    'reviewer',
    'pass',
    [],
    'public-recovery-reviewer',
  );
  const result = reassessArchive(work.root, work.parent.meta.id, {
    change_id: approval.change.meta.id,
    reason: approval.reason,
    request: publicRemote.request,
  });
  assert.equal(result.status, 'ready-for-fresh-preparation');
  assert.equal(result.retired_snapshot_id, snapshot.snapshot_id);
  assert.deepEqual(readFileSync(join(work.root, snapshot.path, 'manifest.json')), originalManifest);
  assert.equal(existsSync(publicationPath), false);
  const intent = JSON.parse(readFileSync(approval.intentPath));
  assert.equal(intent.snapshot_id, undefined);
  assert.equal(intent.report_id, 'stable-report-reference');
  assert.equal(intent.reassessment_id, result.reassessment_id);
  assert.equal(
    publicRemote.calls.every((call) => call.method === 'GET'),
    true,
  );
  const policy = readArchivePolicy(work.root);
  writeFileSync(
    join(work.root, '.verythinker/archive.json'),
    JSON.stringify(
      {
        ...policy,
        repository: 'example/new-private',
      },
      null,
      2,
    ) + '\n',
  );
  const next = prepareArchive(work.root, work.parent.meta.id);
  assert.notEqual(next.snapshot_id, snapshot.snapshot_id);
  assert.equal(next.manifest.repository, 'example/new-private');
  assert.deepEqual(readFileSync(join(work.root, snapshot.path, 'manifest.json')), originalManifest);
});

test('public-target recovery rejects every publication stage and any managed project reference', (t) => {
  const work = fixture(t);
  const snapshot = prepareArchive(work.root, work.parent.meta.id);
  const approval = reassessment(work, snapshot);
  const publicRemote = github({ privateRepo: false });
  const originalIntent = readFileSync(approval.intentPath);
  const publicationPath = join(work.root, snapshot.path, 'publication.json');
  for (const status of [
    'planned',
    'blobs-created',
    'tree-created',
    'commit-created',
    'baseline-advanced',
    'release-created',
    'completed',
  ]) {
    const state = {
      schema_version: 1,
      snapshot_id: snapshot.snapshot_id,
      manifest_hash: snapshot.manifest_hash,
      repository: snapshot.manifest.repository,
      status,
      blobs: {},
    };
    writeFileSync(publicationPath, JSON.stringify(state, null, 2) + '\n');
    assert.throws(
      () =>
        reassessArchive(work.root, work.parent.meta.id, {
          change_id: approval.change.meta.id,
          reason: approval.reason,
          request: publicRemote.request,
        }),
      /never-started snapshot/,
      status,
    );
    assert.deepEqual(readFileSync(approval.intentPath), originalIntent);
    assert.deepEqual(JSON.parse(readFileSync(publicationPath)), state);
  }
  // A malformed-but-present receipt must not count as proof that publication never started.
  writeFileSync(publicationPath, 'null\n');
  assert.throws(
    () =>
      reassessArchive(work.root, work.parent.meta.id, {
        change_id: approval.change.meta.id,
        reason: approval.reason,
        request: publicRemote.request,
      }),
    /never-started snapshot/,
  );
  rmSync(publicationPath);
  for (const branch of [
    `${snapshot.manifest.namespace}/baseline`,
    `${snapshot.manifest.namespace}/releases/${snapshot.manifest.release}`,
    `${snapshot.manifest.namespace}/increments/${snapshot.manifest.increment_id}`,
  ]) {
    publicRemote.branches.set(branch, 'some-existing-project-history');
    assert.throws(
      () =>
        reassessArchive(work.root, work.parent.meta.id, {
          change_id: approval.change.meta.id,
          reason: approval.reason,
          request: publicRemote.request,
        }),
      /never-started snapshot/,
      branch,
    );
    assert.deepEqual(readFileSync(approval.intentPath), originalIntent);
    publicRemote.branches.delete(branch);
  }
  assert.equal(existsSync(join(work.root, '.verythinker/archive-reassessments')), false);
  assert.equal(
    publicRemote.calls.every((call) => call.method === 'GET'),
    true,
  );
});

test('reviewed archive reassessment retires stale unpublished intent and preserves its history/report identity', (t) => {
  const work = fixture(t);
  const snapshot = prepareArchive(work.root, work.parent.meta.id);
  const remote = github();
  const approval = reassessment(work, snapshot);
  writeFileSync(
    join(work.root, 'src/value.mjs'),
    'export const value = 1; // reviewed local change\n',
  );
  assert.throws(
    () => publishArchive(work.root, snapshot.snapshot_id, { request: remote.request }),
    /input changed/,
  );
  const original = readFileSync(join(work.root, snapshot.path, 'manifest.json'));
  const result = reassessArchive(work.root, work.parent.meta.id, {
    change_id: approval.change.meta.id,
    reason: approval.reason,
    request: remote.request,
  });
  assert.equal(result.status, 'ready-for-fresh-preparation');
  assert.equal(result.retired_snapshot_id, snapshot.snapshot_id);
  assert.deepEqual(readFileSync(join(work.root, snapshot.path, 'manifest.json')), original);
  assert.ok(existsSync(join(work.root, snapshot.path, 'publication.json')));
  const intent = JSON.parse(readFileSync(approval.intentPath));
  assert.equal(intent.snapshot_id, undefined);
  assert.equal(intent.report_id, 'stable-report-reference');
  assert.equal(intent.reassessment_id, result.reassessment_id);
  assert.equal(
    reassessArchive(work.root, work.parent.meta.id, {
      change_id: approval.change.meta.id,
      reason: approval.reason,
      request: remote.request,
    }).reassessment_id,
    result.reassessment_id,
  );
  assert.throws(() => prepareArchive(work.root, work.parent.meta.id), /gate failed/);
  updateRecord(work.root, work.task.meta.id, { status: 'draft' });
  startTask(work.root, work.task.meta.id, undefined, undefined, 'worker-reassessment-fixture');
  archiveEvidence(work.root, runCheck(work.root, work.check.meta.id, work.task.meta.id).meta.id);
  submitTask(
    work.root,
    work.task.meta.id,
    'Revalidated the reviewed implementation after retiring its stale archive intent.',
  );
  reviewTask(work.root, work.task.meta.id, 'reviewer', 'pass', [], 'reviewer-reassessment-fixture');
  assert.notEqual(prepareArchive(work.root, work.parent.meta.id).snapshot_id, snapshot.snapshot_id);
});

test('unreviewed reassessment and an already accepted remote archive cannot retire an intent', (t) => {
  const work = fixture(t);
  const snapshot = prepareArchive(work.root, work.parent.meta.id);
  const remote = github();
  const approval = reassessment(work, snapshot, false);
  assert.throws(
    () =>
      reassessArchive(work.root, work.parent.meta.id, {
        change_id: approval.change.meta.id,
        reason: approval.reason,
        request: remote.request,
      }),
    /current independent review/,
  );
  reviewRecord(
    work.root,
    approval.change.meta.id,
    'reviewer',
    'pass',
    [],
    'reviewer-reassessment-fixture',
  );
  // Preserve source identity so this separate snapshot can actually publish.
  const acceptedSnapshot = prepareArchive(work.root, work.parent.meta.id);
  publishArchive(work.root, acceptedSnapshot.snapshot_id, { request: remote.request });
  const acceptedApproval = reassessment(work, acceptedSnapshot);
  assert.throws(
    () =>
      reassessArchive(work.root, work.parent.meta.id, {
        change_id: acceptedApproval.change.meta.id,
        reason: acceptedApproval.reason,
        request: remote.request,
      }),
    /refs or publication history are frozen/,
  );
  assert.equal(
    JSON.parse(readFileSync(acceptedApproval.intentPath)).snapshot_id,
    acceptedSnapshot.snapshot_id,
  );
});

test('unknown remote archive baseline records an integration blocker without discarding the intent', (t) => {
  const work = fixture(t);
  const snapshot = prepareArchive(work.root, work.parent.meta.id);
  const remote = github();
  remote.branches.set(`${snapshot.manifest.namespace}/baseline`, 'unknown-remote-commit');
  const approval = reassessment(work, snapshot);
  const result = reassessArchive(work.root, work.parent.meta.id, {
    change_id: approval.change.meta.id,
    reason: approval.reason,
    request: remote.request,
  });
  assert.equal(result.status, 'integration-required');
  assert.equal(result.retired_snapshot_id, null);
  assert.match(result.blocker, /no verified completed snapshot in the local cache/);
  assert.equal(JSON.parse(readFileSync(approval.intentPath)).snapshot_id, snapshot.snapshot_id);
  assert.equal(
    remote.calls.some((call) => call.method !== 'GET'),
    false,
  );
});

test('known completed remote baseline is reconciled before fresh preparation', (t) => {
  const work = fixture(t);
  const pending = prepareArchive(work.root, work.parent.meta.id);
  const before = readFileSync(join(work.root, '.verythinker/archive.json'));
  const next = nextIncrement(work);
  const completed = prepareArchive(work.root, next.meta.id);
  const remote = github();
  const publication = publishArchive(work.root, completed.snapshot_id, { request: remote.request });
  // Simulate the local metadata write being missing while the completed cache and remote refs remain durable.
  writeFileSync(join(work.root, '.verythinker/archive.json'), before);
  const approval = reassessment(work, pending);
  const result = reassessArchive(work.root, work.parent.meta.id, {
    change_id: approval.change.meta.id,
    reason: approval.reason,
    request: remote.request,
  });
  assert.equal(result.status, 'ready-for-fresh-preparation');
  assert.equal(result.reconciled_snapshot_id, completed.snapshot_id);
  assert.equal(readArchivePolicy(work.root).baseline_commit, publication.commit);
  assert.equal(readArchivePolicy(work.root).last_release, '1.0.0');
  const fresh = prepareArchive(work.root, work.parent.meta.id);
  assert.equal(fresh.manifest.captured_baseline, publication.commit);
  assert.equal(fresh.manifest.release, '1.1.0');
});

test('archive includes hash-locked provider dependencies and rejects mutated lock content', (t) => {
  const work = fixture(t);
  mkdirSync(join(work.root, '.verythinker/tool-locks'));
  const path = '.verythinker/tool-locks/context7-4.3.0.json';
  const lock =
    JSON.stringify(
      {
        lockfileVersion: 3,
        packages: {
          'node_modules/@upstash/context7-mcp': {
            version: '4.3.0',
            integrity: 'fixture-pinned-integrity',
          },
        },
      },
      null,
      2,
    ) + '\n';
  writeFileSync(join(work.root, path), lock);
  writeFileSync(
    join(work.root, '.verythinker/tool-lock.json'),
    JSON.stringify(
      {
        schema_version: 1,
        providers: [
          {
            id: 'context7',
            version: '4.3.0',
            dependency_lock_path: path,
            dependency_lock_hash: hash(lock),
          },
        ],
      },
      null,
      2,
    ) + '\n',
  );
  const snapshot = prepareArchive(work.root, work.parent.meta.id);
  assert.ok(snapshot.manifest.files.some((file) => file.path === path));
  restoreArchive(work.root, snapshot.snapshot_id, work.restore);
  assert.equal(readFileSync(join(work.restore, path), 'utf8'), lock);
  writeFileSync(join(work.root, path), lock + '\n');
  assert.throws(
    () => prepareArchive(work.root, work.parent.meta.id),
    /dependency lock is missing or changed/,
  );
});

test('strict archive preparation and publication reject unfinished manager and undocumented assignments', (t) => {
  const work = fixture(t);
  const snapshot = prepareArchive(work.root, work.parent.meta.id);
  const remote = github();
  ensureRoutingPolicy(work.root);
  updateRecord(work.root, work.parent.meta.id, { data: { routing_required: true } });
  for (const action of [
    () => prepareArchive(work.root, work.parent.meta.id),
    () => publishArchive(work.root, snapshot.snapshot_id, { request: remote.request }),
  ])
    assert.throws(action, /requires a bridge-issued native invocation receipt/);
  const running = validationReceiptFixture(work, 'manager', 'running');
  updateRecord(work.root, work.parent.meta.id, { data: { invocation_id: running.id } });
  assert.throws(
    () => prepareArchive(work.root, work.parent.meta.id),
    /Native inference has not completed successfully/,
  );
  assert.throws(
    () => publishArchive(work.root, snapshot.snapshot_id, { request: remote.request }),
    /Native inference has not completed successfully/,
  );
  const completed = validationReceiptFixture(work, 'manager');
  updateRecord(work.root, work.parent.meta.id, { data: { invocation_id: completed.id } });
  const research = validationReceiptFixture(work, 'researcher');
  assert.throws(
    () => prepareArchive(work.root, work.parent.meta.id),
    /Completed researcher invocation .* needs its seven-section assignment report/,
  );
  const headings = [
    'Objective',
    'Inputs and Sources',
    'Decisions and Rationale',
    'Results',
    'Evidence',
    'Limitations',
    'Lessons',
  ];
  createRecord(work.root, {
    type: 'knowledge',
    title: 'Incomplete fabricated research report',
    owner: 'researcher',
    data: {
      kind: 'work-record',
      workflow_id: work.parent.meta.id,
      invocation_id: research.id,
    },
    body: headings.map((heading) => `# ${heading}\n`).join('\n'),
  });
  assert.throws(
    () => publishArchive(work.root, snapshot.snapshot_id, { request: remote.request }),
    /Completed researcher invocation .* needs its seven-section assignment report/,
  );
  assert.equal(
    remote.calls.some((call) => call.method !== 'GET'),
    false,
  );
});

test('installed routing blocks direct archive acceptance of unmigrated pending work and preserves closed legacy history', (t) => {
  const work = fixture(t);
  const historicalReport = createRecord(work.root, {
    type: 'knowledge',
    title: 'Recorded legacy manager report fixture',
    owner: 'manager',
    data: { kind: 'work-record', workflow_id: work.parent.meta.id },
    links: [{ type: 'documents', target: work.parent.meta.id }],
    body: '# Objective\nLegacy metadata fixture; it establishes no authenticated native model access.\n',
  });
  const pending = prepareArchive(work.root, work.parent.meta.id);
  ensureRoutingPolicy(work.root);
  const remote = github();
  assert.throws(
    () => prepareArchive(work.root, work.parent.meta.id),
    /Pending legacy workflow requires alpha.3 migration/,
  );
  assert.throws(
    () => publishArchive(work.root, pending.snapshot_id, { request: remote.request }),
    /Pending legacy workflow requires alpha.3 migration/,
  );
  assert.equal(
    remote.calls.some((call) => call.method !== 'GET'),
    false,
  );
  // Model-observation history remains qualified as legacy. It is not converted
  // into authenticated Sol routing by adding the installation policy.
  updateRecord(work.root, work.parent.meta.id, {
    data: { phase: 'completed', final_report_id: historicalReport.meta.id },
  });
  const originals = [work.parent.path, work.task.path, historicalReport.path].map((path) => ({
    path,
    bytes: readFileSync(join(work.root, path)),
  }));
  const closed = prepareArchive(work.root, work.parent.meta.id);
  assert.equal(closed.manifest.disposition, 'accepted');
  assert.notEqual(getRecord(work.root, work.parent.meta.id).meta.data.routing_required, true);
  for (const original of originals)
    assert.deepEqual(readFileSync(join(work.root, original.path)), original.bytes);
});

test('a new increment rejects unrelated historical edits and admits intentional reviewed source changes', (t) => {
  const work = fixture(t);
  const remote = github();
  const first = prepareArchive(work.root, work.parent.meta.id);
  publishArchive(work.root, first.snapshot_id, { request: remote.request });
  mkdirSync(join(work.root, 'src/new-feature'));
  writeFileSync(join(work.root, 'src/new-feature/value.mjs'), 'export const value = 2;\n');
  const requirement = createRecord(work.root, {
    type: 'requirement',
    title: 'Export a second independently scoped integer',
    data: { acceptance_criteria: ['The new feature exports integer two.'] },
  });
  const parent = createRecord(work.root, {
    type: 'knowledge',
    title: 'Deliver the independent feature',
    data: {
      kind: 'manager-workflow',
      increment_id: randomUUID(),
      requirement_id: requirement.meta.id,
      requirement_ids: [requirement.meta.id],
      change_type: 'feature',
      task_ids: [],
      open_questions: [],
    },
    links: [{ type: 'documents', target: requirement.meta.id }],
  });
  const task = createRecord(work.root, {
    type: 'task',
    title: 'Implement the independent feature',
    owner: 'developer',
    links: [{ type: 'satisfies', target: requirement.meta.id }],
    data: {
      workflow_id: parent.meta.id,
      acceptance_criteria: ['Export integer two.'],
      allowed_paths: ['src/new-feature'],
      outputs: ['src/new-feature/value.mjs'],
    },
  });
  const check = createRecord(work.root, {
    type: 'check',
    title: 'Verify the independent feature',
    links: [{ type: 'verifies', target: requirement.meta.id }],
    data: {
      command: [
        process.execPath,
        '--input-type=module',
        '-e',
        'import {value} from "./src/new-feature/value.mjs"; if(value!==2) process.exit(1)',
      ],
      baseline_paths: ['src/new-feature'],
    },
  });
  const complete = (invocation) => {
    startTask(work.root, task.meta.id, undefined, undefined, invocation);
    archiveEvidence(work.root, runCheck(work.root, check.meta.id, task.meta.id).meta.id);
    submitTask(work.root, task.meta.id, 'Delivered and checked the independent integer feature.');
    reviewTask(work.root, task.meta.id, 'reviewer', 'pass', [], `${invocation}-reviewer`);
  };
  complete('worker-independent-fixture');
  const decision = createRecord(work.root, {
    type: 'knowledge',
    title: 'Independent feature scope decision',
    links: [{ type: 'documents', target: parent.meta.id }],
    data: {
      kind: 'manager-decision',
      workflow_id: parent.meta.id,
      requirement_baseline: { [requirement.meta.id]: recordFingerprint(requirement) },
    },
  });
  updateRecord(work.root, parent.meta.id, {
    data: { task_ids: [task.meta.id], decision_id: decision.meta.id },
  });
  // Another active increment sharing the original requirement must stay outside
  // both forward/reverse closure, including its review and source outputs.
  const unrelatedTask = createRecord(work.root, {
    type: 'task',
    title: 'Unrelated concurrent assignment',
    links: [{ type: 'satisfies', target: requirement.meta.id }],
    data: { workflow_id: 'other-increment', outputs: ['unrelated-secret.txt'] },
  });
  createRecord(work.root, {
    type: 'review',
    title: 'Unrelated concurrent review',
    links: [
      { type: 'reviews', target: requirement.meta.id },
      { type: 'reviews', target: unrelatedTask.meta.id },
    ],
    data: { workflow_id: 'other-increment', task_id: unrelatedTask.meta.id },
  });
  createRecord(work.root, {
    type: 'knowledge',
    title: 'Unbound documentation belonging to another active task',
    links: [
      { type: 'documents', target: requirement.meta.id },
      { type: 'documents', target: unrelatedTask.meta.id },
    ],
  });
  const clean = prepareArchive(work.root, parent.meta.id);
  assert.ok(!clean.manifest.records.some((record) => record.id === unrelatedTask.meta.id));
  const originalSource = readFileSync(join(work.root, 'src/value.mjs'), 'utf8');
  const changedSource = originalSource + '// unrelated active edit before explicit scope review\n';
  writeFileSync(join(work.root, 'src/value.mjs'), changedSource);
  assert.equal(verify(work.root, task.meta.id, 'accepted').ok, true);
  assert.throws(
    () => prepareArchive(work.root, parent.meta.id),
    /Historical archive input changed outside this increment.*src\/value.mjs/,
  );
  writeFileSync(join(work.root, 'src/value.mjs'), originalSource);
  const historicalWork = getRecord(
    work.root,
    work.task.meta.data.submission?.work_record_id ??
      getRecord(work.root, work.task.meta.id).meta.data.submission.work_record_id,
  );
  const originalBody = historicalWork.body;
  updateRecord(
    work.root,
    historicalWork.meta.id,
    {},
    originalBody + '\nUnrelated historical narrative edit.\n',
  );
  assert.throws(
    () => prepareArchive(work.root, parent.meta.id),
    /Historical archive engineering record changed outside this increment/,
  );
  updateRecord(work.root, historicalWork.meta.id, {}, originalBody);
  writeFileSync(join(work.root, 'src/value.mjs'), changedSource);
  updateRecord(work.root, task.meta.id, {
    status: 'draft',
    data: {
      allowed_paths: ['src/new-feature', 'src/value.mjs'],
      outputs: ['src/new-feature/value.mjs', 'src/value.mjs'],
    },
  });
  updateRecord(work.root, check.meta.id, {
    data: { baseline_paths: ['src/new-feature', 'src/value.mjs'] },
  });
  complete('worker-scoped-follow-up-fixture');
  const accepted = prepareArchive(work.root, parent.meta.id);
  assert.equal(
    accepted.manifest.files.find((file) => file.path === 'src/value.mjs').hash,
    hash(changedSource),
  );
  assert.equal(
    readFileSync(join(work.root, first.path, 'workspace/src/value.mjs'), 'utf8'),
    originalSource,
  );
});

test('failed checks and repaired checks retain original input versions including deleted binary inputs', (t) => {
  const work = fixture(t);
  const failedSource = 'export const value = 0;\n';
  const repairedSource = 'export const value = 1; // repaired after observed failing check\n';
  const obsolete = Buffer.from([0, 255, 13, 0, 129]);
  writeFileSync(join(work.root, 'src/value.mjs'), failedSource);
  writeFileSync(join(work.root, 'src/obsolete.bin'), obsolete);
  updateRecord(work.root, work.task.meta.id, { status: 'draft' });
  startTask(work.root, work.task.meta.id, undefined, undefined, 'worker-repair-input-fixture');
  const failed = archiveEvidence(
    work.root,
    runCheck(work.root, work.check.meta.id, work.task.meta.id).meta.id,
  );
  assert.equal(failed.meta.data.result, 'fail');
  writeFileSync(join(work.root, 'src/value.mjs'), repairedSource);
  rmSync(join(work.root, 'src/obsolete.bin'));
  const passed = archiveEvidence(
    work.root,
    runCheck(work.root, work.check.meta.id, work.task.meta.id).meta.id,
  );
  assert.equal(passed.meta.data.result, 'pass');
  submitTask(
    work.root,
    work.task.meta.id,
    'Repaired the observed integer mismatch and checked the unchanged integer-one oracle.',
  );
  reviewTask(work.root, work.task.meta.id, 'reviewer', 'pass', [], 'reviewer-repair-input-fixture');
  const failedRecordBytes = readFileSync(join(work.root, failed.path));
  const snapshot = prepareArchive(work.root, work.parent.meta.id);
  const oldInputs = validateEvidenceInputs(
    work.root,
    snapshot.manifest.evidence_inputs[failed.meta.id],
  );
  const newInputs = validateEvidenceInputs(
    work.root,
    snapshot.manifest.evidence_inputs[passed.meta.id],
  );
  assert.equal(
    readFileSync(join(work.root, oldInputs.files['src/value.mjs'].blob_path), 'utf8'),
    failedSource,
  );
  assert.equal(
    readFileSync(join(work.root, newInputs.files['src/value.mjs'].blob_path), 'utf8'),
    repairedSource,
  );
  assert.deepEqual(
    readFileSync(join(work.root, oldInputs.files['src/obsolete.bin'].blob_path)),
    obsolete,
  );
  assert.equal(newInputs.files['src/obsolete.bin'], undefined);
  assert.equal(
    snapshot.manifest.files.some((file) => file.path === 'src/obsolete.bin'),
    false,
  );
  assert.deepEqual(readFileSync(join(work.root, failed.path)), failedRecordBytes);
  restoreArchive(work.root, snapshot.snapshot_id, work.restore);
  assert.equal(verify(work.restore, work.task.meta.id, 'accepted').ok, true);
  const restored = validateEvidenceInputs(
    work.restore,
    snapshot.manifest.evidence_inputs[failed.meta.id],
  );
  assert.deepEqual(
    readFileSync(join(work.restore, restored.files['src/obsolete.bin'].blob_path)),
    obsolete,
  );
  // Stale failed evidence is not used for current acceptance, but its historical
  // inputs remain mandatory export artifacts and cannot be silently replaced.
  writeFileSync(join(work.root, oldInputs.files['src/obsolete.bin'].blob_path), 'tampered input');
  assert.equal(verify(work.root, work.task.meta.id, 'accepted').ok, true);
  assert.throws(() => prepareArchive(work.root, work.parent.meta.id), /missing or modified/);
});

test('legacy archive evidence recovers verified cached input bytes or reports its exact missing baseline', (t) => {
  const work = fixture(t);
  // Simulate an alpha.2 receipt that predates immutable input capture.
  const original = getRecord(work.root, work.evidence.meta.id);
  updateRecord(work.root, original.meta.id, { data: { input_snapshot: null } });
  reviewTask(work.root, work.task.meta.id, 'reviewer', 'pass', [], 'reviewer-legacy-input-fixture');
  const cache = prepareArchive(work.root, work.parent.meta.id, { disposition: 'working' });
  const legacyBytes = readFileSync(join(work.root, original.path));
  const changed = 'export const value = 1; // later implementation revision\n';
  writeFileSync(join(work.root, 'src/value.mjs'), changed);
  updateRecord(work.root, work.task.meta.id, { status: 'draft' });
  startTask(work.root, work.task.meta.id, undefined, undefined, 'worker-new-input-fixture');
  archiveEvidence(work.root, runCheck(work.root, work.check.meta.id, work.task.meta.id).meta.id);
  submitTask(
    work.root,
    work.task.meta.id,
    'Verified the later implementation against its fresh baseline.',
  );
  reviewTask(work.root, work.task.meta.id, 'reviewer', 'pass', [], 'reviewer-new-input-fixture');
  const recovered = prepareArchive(work.root, work.parent.meta.id);
  const inputs = validateEvidenceInputs(
    work.root,
    recovered.manifest.evidence_inputs[original.meta.id],
  );
  assert.equal(inputs.provenance, 'legacy-recovered');
  assert.equal(
    readFileSync(join(work.root, inputs.files['src/value.mjs'].blob_path), 'utf8'),
    'export const value = 1;\n',
  );
  assert.deepEqual(readFileSync(join(work.root, original.path)), legacyBytes);
  assert.equal(
    recovered.manifest.records.find((record) => record.id === original.meta.id).fingerprint,
    recordFingerprint(getRecord(work.root, original.meta.id)),
  );
  const missing = fixture(t);
  updateRecord(missing.root, missing.evidence.meta.id, { data: { input_snapshot: null } });
  const missingHash = missing.evidence.meta.data.file_baseline['src/value.mjs'];
  rmSync(join(missing.root, `.verythinker/evidence/inputs/blobs/${missingHash}`));
  writeFileSync(join(missing.root, 'src/value.mjs'), changed);
  updateRecord(missing.root, missing.task.meta.id, { status: 'draft' });
  startTask(
    missing.root,
    missing.task.meta.id,
    undefined,
    undefined,
    'worker-missing-input-fixture',
  );
  archiveEvidence(
    missing.root,
    runCheck(missing.root, missing.check.meta.id, missing.task.meta.id).meta.id,
  );
  submitTask(
    missing.root,
    missing.task.meta.id,
    'Verified the current implementation without fabricating old source bytes.',
  );
  reviewTask(
    missing.root,
    missing.task.meta.id,
    'reviewer',
    'pass',
    [],
    'reviewer-missing-input-fixture',
  );
  assert.throws(
    () => prepareArchive(missing.root, missing.parent.meta.id),
    (error) =>
      error.message.includes('missing original input src/value.mjs') &&
      error.message.includes(missingHash),
  );
  assert.ok(existsSync(join(work.root, cache.path, 'manifest.json')));
});

test('deleted sensitive original paths cannot hide inside hash-named evidence blobs', (t) => {
  const work = fixture(t);
  writeFileSync(join(work.root, '.env'), 'LOCAL_MODE=sample\n');
  updateRecord(work.root, work.task.meta.id, { status: 'draft' });
  startTask(work.root, work.task.meta.id, undefined, undefined, 'worker-original-path-fixture');
  updateRecord(work.root, work.check.meta.id, { data: { baseline_paths: ['src', '.env'] } });
  archiveEvidence(work.root, runCheck(work.root, work.check.meta.id, work.task.meta.id).meta.id);
  rmSync(join(work.root, '.env'));
  updateRecord(work.root, work.check.meta.id, { data: { baseline_paths: ['src'] } });
  archiveEvidence(work.root, runCheck(work.root, work.check.meta.id, work.task.meta.id).meta.id);
  submitTask(
    work.root,
    work.task.meta.id,
    'Verified the current bounded source without exporting private input paths.',
  );
  reviewTask(
    work.root,
    work.task.meta.id,
    'reviewer',
    'pass',
    [],
    'reviewer-original-path-fixture',
  );
  assert.equal(verify(work.root, work.task.meta.id, 'accepted').ok, true);
  assert.throws(
    () => prepareArchive(work.root, work.parent.meta.id),
    /sensitive original input: \.env/,
  );
});
