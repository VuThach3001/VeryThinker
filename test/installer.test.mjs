import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
  readdirSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { parse } from 'jsonc-parser';
import { installProject, updateProject, doctor, configureCodeGraph } from '../dist/installer.js';
import { codeGraphConformanceChecks } from '../dist/adapters.js';
import { createRecord, getRecord, updateRecord, hash, readConfig } from '../dist/storage.js';
import {
  canonicalJson,
  defaultRoutingPolicy,
  ownerIsAlive,
  priorDefaultRoutingPolicy,
} from '../dist/routing.js';
import { resumeTask } from '../dist/engineering.js';

function project(t, platforms = ['codex', 'claude', 'copilot']) {
  const root = mkdtempSync(join(tmpdir(), 'verythinker install-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, '.verythinker'));
  writeFileSync(
    join(root, '.verythinker', 'config.json'),
    JSON.stringify({
      schema_version: 1,
      project_id: 'TEST-PROJECT',
      name: 'Installer test',
      profile: 'software',
      platforms,
      models: { economy: null, balanced: null, strong: null },
      max_workers: 3,
      repair_attempts: 1,
    }),
  );
  return root;
}
function write(root, path, content) {
  mkdirSync(join(root, path, '..'), { recursive: true });
  writeFileSync(join(root, path), content);
}
function read(root, path) {
  return readFileSync(join(root, path), 'utf8');
}
function signedReceipt(
  root,
  state = 'completed',
  { ownerPid = process.pid, serverPid = null } = {},
) {
  const pair = generateKeyPairSync('ed25519');
  const publicKey = pair.publicKey.export({ type: 'spki', format: 'pem' });
  const keyId = hash(publicKey);
  mkdirSync(join(root, '.verythinker/native/keys'), { recursive: true });
  mkdirSync(join(root, '.verythinker/native/receipts'), { recursive: true });
  write(root, `.verythinker/native/keys/${keyId}.pem`, publicKey);
  write(root, '.verythinker/native/trust.json', JSON.stringify({ keys: [keyId] }));
  const id = randomUUID();
  const unsigned = {
    schema_version: 1,
    issuer: 'verythinker-codex-app-server',
    execution_mode: 'native',
    id,
    receipt_path: `.verythinker/native/receipts/${id}.json`,
    project_id: readConfig(root).project_id,
    state,
    owner_pid: ownerPid,
    server_pid: serverPid,
    key_id: keyId,
  };
  const receiptPath = unsigned.receipt_path;
  write(
    root,
    receiptPath,
    JSON.stringify({
      ...unsigned,
      signature: sign(null, Buffer.from(canonicalJson(unsigned)), pair.privateKey).toString(
        'base64',
      ),
    }),
  );
  return { path: receiptPath, bytes: read(root, receiptPath) };
}

test('installation preserves instructions and JSONC/TOML siblings, then is idempotent', (t) => {
  const root = project(t);
  const instructions = '# Project rules\n\nKeep all existing rules.\n';
  write(root, 'AGENTS.md', instructions);
  write(root, 'CLAUDE.md', '# Existing Claude instructions\n');
  write(
    root,
    '.mcp.json',
    '{\n  // User server comment\n  "mcpServers": { "existing": { "command": "existing-server" } },\n  "extra": true,\n}\n',
  );
  write(
    root,
    '.codex/config.toml',
    '# Personal comment\nmodel = "user-model"\n\n[mcp_servers.existing]\ncommand = "existing-server"\n',
  );
  const report = installProject(root);
  assert.deepEqual(report.conflicts, []);
  assert.ok(read(root, 'AGENTS.md').startsWith(instructions.trimEnd()));
  assert.match(read(root, 'AGENTS.md'), /BEGIN VERYTHINKER instructions/);
  assert.match(read(root, '.mcp.json'), /User server comment/);
  assert.equal(parse(read(root, '.mcp.json')).mcpServers.existing.command, 'existing-server');
  assert.equal(parse(read(root, '.mcp.json')).extra, true);
  assert.match(read(root, '.codex/config.toml'), /model = "user-model"/);
  assert.match(read(root, '.codex/config.toml'), /\[mcp_servers.existing\]/);
  assert.equal(readdirSync(join(root, '.codex/agents')).length, 12);
  assert.ok(existsSync(join(root, '.agents/skills/verythinker-verify/SKILL.md')));
  assert.ok(existsSync(join(root, '.claude/skills/verythinker-verify/SKILL.md')));
  assert.ok(existsSync(join(root, '.github/skills/verythinker-verify/SKILL.md')));
  const before = read(root, 'AGENTS.md');
  const next = updateProject(root);
  assert.deepEqual(next.installed, []);
  assert.deepEqual(next.updated, []);
  assert.deepEqual(next.conflicts, []);
  assert.equal(read(root, 'AGENTS.md'), before);
});

test('ordinary engineering intent automatically routes to the manager on every native adapter', (t) => {
  const root = project(t);
  installProject(root);
  for (const path of ['AGENTS.md', 'CLAUDE.md', '.github/copilot-instructions.md']) {
    const instructions = read(root, path);
    assert.match(instructions, /new requirement, feature, fix/);
    assert.match(instructions, /automatically act as the VeryThinker manager/);
    assert.match(instructions, /verythinker-manager/);
    assert.match(instructions, /automation\.json/);
    assert.match(instructions, /agent-operated CLI fallback/);
  }
  for (const prefix of ['.agents', '.claude', '.github']) {
    const skill = read(root, `${prefix}/skills/verythinker-manager/SKILL.md`);
    assert.match(skill, /^---\r?\nname: verythinker-manager\r?\n/);
    assert.match(skill, /description: Manage a user's engineering requirement/);
    assert.doesNotMatch(skill, /disable-model-invocation: true/);
    assert.match(skill, /manager_begin/);
    assert.match(skill, /reviewed knowledge contribution/);
  }
  const guide = read(root, '.verythinker/guides/manager.md');
  for (const operation of [
    'manager_begin',
    'manager_discuss',
    'manager_decide',
    'manager_finish',
  ]) {
    assert.ok(guide.includes(operation), operation);
  }
  assert.match(guide, /documentation_required: true/);
  assert.match(guide, /separate reviewer invocation/);
  assert.match(guide, /automatic_pr/);
  assert.match(guide, /Human approval governs merging/);
  assert.match(guide, /three rounds/);
  assert.match(guide, /unconfigured background service/);
});

test('modified and deleted managed templates remain preserved and receive candidates', (t) => {
  const root = project(t, ['codex']);
  installProject(root);
  const changed = '.verythinker/roles/researcher.md';
  const removed = '.verythinker/roles/reviewer.md';
  write(root, changed, 'User research procedure.\n');
  rmSync(join(root, removed));
  const report = updateProject(root);
  assert.equal(read(root, changed), 'User research procedure.\n');
  assert.equal(existsSync(join(root, removed)), false);
  const changedConflict = report.conflicts.find((item) => item.path === changed);
  const removedConflict = report.conflicts.find((item) => item.path === removed);
  assert.ok(changedConflict);
  assert.ok(removedConflict);
  assert.match(read(root, changedConflict.candidate), /Research/);
  assert.match(read(root, removedConflict.candidate), /Review/);
  const repeated = updateProject(root);
  assert.equal(
    repeated.conflicts.find((item) => item.path === changed).candidate,
    changedConflict.candidate,
  );
});

test('user-owned MCP entries and hook events produce review candidates', (t) => {
  const root = project(t);
  write(
    root,
    '.mcp.json',
    '{ // preserve me\n "mcpServers": {"verythinker": {"command":"user-owned"}}\n}\n',
  );
  write(
    root,
    '.codex/config.toml',
    '# User owned\n[mcp_servers.verythinker]\ncommand = "user-owned"\n',
  );
  write(
    root,
    '.claude/settings.json',
    '{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"user-start"}]}]},"other":42}\n',
  );
  const mcp = read(root, '.mcp.json');
  const toml = read(root, '.codex/config.toml');
  const report = installProject(root);
  assert.equal(read(root, '.mcp.json'), mcp);
  assert.equal(read(root, '.codex/config.toml'), toml);
  assert.equal(
    parse(read(root, '.claude/settings.json')).hooks.SessionStart[0].hooks[0].command,
    'user-start',
  );
  assert.equal(parse(read(root, '.claude/settings.json')).other, 42);
  assert.ok(report.conflicts.some((item) => item.path === '.mcp.json#mcpServers.verythinker'));
  assert.ok(report.conflicts.some((item) => item.path === '.codex/config.toml#mcp'));
  assert.ok(
    report.conflicts.some((item) => item.path === '.claude/settings.json#hooks.SessionStart'),
  );
});

test('sibling changes remain editable and managed instructions edits produce a full candidate', (t) => {
  const root = project(t, ['codex', 'claude']);
  installProject(root);
  write(
    root,
    '.mcp.json',
    read(root, '.mcp.json').replace('{', '{\n // Later user note\n "other": 5,'),
  );
  write(root, 'AGENTS.md', read(root, 'AGENTS.md').replace('Use English', 'Use custom English'));
  const report = updateProject(root);
  assert.match(read(root, '.mcp.json'), /Later user note/);
  assert.equal(parse(read(root, '.mcp.json')).other, 5);
  assert.match(read(root, 'AGENTS.md'), /Use custom English/);
  const conflict = report.conflicts.find((item) => item.path === 'AGENTS.md#instructions');
  assert.ok(conflict);
  assert.match(read(root, conflict.candidate), /Use English/);
});

test('native hook commands and model metadata are generated without claiming live execution', (t) => {
  const root = project(t);
  installProject(root);
  const codex = parse(read(root, '.codex/hooks.json'));
  const claude = parse(read(root, '.claude/settings.json'));
  const copilot = parse(read(root, '.github/hooks/verythinker.json'));
  assert.match(codex.hooks.SessionStart[0].hooks[0].command, /--event.*session-start/);
  assert.match(codex.hooks.Stop[0].hooks[0].commandWindows, /^& /);
  assert.equal(claude.hooks.SessionStart[0].hooks[0].command, process.execPath);
  assert.ok(claude.hooks.SessionStart[0].hooks[0].args.includes('--project'));
  const hook = claude.hooks.SessionStart[0].hooks[0];
  const result = spawnSync(hook.command, hook.args, {
    input: '{"hook_event_name":"SessionStart"}',
    encoding: 'utf8',
    windowsHide: true,
    timeout: 10000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(JSON.parse(result.stdout).hookSpecificOutput.additionalContext, /TEST-PROJECT/);
  assert.equal(copilot.version, 1);
  assert.ok(copilot.hooks.sessionStart);
  assert.ok(copilot.hooks.agentStop);
  const report = doctor(root);
  assert.equal(report.codegraph.version, '1.6.2');
  assert.equal(report.codegraph.enabled, false);
  for (const platform of report.platforms) {
    assert.equal(
      platform.capabilities.find((item) => item.capability === 'adapter-files').status,
      'configured',
    );
    assert.equal(
      platform.capabilities.find((item) => item.capability === 'skill-discovery').status,
      'unverified',
    );
    assert.equal(
      platform.capabilities.find((item) => item.capability === 'model-routing').status,
      platform.platform === 'codex' ? 'unverified' : 'restricted',
    );
  }
});

test('initial installation fills Luna Codex mappings and preserves authored platform overrides', (t) => {
  const root = project(t);
  const config = JSON.parse(read(root, '.verythinker/config.json'));
  config.models = {
    economy: { claude: 'haiku', copilot: 'worker-choice' },
    balanced: null,
    strong: { codex: 'authored-model', claude: 'opus' },
  };
  write(root, '.verythinker/config.json', JSON.stringify(config, null, 2) + '\n');
  write(
    root,
    '.verythinker/records/legacy.md',
    'Historical accepted record retained byte for byte.\n',
  );
  const report = installProject(root);
  const current = JSON.parse(read(root, '.verythinker/config.json'));
  assert.deepEqual(current.models.economy, {
    claude: 'haiku',
    copilot: 'worker-choice',
    codex: 'gpt-6-luna',
  });
  assert.deepEqual(current.models.balanced, { codex: 'gpt-6-luna' });
  assert.deepEqual(current.models.strong, { codex: 'authored-model', claude: 'opus' });
  const conflict = report.conflicts.find(
    (item) => item.path === '.verythinker/config.json#models.codex',
  );
  assert.ok(conflict);
  assert.equal(JSON.parse(read(root, conflict.candidate)).models.strong.codex, 'gpt-6-luna');
  assert.equal(
    read(root, '.verythinker/records/legacy.md'),
    'Historical accepted record retained byte for byte.\n',
  );
  assert.match(read(root, '.codex/agents/verythinker-manager.toml'), /model = "gpt-6-luna"/);
  assert.equal(
    updateProject(root).conflicts.find((item) => item.path === conflict.path).candidate,
    conflict.candidate,
  );
});

test('update migrates the exact Sol/high defaults and preserves accepted records and receipt bytes', (t) => {
  const root = project(t, ['codex']);
  write(
    root,
    '.verythinker/routing.json',
    JSON.stringify(priorDefaultRoutingPolicy(), null, 2) + '\n',
  );
  const config = JSON.parse(read(root, '.verythinker/config.json'));
  config.models.strong = { codex: 'gpt-6.1-sol', claude: 'opus' };
  write(root, '.verythinker/config.json', JSON.stringify(config, null, 2) + '\n');
  const accepted = createRecord(root, {
    type: 'task',
    title: 'Accepted historical work',
    status: 'accepted',
  });
  const acceptedBytes = read(root, accepted.path);
  const receipt = signedReceipt(root, 'completed');
  const report = updateProject(root);
  const migratedPolicyBytes = read(root, '.verythinker/routing.json');
  const migratedConfigBytes = read(root, '.verythinker/config.json');
  assert.deepEqual(JSON.parse(migratedPolicyBytes), defaultRoutingPolicy());
  assert.deepEqual(JSON.parse(migratedConfigBytes).models.strong, {
    codex: 'gpt-6-luna',
    claude: 'opus',
  });
  assert.ok(report.updated.includes('.verythinker/routing.json#legacy-strong-policy'));
  assert.equal(read(root, accepted.path), acceptedBytes);
  assert.equal(read(root, receipt.path), receipt.bytes);
  assert.match(read(root, '.codex/agents/verythinker-manager.toml'), /model = "gpt-6-luna"/);
  assert.match(
    read(root, '.codex/agents/verythinker-manager.toml'),
    /model_reasoning_effort = "max"/,
  );
  const repeated = updateProject(root);
  assert.equal(read(root, '.verythinker/routing.json'), migratedPolicyBytes);
  assert.equal(read(root, '.verythinker/config.json'), migratedConfigBytes);
  assert.equal(read(root, accepted.path), acceptedBytes);
  assert.equal(read(root, receipt.path), receipt.bytes);
  assert.ok(!repeated.updated.includes('.verythinker/routing.json#legacy-strong-policy'));
  assert.deepEqual(repeated.conflicts, []);
});

test('authored Sol override is preserved while the exact managed legacy mapping migrates', (t) => {
  const root = project(t, ['codex']);
  write(
    root,
    '.verythinker/routing.json',
    JSON.stringify(priorDefaultRoutingPolicy(), null, 2) + '\n',
  );
  const config = JSON.parse(read(root, '.verythinker/config.json'));
  config.models.strong = 'gpt-6.1-sol';
  write(root, '.verythinker/config.json', JSON.stringify(config, null, 2) + '\n');
  const report = updateProject(root);
  assert.equal(JSON.parse(read(root, '.verythinker/config.json')).models.strong, 'gpt-6.1-sol');
  const conflict = report.conflicts.find(
    (item) => item.path === '.verythinker/config.json#models.codex',
  );
  assert.ok(conflict);
  assert.equal(JSON.parse(read(root, conflict.candidate)).models.strong.codex, 'gpt-6-luna');
  assert.deepEqual(JSON.parse(read(root, '.verythinker/routing.json')), defaultRoutingPolicy());
});

test('live authenticated native invocation defers legacy policy and project-record migration', (t) => {
  const root = project(t, ['codex']);
  installProject(root);
  write(
    root,
    '.verythinker/routing.json',
    JSON.stringify(priorDefaultRoutingPolicy(), null, 2) + '\n',
  );
  const config = JSON.parse(read(root, '.verythinker/config.json'));
  config.name = 'Original name';
  config.models.strong = { codex: 'gpt-6.1-sol' };
  write(root, '.verythinker/config.json', JSON.stringify(config, null, 2) + '\n');
  const configBefore = read(root, '.verythinker/config.json');
  const policyBefore = read(root, '.verythinker/routing.json');
  const adapterBefore = read(root, '.codex/config.toml');
  const manifestBefore = read(root, '.verythinker/install-manifest.json');
  const pending = createRecord(root, {
    type: 'task',
    title: 'Pending legacy work during active invocation',
    owner: 'developer',
    status: 'in-progress',
    data: { allowed_paths: ['src'] },
  });
  const pendingBytes = read(root, pending.path);
  const endedOwner = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
  assert.equal(ownerIsAlive(endedOwner.pid), false);
  const receipt = signedReceipt(root, 'running', {
    ownerPid: endedOwner.pid,
    serverPid: process.pid,
  });
  const report = installProject(root, { name: 'Attempted mid-turn edit' });
  assert.equal(read(root, '.verythinker/config.json'), configBefore);
  assert.equal(read(root, '.verythinker/routing.json'), policyBefore);
  assert.equal(read(root, '.codex/config.toml'), adapterBefore);
  assert.equal(read(root, '.verythinker/install-manifest.json'), manifestBefore);
  assert.equal(read(root, pending.path), pendingBytes);
  assert.equal(read(root, receipt.path), receipt.bytes);
  assert.ok(report.conflicts.some((item) => item.path === '.verythinker/routing.json'));
  assert.ok(existsSync(join(root, '.verythinker/routing.json.verythinker-update-routing')));
  assert.ok(report.warnings.some((item) => /live native invocation/i.test(item)));
});

test('unknown routing policy is preserved and produces a Luna/max review candidate', (t) => {
  const root = project(t, ['codex']);
  const authored = { ...defaultRoutingPolicy(), strong_effort: 'xhigh' };
  const original = JSON.stringify(authored, null, 2) + '\n';
  write(root, '.verythinker/routing.json', original);
  assert.throws(() => updateProject(root), /not an approved exact schema/);
  assert.equal(read(root, '.verythinker/routing.json'), original);
  assert.deepEqual(
    JSON.parse(read(root, '.verythinker/routing.json.verythinker-update-routing')),
    defaultRoutingPolicy(),
  );
});

test('alpha.3 migration makes pending legacy work strict while preserving recorded closed history bytes', (t) => {
  const root = project(t, ['codex']);
  const requirement = createRecord(root, {
    type: 'requirement',
    title: 'Legacy migration requirement',
  });
  const closed = createRecord(root, {
    type: 'knowledge',
    title: 'Recorded historical closed workflow',
    status: 'verified',
    data: { kind: 'manager-workflow', phase: 'completed', task_ids: [] },
  });
  const historical = createRecord(root, {
    type: 'task',
    title: 'Recorded historical submitted task',
    status: 'submitted',
    owner: 'developer',
    data: { workflow_id: closed.meta.id, invocation_id: 'legacy-history-worker' },
    links: [{ type: 'satisfies', target: requirement.meta.id }],
  });
  const report = createRecord(root, {
    type: 'knowledge',
    title: 'Recorded historical closure report',
    links: [{ type: 'documents', target: closed.meta.id }],
    data: { kind: 'work-record' },
    body: '# Objective\nHistorical metadata fixture; it establishes no native model access.\n',
  });
  updateRecord(root, closed.meta.id, {
    data: {
      final_report_id: report.meta.id,
      task_ids: [historical.meta.id],
    },
  });
  const accepted = createRecord(root, {
    type: 'task',
    title: 'Recorded historical accepted metadata',
    status: 'accepted',
  });
  const superseded = createRecord(root, {
    type: 'task',
    title: 'Superseded historical assignment',
    status: 'superseded',
  });
  const pending = createRecord(root, {
    type: 'knowledge',
    title: 'Pending legacy workflow',
    data: { kind: 'manager-workflow', phase: 'execution', task_ids: [] },
  });
  const existingIncrement = '12345678-1234-4abc-8def-123456789abc';
  const existing = createRecord(root, {
    type: 'knowledge',
    title: 'Pending workflow with an existing increment identity',
    data: { kind: 'manager-workflow', phase: 'intake', increment_id: existingIncrement },
  });
  const partiallyMigrated = createRecord(root, {
    type: 'knowledge',
    title: 'Pending workflow whose routing migration was already applied',
    data: { kind: 'manager-workflow', phase: 'execution', routing_required: true },
  });
  const active = createRecord(root, {
    type: 'task',
    title: 'Pending legacy in-progress implementation',
    owner: 'developer',
    status: 'in-progress',
    links: [{ type: 'satisfies', target: requirement.meta.id }],
    data: {
      workflow_id: pending.meta.id,
      invocation_id: 'legacy-pending-worker',
      allowed_paths: ['src'],
    },
  });
  updateRecord(root, pending.meta.id, { data: { task_ids: [active.meta.id] } });
  const originals = [closed, historical, accepted, superseded, report].map((record) => ({
    path: record.path,
    bytes: read(root, record.path),
  }));
  const first = installProject(root);
  assert.equal(getRecord(root, pending.meta.id).meta.data.routing_required, true);
  const migratedIncrement = getRecord(root, pending.meta.id).meta.data.increment_id;
  const backfilledIncrement = getRecord(root, partiallyMigrated.meta.id).meta.data.increment_id;
  assert.match(
    migratedIncrement,
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
  );
  assert.match(
    backfilledIncrement,
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
  );
  assert.equal(getRecord(root, existing.meta.id).meta.data.increment_id, existingIncrement);
  const migrated = getRecord(root, active.meta.id);
  assert.equal(migrated.meta.data.routing_required, true);
  assert.equal(migrated.meta.data.invocation_id, 'legacy-pending-worker');
  assert.equal(migrated.meta.revision, active.meta.revision + 1);
  assert.ok(first.updated.includes(`${active.path}#pending-routing`));
  assert.throws(() => resumeTask(root, active.meta.id), /native|routing/i);
  for (const original of originals) assert.equal(read(root, original.path), original.bytes);
  const pendingBytes = read(root, active.path);
  assert.equal(
    updateProject(root).updated.some((path) => path.endsWith('#pending-routing')),
    false,
  );
  assert.equal(read(root, active.path), pendingBytes);
  assert.equal(getRecord(root, pending.meta.id).meta.data.increment_id, migratedIncrement);
  assert.equal(
    getRecord(root, partiallyMigrated.meta.id).meta.data.increment_id,
    backfilledIncrement,
  );
  assert.equal(getRecord(root, existing.meta.id).meta.data.increment_id, existingIncrement);
  for (const original of originals) assert.equal(read(root, original.path), original.bytes);
});

test('concurrent installers allocate one persistent increment identity for pending legacy work', async (t) => {
  const root = project(t, ['codex']);
  const pending = createRecord(root, {
    type: 'knowledge',
    title: 'Concurrent pending migration fixture',
    data: { kind: 'manager-workflow', phase: 'intake' },
  });
  const script = `const {installProject}=await import(${JSON.stringify(new URL('../dist/installer.js', import.meta.url).href)}); const {getRecord}=await import(${JSON.stringify(new URL('../dist/storage.js', import.meta.url).href)}); installProject(process.argv[1]); process.stdout.write(JSON.stringify(getRecord(process.argv[1],process.argv[2]).meta.data.increment_id));`;
  const run = () =>
    new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        ['--input-type=module', '-e', script, root, pending.meta.id],
        { shell: false, windowsHide: true },
      );
      let stdout = '',
        stderr = '';
      child.stdout.on('data', (data) => {
        stdout += data;
      });
      child.stderr.on('data', (data) => {
        stderr += data;
      });
      child.on('error', reject);
      child.on('close', (code) =>
        code === 0 ? resolve(JSON.parse(stdout)) : reject(new Error(stderr)),
      );
    });
  const [first, second] = await Promise.all([run(), run()]);
  assert.equal(first, second);
  assert.equal(getRecord(root, pending.meta.id).meta.data.increment_id, first);
  updateProject(root);
  assert.equal(getRecord(root, pending.meta.id).meta.data.increment_id, first);
});

test('strict roles use Luna max and gateway tool declarations preserve reviewer independence', (t) => {
  const root = project(t);
  installProject(root);
  for (const role of [
    'manager',
    'requirements',
    'architect',
    'component-owner',
    'verifier',
    'reviewer',
  ]) {
    const file = read(root, `.codex/agents/verythinker-${role}.toml`);
    assert.match(file, /model = "gpt-6-luna"/);
    assert.match(file, /model_reasoning_effort = "max"/);
    assert.match(file, /sandbox_mode = "read-only"/);
  }
  for (const role of [
    'researcher',
    'codebase-analyst',
    'curator',
    'developer',
    'check-executor',
    'release',
  ])
    assert.match(read(root, `.codex/agents/verythinker-${role}.toml`), /model = "gpt-6-luna"/);
  const reviewer = read(root, '.codex/agents/verythinker-reviewer.toml');
  const enabled = JSON.parse(/^enabled_tools = (.+)$/m.exec(reviewer)[1]);
  assert.ok(enabled.includes('task_review'));
  assert.ok(!enabled.includes('task_submit'));
  assert.ok(!enabled.includes('record_update'));
  const claude = read(root, '.claude/agents/verythinker-reviewer.md');
  const toolLine = /^tools: (.+)$/m.exec(claude)[1].split(', ');
  assert.ok(toolLine.includes('Read'));
  assert.ok(toolLine.includes('mcp__verythinker__task_review'));
  assert.ok(!toolLine.includes('Edit'));
  const copilot = JSON.parse(
    /^tools: (.+)$/m.exec(read(root, '.github/agents/verythinker-reviewer.agent.md'))[1],
  );
  assert.ok(copilot.includes('verythinker/task_review'));
  assert.ok(!copilot.includes('edit'));
  assert.ok(existsSync(join(root, '.verythinker/roles/check-executor.capabilities.json')));
  assert.match(read(root, '.agents/skills/verythinker-manager/SKILL.md'), /manager_run/);
});

test('project-owned routing, archive, and tool policies survive updates', (t) => {
  const root = project(t, ['codex']);
  installProject(root);
  const archive = JSON.parse(read(root, '.verythinker/archive.json'));
  archive.repository = 'example/private';
  archive.enabled = false;
  write(root, '.verythinker/archive.json', JSON.stringify(archive, null, 2) + '\n');
  const tools = JSON.parse(read(root, '.verythinker/tools.json'));
  tools.automatic_install = false;
  tools.approved_providers = ['context7'];
  write(root, '.verythinker/tools.json', JSON.stringify(tools, null, 2) + '\n');
  const before = read(root, '.verythinker/routing.json');
  const report = updateProject(root);
  assert.deepEqual(report.conflicts, []);
  assert.equal(read(root, '.verythinker/routing.json'), before);
  assert.equal(JSON.parse(read(root, '.verythinker/archive.json')).repository, 'example/private');
  assert.equal(JSON.parse(read(root, '.verythinker/tools.json')).automatic_install, false);
  const health = doctor(root);
  assert.deepEqual(health.routing.observations, []);
  assert.equal(health.archives.enabled, false);
  assert.equal(health.tools.policy.automatic_install, false);
});

test('invalid JSON remains untouched with a generated candidate', (t) => {
  const root = project(t, ['claude']);
  write(root, '.mcp.json', '{ invalid user content');
  const report = installProject(root);
  assert.equal(read(root, '.mcp.json'), '{ invalid user content');
  const conflict = report.conflicts.find(
    (item) => item.path === '.mcp.json#mcpServers.verythinker',
  );
  assert.ok(conflict);
  assert.ok(parse(read(root, conflict.candidate)).mcpServers.verythinker);
});

test('user-owned dotted, inline, and nested TOML server settings receive candidates', (t) => {
  for (const source of [
    'mcp_servers.verythinker = { command = "user-provider" }\n',
    '[mcp_servers]\nverythinker = { command = "user-provider" }\n\n[other]\nvalue = true\n',
    '[mcp_servers.verythinker.env]\nCUSTOM = "user-value"\n',
  ]) {
    const root = project(t, ['codex']);
    write(root, '.codex/config.toml', source);
    const report = installProject(root);
    assert.equal(read(root, '.codex/config.toml'), source);
    assert.ok(report.conflicts.some((item) => item.path === '.codex/config.toml#mcp'));
  }
});

function conformance(root, change = {}) {
  const report = {
    package: '@colbymchenry/codegraph',
    version: '1.6.2',
    status: 'supported-for-fixture',
    environment: { platform: process.platform, architecture: process.arch },
    checks: codeGraphConformanceChecks.map((id) => ({ id, status: 'passed' })),
    limitations: ['A small synthetic test fixture is not native client evidence.'],
    ...change,
  };
  const path = join(root, 'test-conformance.json');
  writeFileSync(path, JSON.stringify(report, null, 2));
  return path;
}

test(
  'explicit CodeGraph enable validates evidence, preserves configuration, and detects a changed report',
  { skip: process.platform !== 'win32' },
  (t) => {
    const root = project(t);
    installProject(root);
    write(
      root,
      '.mcp.json',
      read(root, '.mcp.json').replace('{', '{\n // User comment\n "extra": true,'),
    );
    const report = conformance(root);
    const args = ['test-provider.js', 'serve', '--mcp', '--path', root];
    const config = configureCodeGraph(root, report, process.execPath, args);
    assert.equal(config.enabled, true);
    assert.equal(config.status, 'supported-for-fixture');
    assert.equal(config.report_hash.length, 64);
    assert.deepEqual(config.args, args);
    assert.equal(read(root, config.report_path), readFileSync(report, 'utf8'));
    assert.deepEqual(updateProject(root).conflicts, []);
    const mcp = parse(read(root, '.mcp.json'));
    assert.equal(mcp.extra, true);
    assert.match(read(root, '.mcp.json'), /User comment/);
    assert.equal(mcp.mcpServers.codegraph.command, process.execPath);
    assert.deepEqual(mcp.mcpServers.codegraph.args, args);
    assert.equal(mcp.mcpServers.codegraph.env.CODEGRAPH_NO_DOWNLOAD, '1');
    assert.match(read(root, '.codex/config.toml'), /\[mcp_servers.codegraph\]/);
    assert.equal(doctor(root).codegraph.status, 'supported-for-fixture');
    assert.equal(
      doctor(root).platforms[0].capabilities.find((item) => item.capability === 'mcp').status,
      'unverified',
    );
    assert.deepEqual(updateProject(root).conflicts, []);
    write(root, config.report_path, read(root, config.report_path) + '\n');
    const changed = doctor(root);
    assert.equal(changed.codegraph.enabled, false);
    assert.match(changed.warnings.join(' '), /changed since approval/);
    assert.throws(() => updateProject(root), /changed since approval/);
  },
);

test(
  'CodeGraph rejects incomplete evidence, wrong versions, wrong platforms, and invalid launch arguments',
  { skip: process.platform !== 'win32' },
  (t) => {
    const root = project(t);
    const args = ['test-provider.js', 'serve', '--mcp', '--path', root];
    for (const change of [
      { version: '1.6.3' },
      { environment: { platform: 'linux', architecture: process.arch } },
      { checks: codeGraphConformanceChecks.slice(1).map((id) => ({ id, status: 'passed' })) },
      {
        checks: codeGraphConformanceChecks.map((id) => ({
          id,
          status: id === 'watch-modify' ? 'failed' : 'passed',
        })),
      },
      { checks: codeGraphConformanceChecks.map(() => ({ id: 'version', status: 'passed' })) },
    ]) {
      assert.throws(
        () => configureCodeGraph(root, conformance(root, change), process.execPath, args),
        /CodeGraph/,
      );
    }
    const report = conformance(root);
    assert.throws(() => configureCodeGraph(root, report, 'node', args), /absolute executable/);
    assert.throws(
      () => configureCodeGraph(root, report, process.execPath, ['serve', '--mcp']),
      /absolute project root/,
    );
    assert.throws(
      () => configureCodeGraph(root, report, process.execPath, ['serve', '--path', root]),
      /serve and --mcp/,
    );
    assert.equal(existsSync(join(root, '.verythinker/optional/codegraph.json')), false);
  },
);

test(
  'CodeGraph enable preserves user-owned server entries and creates review candidates',
  { skip: process.platform !== 'win32' },
  (t) => {
    const root = project(t);
    write(
      root,
      '.mcp.json',
      '{ // Keep this provider\n "mcpServers": {"codegraph": {"command":"user-provider"}}\n}\n',
    );
    write(
      root,
      '.codex/config.toml',
      '# Existing provider\n[mcp_servers.codegraph]\ncommand = "user-provider"\n',
    );
    configureCodeGraph(root, conformance(root), process.execPath, [
      'test-provider.js',
      'serve',
      '--mcp',
      '--path',
      root,
    ]);
    const report = installProject(root);
    assert.equal(parse(read(root, '.mcp.json')).mcpServers.codegraph.command, 'user-provider');
    assert.match(read(root, '.mcp.json'), /Keep this provider/);
    assert.match(read(root, '.codex/config.toml'), /command = "user-provider"/);
    assert.ok(report.conflicts.some((item) => item.path === '.mcp.json#mcpServers.codegraph'));
    assert.ok(report.conflicts.some((item) => item.path === '.codex/config.toml#codegraph'));
    assert.equal(
      doctor(root).platforms[0].capabilities.find((item) => item.capability === 'adapter-files')
        .status,
      'restricted',
    );
  },
);
