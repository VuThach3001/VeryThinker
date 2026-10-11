import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, realpathSync } from 'node:fs';
import { resolve, join, dirname, basename } from 'node:path';
import { tmpdir, release } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

export const packageID = '@colbymchenry/codegraph';
export const pinnedVersion = '1.6.2';
export const requiredChecks = ['version', 'windows', 'c-symbol', 'cpp-symbol', 'cross-file-caller', 'modify-sync', 'add-sync', 'delete-sync', 'mcp-tool', 'reconnect-freshness', 'watch-add', 'watch-modify'];

export function assessConformance(checks) {
  const byID = new Map(checks.map(check => [check.id, check]));
  return requiredChecks.every(id => byID.get(id)?.status === 'passed') ? 'supported-for-fixture' : 'unverified';
}

const environment = { ...process.env, CODEGRAPH_TELEMETRY: '0', DO_NOT_TRACK: '1',
  CODEGRAPH_NO_DOWNLOAD: '1', CODEGRAPH_NO_DAEMON: '1', CODEGRAPH_WATCH_DEBOUNCE_MS: '100' };

function execute(command, args, cwd, timeout = 60000) {
  return new Promise(resolveResult => {
    const started = performance.now();
    const process = spawn(command, args, { cwd, env: environment, windowsHide: true });
    let stdout = '', stderr = '', error;
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; process.kill(); }, timeout);
    process.stdout.on('data', data => { stdout += data.toString(); });
    process.stderr.on('data', data => { stderr += data.toString(); });
    process.on('error', failure => { error = failure.message; });
    process.on('close', (status, signal) => {
      clearTimeout(timer);
      resolveResult({ command, args, status, signal, timed_out: timedOut, duration_ms: Math.round(performance.now() - started),
        stdout: stdout.slice(0, 200000), stderr: stderr.slice(0, 10000), ...(error ? { error } : {}) });
    });
  });
}

function parsedNodes(result) {
  if (result.status !== 0) throw new Error(result.stderr || result.error || `Command exited ${result.status}`);
  const parsed = JSON.parse(result.stdout);
  if (!Array.isArray(parsed)) throw new Error('Expected a JSON array from CodeGraph query.');
  return parsed.map(item => item.node ?? item);
}
function safeCleanup(sandbox) {
  const temporary = realpathSync(tmpdir());
  const target = realpathSync(sandbox);
  if (dirname(target) !== temporary || !basename(target).startsWith('verythinker-codegraph-')) throw new Error('Refusing to remove a directory outside the created test sandbox.');
  rmSync(target, { recursive: true, force: true });
}
function bundleLauncher(packageRoot) {
  const platformPackage = join(packageRoot, 'node_modules', '@colbymchenry', `codegraph-${process.platform}-${process.arch}`);
  if (process.platform === 'win32') return { command: join(platformPackage, 'node.exe'),
    args: ['--liftoff-only', '--disable-warning=ExperimentalWarning', join(platformPackage, 'lib', 'dist', 'bin', 'codegraph.js')] };
  return { command: join(platformPackage, 'bin', 'codegraph'), args: [] };
}
function fixture(root, name = 'sensor_read', value = 42) {
  writeFileSync(join(root, 'sensor.h'), `int ${name}(void);\n`);
  writeFileSync(join(root, 'sensor.c'), `#include "sensor.h"\nint ${name}(void) { return ${value}; }\n`);
  writeFileSync(join(root, 'controller.cpp'), `extern "C" {\n#include "sensor.h"\n}\nclass Controller { public: int sample() { return ${name}(); } };\nint control_step() { Controller controller; return controller.sample(); }\n`);
}

