import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  realpathSync,
} from 'node:fs';
import { dirname, join, resolve, relative, isAbsolute, delimiter } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parse, modify, applyEdits, type ParseError } from 'jsonc-parser';
import { ensureAutomationPolicy, readAutomationPolicy, type AutomationPolicy } from './manager.js';
import { ensureArchivePolicy, readArchivePolicy, type ArchivePolicy } from './archives.js';
import {
  defaultRoutingPolicy,
  priorDefaultRoutingPolicy,
  canonicalJson,
  ensureRoutingPolicy,
  readRoutingPolicy,
  readInvocation,
  invocationIsActive,
  ownerIsAlive,
  routingProblems,
  strongRoles,
  workerRoles,
  type RoutingPolicy,
} from './routing.js';
import { ensureToolPolicy, toolObservations, roleCapabilities } from './tools.js';
import { atomicWrite, loadRecords, updateRecord, withOperationLock } from './storage.js';
import { strings } from './engineering.js';
import {
  adapterOutputs,
  codeGraphProvider,
  resourcesDirectory,
  platforms,
  loadCodeGraphConfiguration,
  validateCodeGraphReport,
  validateCodeGraphCommand,
  type CodeGraphConfiguration,
  type Platform,
  type AdapterConfig,
  type ManagedOutput,
} from './adapters.js';

export type { Platform } from './adapters.js';
export type { CodeGraphConfiguration } from './adapters.js';
interface ManifestEntry {
  path: string;
  kind: ManagedOutput['kind'];
  key?: string;
  hash: string;
  version: string;
}
interface Manifest {
  schema_version: 1;
  version: string;
  files: Record<string, ManifestEntry>;
}
export interface InstallReport {
  schema_version: 1;
  version: string;
  root: string;
  platforms: Platform[];
  installed: string[];
  updated: string[];
  unchanged: string[];
  conflicts: { path: string; candidate: string; reason: string }[];
  warnings: string[];
}
export interface InstallOptions {
  platforms?: Platform[];
  profile?: string;
  name?: string;
  force?: boolean;
}
type Status = 'supported' | 'configured' | 'restricted' | 'unverified';
export interface DoctorReport {
  schema_version: 1;
  root: string;
  version: string;
  runtime: { node: string; supported: boolean };
  platforms: {
    platform: Platform;
    client: { executable: string | null; version: string | null };
    capabilities: { capability: string; status: Status; detail: string }[];
    requested_models: AdapterConfig['models'];
  }[];
  codegraph: typeof codeGraphProvider | CodeGraphConfiguration;
  automation: AutomationPolicy;
  routing: {
    policy: RoutingPolicy | null;
    observations: { id: string; role: string; model: string | null; state: string }[];
    limitations: string[];
  };
  archives: ArchivePolicy | null;
  tools: unknown;
  warnings: string[];
}

function version(): string {
  return (
    JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      version: string;
    }
  ).version;
}
function hash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}
function text(path: string): string | undefined {
  return existsSync(path) ? readFileSync(path, 'utf8') : undefined;
}
function configFor(root: string): AdapterConfig {
  const path = join(root, '.verythinker', 'config.json');
  if (!existsSync(path)) throw new Error('Project is not initialized. Run verythinker init first.');
  const config = JSON.parse(readFileSync(path, 'utf8')) as AdapterConfig;
  if (
    !Array.isArray(config.platforms) ||
    config.platforms.some((platform) => !platforms.includes(platform))
  ) {
    throw new Error('Project configuration has an unsupported platform.');
  }
  return config;
}

