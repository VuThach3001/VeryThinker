import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { initialize } from '../dist/storage.js';
import { beginWorkflow } from '../dist/manager.js';
import { selectExecutionPolicy, validateFastSelection } from '../dist/fast-policy.js';
const requirement = 'Change the enabled default in the existing module.';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'verythinker-fast-policy-'));
  t.after(() => {
    assert.ok(relative(tmpdir(), resolve(root)).startsWith('verythinker-fast-policy-'));
    rmSync(root, { recursive: true, force: true });
  });
  initialize(root, { project_id: 'FAST', profile: 'software' });
  const workflow = beginWorkflow(root, { requirement, request_id: 'fast-policy-fixture' });
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'module.mjs'), 'export const enabled = true;\n');
  writeFileSync(join(root, 'src', 'contract.json'), '{"enabled":true}\n');
  const binding = {
    id: 'small-config-change',
    requirement: 'Change the enabled default in the existing module.',
    classification: 'familiar',
    recipe_id: 'software-config-persistence',
    recipe_version: '1.0.0',
    parameters: { output_dir: 'src', schema_version: 1, fields: { enabled: { type: 'boolean', default: true } } },
    editable_paths: ['src/module.mjs'],
    protected_input_paths: ['src/contract.json'],
    risk_flags: { security: false, safety: false, interfaces: false, dependencies: false, environment: false },
  };
  const writeBindings = (bindings = [binding]) => writeFileSync(join(root, '.verythinker', 'fast-bindings.json'), JSON.stringify({ schema_version: 1, bindings }, null, 2));
  writeBindings();
  return { root, binding, writeBindings, workflow_id: workflow.meta.id };
}
const requestFor = (workflow_id) => ({ workflow_id, requirement });

test('Fast rejects junction aliases into private project state', t => {
  const { root, binding, writeBindings, workflow_id } = fixture(t);
  const privateDir=join(root,'.verythinker','private-example');
  mkdirSync(privateDir);
  writeFileSync(join(privateDir,'module.mjs'),'private bytes must never enter a source packet');
  symlinkSync(privateDir,join(root,'src','alias'),'junction');
  writeBindings([{...binding,editable_paths:['src/alias/module.mjs']}]);
  assert.throws(()=>selectExecutionPolicy(root,{...requestFor(workflow_id),policy:'fast'}),/symbolic-link|junction alias/i);
  assert.equal(selectExecutionPolicy(root,requestFor(workflow_id)).mode,'standard');
});
function rehashSelection(selection) {
  const { selection_fingerprint: _ignored, ...core } = selection;
  const canonical = (value) => value === null || typeof value !== 'object' ? JSON.stringify(value) : Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  return { ...core, selection_fingerprint: createHash('sha256').update(canonical(core)).digest('hex') };
}

test('no bindings preserves standard policy and exact eligible binding selects fast', (t) => {
  const { root, binding, writeBindings, workflow_id } = fixture(t);
  rmSync(join(root, '.verythinker', 'fast-bindings.json'));
  assert.equal(selectExecutionPolicy(root, { workflow_id }).mode, 'standard');
  assert.throws(() => selectExecutionPolicy(root, { ...requestFor(workflow_id), policy: 'fast' }), /no fast bindings/i);
  writeBindings();
  const selected = selectExecutionPolicy(root, requestFor(workflow_id));
  assert.equal(selected.mode, 'fast');
  assert.equal(selected.fast.schema_version, 1);
  assert.equal(selected.fast.workflow_id, workflow_id);
  assert.equal(selected.fast.request_sha256.length, 64);
  assert.deepEqual(selected.fast.editable_paths, binding.editable_paths);
  validateFastSelection(root, selected.fast, { baseline: true });
});

test('auto falls back for unknown, duplicate, risky, malformed, or unavailable recipes', (t) => {
  const { root, binding, writeBindings, workflow_id } = fixture(t);
  assert.equal(selectExecutionPolicy(root, { workflow_id, requirement: 'unrelated' }).mode, 'standard');
  writeBindings([binding, { ...binding, id: 'duplicate' }]);
  assert.equal(selectExecutionPolicy(root, requestFor(workflow_id)).mode, 'standard');
  const risky = { ...binding, risk_flags: { ...binding.risk_flags, interfaces: true } };
  writeBindings([risky]);
  assert.equal(selectExecutionPolicy(root, requestFor(workflow_id)).mode, 'standard');
  assert.throws(() => selectExecutionPolicy(root, { ...requestFor(workflow_id), policy: 'fast' }), /risk flags/i);
  writeBindings([{ ...binding, recipe_id: 'missing-recipe' }]);
  assert.equal(selectExecutionPolicy(root, requestFor(workflow_id)).mode, 'standard');
  assert.throws(() => selectExecutionPolicy(root, { ...requestFor(workflow_id), policy: 'fast' }), /unavailable/i);
  writeFileSync(join(root, '.verythinker', 'fast-bindings.json'), '{');
  assert.equal(selectExecutionPolicy(root, requestFor(workflow_id)).mode, 'standard');
  assert.throws(() => selectExecutionPolicy(root, { ...requestFor(workflow_id), policy: 'fast' }));
});

