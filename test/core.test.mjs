import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  renameSync,
  copyFileSync,
  cpSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  initialize,
  createRecord,
  updateRecord,
  getRecord,
  loadRecords,
  rebuildIndex,
  ensureIndex,
  searchMemory,
  traceRecord,
  contextPacket,
  verify,
  startTask,
  resumeTask,
  requestRepair,
  submitTask,
  runCheck,
  archiveEvidence,
  reviewTask,
  reviewRecord,
  acceptTask,
  installPack,
  listPacks,
  prepareContribution,
  submitContribution,
  resourceRoot,
} from '../dist/index.js';

test('the worker limit prevents a fourth active assignment', (t) => {
  const root = project(t);
  const work = [assignment(root), assignment(root), assignment(root), assignment(root)];
  for (const item of work.slice(0, 3)) startTask(root, item.task.meta.id);
  assert.throws(() => startTask(root, work[3].task.meta.id), /worker limit/);
  assert.equal(
    loadRecords(root).filter((record) => record.meta.status === 'in-progress').length,
    3,
  );
});

test('locked pack upgrades require a current reviewed owner decision and invalidate prior evidence', (t) => {
  const root = project(t);
  const work = assignment(root);
  installPack(root, 'engineering-basics@0.1.0');
  submitted(root, work);
  const source = mkdtempSync(join(tmpdir(), 'verythinker-pack-upgrade-'));
  t.after(() => rmSync(source, { recursive: true, force: true }));
  cpSync(join(resourceRoot, 'packs/engineering-basics'), source, { recursive: true });
  const manifest = JSON.parse(readFileSync(join(source, 'pack.json'), 'utf8'));
  manifest.version = '0.2.0';
  writeFileSync(join(source, 'pack.json'), JSON.stringify(manifest));
  assert.throws(() => installPack(root, source), /reviewed/);
  const decision = createRecord(root, {
    type: 'change',
    title: 'Upgrade engineering pack',
    owner: 'manager',
    data: {
      pack_id: 'engineering-basics',
      from_version: '0.1.0',
      to_version: '0.2.0',
      reason: 'Use reviewed new guidance.',
      approved_by: 'project-owner',
    },
  });
  assert.throws(() => installPack(root, source, decision.meta.id), /current reviewed/);
  reviewRecord(root, decision.meta.id, 'reviewer', 'pass');
  assert.equal(installPack(root, source, decision.meta.id).version, '0.2.0');
  assert.equal(verify(root, work.task.meta.id, 'verified').ok, false);
});

test('failed upstream PR creation resumes its persisted branch without duplicate commits', (t) => {
  const root = project(t);
  const knowledge = createRecord(root, {
    type: 'knowledge',
    title: 'Recoverable proposal',
    owner: 'curator',
    data: {
      generalization: 'Validate before persistence.',
      applicability: ['Stores.'],
      provenance: ['https://nodejs.org/api/fs.html'],
    },
  });
  reviewRecord(root, knowledge.meta.id, 'reviewer', 'pass', [], 'independent', true);
  const calls = [];
  let fail = true;
  const request = (method, endpoint, body) => {
    calls.push({ method, endpoint, body });
    if (endpoint === 'repos/example/shared') return { default_branch: 'main' };
    if (endpoint.includes('/git/ref/')) return { object: { sha: 'base' } };
    if (endpoint.endsWith('/git/commits/base')) return { sha: 'base', tree: { sha: 'base-tree' } };
    if (endpoint.endsWith('/git/trees')) return { sha: 'tree' };
    if (endpoint.endsWith('/git/commits')) return { sha: 'commit' };
    if (endpoint.includes('/pulls?')) return [];
    if (endpoint.endsWith('/pulls')) {
      if (fail) throw new Error('Temporary API failure');
      return { html_url: 'https://github.com/example/shared/pull/2' };
    }
    return {};
  };
  assert.throws(
    () => submitContribution(root, knowledge.meta.id, 'example/shared', request),
    /Temporary API/,
  );
  fail = false;
  assert.equal(
    submitContribution(root, knowledge.meta.id, 'example/shared', request).upstream_pr,
    'https://github.com/example/shared/pull/2',
  );
  assert.equal(calls.filter((call) => call.endpoint.endsWith('/git/refs')).length, 1);
  assert.equal(calls.filter((call) => call.endpoint.endsWith('/git/commits')).length, 1);
});

