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
import { spawnSync } from 'node:child_process';
import { parse } from 'jsonc-parser';
import { installProject, updateProject, doctor, configureCodeGraph } from '../dist/installer.js';
import { codeGraphConformanceChecks } from '../dist/adapters.js';

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
  assert.equal(readdirSync(join(root, '.codex/agents')).length, 10);
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
      'unverified',
    );
  }
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
