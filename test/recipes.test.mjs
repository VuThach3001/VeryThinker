import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import {
  createRecord,
  getRecord,
  hash,
  initialize,
  loadRecords,
  updateRecord,
} from '../dist/storage.js';
import {
  hasCurrentReview,
  reviewRecord,
  runCheck,
  startTask,
  verify,
} from '../dist/engineering.js';
import { beginWorkflow, decideWorkflow, discussWorkflow } from '../dist/manager.js';
import {
  listRecipes,
  prepareRecipe,
  resolveRecipe,
  reviseRecipe,
  runRecipe,
  verifyFrozenRecipe,
} from '../dist/recipes.js';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'verythinker-recipes-'));
  t.after(() => {
    const target = resolve(root);
    assert.ok(relative(tmpdir(), target).startsWith('verythinker-recipes-'));
    rmSync(target, { recursive: true, force: true });
  });
  initialize(root, { project_id: 'RECIPE', profile: 'software' });
  const requirement = createRecord(root, {
    type: 'requirement',
    title: 'Parameterized component contract',
    body: 'The component follows the declared scalar or ADC interface and its measurable boundaries.',
    data: {
      acceptance_criteria: [
        'The declared contract passes its parameter-derived boundary and fault procedures.',
      ],
    },
  });
  return { root, requirement };
}
function reviewAndStart(root, instance) {
  reviewRecord(
    root,
    instance.meta.data.design_id,
    'independent-reviewer',
    'pass',
    [],
    'design-review',
  );
  reviewRecord(
    root,
    instance.meta.data.check_id,
    'independent-reviewer',
    'pass',
    [],
    'verification-review',
  );
  startTask(root, instance.meta.data.task_id, 'worker-request', undefined, 'bounded-worker');
}
const software = (output_dir, max = 65535) => ({
  output_dir,
  schema_version: 1,
  fields: {
    port: { type: 'integer', default: 8080, min: 1, max },
    logLevel: { type: 'string', default: 'info', enum: ['debug', 'info', 'warn', 'error'] },
    enabled: { type: 'boolean', default: true },
  },
});
const embedded = (output_dir, adc_max = 255) => ({
  output_dir,
  adc_max,
  fault_low: 2,
  off_threshold: Math.floor(adc_max * 0.4),
  on_threshold: Math.floor(adc_max * 0.6),
  fault_high: adc_max - 2,
  supply_v: 12,
  load_ohm: 120,
  on_ohm: 0.05,
  off_ohm: 1e9,
  tolerance: 1e-5,
});
test('catalog resolves exact versions and hashes executable behavior', () => {
  assert.equal(listRecipes().length, 3);
  assert.equal(resolveRecipe('software-config-persistence').hash.length, 64);
  assert.throws(() => resolveRecipe('software-config-persistence', '2.0.0'), /unavailable/);
});
test('loaded generator identity stays stable and rejects new preparation after its module changes on disk', (t) => {
  const { root, requirement } = fixture(t);
  const copiedDirectory = join(root, 'copied-generator');
  mkdirSync(copiedDirectory);
  const copiedModule = join(copiedDirectory, 'recipes.js');
  const compiledUrl = new URL('../dist/recipes.js', import.meta.url);
  const source = readFileSync(compiledUrl, 'utf8').replace(
    /from ['"]\.\/([^'"]+)['"]/g,
    (_, name) => `from ${JSON.stringify(new URL(name, compiledUrl).href)}`,
  );
  writeFileSync(copiedModule, source);
  const script = `import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import { loadRecords } from ${JSON.stringify(new URL('../dist/storage.js', import.meta.url).href)};
const api = await import(${JSON.stringify(pathToFileURL(copiedModule).href)});
const before = api.resolveRecipe('software-config-persistence').hash;
const prepared = api.prepareRecipe(${JSON.stringify(root)}, {recipe_id: 'software-config-persistence', parameters: ${JSON.stringify(software('components/before-rebuild'))}, requirement_ids: [${JSON.stringify(requirement.meta.id)}]});
appendFileSync(${JSON.stringify(copiedModule)}, '\\n// Later on-disk rebuild.\\n');
assert.equal(api.resolveRecipe('software-config-persistence').hash, before);
assert.deepEqual(api.verifyFrozenRecipe(${JSON.stringify(root)}, prepared.meta.id), []);
const count = loadRecords(${JSON.stringify(root)}).length;
assert.throws(() => api.prepareRecipe(${JSON.stringify(root)}, {recipe_id: 'software-config-persistence', parameters: ${JSON.stringify(software('components/after-rebuild'))}, requirement_ids: [${JSON.stringify(requirement.meta.id)}]}), /Recipe module changed after loading/);
assert.equal(loadRecords(${JSON.stringify(root)}).length, count);
console.log('Loaded behavior retains its hash; new preparation requires a fresh process.');`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    timeout: 60000,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /retains its hash/);
});
test('fresh managed preparation freezes workflow and documentation before provenance adoption and planning review', (t) => {
  const { root } = fixture(t);
  // This initializes legacy core mechanics; these producer strings do not establish native inference.
  const workflow = beginWorkflow(root, {
    requirement:
      'Store a bounded configuration and document its validation and persistence interface.',
    invocation_id: 'fixture-managed-preparation',
  });
  const requirement = updateRecord(root, workflow.meta.data.requirement_id, {
    data: {
      acceptance_criteria: [
        'Preserve valid values and existing data while rejecting inputs outside the declared contract.',
      ],
    },
  });
  const instance = prepareRecipe(root, {
    recipe_id: 'software-config-persistence',
    workflow_id: workflow.meta.id,
    requirement_ids: [requirement.meta.id],
    parameters: software('components/managed-config'),
  });
  const task = getRecord(root, instance.meta.data.task_id);
  assert.equal(task.meta.data.workflow_id, workflow.meta.id);
  assert.equal(task.meta.data.documentation_required, true);
  assert.deepEqual(task.meta.data.documentation_paths, []);
  for (const [id, role] of [
    [instance.meta.data.design_id, 'architect'],
    [instance.meta.data.check_id, 'verifier'],
  ]) {
    const record = getRecord(root, id);
    assert.equal(record.meta.data.workflow_id, workflow.meta.id);
    assert.equal(record.meta.data.task_id, task.meta.id);
    updateRecord(root, id, {
      data: {
        invocation_id: `fixture-${role}-adoption`,
        author_invocation_id: `fixture-${role}-adoption`,
        invocation_role: role,
      },
    });
  }
  assert.deepEqual(verifyFrozenRecipe(root, instance.meta.id), []);
  reviewRecord(
    root,
    instance.meta.data.design_id,
    'independent-reviewer',
    'pass',
    [],
    'fixture-design-planning-review',
  );
  reviewRecord(
    root,
    instance.meta.data.check_id,
    'independent-reviewer',
    'pass',
    [],
    'fixture-check-planning-review',
  );
  assert.equal(hasCurrentReview(root, instance.meta.data.check_id), true);
  for (const role of ['requirements', 'verifier']) {
    discussWorkflow(root, workflow.meta.id, {
      role,
      invocation_id: `fixture-${role}-planning-discussion`,
      summary:
        'The independent expected fixtures and frozen scalar contract provide bounded verifiable behavior.',
      rationale:
        'Prescribed validation and storage checks cover the declared requirement without another implementation strategy.',
      source_ids: [requirement.meta.id],
      risks: [],
    });
  }
  decideWorkflow(root, workflow.meta.id, {
    summary: 'Implement the prepared bounded configuration component after its source reviews.',
    rationale:
      'The parameterized interface and independent expected fixtures preserve the reviewed acceptance contract.',
    task_ids: [task.meta.id],
  });
  assert.equal(hasCurrentReview(root, instance.meta.data.check_id), true);
  assert.deepEqual(verifyFrozenRecipe(root, task.meta.id), []);
  updateRecord(
    root,
    instance.meta.data.check_id,
    {},
    'A substantive procedure change must require a reviewed replacement.',
  );
  assert.ok(
    verifyFrozenRecipe(root, task.meta.id).some((problem) =>
      problem.includes('protected engineering record changed'),
    ),
  );
});
test('existing task workflow conflicts cannot be silently rebound during preparation', (t) => {
  const { root, requirement } = fixture(t);
  const first = beginWorkflow(root, { requirement: 'Preserve the first increment scope.' });
  const second = beginWorkflow(root, { requirement: 'Preserve the second increment scope.' });
  const task = createRecord(root, {
    type: 'task',
    title: 'First increment component',
    data: { workflow_id: first.meta.id, allowed_paths: ['components/config'] },
  });
  assert.throws(
    () =>
      prepareRecipe(root, {
        recipe_id: 'software-config-persistence',
        task_id: task.meta.id,
        workflow_id: second.meta.id,
        requirement_ids: [requirement.meta.id],
        parameters: software('components/config'),
      }),
    /conflicts with the assigned task workflow/,
  );
  assert.equal(getRecord(root, task.meta.id).meta.data.workflow_id, first.meta.id);
  assert.equal(
    loadRecords(root).filter((record) => record.meta.data.kind === 'recipe-instance').length,
    0,
  );
});
test('strict recipe records cannot fall back to legacy execution when routing policy is missing', (t) => {
  const { root, requirement } = fixture(t);
  const instance = prepareRecipe(root, {
    recipe_id: 'software-config-persistence',
    parameters: software('components/strict-config'),
    requirement_ids: [requirement.meta.id],
  });
  reviewAndStart(root, instance);
  // A retained strict flag represents a removed policy, not native execution evidence.
  updateRecord(root, instance.meta.data.task_id, { data: { routing_required: true } });
  assert.throws(() => runRecipe(root, instance.meta.id), /Strict recipe routing policy is missing/);
  assert.equal(existsSync(join(root, 'components/strict-config/config.mjs')), false);
  assert.equal(loadRecords(root).filter((record) => record.meta.type === 'evidence').length, 0);
});
test('two software parameter sets run deterministic frozen verification and preserve generated outputs', (t) => {
  const { root, requirement } = fixture(t);
  for (const [path, max] of [
    ['components/config-a', 9000],
    ['components/config-b', 65535],
  ]) {
    const instance = prepareRecipe(root, {
      recipe_id: 'software-config-persistence',
      parameters: software(path, max),
      requirement_ids: [requirement.meta.id],
    });
    assert.equal(
      prepareRecipe(root, {
        recipe_id: 'software-config-persistence',
        parameters: software(path, max),
        requirement_ids: [requirement.meta.id],
      }).meta.id,
      instance.meta.id,
    );
    assert.throws(() => runRecipe(root, instance.meta.id), /require current independent reviews/);
    reviewAndStart(root, instance);
    const run = runRecipe(root, instance.meta.id);
    assert.equal(
      run.evidence.meta.data.result,
      'pass',
      readFileSync(join(root, run.evidence.meta.data.log_path), 'utf8'),
    );
    const first = readFileSync(join(root, path, 'config.mjs'), 'utf8');
    assert.equal(runRecipe(root, instance.meta.id).evidence.meta.data.result, 'pass');
    assert.equal(readFileSync(join(root, path, 'config.mjs'), 'utf8'), first);
    assert.deepEqual(verifyFrozenRecipe(root, instance), []);
  }
});
test('software oracle rejects validation and save functions that mutate their expected input', (t) => {
  const { root, requirement } = fixture(t);
  for (const [name, mutate] of [
    [
      'validation-alias',
      (source) =>
        source.replace('return { ...value };', 'value.port = DEFAULT_CONFIG.port; return value;'),
    ],
    [
      'save-alias',
      (source) =>
        source.replace(
          'const validated = validateConfig(value);',
          'const validated = validateConfig(value); value.port = DEFAULT_CONFIG.port; validated.port = DEFAULT_CONFIG.port;',
        ),
    ],
  ]) {
    const output = `components/${name}`;
    const instance = prepareRecipe(root, {
      recipe_id: 'software-config-persistence',
      parameters: software(output, 9000),
      requirement_ids: [requirement.meta.id],
    });
    reviewAndStart(root, instance);
    assert.equal(runRecipe(root, instance.meta.id).evidence.meta.data.result, 'pass');
    const modulePath = join(root, output, 'config.mjs');
    const original = readFileSync(modulePath, 'utf8');
    const mutant = mutate(original);
    assert.notEqual(mutant, original);
    writeFileSync(modulePath, mutant);
    const evidence = runCheck(root, instance.meta.data.check_id, instance.meta.data.task_id);
    assert.equal(evidence.meta.data.result, 'fail');
    assert.match(
      readFileSync(join(root, evidence.meta.data.log_path), 'utf8'),
      /deep|strict|Expected values/,
    );
  }
});
test('two embedded calibrations verify every ADC state plus hysteresis and circuit bounds', (t) => {
  const { root, requirement } = fixture(t);
  for (const [path, max] of [
    ['components/control-8bit', 255],
    ['components/control-10bit', 1023],
  ]) {
    const instance = prepareRecipe(root, {
      recipe_id: 'embedded-hysteresis-load-control',
      parameters: embedded(path, max),
      requirement_ids: [requirement.meta.id],
    });
    reviewAndStart(root, instance);
    const run = runRecipe(root, instance.meta.id);
    assert.equal(run.evidence.meta.data.result, 'pass');
    const oracle = JSON.parse(
      readFileSync(join(root, '.verythinker/recipes', instance.meta.id, 'oracle.json'), 'utf8'),
    );
    assert.equal(oracle.cases.length, (max + 1) * 2 + 2);
    assert.ok(
      oracle.sequence.some(
        (item) => item.adc === embedded(path, max).off_threshold && item.expected === 0,
      ),
    );
    assert.ok(readFileSync(join(root, path, 'load-switch.cir'), 'utf8').includes('Ron=0.05'));
  }
});
test('parameter, oracle, check, and requirement mutations prevent recipe execution', (t) => {
  const { root, requirement } = fixture(t);
  const instance = prepareRecipe(root, {
    recipe_id: 'software-config-persistence',
    parameters: software('components/config'),
    requirement_ids: [requirement.meta.id],
  });
  reviewAndStart(root, instance);
  const oraclePath = join(root, '.verythinker/recipes', instance.meta.id, 'oracle.json');
  writeFileSync(oraclePath, '{}\n');
  assert.ok(
    verifyFrozenRecipe(root, instance).some((message) =>
      message.includes('protected recipe artifact changed'),
    ),
  );
  assert.throws(() => runRecipe(root, instance.meta.id), /protected recipe artifact changed/);
  updateRecord(root, instance.meta.id, {
    data: { parameters: software('components/config', 9000) },
  });
  updateRecord(root, instance.meta.data.check_id, { data: { expected_exit_code: 7 } });
  updateRecord(
    root,
    requirement.meta.id,
    {},
    'A changed requirement now needs a different interface.',
  );
  const problems = verifyFrozenRecipe(root, instance.meta.id);
  assert.ok(problems.some((message) => message.includes('parameters changed')));
  assert.ok(problems.some((message) => message.includes('protected engineering record changed')));
  assert.ok(problems.some((message) => message.includes('recipe requirement changed')));
});
test('recipes reject invalid parameters and preserve existing authored implementation edits', (t) => {
  const { root, requirement } = fixture(t);
  assert.throws(
    () =>
      prepareRecipe(root, {
        recipe_id: 'embedded-hysteresis-load-control',
        parameters: { ...embedded('components/control'), on_threshold: 1 },
        requirement_ids: [requirement.meta.id],
      }),
    /Embedded boundaries/,
  );
  assert.throws(
    () =>
      prepareRecipe(root, {
        recipe_id: 'software-config-persistence',
        parameters: software('../outside'),
        requirement_ids: [requirement.meta.id],
      }),
    /escapes|visible/,
  );
  const instance = prepareRecipe(root, {
    recipe_id: 'software-config-persistence',
    parameters: software('components/config'),
    requirement_ids: [requirement.meta.id],
  });
  reviewAndStart(root, instance);
  runRecipe(root, instance.meta.id);
  const path = join(root, 'components/config/config.mjs');
  writeFileSync(path, readFileSync(path, 'utf8') + '// My authored change must be preserved.\n');
  assert.throws(() => runRecipe(root, instance.meta.id), /preserves authored edits/);
  assert.ok(readFileSync(path, 'utf8').includes('My authored change'));
});
test('reviewed changes produce a new frozen recipe instance and preserve history', (t) => {
  const { root, requirement } = fixture(t);
  const instance = prepareRecipe(root, {
    recipe_id: 'software-config-persistence',
    parameters: software('components/config'),
    requirement_ids: [requirement.meta.id],
  });
  const change = createRecord(root, {
    type: 'change',
    title: 'Revise the accepted port bound',
    owner: 'architect',
    links: [{ type: 'documents', target: instance.meta.id }],
    body: 'The intended storage deployment now restricts configuration ports to 9000.',
  });
  assert.throws(
    () =>
      reviseRecipe(root, instance.meta.id, {
        change_id: change.meta.id,
        parameters: software('components/config', 9000),
        reason: 'The reviewed deployment range requires a lower upper port bound.',
      }),
    /reviewed change/,
  );
  reviewRecord(root, change.meta.id, 'independent-reviewer', 'pass', [], 'change-review');
  const replacement = reviseRecipe(root, instance.meta.id, {
    change_id: change.meta.id,
    parameters: software('components/config', 9000),
    reason: 'The reviewed deployment range requires a lower upper port bound.',
  });
  assert.notEqual(replacement.meta.id, instance.meta.id);
  assert.equal(getRecord(root, instance.meta.id).meta.status, 'superseded');
  assert.equal(getRecord(root, instance.meta.id).meta.data.parameters.fields.port.max, 65535);
  assert.equal(replacement.meta.data.parameters.fields.port.max, 9000);
});
test('same parameters receive a distinct idempotent reviewed replacement after requirement changes', (t) => {
  const { root, requirement } = fixture(t);
  const parameters = software('components/same-parameters');
  const input = {
    recipe_id: 'software-config-persistence',
    parameters,
    requirement_ids: [requirement.meta.id],
  };
  const original = prepareRecipe(root, input);
  updateRecord(
    root,
    requirement.meta.id,
    {},
    'The reviewed storage requirement now explicitly preserves every invalid input class.',
  );
  assert.throws(() => prepareRecipe(root, input), /reviewed replacement/);
  const change = createRecord(root, {
    type: 'change',
    title: 'Refresh verification without weakening its parameters',
    owner: 'architect',
    links: [{ type: 'documents', target: original.meta.id }],
    body: 'The changed requirement needs an independently reviewed current oracle with identical scalar parameters.',
  });
  reviewRecord(
    root,
    change.meta.id,
    'independent-reviewer',
    'pass',
    [],
    'same-parameter-change-review',
  );
  const request = {
    change_id: change.meta.id,
    parameters,
    reason: 'Reassess the updated requirement while preserving all scalar acceptance parameters.',
  };
  const replacement = reviseRecipe(root, original.meta.id, request);
  assert.notEqual(replacement.meta.id, original.meta.id);
  assert.equal(replacement.meta.data.parameters_hash, original.meta.data.parameters_hash);
  assert.notDeepEqual(
    replacement.meta.data.requirement_baselines,
    original.meta.data.requirement_baselines,
  );
  assert.equal(reviseRecipe(root, original.meta.id, request).meta.id, replacement.meta.id);
  assert.equal(getRecord(root, original.meta.data.check_id).meta.status, 'superseded');
  assert.throws(() => runRecipe(root, replacement.meta.id), /independent reviews/);
});
test('reviewed revision retires only explicitly referenced matching recipe history and is retry-safe', (t) => {
  const { root, requirement } = fixture(t);
  const original = prepareRecipe(root, {
    recipe_id: 'software-config-persistence',
    parameters: software('components/original'),
    requirement_ids: [requirement.meta.id],
  });
  const taskId = original.meta.data.task_id;
  updateRecord(root, taskId, { data: { allowed_paths: ['components'] } });
  const parameters = software('components/replacement');
  const second = prepareRecipe(root, {
    recipe_id: 'software-config-persistence',
    task_id: taskId,
    parameters,
    requirement_ids: [requirement.meta.id],
  });
  const otherRecipe = prepareRecipe(root, {
    recipe_id: 'embedded-hysteresis-load-control',
    task_id: taskId,
    parameters: embedded('components/retained-controller'),
    requirement_ids: [requirement.meta.id],
  });
  const otherTask = prepareRecipe(root, {
    recipe_id: 'software-config-persistence',
    parameters: software('components/retained-task'),
    requirement_ids: [requirement.meta.id],
  });
  const untouched = [otherRecipe.meta.id, otherTask.meta.id].map((id) => getRecord(root, id));
  const protectedHistory = {
    ...original.meta.data.protected_files,
    ...second.meta.data.protected_files,
  };
  const change = createRecord(root, {
    type: 'change',
    title: 'Replace two superseded software preparation histories',
    owner: 'architect',
    links: [original, second, otherRecipe, otherTask].map((record) => ({
      type: 'references',
      target: record.meta.id,
    })),
    body: 'Retire the two superseded software instances for this task; the distinct controller recipe and other task remain context references.',
  });
  reviewRecord(
    root,
    change.meta.id,
    'independent-reviewer',
    'pass',
    [],
    'retirement-change-review',
  );
  const input = {
    change_id: change.meta.id,
    parameters,
    reason:
      'The reviewed oracle correction replaces both explicitly referenced software histories for this bounded task.',
  };
  const replacement = reviseRecipe(root, second.meta.id, input);
  const retiredIds = [original.meta.id, second.meta.id].sort();
  assert.deepEqual(replacement.meta.data.retired_instance_ids, retiredIds);
  assert.deepEqual(
    replacement.meta.links
      .filter((link) => link.type === 'supersedes')
      .map((link) => link.target)
      .sort(),
    retiredIds,
  );
  for (const previous of [original, second]) {
    for (const id of [previous.meta.id, previous.meta.data.design_id, previous.meta.data.check_id])
      assert.equal(getRecord(root, id).meta.status, 'superseded');
  }
  for (const before of untouched) assert.deepEqual(getRecord(root, before.meta.id), before);
  for (const [path, checksum] of Object.entries(protectedHistory))
    assert.equal(hash(readFileSync(join(root, path))), checksum);
  assert.equal(reviseRecipe(root, second.meta.id, input).meta.id, replacement.meta.id);
  assert.deepEqual(verifyFrozenRecipe(root, replacement.meta.id), []);
  assert.throws(() => runRecipe(root, replacement.meta.id), /current independent reviews/);
});
test('Cornell recipe creates source-backed runnable practice and verifies its frozen format', (t) => {
  const { root, requirement } = fixture(t);
  const note = {
    topic: 'Finite-domain controller verification',
    kind: 'learning-note',
    path: 'docs/knowledge/finite-domain.md',
    context: 'A finite input domain permits a complete enumeration within a bounded contract.',
    constraints: ['Enumeration size must remain within the declared execution budget.'],
    cues: ['Which input classes should the requirement cover before implementation?'],
    main_notes:
      '[source-reported] The component contract includes measurable boundary and fault procedures [S1]. [inferred] A finite domain can enumerate all declared input states.',
    sources: [
      {
        id: 'S1',
        title: 'Parameterized component requirement',
        uri: `record:${requirement.meta.id}`,
        record_id: requirement.meta.id,
        retrieved_at: '2026-10-11T00:00:00Z',
      },
    ],
    demonstration: {
      body: 'Enumerate two Boolean prior states for each of four ADC input values.',
      expected: 'The Cartesian product contains eight distinct input-state pairs.',
      command: [process.execPath, '-e', 'console.log(4 * 2)'],
    },
    failure_cases: [
      'A larger unbounded input domain prevents complete enumeration in a fixed budget.',
    ],
    practice: {
      exercise_path: 'docs/practice/domain-exercise.md',
      exercise:
        '# Exercise\nCalculate the input-state count for eight ADC values and two prior states.\n',
      answer_path: 'docs/practice/domain-answer.md',
      answer:
        '# Answer\nThe Cartesian product contains sixteen cases because eight times two is sixteen.\n',
      command: [process.execPath, '-e', 'console.log(8 * 2)'],
    },
    summary:
      'Define domain size and independent expected outcomes before implementing a bounded controller.',
  };
  const instance = prepareRecipe(root, {
    recipe_id: 'cornell-evidence-note',
    parameters: { note },
    requirement_ids: [requirement.meta.id],
  });
  reviewAndStart(root, instance);
  const run = runRecipe(root, instance.meta.id);
  assert.equal(run.evidence.meta.data.result, 'pass');
  assert.equal(run.note.meta.data.format, 'cornell-v1');
  assert.equal(runRecipe(root, instance.meta.id).note.meta.id, run.note.meta.id);
});
test('optional native C verification records actual host comparisons without changing acceptance inputs', (t) => {
  const dmc = 'C:/Program Files/QSPICE/dm/bin/dmc.exe';
  const compiler = process.platform === 'win32' ? (existsSync(dmc) ? dmc : null) : 'cc';
  if (
    !compiler ||
    (process.platform !== 'win32' &&
      spawnSync(compiler, ['--version'], { encoding: 'utf8', timeout: 5000 }).status !== 0)
  ) {
    t.skip('A native host C compiler is unavailable.');
    return;
  }
  const { root, requirement } = fixture(t);
  const parameters = {
    ...embedded('components/native-controller', 127),
    compiler,
    compiler_family: process.platform === 'win32' ? 'dmc' : 'gcc',
  };
  const instance = prepareRecipe(root, {
    recipe_id: 'embedded-hysteresis-load-control',
    parameters,
    requirement_ids: [requirement.meta.id],
  });
  reviewAndStart(root, instance);
  const run = runRecipe(root, instance.meta.id);
  assert.equal(run.evidence.meta.data.result, 'pass');
  const log = readFileSync(join(root, run.evidence.meta.data.log_path), 'utf8');
  assert.ok(log.includes('"comparisons":258'));
  assert.ok(log.includes('"executable_sha256"'));
  assert.equal(existsSync(join(root, parameters.output_dir, 'firmware-test.exe')), false);
  assert.equal(verify(root, instance.meta.data.task_id, 'verified').ok, true);
});
test('rewriting snapshot metadata or superseding a recipe cannot bypass its reviewed oracle', (t) => {
  const { root, requirement } = fixture(t);
  const instance = prepareRecipe(root, {
    recipe_id: 'software-config-persistence',
    parameters: software('components/protected'),
    requirement_ids: [requirement.meta.id],
  });
  reviewAndStart(root, instance);
  const oraclePath = `.verythinker/recipes/${instance.meta.id}/oracle.json`;
  writeFileSync(join(root, oraclePath), '{}\n');
  updateRecord(root, instance.meta.id, {
    data: {
      protected_files: { ...instance.meta.data.protected_files, [oraclePath]: hash('{}\n') },
    },
  });
  assert.ok(
    verifyFrozenRecipe(root, instance.meta.data.task_id).some((problem) =>
      problem.includes('reviewed engineering contract'),
    ),
  );
  updateRecord(root, instance.meta.id, { status: 'superseded' });
  assert.ok(
    verifyFrozenRecipe(root, instance.meta.data.task_id).some((problem) =>
      problem.includes('lacks a current reviewed replacement'),
    ),
  );
});
test('reviewed recipe replacement updates unchanged generated bytes and preserves user edits', (t) => {
  const { root, requirement } = fixture(t);
  const instance = prepareRecipe(root, {
    recipe_id: 'software-config-persistence',
    parameters: software('components/reusable'),
    requirement_ids: [requirement.meta.id],
  });
  reviewAndStart(root, instance);
  assert.equal(runRecipe(root, instance.meta.id).evidence.meta.data.result, 'pass');
  updateRecord(root, instance.meta.data.task_id, { status: 'blocked' });
  const change = createRecord(root, {
    type: 'change',
    title: 'Narrow the generated port range',
    owner: 'architect',
    links: [{ type: 'documents', target: instance.meta.id }],
    body: 'The deployment now limits valid ports to nine thousand while preserving the module interface.',
  });
  reviewRecord(
    root,
    change.meta.id,
    'independent-reviewer',
    'pass',
    [],
    'replacement-change-review',
  );
  const replacement = reviseRecipe(root, instance.meta.id, {
    change_id: change.meta.id,
    parameters: software('components/reusable', 9000),
    reason: 'A reviewed deployment constraint narrows the maximum accepted port.',
  });
  reviewAndStart(root, replacement);
  const completed = runRecipe(root, replacement.meta.id);
  assert.equal(
    completed.evidence.meta.data.result,
    'pass',
    readFileSync(join(root, completed.evidence.meta.data.log_path), 'utf8'),
  );
  assert.ok(
    readFileSync(join(root, 'components/reusable/config.mjs'), 'utf8').includes('"max":9000'),
  );
  assert.equal(getRecord(root, instance.meta.data.check_id).meta.status, 'superseded');
  updateRecord(root, replacement.meta.data.task_id, { status: 'blocked' });
  const secondChange = createRecord(root, {
    type: 'change',
    title: 'Narrow the port range again',
    owner: 'architect',
    links: [{ type: 'documents', target: replacement.meta.id }],
    body: 'The deployment now limits valid ports to eight thousand five hundred.',
  });
  reviewRecord(
    root,
    secondChange.meta.id,
    'independent-reviewer',
    'pass',
    [],
    'second-change-review',
  );
  const next = reviseRecipe(root, replacement.meta.id, {
    change_id: secondChange.meta.id,
    parameters: software('components/reusable', 8500),
    reason: 'The subsequent reviewed deployment restricts the port range further.',
  });
  const file = join(root, 'components/reusable/config.mjs');
  writeFileSync(
    file,
    readFileSync(file, 'utf8') + '// My own implementation correction must stay intact.\n',
  );
  reviewAndStart(root, next);
  assert.throws(() => runRecipe(root, next.meta.id), /preserves authored edits/);
  assert.ok(readFileSync(file, 'utf8').includes('My own implementation correction'));
});
test('interrupted recipe preparation resumes the same task and instance without duplicate contracts', (t) => {
  const { root, requirement } = fixture(t);
  const request = {
    recipe_id: 'software-config-persistence',
    parameters: software('components/resumable'),
    requirement_ids: [requirement.meta.id],
  };
  const instance = prepareRecipe(root, request);
  const count = loadRecords(root).length;
  updateRecord(root, instance.meta.id, { data: { preparation_complete: false } });
  const resumed = prepareRecipe(root, request);
  assert.equal(resumed.meta.id, instance.meta.id);
  assert.equal(resumed.meta.data.task_id, instance.meta.data.task_id);
  assert.equal(resumed.meta.data.check_id, instance.meta.data.check_id);
  assert.equal(loadRecords(root).length, count);
  updateRecord(root, instance.meta.id, { data: { preparation_complete: false } });
  writeFileSync(join(root, `.verythinker/recipes/${instance.meta.id}/oracle.json`), '{}\n');
  assert.throws(
    () => prepareRecipe(root, request),
    /Interrupted protected recipe artifact changed/,
  );
});
