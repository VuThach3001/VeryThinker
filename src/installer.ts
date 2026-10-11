import { createHash } from 'node:crypto';
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
  const config = configFor(root);
  const policyExists = existsSync(safePath(root, '.verythinker/automation.json'));
  ensureAutomationPolicy(root);
  if (options.platforms) config.platforms = options.platforms;
  if (options.profile) config.profile = options.profile;
  if (options.name) config.name = options.name;
  if (config.platforms.some((platform) => !platforms.includes(platform)))
    throw new Error('Unsupported platform requested.');
  if (!['basic', 'software', 'embedded'].includes(config.profile))
    throw new Error('Unsupported project profile requested.');
  if (options.platforms || options.profile || options.name)
    save(safePath(root, '.verythinker/config.json'), JSON.stringify(config, null, 2) + '\n');
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
  if (!policyExists) report.installed.push('.verythinker/automation.json');
  if (options.force)
    report.warnings.push(
      'Force does not overwrite user edits. Review and apply update candidates explicitly.',
    );
  const outputs = [
    ...resourceOutputs(),
    ...adapterOutputs(root, config),
    {
      path: '.verythinker/providers/codegraph.json',
      kind: 'file' as const,
      content: JSON.stringify(codeGraphProvider, null, 2) + '\n',
    },
    {
      path: '.verythinker/.gitignore',
      kind: 'block' as const,
      key: 'local-data',
      content: 'index.sqlite*\ncache/\nraw/\nsessions/\n',
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
  return {
    schema_version: 1,
    root,
    version: version(),
    runtime: { node: process.version, supported: nodeMajor === 24 || nodeMajor >= 26 },
    automation: readAutomationPolicy(root),
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
            status: 'unverified',
            detail:
              'Only requested mappings are generated. Actual availability and selected models require native session evidence.',
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
