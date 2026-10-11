import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, relative } from 'node:path';
import {
  createCornellNote,
  cornellQuote,
  validateCornellNote,
  type CornellInput,
} from './notes.js';
import { hasCurrentReview, recordFingerprint, runCheck } from './engineering.js';
import { assertRouting, readInvocation, readRoutingPolicy } from './routing.js';
import {
  atomicWrite,
  createRecord,
  getRecord,
  hash,
  loadRecords,
  now,
  readConfig,
  resourceRoot,
  safePath,
  snapshotPaths,
  updateRecord,
  withOperationLock,
} from './storage.js';
import type { ProjectRecord } from './types.js';

// Identify the generator functions this process actually loaded, even across a package rebuild.
const loadedGeneratorImplementation = readFileSync(new URL('./recipes.js', import.meta.url));
const loadedGeneratorHash = hash(loadedGeneratorImplementation);
function assertCurrentGeneratorModule(): void {
  if (hash(readFileSync(new URL('./recipes.js', import.meta.url))) !== loadedGeneratorHash)
    throw new Error(
      'Recipe module changed after loading; restart the native transport before preparing a new instance.',
    );
}

export interface RecipeDescriptor {
  id: string;
  version: string;
  hash: string;
  applicability: string;
  limitations: string[];
  parameter_schema: Record<string, unknown>;
}
export interface RecipeInput {
  recipe_id: string;
  version?: string;
  parameters: Record<string, unknown>;
  requirement_ids: string[];
  task_id?: string;
  workflow_id?: string;
  owner?: string;
}
interface SoftwareParameters {
  output_dir: string;
  fields: Record<
    string,
    {
      type: 'integer' | 'number' | 'string' | 'boolean';
      default: unknown;
      min?: number;
      max?: number;
      enum?: unknown[];
    }
  >;
  schema_version: number;
}
interface EmbeddedParameters {
  output_dir: string;
  adc_max: number;
  on_threshold: number;
  off_threshold: number;
  fault_low: number;
  fault_high: number;
  supply_v: number;
  load_ohm: number;
  on_ohm: number;
  off_ohm: number;
  tolerance: number;
  compiler?: string;
  compiler_family?: 'gcc' | 'dmc';
  ngspice?: string;
}
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
    .join(',')}}`;
}
function contractFingerprint(record: ProjectRecord): string {
  const { invocation_id, author_invocation_id, invocation_role, ...data } = record.meta.data;
  return recordFingerprint({ ...record, meta: { ...record.meta, data } });
}
export function listRecipes(): RecipeDescriptor[] {
  return [
    'cornell-evidence-note',
    'software-config-persistence',
    'embedded-hysteresis-load-control',
  ].map((id) => resolveRecipe(id));
}
export function resolveRecipe(id: string, version = '1.0.0'): RecipeDescriptor {
  if (
    ![
      'cornell-evidence-note',
      'software-config-persistence',
      'embedded-hysteresis-load-control',
    ].includes(id) ||
    version !== '1.0.0'
  )
    throw new Error('Recipe identity/version is unavailable.');
  const path = `${resourceRoot}/recipes/${id}/recipe.json`;
  const content = readFileSync(path, 'utf8');
  const descriptor = JSON.parse(content) as Omit<RecipeDescriptor, 'hash'>;
  if (descriptor.id !== id || descriptor.version !== version)
    throw new Error('Recipe catalog identity does not match.');
  // Include the executable generator itself: descriptor-only hashes cannot freeze behavior.
  return {
    ...descriptor,
    hash: hash(Buffer.concat([Buffer.from(content), loadedGeneratorImplementation])),
  };
}
function visiblePath(root: string, value: unknown): string {
  if (typeof value !== 'string' || !value || value.includes('\\'))
    throw new Error('Recipe output paths must be canonical project-relative forward-slash paths.');
  const path = relative(root, safePath(root, value)).replaceAll('\\', '/');
  if (
    path !== value ||
    path.startsWith('.') ||
    !path.split('/').every((part) => /^[a-zA-Z0-9_.-]+$/.test(part))
  )
    throw new Error('Recipe outputs must use a visible canonical project path.');
  return path;
}
function softwareParameters(root: string, parameters: Record<string, unknown>): SoftwareParameters {
  const value = parameters as unknown as SoftwareParameters;
  visiblePath(root, value.output_dir);
  if (
    !Number.isSafeInteger(value.schema_version) ||
    value.schema_version < 1 ||
    !value.fields ||
    typeof value.fields !== 'object' ||
    Array.isArray(value.fields) ||
    !Object.keys(value.fields).length
  )
    throw new Error('Software recipe needs a positive schema_version and non-empty fields object.');
  if (
    Object.keys(value.fields).some(
      (key) =>
        !/^[a-zA-Z][a-zA-Z0-9_]*$/.test(key) ||
        ['schemaVersion', '__proto__', 'constructor', 'prototype'].includes(key),
    )
  )
    throw new Error('Configuration field names must be safe identifiers other than schemaVersion.');
  for (const [key, field] of Object.entries(value.fields)) {
    if (!field || !['integer', 'number', 'string', 'boolean'].includes(field.type))
      throw new Error(`Invalid field type: ${key}`);
    if (
      (field.type === 'integer' && !Number.isSafeInteger(field.default)) ||
      (field.type === 'number' &&
        (typeof field.default !== 'number' || !Number.isFinite(field.default))) ||
      (['string', 'boolean'].includes(field.type) && typeof field.default !== field.type)
    )
      throw new Error(`Default does not satisfy field type: ${key}`);
    if (
      field.min !== undefined &&
      (!Number.isFinite(field.min) ||
        !['integer', 'number'].includes(field.type) ||
        (field.type === 'integer' && !Number.isSafeInteger(field.min)))
    )
      throw new Error(`Invalid minimum: ${key}`);
    if (
      field.max !== undefined &&
      (!Number.isFinite(field.max) ||
        !['integer', 'number'].includes(field.type) ||
        (field.type === 'integer' && !Number.isSafeInteger(field.max)))
    )
      throw new Error(`Invalid maximum: ${key}`);
    if (
      (field.min !== undefined && field.max !== undefined && field.min > field.max) ||
      (field.min !== undefined && Number(field.default) < field.min) ||
      (field.max !== undefined && Number(field.default) > field.max)
    )
      throw new Error(`Default/bounds conflict: ${key}`);
    if (
      field.enum &&
      (!Array.isArray(field.enum) ||
        !field.enum.length ||
        !field.enum.includes(field.default) ||
        field.enum.some((item) => typeof item !== typeof field.default))
    )
      throw new Error(`Enum/default conflict: ${key}`);
  }
  return JSON.parse(JSON.stringify(value));
}
function embeddedParameters(root: string, parameters: Record<string, unknown>): EmbeddedParameters {
  const value = parameters as unknown as EmbeddedParameters;
  visiblePath(root, value.output_dir);
  const boundaries = [
    value.adc_max,
    value.on_threshold,
    value.off_threshold,
    value.fault_low,
    value.fault_high,
  ];
  if (
    !boundaries.every(Number.isSafeInteger) ||
    value.adc_max > 65535 ||
    !(
      0 <= value.fault_low &&
      value.fault_low < value.off_threshold &&
      value.off_threshold < value.on_threshold &&
      value.on_threshold < value.fault_high &&
      value.fault_high <= value.adc_max
    )
  )
    throw new Error(
      'Embedded boundaries require 0 <= fault_low < off_threshold < on_threshold < fault_high <= adc_max <= 65535.',
    );
  if (
    ![value.supply_v, value.load_ohm, value.on_ohm, value.off_ohm, value.tolerance].every(
      (number) => Number.isFinite(number) && number > 0,
    ) ||
    value.off_ohm <= value.on_ohm ||
    value.tolerance > 0.01
  )
    throw new Error(
      'Circuit parameters need positive finite values, off_ohm > on_ohm, and tolerance <= 0.01.',
    );
  for (const tool of ['compiler', 'ngspice'] as const)
    if (value[tool] !== undefined && (typeof value[tool] !== 'string' || !value[tool]!.trim()))
      throw new Error(`${tool} must be an executable path or name.`);
  if (value.compiler_family && !['gcc', 'dmc'].includes(value.compiler_family))
    throw new Error('Compiler family must be gcc or dmc.');
  return JSON.parse(JSON.stringify(value));
}
function normalizeParameters(
  root: string,
  id: string,
  parameters: Record<string, unknown>,
): Record<string, unknown> {
  if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters))
    throw new Error('Recipe parameters must be an object.');
  if (id === 'software-config-persistence')
    return softwareParameters(root, parameters) as unknown as Record<string, unknown>;
  if (id === 'embedded-hysteresis-load-control')
    return embeddedParameters(root, parameters) as unknown as Record<string, unknown>;
  if (!parameters.note || typeof parameters.note !== 'object')
    throw new Error('Cornell recipe parameters need the complete note input.');
  const note = parameters.note as CornellInput;
  visiblePath(root, note.path);
  visiblePath(root, note.practice?.exercise_path);
  visiblePath(root, note.practice?.answer_path);
  return JSON.parse(JSON.stringify(parameters));
}
function oracleFor(id: string, parameters: Record<string, unknown>): Record<string, unknown> {
  if (id === 'software-config-persistence') {
    const p = parameters as unknown as SoftwareParameters;
    const valid = {
      schemaVersion: p.schema_version,
      ...Object.fromEntries(Object.entries(p.fields).map(([key, field]) => [key, field.default])),
    };
    const invalid: unknown[] = [
      null,
      [],
      'configuration',
      { ...valid, schemaVersion: p.schema_version + 1 },
      { ...valid, unexpected: true },
    ];
    const boundary: unknown[] = [];
    for (const [key, field] of Object.entries(p.fields)) {
      const missing = { ...valid };
      delete (missing as Record<string, unknown>)[key];
      invalid.push(missing);
      invalid.push({
        ...valid,
        [key]: field.type === 'boolean' ? 'true' : field.type === 'string' ? 1 : '1',
      });
      if (field.type === 'integer') invalid.push({ ...valid, [key]: Number(field.default) + 0.5 });
      if (field.min !== undefined) {
        boundary.push({ ...valid, [key]: field.min });
        invalid.push({ ...valid, [key]: field.min - 1 });
      }
      if (field.max !== undefined) {
        boundary.push({ ...valid, [key]: field.max });
        invalid.push({ ...valid, [key]: field.max + 1 });
      }
      if (field.enum) {
        field.enum.forEach((item) => boundary.push({ ...valid, [key]: item }));
        if (field.type === 'boolean') {
          if (field.enum.length === 1) invalid.push({ ...valid, [key]: !field.default });
        } else {
          let outside =
            typeof field.default === 'string' ? '__outside_enum__' : Number(field.default) + 1;
          while (field.enum.includes(outside))
            outside = typeof outside === 'string' ? outside + '_' : outside + 1;
          invalid.push({ ...valid, [key]: outside });
        }
      }
    }
    // Enum restrictions can exclude numeric endpoints: only include cases permitted by the contract.
    const accepted = boundary.filter((item) =>
      Object.entries(p.fields).every(
        ([key, field]) =>
          !field.enum || field.enum.includes((item as Record<string, unknown>)[key]),
      ),
    );
    return {
      coverage: [
        'object shape',
        'exact schema',
        'missing/extra fields',
        'field types',
        'integer fractional rejection',
        'inclusive numeric bounds',
        'enum members',
        'missing file defaults',
        'round-trip persistence',
        'invalid save preservation',
        'malformed storage',
      ],
      valid,
      boundary: accepted,
      invalid,
      rationale:
        'Expected records derive from the declared input contract and bounds; the verifier does not call the implementation to compute expectations.',
    };
  }
  if (id === 'embedded-hysteresis-load-control') {
    const p = parameters as unknown as EmbeddedParameters;
    const cases: { adc: number; previous: number; expected: number }[] = [];
    for (let adc = 0; adc <= p.adc_max; adc++)
      for (const previous of [0, 1]) {
        let expected: number;
        // Partition the declared input domain independently from the generated controller.
        if (adc <= p.fault_low || adc >= p.fault_high) expected = 2;
        else if (adc <= p.off_threshold) expected = 0;
        else if (adc >= p.on_threshold) expected = 1;
        else expected = previous;
        cases.push({ adc, previous, expected });
      }
    cases.push(
      { adc: p.adc_max + 1, previous: 0, expected: 2 },
      { adc: p.on_threshold, previous: 2, expected: 2 },
    );
    const sequence = [
      p.fault_low,
      p.off_threshold,
      p.on_threshold - 1,
      p.on_threshold,
      p.on_threshold - 1,
      p.off_threshold + 1,
      p.off_threshold,
      p.fault_high,
      p.on_threshold,
    ];
    let previous = 0;
    const history = sequence.map((adc) => {
      const item = cases.find((entry) => entry.adc === adc && entry.previous === previous)!;
      previous = item.expected === 1 ? 1 : 0;
      return item;
    });
    return {
      coverage: [
        'complete ADC/prior-state domain',
        'inclusive fault boundaries',
        'inclusive switching thresholds',
        'hysteresis history',
        'ADC overflow',
        'invalid prior state',
        'ideal ON/OFF operating points',
        'declared circuit tolerance',
      ],
      cases,
      sequence: history,
      points: [p.on_ohm, p.off_ohm].map((resistance) => ({
        current: p.supply_v / (p.load_ohm + resistance),
        drain: (p.supply_v * resistance) / (p.load_ohm + resistance),
      })),
      tolerance: p.tolerance,
      rationale:
        'Finite ADC domain partitions implement the stated contract. Ideal resistive circuit expectations follow Ohm law; no transistor, timing, bench, or hardware safety claim is made.',
    };
  }
  return {
    coverage: [
      'exact quote',
      'required Cornell sections',
      'source ledger',
      'explicit expectation/observation distinction',
      'separate practice and answer',
    ],
    quote: cornellQuote,
    rationale:
      'Format and provenance checks establish document structure; independent review establishes educational and engineering correctness.',
  };
}
const softwareModule = (p: SoftwareParameters) => `import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
const FIELDS = ${JSON.stringify(p.fields)};
export const DEFAULT_CONFIG = Object.freeze(${JSON.stringify({ schemaVersion: p.schema_version, ...Object.fromEntries(Object.entries(p.fields).map(([key, field]) => [key, field.default])) })});
export function validateConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Configuration must be an object.');
  if (Object.keys(value).sort().join(',') !== ['schemaVersion', ...Object.keys(FIELDS)].sort().join(',')) throw new TypeError('Configuration fields differ from the schema.');
  if (value.schemaVersion !== ${p.schema_version}) throw new RangeError('Unsupported schema version.');
  for (const [key, field] of Object.entries(FIELDS)) {
    const item = value[key];
    if (field.type === 'integer' ? !Number.isSafeInteger(item) : typeof item !== field.type) throw new TypeError('Wrong type for ' + key);
    if (typeof item === 'number' && !Number.isFinite(item)) throw new RangeError('Non-finite number.');
    if ((field.min !== undefined && item < field.min) || (field.max !== undefined && item > field.max) || (field.enum && !field.enum.includes(item))) throw new RangeError('Outside bounds for ' + key);
  }
  return { ...value };
}
export async function loadConfig(file) { let text; try { text = await readFile(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return { ...DEFAULT_CONFIG }; throw error; } return validateConfig(JSON.parse(text)); }
export async function saveConfig(file, value) {
  const validated = validateConfig(value); const target = resolve(file); await mkdir(dirname(target), { recursive: true }); const temporary = target + '.' + randomUUID() + '.tmp';
  try { const handle = await open(temporary, 'wx', 0o600); try { await handle.writeFile(JSON.stringify(validated) + '\\n'); await handle.sync(); } finally { await handle.close(); } await rename(temporary, target); } finally { await rm(temporary, { force: true }); } return validated;
}
`;
function verifierFor(id: string, output: string, oraclePath: string): string {
  const header = `import assert from 'node:assert/strict';\nimport { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';\nimport { readFile, rm } from 'node:fs/promises';\nimport { resolve } from 'node:path';\nimport { pathToFileURL } from 'node:url';\nimport { spawnSync } from 'node:child_process';\nimport { createHash, randomUUID } from 'node:crypto';\nconst p = JSON.parse(readFileSync(${JSON.stringify(`${dirname(oraclePath)}/parameters.json`)}, 'utf8'));\nconst oracle = JSON.parse(readFileSync(${JSON.stringify(oraclePath)}, 'utf8'));\nconst out = ${JSON.stringify(output)};\n`;
  if (id === 'software-config-persistence')
    return (
      header +
      `const api = await import(pathToFileURL(resolve(out, 'config.mjs')).href);
// Expectations remain in the protected oracle; only disposable copies reach the implementation.
for (const expected of [oracle.valid, ...oracle.boundary]) assert.deepEqual(api.validateConfig(structuredClone(expected)), expected);
for (const value of oracle.invalid) assert.throws(() => api.validateConfig(structuredClone(value)));
const file = resolve(out, '.recipe-storage-test.json');
try {
  await rm(file, { force: true }); assert.deepEqual(await api.loadConfig(file), oracle.valid);
  for (const expected of [oracle.valid, ...oracle.boundary]) { await api.saveConfig(file, structuredClone(expected)); assert.deepEqual(await api.loadConfig(file), expected); }
  await api.saveConfig(file, structuredClone(oracle.valid)); const before = await readFile(file, 'utf8');
  for (const invalid of oracle.invalid) { await assert.rejects(api.saveConfig(file, structuredClone(invalid))); assert.equal(await readFile(file, 'utf8'), before); }
  writeFileSync(file, '{broken'); await assert.rejects(api.loadConfig(file)); assert.equal(await readFile(file, 'utf8'), '{broken');
} finally { await rm(file, { force: true }); }
console.log(JSON.stringify({ status: 'passed', valid: 1 + oracle.boundary.length, invalid: oracle.invalid.length, method: 'node-validation-and-storage' }));
`
    );
  if (id === 'embedded-hysteresis-load-control')
    return (
      header +
      `const api = await import(pathToFileURL(resolve(out, 'controller.mjs')).href);
for (const c of oracle.cases) assert.equal(api.controllerStep(c.adc, c.previous), c.expected);
for (const c of oracle.sequence) assert.equal(api.controllerStep(c.adc, c.previous), c.expected);
for (const [index, state] of [true, false].entries()) { const point = api.operatingPoint(state); for (const key of ['current', 'drain']) assert.ok(Math.abs(point[key] - oracle.points[index][key]) <= p.tolerance * Math.max(1e-12, Math.abs(oracle.points[index][key]))); }
const circuit = readFileSync(resolve(out, 'load-switch.cir'), 'utf8');
for (const expected of ['DC ' + p.supply_v, 'drain ' + p.load_ohm, 'Ron=' + p.on_ohm, 'Roff=' + p.off_ohm]) assert.ok(circuit.includes(expected), 'Circuit parameter mismatch: ' + expected);
let native = 'not requested'; let spice = 'not requested';
if (p.compiler) {
  const family = p.compiler_family ?? 'gcc'; const build = resolve('.verythinker/cache/recipe-native', randomUUID()); mkdirSync(build, {recursive: true});
  for (const name of ['controller.c', 'controller.h', 'firmware-test.c']) copyFileSync(resolve(out, name), resolve(build, name));
  const executable = resolve(build, process.platform === 'win32' ? 'firmware-test.exe' : 'firmware-test');
  const args = family === 'dmc' ? ['controller.c', 'firmware-test.c', '-mn', '-wx', '-ofirmware-test.exe'] : ['-std=c11', '-Wall', '-Wextra', '-Werror', 'controller.c', 'firmware-test.c', '-o', executable];
  const version = spawnSync(p.compiler, family === 'dmc' ? [] : ['--version'], { cwd: build, encoding: 'utf8', timeout: 5000, windowsHide: true });
  const compiled = spawnSync(p.compiler, args, { cwd: build, encoding: 'utf8', timeout: 60000, windowsHide: true });
  assert.equal(compiled.status, 0, 'C compiler failed: ' + compiled.stdout + compiled.stderr);
  const run = spawnSync(executable, [], { cwd: build, encoding: 'utf8', timeout: 60000, windowsHide: true }); assert.equal(run.status, 0, 'C harness failed');
  const actual = run.stdout.trim().split(/\\r?\\n/).map(Number); assert.equal(actual.length, oracle.cases.length); actual.forEach((value, index) => assert.equal(value, oracle.cases[index].expected));
  native = { comparisons: actual.length, compiler: p.compiler, family, version: (version.stdout || version.stderr).split(/\\r?\\n/)[0], arguments: args, executable_sha256: createHash('sha256').update(readFileSync(executable)).digest('hex'), results_sha256: createHash('sha256').update(run.stdout).digest('hex') };
}
if (p.ngspice) {
  for (const [index, state] of ['on', 'off'].entries()) {
    const result = spawnSync(p.ngspice, ['-b', state + '.cir'], { cwd: resolve(out), encoding: 'utf8', timeout: 60000, windowsHide: true });
    assert.equal(result.status, 0, 'SPICE failed: ' + result.stderr);
    const current = result.stdout.match(/vt_current\\s*=\\s*([-+0-9.eE]+)/i); const drain = result.stdout.match(/vt_drain\\s*=\\s*([-+0-9.eE]+)/i);
    assert.ok(current && drain, 'SPICE measurement vectors missing');
    for (const [key, match] of [['current', current], ['drain', drain]]) assert.ok(Math.abs(Number(match[1]) - oracle.points[index][key]) <= p.tolerance * Math.max(1e-12, Math.abs(oracle.points[index][key])), 'SPICE differs from reviewed ideal circuit expectation');
  } spice = 'two ideal DC points';
}
console.log(JSON.stringify({ status: 'passed', comparisons: oracle.cases.length + oracle.sequence.length, native, spice, limitations: ['Host and ideal circuit only; no MCU, transient, physical-board, or safety proof.'] }));
`
    );
  return (
    header +
    `const note = readFileSync(p.note.path, 'utf8'); assert.ok(note.includes(oracle.quote));
for (const section of ['Cue Column', 'Main Notes', 'Demonstration', 'Failure Cases', 'Practice', 'Summary', 'Sources']) assert.ok(note.includes('## ' + section));
assert.ok(note.includes('[expected]')); assert.ok(note.includes('[S1]'));
assert.notEqual(p.note.practice.exercise_path, p.note.practice.answer_path); readFileSync(p.note.practice.exercise_path); readFileSync(p.note.practice.answer_path);
console.log(JSON.stringify({ status: 'passed', method: 'Cornell-format-inspection', content_quality: 'independent review required' }));
`
  );
}
function recipeInstances(root: string, target?: ProjectRecord | string): ProjectRecord[] {
  const records = loadRecords(root);
  const record = typeof target === 'string' ? getRecord(root, target) : target;
  if (record?.meta.data.kind === 'recipe-instance') return [record];
  const ids = record
    ? [
        record.meta.data.recipe_instance_id,
        ...(Array.isArray(record.meta.data.recipe_instance_ids)
          ? record.meta.data.recipe_instance_ids
          : []),
      ].filter((value): value is string => typeof value === 'string')
    : null;
  return records.filter(
    (item) =>
      item.meta.data.kind === 'recipe-instance' &&
      (!record || ids!.includes(item.meta.id) || item.meta.data.task_id === record.meta.id) &&
      item.meta.status !== 'superseded',
  );
}
/** Cheap implementation and acceptance both check these immutable, reviewed inputs. */
export function verifyFrozenRecipe(root: string, target?: ProjectRecord | string): string[] {
  const problems: string[] = [];
  for (const instance of recipeInstances(root, target)) {
    const data = instance.meta.data;
    try {
      const descriptor = resolveRecipe(String(data.recipe_id), String(data.recipe_version));
      if (descriptor.hash !== data.recipe_hash)
        problems.push(
          `${instance.meta.id}: installed recipe changed; resolve a reviewed replacement.`,
        );
      const protectedFiles = data.protected_files as Record<string, string>;
      if (!protectedFiles || typeof protectedFiles !== 'object')
        throw new Error('Missing frozen files.');
      for (const [path, digest] of Object.entries(protectedFiles))
        if (
          !existsSync(safePath(root, path)) ||
          hash(readFileSync(safePath(root, path))) !== digest
        )
          problems.push(`${instance.meta.id}: protected recipe artifact changed: ${path}`);
      if (hash(canonical(data.parameters)) !== data.parameters_hash)
        problems.push(`${instance.meta.id}: recipe parameters changed.`);
      const records = data.protected_records as Record<string, string>;
      if (!records || typeof records !== 'object' || !Object.keys(records).length)
        throw new Error('Missing frozen design/check records.');
      for (const [id, digest] of Object.entries(records))
        if (contractFingerprint(getRecord(root, id)) !== digest)
          problems.push(`${instance.meta.id}: protected engineering record changed: ${id}`);
      for (const id of [data.design_id, data.check_id]) {
        if (typeof id !== 'string') throw new Error('Missing recipe design/check identity.');
        const contract = getRecord(root, id).meta.data;
        if (
          canonical(contract.protected_file_hashes) !== canonical(protectedFiles) ||
          contract.parameters_hash !== data.parameters_hash ||
          contract.recipe_hash !== data.recipe_hash ||
          canonical(contract.requirement_baselines) !== canonical(data.requirement_baselines)
        )
          problems.push(
            `${instance.meta.id}: frozen snapshot differs from its reviewed engineering contract.`,
          );
      }
      for (const [id, digest] of Object.entries(
        data.requirement_baselines as Record<string, string>,
      ))
        if (recordFingerprint(getRecord(root, id)) !== digest)
          problems.push(`${instance.meta.id}: recipe requirement changed: ${id}`);
      if (data.preparation_complete !== true)
        problems.push(`${instance.meta.id}: recipe preparation is incomplete.`);
      if (
        target &&
        (typeof target === 'string' ? getRecord(root, target) : target).meta.type === 'task'
      )
        for (const reviewId of [data.design_id, data.check_id])
          if (typeof reviewId !== 'string' || !hasCurrentReview(root, reviewId))
            problems.push(
              `${instance.meta.id}: recipe design and verification plan require current independent reviews.`,
            );
    } catch (error) {
      problems.push(
        `${instance.meta.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  const targetRecord = typeof target === 'string' ? getRecord(root, target) : target;
  if (targetRecord?.meta.type === 'task') {
    const ids = Array.isArray(targetRecord.meta.data.recipe_instance_ids)
      ? (targetRecord.meta.data.recipe_instance_ids as string[])
      : [];
    const records = loadRecords(root);
    const reachesReviewed = (
      replacement: ProjectRecord,
      wanted: string,
      seen = new Set<string>(),
    ): boolean => {
      if (replacement.meta.id === wanted) return true;
      if (
        seen.has(replacement.meta.id) ||
        replacement.meta.data.kind !== 'recipe-instance' ||
        replacement.meta.data.task_id !== targetRecord.meta.id ||
        typeof replacement.meta.data.change_id !== 'string' ||
        !hasCurrentReview(root, replacement.meta.data.change_id)
      )
        return false;
      const visited = new Set([...seen, replacement.meta.id]);
      return replacement.meta.links
        .filter((link) => link.type === 'supersedes')
        .some((link) => {
          const previous = records.find((record) => record.meta.id === link.target);
          return Boolean(previous && reachesReviewed(previous, wanted, visited));
        });
    };
    for (const id of ids) {
      const historical = records.find((record) => record.meta.id === id);
      if (!historical || historical.meta.data.kind !== 'recipe-instance') {
        problems.push(`Recipe assignment reference is missing: ${id}`);
        continue;
      }
      if (
        historical.meta.status === 'superseded' &&
        !records.some(
          (replacement) =>
            replacement.meta.data.kind === 'recipe-instance' &&
            replacement.meta.data.task_id === targetRecord.meta.id &&
            replacement.meta.status !== 'superseded' &&
            reachesReviewed(replacement, id),
        )
      )
        problems.push(`Superseded recipe lacks a current reviewed replacement: ${id}`);
    }
  }
  return problems;
}
export function prepareRecipe(root: string, input: RecipeInput): ProjectRecord {
  return prepareRecipeInstance(root, input);
}
function prepareRecipeInstance(
  root: string,
  input: RecipeInput,
  replacementIdentity?: { supersedes: string; change_id: string },
): ProjectRecord {
  readConfig(root);
  const descriptor = resolveRecipe(input.recipe_id, input.version);
  const parameters = normalizeParameters(root, input.recipe_id, input.parameters);
  const assignedTask = input.task_id ? getRecord(root, input.task_id) : undefined;
  const taskWorkflow = assignedTask?.meta.data.workflow_id;
  if (input.workflow_id && taskWorkflow && input.workflow_id !== taskWorkflow)
    throw new Error('Recipe workflow conflicts with the assigned task workflow.');
  const workflowId =
    input.workflow_id ?? (typeof taskWorkflow === 'string' ? taskWorkflow : undefined);
  if (workflowId) {
    const workflow = getRecord(root, workflowId);
    if (workflow.meta.type !== 'knowledge' || workflow.meta.data.kind !== 'manager-workflow')
      throw new Error('Recipe workflow must identify an existing manager workflow.');
  }
  if (
    !input.requirement_ids?.length ||
    new Set(input.requirement_ids).size !== input.requirement_ids.length
  )
    throw new Error('Recipes need distinct requirement IDs.');
  const requirementBaselines = Object.fromEntries(
    input.requirement_ids.map((id) => {
      const record = getRecord(root, id);
      if (record.meta.type !== 'requirement') throw new Error(`Expected requirement: ${id}`);
      return [id, recordFingerprint(record)];
    }),
  );
  const requestHash = hash(
    canonical({
      ...input,
      ...(workflowId ? { workflow_id: workflowId } : {}),
      parameters,
      version: descriptor.version,
      recipe_hash: descriptor.hash,
      requirement_baselines: requirementBaselines,
      ...(replacementIdentity ? { replacement: replacementIdentity } : {}),
    }),
  );
  return withOperationLock(root, `recipe-${requestHash.slice(0, 32)}`, () => {
    const existing = loadRecords(root).find(
      (record) =>
        record.meta.data.kind === 'recipe-instance' &&
        record.meta.data.request_hash === requestHash &&
        record.meta.status !== 'superseded',
    );
    if (existing?.meta.data.preparation_complete === true) return existing;
    assertCurrentGeneratorModule();
    if (!existing && !replacementIdentity) {
      const stale = loadRecords(root).find(
        (record) =>
          record.meta.data.kind === 'recipe-instance' &&
          record.meta.status !== 'superseded' &&
          record.meta.data.recipe_id === descriptor.id &&
          record.meta.data.recipe_version === descriptor.version &&
          record.meta.data.parameters_hash === hash(canonical(parameters)) &&
          (!input.task_id || record.meta.data.task_id === input.task_id) &&
          canonical(
            Object.keys(record.meta.data.requirement_baselines as Record<string, string>).sort(),
          ) === canonical([...input.requirement_ids].sort()) &&
          (record.meta.data.recipe_hash !== descriptor.hash ||
            canonical(record.meta.data.requirement_baselines) !== canonical(requirementBaselines)),
      );
      if (stale)
        throw new Error(
          'Recipe generator or requirements changed; record a reviewed replacement before preparing the same parameters.',
        );
    }
    if (
      existing &&
      (existing.meta.data.recipe_hash !== descriptor.hash ||
        canonical(existing.meta.data.requirement_baselines) !== canonical(requirementBaselines))
    )
      throw new Error(
        'Interrupted recipe inputs changed; record a reviewed replacement before continuing.',
      );
    let task = existing
      ? getRecord(root, String(existing.meta.data.task_id))
      : input.task_id
        ? getRecord(root, input.task_id)
        : createRecord(root, {
            type: 'task',
            title: `Apply ${descriptor.id}`,
            owner: input.owner ?? 'developer',
            links: input.requirement_ids.map((id) => ({ type: 'satisfies', target: id })),
            data: {
              acceptance_criteria: [
                `Apply reviewed ${descriptor.id} parameters and pass its frozen verification plan.`,
              ],
              allowed_paths:
                input.recipe_id === 'cornell-evidence-note'
                  ? [
                      ...new Set(
                        [
                          (parameters.note as CornellInput).path!,
                          (parameters.note as CornellInput).practice.exercise_path,
                          (parameters.note as CornellInput).practice.answer_path,
                          ...((parameters.note as CornellInput).practice.solution_path
                            ? [(parameters.note as CornellInput).practice.solution_path!]
                            : []),
                        ].map((path) => dirname(path)),
                      ),
                    ]
                  : [parameters.output_dir],
              requirements: input.requirement_ids,
              ...(workflowId
                ? { workflow_id: workflowId, documentation_required: true, documentation_paths: [] }
                : {}),
            },
            body: 'Execute the reviewed parameterized recipe, record actual checks, and submit substantive work documentation.',
          });
    if (task.meta.type !== 'task' || !['draft', 'ready', 'blocked'].includes(task.meta.status))
      throw new Error('Prepare a recipe for a draft, ready, or blocked task.');
    if (workflowId && task.meta.data.workflow_id && task.meta.data.workflow_id !== workflowId)
      throw new Error('Recipe workflow conflicts with the assigned task workflow.');
    if (
      workflowId &&
      (task.meta.data.workflow_id !== workflowId ||
        task.meta.data.documentation_required !== true ||
        task.meta.data.documentation_paths === undefined)
    ) {
      task = updateRecord(root, task.meta.id, {
        data: {
          workflow_id: workflowId,
          documentation_required: true,
          ...(task.meta.data.documentation_paths === undefined ? { documentation_paths: [] } : {}),
        },
      });
    }
    const output =
      input.recipe_id === 'cornell-evidence-note'
        ? dirname((parameters.note as CornellInput).path!)
        : String(parameters.output_dir);
    const allowed = Array.isArray(task.meta.data.allowed_paths)
      ? (task.meta.data.allowed_paths as string[])
      : [];
    const writePaths =
      input.recipe_id === 'cornell-evidence-note'
        ? [
            (parameters.note as CornellInput).path!,
            (parameters.note as CornellInput).practice.exercise_path,
            (parameters.note as CornellInput).practice.answer_path,
            ...((parameters.note as CornellInput).practice.solution_path
              ? [(parameters.note as CornellInput).practice.solution_path!]
              : []),
          ]
        : [output];
    if (
      writePaths.some(
        (target) => !allowed.some((path) => target === path || target.startsWith(`${path}/`)),
      )
    )
      throw new Error('Recipe output directory lies outside the assigned task scope.');
    const instance =
      existing ??
      createRecord(root, {
        type: 'knowledge',
        title: `${descriptor.id} ${descriptor.version}`,
        owner: 'architect',
        links: [
          { type: 'documents', target: task.meta.id },
          ...input.requirement_ids.map((id) => ({ type: 'references' as const, target: id })),
        ],
        data: {
          kind: 'recipe-instance',
          recipe_id: descriptor.id,
          recipe_version: descriptor.version,
          recipe_hash: descriptor.hash,
          parameters,
          parameters_hash: hash(canonical(parameters)),
          request_hash: requestHash,
          task_id: task.meta.id,
          ...(typeof task.meta.data.workflow_id === 'string'
            ? { workflow_id: task.meta.data.workflow_id }
            : {}),
          requirement_baselines: requirementBaselines,
          preparation_complete: false,
        },
        body: `# Recipe\n${descriptor.id}@${descriptor.version}\n\n# Applicability\n${descriptor.applicability}\n\n# Review\nThe design and verification plan require separate current reviews before implementation.\n`,
      });
    const directory = `.verythinker/recipes/${instance.meta.id}`;
    const parameterPath = `${directory}/parameters.json`;
    const oraclePath = `${directory}/oracle.json`;
    const verifierPath = `${directory}/verify.mjs`;
    const plan = oracleFor(descriptor.id, parameters);
    const preparedArtifacts: [string, string][] = [
      [parameterPath, canonical(parameters) + '\n'],
      [oraclePath, JSON.stringify(plan, null, 2) + '\n'],
      [verifierPath, verifierFor(descriptor.id, output, oraclePath)],
    ];
    for (const [path, content] of preparedArtifacts) {
      if (
        existsSync(safePath(root, path)) &&
        hash(readFileSync(safePath(root, path))) !== hash(content)
      )
        throw new Error(`Interrupted protected recipe artifact changed: ${path}`);
      atomicWrite(safePath(root, path), content);
    }
    const protectedFiles = snapshotPaths(root, [directory]);
    const design =
      loadRecords(root).find(
        (record) =>
          record.meta.type === 'design' &&
          record.meta.data.kind === 'recipe-design' &&
          record.meta.data.recipe_instance_id === instance.meta.id,
      ) ??
      createRecord(root, {
        type: 'design',
        title: `Recipe contract: ${descriptor.id}`,
        owner: 'architect',
        links: input.requirement_ids.map((id) => ({ type: 'satisfies', target: id })),
        data: {
          kind: 'recipe-design',
          recipe_instance_id: instance.meta.id,
          task_id: task.meta.id,
          ...(typeof task.meta.data.workflow_id === 'string'
            ? { workflow_id: task.meta.data.workflow_id }
            : {}),
          parameters_hash: hash(canonical(parameters)),
          recipe_hash: descriptor.hash,
          protected_file_hashes: protectedFiles,
          requirement_baselines: requirementBaselines,
          interfaces: [descriptor.applicability],
          baseline_paths: [parameterPath, oraclePath],
          ...(descriptor.id === 'embedded-hysteresis-load-control'
            ? {
                hardware_software_interface: {
                  input: 'Unsigned ADC count and prior switch state',
                  output: '0 OFF, 1 ON, 2 fail-safe fault',
                  circuit:
                    'Ideal resistive load switch; measured hardware allocation remains a separate requirement.',
                },
              }
            : {}),
        },
        body: `# Interfaces and Parameters\n${canonical(parameters)}\n\n# Verification Strategy\n${JSON.stringify(plan.coverage)}\n\n# Oracle Rationale\n${plan.rationale}\n\n# Demonstrated Limits\n${descriptor.limitations.join('\n')}\n`,
      });
    const outputs =
      descriptor.id === 'cornell-evidence-note'
        ? [
            (parameters.note as CornellInput).path!,
            (parameters.note as CornellInput).practice.exercise_path,
            (parameters.note as CornellInput).practice.answer_path,
          ]
        : [output];
    const check =
      loadRecords(root).find(
        (record) =>
          record.meta.type === 'check' &&
          record.meta.data.kind === 'recipe-check' &&
          record.meta.data.recipe_instance_id === instance.meta.id,
      ) ??
      createRecord(root, {
        type: 'check',
        title: `Frozen recipe verification: ${descriptor.id}`,
        owner: 'verifier',
        links: [
          { type: 'verifies', target: task.meta.id },
          ...input.requirement_ids.map((id) => ({ type: 'verifies' as const, target: id })),
        ],
        data: {
          kind: 'recipe-check',
          recipe_instance_id: instance.meta.id,
          task_id: task.meta.id,
          ...(typeof task.meta.data.workflow_id === 'string'
            ? { workflow_id: task.meta.data.workflow_id }
            : {}),
          parameters_hash: hash(canonical(parameters)),
          recipe_hash: descriptor.hash,
          protected_file_hashes: protectedFiles,
          requirement_baselines: requirementBaselines,
          command: [process.execPath, verifierPath],
          baseline_paths: [...outputs, directory],
          expected_exit_code: 0,
          timeout_ms: 120000,
          method:
            descriptor.id === 'embedded-hysteresis-load-control'
              ? 'simulation-and-optional-native-C-SPICE'
              : 'parameterized-recipe',
          protected_acceptance_paths: [parameterPath, oraclePath, verifierPath],
        },
        body: `# Coverage\n${JSON.stringify(plan.coverage)}\n\n# Expected Results and Tolerance\n${oraclePath}\n\n# Independent Oracle Rationale\n${plan.rationale}\n`,
      });
    for (const contract of [design, check])
      if (
        contract.meta.data.parameters_hash !== hash(canonical(parameters)) ||
        contract.meta.data.recipe_hash !== descriptor.hash ||
        canonical(contract.meta.data.protected_file_hashes) !== canonical(protectedFiles) ||
        canonical(contract.meta.data.requirement_baselines) !== canonical(requirementBaselines)
      )
        throw new Error('Interrupted recipe engineering contract differs from its frozen inputs.');
    if (
      canonical(check.meta.data.command) !== canonical([process.execPath, verifierPath]) ||
      canonical(check.meta.data.baseline_paths) !== canonical([...outputs, directory]) ||
      check.meta.data.expected_exit_code !== 0 ||
      check.meta.owner !== 'verifier' ||
      design.meta.owner !== 'architect'
    )
      throw new Error('Interrupted recipe verification contract changed.');
    const prepared = updateRecord(root, instance.meta.id, {
      data: {
        design_id: design.meta.id,
        check_id: check.meta.id,
        protected_files: protectedFiles,
        protected_records: {
          [design.meta.id]: contractFingerprint(design),
          [check.meta.id]: contractFingerprint(check),
        },
        preparation_complete: true,
        output_paths: outputs,
      },
    });
    const ids = Array.isArray(task.meta.data.recipe_instance_ids)
      ? (task.meta.data.recipe_instance_ids as string[])
      : [];
    updateRecord(root, task.meta.id, {
      data: {
        recipe_instance_ids: [...new Set([...ids, instance.meta.id])],
        protected_acceptance_paths: [
          ...new Set([
            ...(Array.isArray(task.meta.data.protected_acceptance_paths)
              ? (task.meta.data.protected_acceptance_paths as string[])
              : []),
            ...Object.keys(protectedFiles),
          ]),
        ],
      },
    });
    return prepared;
  });
}
function writePreserving(
  root: string,
  path: string,
  content: string,
  generated: Record<string, string> = {},
  prior: Record<string, string> = {},
): void {
  if (existsSync(safePath(root, path))) {
    const currentHash = statSync(safePath(root, path)).isFile()
      ? hash(readFileSync(safePath(root, path)))
      : null;
    if (currentHash !== hash(content) && (!currentHash || currentHash !== prior[path]))
      throw new Error(`Recipe preserves authored edits; inspect or use a new output path: ${path}`);
    if (currentHash === hash(content)) {
      generated[path] = currentHash;
      return;
    }
  }
  atomicWrite(safePath(root, path), content);
  generated[path] = hash(content);
}
function generateEmbedded(
  root: string,
  p: EmbeddedParameters,
  oracle: Record<string, unknown>,
  generated: Record<string, string>,
  prior: Record<string, string>,
): void {
  const d = p.output_dir;
  const write = (path: string, content: string) =>
    writePreserving(root, path, content, generated, prior);
  write(
    `${d}/controller.h`,
    '#ifndef VERYTHINKER_RECIPE_CONTROLLER_H\n#define VERYTHINKER_RECIPE_CONTROLLER_H\nunsigned controller_step(unsigned adc, unsigned previous);\n#endif\n',
  );
  write(
    `${d}/controller.c`,
    `#include "controller.h"\nunsigned controller_step(unsigned adc, unsigned previous) {\n  if (previous > 1u || adc > ${p.adc_max}u || adc <= ${p.fault_low}u || adc >= ${p.fault_high}u) return 2u;\n  if (adc >= ${p.on_threshold}u) return 1u;\n  if (adc <= ${p.off_threshold}u) return 0u;\n  return previous;\n}\n`,
  );
  write(
    `${d}/controller.mjs`,
    `export function controllerStep(adc, previous) {\n  if (!Number.isInteger(adc) || adc < 0 || adc > ${p.adc_max} || ![0, 1].includes(previous) || adc <= ${p.fault_low} || adc >= ${p.fault_high}) return 2;\n  return adc >= ${p.on_threshold} ? 1 : adc <= ${p.off_threshold} ? 0 : previous;\n}\nexport function operatingPoint(on) { if (typeof on !== 'boolean') throw new TypeError('Boolean switch state required.'); const r = on ? ${p.on_ohm} : ${p.off_ohm}; const current = ${p.supply_v} / (${p.load_ohm} + r); return { current, drain: current * r }; }\n`,
  );
  const netlist = (on: boolean) =>
    `VeryThinker parameterized ideal load switch\n* Ideal switch; no selected transistor or physical board proof.\nVSUPPLY supply 0 DC ${p.supply_v}\nVCONTROL control 0 DC ${on ? 3.3 : 0}\nRLOAD supply drain ${p.load_ohm}\nSLOAD drain 0 control 0 LOADSWITCH\n.model LOADSWITCH SW(Ron=${p.on_ohm} Roff=${p.off_ohm} Vt=1.65 Vh=0.1)\n.op\n.control\nset numdgt=15\nop\nlet vt_current = -vsupply#branch\nlet vt_drain = v(drain)\nprint vt_current vt_drain\nquit\n.endc\n.end\n`;
  write(`${d}/load-switch.cir`, netlist(true));
  write(`${d}/on.cir`, netlist(true));
  write(`${d}/off.cir`, netlist(false));
  write(
    `${d}/firmware-test.c`,
    `#include <stdio.h>\n#include "controller.h"\nint main(void) {\n  unsigned adc, previous;\n  for (adc = 0; adc <= ${p.adc_max}u; ++adc)\n    for (previous = 0; previous < 2u; ++previous)\n      printf("%u\\n", controller_step(adc, previous));\n  printf("%u\\n", controller_step(${p.adc_max + 1}u, 0u));\n  printf("%u\\n", controller_step(${p.on_threshold}u, 2u));\n  return 0;\n}\n`,
  );
}
export function runRecipe(
  root: string,
  id: string,
  invocationId?: string,
): {
  instance: ProjectRecord;
  evidence?: ProjectRecord;
  verification_pending?: boolean;
  note?: ProjectRecord;
} {
  return withOperationLock(root, `recipe-run-${hash(id).slice(0, 32)}`, () => {
    const instance = getRecord(root, id);
    if (
      instance.meta.data.kind !== 'recipe-instance' ||
      instance.meta.data.preparation_complete !== true
    )
      throw new Error('Recipe preparation is incomplete.');
    const problems = verifyFrozenRecipe(root, instance);
    if (problems.length) throw new Error(problems.join('\n'));
    const task = getRecord(root, String(instance.meta.data.task_id));
    const routing = readRoutingPolicy(root);
    if (
      !routing &&
      (task.meta.data.routing_required === true || instance.meta.data.routing_required === true)
    )
      throw new Error('Strict recipe routing policy is missing; restore it before execution.');
    for (const reviewId of [instance.meta.data.design_id, instance.meta.data.check_id])
      if (typeof reviewId !== 'string' || !hasCurrentReview(root, reviewId))
        throw new Error(
          'Recipe design and verification plan require current independent reviews before implementation.',
        );
    if (task.meta.status !== 'in-progress')
      throw new Error('Start the bounded task before running its recipe.');
    let verificationPending = false;
    if (routing) {
      if (!invocationId)
        throw new Error('Strict recipe execution requires a native invocation receipt.');
      const receipt = readInvocation(root, invocationId);
      if (!['developer', 'check-executor'].includes(receipt.role))
        throw new Error('Only assigned developers and check executors run recipes.');
      assertRouting(root, receipt.role, invocationId, {
        task_id: task.meta.id,
        workflow_id:
          typeof task.meta.data.workflow_id === 'string' ? task.meta.data.workflow_id : undefined,
        require_completed: false,
      });
      verificationPending = receipt.role === 'developer';
    }
    const parameters = instance.meta.data.parameters as Record<string, unknown>;
    const generated: Record<string, string> = {};
    const prior: Record<string, string> = {};
    if (
      typeof instance.meta.data.change_id === 'string' &&
      hasCurrentReview(root, instance.meta.data.change_id)
    ) {
      const change = getRecord(root, instance.meta.data.change_id);
      for (const link of instance.meta.links.filter((link) => link.type === 'supersedes')) {
        const previous = getRecord(root, link.target);
        if (
          previous.meta.data.kind !== 'recipe-instance' ||
          previous.meta.data.task_id !== instance.meta.data.task_id ||
          previous.meta.data.workflow_id !== instance.meta.data.workflow_id ||
          previous.meta.data.recipe_id !== instance.meta.data.recipe_id ||
          !change.meta.links.some((reference) => reference.target === previous.meta.id)
        )
          throw new Error('Generated output replacement escapes the reviewed recipe history.');
        for (const [path, checksum] of Object.entries(
          (previous.meta.data.generated_files as Record<string, string>) ?? {},
        ))
          if (
            !prior[path] ||
            (existsSync(safePath(root, path)) &&
              hash(readFileSync(safePath(root, path))) === checksum)
          )
            prior[path] = checksum;
      }
    }
    let note: ProjectRecord | undefined;
    if (instance.meta.data.recipe_id === 'software-config-persistence') {
      const p = softwareParameters(root, parameters);
      writePreserving(root, `${p.output_dir}/config.mjs`, softwareModule(p), generated, prior);
      writePreserving(
        root,
        `${p.output_dir}/README.md`,
        `# Configuration Persistence\n\nThe module validates exact schema ${p.schema_version}, provides missing-file defaults, and atomically saves validated JSON.\nRun the linked recipe check from the project root.\n\nDeclared fields: ${JSON.stringify(p.fields)}\n`,
        generated,
        prior,
      );
    } else if (instance.meta.data.recipe_id === 'embedded-hysteresis-load-control') {
      const p = embeddedParameters(root, parameters);
      generateEmbedded(
        root,
        p,
        JSON.parse(readFileSync(safePath(root, `.verythinker/recipes/${id}/oracle.json`), 'utf8')),
        generated,
        prior,
      );
      writePreserving(
        root,
        `${p.output_dir}/README.md`,
        '# Hysteresis Load Control\n\nReturns 0 for OFF, 1 for ON, and 2 for fail-safe fault. Prior state is retained between inclusive OFF/ON thresholds. Fault bounds are inclusive.\nC and JavaScript implement the declared finite ADC contract; SPICE uses an ideal switch. Host simulation cannot establish physical hardware safety or timing.\n',
        generated,
        prior,
      );
    } else {
      const priorId = instance.meta.data.note_id;
      if (typeof priorId === 'string') {
        note = getRecord(root, priorId);
        const validation = validateCornellNote(root, priorId);
        if (!validation.ok) throw new Error(validation.problems.join('\n'));
      } else {
        const noteInput = parameters.note as CornellInput;
        note = createCornellNote(root, {
          ...noteInput,
          requirement_ids: [
            ...new Set([
              ...(noteInput.requirement_ids ?? []),
              ...Object.keys(instance.meta.data.requirement_baselines as Record<string, string>),
            ]),
          ],
        });
        note = updateRecord(root, note.meta.id, {
          links: [...note.meta.links, { type: 'documents', target: task.meta.id }],
        });
        updateRecord(root, id, { data: { note_id: note.meta.id } });
      }
    }
    const after = verifyFrozenRecipe(root, instance);
    if (after.length) throw new Error(after.join('\n'));
    if (Object.keys(generated).length)
      updateRecord(root, id, { data: { generated_files: generated, generated_at: now() } });
    if (verificationPending)
      return {
        instance: getRecord(root, id),
        verification_pending: true,
        ...(note ? { note } : {}),
      };
    const evidence = runCheck(
      root,
      String(instance.meta.data.check_id),
      String(instance.meta.data.task_id),
      invocationId,
    );
    return { instance: getRecord(root, id), evidence, ...(note ? { note } : {}) };
  });
}
/** Replace a specification through an explicit, independently reviewed change. */
export function reviseRecipe(
  root: string,
  id: string,
  input: { change_id: string; parameters: Record<string, unknown>; reason: string },
): ProjectRecord {
  const instance = getRecord(root, id);
  const change = getRecord(root, input.change_id);
  if (
    instance.meta.data.kind !== 'recipe-instance' ||
    change.meta.type !== 'change' ||
    !change.meta.links.some((link) => link.target === id) ||
    !hasCurrentReview(root, change.meta.id) ||
    typeof input.reason !== 'string' ||
    input.reason.trim().length < 24
  )
    throw new Error(
      'Recipe revision requires a linked current reviewed change and substantive rationale.',
    );
  const retired = loadRecords(root).filter(
    (record) =>
      record.meta.data.kind === 'recipe-instance' &&
      record.meta.data.task_id === instance.meta.data.task_id &&
      record.meta.data.workflow_id === instance.meta.data.workflow_id &&
      record.meta.data.recipe_id === instance.meta.data.recipe_id &&
      change.meta.links.some((link) => link.target === record.meta.id),
  );
  const retiredIds = retired.map((record) => record.meta.id).sort();
  const replacement = prepareRecipeInstance(
    root,
    {
      recipe_id: String(instance.meta.data.recipe_id),
      version: String(instance.meta.data.recipe_version),
      parameters: input.parameters,
      requirement_ids: Object.keys(
        instance.meta.data.requirement_baselines as Record<string, string>,
      ),
      task_id: String(instance.meta.data.task_id),
      ...(typeof instance.meta.data.workflow_id === 'string'
        ? { workflow_id: instance.meta.data.workflow_id }
        : {}),
    },
    { supersedes: id, change_id: change.meta.id },
  );
  if (replacement.meta.id === instance.meta.id)
    throw new Error('Recipe revision requires a distinct reviewed replacement.');
  updateRecord(root, replacement.meta.id, {
    links: [
      ...replacement.meta.links.filter(
        (link) =>
          !(link.type === 'supersedes' && retiredIds.includes(link.target)) &&
          !(link.type === 'references' && link.target === change.meta.id),
      ),
      ...retiredIds.map((target) => ({ type: 'supersedes' as const, target })),
      { type: 'references', target: change.meta.id },
    ],
    data: {
      change_id: change.meta.id,
      revision_reason: input.reason,
      retired_instance_ids: retiredIds,
    },
  });
  for (const predecessor of retired) {
    updateRecord(root, predecessor.meta.id, { status: 'superseded' });
    for (const contractId of [predecessor.meta.data.design_id, predecessor.meta.data.check_id])
      if (typeof contractId === 'string') updateRecord(root, contractId, { status: 'superseded' });
  }
  return getRecord(root, replacement.meta.id);
}
