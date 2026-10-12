import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageVersion = JSON.parse(readFileSync(join(repository, 'package.json'), 'utf8')).version;
const options = process.argv.slice(2);
const supplied = options.indexOf('--tarball');
const npmCli = [
  process.env.npm_execpath,
  join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
].find((path) => path && existsSync(path));
if (!npmCli) throw new Error('Run npm run package:smoke so the npm executable path is available.');
function run(args, cwd = repository) {
  const result = spawnSync(process.execPath, args, {
    cwd,
    shell: false,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 120000,
    maxBuffer: 4 * 1024 * 1024,
  });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  return result.stdout;
}
let tarball;
if (supplied >= 0) tarball = resolve(options[supplied + 1]);
else {
  mkdirSync(join(repository, 'artifacts'), { recursive: true });
  const inventory = JSON.parse(run([npmCli, 'pack', '--pack-destination', 'artifacts', '--json']));
  const packed = Array.isArray(inventory) ? inventory : Object.values(inventory);
  assert.ok(
    !packed[0].files.some((file) => /__pycache__|\.pyc$|\.o$|\.obj$/.test(file.path)),
    'Package must exclude generated binary/cache files.',
  );
  tarball = join(repository, 'artifacts', packed[0].filename);
}
const workspace = mkdtempSync(join(tmpdir(), 'verythinker-package-'));
function removeManaged(path) {
  const target = resolve(path);
  const child = relative(workspace, target);
  assert.ok(
    !isAbsolute(child) && child !== '..' && !child.startsWith('../') && !child.startsWith('..\\'),
  );
  rmSync(target, { recursive: true, force: true });
}
try {
  writeFileSync(join(workspace, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  run([npmCli, 'install', '--ignore-scripts', '--no-audit', '--no-fund', tarball], workspace);
  const installed = join(workspace, 'node_modules/verythinker');
  const cli = join(installed, 'dist/cli.js');
  let project = workspace;
  const invoke = (args) => JSON.parse(run([cli, ...args, '--project', project], project));
  writeFileSync(join(workspace, 'AGENTS.md'), '# Existing project instructions\n');
  const initialization = invoke([
    'init',
    '--name',
    'Packaged smoke project',
    '--project-id',
    'SMOKE',
    '--platforms',
    'codex,claude,copilot',
  ]);
  assert.equal(initialization.config.schema_version, 1);
  assert.equal(initialization.installation.version, packageVersion);
  assert.ok(
    readFileSync(join(workspace, 'AGENTS.md'), 'utf8').startsWith(
      '# Existing project instructions',
    ),
  );
  const core = await import(pathToFileURL(join(installed, 'dist/index.js')).href);
  assert.equal(
    readdirSync(join(workspace, '.verythinker/roles')).filter((path) => path.endsWith('.md'))
      .length,
    12,
  );
  assert.equal(core.listRecipes().length, 3);
  assert.equal(core.readRoutingPolicy(workspace).strong_model, 'gpt-6-luna');
  assert.equal(core.readRoutingPolicy(workspace).strong_effort, 'max');
  assert.equal(core.readRoutingPolicy(workspace).worker_effort, 'medium');
  const strictRequirement = core.createRecord(workspace, {
    type: 'requirement',
    title: 'Strict package routing fixture',
    data: { acceptance_criteria: ['Unconfirmed execution must remain blocked.'] },
  });
  const strictTask = core.createRecord(workspace, {
    type: 'task',
    title: 'Reject asserted model observations',
    links: [{ type: 'satisfies', target: strictRequirement.meta.id }],
    data: {
      acceptance_criteria: ['No fake invocation can satisfy strict dispatch.'],
      allowed_paths: ['src'],
    },
  });
  assert.throws(
    () =>
      core.startTask(
        workspace,
        strictTask.meta.id,
        'gpt-6-luna',
        'gpt-6-luna',
        'asserted-package-fixture',
      ),
    /native|receipt|routing|invocation/i,
  );
  assert.equal(core.getRecord(workspace, strictTask.meta.id).meta.status, 'draft');
  const edited = join(workspace, '.verythinker/roles/developer.md');
  writeFileSync(edited, 'User edits preserved.\n');
  assert.ok(
    invoke(['update']).conflicts.some(
      (conflict) => conflict.path === '.verythinker/roles/developer.md',
    ),
  );
  assert.equal(readFileSync(edited, 'utf8'), 'User edits preserved.\n');
  const strictClient = new Client({ name: 'packaged-strict-discovery', version: '1.0.0' });
  await strictClient.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [cli, 'mcp', '--project', workspace],
      stderr: 'pipe',
    }),
  );
  try {
    const tools = (await strictClient.listTools()).tools;
    for (const name of [
      'native_dispatch',
      'native_status',
      'native_wait',
      'native_interrupt',
      'native_resume',
      'capability_describe',
      'capability_resolve',
      'capability_invoke',
      'archive_prepare',
      'archive_publish',
      'archive_status',
      'note_create',
      'note_validate',
      'recipe_list',
      'recipe_prepare',
      'recipe_run',
      'recipe_revise',
    ])
      assert.ok(
        tools.some((tool) => tool.name === name),
        `Installed MCP exposes ${name}.`,
      );
    const refusal = await strictClient.callTool({
      name: 'task_start',
      arguments: { id: strictTask.meta.id, invocation_id: 'asserted-package-fixture' },
    });
    assert.equal(refusal.isError, true);
    assert.match(refusal.content[0].text, /native|receipt|routing|invocation/i);
  } finally {
    await strictClient.close();
  }
  // Legacy fixtures intentionally have no installed routing policy. They establish
  // packaged engineering mechanics, never authenticated native execution.
  project = join(workspace, 'legacy-workflow');
  mkdirSync(project);
  core.initialize(project, { project_id: 'LEGACY-SMOKE', profile: 'basic' });
  assert.equal(core.readRoutingPolicy(project), null);
  mkdirSync(join(project, 'src'));
  writeFileSync(join(project, 'src/value.mjs'), 'export const value = 1;\n');
  const requirement = core.createRecord(project, {
    type: 'requirement',
    title: 'Packaged value',
    owner: 'requirements',
    data: { acceptance_criteria: ['The value equals one.'] },
  });
  const task = core.createRecord(project, {
    type: 'task',
    title: 'Verify packaged value',
    owner: 'developer',
    links: [{ type: 'satisfies', target: requirement.meta.id }],
    data: { acceptance_criteria: ['Value is one.'], allowed_paths: ['src'] },
  });
  const check = core.createRecord(project, {
    type: 'check',
    title: 'Packaged verification',
    links: [{ type: 'verifies', target: requirement.meta.id }],
    data: {
      command: [
        process.execPath,
        '--input-type=module',
        '-e',
        'import{value}from"./src/value.mjs";if(value!==1)process.exit(1)',
      ],
      baseline_paths: ['src'],
      method: 'unit',
    },
  });
  invoke(['task', 'start', task.meta.id, '--invocation', 'packaged-implementation-fixture']);
  assert.equal(
    invoke(['task', 'resume', task.meta.id]).meta.data.invocation_id,
    'packaged-implementation-fixture',
  );
  const evidence = invoke(['check', 'run', check.meta.id, '--task', task.meta.id]);
  assert.equal(evidence.meta.data.result, 'pass');
  invoke(['check', 'archive', evidence.meta.id]);
  invoke([
    'task',
    'submit',
    task.meta.id,
    '--summary',
    'Package smoke fixture executed a real Node check.',
  ]);
  invoke([
    'review',
    task.meta.id,
    '--owner',
    'reviewer',
    '--decision',
    'pass',
    '--invocation',
    'packaged-independent-review-fixture',
  ]);
  assert.equal(invoke(['task', 'accept', task.meta.id]).meta.status, 'accepted');
  removeManaged(join(project, '.verythinker/cache'));
  removeManaged(join(project, '.verythinker/runs'));
  assert.equal(invoke(['verify', task.meta.id, '--gate', 'accepted']).ok, true);
  assert.equal(invoke(['memory', 'search', 'Packaged']).length > 0, true);
  const client = new Client({ name: 'packaged-smoke', version: '1.0.0' });
  let managerWorkflow;
  let managerTask;
  let managerFinalReportId;
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [cli, 'mcp', '--project', project],
      stderr: 'pipe',
    }),
  );
  try {
    const tools = (await client.listTools()).tools;
    for (const name of [
      'task_accept',
      'manager_begin',
      'manager_status',
      'manager_discuss',
      'manager_decide',
      'manager_finish',
    ])
      assert.ok(
        tools.some((tool) => tool.name === name),
        `Installed MCP exposes ${name}.`,
      );
    const call = async (name, arguments_) => {
      const response = await client.callTool({ name, arguments: arguments_ });
      assert.ok(!response.isError, response.content?.[0]?.text ?? `${name} failed.`);
      assert.equal(response.content?.[0]?.type, 'text');
      return JSON.parse(response.content[0].text);
    };
    const result = await client.callTool({
      name: 'verify',
      arguments: { id: task.meta.id, gate: 'accepted' },
    });
    assert.equal(JSON.parse(result.content[0].text).ok, true);

    // This is an automated coordination/gate fixture, not a native-agent quality evaluation.
    const demo = join(project, 'manager-demo');
    mkdirSync(join(demo, 'src'), { recursive: true });
    mkdirSync(join(demo, 'docs'), { recursive: true });
    writeFileSync(join(demo, 'src/value.mjs'), 'export const managedValue = 7;\n');
    writeFileSync(
      join(demo, 'docs/value.md'),
      '# Managed value\nImport managedValue from src/value.mjs; its integer value is seven.\n',
    );
    managerWorkflow = await call('manager_begin', {
      requirement: 'Provide a documented module whose managedValue export equals integer seven.',
      title: 'Packaged manager lifecycle',
      invocation_id: 'packaged-manager-coordinator-fixture',
      request_id: 'packaged-manager-request-fixture',
    });
    const recovered = await call('manager_begin', {
      requirement: 'Provide a documented module whose managedValue export equals integer seven.',
      request_id: 'packaged-manager-request-fixture',
    });
    assert.equal(recovered.meta.id, managerWorkflow.meta.id);
    const managerRequirement = core.updateRecord(
      project,
      managerWorkflow.meta.data.requirement_id,
      {
        data: {
          acceptance_criteria: [
            'Importing managedValue yields the integer seven.',
            'The interface document identifies the export name and its integer value.',
          ],
        },
      },
    );
    managerTask = core.createRecord(project, {
      type: 'task',
      title: 'Deliver documented managed value',
      owner: 'developer',
      links: [{ type: 'satisfies', target: managerRequirement.meta.id }],
      data: {
        acceptance_criteria: ['Export integer seven and document the observable module interface.'],
        allowed_paths: ['manager-demo'],
        documentation_paths: ['manager-demo/docs/value.md'],
        outputs: ['manager-demo/src/value.mjs', 'manager-demo/docs/value.md'],
      },
    });
    const managerCheck = core.createRecord(project, {
      type: 'check',
      title: 'Check managed numeric export',
      owner: 'verifier',
      links: [{ type: 'verifies', target: managerRequirement.meta.id }],
      data: {
        command: [
          process.execPath,
          '--input-type=module',
          '-e',
          'import{managedValue}from"./manager-demo/src/value.mjs";if(!Number.isInteger(managedValue)||managedValue!==7)process.exit(1)',
        ],
        baseline_paths: ['manager-demo/src'],
        method: 'unit',
      },
    });
    for (const role of ['requirements', 'verifier']) {
      await call('manager_discuss', {
        workflow_id: managerWorkflow.meta.id,
        role,
        invocation_id: `packaged-manager-${role}-specialist-fixture`,
        summary:
          role === 'requirements'
            ? 'A named integer export and an interface document define measurable deliverables.'
            : 'Execute a Node import assertion and inspect the documented export against that result.',
        rationale: 'A small deterministic module needs no service, dependency, or custom runtime.',
        source_ids: [managerRequirement.meta.id],
        risks: [],
      });
    }
    await call('manager_decide', {
      workflow_id: managerWorkflow.meta.id,
      summary: 'Deliver one numeric export with its interface document and focused verification.',
      rationale:
        'The basic profile covers the stated invariant with bounded artifacts and separate review.',
      task_ids: [managerTask.meta.id],
    });
    const planned = await call('manager_status', { workflow_id: managerWorkflow.meta.id });
    assert.equal(planned.phase, 'execution');
    assert.equal(planned.tasks[0].documentation_required, true);
    invoke([
      'task',
      'start',
      managerTask.meta.id,
      '--invocation',
      'packaged-manager-developer-fixture',
    ]);
    const resumed = await call('task_resume', {
      id: managerTask.meta.id,
      invocation_id: 'packaged-manager-resumed-developer-fixture',
    });
    assert.equal(resumed.meta.data.invocation_id, 'packaged-manager-resumed-developer-fixture');
    assert.ok(
      resumed.meta.data.prior_invocation_ids.includes('packaged-manager-developer-fixture'),
    );
    const managerEvidence = invoke([
      'check',
      'run',
      managerCheck.meta.id,
      '--task',
      managerTask.meta.id,
    ]);
    assert.equal(managerEvidence.meta.data.result, 'pass');
    invoke(['check', 'archive', managerEvidence.meta.id]);
    const workRecord =
      [
        '# Objective',
        `Deliver ${managerTask.meta.id} with a named integer export and an interface document.`,
        '# Inputs and Sources',
        `Inspected ${managerRequirement.meta.id}, manager-demo/src/value.mjs, and manager-demo/docs/value.md.`,
        '# Decisions and Rationale',
        'Used one named export because the fixed integer contract requires no parser or runtime service.',
        '# Results',
        'The managedValue export yields integer seven and the interface document states its observable contract.',
        '# Evidence',
        `Executed ${managerCheck.meta.id}; ${managerEvidence.meta.id} retains the archived Node output and receipt.`,
        '# Limitations',
        'This automated fixture checks packaged workflow mechanics; native agent reasoning and model quality remain unmeasured.',
        '# Lessons',
        'A focused import assertion gives repeatable evidence for a constant module export on a recorded baseline.',
      ].join('\n\n') + '\n';
    const workRecordPath = join(demo, 'work-record.md');
    writeFileSync(workRecordPath, workRecord);
    invoke([
      'task',
      'submit',
      managerTask.meta.id,
      '--summary',
      'Delivered the documented integer export and archived its actual verification output.',
      '--work-record',
      workRecordPath,
    ]);
    const closure = {
      workflow_id: managerWorkflow.meta.id,
      no_lesson_reason:
        'This packaged smoke fixture repeats an existing deterministic verification lesson and adds no qualified reusable insight.',
    };
    const rejected = await client.callTool({ name: 'manager_finish', arguments: closure });
    assert.equal(rejected.isError, true);
    assert.match(rejected.content[0].text, /independent review/i);
    assert.equal(core.getRecord(project, managerTask.meta.id).meta.status, 'submitted');
    invoke([
      'review',
      managerTask.meta.id,
      '--owner',
      'reviewer',
      '--decision',
      'pass',
      '--invocation',
      'packaged-manager-independent-review-fixture',
    ]);
    const completed = await call('manager_finish', closure);
    assert.equal(completed.phase, 'completed');
    assert.deepEqual(completed.publication_blockers, []);
    assert.equal(core.getRecord(project, managerTask.meta.id).meta.status, 'accepted');
    assert.match(completed.final_report, /Documentation and separate review were validated/);
    managerFinalReportId = completed.final_report_id;
    const repeated = await call('manager_finish', { workflow_id: managerWorkflow.meta.id });
    assert.equal(repeated.final_report_id, managerFinalReportId);
    assert.equal(
      core.loadRecords(project).filter((record) => record.meta.title === 'Manager final report')
        .length,
      1,
    );
  } finally {
    await client.close();
  }
  removeManaged(join(project, '.verythinker/cache'));
  removeManaged(join(project, '.verythinker/runs'));
  const managerResumed = invoke(['workflow', 'status', managerWorkflow.meta.id]);
  assert.equal(managerResumed.phase, 'completed');
  assert.equal(managerResumed.final_report_id, managerFinalReportId);
  assert.equal(invoke(['verify', managerTask.meta.id, '--gate', 'accepted']).ok, true);
  assert.equal(invoke(['verify', task.meta.id, '--gate', 'accepted']).ok, true);
  const report = {
    schema_version: 1,
    tested_at: new Date().toISOString(),
    package: 'verythinker',
    version: initialization.installation.version,
    tarball: relative(repository, tarball).replaceAll('\\', '/'),
    sha256: createHash('sha256').update(readFileSync(tarball)).digest('hex'),
    platform: process.platform,
    node: process.version,
    status: 'passed',
    checks: [
      'tarball-install',
      'resource-resolution',
      'three-adapter-generation',
      'twelve-role-generation',
      'three-versioned-recipe-resolution',
      'strict-routing-policy-defaults',
      'strict-CLI-and-MCP-unconfirmed-invocation-rejection',
      'native-capability-archive-Cornell-recipe-MCP-discovery',
      'configuration-preservation',
      'real-check',
      'evidence-archive',
      'fixture-review-gate',
      'interrupted-resumption',
      'new-process-acceptance',
      'index-rebuild',
      'edit-preserving-update',
      'MCP-stdio-discovery-and-invocation',
      'MCP-manager-tool-discovery',
      'MCP-manager-intake-and-request-idempotency',
      'MCP-two-specialist-discussion-and-integrated-decision-fixture',
      'manager-invocation-handoff-fixture',
      'manager-real-check-and-archived-evidence',
      'manager-substantive-seven-section-documentation',
      'MCP-manager-missing-review-rejection',
      'MCP-manager-closure-and-final-report-idempotency',
      'manager-new-process-resumption-after-cache-and-private-log-removal',
    ],
    limitations: [
      'The complete engineering lifecycle intentionally uses a separately initialized legacy-policy project; automated identities establish core mechanics only.',
      'Installed alpha.3 strict policy is exercised for missing-receipt rejection and discovery, not authenticated inference.',
      'Native account/model access, remote archives, and upstream PR publication are not exercised by package smoke.',
    ],
  };
  mkdirSync(join(repository, 'artifacts'), { recursive: true });
  writeFileSync(
    join(repository, 'artifacts/package-smoke.json'),
    JSON.stringify(report, null, 2) + '\n',
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  assert.equal(dirname(resolve(workspace)), resolve(tmpdir()));
  removeManaged(workspace);
}
