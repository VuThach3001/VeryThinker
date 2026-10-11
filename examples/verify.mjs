import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const options = {};
for (let i = 2; i < process.argv.length; i += 2) {
  if (!process.argv[i]?.startsWith('--') || process.argv[i + 1] === undefined)
    throw new Error('Options require values.');
  options[process.argv[i].slice(2)] = process.argv[i + 1];
}
function execute(executable, args) {
  const result = spawnSync(executable, args, {
    cwd: root,
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 2 ** 20,
  });
  return {
    command: [executable, ...args],
    exit_code: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error?.message ?? null,
  };
}
function sanitize(value) {
  if (typeof value === 'string') {
    const paths = [
      [root, '<project>'],
      [tmpdir(), '<temporary-directory>'],
      [process.execPath, '<node>'],
      [options.compiler, '<compiler>'],
      [options['host-compiler'], '<host-compiler>'],
      [options['ngspice-library'], '<ngspice-library>'],
    ].filter(([path]) => path);
    for (const [path, replacement] of paths) {
      for (const variant of new Set([
        path,
        resolve(path),
        resolve(path).replaceAll('\\', '/'),
        resolve(path).replaceAll('\\', '\\\\'),
      ])) {
        value = value.replaceAll(variant, replacement);
      }
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(sanitize);
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitize(item)]));
  return value;
}
async function hashes(dir, output = {}) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === '__pycache__') continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await hashes(path, output);
    else if (entry.name !== 'verification.json' && entry.name !== 'records.json') {
      output[relative(root, path).replaceAll('\\', '/')] = createHash('sha256')
        .update(await readFile(path))
        .digest('hex');
    }
  }
  return output;
}

const results = [];
const tests = execute(process.execPath, ['--test', 'test/pilots.test.mjs']);
results.push({
  check_ids: [
    'SW-CHECK-001',
    'SW-CHECK-002',
    'SW-CHECK-003',
    'EM-CHECK-001',
    'EM-CHECK-002',
    'EM-CHECK-003',
    'EM-CHECK-004',
  ],
  status: tests.exit_code === 0 ? 'passed' : 'failed',
  method: 'behavioral-and-file-integration-tests',
  ...tests,
});
if (options['ngspice-library']) {
  const result = execute(options.python ?? 'python', [
    'examples/embedded/run-ngspice.py',
    '--library',
    options['ngspice-library'],
  ]);
  results.push({
    check_id: 'EM-CHECK-005',
    status: result.exit_code === 0 ? 'passed' : 'failed',
    method: 'spice-simulation',
    ...result,
    result: result.exit_code === 0 ? JSON.parse(result.stdout) : null,
  });
} else
  results.push({
    check_id: 'EM-CHECK-005',
    status: 'unavailable',
    reason: 'No ngspice shared library supplied.',
  });
if (options.compiler) {
  const dir = await mkdtemp(join(tmpdir(), 'verythinker-firmware-'));
  try {
    const result = execute(options.compiler, [
      '-std=c11',
      '-Wall',
      '-Wextra',
      '-Werror',
      '-ffreestanding',
      '-c',
      'examples/embedded/controller.c',
      '-o',
      join(dir, 'controller.o'),
    ]);
    const version = execute(options.compiler, ['--version']);
    results.push({
      check_id: 'EM-CHECK-006',
      status: result.exit_code === 0 ? 'passed' : 'failed',
      method: 'cross-compilation',
      ...result,
      compiler_version: version.stdout,
      object_sha256:
        result.exit_code === 0
          ? createHash('sha256')
              .update(await readFile(join(dir, 'controller.o')))
              .digest('hex')
          : null,
      limitations: ['Compilation only; the C controller was not executed on target hardware.'],
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
} else
  results.push({
    check_id: 'EM-CHECK-006',
    status: 'unavailable',
    reason: 'No C compiler supplied.',
  });
if (options['host-compiler']) {
  const result = execute(process.execPath, [
    'examples/embedded/run-firmware.mjs',
    '--compiler',
    options['host-compiler'],
  ]);
  results.push({
    check_id: 'EM-CHECK-007',
    status: result.exit_code === 0 ? 'passed' : 'failed',
    method: 'native-host-firmware-execution-and-model-comparison',
    ...result,
    result: result.exit_code === 0 ? JSON.parse(result.stdout) : null,
  });
} else
  results.push({
    check_id: 'EM-CHECK-007',
    status: 'unavailable',
    reason: 'No host C compiler supplied.',
  });
const git = execute('git', ['rev-parse', 'HEAD']);
const evidence = {
  schema_version: 1,
  recorded_at: new Date().toISOString(),
  revision: git.exit_code === 0 ? git.stdout.trim() : 'unavailable',
  baseline: 'Exact source hashes identify the tested working tree, including uncommitted files.',
  redactions: [
    'Local machine paths are replaced with tool/project/temporary-directory placeholders.',
  ],
  runtime: { node: process.version, platform: process.platform, architecture: process.arch },
  source_hashes: await hashes(join(root, 'examples')),
  results,
  limitations: [
    'No physical hardware, board, HIL, thermal, EMC, timing, or power-loss validation.',
    'Automated pilot verification is not an LLM agent benchmark.',
  ],
};
evidence.source_hashes['test/pilots.test.mjs'] = createHash('sha256')
  .update(await readFile(join(root, 'test/pilots.test.mjs')))
  .digest('hex');
evidence.source_hashes['scripts/evaluate.mjs'] = createHash('sha256')
  .update(await readFile(join(root, 'scripts/evaluate.mjs')))
  .digest('hex');
for (const directory of ['src', 'resources'])
  await hashes(join(root, directory), evidence.source_hashes);
for (const file of ['package.json', 'package-lock.json']) {
  try {
    evidence.source_hashes[file] = createHash('sha256')
      .update(await readFile(join(root, file)))
      .digest('hex');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}
const portableEvidence = sanitize(evidence);
if (options.output)
  await writeFile(
    resolve(options.output),
    `${JSON.stringify(portableEvidence, null, 2)}\n`,
    'utf8',
  );
process.stdout.write(`${JSON.stringify(portableEvidence, null, 2)}\n`);
if (results.some((result) => result.status === 'failed')) process.exitCode = 1;
