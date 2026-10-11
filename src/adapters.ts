import { readFileSync, readdirSync, existsSync, lstatSync, realpathSync } from 'node:fs';
import { resolve, join, basename, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { createHash } from 'node:crypto';

export type Platform = 'codex' | 'claude' | 'copilot';
export type ModelTier = 'economy' | 'balanced' | 'strong';
export interface AdapterConfig {
  schema_version: number;
  project_id: string;
  name: string;
  profile: string;
  platforms: Platform[];
  models: Record<ModelTier, string | null | Record<string, string>>;
  max_workers: number;
  repair_attempts: number;
}
export interface ManagedOutput {
  path: string;
  content: string;
  kind: 'file' | 'block' | 'json';
  key?: string;
  jsonPath?: (string | number)[];
  value?: unknown;
}

export const resourcesDirectory = fileURLToPath(new URL('../resources/', import.meta.url));
export const cliPath = fileURLToPath(new URL('./cli.js', import.meta.url));
export const platforms: Platform[] = ['codex', 'claude', 'copilot'];
export const codeGraphProvider = {
  id: 'codegraph',
  package: '@colbymchenry/codegraph',
  version: '1.6.2',
  enabled: false,
  status: 'unverified',
  required_checks: ['windows', 'cpp', 'freshness'],
  note: 'Optional code-context provider. No provider is installed or enabled automatically.',
};

export const codeGraphConformanceChecks = [
  'version',
  'windows',
  'c-symbol',
  'cpp-symbol',
  'cross-file-caller',
  'modify-sync',
  'add-sync',
  'delete-sync',
  'mcp-tool',
  'reconnect-freshness',
  'watch-add',
  'watch-modify',
];
export interface CodeGraphConfiguration {
  schema_version: 1;
  package: string;
  version: string;
  enabled: true;
  status: 'supported-for-fixture';
  command: string;
  args: string[];
  report_path: '.verythinker/optional/codegraph-conformance.json';
  report_hash: string;
  platform: string;
  architecture: string;
  limitations: string[];
}

export function validateCodeGraphReport(source: string): { limitations: string[] } {
  const report = JSON.parse(source) as Record<string, unknown>;
  const environment = report['environment'] as Record<string, unknown> | undefined;
  const checks = report['checks'];
  if (
    report['package'] !== codeGraphProvider.package ||
    report['version'] !== codeGraphProvider.version ||
    report['status'] !== 'supported-for-fixture'
  ) {
    throw new Error(
      'CodeGraph requires a supported-for-fixture report for the pinned package version 1.6.2.',
    );
  }
  if (
    process.platform !== 'win32' ||
    environment?.['platform'] !== process.platform ||
    environment?.['architecture'] !== process.arch
  ) {
    throw new Error(
      'CodeGraph conformance must match the current Windows platform and architecture.',
    );
  }
  if (
    !Array.isArray(checks) ||
    checks.length !== codeGraphConformanceChecks.length ||
    checks.some((check) => !check || typeof check !== 'object') ||
    new Set(checks.map((check) => check.id)).size !== checks.length ||
    codeGraphConformanceChecks.some(
      (id) => !checks.some((check) => check.id === id && check.status === 'passed'),
    )
  ) {
    throw new Error('CodeGraph requires all twelve unique conformance checks to pass.');
  }
  return {
    limitations: Array.isArray(report['limitations'])
      ? report['limitations'].filter((item): item is string => typeof item === 'string')
      : [],
  };
}

export function validateCodeGraphCommand(root: string, command: string, args: string[]): void {
  if (
    typeof command !== 'string' ||
    !isAbsolute(command) ||
    !existsSync(command) ||
    !lstatSync(command).isFile() ||
    /\.(cmd|bat)$/i.test(command)
  ) {
    throw new Error(
      'CodeGraph requires an existing absolute executable file; invoke a Node script with the Node executable and separate arguments.',
    );
  }
  if (
    !Array.isArray(args) ||
    args.some((argument) => typeof argument !== 'string') ||
    !args.includes('serve') ||
    !args.includes('--mcp')
  ) {
    throw new Error('Provide exact CodeGraph server arguments containing serve and --mcp.');
  }
  const pathIndex = args.indexOf('--path');
  if (
    pathIndex < 0 ||
    !args[pathIndex + 1] ||
    !isAbsolute(args[pathIndex + 1]!) ||
    realpathSync(args[pathIndex + 1]!) !== realpathSync(root) ||
    args.filter((argument) => argument === '--path').length !== 1
  ) {
    throw new Error(
      'CodeGraph server arguments must contain one --path followed by the absolute project root.',
    );
  }
}

export function loadCodeGraphConfiguration(root: string): CodeGraphConfiguration | undefined {
  const path = join(root, '.verythinker', 'optional', 'codegraph.json');
  if (!existsSync(path)) return undefined;
  const config = JSON.parse(readFileSync(path, 'utf8')) as CodeGraphConfiguration;
  if (
    config.schema_version !== 1 ||
    config.enabled !== true ||
    config.package !== codeGraphProvider.package ||
    config.version !== codeGraphProvider.version ||
    config.report_path !== '.verythinker/optional/codegraph-conformance.json' ||
    typeof config.report_hash !== 'string' ||
    !/^[0-9a-f]{64}$/.test(config.report_hash) ||
    config.platform !== process.platform ||
    config.architecture !== process.arch ||
    !Array.isArray(config.limitations) ||
    config.limitations.some((item) => typeof item !== 'string')
  ) {
    throw new Error('Invalid optional CodeGraph configuration.');
  }
  const source = readFileSync(join(root, config.report_path), 'utf8');
  if (createHash('sha256').update(source).digest('hex') !== config.report_hash)
    throw new Error('CodeGraph conformance report has changed since approval.');
  validateCodeGraphReport(source);
  validateCodeGraphCommand(root, config.command, config.args);
  return config;
}

function jsonEntry(path: string, jsonPath: (string | number)[], value: unknown): ManagedOutput {
  return {
    path,
    kind: 'json',
    key: jsonPath.join('.'),
    jsonPath,
    value,
    content: JSON.stringify(value),
  };
}

function modelFor(config: AdapterConfig, tier: ModelTier, platform: Platform): string | undefined {
  const mapping = config.models?.[tier];
  const model = mapping && typeof mapping === 'object' ? mapping[platform] : mapping;
  return model && model !== 'auto' && model !== 'inherit' ? model : undefined;
}

function roleFiles(): { id: string; description: string; tier: ModelTier; body: string }[] {
  const directory = join(resourcesDirectory, 'roles');
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((name) => name.endsWith('.md'))
    .sort()
    .map((name) => {
      const source = readFileSync(join(directory, name), 'utf8');
      const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(source);
      const metadata = frontmatter ? (parseYaml(frontmatter[1]!) as Record<string, unknown>) : {};
      const id = basename(name, '.md')
        .replace(/[^a-z0-9-]/gi, '-')
        .toLowerCase();
      const requestedTier = metadata['model_tier'] ?? metadata['tier'];
      const tier = ['economy', 'balanced', 'strong'].includes(String(requestedTier))
        ? (requestedTier as ModelTier)
        : ['manager', 'system-designer', 'independent-reviewer'].includes(id)
          ? 'strong'
          : 'balanced';
      return {
        id,
        description: String(
          metadata['description'] ?? `VeryThinker ${id.replaceAll('-', ' ')} role.`,
        ),
        tier,
        body: frontmatter ? source.slice(frontmatter[0].length) : source,
      };
    });
}

function shellCommands(args: string[]): { command: string; windows: string } {
  const values = [process.execPath, cliPath, ...args];
  return {
    command: values.map((value) => `'${value.replaceAll("'", "'\\''")}'`).join(' '),
    windows: `& ${values.map((value) => `'${value.replaceAll("'", "''")}'`).join(' ')}`,
  };
}

const workflow = `## VeryThinker engineering workflow

For a new requirement, feature, fix, research-to-implementation request, or interrupted engineering workflow received directly from the user, automatically act as the VeryThinker manager and load the verythinker-manager skill plus .verythinker/guides/manager.md. Assigned workers follow their bounded task and specialist role. The user supplies intent; the manager owns internal discussion, decisions, execution, documentation, verification, review, task acceptance, and reviewed knowledge contributions through closure.
Read .verythinker/config.json and .verythinker/automation.json for profile, routing, and contribution policy. Ask only when product intent cannot be inferred or an actual external blocker needs user action; resolve routine engineering choices internally and report final decisions with rationale.
Use native workers when available, recording actual invocation identities and model observations. Resume saved manager workflow state before creating duplicate work. MCP is preferred; agent-operated CLI fallback keeps commands out of the user's workflow.
For a delegated task, obtain its context packet through VeryThinker CLI or MCP, then stay within its allowed scope.
Read .verythinker/guides/workflow.md and your role contract for worker submission and review. Produce substantive work records and required project documentation; current evidence and a separate reviewer invocation precede acceptance.
Hooks provide advisory context. Completion must pass core validation even when hooks fail. Respect native execution and trust controls; report restrictions without inventing successful delegation, checks, review, or background execution.
Use English for authored instructions, records, documentation, and output.
`;

export function adapterOutputs(root: string, config: AdapterConfig): ManagedOutput[] {
  root = resolve(root);
  const outputs: ManagedOutput[] = [];
  const server = {
    type: 'stdio',
    command: process.execPath,
    args: [cliPath, 'mcp', '--project', root],
  };
  const roles = roleFiles();
  const codegraph = loadCodeGraphConfiguration(root);
  if (config.platforms.includes('codex')) {
    outputs.push({ path: 'AGENTS.md', kind: 'block', key: 'instructions', content: workflow });
    outputs.push({
      path: '.codex/config.toml',
      kind: 'block',
      key: 'mcp',
      content: `[mcp_servers.verythinker]\ncommand = ${JSON.stringify(process.execPath)}\nargs = ${JSON.stringify(server.args)}\n`,
    });
    if (codegraph)
      outputs.push({
        path: '.codex/config.toml',
        kind: 'block',
        key: 'codegraph',
        content: `[mcp_servers.codegraph]\ncommand = ${JSON.stringify(codegraph.command)}\nargs = ${JSON.stringify(codegraph.args)}\nenabled = true\nenv = { CODEGRAPH_TELEMETRY = "0", DO_NOT_TRACK = "1", CODEGRAPH_NO_DOWNLOAD = "1" }\n`,
      });
    for (const role of roles) {
      const model = modelFor(config, role.tier, 'codex');
      outputs.push({
        path: `.codex/agents/verythinker-${role.id}.toml`,
        kind: 'file',
        content: `name = ${JSON.stringify(`verythinker-${role.id}`)}\ndescription = ${JSON.stringify(role.description)}\n${model ? `model = ${JSON.stringify(model)}\n` : ''}developer_instructions = ${JSON.stringify(`${workflow}\n${role.body}`)}\n`,
      });
    }
    for (const [event, internal] of [
      ['SessionStart', 'session-start'],
      ['PostToolUse', 'after-tool'],
      ['Stop', 'stop'],
    ]) {
      const command = shellCommands([
        'hook',
        '--event',
        internal!,
        '--platform',
        'codex',
        '--project',
        root,
      ]);
      outputs.push(
        jsonEntry(
          '.codex/hooks.json',
          ['hooks', event!],
          [
            {
              hooks: [
                {
                  type: 'command',
                  command: command.command,
                  commandWindows: command.windows,
                  timeout: 10,
                },
              ],
            },
          ],
        ),
      );
    }
  }
  if (config.platforms.includes('claude')) {
    outputs.push({ path: 'CLAUDE.md', kind: 'block', key: 'instructions', content: workflow });
    for (const role of roles) {
      const model = modelFor(config, role.tier, 'claude');
      outputs.push({
        path: `.claude/agents/verythinker-${role.id}.md`,
        kind: 'file',
        content: `---\nname: verythinker-${role.id}\ndescription: ${JSON.stringify(role.description)}\nmodel: ${JSON.stringify(model ?? 'inherit')}\n---\n\n${workflow}\n${role.body}`,
      });
    }
    for (const [event, internal] of [
      ['SessionStart', 'session-start'],
      ['PostToolUse', 'after-tool'],
      ['Stop', 'stop'],
    ]) {
      outputs.push(
        jsonEntry(
          '.claude/settings.json',
          ['hooks', event!],
          [
            {
              hooks: [
                {
                  type: 'command',
                  command: process.execPath,
                  args: [
                    cliPath,
                    'hook',
                    '--event',
                    internal!,
                    '--platform',
                    'claude',
                    '--project',
                    root,
                  ],
                  timeout: 10,
                },
              ],
            },
          ],
        ),
      );
    }
  }
  if (config.platforms.includes('copilot')) {
    outputs.push({
      path: '.github/copilot-instructions.md',
      kind: 'block',
      key: 'instructions',
      content: workflow,
    });
    for (const role of roles) {
      const model = modelFor(config, role.tier, 'copilot');
      outputs.push({
        path: `.github/agents/verythinker-${role.id}.agent.md`,
        kind: 'file',
        content: `---\nname: verythinker-${role.id}\ndescription: ${JSON.stringify(role.description)}\n${model ? `model: ${JSON.stringify(model)}\n` : ''}---\n\n${workflow}\n${role.body}`,
      });
    }
    outputs.push({
      path: '.github/hooks/verythinker.json',
      kind: 'file',
      content:
        JSON.stringify(
          {
            version: 1,
            hooks: Object.fromEntries(
              [
                ['sessionStart', 'session-start'],
                ['postToolUse', 'after-tool'],
                ['agentStop', 'stop'],
              ].map(([event, internal]) => {
                const command = shellCommands([
                  'hook',
                  '--event',
                  internal!,
                  '--platform',
                  'copilot',
                  '--project',
                  root,
                ]);
                return [
                  event,
                  [
                    {
                      type: 'command',
                      bash: command.command,
                      powershell: command.windows,
                      timeoutSec: 10,
                    },
                  ],
                ];
              }),
            ),
          },
          null,
          2,
        ) + '\n',
    });
  }
  if (config.platforms.some((platform) => platform === 'claude' || platform === 'copilot')) {
    outputs.push(jsonEntry('.mcp.json', ['mcpServers', 'verythinker'], server));
    if (codegraph)
      outputs.push(
        jsonEntry('.mcp.json', ['mcpServers', 'codegraph'], {
          type: 'stdio',
          command: codegraph.command,
          args: codegraph.args,
          env: { CODEGRAPH_TELEMETRY: '0', DO_NOT_TRACK: '1', CODEGRAPH_NO_DOWNLOAD: '1' },
        }),
      );
  }
  const skillDirectory = join(resourcesDirectory, 'skills');
  if (existsSync(skillDirectory)) {
    for (const name of readdirSync(skillDirectory)) {
      if (!existsSync(join(skillDirectory, name, 'SKILL.md'))) continue;
      const content = readFileSync(join(skillDirectory, name, 'SKILL.md'), 'utf8');
      for (const platform of config.platforms) {
        const prefix =
          platform === 'codex' ? '.agents' : platform === 'claude' ? '.claude' : '.github';
        outputs.push({ path: `${prefix}/skills/${name}/SKILL.md`, kind: 'file', content });
      }
    }
  }
  return outputs;
}
