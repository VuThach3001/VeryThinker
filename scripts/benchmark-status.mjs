import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';

const options = parseArgs(process.argv.slice(2));
if (options.help) {
  process.stdout.write('Usage: node scripts/benchmark-status.mjs --project PATH [--workflow ID] [--repeats N] [--baseline FILE] [--output FILE]\n');
  process.exit(0);
}
if (!options.project) throw new Error('--project is required. Build the current source with npm run build before benchmarking.');
const project = resolve(options.project);
if (!existsSync(project)) throw new Error(`Project directory does not exist: ${project}`);
const workflow = options.workflow;
const repeats = options.repeats ?? 3;
if (!Number.isSafeInteger(repeats) || repeats < 1 || repeats > 100) throw new Error('--repeats must be an integer from 1 through 100.');
if (options.output && options.baseline && resolve(options.output).toLowerCase() === resolve(options.baseline).toLowerCase()) {
  throw new Error('--output must not overwrite the read-only --baseline artifact.');
}
const [{ workflowProgress }, { workflowStatus }] = await Promise.all([
  import('../dist/progress.js'),
  import('../dist/manager.js'),
]);

const measure = (operation) => {
  const samples = [];
  for (let index = 0; index < repeats; index++) {
    const start = performance.now();
    operation(project, workflow);
    samples.push(round(performance.now() - start));
  }
  return summarize(samples);
};
const current = {
  schema_version: 1,
  observed_at: new Date().toISOString(),
  project: project,
  workflow_id: workflow ?? null,
  repeats,
  measurements: {
    manager_progress: measure(workflowProgress),
    manager_status: measure(workflowStatus),
  },
};
if (options.baseline) current.comparison = compare(current.measurements, readBaseline(resolve(options.baseline)));
const serialized = `${JSON.stringify(current, null, 2)}\n`;
if (options.output) {
  const output = resolve(options.output);
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, serialized, { encoding: 'utf8', flag: 'w' });
} else {
  process.stdout.write(serialized);
}

function parseArgs(args) {
  const result = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (key === '--help') { result.help = true; continue; }
    if (!['--project', '--workflow', '--repeats', '--baseline', '--output'].includes(key)) throw new Error(`Unknown option: ${key}`);
    const value = args[++i];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${key}`);
    if (key === '--project') result.project = value;
    else if (key === '--workflow') result.workflow = value;
    else if (key === '--repeats') result.repeats = Number(value);
    else if (key === '--baseline') result.baseline = value;
    else result.output = value;
  }
  return result;
}
function round(number) { return Number(number.toFixed(3)); }
function summarize(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  return { unit: 'ms', samples, min: sorted[0], median: round(median), max: sorted.at(-1) };
}
function readBaseline(path) {
  const artifact = JSON.parse(readFileSync(path, 'utf8'));
  const measurements = artifact?.measurements;
  if (!measurements || !['manager_progress', 'manager_status'].every((key) => Number.isFinite(measurements[key]?.median))) {
    throw new Error('Baseline must be a benchmark-status artifact with measurements for both operations.');
  }
  return measurements;
}
function compare(measurements, baseline) {
  return Object.fromEntries(['manager_progress', 'manager_status'].map((key) => {
    const prior = baseline[key].median;
    const currentMedian = measurements[key].median;
    return [key, {
      baseline_median_ms: prior,
      current_median_ms: currentMedian,
      delta_ms: round(currentMedian - prior),
      delta_percent: prior === 0 ? null : round(((currentMedian - prior) / prior) * 100),
    }];
  }));
}
