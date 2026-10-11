import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as pause } from 'node:timers/promises';
import {
  createRecord,
  initialize,
  reviewRecord,
  submitContribution,
  updateRecord,
  withOperationLock,
} from '../dist/index.js';

function project(t) {
  const root = mkdtempSync(join(tmpdir(), 'verythinker-publication-'));
  t.after(() => {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    assert.ok(root.includes('verythinker-publication-'));
    rmSync(root, { recursive: true, force: true });
  });
  initialize(root, { project_id: 'PUBLICATION' });
  const candidate = createRecord(root, {
    type: 'knowledge',
    title: 'Durable reviewed proposal',
    owner: 'curator',
    body: 'PRIVATE_PROJECT_DETAILS',
    data: {
      invocation_id: 'curation-fixture',
      generalization: 'Validate configuration before replacing its persisted representation.',
      applicability: ['Applications with local configuration.'],
      provenance: ['https://nodejs.org/api/fs.html'],
    },
  });
  reviewRecord(root, candidate.meta.id, 'reviewer', 'pass', [], 'review-fixture', true);
  return { root, id: candidate.meta.id };
}
function submissionPath(work) {
  return join(work.root, '.verythinker/contributions', work.id.toLowerCase(), 'submission.json');
}
function readState(work) {
  return JSON.parse(readFileSync(submissionPath(work), 'utf8'));
}
function fakeGitHub(work, { loseBranch = false, losePR = false, mutateBeforePR = false } = {}) {
  const calls = [];
  const branches = new Map();
  const prs = [];
  const request = (method, endpoint, body) => {
    calls.push({ method, endpoint, body });
    const state = readState(work);
    assert.match(state.operation_id, /^[a-f0-9-]{36}$/);
    assert.match(state.branch, /^codex\/knowledge-/);
    if (endpoint === 'repos/example/shared') return { default_branch: 'main' };
    if (endpoint.includes('/git/ref/heads/')) {
      const branch = decodeURIComponent(endpoint.split('/git/ref/heads/')[1]);
      if (branch === 'main') return { object: { sha: 'base' } };
      if (branches.has(branch)) return { object: { sha: branches.get(branch) } };
      const error = new Error('HTTP 404: reference does not exist');
      error.status = 404;
      throw error;
    }
    if (endpoint.endsWith('/git/commits/base')) return { sha: 'base', tree: { sha: 'base-tree' } };
    if (endpoint.endsWith('/git/trees')) return { sha: 'tree' };
    if (endpoint.endsWith('/git/commits')) return { sha: 'commit' };
    if (endpoint.endsWith('/git/refs')) {
      branches.set(body.ref.replace('refs/heads/', ''), body.sha);
      if (mutateBeforePR) {
        updateRecord(work.root, work.id, {
          data: { generalization: 'Changed unreviewed proposal.' },
        });
      }
      if (loseBranch) {
        loseBranch = false;
        throw new Error('Connection lost after remote branch creation.');
      }
      return {};
    }
    if (endpoint.includes('/pulls?')) return prs;
    if (endpoint.endsWith('/pulls')) {
      assert.equal(body.draft, true);
      const pr = { html_url: 'https://github.com/example/shared/pull/7' };
      prs.push(pr);
      if (losePR) {
        losePR = false;
        throw new Error('Connection lost after remote PR creation.');
      }
      return pr;
    }
    throw new Error(`Unexpected fixture request: ${method} ${endpoint}`);
  };
  return { calls, branches, prs, request };
}

test('publication resumes stable intent after lost branch and PR responses without duplicate mutations', (t) => {
  const work = project(t);
  const github = fakeGitHub(work, { loseBranch: true, losePR: true });
  assert.throws(
    () => submitContribution(work.root, work.id, 'example/shared', github.request),
    /lost after remote branch/,
  );
  const intent = readState(work);
  assert.equal(intent.status, 'commit-created');
  assert.throws(
    () => submitContribution(work.root, work.id, 'example/shared', github.request),
    /lost after remote PR/,
  );
  assert.equal(readState(work).status, 'branch-created');
  const result = submitContribution(work.root, work.id, 'example/shared', github.request);
  assert.equal(result.operation_id, intent.operation_id);
  assert.equal(result.branch, intent.branch);
  assert.equal(result.upstream_pr, 'https://github.com/example/shared/pull/7');
  assert.equal(result.approval_scope, 'merge');
  for (const suffix of ['/git/trees', '/git/commits', '/git/refs', '/pulls']) {
    assert.equal(
      github.calls.filter((call) => call.method === 'POST' && call.endpoint.endsWith(suffix))
        .length,
      1,
      suffix,
    );
  }
  assert.ok(github.calls.some((call) => call.endpoint.includes('/pulls?state=all')));
  assert.ok(!JSON.stringify(github.calls).includes('PRIVATE_PROJECT_DETAILS'));
});

test('same-invocation reentry is rejected while the original publication retains its claim', (t) => {
  const work = project(t);
  const github = fakeGitHub(work);
  let attempted = false;
  const request = (...args) => {
    if (!attempted) {
      attempted = true;
      assert.throws(
        () => submitContribution(work.root, work.id, 'example/shared', github.request),
        /already running in this invocation/,
      );
    }
    return github.request(...args);
  };
  const result = submitContribution(work.root, work.id, 'example/shared', request);
  assert.equal(result.status, 'draft-pr-created');
  assert.equal(github.calls.filter((call) => call.endpoint.endsWith('/pulls')).length, 1);
  const count = github.calls.length;
  submitContribution(work.root, work.id, 'example/shared', github.request);
  assert.equal(github.calls.length, count);
});