test('selection validation catches forged data, changed request/config/bindings/protected inputs and optional baselines', (t) => {
  const { root, binding, writeBindings, workflow_id } = fixture(t);
  const selection = selectExecutionPolicy(root, requestFor(workflow_id)).fast;
  assert.ok(selection);
  assert.throws(() => validateFastSelection(root, { ...selection, binding_id: 'forged' }), /fingerprint/i);
  assert.throws(() => validateFastSelection(root, { ...selection, request_sha256: 'changed' }), /fingerprint/i);
  const configPath = join(root, '.verythinker', 'config.json');
  const originalConfig = readFileSync(configPath, 'utf8');
  writeFileSync(configPath, originalConfig + '\n');
  assert.throws(() => validateFastSelection(root, selection), /configuration changed/i);
  writeFileSync(configPath, originalConfig);
  writeBindings([{ ...binding, classification: 'warm' }]);
  assert.throws(() => validateFastSelection(root, selection), /bindings changed/i);
  writeBindings();
  writeFileSync(join(root, 'src', 'contract.json'), '{"enabled":false}\n');
  assert.throws(() => validateFastSelection(root, selection), /protected fast input changed/i);
  writeFileSync(join(root, 'src', 'contract.json'), '{"enabled":true}\n');
  writeFileSync(join(root, 'src', 'module.mjs'), 'export const enabled = false;\n');
  validateFastSelection(root, selection);
  assert.throws(() => validateFastSelection(root, selection, { baseline: true }), /planning baseline changed/i);
});

test('fast selection is bound to the authoritative workflow original requirement', (t) => {
  const { root, writeBindings, workflow_id } = fixture(t);
  const selection = selectExecutionPolicy(root, requestFor(workflow_id)).fast;
  assert.ok(selection);
  const other = beginWorkflow(root, { requirement: 'Change a different module.', request_id: 'fast-policy-other' });
  assert.throws(() => validateFastSelection(root, rehashSelection({ ...selection, workflow_id: other.meta.id })), /workflow original requirement/i);
  assert.equal(selectExecutionPolicy(root, { ...requestFor(other.meta.id), requirement, policy: 'auto' }).mode, 'standard');
  assert.throws(() => selectExecutionPolicy(root, { ...requestFor(other.meta.id), requirement, policy: 'fast' }), /workflow original requirement/i);
  writeBindings();
  validateFastSelection(root, selection);
});

test('fast policy requires a workflow with exactly one original requirement', (t) => {
  const { root, binding, writeBindings } = fixture(t);
  const multi = beginWorkflow(root, { requirements: [requirement, 'Keep the existing API stable.'], request_id: 'fast-policy-multiple' });
  writeBindings([binding, { ...binding, id: 'second', requirement: 'Keep the existing API stable.' }]);
  assert.equal(selectExecutionPolicy(root, { workflow_id: multi.meta.id, requirements: [requirement, 'Keep the existing API stable.'] }).mode, 'standard');
  assert.throws(() => selectExecutionPolicy(root, { workflow_id: multi.meta.id, requirement, policy: 'fast' }), /one unchanged original workflow requirement/i);
});

test('duplicate paths, protected edits, private paths, missing files, and unreadable inputs reject explicit fast', (t) => {
  const { root, binding, writeBindings, workflow_id } = fixture(t);
  for (const editable_paths of [['src/module.mjs', 'src/module.mjs'], ['src/contract.json'], ['.verythinker/config.json'], ['src/missing.mjs']]) {
    writeBindings([{ ...binding, editable_paths }]);
    assert.throws(() => selectExecutionPolicy(root, { ...requestFor(workflow_id), policy: 'fast' }));
  }
  writeBindings([{ ...binding, protected_input_paths: ['src/missing-contract.json'] }]);
  assert.throws(() => selectExecutionPolicy(root, { ...requestFor(workflow_id), policy: 'fast' }), /existing file/i);
});