export async function runConformance({ packageRoot, install = false } = {}) {
  const sandbox = mkdtempSync(join(realpathSync(tmpdir()), 'verythinker-codegraph-'));
  const root = join(sandbox, 'fixture');
  mkdirSync(root);
  const report = { schema_version: 1, package: packageID, version: pinnedVersion, tested_at: new Date().toISOString(),
    environment: { platform: process.platform, architecture: process.arch, os_release: release(), host_node: process.version },
    status: 'unverified', enabled: false, checks: [], commands: [], limitations: [
      'Results apply only to this small C/C++ fixture and recorded platform/package version.',
      'A code graph assists code discovery; it does not establish engineering requirement traceability.',
      'The runner does not change native agent configuration or enable the provider.',
    ] };
  let client;
  function check(id, passed, detail) { report.checks.push({ id, status: passed ? 'passed' : 'failed', detail }); }
  try {
    if (install) {
      packageRoot = sandbox;
      const npm = process.env.npm_execpath ?? join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
      if (!existsSync(npm)) throw new Error('npm CLI script not found. Run with --package-root pointing to an isolated installation.');
      const result = await execute(process.execPath, [npm, 'install', '--prefix', sandbox, '--no-audit', '--no-fund', '--ignore-scripts', `${packageID}@${pinnedVersion}`], sandbox, 120000);
      report.commands.push(result);
      if (result.status !== 0) throw new Error(`Pinned package installation failed: ${result.stderr || result.error}`);
    }
    if (!packageRoot) throw new Error('Package is not installed. Supply --install or --package-root; no global installation is used.');
    packageRoot = resolve(packageRoot);
    const packagePath = join(packageRoot, 'node_modules', '@colbymchenry', 'codegraph');
    const metadata = JSON.parse(readFileSync(join(packagePath, 'package.json'), 'utf8'));
    if (metadata.version !== pinnedVersion) throw new Error(`Expected ${pinnedVersion}; installed package is ${metadata.version}.`);
    const launcher = bundleLauncher(packageRoot);
    async function command(args) {
      const result = await execute(launcher.command, [...launcher.args, ...args], root);
      report.commands.push(result);
      return result;
    }
    const version = await command(['version']);
    check('version', version.status === 0 && version.stdout.trim() === pinnedVersion, `Observed ${version.stdout.trim() || version.stderr}`);
    check('windows', process.platform === 'win32' && version.status === 0, `${process.platform}/${process.arch}`);
    fixture(root);
    const initialized = await command(['init', root]);
    if (initialized.status !== 0) throw new Error(`Fixture indexing failed: ${initialized.stderr || initialized.stdout}`);
    const query = async name => parsedNodes(await command(['query', name, '--path', root, '--json']));
    const c = await query('sensor_read');
    check('c-symbol', c.some(node => node.name === 'sensor_read' && node.language === 'c'), 'C definition from sensor.c');
    const cpp = await query('control_step');
    check('cpp-symbol', cpp.some(node => node.name === 'control_step' && node.language === 'cpp'), 'C++ definition from controller.cpp');
    const callers = await command(['callers', 'sensor_read', '--path', root, '--json']);
    let callerNodes = [];
    try { callerNodes = JSON.parse(callers.stdout); } catch {}
    check('cross-file-caller', callers.status === 0 && JSON.stringify(callerNodes).includes('controller.cpp') && JSON.stringify(callerNodes).includes('sample'), 'C++ Controller.sample calls C sensor_read across files');
    fixture(root, 'sensor_measure');
    writeFileSync(join(root, 'guard.c'), 'int sensor_guard(void) { return 1; }\n');
    const sync = await command(['sync', root]);
    if (sync.status !== 0) throw new Error(`Incremental sync failed: ${sync.stderr}`);
    const old = await query('sensor_read');
    const changed = await query('sensor_measure');
    check('modify-sync', old.every(node => node.name !== 'sensor_read') && changed.some(node => node.name === 'sensor_measure'), 'Renamed definition replaces its previous indexed name');
    const added = await query('sensor_guard');
    check('add-sync', added.some(node => node.name === 'sensor_guard'), 'Added C file indexed after explicit sync');
    rmSync(join(root, 'guard.c'));
    const deletionSync = await command(['sync', root]);
    if (deletionSync.status !== 0) throw new Error(`Deletion sync failed: ${deletionSync.stderr}`);
    check('delete-sync', (await query('sensor_guard')).every(node => node.name !== 'sensor_guard'), 'Deleted C file removed after explicit sync');
    fixture(root, 'sensor_latest');
    const bundledNode = process.platform === 'win32' ? await execute(launcher.command, ['--version'], root) : null;
    if (bundledNode) report.environment.bundled_node = bundledNode.stdout.trim();
    const transport = new StdioClientTransport({ command: launcher.command,
      args: [...launcher.args, 'serve', '--mcp', '--path', root], cwd: root, env: environment, stderr: 'pipe' });
    report.commands.push({ command: launcher.command, args: [...launcher.args, 'serve', '--mcp', '--path', root], purpose: 'MCP direct mode, automatic watcher enabled' });
    client = new Client({ name: 'verythinker-codegraph-conformance', version: '0.1.0' });
    await client.connect(transport, { timeout: 30000 });
    const tools = await client.listTools();
    check('mcp-tool', tools.tools.some(tool => tool.name === 'codegraph_explore'), 'MCP codegraph_explore discovered through initialize and tools/list');
    async function explore(query) {
      const result = await client.callTool({ name: 'codegraph_explore', arguments: { query, projectPath: root } }, undefined, { timeout: 30000 });
      return result.content?.filter(item => item.type === 'text').map(item => item.text).join('\n') ?? '';
    }
    const reconnected = await explore('sensor_latest');
    report.commands.push({ operation: 'tools/call', tool: 'codegraph_explore', query: 'sensor_latest', result: reconnected.slice(0, 12000) });
    check('reconnect-freshness', /sensor_latest\s*\(void\)/.test(reconnected), 'Source edited while server was absent is reflected after MCP connection');
    writeFileSync(join(root, 'watch.c'), 'int watch_added(void) { return 7; }\n');
    async function eventually(name, pattern) {
      const deadline = Date.now() + 20000;
      let output = '';
      let observedStaleWarning = false;
      while (Date.now() < deadline) {
        output = await explore(name);
        const stale = /⚠️|pending sync|indexing in progress|edited since the last index sync/i.test(output);
        observedStaleWarning ||= stale;
        if (pattern.test(output) && !stale) return { passed: true, output, observed_stale_warning: observedStaleWarning };
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      return { passed: false, output, observed_stale_warning: observedStaleWarning };
    }
    const watchedAdd = await eventually('watch_added', /watch_added\s*\(void\)/);
    check('watch-add', watchedAdd.passed, 'Added C file is returned through the live MCP server without explicit sync');
    report.commands.push({ operation: 'tools/call', tool: 'codegraph_explore', query: 'watch_added', observed_stale_warning: watchedAdd.observed_stale_warning, result: watchedAdd.output.slice(0, 12000) });
    writeFileSync(join(root, 'watch.c'), 'int watch_updated(void) { return 19; }\n');
    const watchedModify = await eventually('watch_updated', /watch_updated\s*\(void\)\s*\{ return 19/);
    const newIndexed = await query('watch_updated');
    const oldIndexed = await query('watch_added');
    check('watch-modify', watchedModify.passed && newIndexed.some(node => node.name === 'watch_updated') && oldIndexed.every(node => node.name !== 'watch_added'), 'Renamed symbol and changed body become warning-free; indexed name changes without explicit sync');
    report.commands.push({ operation: 'tools/call', tool: 'codegraph_explore', query: 'watch_updated after symbol/body change', observed_stale_warning: watchedModify.observed_stale_warning, result: watchedModify.output.slice(0, 12000) });
  } catch (error) {
    report.limitations.push(error instanceof Error ? error.message : String(error));
  } finally {
    if (client) await client.close().catch(error => report.limitations.push(`MCP shutdown: ${error.message}`));
    try { safeCleanup(sandbox); } catch (error) { report.limitations.push(`Sandbox cleanup: ${error.message}`); }
  }
  for (const id of requiredChecks) if (!report.checks.some(check => check.id === id)) report.checks.push({ id, status: 'unverified', detail: 'Not executed because a prerequisite was unavailable or failed.' });
  report.status = assessConformance(report.checks);
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log('Usage: node scripts/codegraph-check.mjs [--install | --package-root PATH] [--out REPORT.json]\nRuns a pinned isolated C/C++ CLI and MCP conformance check. Provider remains disabled.');
  } else {
    const option = name => { const position = args.indexOf(name); return position < 0 ? undefined : args[position + 1]; };
    const report = await runConformance({ install: args.includes('--install'), packageRoot: option('--package-root') });
    const output = option('--out');
    if (output) { mkdirSync(dirname(resolve(output)), { recursive: true }); writeFileSync(output, JSON.stringify(report, null, 2) + '\n'); }
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.status === 'supported-for-fixture' ? 0 : 1;
  }
}
