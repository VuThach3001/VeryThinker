// These suites also run independently inside the example directories.
import '../examples/software/tests/config.test.mjs';
import '../examples/embedded/tests/controller.test.mjs';

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const evaluation = fileURLToPath(new URL('../scripts/evaluate.mjs', import.meta.url));
const softwareSource = fileURLToPath(new URL('../examples/software/config.mjs', import.meta.url));
const evaluate = (args) =>
  spawnSync(process.execPath, [evaluation, ...args], { encoding: 'utf8', timeout: 60_000 });

test('evaluation matrix contains 18 planned trials without observed results', () => {
  const result = evaluate(['matrix']);
  assert.equal(result.status, 0, result.stderr);
  const matrix = JSON.parse(result.stdout);
  assert.equal(matrix.status, 'not-run');
  assert.equal(matrix.trials.length, 18);
  assert.equal(new Set(matrix.trials.map((trial) => trial.trial_id)).size, 18);
  assert.ok(matrix.trials.every((trial) => !('status' in trial)));
  assert.notEqual(evaluate(['run']).status, 0);
});

test('evaluation reports missing observations instead of zeros and rejects inconsistent imports', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'verythinker-evaluation-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const input = join(dir, 'empty.jsonl');
  await writeFile(input, '');
  const result = evaluate(['summarize', '--input', input]);
  assert.equal(result.status, 0, result.stderr);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.recorded_trials, 0);
  assert.equal(summary.unrecorded_trials.length, 18);
  assert.ok(
    summary.groups.every(
      (group) => group.acceptance_rate === 'unavailable' && group.cost.median === 'unavailable',
    ),
  );
  await writeFile(
    input,
    JSON.stringify({
      schema_version: 1,
      trial_id: 'software/strong-single/1',
      pilot: 'embedded',
      configuration: 'strong-single',
      trial: 1,
      status: 'accepted',
      elapsed_ms: 1,
      provenance: { platform: 'test-fixture' },
      artifacts: {},
      metrics: {},
    }),
  );
  const invalid = evaluate(['import', '--input', input, '--output', join(dir, 'results.jsonl')]);
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /Invalid trial record/);
});

test('evaluation executes protected checks and rejects a runner that edits them', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'verythinker-runner-fixture-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const runner = join(dir, 'mock-runner.mjs');
  // This fixture tests the harness; its temporary results are not LLM benchmarks.
  const fixture = `import { copyFile, readFile, writeFile } from 'node:fs/promises';
let input = ''; for await (const chunk of process.stdin) input += chunk;
const packet = JSON.parse(input);
if (process.argv.includes('null-output')) { console.log('null'); process.exit(0); }
await copyFile(${JSON.stringify(softwareSource)}, 'config.mjs');
await writeFile('review.md', 'Test fixture independent review.');
if (process.argv.includes('tamper')) await writeFile('tests/config.test.mjs', '');
console.log(JSON.stringify({ implementation_actor: 'fixture-implementer',
  review: { status: 'accepted', actor: 'fixture-reviewer', artifact: 'review.md' },
  requested_models: 'unavailable', confirmed_models: 'unavailable', metrics: {} }));`;
  await writeFile(runner, fixture);
  const output = join(dir, 'fixture-results.jsonl');
  const result = evaluate([
    'run',
    '--runner',
    process.execPath,
    '--runner-args-json',
    JSON.stringify([runner]),
    '--platform',
    'test-fixture',
    '--pilot',
    'software',
    '--configuration',
    'strong-single',
    '--trial',
    '1',
    '--output',
    output,
  ]);
  assert.equal(result.status, 0, result.stderr);
  const trial = JSON.parse((await readFile(output, 'utf8')).trim());
  assert.equal(trial.status, 'accepted');
  assert.equal(trial.metrics.cost_amount, null);
  assert.equal(trial.metrics.escaped_defects, null);
  assert.equal(trial.confirmed_models, 'unavailable');
  const tamperedOutput = join(dir, 'tampered-results.jsonl');
  const tampered = evaluate([
    'run',
    '--runner',
    process.execPath,
    '--runner-args-json',
    JSON.stringify([runner, 'tamper']),
    '--platform',
    'test-fixture',
    '--pilot',
    'software',
    '--configuration',
    'strong-single',
    '--trial',
    '1',
    '--output',
    tamperedOutput,
  ]);
  assert.equal(tampered.status, 0, tampered.stderr);
  const tamperedTrial = JSON.parse((await readFile(tamperedOutput, 'utf8')).trim());
  assert.equal(tamperedTrial.status, 'failed');
  assert.equal(tamperedTrial.verification.protected_files_unchanged, false);
  const malformedOutput = join(dir, 'malformed-results.jsonl');
  const malformed = evaluate([
    'run',
    '--runner',
    process.execPath,
    '--runner-args-json',
    JSON.stringify([runner, 'null-output']),
    '--platform',
    'test-fixture',
    '--pilot',
    'software',
    '--configuration',
    'strong-single',
    '--trial',
    '1',
    '--output',
    malformedOutput,
  ]);
  assert.equal(malformed.status, 0, malformed.stderr);
  const malformedTrial = JSON.parse((await readFile(malformedOutput, 'utf8')).trim());
  assert.equal(malformedTrial.status, 'failed');
  assert.match(malformedTrial.verification.runner_error, /JSON object/);
});

