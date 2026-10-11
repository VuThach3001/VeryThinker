import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  atomicWrite,
  getRecord,
  hash,
  now,
  readConfig,
  safePath,
  withLock,
  withOperationLock,
} from './storage.js';
import { readInvocation, assertRouting, roleModelPolicy } from './routing.js';

export const toolCatalog = [
  {
    id: 'codegraph',
    package: '@colbymchenry/codegraph',
    version: '1.6.2',
    integrity:
      'sha512-hODH/mGnCf3IUMs6rzktv/zbecJIKJfdZAYHZ9mqecb0G7ZkHaA8CZafDVnswANFEL1YFcG+lfAwc5SIXzUH6Q==',
    tools: ['codegraph_explore'],
    capability: 'code-analysis',
  },
  {
    id: 'context7',
    package: '@upstash/context7-mcp',
    version: '4.3.0',
    integrity:
      'sha512-fuDt5nWjE5JkAPLjU0m+m0LlJphxyegAvAmcwHoA5jrzAhKo/rVV0RFA8TOwODGdDVdt/nPxNslkxeDIDp/rPA==',
    tools: ['resolve-library-id', 'query-docs'],
    capability: 'library-documentation',
  },
  {
    id: 'playwright',
    package: '@playwright/mcp',
    version: '0.0.83',
    integrity:
      'sha512-oNcl+Ae2/IAjhfPeP46BfIkSakfmprY+aOtkv5MjrQ4lPav4/yNtPhL0iq8SlIM90oApWgBDUxaNKvktazUKOg==',
    tools: [
      'browser_navigate',
      'browser_snapshot',
      'browser_click',
      'browser_type',
      'browser_select_option',
      'browser_press_key',
      'browser_wait_for',
      'browser_take_screenshot',
      'browser_close',
    ],
    capability: 'browser-exploration',
  },
] as const;
export type ProviderId = (typeof toolCatalog)[number]['id'];
export interface ToolPolicy {
  schema_version: 1;
  automatic_install: boolean;
  approved_providers: ProviderId[];
}
export interface RoleCapabilities {
  role: string;
  operations: string[];
  providers: ProviderId[];
  required: string[];
  optional: string[];
  native_tools: string[];
}
const common = [
  'project_status',
  'project_read',
  'assignment_report',
  'record_list',
  'record_get',
  'record_trace',
  'verify',
  'task_context',
  'memory_search',
  'manager_status',
  'native_status',
  'native_wait',
  'capability_describe',
  'recipe_list',
  'recipe_resolve',
  'note_validate',
  'pack_list',
  'pack_suggest',
];
const writeRecords = [
  'record_create',
  'record_update',
  'note_create',
  'note_validate',
  'recipe_list',
  'recipe_prepare',
];
const submit = ['task_start', 'task_resume', 'task_submit', 'task_repair', 'evidence_archive'];
const roles: Record<string, Omit<RoleCapabilities, 'role'>> = {
  manager: {
    operations: [
      ...common,
      ...writeRecords,
      ...submit,
      'manager_begin',
      'manager_discuss',
      'manager_decide',
      'manager_finish',
      'native_dispatch',
      'native_interrupt',
      'native_resume',
      'task_accept',
      'archive_prepare',
      'archive_publish',
      'archive_status',
      'archive_reassess',
      'capability_resolve',
      'capability_invoke',
      'contribution_prepare',
      'contribution_submit',
    ],
    providers: ['codegraph', 'context7'],
    required: ['engineering-core', 'native-coordination'],
    optional: ['code-analysis', 'library-documentation'],
    native_tools: ['read', 'search', 'web', 'coordination'],
  },
  requirements: {
    operations: [
      ...common,
      ...writeRecords,
      'manager_discuss',
      'capability_resolve',
      'capability_invoke',
    ],
    providers: ['codegraph', 'context7'],
    required: ['engineering-core', 'source-retrieval'],
    optional: ['code-analysis', 'library-documentation'],
    native_tools: ['read', 'search', 'web'],
  },
  architect: {
    operations: [
      ...common,
      ...writeRecords,
      'manager_discuss',
      'capability_resolve',
      'capability_invoke',
    ],
    providers: ['codegraph', 'context7'],
    required: ['engineering-core', 'source-retrieval'],
    optional: ['code-analysis', 'library-documentation'],
    native_tools: ['read', 'search', 'web'],
  },
  'component-owner': {
    operations: [
      ...common,
      ...writeRecords,
      'manager_discuss',
      'capability_resolve',
      'capability_invoke',
    ],
    providers: ['codegraph', 'context7'],
    required: ['engineering-core'],
    optional: ['code-analysis', 'library-documentation'],
    native_tools: ['read', 'search', 'web'],
  },
  verifier: {
    operations: [
      ...common,
      ...writeRecords,
      'manager_discuss',
      'capability_resolve',
      'capability_invoke',
      'recipe_revise',
    ],
    providers: ['codegraph', 'context7', 'playwright'],
    required: ['engineering-core'],
    optional: ['code-analysis', 'library-documentation', 'browser-exploration'],
    native_tools: ['read', 'search', 'web'],
  },
  reviewer: {
    operations: [
      ...common,
      'task_review',
      'record_review',
      'note_validate',
      'recipe_list',
      'manager_discuss',
      'capability_resolve',
      'capability_invoke',
    ],
    providers: ['codegraph', 'context7'],
    required: ['engineering-core'],
    optional: ['code-analysis', 'library-documentation'],
    native_tools: ['read', 'search', 'web'],
  },
  researcher: {
    operations: [
      ...common,
      ...writeRecords,
      ...submit,
      'manager_discuss',
      'capability_resolve',
      'capability_invoke',
    ],
    providers: ['codegraph', 'context7'],
    required: ['source-retrieval'],
    optional: ['code-analysis', 'library-documentation'],
    native_tools: ['read', 'search', 'web', 'edit-assigned-documents'],
  },
  'codebase-analyst': {
    operations: [
      ...common,
      ...writeRecords,
      ...submit,
      'manager_discuss',
      'capability_resolve',
      'capability_invoke',
    ],
    providers: ['codegraph', 'context7'],
    required: ['source-retrieval'],
    optional: ['code-analysis', 'library-documentation'],
    native_tools: ['read', 'search', 'web', 'edit-assigned-documents'],
  },
  curator: {
    operations: [
      ...common,
      ...writeRecords,
      ...submit,
      'contribution_prepare',
      'manager_discuss',
      'capability_resolve',
      'capability_invoke',
    ],
    providers: ['context7'],
    required: ['engineering-core'],
    optional: ['library-documentation'],
    native_tools: ['read', 'search', 'web', 'edit-assigned-documents'],
  },
  developer: {
    operations: [
      ...common,
      ...submit,
      'note_create',
      'note_validate',
      'recipe_list',
      'recipe_run',
      'task_file_write',
      'capability_resolve',
      'capability_invoke',
    ],
    providers: ['codegraph', 'context7', 'playwright'],
    required: ['engineering-core', 'assigned-editing'],
    optional: ['code-analysis', 'library-documentation', 'browser-exploration'],
    native_tools: ['read', 'search', 'edit', 'execute-prescribed'],
  },
  'check-executor': {
    operations: [
      ...common,
      ...submit,
      'check_run',
      'check_inspect',
      'recipe_run',
      'note_create',
      'note_validate',
      'capability_resolve',
      'capability_invoke',
    ],
    providers: ['playwright'],
    required: ['engineering-core', 'prescribed-execution'],
    optional: ['browser-exploration'],
    native_tools: ['read', 'search', 'execute-prescribed'],
  },
  release: {
    operations: [
      ...common,
      ...submit,
      'archive_prepare',
      'archive_publish',
      'archive_status',
      'contribution_prepare',
      'contribution_submit',
      'recipe_run',
    ],
    providers: [],
    required: ['engineering-core', 'git-publication'],
    optional: [],
    native_tools: ['read', 'search', 'execute-prescribed'],
  },
};
export function roleCapabilities(role: string): RoleCapabilities {
  const contract = roles[role];
  if (!contract) throw new Error(`Unknown engineering role: ${role}`);
  return {
    role,
    ...contract,
    operations: [
      ...new Set([
        ...contract.operations,
        ...(['manager', 'release'].includes(role) ? ['archive_restore'] : []),
      ]),
    ],
  };
}
export function readToolPolicy(root: string): ToolPolicy | null {
  const path = safePath(root, '.verythinker/tools.json');
  if (!existsSync(path)) return null;
  const policy = JSON.parse(readFileSync(path, 'utf8'));
  if (
    policy.schema_version !== 1 ||
    typeof policy.automatic_install !== 'boolean' ||
    !Array.isArray(policy.approved_providers) ||
    policy.approved_providers.some((id: string) => !toolCatalog.some((tool) => tool.id === id))
  )
    throw new Error('Invalid approved tool policy.');
  return policy;
}
export function ensureToolPolicy(root: string): ToolPolicy {
  readConfig(root);
  return withLock(root, () => {
    const existing = readToolPolicy(root);
    if (existing) return existing;
    const policy: ToolPolicy = {
      schema_version: 1,
      automatic_install: true,
      approved_providers: toolCatalog.map((tool) => tool.id),
    };
    atomicWrite(safePath(root, '.verythinker/tools.json'), JSON.stringify(policy, null, 2) + '\n');
    return policy;
  });
}
export function authorizeOperation(
  root: string,
  invocationId: string,
  operation: string,
  input: { workflow_id?: string; task_id?: string } = {},
): RoleCapabilities {
  const receipt = readInvocation(root, invocationId);
  assertRouting(root, receipt.role, invocationId, {
    workflow_id: input.workflow_id ?? receipt.workflow_id ?? undefined,
    task_id: input.task_id ?? receipt.task_id ?? undefined,
    require_completed: false,
  });
  const contract = roleCapabilities(receipt.role);
  if (!contract.operations.includes(operation))
    throw new Error(`Role ${receipt.role} cannot use ${operation}.`);
  if (receipt.task_id && input.task_id && receipt.task_id !== input.task_id)
    throw new Error('Operation escapes the assigned task.');
  if (receipt.workflow_id && input.workflow_id && receipt.workflow_id !== input.workflow_id)
    throw new Error('Operation escapes the assigned workflow.');
  return contract;
}
function npmScript(): string {
  const options = [
    process.env.npm_execpath,
    join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
  ];
  const script = options.find((path) => path && existsSync(path));
  if (!script)
    throw new Error('npm CLI script is unavailable for isolated approved-tool installation.');
  return script;
}
function installProvider(root: string, id: ProviderId): string {
  const provider = toolCatalog.find((tool) => tool.id === id)!;
  const policy = readToolPolicy(root);
  if (!policy || !policy.approved_providers.includes(id))
    throw new Error(`Provider is outside the approved catalog: ${id}`);
  const base = safePath(root, `.verythinker/tools/${id}/${provider.version}`);
  const dependencyLockPath = `.verythinker/tool-locks/${id}-${provider.version}.json`;
  const dependencyLock = safePath(root, dependencyLockPath);
  const metadata = join(base, 'node_modules', provider.package, 'package.json');
  return withOperationLock(root, `provider-${id}`, () => {
    if (!existsSync(metadata)) {
      if (!policy.automatic_install)
        throw new Error(`Provider ${id} is missing and automatic installation is disabled.`);
      mkdirSync(base, { recursive: true });
      const recovering = existsSync(dependencyLock);
      if (recovering) {
        const saved = JSON.parse(readFileSync(dependencyLock, 'utf8'));
        atomicWrite(
          join(base, 'package.json'),
          JSON.stringify(
            { private: true, dependencies: saved.packages?.['']?.dependencies },
            null,
            2,
          ) + '\n',
        );
        atomicWrite(join(base, 'package-lock.json'), readFileSync(dependencyLock));
      }
      const result = spawnSync(
        process.execPath,
        [
          npmScript(),
          recovering ? 'ci' : 'install',
          '--prefix',
          base,
          '--ignore-scripts',
          '--no-audit',
          '--no-fund',
          ...(recovering ? [] : [`${provider.package}@${provider.version}`]),
        ],
        { windowsHide: true, encoding: 'utf8', timeout: 120000, maxBuffer: 2 * 1024 * 1024 },
      );
      if (result.error || result.status !== 0)
        throw new Error(
          `Approved provider installation failed: ${result.error?.message ?? result.stderr.trim()}`,
        );
    }
    const manifest = JSON.parse(readFileSync(metadata, 'utf8'));
    const packageLock = JSON.parse(readFileSync(join(base, 'package-lock.json'), 'utf8'));
    const installed = packageLock.packages?.[`node_modules/${provider.package}`];
    if (manifest.version !== provider.version || installed?.integrity !== provider.integrity)
      throw new Error(`Pinned provider version or integrity mismatch: ${id}`);
    const dependencyBytes = readFileSync(join(base, 'package-lock.json'));
    const dependencyHash = hash(dependencyBytes);
    if (existsSync(dependencyLock) && hash(readFileSync(dependencyLock)) !== dependencyHash)
      throw new Error(
        `Provider dependency lock changed: ${id}. Review before selecting a new baseline.`,
      );
    if (!existsSync(dependencyLock)) atomicWrite(dependencyLock, dependencyBytes);
    const lockPath = safePath(root, '.verythinker/tool-lock.json');
    withLock(root, () => {
      const lock = existsSync(lockPath)
        ? JSON.parse(readFileSync(lockPath, 'utf8'))
        : { schema_version: 1, providers: [] };
      const previous = lock.providers.find((tool: { id: string }) => tool.id === id);
      if (
        previous?.version === provider.version &&
        previous?.integrity === provider.integrity &&
        previous?.package === provider.package &&
        previous?.dependency_lock_hash === dependencyHash
      )
        return;
      lock.providers = [
        ...lock.providers.filter((tool: { id: string }) => tool.id !== id),
        {
          id,
          package: provider.package,
          version: provider.version,
          integrity: provider.integrity,
          dependency_lock_path: dependencyLockPath,
          dependency_lock_hash: dependencyHash,
          installed_at: previous?.installed_at ?? now(),
        },
      ];
      atomicWrite(lockPath, JSON.stringify(lock, null, 2) + '\n');
    });
    return base;
  });
}
function providerLaunch(
  root: string,
  id: ProviderId,
  base: string,
): { command: string; args: string[] } {
  if (id === 'codegraph') {
    const platformRoot = join(
      base,
      'node_modules/@colbymchenry',
      `codegraph-${process.platform}-${process.arch}`,
    );
    if (process.platform === 'win32')
      return {
        command: join(platformRoot, 'node.exe'),
        args: [
          '--liftoff-only',
          '--disable-warning=ExperimentalWarning',
          join(platformRoot, 'lib/dist/bin/codegraph.js'),
        ],
      };
    return { command: join(platformRoot, 'bin/codegraph'), args: [] };
  }
  const provider = toolCatalog.find((tool) => tool.id === id)!;
  const packageRoot = join(base, 'node_modules', provider.package);
  const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
  const binary =
    typeof manifest.bin === 'string' ? manifest.bin : Object.values(manifest.bin ?? {})[0];
  if (typeof binary !== 'string')
    throw new Error(`Provider ${id} exposes no supported executable.`);
  const relativePath = binary.replace(/^\.\//, '');
  const path = resolve(packageRoot, relativePath);
  if (
    !path.startsWith(packageRoot + '/'.replace('/', process.platform === 'win32' ? '\\' : '/')) &&
    path !== packageRoot
  )
    throw new Error('Provider executable escapes its package.');
  return { command: process.execPath, args: [path] };
}
const providerEnvironment = () =>
  Object.fromEntries(
    Object.entries({
      ...process.env,
      CODEGRAPH_TELEMETRY: '0',
      DO_NOT_TRACK: '1',
      CODEGRAPH_NO_DOWNLOAD: '1',
      CODEGRAPH_NO_DAEMON: '1',
    }).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
async function connectProvider(
  root: string,
  id: ProviderId,
): Promise<{ client: Client; launch: { command: string; args: string[] } }> {
  const base = installProvider(root, id);
  const launch = providerLaunch(root, id, base);
  if (id === 'codegraph') {
    // Index and sync on each connection. This avoids relying on an unattended watcher.
    for (const args of [
      ['init', root],
      ['sync', root],
    ]) {
      const result = spawnSync(launch.command, [...launch.args, ...args], {
        cwd: root,
        env: providerEnvironment(),
        windowsHide: true,
        encoding: 'utf8',
        timeout: 120000,
      });
      if (result.error || result.status !== 0)
        throw new Error(
          `CodeGraph project freshness check failed: ${result.error?.message ?? result.stderr ?? result.stdout}`,
        );
    }
  }
  const args =
    id === 'codegraph'
      ? [...launch.args, 'serve', '--mcp', '--path', root]
      : id === 'playwright'
        ? [...launch.args, '--headless', '--isolated']
        : launch.args;
  const client = new Client({ name: 'verythinker-capability-gateway', version: '0.1.0-alpha.3' });
  try {
    await client.connect(
      new StdioClientTransport({
        ...launch,
        args,
        cwd: root,
        env: providerEnvironment(),
        stderr: 'pipe',
      }),
    );
    return { client, launch: { ...launch, args } };
  } catch (error) {
    await client.close().catch(() => {});
    throw error;
  }
}
export function describeCapabilities(root: string, role: string): unknown {
  const contract = roleCapabilities(role);
  return {
    ...contract,
    model_policy: roleModelPolicy(root, role),
    policy: readToolPolicy(root),
    providers: toolCatalog.filter((tool) => contract.providers.includes(tool.id)),
    enforcement: {
      gateway: 'role-and-task-bound core validation',
      native:
        'Configured native restrictions require observed client conformance; inherited tools may remain available.',
    },
  };
}
export async function resolveCapabilities(
  root: string,
  input: { role: string; providers?: ProviderId[]; required?: ProviderId[] },
): Promise<unknown> {
  const contract = roleCapabilities(input.role);
  const requested = [...new Set([...(input.providers ?? []), ...(input.required ?? [])])];
  if (requested.some((id) => !contract.providers.includes(id)))
    throw new Error('Provider is outside the role capability contract.');
  const observations = [];
  const blockers: string[] = [];
  for (const id of requested) {
    let client: Client | undefined;
    try {
      const connection = await connectProvider(root, id);
      client = connection.client;
      const tools = (await client.listTools()).tools.map((tool) => tool.name);
      const expected = toolCatalog.find((tool) => tool.id === id)!.tools;
      if (!expected.every((name) => tools.includes(name)))
        throw new Error(`Required provider tool names are missing: ${id}`);
      if (id === 'context7') {
        const probe = await client.callTool(
          {
            name: 'resolve-library-id',
            arguments: { libraryName: 'nodejs', query: 'Find official Node.js API documentation.' },
          },
          undefined,
          { timeout: 30000 },
        );
        if (probe.isError)
          throw new Error(
            `Context7 documentation access check failed: ${JSON.stringify(probe.content).slice(0, 2000)}`,
          );
      }
      observations.push({
        id,
        status: 'connected',
        tools: expected,
        observed_at: now(),
        scope: 'MCP discovery; authenticated execution is assessed by invocation.',
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      observations.push({ id, status: 'unavailable', detail: message, observed_at: now() });
      if (input.required?.includes(id))
        blockers.push(`Required capability ${id} is unavailable: ${message}`);
    } finally {
      await client?.close().catch(() => {});
    }
  }
  atomicWrite(
    safePath(root, `.verythinker/capabilities/${input.role}.json`),
    JSON.stringify({ role: input.role, observations }, null, 2) + '\n',
  );
  if (blockers.length) throw new Error(blockers.join('\n'));
  return { role: input.role, observations };
}
export async function invokeCapability(
  root: string,
  input: {
    invocation_id: string;
    workflow_id?: string;
    task_id?: string;
    provider: ProviderId;
    tool: string;
    arguments?: Record<string, unknown>;
  },
): Promise<unknown> {
  const receipt = readInvocation(root, input.invocation_id);
  const scope = {
    workflow_id: input.workflow_id ?? receipt.workflow_id ?? undefined,
    task_id: input.task_id ?? receipt.task_id ?? undefined,
  };
  const contract = authorizeOperation(root, input.invocation_id, 'capability_invoke', scope);
  const provider = toolCatalog.find((tool) => tool.id === input.provider);
  if (
    !provider ||
    !contract.providers.includes(input.provider) ||
    !(provider.tools as readonly string[]).includes(input.tool)
  )
    throw new Error('Tool is outside the approved role/provider contract.');
  if (scope.task_id) {
    const task = getRecord(root, scope.task_id);
    const required = task.meta.data.required_tools;
    if (Array.isArray(required) && !required.every((item) => typeof item === 'string'))
      throw new Error('Invalid task required_tools.');
  }
  const args = { ...input.arguments };
  if (input.provider === 'playwright' && input.tool === 'browser_navigate' && scope.task_id) {
    const allowed = getRecord(root, scope.task_id).meta.data.allowed_urls;
    if (
      !Array.isArray(allowed) ||
      !allowed.every((url) => typeof url === 'string') ||
      typeof args.url !== 'string' ||
      !allowed.includes(args.url)
    )
      throw new Error(
        'Browser navigation requires an exact URL in the assigned task allowed_urls.',
      );
  }
  if (input.provider === 'codegraph') {
    if (args.projectPath !== undefined && resolve(String(args.projectPath)) !== resolve(root))
      throw new Error('CodeGraph request escapes the assigned project.');
    args.projectPath = root;
  }
  const sessionKey = `${resolve(root)}:${input.invocation_id}:${input.provider}`;
  const persistent = input.provider === 'playwright';
  const connection =
    persistent && capabilitySessions.has(sessionKey)
      ? capabilitySessions.get(sessionKey)!
      : await connectProvider(root, input.provider);
  if (persistent) capabilitySessions.set(sessionKey, connection);
  try {
    const names = (await connection.client.listTools()).tools.map((tool) => tool.name);
    if (!names.includes(input.tool))
      throw new Error('Selected tool was not observed in provider discovery.');
    const result = await connection.client.callTool(
      { name: input.tool, arguments: args },
      undefined,
      { timeout: 60000 },
    );
    atomicWrite(
      safePath(
        root,
        `.verythinker/capabilities/call-${hash(input.invocation_id + now()).slice(0, 24)}.json`,
      ),
      JSON.stringify(
        {
          invocation_id: input.invocation_id,
          ...scope,
          provider: input.provider,
          package: provider.package,
          version: provider.version,
          integrity: provider.integrity,
          tool: input.tool,
          observed_at: now(),
          result: result.isError ? 'failed' : 'returned',
        },
        null,
        2,
      ) + '\n',
    );
    return result;
  } finally {
    if (!persistent) await connection.client.close();
  }
}
const capabilitySessions = new Map<string, Awaited<ReturnType<typeof connectProvider>>>();
export async function closeCapabilitySessions(root?: string, invocationId?: string): Promise<void> {
  for (const [key, connection] of capabilitySessions)
    if (
      (!root || key.startsWith(resolve(root) + ':')) &&
      (!invocationId || key.includes(`:${invocationId}:`))
    ) {
      capabilitySessions.delete(key);
      await connection.client.close().catch(() => {});
    }
}
export function toolObservations(root: string): unknown {
  const policy = readToolPolicy(root);
  const path = safePath(root, '.verythinker/tool-lock.json');
  return {
    policy,
    installed: existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null,
    roles: Object.keys(roles).map((role) => roleCapabilities(role)),
    limitations: [
      'Installed provider packages do not establish authenticated tool execution.',
      'Native tools outside the gateway may inherit broader client permissions.',
      'Exact task URL checks apply to browser_navigate; page actions and redirects inherit provider network permissions.',
    ],
  };
}
export function toolLockProblems(root: string): string[] {
  const path = safePath(root, '.verythinker/tool-lock.json');
  if (!existsSync(path)) return [];
  try {
    const lock = JSON.parse(readFileSync(path, 'utf8'));
    if (lock.schema_version !== 1 || !Array.isArray(lock.providers))
      return ['Tool lock schema is invalid.'];
    return lock.providers.flatMap(
      (installed: {
        id: string;
        version: string;
        integrity: string;
        dependency_lock_path?: string;
        dependency_lock_hash?: string;
      }) => {
        const provider = toolCatalog.find((item) => item.id === installed.id);
        if (
          !provider ||
          installed.version !== provider.version ||
          installed.integrity !== provider.integrity
        )
          return [`Tool baseline is outside the pinned catalog: ${installed.id}`];
        if (
          !installed.dependency_lock_path ||
          !installed.dependency_lock_hash ||
          hash(readFileSync(safePath(root, installed.dependency_lock_path))) !==
            installed.dependency_lock_hash
        )
          return [`Tool dependency baseline changed or is absent: ${installed.id}`];
        return [];
      },
    );
  } catch (error) {
    return [`Tool dependency baseline is unreadable: ${String(error)}`];
  }
}
