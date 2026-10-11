import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  initialize,
  createRecord,
  updateRecord,
  getRecord,
  loadRecords,
  hash,
} from '../dist/storage.js';
import {
  beginWorkflow,
  discussWorkflow,
  decideWorkflow,
  finishWorkflow,
  workflowStatus,
} from '../dist/manager.js';
import {
  startTask,
  runCheck,
  archiveEvidence,
  submitTask,
  reviewTask,
} from '../dist/engineering.js';
import { ensureArchivePolicy, publishArchive } from '../dist/archives.js';

test('automatic archive retry reuses the frozen snapshot and final report after lost publication response', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'verythinker-manager-archive-'));
  t.after(() => {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    rmSync(root, { recursive: true, force: true });
  });
  initialize(root, { project_id: 'CLOSURE', profile: 'basic' });
  const policy = ensureArchivePolicy(root);
  writeFileSync(
    join(root, '.verythinker/archive.json'),
    JSON.stringify({ ...policy, repository: 'example/private' }, null, 2) + '\n',
  );
  const parent = beginWorkflow(root, {
    requirement: 'Export the documented integer one.',
    request_id: 'archive-retry',
    invocation_id: 'legacy-manager-fixture',
  });
  const requirement = updateRecord(root, parent.meta.data.requirement_id, {
    data: { acceptance_criteria: ['The value export is integer one.'] },
  });
  mkdirSync(join(root, 'src'));
  mkdirSync(join(root, 'docs'));
  writeFileSync(join(root, 'src/value.mjs'), 'export const value = 1;\n');
  writeFileSync(join(root, 'docs/value.md'), '# Value\nThe value export is integer one.\n');
  const task = createRecord(root, {
    type: 'task',
    title: 'Deliver documented value',
    owner: 'developer',
    links: [{ type: 'satisfies', target: requirement.meta.id }],
    data: {
      acceptance_criteria: ['The module and documentation agree.'],
      allowed_paths: ['src', 'docs'],
      documentation_paths: ['docs/value.md'],
      outputs: ['src/value.mjs', 'docs/value.md'],
    },
  });
  const check = createRecord(root, {
    type: 'check',
    title: 'Verify numeric export',
    links: [{ type: 'verifies', target: requirement.meta.id }],
    data: {
      baseline_paths: ['src'],
      command: [
        process.execPath,
        '--input-type=module',
        '-e',
        'import {value} from "./src/value.mjs"; if(value!==1) process.exit(1)',
      ],
    },
  });
  for (const role of ['requirements', 'verifier'])
    discussWorkflow(root, parent.meta.id, {
      role,
      invocation_id: `${role}-legacy-fixture`,
      summary: 'The documented invariant has a focused executable verification procedure.',
      rationale:
        'A bounded module and explicit numeric oracle cover the small requirement without external services.',
      source_ids: [requirement.meta.id],
    });
  decideWorkflow(root, parent.meta.id, {
    summary: 'Use one named export and document its observed value.',
    rationale:
      'The basic engineering profile covers this bounded module through separate review and repeatable evidence.',
    task_ids: [task.meta.id],
  });
  startTask(root, task.meta.id, undefined, undefined, 'worker-fixture');
  const evidence = archiveEvidence(root, runCheck(root, check.meta.id, task.meta.id).meta.id);
  const work = `# Objective\nDeliver the named integer export and its documented interface for ${task.meta.id}.\n# Inputs and Sources\nInspected ${requirement.meta.id}, the module, documentation, and verification procedure.\n# Decisions and Rationale\nUsed a named immutable export because the contract needs no parsing or external service.\n# Results\nCreated the numeric module and documented its expected observable interface.\n# Evidence\nExecuted ${check.meta.id}; collected ${evidence.meta.id} with persistent logs and receipts.\n# Limitations\nThis fixture verifies a bounded module and uses legacy invocation observations without native inference claims.\n# Lessons\nA focused executable oracle gives a reproducible check for a small stable numeric contract.\n`;
  submitTask(root, task.meta.id, 'Delivered the documented integer and verified its export.', work);
  reviewTask(root, task.meta.id, 'reviewer', 'pass', [], 'reviewer-fixture');
  const branches = new Map([['main', 'base']]);
  let lost = true;
  const commits = new Map([['base', { sha: 'base', tree: { sha: 'base-tree' } }]]);
  const request = (method, endpoint, body) => {
    if (endpoint === 'repos/example/private') return { private: true, default_branch: 'main' };
    if (endpoint.includes('/git/ref/heads/')) {
      const branch = decodeURIComponent(endpoint.split('/git/ref/heads/')[1]);
      if (branches.has(branch)) return { object: { sha: branches.get(branch) } };
      const error = new Error('HTTP 404');
      error.status = 404;
      throw error;
    }
    if (endpoint.includes('/git/commits/') && method === 'GET')
      return commits.get(endpoint.split('/git/commits/')[1]);
    if (endpoint.endsWith('/git/blobs') || endpoint.endsWith('/git/trees'))
      return { sha: hash(JSON.stringify(body)) };
    if (endpoint.endsWith('/git/commits')) {
      const sha = hash(JSON.stringify(body));
      commits.set(sha, { sha, tree: { sha: body.tree } });
      return { sha };
    }
    if (endpoint.endsWith('/git/refs')) {
      branches.set(body.ref.replace('refs/heads/', ''), body.sha);
      if (lost) {
        lost = false;
        throw new Error('Lost successful baseline response.');
      }
      return {};
    }
    throw new Error(`Unexpected archive request ${method} ${endpoint}`);
  };
  const snapshots = [];
  const publisher = (project, snapshotId) => {
    snapshots.push(snapshotId);
    return publishArchive(project, snapshotId, { request });
  };
  const input = {
    no_lesson_reason:
      'This legacy protocol fixture demonstrates publication recovery and adds no reusable domain engineering lesson.',
  };
  const first = finishWorkflow(root, parent.meta.id, input, undefined, publisher);
  assert.equal(first.phase, 'completed-with-blockers');
  assert.equal(getRecord(root, task.meta.id).meta.status, 'accepted');
  assert.equal(
    loadRecords(root).filter((record) => record.meta.title === 'Manager final report').length,
    1,
  );
  const sequence = readFileSync(join(root, '.verythinker/id-sequence.json'));
  const second = finishWorkflow(root, parent.meta.id, input, undefined, publisher);
  assert.equal(second.phase, 'completed');
  assert.equal(new Set(snapshots).size, 1);
  assert.deepEqual(readFileSync(join(root, '.verythinker/id-sequence.json')), sequence);
  assert.equal(
    loadRecords(root).filter((record) => record.meta.title === 'Manager final report').length,
    1,
  );
  assert.equal(workflowStatus(root, parent.meta.id).archive.status, 'completed');
  assert.equal(commits.size, 2);
});
