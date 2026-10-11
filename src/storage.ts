import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  openSync,
  closeSync,
  unlinkSync,
  realpathSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { threadId } from 'node:worker_threads';
import { parse, stringify } from 'yaml';
import {
  linkTypes,
  recordTypes,
  statuses,
  type CreateRecord,
  type Metadata,
  type ProjectConfig,
  type ProjectRecord,
} from './types.js';

export const resourceRoot = fileURLToPath(new URL('../resources/', import.meta.url));
export const now = () => new Date().toISOString();
export const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export function safePath(root: string, path: string): string {
  if (isAbsolute(path)) throw new Error('Use a project-relative path.');
  const base = resolve(root);
  const target = resolve(base, path);
  const rel = relative(base, target);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    throw new Error('Path escapes the project.');
  let ancestor = target;
  while (!existsSync(ancestor) && ancestor !== dirname(ancestor)) ancestor = dirname(ancestor);
  if (existsSync(ancestor)) {
    const physical = realpathSync(ancestor);
    const physicalRoot = realpathSync(base);
    const physicalRel = relative(physicalRoot, physical);
    if (physicalRel === '..' || physicalRel.startsWith(`..${sep}`) || isAbsolute(physicalRel))
      throw new Error('Path follows a link outside the project.');
  }
  return target;
}
export function atomicWrite(path: string, value: string | Buffer): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, value, { flag: 'wx' });
    renameSync(temporary, path);
  } finally {
    if (existsSync(temporary)) rmSync(temporary);
  }
}
export function readConfig(root: string): ProjectConfig {
  const config = JSON.parse(
    readFileSync(safePath(root, '.verythinker/config.json'), 'utf8'),
  ) as ProjectConfig;
  validateConfig(config);
  return config;
}
function validateConfig(config: ProjectConfig): void {
  if (
    !config ||
    config.schema_version !== 1 ||
    !/^[A-Z][A-Z0-9-]{0,31}$/.test(config.project_id) ||
    typeof config.name !== 'string' ||
    !config.name.trim() ||
    !['basic', 'software', 'embedded'].includes(config.profile) ||
    !Array.isArray(config.platforms) ||
    !config.platforms.length ||
    config.platforms.some((p) => !['codex', 'claude', 'copilot'].includes(p)) ||
    new Set(config.platforms).size !== config.platforms.length ||
    !Number.isSafeInteger(config.max_workers) ||
    config.max_workers < 1 ||
    config.max_workers > 3 ||
    config.repair_attempts !== 1 ||
    !config.models
  )
    throw new Error('Unsupported or invalid project configuration.');
  for (const tier of ['economy', 'balanced', 'strong'] as const) {
    const model = config.models[tier];
    if (
      model !== null &&
      typeof model !== 'string' &&
      (!model ||
        typeof model !== 'object' ||
        Array.isArray(model) ||
        Object.entries(model).some(
          ([platform, value]) =>
            !['codex', 'claude', 'copilot'].includes(platform) || typeof value !== 'string',
        ))
    )
      throw new Error(`Invalid ${tier} model mapping.`);
  }
}
export function initialize(root: string, options: Partial<ProjectConfig> = {}): ProjectConfig {
  root = resolve(root);
  mkdirSync(root, { recursive: true });
  const configPath = safePath(root, '.verythinker/config.json');
  if (existsSync(configPath)) return readConfig(root);
  const project_id = options.project_id ?? `VT-${randomUUID().slice(0, 8).toUpperCase()}`;
  if (!/^[A-Z][A-Z0-9-]{0,31}$/.test(project_id))
    throw new Error('Project ID must use uppercase letters, digits, and hyphens.');
  const config: ProjectConfig = {
    schema_version: 1,
    project_id,
    name: options.name ?? 'VeryThinker project',
    profile: options.profile ?? 'basic',
    platforms: options.platforms ?? ['codex'],
    models: options.models ?? { economy: null, balanced: null, strong: null },
    max_workers: options.max_workers ?? 3,
    repair_attempts: 1,
  };
  validateConfig(config);
  atomicWrite(configPath, JSON.stringify(config, null, 2) + '\n');
  atomicWrite(
    safePath(root, '.verythinker/.gitignore'),
    'cache/\nruns/\ncontributions/\n*.lock\n*.tmp\n',
  );
  mkdirSync(safePath(root, '.verythinker/records'), { recursive: true });
  return config;
}
export function withLock<T>(root: string, action: () => T): T {
  const path = safePath(root, '.verythinker/write.lock');
  mkdirSync(dirname(path), { recursive: true });
  let fd: number;
  try {
    fd = openSync(path, 'wx');
  } catch {
    if (!recoverLock(root))
      throw new Error(
        'Project is locked by another writer. Retry after it finishes. A malformed lock requires inspection before manual recovery.',
      );
    fd = openSync(path, 'wx');
  }
  try {
    writeFileSync(fd, JSON.stringify({ pid: process.pid, started_at: now() }));
    return action();
  } finally {
    closeSync(fd);
    unlinkSync(path);
  }
}
/** Recover only a lock whose recorded process can be proved absent. */
export function recoverLock(root: string): boolean {
  const path = safePath(root, '.verythinker/write.lock');
  if (!existsSync(path)) return false;
  let pid: number;
  try {
    pid = JSON.parse(readFileSync(path, 'utf8')).pid;
  } catch {
    return false;
  }
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return false;
    unlinkSync(path);
    return true;
  }
}
/** Serialize a synchronous workflow operation without holding the project record-write lock. */
export function withOperationLock<T>(
  root: string,
  key: string,
  action: () => T,
  waitMs = 60000,
): T {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(key))
    throw new Error('Operation lock key must be a portable identifier.');
  if (!Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > 60000)
    throw new Error('Operation lock wait must be between 0 and 60000 milliseconds.');
  const path = safePath(root, `.verythinker/operations/${key}.lock`);
  mkdirSync(dirname(path), { recursive: true });
  const lease = { pid: process.pid, thread_id: threadId, token: randomUUID(), started_at: now() };
  const pause = new Int32Array(new SharedArrayBuffer(4));
  const deadline = Date.now() + waitMs;
  let fd: number;
  while (true) {
    try {
      fd = openSync(path, 'wx');
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let owner: { pid?: number; thread_id?: number } | null = null;
      try {
        owner = JSON.parse(readFileSync(path, 'utf8'));
      } catch (readError) {
        if ((readError as NodeJS.ErrnoException).code === 'ENOENT') continue;
      }
      if (owner?.pid === process.pid && owner.thread_id === threadId)
        throw new Error(`Operation ${key} is already running in this invocation.`);
      if (owner?.pid && Number.isSafeInteger(owner.pid) && owner.pid > 0) {
        let absent = false;
        try {
          process.kill(owner.pid, 0);
        } catch (probeError) {
          absent = (probeError as NodeJS.ErrnoException).code === 'ESRCH';
        }
        if (absent) {
          // Serialize stale recovery with other recoverers. A live claimant cannot
          // create this path until the old lock is removed, and recovery rechecks it.
          try {
            const recovered = withLock(root, () => {
              if (!existsSync(path)) return true;
              let stale: { pid?: number };
              try {
                stale = JSON.parse(readFileSync(path, 'utf8'));
              } catch {
                return false;
              }
              if (!stale.pid || !Number.isSafeInteger(stale.pid) || stale.pid < 1) return false;
              try {
                process.kill(stale.pid, 0);
                return false;
              } catch (probeError) {
                if ((probeError as NodeJS.ErrnoException).code !== 'ESRCH') return false;
                unlinkSync(path);
                return true;
              }
            });
            if (recovered) continue;
          } catch (recoveryError) {
            if (!String(recoveryError).includes('Project is locked')) throw recoveryError;
          }
        }
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0)
        throw new Error(
          `Operation ${key} remains locked. Retry after its owner finishes; malformed or inaccessible-owner locks require inspection.`,
        );
      Atomics.wait(pause, 0, 0, Math.min(50, remaining));
    }
  }
  try {
    writeFileSync(fd, JSON.stringify(lease));
    return action();
  } finally {
    closeSync(fd);
    unlinkSync(path);
  }
}
export function filesUnder(root: string, directory: string): string[] {
  const target = safePath(root, directory);
  if (!existsSync(target)) return [];
  return readdirSync(target, { withFileTypes: true })
    .flatMap((entry) => {
      if (entry.isSymbolicLink())
        throw new Error(
          `Symbolic links are not supported in managed data: ${directory}/${entry.name}`,
        );
      const path = join(directory, entry.name);
      return entry.isDirectory() ? filesUnder(root, path) : [path];
    })
    .sort();
}
export function validateMetadata(value: unknown): Metadata {
  const m = value as Metadata;
  if (
    !m ||
    typeof m !== 'object' ||
    m.schema_version !== 1 ||
    !/^[A-Z][A-Z0-9-]+$/.test(m.id) ||
    !recordTypes.includes(m.type) ||
    !statuses.includes(m.status) ||
    !Number.isSafeInteger(m.revision) ||
    m.revision < 1 ||
    typeof m.title !== 'string' ||
    !m.title.trim() ||
    typeof m.owner !== 'string' ||
    !m.owner.trim() ||
    !Array.isArray(m.links) ||
    !m.data ||
    typeof m.data !== 'object' ||
    Array.isArray(m.data) ||
    typeof m.created_at !== 'string' ||
    !Number.isFinite(Date.parse(m.created_at)) ||
    typeof m.updated_at !== 'string' ||
    !Number.isFinite(Date.parse(m.updated_at))
  )
    throw new Error('Invalid record metadata.');
  for (const field of [
    'acceptance_criteria',
    'requirements',
    'dependencies',
    'allowed_paths',
    'baseline_paths',
    'command',
    'findings',
  ])
    if (
      m.data[field] !== undefined &&
      (!Array.isArray(m.data[field]) ||
        (m.data[field] as unknown[]).some((v) => typeof v !== 'string'))
    )
      throw new Error(`Invalid ${field} in ${m.id}; expected a string array.`);
  for (const link of m.links)
    if (
      !link ||
      !linkTypes.includes(link.type) ||
      typeof link.target !== 'string' ||
      !/^[A-Z][A-Z0-9-]+$/.test(link.target)
    )
      throw new Error(`Invalid link in ${m.id}.`);
  if (new Set(m.links.map((l) => `${l.type}:${l.target}`)).size !== m.links.length)
    throw new Error(`Duplicate links in ${m.id}.`);
  return m;
}
export function loadRecords(root: string): ProjectRecord[] {
  readConfig(root);
  const seen = new Set<string>();
  return filesUnder(root, '.verythinker/records')
    .filter((p) => p.endsWith('.md'))
    .map((path) => {
      const source = readFileSync(safePath(root, path), 'utf8').replace(/\r\n/g, '\n');
      const match = /^---\n([\s\S]*?)\n---(?:\n|$)([\s\S]*)$/.exec(source);
      if (!match) throw new Error(`Missing YAML frontmatter: ${path}`);
      const meta = validateMetadata(parse(match[1]!));
      if (seen.has(meta.id)) throw new Error(`Duplicate record ID: ${meta.id}`);
      seen.add(meta.id);
      return { meta, body: match[2]!, path: path.replaceAll('\\', '/') };
    });
}
export function getRecord(root: string, id: string): ProjectRecord {
  const record = loadRecords(root).find((r) => r.meta.id === id);
  if (!record) throw new Error(`Record not found: ${id}`);
  return record;
}
function serialize(record: ProjectRecord): string {
  return `---\n${stringify(record.meta).trimEnd()}\n---\n${record.body.trim()}\n`;
}
const prefixes: Record<string, string> = {
  requirement: 'REQ',
  design: 'DES',
  task: 'TASK',
  check: 'CHK',
  evidence: 'EVD',
  review: 'REV',
  change: 'CHG',
  problem: 'PRB',
  knowledge: 'KNW',
};
export function createRecord(root: string, input: CreateRecord): ProjectRecord {
  return withLock(root, () => {
    const config = readConfig(root);
    const records = loadRecords(root);
    const prefix = `${config.project_id}-${prefixes[input.type]}-`;
    const sequencePath = safePath(root, '.verythinker/id-sequence.json');
    const sequence: Record<string, number> = existsSync(sequencePath)
      ? JSON.parse(readFileSync(sequencePath, 'utf8'))
      : {};
    const number =
      Math.max(
        sequence[input.type] ?? 0,
        ...records
          .filter((r) => r.meta.id.startsWith(prefix))
          .map((r) => Number(r.meta.id.slice(prefix.length)) || 0),
      ) + 1;
    const date = now();
    const template = join(
      resourceRoot,
      'templates',
      `${input.data?.kind === 'work-record' ? 'work-record' : input.type}.md`,
    );
    const record: ProjectRecord = {
      meta: {
        schema_version: 1,
        id: `${prefix}${String(number).padStart(4, '0')}`,
        type: input.type,
        title: input.title,
        owner: input.owner ?? 'manager',
        status: input.status ?? 'draft',
        revision: 1,
        created_at: date,
        updated_at: date,
        links: input.links ?? [],
        data: input.data ?? {},
      },
      body:
        input.body ??
        (existsSync(template) ? readFileSync(template, 'utf8') : `# ${input.title}\n`),
      path: '',
    };
    validateMetadata(record.meta);
    sequence[input.type] = number;
    atomicWrite(sequencePath, JSON.stringify(sequence, null, 2) + '\n');
    record.path = `.verythinker/records/${record.meta.id}.md`;
    atomicWrite(safePath(root, record.path), serialize(record));
    return record;
  });
}
export function updateRecord(
  root: string,
  id: string,
  patch: Partial<Pick<Metadata, 'title' | 'owner' | 'status' | 'links' | 'data'>>,
  body?: string,
  precondition?: (record: ProjectRecord) => void,
): ProjectRecord {
  return withLock(root, () => {
    const record = getRecord(root, id);
    precondition?.(record);
    if (patch.status === 'accepted' && record.meta.status !== 'accepted')
      throw new Error(
        'Use task accept or record approve to record a validated acceptance decision.',
      );
    record.meta = {
      ...record.meta,
      ...patch,
      data: patch.data ? { ...record.meta.data, ...patch.data } : record.meta.data,
      revision: record.meta.revision + 1,
      updated_at: now(),
    };
    if (body !== undefined) record.body = body;
    validateMetadata(record.meta);
    atomicWrite(safePath(root, record.path), serialize(record));
    return record;
  });
}
export function saveStatus(
  root: string,
  id: string,
  status: Metadata['status'],
  precondition?: () => void,
): ProjectRecord {
  return withLock(root, () => {
    precondition?.();
    const record = getRecord(root, id);
    record.meta = { ...record.meta, status, revision: record.meta.revision + 1, updated_at: now() };
    atomicWrite(safePath(root, record.path), serialize(record));
    return record;
  });
}
export function appendEvent(root: string, run: string, event: Record<string, unknown>): string {
  if (!/^[a-zA-Z0-9-]+$/.test(run)) throw new Error('Invalid run ID.');
  const path = safePath(root, `.verythinker/runs/${run}/events.jsonl`);
  mkdirSync(dirname(path), { recursive: true });
  const fd = openSync(path, 'a');
  try {
    writeFileSync(fd, JSON.stringify({ event_id: randomUUID(), at: now(), ...event }) + '\n');
  } finally {
    closeSync(fd);
  }
  return relative(root, path).replaceAll('\\', '/');
}
export function sourceHash(root: string): string {
  return hash(
    filesUnder(root, '.verythinker/records')
      .filter((p) => p.endsWith('.md'))
      .map((p) => `${p}:${hash(readFileSync(safePath(root, p)))}`)
      .join('\n'),
  );
}
export function snapshotPaths(root: string, paths: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const path of paths) {
    const target = safePath(root, path);
    if (!existsSync(target)) throw new Error(`Baseline input does not exist: ${path}`);
    const files = statSync(target).isDirectory() ? filesUnder(root, path) : [path];
    for (const file of files)
      result[file.replaceAll('\\', '/')] = hash(readFileSync(safePath(root, file)));
  }
  return result;
}