test('a candidate changed during remote preparation cannot create its PR', (t) => {
  const work = project(t);
  const github = fakeGitHub(work, { mutateBeforePR: true });
  assert.throws(
    () => submitContribution(work.root, work.id, 'example/shared', github.request),
    /independent generalization review/,
  );
  assert.equal(github.prs.length, 0);
  assert.equal(readState(work).status, 'branch-created');
});

test('operation locks recover only dead owners and preserve live or malformed leases', (t) => {
  const work = project(t);
  const path = join(work.root, '.verythinker/operations/fixture.lock');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, '{malformed');
  assert.throws(() => withOperationLock(work.root, 'fixture', () => 'unsafe', 0), /remains locked/);
  assert.equal(readFileSync(path, 'utf8'), '{malformed');
  writeFileSync(
    path,
    JSON.stringify({ pid: process.pid, thread_id: 123456, token: 'live-fixture' }),
  );
  assert.throws(() => withOperationLock(work.root, 'fixture', () => 'unsafe', 0), /remains locked/);
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).token, 'live-fixture');
  const exited = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(exited.status, 0, exited.stderr);
  writeFileSync(
    path,
    JSON.stringify({ pid: Number(exited.stdout), thread_id: 0, token: 'dead-fixture' }),
  );
  assert.equal(
    withOperationLock(work.root, 'fixture', () => 'recovered', 0),
    'recovered',
  );
  assert.equal(existsSync(path), false);
});

test(
  'racing processes publish one candidate through a single branch and draft PR',
  { timeout: 10000 },
  async (t) => {
    const work = project(t);
    const runner = join(work.root, 'publish-race.mjs');
    const callsPath = join(work.root, 'remote-calls.jsonl');
    const startPath = join(work.root, 'start');
    const moduleUrl = new URL('../dist/index.js', import.meta.url).href;
    writeFileSync(
      runner,
      `
import { existsSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { submitContribution } from ${JSON.stringify(moduleUrl)};
const [root, id, worker] = process.argv.slice(2);
writeFileSync(join(root, 'ready-' + worker), 'ready');
while (!existsSync(join(root, 'start'))) await pause(10);
const request = (method, endpoint, body) => {
  const state = JSON.parse(readFileSync(join(root, '.verythinker/contributions', id.toLowerCase(), 'submission.json'), 'utf8'));
  if (!state.operation_id || !state.branch) throw new Error('Intent was not persisted before remote operations.');
  appendFileSync(join(root, 'remote-calls.jsonl'), JSON.stringify({method, endpoint, body, operation_id:state.operation_id}) + '\\n');
  if (endpoint === 'repos/example/shared') {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
    return {default_branch:'main'};
  }
  if (endpoint.includes('/git/ref/heads/')) return {object:{sha:'base'}};
  if (endpoint.endsWith('/git/commits/base')) return {sha:'base',tree:{sha:'base-tree'}};
  if (endpoint.endsWith('/git/trees')) return {sha:'tree'};
  if (endpoint.endsWith('/git/commits')) return {sha:'commit'};
  if (endpoint.endsWith('/git/refs')) return {};
  if (endpoint.includes('/pulls?')) return [];
  if (endpoint.endsWith('/pulls')) return {html_url:'https://github.com/example/shared/pull/8'};
  throw new Error('Unexpected fixture request ' + endpoint);
};
process.stdout.write(JSON.stringify(submitContribution(root, id, 'example/shared', request)));
`,
    );
    const children = [1, 2].map((worker) => {
      const child = spawn(process.execPath, [runner, work.root, work.id, String(worker)], {
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (part) => {
        stdout += part;
      });
      child.stderr.on('data', (part) => {
        stderr += part;
      });
      const done = new Promise((resolveChild, reject) => {
        child.on('error', reject);
        child.on('close', (code) => resolveChild({ code, stdout, stderr }));
      });
      return { child, done };
    });
    t.after(() => {
      for (const { child } of children) if (child.exitCode === null) child.kill();
    });
    const deadline = Date.now() + 5000;
    while (![1, 2].every((worker) => existsSync(join(work.root, 'ready-' + worker)))) {
      assert.ok(Date.now() < deadline, 'Publication workers failed to reach the start barrier.');
      await pause(10);
    }
    writeFileSync(startPath, 'start');
    const results = await Promise.all(children.map(({ done }) => done));
    for (const result of results) assert.equal(result.code, 0, result.stderr);
    const states = results.map((result) => JSON.parse(result.stdout));
    assert.equal(states[0].operation_id, states[1].operation_id);
    assert.equal(states[0].branch, states[1].branch);
    assert.equal(states[0].upstream_pr, states[1].upstream_pr);
    const calls = readFileSync(callsPath, 'utf8').trim().split('\n').map(JSON.parse);
    for (const suffix of ['/git/trees', '/git/commits', '/git/refs', '/pulls']) {
      assert.equal(
        calls.filter((call) => call.method === 'POST' && call.endpoint.endsWith(suffix)).length,
        1,
        suffix,
      );
    }
    assert.equal(new Set(calls.map((call) => call.operation_id)).size, 1);
  },
);