for (const pilot of ['software', 'embedded']) {
  test(`${pilot} workflow records actual checks, resumes, and requires explicit independent reviews`, async (t) => {
    const { buildWorkflow } = await import('../examples/workflow.mjs');
    const { acceptTask, getRecord, prepareContribution, reviewRecord, verify } =
      await import('../dist/index.js');
    const dir = await mkdtemp(join(tmpdir(), `verythinker-${pilot}-workflow-`));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const report = await buildWorkflow(dir, pilot);
    assert.equal(report.gates.ready.ok, true);
    assert.equal(report.gates.accepted.ok, false);
    assert.ok(
      report.gates.accepted.findings.some(
        (finding) => finding.code === 'missing-independent-review',
      ),
    );
    assert.equal(getRecord(dir, report.records.evidence).meta.data.result, 'pass');
    assert.throws(() => acceptTask(dir, report.records.task), /review/);
    // These review records exercise gate mechanics, not real engineering review.
    reviewRecord(
      dir,
      report.records.design,
      'fixture-reviewer',
      'pass',
      [],
      'test-fixture-design-review',
    );
    assert.equal(verify(dir, report.records.task, 'verified').ok, true);
    reviewRecord(
      dir,
      report.records.task,
      'fixture-reviewer',
      'pass',
      [],
      'test-fixture-task-review',
    );
    assert.equal(acceptTask(dir, report.records.task).meta.status, 'accepted');
    const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
    const resumed = spawnSync(
      process.execPath,
      [cli, 'verify', report.records.task, '--project', dir, '--json'],
      { encoding: 'utf8', timeout: 60_000 },
    );
    assert.equal(resumed.status, 0, resumed.stderr);
    assert.equal(JSON.parse(resumed.stdout).ok, true);
    assert.throws(() => prepareContribution(dir, report.records.lesson), /review/i);
    reviewRecord(
      dir,
      report.records.lesson,
      'fixture-reviewer',
      'pass',
      [],
      'test-fixture-knowledge-review',
      true,
    );
    const contribution = prepareContribution(dir, report.records.lesson);
    assert.equal(contribution.status, 'prepared');
    assert.equal(contribution.human_approval_required, true);
    const lesson = await readFile(join(dir, contribution.path, 'lesson.md'), 'utf8');
    assert.ok(lesson.length > 50);
    assert.ok(!lesson.includes('script-driven-pilot-verification'));
  });
}
