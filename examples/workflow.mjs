import { existsSync } from 'node:fs';
import { cp, mkdir, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { contextPacket, createRecord, initialize, installPack, installProject,
  runCheck, startTask, submitTask, traceRecord, verify } from '../dist/index.js';

const examples = dirname(fileURLToPath(import.meta.url));
const definitions = {
  software: {
    project_id: 'SW-PILOT',
    criteria: [
      'Accept only schemaVersion 1, integer ports 1–65535, and debug/info/warn/error log levels.',
      'Missing files return defaults and a saved configuration is readable in another process.',
      'Invalid saves and corrupt existing files preserve existing data.',
      'CLI get/set operations return JSON; invalid operations fail with an English diagnostic.',
    ],
    test: 'tests/config.test.mjs',
    design: 'Validate before writing. Persist through a synced unique temporary file and rename. Use a separate CLI process to verify persistence.',
    lesson: 'Validate complete input before filesystem mutations; write a temporary file beside the destination before replacement. State durability and concurrency limits explicitly.',
    applicability: ['Small local JSON configuration stores with last-writer-wins concurrency.'],
    limitations: ['Power-loss durability and network filesystems require additional verification.'],
  },
  embedded: {
    project_id: 'EM-PILOT',
    criteria: [
      'Start off, enable at ADC ≥2800, disable at ADC ≤2400, and retain the state inside the band.',
      'Invalid inputs and readings ≤30 or ≥4065 force the load off; valid input restarts ordinary hysteresis.',
      'Calibrated threshold ordering is validated and incorrect ordering fails off.',
      'The ideal 12 V, 120 Ω load draws 99–100 mA on and less than 20 nA off.',
    ],
    test: 'tests/controller.test.mjs',
    design: 'Use calibrated hysteresis with rail-fault detection and fail-off behavior. Analyze the nominal resistive circuit separately from firmware behavior.',
    lesson: 'Record distinct evidence methods for behavioral simulation, circuit simulation, compilation, and physical measurement; preserve each configuration and its limitations.',
    applicability: ['Embedded projects combining firmware logic and circuit simulation.'],
    limitations: ['Simulation does not establish component ratings or behavior on a physical board.'],
  },
};

export async function buildWorkflow(output, pilot) {
  if (!definitions[pilot]) throw new Error('Pilot must be software or embedded.');
  output = resolve(output);
  if (existsSync(output) && (await readdir(output)).length) throw new Error('Choose a new or empty output directory; existing files are preserved.');
  await mkdir(output, { recursive: true });
  const definition = definitions[pilot];
  await cp(join(examples, pilot), join(output, pilot), { recursive: true });
  initialize(output, { project_id: definition.project_id, name: `${pilot} pilot`, profile: pilot,
    platforms: ['codex'] });
  const installation = installProject(output);
  installPack(output, 'engineering-basics');
  const requirements = definition.criteria.map((criterion, index) => createRecord(output, {
    type: 'requirement', title: `${pilot} requirement ${index + 1}`, owner: 'requirements', status: 'ready',
    data: { acceptance_criteria: [criterion], pilot_reference: `${pilot === 'software' ? 'SW' : 'EM'}-REQ-${String(index + 1).padStart(3, '0')}` },
    body: `# Requirement\n${criterion}\n\n# Source\nBundled ${pilot}/README.md.\n`,
  }));
  const design = createRecord(output, { type: 'design', title: `${pilot} pilot architecture`, owner: 'architect', status: 'ready',
    links: requirements.map(record => ({ type: 'satisfies', target: record.meta.id })),
    data: pilot === 'embedded' ? { hardware_software_interface: {
      adc: 'Unsigned 12-bit ADC, nominal 3.3 V reference.', output: 'Active-high 3.3 V load command.',
      fault: 'Result bit 1 forces load off.', board_revision: 'Conceptual sim-1; no physical board.',
    } } : { interfaces: ['validateConfig', 'loadConfig', 'saveConfig', 'CLI get/set'] },
    body: `# Design\n${definition.design}\n\n# Limitations\n${definition.limitations.join('\n')}\n`,
  });
  const task = createRecord(output, { type: 'task', title: `Verify the bundled ${pilot} implementation`, owner: 'developer', status: 'ready',
    links: [{ type: 'implements', target: design.meta.id }, ...requirements.map(record => ({ type: 'satisfies', target: record.meta.id }))],
    data: { requirements: requirements.map(record => record.meta.id), acceptance_criteria: definition.criteria,
      allowed_paths: [pilot], tools: ['Node.js 24 standard libraries'], outputs: [`${pilot}/README.md`, 'Collected test evidence'],
      assumptions: ['The delivered implementation is already present; this script verifies it and records a submission.'],
      decisions: [definition.design] },
  });
  const check = createRecord(output, { type: 'check', title: `${pilot} automated acceptance checks`, owner: 'verifier', status: 'ready',
    links: requirements.map(record => ({ type: 'verifies', target: record.meta.id })),
    data: { command: [process.execPath, '--test', `${pilot}/${definition.test}`], baseline_paths: [pilot],
      method: pilot === 'embedded' ? 'behavioral-and-dc-equation-simulation' : 'unit-integration-process-acceptance',
      environment: { node: process.version, os: process.platform, physical_hardware: false }, timeout_ms: 120000,
      limitations: definition.limitations },
  });
  startTask(output, task.meta.id, undefined, undefined, 'script-driven-pilot-verification');
  const evidence = runCheck(output, check.meta.id, task.meta.id);
  submitTask(output, task.meta.id, `Executed ${check.meta.id}; collected ${evidence.meta.id}. This submission was generated by a script and awaits an actual independent engineering review.`);
  const lesson = createRecord(output, { type: 'knowledge', title: `${pilot} verification lesson`, owner: 'curator', status: 'candidate',
    links: [{ type: 'documents', target: task.meta.id }],
    data: { generalization: definition.lesson, applicability: definition.applicability,
      provenance: [`Bundled VeryThinker ${pilot} pilot and its executed acceptance checks.`],
      domains: [pilot], technologies: pilot === 'software' ? ['Node.js', 'JSON'] : ['C', 'circuit simulation'],
      assumptions: ['Review applicability against the receiving project.'], limitations: definition.limitations },
    body: `# Generalized Candidate\n${definition.lesson}\n\n# Status\nAwaiting independent generalization review and human approval before upstream publication.\n`,
  });
  const result = { schema_version: 1, project: output, pilot, installation,
    records: { requirements: requirements.map(record => record.meta.id), design: design.meta.id,
      task: task.meta.id, check: check.meta.id, evidence: evidence.meta.id, lesson: lesson.meta.id },
    gates: { ready: verify(output, task.meta.id, 'ready'), design_ready: verify(output, task.meta.id, 'design-ready'),
      verified: verify(output, task.meta.id, 'verified'), accepted: verify(output, task.meta.id, 'accepted') },
    context: contextPacket(output, task.meta.id), trace: traceRecord(output, task.meta.id, true),
    acceptance_status: 'submitted-awaiting-independent-review',
    next_actions: [
      ['verythinker', 'review', design.meta.id, '--owner', 'reviewer', '--decision', 'pass', '--project', output],
      ['verythinker', 'review', task.meta.id, '--owner', 'reviewer', '--decision', 'pass', '--project', output],
      ['verythinker', 'task', 'accept', task.meta.id, '--project', output],
      ['verythinker', 'review', lesson.meta.id, '--owner', 'reviewer', '--decision', 'pass', '--generalization-review', '--project', output],
      ['verythinker', 'memory', 'contribute', lesson.meta.id, '--project', output],
    ],
    limitations: ['Next actions require actual reviews; command examples are not review evidence.',
      'The script does not perform an LLM agent evaluation or create an upstream PR.', ...definition.limitations] };
  await writeFile(join(output, 'workflow-report.json'), `${JSON.stringify(result, null, 2)}\n`);
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [pilot, output] = process.argv.slice(2);
  if (!output || process.argv.length !== 4) {
    process.stderr.write('Usage: node examples/workflow.mjs <software|embedded> <new-directory>\n');
    process.exitCode = 1;
  } else buildWorkflow(output, pilot).then(result => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
    .catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
