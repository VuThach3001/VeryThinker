import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { controllerStep, DEFAULT_CALIBRATION } from './simulation.mjs';

const source = dirname(fileURLToPath(import.meta.url));
const options = {};
for (let i = 2; i < process.argv.length; i += 2) {
  if (!process.argv[i]?.startsWith('--') || process.argv[i + 1] === undefined) {
    throw new Error('Options require values.');
  }
  options[process.argv[i].slice(2)] = process.argv[i + 1];
}
if (!options.compiler) throw new Error('Supply an installed host C compiler with --compiler.');
const compiler = resolve(options.compiler);
const family = options.family ?? (basename(compiler).toLowerCase() === 'dmc.exe' ? 'dmc' : 'gcc');
if (!['dmc', 'gcc'].includes(family))
  throw new Error('Compiler family must be dmc or gcc (including compatible clang).');
const build = join(resolve(source, '..', '..'), 'artifacts', 'firmware-test', randomUUID());
await mkdir(build, { recursive: true });
const files = ['controller.c', 'controller.h', 'firmware-test.c'];
const sourceHashes = {};
for (const file of files) {
  await copyFile(join(source, file), join(build, file));
  sourceHashes[file] = createHash('sha256')
    .update(await readFile(join(source, file)))
    .digest('hex');
}
sourceHashes['simulation.mjs'] = createHash('sha256')
  .update(await readFile(join(source, 'simulation.mjs')))
  .digest('hex');
function execute(executable, args) {
  const result = spawnSync(executable, args, {
    cwd: build,
    encoding: 'utf8',
    timeout: 60_000,
    maxBuffer: 2 ** 20,
  });
  if (result.error) throw result.error;
  return result;
}
const version = execute(compiler, family === 'dmc' ? [] : ['--version']);
const executable = join(
  build,
  process.platform === 'win32' ? 'firmware-test.exe' : 'firmware-test',
);
const compilerArgs =
  family === 'dmc'
    ? ['controller.c', 'firmware-test.c', '-mn', '-wx', '-ofirmware-test.exe']
    : [
        '-std=c11',
        '-Wall',
        '-Wextra',
        '-Werror',
        'controller.c',
        'firmware-test.c',
        '-o',
        basename(executable),
      ];
const compiled = execute(compiler, compilerArgs);
await writeFile(
  join(build, 'compiler.log'),
  `${compiled.stdout ?? ''}${compiled.stderr ?? ''}`,
  'utf8',
);
assert.equal(
  compiled.status,
  0,
  `Host C compilation failed: ${compiled.stdout ?? ''}${compiled.stderr ?? ''}`,
);
const run = execute(executable, []);
await writeFile(join(build, 'results.csv'), run.stdout, 'utf8');
assert.equal(run.status, 0, `Native C harness failed: ${run.stderr ?? ''}`);
const counts = { exhaustive: 0, boundary: 0, sequence: 0 };
let sequencePrevious = 0;
for (const line of run.stdout.trim().split(/\r?\n/)) {
  const [kind, ...values] = line.split(',');
  assert.ok(Object.hasOwn(counts, kind), `Unexpected case kind: ${kind}`);
  const numbers = values.map(Number);
  assert.equal(numbers.length, 7);
  assert.ok(numbers.every((value) => Number.isInteger(value) && value >= 0 && value <= 0xffffffff));
  const [adc, previous, onThreshold, offThreshold, faultLow, faultHigh, actual] = numbers;
  if (kind === 'exhaustive') {
    assert.equal(adc, Math.floor(counts.exhaustive / 2));
    assert.equal(previous, counts.exhaustive % 2);
  }
  if (kind === 'sequence')
    assert.equal(previous, sequencePrevious, 'Native sequence lost its prior output state.');
  const state = controllerStep(adc, previous <= 1 ? previous === 1 : previous, {
    ...DEFAULT_CALIBRATION,
    onThreshold,
    offThreshold,
    faultLow,
    faultHigh,
  });
  const expected = Number(state.on) | (Number(state.fault) << 1);
  assert.equal(actual, expected, `Native C and JavaScript differ for ${line}`);
  if (kind === 'sequence') sequencePrevious = expected & 1;
  counts[kind] += 1;
}
assert.deepEqual(counts, { exhaustive: 8192, boundary: 14, sequence: 9 });
const evidence = {
  schema_version: 1,
  check_id: 'EM-CHECK-007',
  recorded_at: new Date().toISOString(),
  status: 'passed',
  method: 'native-host-firmware-execution-and-model-comparison',
  compiler: {
    family,
    version: (version.stdout || version.stderr).split(/\r?\n/)[0],
    arguments: compilerArgs,
  },
  runtime: { platform: process.platform, architecture: process.arch },
  source_hashes: sourceHashes,
  executable_sha256: createHash('sha256')
    .update(await readFile(executable))
    .digest('hex'),
  results_sha256: createHash('sha256').update(run.stdout).digest('hex'),
  comparisons: counts,
  total_comparisons: Object.values(counts).reduce((sum, count) => sum + count, 0),
  limitations: [
    'C ran on a native host, not on an MCU or physical board.',
    'Exhaustive comparison covers ADC and prior-state combinations for the default calibration; alternate calibration and fault cases are representative.',
    'The independent requirement tests validate the JavaScript model; matching implementations can still share a specification error.',
    'Timing, ADC electronics, GPIO behavior, and hardware safety remain outside this check.',
  ],
};
if (options.output)
  await writeFile(resolve(options.output), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