function project(t, profile = 'basic') {
  const root = mkdtempSync(join(tmpdir(), 'verythinker-core-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  initialize(root, { project_id: 'TEST', profile });
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src/value.mjs'), 'export const value = 1;\n');
  return root;
}
function assignment(root) {
  const requirement = createRecord(root, {
    type: 'requirement',
    title: 'Persistent positive value',
    owner: 'requirements',
    data: { acceptance_criteria: ['The value equals one.'] },
    body: 'Persistent configuration requirement.',
  });
  const task = createRecord(root, {
    type: 'task',
    title: 'Implement configuration',
    owner: 'developer',
    links: [{ type: 'satisfies', target: requirement.meta.id }],
    data: {
      acceptance_criteria: ['Stored value is one.'],
      allowed_paths: ['src'],
      tools: ['node'],
      outputs: ['src/value.mjs'],
    },
  });
  const check = createRecord(root, {
    type: 'check',
    title: 'Check value',
    owner: 'verifier',
    links: [{ type: 'verifies', target: requirement.meta.id }],
    data: {
      command: [
        process.execPath,
        '--input-type=module',
        '-e',
        'import {value} from "./src/value.mjs"; if(value !== 1) process.exit(1)',
      ],
      baseline_paths: ['src'],
      method: 'unit',
    },
  });
  return { requirement, task, check };
}
function submitted(root, work) {
  startTask(root, work.task.meta.id, 'requested-model', undefined, 'developer-invocation');
  const evidence = runCheck(root, work.check.meta.id, work.task.meta.id);
  submitTask(root, work.task.meta.id, 'Implemented and checked the value.');
  return evidence;
}

test('stable IDs survive rename and a deleted ID is never reallocated', (t) => {
  const root = project(t);
  const first = createRecord(root, { type: 'requirement', title: 'Original' });
  renameSync(join(root, first.path), join(root, '.verythinker/records/renamed.md'));
  assert.equal(getRecord(root, first.meta.id).path, '.verythinker/records/renamed.md');
  rmSync(join(root, '.verythinker/records/renamed.md'));
  const second = createRecord(root, { type: 'requirement', title: 'Replacement' });
  assert.notEqual(first.meta.id, second.meta.id);
});

test('duplicate IDs and malformed metadata prevent indexing', (t) => {
  const root = project(t);
  const record = createRecord(root, { type: 'requirement', title: 'Unique' });
  copyFileSync(join(root, record.path), join(root, '.verythinker/records/duplicate.md'));
  assert.throws(() => rebuildIndex(root), /Duplicate record ID/);
  rmSync(join(root, '.verythinker/records/duplicate.md'));
  writeFileSync(join(root, record.path), '# Missing metadata');
  assert.throws(() => loadRecords(root), /YAML frontmatter/);
});

test('dependency cycles, broken links and invalid link types are gate findings', (t) => {
  const root = project(t);
  const work = assignment(root);
  const other = createRecord(root, {
    type: 'task',
    title: 'Dependent',
    links: [{ type: 'depends-on', target: work.task.meta.id }],
  });
  updateRecord(root, work.task.meta.id, {
    links: [
      ...work.task.meta.links,
      { type: 'depends-on', target: other.meta.id },
      { type: 'references', target: 'MISSING-REQ-0001' },
      { type: 'evidence-for', target: work.check.meta.id },
    ],
  });
  const codes = verify(root, work.task.meta.id, 'ready').findings.map((f) => f.code);
  for (const code of ['dependency-cycle', 'broken-link', 'invalid-link-type'])
    assert.ok(codes.includes(code), code);
});

test('FTS5 refreshes after edits and the SQLite cache rebuilds from Markdown', (t) => {
  const root = project(t);
  const record = createRecord(root, {
    type: 'knowledge',
    title: 'Durable lesson',
    body: 'Atomic replacement avoids partial configuration.',
  });
  assert.equal(searchMemory(root, 'Atomic').length, 1);
  assert.equal(ensureIndex(root).rebuilt, false);
  updateRecord(root, record.meta.id, {}, 'Recovery preserves calibration.');
  assert.equal(ensureIndex(root).rebuilt, true);
  assert.equal(searchMemory(root, 'Atomic').length, 0);
  rmSync(join(root, '.verythinker/cache'), { recursive: true });
  assert.equal(searchMemory(root, 'calibration')[0].id, record.meta.id);
});

test('completion requires collected evidence, a submission and a separate review', (t) => {
  const root = project(t);
  const work = assignment(root);
  assert.equal(verify(root, work.task.meta.id, 'ready').ok, true);
  assert.equal(verify(root, work.task.meta.id, 'verified').ok, false);
  assert.throws(() => reviewTask(root, work.task.meta.id, 'reviewer', 'pass'), /Submit/);
  const evidence = submitted(root, work);
  assert.equal(evidence.meta.data.result, 'pass');
  assert.equal(verify(root, work.task.meta.id, 'verified').ok, true);
  assert.throws(() => acceptTask(root, work.task.meta.id), /independent review/);
  assert.throws(() => reviewTask(root, work.task.meta.id, 'developer', 'pass'), /different owner/);
  assert.throws(
    () => reviewTask(root, work.task.meta.id, 'reviewer', 'pass', [], 'developer-invocation'),
    /different owner/,
  );
  reviewTask(root, work.task.meta.id, 'reviewer', 'pass', [], 'reviewer-invocation');
  assert.equal(acceptTask(root, work.task.meta.id).meta.status, 'accepted');
  assert.equal(verify(root, work.task.meta.id, 'accepted').ok, true);
  const history = loadRecords(root).filter((r) => r.meta.data.kind === 'work-record');
  assert.equal(history.length, 1);
  for (const heading of [
    'Objective',
    'Inputs and Sources',
    'Decisions and Rationale',
    'Results',
    'Evidence',
    'Limitations',
    'Lessons',
  ])
    assert.ok(history[0].body.includes(`# ${heading}`));
  assert.equal(history[0].meta.data.confirmed_model, null);
});

test('tampered execution logs, receipts and missing logs invalidate evidence', (t) => {
  const root = project(t);
  const work = assignment(root);
  const evidence = submitted(root, work);
  const log = join(root, evidence.meta.data.log_path);
  const original = readFileSync(log);
  writeFileSync(log, 'Fake passing result');
  assert.equal(verify(root, work.task.meta.id, 'verified').ok, false);
  writeFileSync(log, original);
  const receipt = join(root, evidence.meta.data.receipt_path);
  const originalReceipt = readFileSync(receipt);
  const data = JSON.parse(originalReceipt);
  data.result = 'fail';
  writeFileSync(receipt, JSON.stringify(data));
  assert.equal(verify(root, work.task.meta.id, 'verified').ok, false);
  writeFileSync(receipt, originalReceipt);
  rmSync(log);
  assert.equal(verify(root, work.task.meta.id, 'verified').ok, false);
  mkdirSync(log);
  assert.equal(verify(root, work.task.meta.id, 'verified').ok, false);
});

test('a later failed execution does not reuse an earlier passing result', (t) => {
  const root = project(t);
  const work = assignment(root);
  updateRecord(root, work.check.meta.id, {
    data: {
      command: [process.execPath, '-e', 'process.exit(process.env.VERYTHINKER_TEST_FAIL ? 1 : 0)'],
    },
  });
  submitted(root, work);
  assert.equal(verify(root, work.task.meta.id, 'verified').ok, true);
  process.env.VERYTHINKER_TEST_FAIL = '1';
  try {
    assert.equal(runCheck(root, work.check.meta.id, work.task.meta.id).meta.data.result, 'fail');
  } finally {
    delete process.env.VERYTHINKER_TEST_FAIL;
  }
  assert.equal(verify(root, work.task.meta.id, 'verified').ok, false);
});

test('requirement changes identify affected checks, evidence and reviews without deleting history', (t) => {
  const root = project(t);
  const work = assignment(root);
  const evidence = submitted(root, work);
  reviewTask(root, work.task.meta.id, 'reviewer', 'pass', [], 'reviewer-invocation');
  acceptTask(root, work.task.meta.id);
  updateRecord(root, work.requirement.meta.id, {
    data: { acceptance_criteria: ['The value equals two.'] },
  });
  const affected = traceRecord(root, work.requirement.meta.id, true).affected.map((r) => r.type);
  for (const type of ['task', 'check', 'evidence', 'review']) assert.ok(affected.includes(type));
  assert.equal(verify(root, work.task.meta.id, 'accepted').ok, false);
  assert.equal(getRecord(root, evidence.meta.id).meta.data.result, 'pass');
});

test('a software design is reviewed against both its design and requirements baseline', (t) => {
  const root = project(t, 'software');
  const work = assignment(root);
  const design = createRecord(root, {
    type: 'design',
    title: 'Configuration interface',
    owner: 'architect',
    links: [{ type: 'satisfies', target: work.requirement.meta.id }],
    data: { interfaces: ['Export value.'] },
  });
  assert.equal(verify(root, work.task.meta.id, 'design-ready').ok, false);
  reviewRecord(root, design.meta.id, 'reviewer', 'pass');
  assert.equal(verify(root, work.task.meta.id, 'design-ready').ok, true);
  updateRecord(root, work.requirement.meta.id, {
    data: { acceptance_criteria: ['Different allocation.'] },
  });
  assert.equal(verify(root, work.task.meta.id, 'design-ready').ok, false);
});

test('interrupted assignments resume, dead writer locks recover, and live locks are preserved', (t) => {
  const root = project(t);
  const work = assignment(root);
  startTask(root, work.task.meta.id, 'requested', undefined, 'persisted-invocation');
  assert.equal(resumeTask(root, work.task.meta.id).meta.data.invocation_id, 'persisted-invocation');
  // Obtain a PID that has actually exited; avoid assuming a magic PID is absent.
  const child = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
  writeFileSync(
    join(root, '.verythinker/write.lock'),
    JSON.stringify({ pid: child.pid, started_at: new Date().toISOString() }),
  );
  updateRecord(root, work.task.meta.id, { data: { recovered: true } });
  writeFileSync(join(root, '.verythinker/write.lock'), JSON.stringify({ pid: process.pid }));
  assert.throws(() => updateRecord(root, work.task.meta.id, {}), /locked/);
  rmSync(join(root, '.verythinker/write.lock'));
});

test('one repair is permitted and repeated failure requires coordinator escalation', (t) => {
  const root = project(t);
  const work = assignment(root);
  startTask(root, work.task.meta.id);
  assert.equal(
    requestRepair(root, work.task.meta.id, 'Fix the implementation.').meta.status,
    'ready',
  );
  startTask(root, work.task.meta.id);
  assert.equal(
    requestRepair(root, work.task.meta.id, 'Repair still failed.').meta.status,
    'blocked',
  );
  assert.throws(() => resumeTask(root, work.task.meta.id), /coordinator/);
  assert.throws(() => startTask(root, work.task.meta.id), /coordinator/);
  assert.equal(resumeTask(root, work.task.meta.id, 'stronger-model').meta.status, 'in-progress');
});

test('context is bounded as serialized JSON and includes versioned pack pointers', (t) => {
  const root = project(t);
  const work = assignment(root);
  installPack(root, 'engineering-basics');
  updateRecord(root, work.requirement.meta.id, {}, 'Long input '.repeat(5000));
  const packet = contextPacket(root, work.task.meta.id, 4000);
  assert.ok(JSON.stringify(packet).length <= 4000);
  assert.ok(packet.inputs.some((input) => input.truncated));
  assert.equal(packet.knowledge_packs[0].version, '0.1.0');
  assert.throws(() => contextPacket(root, work.task.meta.id, NaN), /Context budget/);
});

test('contributions contain reviewed generalizations and never copy raw work records', (t) => {
  const root = project(t);
  const knowledge = createRecord(root, {
    type: 'knowledge',
    title: 'Validate before saving',
    owner: 'curator',
    body: 'PRIVATE_CUSTOMER_TOKEN_123',
    data: {
      generalization: 'Validate inputs before atomic persistence.',
      applicability: ['Small configuration stores.'],
      provenance: ['https://nodejs.org/api/fs.html'],
      limitations: ['Filesystem durability requires separate testing.'],
    },
  });
  assert.throws(() => prepareContribution(root, knowledge.meta.id), /review/);
  reviewRecord(root, knowledge.meta.id, 'reviewer', 'pass', [], 'curator-review', true);
  const result = prepareContribution(root, knowledge.meta.id);
  for (const file of result.files)
    assert.ok(
      !readFileSync(join(root, result.path, file), 'utf8').includes('PRIVATE_CUSTOMER_TOKEN_123'),
    );
  assert.equal(result.human_approval_required, true);
  assert.equal(result.upstream_pr, null);
  updateRecord(root, knowledge.meta.id, { data: { generalization: 'Changed lesson.' } });
  assert.throws(() => prepareContribution(root, knowledge.meta.id), /current independent/);
});

test('pack tampering is observable and same-version mutation cannot reinstall', (t) => {
  const root = project(t);
  const locked = installPack(root, 'engineering-basics');
  writeFileSync(join(root, locked.path, 'extra.md'), 'Unreviewed change');
  assert.equal(listPacks(root).installed[0].integrity, 'changed-or-missing');
  assert.throws(() => installPack(root, 'engineering-basics'), /modified/);
});

test('archived verification evidence remains valid after private runs are removed', (t) => {
  const root = project(t);
  const work = assignment(root);
  const evidence = submitted(root, work);
  archiveEvidence(root, evidence.meta.id);
  rmSync(join(root, '.verythinker/runs'), { recursive: true });
  assert.equal(verify(root, work.task.meta.id, 'verified').ok, true);
  reviewTask(root, work.task.meta.id, 'reviewer', 'pass');
  assert.equal(acceptTask(root, work.task.meta.id).meta.status, 'accepted');
});

test('explicit upstream contribution uploads only reviewed pack material and creates a draft PR', (t) => {
  const root = project(t);
  const knowledge = createRecord(root, {
    type: 'knowledge',
    title: 'Bounded reusable lesson',
    owner: 'curator',
    body: 'PRIVATE_PROJECT_RECORD',
    data: {
      generalization: 'Validate before storing.',
      applicability: ['Local stores.'],
      provenance: ['https://nodejs.org/api/fs.html'],
    },
  });
  reviewRecord(root, knowledge.meta.id, 'reviewer', 'pass', [], 'independent-generalization', true);
  const calls = [];
  const request = (method, endpoint, body) => {
    calls.push({ method, endpoint, body });
    if (endpoint === 'repos/example/shared') return { default_branch: 'main' };
    if (endpoint.includes('/git/ref/')) return { object: { sha: 'base' } };
    if (endpoint.endsWith('/git/commits/base')) return { sha: 'base', tree: { sha: 'base-tree' } };
    if (endpoint.endsWith('/git/trees')) return { sha: 'tree' };
    if (endpoint.endsWith('/git/commits')) return { sha: 'new-commit' };
    if (endpoint.endsWith('/pulls'))
      return { html_url: 'https://github.com/example/shared/pull/1' };
    return {};
  };
  const submitted = submitContribution(root, knowledge.meta.id, 'example/shared', request);
  assert.equal(submitted.upstream_pr, 'https://github.com/example/shared/pull/1');
  const tree = calls.find((call) => call.endpoint.endsWith('/git/trees')).body.tree;
  assert.equal(tree.length, 2);
  assert.ok(tree.every((file) => file.path.startsWith('resources/packs/')));
  assert.ok(!JSON.stringify(calls).includes('PRIVATE_PROJECT_RECORD'));
  assert.equal(calls.find((call) => call.endpoint.endsWith('/pulls')).body.draft, true);
  assert.ok(!JSON.stringify(calls).includes(knowledge.meta.id));
  const count = calls.length;
  assert.equal(
    submitContribution(root, knowledge.meta.id, 'example/shared', request).upstream_pr,
    submitted.upstream_pr,
  );
  assert.equal(
    calls.length,
    count,
    'Repeated submission must not create duplicate remote changes.',
  );
  assert.ok(!calls.some((call) => call.endpoint.includes('/merge')));
  assert.throws(
    () => submitContribution(root, knowledge.meta.id, 'https://github.com/example/shared', request),
    /owner\/repository/,
  );
});

test('a later generalization rejection supersedes an earlier approval', (t) => {
  const root = project(t);
  const knowledge = createRecord(root, {
    type: 'knowledge',
    title: 'Candidate',
    owner: 'curator',
    data: {
      generalization: 'A lesson.',
      applicability: ['Stores.'],
      provenance: ['https://nodejs.org/api/fs.html'],
    },
  });
  reviewRecord(root, knowledge.meta.id, 'reviewer', 'pass', [], 'first', true);
  assert.equal(prepareContribution(root, knowledge.meta.id).status, 'prepared');
  reviewRecord(
    root,
    knowledge.meta.id,
    'reviewer',
    'fail',
    ['Private context remains.'],
    'second',
    true,
  );
  assert.throws(() => prepareContribution(root, knowledge.meta.id), /current independent/);
});

test('CLI hooks use each native response schema and CLI gates work without hooks', (t) => {
  const root = project(t);
  const work = assignment(root);
  const cli = resolve('dist/cli.js');
  const invoke = (args) =>
    spawnSync(process.execPath, [cli, ...args, '--project', root], {
      encoding: 'utf8',
      windowsHide: true,
    });
  for (const platform of ['codex', 'claude', 'copilot']) {
    const result = invoke(['hook', '--event', 'session-start', '--platform', platform]);
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(
      typeof (platform === 'copilot'
        ? output.additionalContext
        : output.hookSpecificOutput.additionalContext),
      'string',
    );
    assert.deepEqual(
      JSON.parse(invoke(['hook', '--event', 'stop', '--platform', platform]).stdout),
      {},
    );
  }
  assert.equal(invoke(['verify', work.task.meta.id]).status, 1);
  assert.equal(
    invoke(['--version']).stdout.trim(),
    JSON.parse(readFileSync('package.json', 'utf8')).version,
  );
});

test('MCP performs a real stdio handshake, discovery, record mutation and core gate validation', async (t) => {
  const root = project(t);
  const client = new Client({ name: 'verythinker-test', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve('dist/cli.js'), 'mcp', '--project', root],
    stderr: 'pipe',
  });
  await client.connect(transport);
  try {
    const tools = await client.listTools();
    assert.ok(tools.tools.some((tool) => tool.name === 'task_accept'));
    const response = await client.callTool({
      name: 'record_create',
      arguments: {
        type: 'requirement',
        title: 'MCP configuration requirement',
        owner: 'requirements',
        data: { acceptance_criteria: ['The value is valid.'] },
      },
    });
    const record = JSON.parse(response.content[0].text);
    assert.equal(getRecord(root, record.meta.id).meta.title, 'MCP configuration requirement');
    const missing = await client.callTool({
      name: 'task_accept',
      arguments: { id: record.meta.id },
    });
    assert.equal(missing.isError, true);
    const report = await client.callTool({ name: 'verify', arguments: {} });
    assert.equal(JSON.parse(report.content[0].text).ok, false);
  } finally {
    await client.close();
  }
});
