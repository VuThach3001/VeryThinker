import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { initialize, loadRecords, getRecord, createRecord } from '../dist/storage.js';
import { managedRun } from '../dist/managed.js';
import {
  ensureRoutingPolicy,
  readRoutingPolicy,
  roleModelPolicy,
  routingConfigurationHashes,
  routingBindingProblems,
  routingProblems,
  strongRoles,
  workerRoles,
} from '../dist/routing.js';
function project(t) {
  const root = mkdtempSync(join(tmpdir(), 'verythinker-routing-'));
  initialize(root);
  t.after(() => {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    rmSync(root, { recursive: true, force: true });
  });
  return root;
}
test('legacy core projects keep existing API compatibility until routing migration', (t) => {
  const root = project(t);
  assert.equal(readRoutingPolicy(root), null);
  assert.deepEqual(routingProblems(root, 'developer', 'legacy-invocation'), []);
  ensureRoutingPolicy(root);
  assert.match(
    routingProblems(root, 'developer', 'legacy-invocation').join(' '),
    /cannot be verified/,
  );
});
test('authored Codex model overrides block strict routing while other platform choices survive', (t) => {
  const root = project(t);
  ensureRoutingPolicy(root);
  const path = join(root, '.verythinker/config.json');
  const config = JSON.parse(readFileSync(path, 'utf8'));
  config.models.strong = { claude: 'authored-claude-model', codex: 'gpt-6.1-sol' };
  config.models.economy = { copilot: 'authored-copilot-model' };
  writeFileSync(path, JSON.stringify(config));
  assert.deepEqual(roleModelPolicy(root, 'reviewer').models, ['gpt-6.1-sol']);
  config.models.economy.codex = 'gpt-5.6-terra';
  writeFileSync(path, JSON.stringify(config));
  assert.throws(() => roleModelPolicy(root, 'developer'), /economy model mapping conflicts/);
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).models.economy.codex, 'gpt-5.6-terra');
});
test('approved provider installations do not invalidate routing policy fingerprints', (t) => {
  const root = project(t);
  ensureRoutingPolicy(root);
  const prior = routingConfigurationHashes(root);
  writeFileSync(
    join(root, '.verythinker/tool-lock.json'),
    JSON.stringify({ providers: ['codegraph'] }),
  );
  assert.deepEqual(routingConfigurationHashes(root), prior);
  writeFileSync(join(root, '.verythinker/tools.json'), JSON.stringify({ approved_providers: [] }));
  assert.notDeepEqual(routingConfigurationHashes(root), prior);
});
test('all strategic roles use exclusively Sol and routine roles use documented worker fallback', (t) => {
  const root = project(t);
  ensureRoutingPolicy(root);
  for (const role of strongRoles) {
    const policy = roleModelPolicy(root, role);
    assert.deepEqual(policy.models, ['gpt-6.1-sol']);
    assert.equal(policy.reasoning_effort, 'high');
  }
  for (const role of workerRoles) {
    const policy = roleModelPolicy(root, role);
    assert.deepEqual(policy.models, ['gpt-6-luna', 'gpt-5.6-terra']);
    assert.equal(policy.reasoning_effort, 'medium');
  }
  assert.throws(() => roleModelPolicy(root, 'unknown'), /Unsupported/);
  assert.match(routingProblems(root, 'reviewer', undefined).join(' '), /bridge-issued/);
});
test('migration preserves authored routing conflicts for review', (t) => {
  const root = project(t);
  ensureRoutingPolicy(root);
  const path = join(root, '.verythinker/routing.json');
  const original = JSON.parse(readFileSync(path, 'utf8'));
  original.strong_model = 'custom-model';
  writeFileSync(path, JSON.stringify(original));
  assert.throws(() => ensureRoutingPolicy(root), /migration conflict/);
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).strong_model, 'custom-model');
});
test('managed resumption preserves increment identity and reports policy blockers without launching inference', async (t) => {
  const root = project(t);
  const started = await managedRun(root, {
    requirements: [
      'Validate declared integer bounds.',
      'Persist accepted configuration atomically.',
    ],
  });
  assert.match(started.blocker, /Strict native routing must be installed/);
  assert.equal(started.invocation, undefined);
  const workflowId = started.workflow.workflow_id;
  const incrementId = started.workflow.increment_id;
  const resumed = await managedRun(root, { workflow_id: workflowId });
  assert.equal(resumed.workflow.increment_id, incrementId);
  assert.equal(
    loadRecords(root).filter((record) => record.meta.data.kind === 'manager-workflow').length,
    1,
  );
  await assert.rejects(
    managedRun(root, { workflow_id: workflowId, requirement: 'An unrelated new requirement.' }),
    /differ from the saved increment/,
  );
  assert.equal(getRecord(root, workflowId).meta.data.original_requirements.length, 2);
  ensureRoutingPolicy(root);
  const path = join(root, '.verythinker/config.json');
  const config = JSON.parse(readFileSync(path, 'utf8'));
  config.models.strong = 'unapproved-model';
  writeFileSync(path, JSON.stringify(config));
  const conflicted = await managedRun(root, { workflow_id: workflowId });
  assert.match(conflicted.blocker, /strong model mapping conflicts/);
  assert.equal(conflicted.invocation, undefined);
});
test('workflow-wide strategic binding covers only a target task in that explicitly bound workflow', (t) => {
  const root = project(t);
  const task = createRecord(root, {
    type: 'task',
    title: 'Review planned component',
    data: { workflow_id: 'workflow-a' },
  });
  const scope = { role: 'reviewer', task_id: null, workflow_id: 'workflow-a' };
  const target = { task_id: task.meta.id, workflow_id: 'workflow-a' };
  assert.deepEqual(routingBindingProblems(root, scope, target), []);
  assert.match(
    routingBindingProblems(root, { ...scope, role: 'developer' }, target).join(' '),
    /different task/,
  );
  assert.match(
    routingBindingProblems(root, scope, { task_id: task.meta.id }).join(' '),
    /different task/,
  );
  assert.match(
    routingBindingProblems(
      root,
      { ...scope, workflow_id: 'workflow-b' },
      { ...target, workflow_id: 'workflow-b' },
    ).join(' '),
    /different task/,
  );
  assert.match(
    routingBindingProblems(root, { ...scope, task_id: 'another-task' }, target).join(' '),
    /different task/,
  );
});