function safePath(root: string, path: string): string {
  const result = resolve(root, path);
  const rel = relative(root, result).replaceAll('\\', '/');
  if (isAbsolute(rel) || rel === '..' || rel.startsWith('../')) {
    throw new Error(`Managed path escapes the project: ${path}`);
  }
  // Existing symlinks can redirect a relative managed path outside the project.
  let parent = result;
  while (parent !== root) {
    let link = false;
    try {
      link = lstatSync(parent).isSymbolicLink();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (link) throw new Error(`Managed path uses a symbolic link: ${path}`);
    parent = dirname(parent);
  }
  return result;
}

function save(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf8');
}
function manifestFor(root: string): Manifest {
  const source = text(safePath(root, '.verythinker/install-manifest.json'));
  if (!source) return { schema_version: 1, version: version(), files: {} };
  const manifest = JSON.parse(source) as Manifest;
  if (manifest.schema_version !== 1 || !manifest.files || typeof manifest.files !== 'object')
    throw new Error('Unsupported installation manifest.');
  return manifest;
}
function migratePendingRouting(
  root: string,
  report: InstallReport,
): {
  migrated: string[];
  preserved: string[];
  blocked: boolean;
} {
  let records;
  try {
    records = loadRecords(root);
  } catch {
    const base = '.verythinker/migrations/alpha3-records-review.json';
    const body =
      JSON.stringify(
        {
          schema_version: 1,
          status: 'blocked-invalid-record-storage',
          reason:
            'Existing records have invalid metadata or duplicate identities. No original records were modified.',
          recovery:
            'Validate and repair the authoritative records, then rerun the project update. Pending work cannot use legacy model observations for new execution.',
        },
        null,
        2,
      ) + '\n';
    let candidate = base;
    let suffix = 1;
    while (existsSync(safePath(root, candidate)) && text(safePath(root, candidate)) !== body)
      candidate = `${base}.${suffix++}`;
    save(safePath(root, candidate), body);
    report.conflicts.push({
      path: '.verythinker/records#alpha3-pending-routing',
      candidate,
      reason:
        'Existing record validation prevents safe pending-work migration; records were preserved for review.',
    });
    report.warnings.push(
      'Pending-work migration requires valid authoritative records; inspect the migration review candidate.',
    );
    return { migrated: [], preserved: [], blocked: true };
  }
  const closedWorkflowIds = new Set<string>();
  const closedTaskIds = new Set<string>();
  for (const record of records) {
    const tasks = strings(record.meta.data.task_ids);
    if (
      record.meta.data.kind !== 'manager-workflow' ||
      !['completed', 'completed-with-blockers'].includes(String(record.meta.data.phase)) ||
      typeof record.meta.data.final_report_id !== 'string' ||
      !tasks.length
    )
      continue;
    const reportRecord = records.find((item) => item.meta.id === record.meta.data.final_report_id);
    if (
      reportRecord?.meta.data.kind !== 'work-record' ||
      !reportRecord.meta.links.some(
        (link) => link.type === 'documents' && link.target === record.meta.id,
      )
    )
      continue;
    closedWorkflowIds.add(record.meta.id);
    for (const id of tasks)
      if (
        records.some(
          (item) =>
            item.meta.id === id &&
            item.meta.type === 'task' &&
            ['submitted', 'verified', 'accepted', 'superseded'].includes(item.meta.status),
        )
      )
        closedTaskIds.add(id);
  }
  const migrated: string[] = [];
  const preserved: string[] = [];
  for (const record of records) {
    if (record.meta.type !== 'task' && record.meta.data.kind !== 'manager-workflow') continue;
    if (
      ['accepted', 'superseded'].includes(record.meta.status) ||
      closedWorkflowIds.has(record.meta.id) ||
      closedTaskIds.has(record.meta.id)
    ) {
      preserved.push(record.meta.id);
      continue;
    }
    const missingIncrement =
      record.meta.data.kind === 'manager-workflow' &&
      (record.meta.data.increment_id === undefined || record.meta.data.increment_id === null);
    if (record.meta.data.routing_required === true && !missingIncrement) continue;
    updateRecord(root, record.meta.id, {
      data: {
        routing_required: true,
        ...(missingIncrement ? { increment_id: randomUUID() } : {}),
        ...(record.meta.data.routing_required === true
          ? {}
          : {
              routing_migration: {
                version: 'alpha.3',
                prior_observations: 'legacy',
                reassessment:
                  'Confirmed Luna/max strategic planning and a native worker invocation are required before resuming pending work.',
              },
            }),
      },
    });
    migrated.push(record.meta.id);
    report.updated.push(`${record.path}#pending-routing`);
  }
  return { migrated, preserved, blocked: false };
}
interface RoutingUpdate {
  policy: RoutingPolicy;
  legacy: boolean;
  blocked: boolean;
  migrate: boolean;
}
function routingCandidate(root: string, report: InstallReport, reason: string): string {
  const base = '.verythinker/routing.json.verythinker-update-routing';
  const body = JSON.stringify(defaultRoutingPolicy(), null, 2) + '\n';
  let target = base;
  let suffix = 1;
  while (existsSync(safePath(root, target)) && text(safePath(root, target)) !== body)
    target = `${base}.${suffix++}`;
  save(safePath(root, target), body);
  report.conflicts.push({ path: '.verythinker/routing.json', candidate: target, reason });
  return target;
}
function activeRoutingOwner(root: string): { active: boolean; reason?: string } {
  const directory = safePath(root, '.verythinker/native/receipts');
  if (!existsSync(directory)) return { active: false };
  for (const file of readdirSync(directory)) {
    const match = /^([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\.json$/i.exec(
      file,
    );
    if (!match) continue;
    try {
      const receipt = readInvocation(root, match[1]!);
      const ownerAlive = ownerIsAlive(receipt.owner_pid);
      const serverAlive =
        typeof receipt.server_pid === 'number' && ownerIsAlive(receipt.server_pid);
      if (invocationIsActive(receipt) && (ownerAlive || serverAlive))
        return { active: true, reason: `Live native invocation ${receipt.id} is still active.` };
    } catch {
      return {
        active: true,
        reason: `Native receipt ${match[1]} could not be authenticated, so routing migration cannot establish that it is inactive.`,
      };
    }
  }
  return { active: false };
}
function prepareRoutingUpdate(root: string, report: InstallReport): RoutingUpdate {
  let existing: RoutingPolicy | null;
  try {
    existing = readRoutingPolicy(root);
  } catch (error) {
    routingCandidate(
      root,
      report,
      `Authored routing policy was preserved because it is not one of the approved exact schemas. Review the Luna/max candidate. ${String(error)}`,
    );
    report.warnings.push(
      'Routing policy migration is blocked until the authored policy is reviewed; the original policy remains active.',
    );
    throw new Error(
      'Routing policy is not an approved exact schema; it was preserved and a Luna/max review candidate was written.',
    );
  }
  if (!existing)
    return { policy: defaultRoutingPolicy(), legacy: false, blocked: false, migrate: false };
  const legacy = canonicalJson(existing) === canonicalJson(priorDefaultRoutingPolicy());
  if (!legacy) return { policy: existing, legacy: false, blocked: false, migrate: false };
  const active = activeRoutingOwner(root);
  if (active.active) {
    routingCandidate(
      root,
      report,
      `The exact Sol/high legacy policy remains in place because ${active.reason} Review the Luna/max candidate after the invocation is settled.`,
    );
    report.warnings.push(
      'Routing and Codex model migration is deferred while a live native invocation may be using the legacy policy.',
    );
    return { policy: existing, legacy: true, blocked: true, migrate: false };
  }
  return { policy: defaultRoutingPolicy(), legacy: true, blocked: false, migrate: true };
}
function outputID(output: ManagedOutput): string {
  return `${output.path}${output.key ? `#${output.key}` : ''}`;
}
function markers(output: ManagedOutput): { begin: string; end: string } {
  const key = output.key ?? 'instructions';
  return output.path.endsWith('.toml') || output.path.endsWith('.gitignore')
    ? { begin: `# BEGIN VERYTHINKER ${key}`, end: `# END VERYTHINKER ${key}` }
    : { begin: `<!-- BEGIN VERYTHINKER ${key} -->`, end: `<!-- END VERYTHINKER ${key} -->` };
}
function blockState(
  source: string | undefined,
  output: ManagedOutput,
): { value?: string; start?: number; end?: number; malformed?: boolean } {
  if (source === undefined) return {};
  const mark = markers(output);
  const start = source.indexOf(mark.begin);
  const finish = source.indexOf(mark.end);
  if (start < 0 && finish < 0) return {};
  if (
    start < 0 ||
    finish < start ||
    source.indexOf(mark.begin, start + mark.begin.length) >= 0 ||
    source.indexOf(mark.end, finish + mark.end.length) >= 0
  )
    return { malformed: true };
  return {
    value: source
      .slice(start + mark.begin.length, finish)
      .replace(/^\r?\n/, '')
      .replace(/\r?\n$/, ''),
    start,
    end: finish + mark.end.length,
  };
}
function parseJSON(source: string): unknown {
  const errors: ParseError[] = [];
  const result: unknown = parse(source, errors, {
    allowTrailingComma: true,
    disallowComments: false,
  });
  if (errors.length || !result || typeof result !== 'object' || Array.isArray(result))
    throw new Error('Existing JSON configuration is not a valid object.');
  return result;
}
function jsonValue(object: unknown, path: (string | number)[]): unknown {
  return path.reduce<unknown>(
    (value, key) =>
      value && typeof value === 'object'
        ? (value as Record<string | number, unknown>)[key]
        : undefined,
    object,
  );
}

function installOutput(
  root: string,
  output: ManagedOutput,
  manifest: Manifest,
  report: InstallReport,
): void {
  const path = safePath(root, output.path);
  const current = text(path);
  const id = outputID(output);
  const previous = manifest.files[id];
  let currentValue = current;
  let proposed = output.content;
  let targetHash = hash(proposed);
  let reason: string | undefined;
  try {
    if (output.kind === 'block') {
      const mark = markers(output);
      const block = `${mark.begin}\n${output.content.trimEnd()}\n${mark.end}`;
      proposed = `${block}\n`;
      const state = blockState(current, output);
      if (state.malformed) throw new Error('Managed markers are malformed.');
      currentValue = state.value;
      targetHash = hash(output.content.trimEnd());
      proposed =
        state.start === undefined
          ? `${current?.trimEnd() ?? ''}${current ? '\n\n' : ''}${block}\n`
          : `${current!.slice(0, state.start)}${block}${current!.slice(state.end)}`;
      const serverName = output.key === 'codegraph' ? 'codegraph' : 'verythinker';
      const serverKey = `(?:${serverName}|"${serverName}"|'${serverName}')`;
      const table = new RegExp(
        `^\\s*\\[\\s*mcp_servers\\s*\\.\\s*${serverKey}\\s*(?:\\.|\\])`,
        'm',
      );
      const dotted = new RegExp(`^\\s*mcp_servers\\s*\\.\\s*${serverKey}\\s*(?:\\.|=)`, 'm');
      const parent = /^\s*\[\s*mcp_servers\s*\]([\s\S]*?)(?=^\s*\[|(?![\s\S]))/m.exec(
        current ?? '',
      )?.[1];
      const child = new RegExp(`^\\s*${serverKey}\\s*(?:\\.|=)`, 'm');
      if (
        output.path.endsWith('.toml') &&
        state.start === undefined &&
        current &&
        (table.test(current) || dotted.test(current) || (parent && child.test(parent)))
      ) {
        reason = `A user-owned ${serverName} MCP table already exists.`;
      }
    } else if (output.kind === 'json') {
      proposed = applyEdits(
        '{}\n',
        modify('{}\n', output.jsonPath!, output.value, {
          formattingOptions: { insertSpaces: true, tabSize: 2, eol: '\n' },
        }),
      );
      const object = current === undefined ? {} : parseJSON(current);
      const value = jsonValue(object, output.jsonPath!);
      currentValue = value === undefined ? undefined : JSON.stringify(value);
      // Refuse replacing an existing primitive parent with a new object.
      for (let depth = 1; depth < output.jsonPath!.length; depth++) {
        const parent = jsonValue(object, output.jsonPath!.slice(0, depth));
        if (
          parent !== undefined &&
          (!parent || typeof parent !== 'object' || Array.isArray(parent))
        )
          throw new Error('A parent JSON setting has an incompatible value.');
      }
      proposed = applyEdits(
        current ?? '{}\n',
        modify(current ?? '{}\n', output.jsonPath!, output.value, {
          formattingOptions: { insertSpaces: true, tabSize: 2, eol: '\n' },
        }),
      );
    }
  } catch (error) {
    reason = error instanceof Error ? error.message : String(error);
  }
  const currentHash = currentValue === undefined ? undefined : hash(currentValue);
  if (!reason && currentHash === targetHash) {
    report.unchanged.push(id);
    // Only retain ownership acquired by this installer; identical user files remain user owned.
    if (previous) manifest.files[id] = { ...previous, hash: targetHash, version: report.version };
    return;
  }
  if (!reason && previous && currentHash !== previous.hash)
    reason =
      currentValue === undefined
        ? 'A managed file or entry was deleted by the user.'
        : 'A managed file or entry was modified by the user.';
  if (!reason && !previous && currentValue !== undefined)
    reason = 'Existing content is owned by the user.';
  if (reason) {
    const candidate = `${output.path}.verythinker-update${output.key ? `-${output.key.replace(/[^a-z0-9-]/gi, '-')}` : ''}`;
    const candidatePath = safePath(root, candidate);
    // Keep conflicting candidate edits too; choose a fresh numbered filename.
    let available = candidatePath;
    let suffix = 1;
    while (existsSync(available) && text(available) !== proposed)
      available = `${candidatePath}.${suffix++}`;
    save(available, proposed);
    report.conflicts.push({
      path: id,
      candidate: relative(root, available).replaceAll('\\', '/'),
      reason,
    });
    return;
  }
  save(path, proposed);
  manifest.files[id] = {
    path: output.path,
    kind: output.kind,
    ...(output.key ? { key: output.key } : {}),
    hash: targetHash,
    version: report.version,
  };
  (previous ? report.updated : report.installed).push(id);
}

function resourceOutputs(): ManagedOutput[] {
  const outputs: ManagedOutput[] = [];
  function visit(directory: string, prefix: string): void {
    if (!existsSync(directory)) return;
    for (const item of readdirSync(directory, { withFileTypes: true })) {
      if (item.isSymbolicLink()) continue;
      const path = join(directory, item.name);
      const target = `${prefix}/${item.name}`;
      if (item.isDirectory()) visit(path, target);
      else if (item.isFile())
        outputs.push({ path: target, kind: 'file', content: readFileSync(path, 'utf8') });
    }
  }
  for (const directory of ['roles', 'guides', 'templates', 'skills'])
    visit(join(resourcesDirectory, directory), `.verythinker/${directory}`);
  return outputs;
}

export function installProject(root: string, options: InstallOptions = {}): InstallReport {
  root = realpathSync(resolve(root));
  configFor(root);
  return withOperationLock(root, 'project-install', () =>
    withOperationLock(root, 'native-dispatch', () => installProjectClaimed(root, options)),
  );
}
function installProjectClaimed(root: string, options: InstallOptions): InstallReport {
  const config = configFor(root);
  const automationExists = existsSync(safePath(root, '.verythinker/automation.json'));
  const policyPaths = [
    '.verythinker/routing.json',
    '.verythinker/archive.json',
    '.verythinker/tools.json',
  ];
  const newPolicyPaths = policyPaths.filter((path) => !existsSync(safePath(root, path)));
  if (options.platforms) config.platforms = options.platforms;
  if (options.profile) config.profile = options.profile;
  if (options.name) config.name = options.name;
  if (config.platforms.some((platform) => !platforms.includes(platform)))
    throw new Error('Unsupported platform requested.');
  if (!['basic', 'software', 'embedded'].includes(config.profile))
    throw new Error('Unsupported project profile requested.');
  const manifest = manifestFor(root);
  const report: InstallReport = {
    schema_version: 1,
    version: version(),
    root,
    platforms: config.platforms,
    installed: [],
    updated: [],
    unchanged: [],
    conflicts: [],
    warnings: [],
  };
  const routingUpdate = prepareRoutingUpdate(root, report);
  if (routingUpdate.blocked) return report;
  if (options.platforms || options.profile || options.name)
    save(safePath(root, '.verythinker/config.json'), JSON.stringify(config, null, 2) + '\n');
  ensureAutomationPolicy(root);
  if (!automationExists) report.installed.push('.verythinker/automation.json');
  const defaults = {
    economy: 'gpt-6-luna',
    balanced: 'gpt-6-luna',
    strong: routingUpdate.policy.strong_model,
  };
  let changedMapping = false;
  const proposedConfig: AdapterConfig = structuredClone(config);
  let authoredConflict = false;
  if (!routingUpdate.blocked) {
    for (const tier of ['economy', 'balanced', 'strong'] as const) {
      const current = config.models[tier];
      const value = current && typeof current === 'object' ? current['codex'] : current;
      const managedLegacyStrong =
        tier === 'strong' &&
        routingUpdate.legacy &&
        routingUpdate.migrate &&
        current !== null &&
        typeof current === 'object' &&
        value === priorDefaultRoutingPolicy().strong_model;
      if (managedLegacyStrong) {
        config.models[tier] = {
          ...(current && typeof current === 'object' ? current : {}),
          codex: defaults[tier],
        };
        proposedConfig.models[tier] = config.models[tier];
        changedMapping = true;
      } else if (!value || value === 'inherit' || value === 'auto') {
        config.models[tier] = {
          ...(current && typeof current === 'object' ? current : {}),
          codex: defaults[tier],
        };
        proposedConfig.models[tier] = config.models[tier];
        changedMapping = true;
      } else if (value !== defaults[tier]) {
        authoredConflict = true;
        proposedConfig.models[tier] = {
          ...(current && typeof current === 'object'
            ? current
            : Object.fromEntries(
                config.platforms
                  .filter((platform) => platform !== 'codex')
                  .map((platform) => [platform, current]),
              )),
          codex: defaults[tier],
        };
      }
    }
  }
  if (changedMapping) {
    save(safePath(root, '.verythinker/config.json'), JSON.stringify(config, null, 2) + '\n');
    report.updated.push('.verythinker/config.json#codex-model-mappings');
  }
  if (authoredConflict) {
    const candidate = '.verythinker/config.json.verythinker-update-routing';
    const body = JSON.stringify(proposedConfig, null, 2) + '\n';
    let target = candidate;
    let suffix = 1;
    while (existsSync(safePath(root, target)) && text(safePath(root, target)) !== body)
      target = `${candidate}.${suffix++}`;
    save(safePath(root, target), body);
    report.conflicts.push({
      path: '.verythinker/config.json#models.codex',
      candidate: target,
      reason:
        'Authored model mappings were preserved. Managed dispatch enforces the installed strategic Luna/max policy; review the legacy mapping candidate.',
    });
    report.warnings.push(
      'Legacy authored model mappings differ from strategic Luna/max managed routing and were preserved for review.',
    );
  }
  if (routingUpdate.migrate) {
    atomicWrite(
      safePath(root, '.verythinker/routing.json'),
      JSON.stringify(defaultRoutingPolicy(), null, 2) + '\n',
    );
    report.updated.push('.verythinker/routing.json#legacy-strong-policy');
  }
  ensureRoutingPolicy(root);
  ensureArchivePolicy(root);
  ensureToolPolicy(root);
  report.installed.push(...newPolicyPaths);
  const pendingMigration = routingUpdate.blocked
    ? { migrated: [], preserved: [], blocked: true }
    : migratePendingRouting(root, report);
  const migrationPath = '.verythinker/migrations/alpha3.json';
  if (!existsSync(safePath(root, migrationPath))) {
    save(
      safePath(root, migrationPath),
      JSON.stringify(
        {
          schema_version: 1,
          installed_version: report.version,
          historical_routing:
            'Historical accepted/superseded records, closed workflow history, and signed receipts retain their original bytes and evidence. Pending work requires strict native routing and strategic reassessment; old model strings are legacy observations.',
          new_work:
            'Installed routing policy requires Luna at max for strategic roles and Luna at medium for routine workers; Terra is permitted only after observed Luna unavailability.',
          authored_overrides: authoredConflict
            ? 'preserved-with-review-candidate'
            : 'preserved-or-unset-defaults-filled',
          pending_work: pendingMigration,
        },
        null,
        2,
      ) + '\n',
    );
    report.installed.push(migrationPath);
  }
  if (options.force)
    report.warnings.push(
      'Force does not overwrite user edits. Review and apply update candidates explicitly.',
    );
  const outputs = [
    ...resourceOutputs(),
    ...adapterOutputs(root, config),
    ...[...strongRoles, ...workerRoles].map((role) => ({
      path: `.verythinker/roles/${role}.capabilities.json`,
      kind: 'file' as const,
      content:
        JSON.stringify(
          {
            schema_version: 1,
            ...roleCapabilities(role),
            native_enforcement:
              'generated declarations require observed client conformance; invocation-bound MCP gateway enforces its operations',
          },
          null,
          2,
        ) + '\n',
    })),
    {
      path: '.verythinker/providers/codegraph.json',
      kind: 'file' as const,
      content: JSON.stringify(codeGraphProvider, null, 2) + '\n',
    },
    {
      path: '.verythinker/.gitignore',
      kind: 'block' as const,
      key: 'local-data',
      content:
        'index.sqlite*\ncache/\nraw/\nsessions/\ntools/\narchives/\noperations/\ncapabilities/\n',
    },
  ];
  for (const output of outputs) installOutput(root, output, manifest, report);
  manifest.version = report.version;
  save(
    safePath(root, '.verythinker/install-manifest.json'),
    JSON.stringify(manifest, null, 2) + '\n',
  );
  return report;
}

export function updateProject(root: string): InstallReport {
  return installProject(root);
}

export function configureCodeGraph(
  root: string,
  reportPath: string,
  executablePath: string,
  args: string[],
): CodeGraphConfiguration {
  root = realpathSync(resolve(root));
  configFor(root);
  const source = readFileSync(resolve(reportPath), 'utf8');
  const report = validateCodeGraphReport(source);
  validateCodeGraphCommand(root, executablePath, args);
  const config: CodeGraphConfiguration = {
    schema_version: 1,
    package: codeGraphProvider.package,
    version: codeGraphProvider.version,
    enabled: true,
    status: 'supported-for-fixture',
    command: realpathSync(executablePath),
    args: [...args],
    report_path: '.verythinker/optional/codegraph-conformance.json',
    report_hash: hash(source),
    platform: process.platform,
    architecture: process.arch,
    limitations: [
      ...report.limitations,
      'Native agent discovery and invocation of this configured command remain unverified.',
    ],
  };
  save(safePath(root, config.report_path), source);
  save(
    safePath(root, '.verythinker/optional/codegraph.json'),
    JSON.stringify(config, null, 2) + '\n',
  );
  return config;
}

function executable(name: string): string | null {
  const extensions =
    process.platform === 'win32' ? (process.env['PATHEXT'] ?? '.EXE;.CMD;.BAT').split(';') : [''];
  for (const directory of (process.env['PATH'] ?? '').split(delimiter)) {
    for (const extension of extensions) {
      const path = join(directory.replace(/^"|"$/g, ''), name + extension.toLowerCase());
      if (existsSync(path) && lstatSync(path).isFile()) return path;
    }
  }
  return null;
}
function observeClient(name: string): { executable: string | null; version: string | null } {
  const path = executable(name);
  if (!path) return { executable: null, version: null };
  // Batch shims require a shell; report availability without launching user shell code.
  if (/\.(cmd|bat)$/i.test(path)) return { executable: path, version: null };
  const result = spawnSync(path, ['--version'], {
    encoding: 'utf8',
    timeout: 5000,
    windowsHide: true,
  });
  return {
    executable: path,
    version: result.status === 0 ? result.stdout.trim().slice(0, 300) : null,
  };
}

export function doctor(root: string): DoctorReport {
  root = realpathSync(resolve(root));
  const config = configFor(root);
  const warnings: string[] = [];
  let codegraph: typeof codeGraphProvider | CodeGraphConfiguration = codeGraphProvider;
  try {
    codegraph = loadCodeGraphConfiguration(root) ?? codeGraphProvider;
  } catch (error) {
    warnings.push(
      `CodeGraph configuration is restricted: ${error instanceof Error ? error.message : String(error)} Review existing native MCP entries before use.`,
    );
  }
  const manifest = manifestFor(root);
  const damaged = Object.values(manifest.files).filter(
    (entry) => !existsSync(safePath(root, entry.path)),
  );
  if (damaged.length)
    warnings.push(
      `${damaged.length} managed files are missing. Run update to generate review candidates.`,
    );
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  const routingPolicy = readRoutingPolicy(root);
  const observations: DoctorReport['routing']['observations'] = [];
  const receiptDirectory = safePath(root, '.verythinker/native/receipts');
  for (const file of existsSync(receiptDirectory) ? readdirSync(receiptDirectory) : []) {
    if (!file.endsWith('.json')) continue;
    try {
      const receipt = readInvocation(root, file.slice(0, -5));
      if (!routingProblems(root, receipt.role, receipt.id, { require_completed: true }).length)
        observations.push({
          id: receipt.id,
          role: receipt.role,
          model: receipt.confirmed_model,
          state: receipt.state,
        });
    } catch {
      /* Invalid receipts remain unusable engineering evidence. */
    }
  }
  const capabilityDirectory = safePath(root, '.verythinker/capabilities');
  const capabilityObservations: unknown[] = [];
  for (const file of existsSync(capabilityDirectory) ? readdirSync(capabilityDirectory) : []) {
    if (!file.endsWith('.json')) continue;
    try {
      capabilityObservations.push(
        JSON.parse(readFileSync(safePath(root, `.verythinker/capabilities/${file}`), 'utf8')),
      );
    } catch {
      warnings.push(`Tool observation cannot be read: ${file}`);
    }
  }
  return {
    schema_version: 1,
    root,
    version: version(),
    runtime: { node: process.version, supported: nodeMajor === 24 || nodeMajor >= 26 },
    automation: readAutomationPolicy(root),
    routing: {
      policy: routingPolicy,
      observations,
      limitations: [
        'Catalog/configuration entries do not establish authenticated inference.',
        'Only completed, currently valid signed native receipts count as routing observations.',
        'Exact model routing on native Claude/Copilot clients remains restricted.',
      ],
    },
    archives: readArchivePolicy(root),
    tools: {
      ...(toolObservations(root) as Record<string, unknown>),
      observations: capabilityObservations,
      observation_scope:
        'Persisted discovery/call observations apply to their recorded provider, role, time, and invocation. They do not establish unrestricted native tool enforcement.',
    },
    platforms: config.platforms.map((platform) => {
      const client = observeClient(platform === 'copilot' ? 'code' : platform);
      let expected: ManagedOutput[] = [];
      let validOptional = true;
      try {
        expected = adapterOutputs(root, { ...config, platforms: [platform] });
      } catch {
        validOptional = false;
      }
      const configured =
        validOptional &&
        expected.every((output) => {
          const source = text(safePath(root, output.path));
          if (source === undefined) return false;
          try {
            if (output.kind === 'json')
              return (
                JSON.stringify(jsonValue(parseJSON(source), output.jsonPath!)) === output.content
              );
            if (output.kind === 'block')
              return blockState(source, output).value === output.content.trimEnd();
            return source === output.content;
          } catch {
            return false;
          }
        });
      return {
        platform,
        client,
        requested_models: config.models,
        capabilities: [
          {
            capability: 'adapter-files',
            status: configured ? 'configured' : 'restricted',
            detail: configured
              ? 'Expected adapter content is present. This is a structural observation.'
              : 'One or more adapter files or managed entries are absent or differ from the generated configuration.',
          },
          {
            capability: 'client-executable',
            status: client.executable ? 'configured' : 'unverified',
            detail: client.executable
              ? 'Executable found on PATH; authentication and client behavior are unverified.'
              : 'Client executable was not found on PATH.',
          },
          {
            capability: 'skill-discovery',
            status: 'unverified',
            detail: 'Confirm discovery in a native client session.',
          },
          {
            capability: 'model-routing',
            status:
              platform === 'codex'
                ? observations.length
                  ? 'supported'
                  : 'unverified'
                : 'restricted',
            detail:
              platform === 'codex'
                ? observations.length
                  ? `${observations.length} completed invocations have currently valid signed model-selection receipts; support is limited to those observed roles/models.`
                  : 'Strategic Luna/max and routine Luna/medium routing is configured; authenticated access and execution require successful native receipt evidence.'
                : 'Portable role/tool declarations are generated; strategic Luna/max and routine Luna/medium execution is verified for Codex first.',
          },
          {
            capability: 'role-tools',
            status: configured ? 'configured' : 'restricted',
            detail: `${roleCapabilities('manager').required.join(', ')} and role-specific operation/provider contracts are configured. The MCP gateway enforces bound roles; native file/tool restrictions remain unverified until observed in the client.`,
          },
          {
            capability: 'mcp',
            status: 'unverified',
            detail:
              'Configuration is generated. Verify tool discovery and invocation in a native client.',
          },
          {
            capability: 'hooks',
            status: 'unverified',
            detail:
              'Advisory hooks are generated. Native trust, settings, and version may restrict execution. CLI verify remains authoritative.',
          },
          {
            capability: 'cloud-client',
            status: 'restricted',
            detail:
              'This adapter targets local project clients. Absolute launch paths require reinstalling on another machine.',
          },
        ],
      };
    }),
    codegraph,
    warnings,
  };
}
