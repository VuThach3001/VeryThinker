import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
  sign,
  verify,
} from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
  openSync,
  closeSync,
} from 'node:fs';
import { dirname, join, resolve, delimiter, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  atomicWrite,
  hash,
  now,
  readConfig,
  safePath,
  withOperationLock,
  getRecord,
  resourceRoot,
  appendEvent,
  loadRecords,
} from './storage.js';
import {
  canonicalJson,
  invocationIsActive,
  nativeReceiptPath,
  ownerIsAlive,
  readInvocation,
  readRoutingPolicy,
  requireRoutingPolicy,
  roleModelPolicy,
  routingConfigurationHashes,
  type NativeReceipt,
  type NativeRole,
} from './routing.js';
import { roleCapabilitiesForReceipt, resolveCapabilities, toolCatalog, type ProviderId } from './tools.js';
import {
  assertFastProducerReady,
  fastGrantProblems,
  issueFastGrant,
  type FastStage,
} from './fast-grants.js';
import { ensureNativeTrustFiles } from './trust.js';
import { executionScope } from './engineering.js';
import type { FastSelection } from './fast-policy.js';

/** Core intake seals the original selection before a model receives authority. */
export function sealFastSelection(root: string, selection: FastSelection): void {
  const path = safePath(root, `.verythinker/native/fast-selections/${hash(selection.workflow_id)}.json`);
  if (existsSync(path)) { assertFastSelectionSeal(root, selection); return; }
  const key = receiptKey(root);
  const unsigned = { schema_version: 1, project_id: readConfig(root).project_id, selection, key_id: key.id };
  const signature = sign(null, Buffer.from(canonicalJson(unsigned)), createPrivateKey(key.privateKey)).toString('base64');
  atomicWrite(path, JSON.stringify({ ...unsigned, signature }, null, 2) + '\n');
}
export function assertFastSelectionSeal(root: string, selection: FastSelection): void {
  const path = safePath(root, `.verythinker/native/fast-selections/${hash(selection.workflow_id)}.json`);
  const proof = JSON.parse(readFileSync(path, 'utf8'));
  const { signature, ...unsigned } = proof;
  if (proof.schema_version !== 1 || proof.project_id !== readConfig(root).project_id || canonicalJson(proof.selection) !== canonicalJson(selection) || !/^[a-f0-9]{64}$/.test(proof.key_id))
    throw new Error('The Fast selection differs from its signed intake snapshot.');
  const trust = JSON.parse(readFileSync(safePath(root, '.verythinker/native/trust.json'), 'utf8'));
  const publicBytes = readFileSync(safePath(root, `.verythinker/native/keys/${proof.key_id}.pem`), 'utf8');
  if (!trust.keys?.includes(proof.key_id) || hash(publicBytes) !== proof.key_id || !verify(null, Buffer.from(canonicalJson(unsigned)), createPublicKey(publicBytes), Buffer.from(signature, 'base64')))
    throw new Error('The Fast selection snapshot cannot be authenticated.');
}

const runtimeVersion = '0.162.1';
const runtimeIntegrity =
  'sha512-NWZdi/kxyjv/8EUGFupziGU38YyleugZRM4JXgY5XFH7FUmaFA33NZS2Bmq0HPazf7S3jJQQWsZ/jAK9jsrV3Q==';
const active = new Map<string, NativeSession>();
const installations = new Map<string, Promise<RuntimeInfo>>();
const terminalStates = ['completed', 'failed', 'interrupted', 'blocked', 'orphaned'];
export interface RuntimeInfo {
  version: string;
  command: string;
  args: string[];
  integrity: string;
  protocol_sha256: string;
  executable_sha256: string;
  test_fixture?: boolean;
}
export interface NativeStartInput {
  role: NativeRole;
  prompt: string;
  workflow_id?: string;
  task_id?: string;
  request_id?: string;
}
export interface NativeResumeInput {
  prompt?: string;
  request_id?: string;
}
export interface OrphanReconcileResult {
  reconciled: string[];
  quarantined: { invocation_id: string; reason: string }[];
}
interface NativeOptions {
  runtime?: (root: string) => Promise<RuntimeInfo>;
  rpc_timeout_ms?: number;
  owner_token?: string;
  provisioning_hook?: (stage: 'pending' | 'public' | 'trust' | 'private') => void;
  /** Internal controller-only stage selection; never accepted from native_dispatch input. */
  fast_stage?: FastStage;
}
interface RpcMessage {
  id?: number | string;
  method?: string;
  params?: any;
  result?: any;
  error?: { message?: string; code?: number; data?: unknown };
}

function cleanError(error: unknown): string {
  return String(error)
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [redacted]')
    .replace(/\b(?:sk-|sess-)[A-Za-z0-9_-]{8,}/g, '[redacted credential]')
    .slice(0, 3000);
}
interface InitialKeyIntent {
  schema_version: 1;
  purpose: 'verythinker-native-initial-key';
  project_id: string;
  key_id: string;
  public_key: string;
  signature: string;
}
interface PendingInitialKey {
  schema_version: 1;
  project_id: string;
  key_id: string;
  private_key: string;
  public_key: string;
  intent: InitialKeyIntent;
}
function initialTrustBytes(id: string): string {
  return JSON.stringify({ schema_version: 1, keys: [id] }, null, 2) + '\n';
}
function validatePendingInitialKey(root: string, path: string): PendingInitialKey {
  let pending: PendingInitialKey;
  try {
    pending = JSON.parse(readFileSync(path, 'utf8')) as PendingInitialKey;
    const privateKey = createPrivateKey(pending.private_key);
    const derivedPublic = createPublicKey(privateKey)
      .export({ type: 'spki', format: 'pem' })
      .toString();
    const { signature, ...unsigned } = pending.intent;
    if (
      pending.schema_version !== 1 ||
      pending.project_id !== readConfig(root).project_id ||
      pending.intent?.schema_version !== 1 ||
      pending.intent.purpose !== 'verythinker-native-initial-key' ||
      pending.intent.project_id !== pending.project_id ||
      pending.intent.key_id !== pending.key_id ||
      pending.intent.public_key !== pending.public_key ||
      derivedPublic !== pending.public_key ||
      hash(derivedPublic) !== pending.key_id ||
      !verify(
        null,
        Buffer.from(canonicalJson(unsigned)),
        createPublicKey(derivedPublic),
        Buffer.from(signature, 'base64'),
      )
    )
      throw new Error('invalid intent');
    return pending;
  } catch {
    throw new Error('Initial native key recovery intent is invalid or belongs to another project.');
  }
}
function receiptKey(
  root: string,
  provisioningHook?: NativeOptions['provisioning_hook'],
): { privateKey: string; id: string } {
  return withOperationLock(root, 'native-receipt-key', () => {
    const privatePath = safePath(root, '.verythinker/cache/native/private-key.pem');
    const pendingPath = safePath(root, '.verythinker/cache/native/pending-initial-key.json');
    if (!existsSync(privatePath)) {
      const receipts = safePath(root, '.verythinker/native/receipts');
      const historyExists =
        existsSync(safePath(root, '.verythinker/cache/native/trust-backup.json')) ||
        (existsSync(receipts) && readdirSync(receipts).some((name) => name.endsWith('.json')));
      if (historyExists)
        throw new Error(
          'The original native signing key is missing. Restore it from its trusted local backup; no replacement key was enrolled.',
        );
      let pending: PendingInitialKey;
      if (existsSync(pendingPath)) {
        pending = validatePendingInitialKey(root, pendingPath);
      } else {
        if (existsSync(safePath(root, '.verythinker/native/trust.json')))
          throw new Error(
            'The original native signing key is missing. Restore it from its trusted local backup; no replacement key was enrolled.',
          );
        const keys = generateKeyPairSync('ed25519');
        const privateKey = keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
        const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
        const id = hash(publicKey);
        const unsignedIntent = {
          schema_version: 1 as const,
          purpose: 'verythinker-native-initial-key' as const,
          project_id: readConfig(root).project_id,
          key_id: id,
          public_key: publicKey,
        };
        pending = {
          schema_version: 1,
          project_id: unsignedIntent.project_id,
          key_id: id,
          private_key: privateKey,
          public_key: publicKey,
          intent: {
            ...unsignedIntent,
            signature: sign(
              null,
              Buffer.from(canonicalJson(unsignedIntent)),
              keys.privateKey,
            ).toString('base64'),
          },
        };
        atomicWrite(pendingPath, JSON.stringify(pending, null, 2) + '\n');
        provisioningHook?.('pending');
      }
      const privateKey = pending.private_key;
      const publicKey = pending.public_key;
      const id = pending.key_id;
      const publicPath = safePath(root, `.verythinker/native/keys/${id}.pem`);
      const trustPath = safePath(root, '.verythinker/native/trust.json');
      const trustBytes = initialTrustBytes(id);
      if (existsSync(publicPath) && readFileSync(publicPath, 'utf8') !== publicKey)
        throw new Error('Initial native public key differs from its signed recovery intent.');
      if (existsSync(trustPath) && readFileSync(trustPath, 'utf8') !== trustBytes)
        throw new Error('Initial native trust registry differs from its signed recovery intent.');
      if (!existsSync(publicPath)) atomicWrite(publicPath, publicKey);
      provisioningHook?.('public');
      if (!existsSync(trustPath)) atomicWrite(trustPath, trustBytes);
      provisioningHook?.('trust');
      atomicWrite(privatePath, privateKey);
      provisioningHook?.('private');
    }
    const privateKey = readFileSync(privatePath, 'utf8');
    const publicKey = createPublicKey(createPrivateKey(privateKey))
      .export({ type: 'spki', format: 'pem' })
      .toString();
    const id = hash(publicKey);
    const publicPath = safePath(root, `.verythinker/native/keys/${id}.pem`);
    ensureNativeTrustFiles(root, true);
    const trusted = JSON.parse(
      readFileSync(safePath(root, '.verythinker/native/trust.json'), 'utf8'),
    );
    if (
      !existsSync(publicPath) ||
      readFileSync(publicPath, 'utf8') !== publicKey ||
      !trusted.keys?.includes(id)
    )
      throw new Error('Native signing key has no matching trusted public key.');
    if (existsSync(pendingPath))
      try {
        const pending = validatePendingInitialKey(root, pendingPath);
        if (pending.key_id === id && pending.private_key === privateKey) unlinkSync(pendingPath);
      } catch {
        // Preserve malformed or foreign pending state without weakening the active key.
      }
    return { privateKey, id };
  });
}
function persist(
  root: string,
  receipt: NativeReceipt,
  provisioningHook?: NativeOptions['provisioning_hook'],
): NativeReceipt {
  const key = receiptKey(root, provisioningHook);
  receipt.key_id = key.id;
  receipt.updated_at = now();
  const { signature: oldSignature, ...unsigned } = receipt;
  void oldSignature;
  receipt.signature = sign(
    null,
    Buffer.from(canonicalJson(unsigned)),
    createPrivateKey(key.privateKey),
  ).toString('base64');
  atomicWrite(nativeReceiptPath(root, receipt.id), JSON.stringify(receipt, null, 2) + '\n');
  return receipt;
}
function allReceipts(root: string): NativeReceipt[] {
  const path = safePath(root, '.verythinker/native/receipts');
  if (!existsSync(path)) return [];
  return readdirSync(path)
    .filter((name) => name.endsWith('.json'))
    .map((name) => readInvocation(root, name.slice(0, -5)))
    .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
}
function npmCommand(): { command: string; args: string[] } {
  const candidates = [
    process.env.npm_execpath,
    join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
    join(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js'),
    ...(process.env.PATH ?? '')
      .split(delimiter)
      .map((path) => join(path, 'node_modules/npm/bin/npm-cli.js')),
  ].filter((value): value is string => !!value);
  const cli = candidates.find((path) => existsSync(path) && path.endsWith('.js'));
  if (cli) return { command: process.execPath, args: [cli] };
  if (process.platform !== 'win32') return { command: 'npm', args: [] };
  throw new Error('The local npm CLI could not be resolved without invoking a shell.');
}
async function run(
  command: string,
  args: string[],
  cwd: string,
  timeout = 180000,
): Promise<string> {
  return new Promise((fulfill, reject) => {
    const child = spawn(command, args, {
      cwd,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('Native runtime preparation timed out.'));
    }, timeout);
    child.stdout.on('data', (data) => {
      output = (output + data).slice(-100000);
    });
    child.stderr.on('data', (data) => {
      output = (output + data).slice(-100000);
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      code === 0
        ? fulfill(output)
        : reject(new Error(`Native runtime command failed (${code}): ${cleanError(output)}`));
    });
  });
}
async function installationLease<T>(root: string, action: () => Promise<T>): Promise<T> {
  const path = safePath(root, '.verythinker/tools/codex.install.lock');
  mkdirSync(dirname(path), { recursive: true });
  const deadline = Date.now() + 180000;
  let fd: number;
  while (true) {
    try {
      fd = openSync(path, 'wx');
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let owner: { pid?: number } = {};
      try {
        owner = JSON.parse(readFileSync(path, 'utf8'));
      } catch {
        /* A malformed lease must not be removed automatically. */
      }
      if (owner.pid && !ownerIsAlive(owner.pid)) {
        unlinkSync(path);
        continue;
      }
      if (Date.now() >= deadline)
        throw new Error('Native runtime installation is locked by another owner.');
      await new Promise((done) => setTimeout(done, 100));
    }
  }
  try {
    writeFileSync(fd, JSON.stringify({ pid: process.pid, at: now() }));
    return await action();
  } finally {
    closeSync(fd);
    unlinkSync(path);
  }
}
async function prepareRuntime(root: string): Promise<RuntimeInfo> {
  readConfig(root);
  return installationLease(root, async () => {
    const prefix = safePath(root, '.verythinker/tools/codex');
    const main = join(prefix, 'node_modules/@openai/codex/bin/codex.js');
    const lockPath = join(prefix, 'package-lock.json');
    if (!existsSync(main) || !existsSync(lockPath)) {
      mkdirSync(prefix, { recursive: true });
      const npm = npmCommand();
      await run(
        npm.command,
        [
          ...npm.args,
          'install',
          '--prefix',
          prefix,
          '--no-audit',
          '--no-fund',
          '--ignore-scripts',
          '--save-exact',
          `@openai/codex@${runtimeVersion}`,
        ],
        root,
      );
    }
    const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
    const entry = lock.packages?.['node_modules/@openai/codex'];
    if (entry?.version !== runtimeVersion || entry?.integrity !== runtimeIntegrity)
      throw new Error(
        'The isolated Codex package does not match the pinned version and integrity.',
      );
    const version = await run(process.execPath, [main, '--version'], root, 15000);
    if (version.trim() !== `codex-cli ${runtimeVersion}`)
      throw new Error('The native executable does not report the pinned Codex version.');
    const schemaDirectory = safePath(root, '.verythinker/cache/native/schema-0.162.1');
    await run(
      process.execPath,
      [main, 'app-server', 'generate-json-schema', '--out', schemaDirectory],
      root,
      30000,
    );
    const schemaNames = [
      'ThreadStartResponse',
      'ThreadResumeResponse',
      'TurnStartResponse',
      'TurnCompletedNotification',
      'ModelReroutedNotification',
    ];
    const schemas = schemaNames.map((name) =>
      JSON.parse(readFileSync(join(schemaDirectory, 'v2', `${name}.json`), 'utf8')),
    );
    for (const schema of schemas.slice(0, 2)) {
      if (
        !['model', 'modelProvider', 'thread', 'cwd'].every((field) =>
          schema.required?.includes(field),
        ) ||
        !schema.properties?.reasoningEffort
      )
        throw new Error('The pinned native model acknowledgment schema is incompatible.');
    }
    if (!schemas[3]?.required?.includes('turn') || !schemas[4]?.required?.includes('toModel'))
      throw new Error('The native completion or rerouting schema is incompatible.');
    const nativePackage = Object.entries(lock.packages as Record<string, any>).filter(
      ([name, value]) =>
        name.startsWith('node_modules/@openai/codex-') &&
        value.optional &&
        existsSync(join(prefix, name)),
    );
    const binaries: Record<string, string> = {};
    function scan(directory: string): void {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) scan(path);
        else if (entry.name === 'codex' || entry.name === 'codex.exe')
          binaries[path.slice(prefix.length + 1).replaceAll('\\', '/')] = hash(readFileSync(path));
      }
    }
    for (const [name] of nativePackage) scan(join(prefix, name));
    if (!Object.keys(binaries).length)
      throw new Error('No pinned platform Codex binary was installed.');
    const info: RuntimeInfo = {
      version: runtimeVersion,
      command: process.execPath,
      args: [main],
      integrity: runtimeIntegrity,
      protocol_sha256: hash(canonicalJson(schemas)),
      executable_sha256: hash(canonicalJson(binaries)),
    };
    const publicLock = {
      schema_version: 1,
      package: '@openai/codex',
      version: runtimeVersion,
      integrity: runtimeIntegrity,
      protocol_sha256: info.protocol_sha256,
      launcher_sha256: hash(readFileSync(main)),
      binaries,
      dependencies: Object.fromEntries(
        nativePackage.map(([name, value]) => [
          name,
          { version: value.version, integrity: value.integrity },
        ]),
      ),
    };
    const target = safePath(root, '.verythinker/native-runtime.lock.json');
    const serialized = JSON.stringify(publicLock, null, 2) + '\n';
    if (existsSync(target) && readFileSync(target, 'utf8') !== serialized)
      throw new Error(
        'The pinned native runtime or protocol changed from its recorded lock; review it before execution.',
      );
    if (!existsSync(target)) atomicWrite(target, serialized);
    return info;
  });
}
export function ensureNativeRuntime(root: string): Promise<RuntimeInfo> {
  root = resolve(root);
  const running = installations.get(root);
  if (running) return running;
  const promise = prepareRuntime(root).finally(() => installations.delete(root));
  installations.set(root, promise);
  return promise;
}

class RpcTransport {
  child: ChildProcessWithoutNullStreams;
  pending = new Map<
    number,
    { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >();
  nextId = 1;
  closed = false;
  onMessage: (message: RpcMessage) => void = () => {};
  onClose: (error: Error) => void = () => {};
  constructor(
    runtime: RuntimeInfo,
    root: string,
    readonly timeout: number,
  ) {
    this.child = spawn(runtime.command, [...runtime.args, 'app-server', '--listen', 'stdio://'], {
      cwd: root,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let buffer = '';
    this.child.stdout.on('data', (data) => {
      buffer += data.toString();
      if (buffer.length > 8 * 1024 * 1024)
        return this.fail(new Error('Native protocol exceeded its bounded message buffer.'));
      while (buffer.includes('\n')) {
        const newline = buffer.indexOf('\n');
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        try {
          const message: RpcMessage = JSON.parse(line);
          if (
            message.id !== undefined &&
            !message.method &&
            typeof message.id === 'number' &&
            this.pending.has(message.id)
          ) {
            const waiting = this.pending.get(message.id)!;
            this.pending.delete(message.id);
            clearTimeout(waiting.timer);
            message.error
              ? waiting.reject(
                  new Error(
                    `Native RPC ${message.error.code ?? ''}: ${message.error.message ?? 'unknown error'}`,
                  ),
                )
              : waiting.resolve(message.result);
          } else this.onMessage(message);
        } catch (error) {
          this.fail(new Error(`Native protocol could not be parsed: ${cleanError(error)}`));
        }
      }
    });
    this.child.stderr.on('data', () => {}); // Native stderr can contain private session content; do not archive it.
    this.child.on('error', (error) => this.fail(error));
    this.child.on('exit', (code) => this.fail(new Error(`Native transport exited (${code}).`)));
  }
  request(method: string, params: unknown): Promise<any> {
    if (this.closed) return Promise.reject(new Error('Native transport is closed.'));
    const id = this.nextId++;
    return new Promise((fulfill, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Native RPC ${method} timed out.`));
      }, this.timeout);
      this.pending.set(id, { resolve: fulfill, reject, timer });
      this.child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
  }
  notify(method: string, params?: unknown): void {
    this.child.stdin.write(
      JSON.stringify({ method, ...(params === undefined ? {} : { params }) }) + '\n',
    );
  }
  fail(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiting of this.pending.values()) {
      clearTimeout(waiting.timer);
      waiting.reject(error);
    }
    this.pending.clear();
    this.onClose(error);
    this.child.kill();
  }
  close(): Promise<void> {
    const exited = this.child.exitCode !== null || this.child.signalCode !== null;
    const closed = exited
      ? Promise.resolve()
      : new Promise<void>((fulfill, reject) => {
          const timer = setTimeout(() => {
            this.child.off('close', done);
            reject(new Error('The owned native process did not close within five seconds.'));
          }, 5000);
          const done = () => {
            clearTimeout(timer);
            fulfill();
          };
          this.child.once('close', done);
        });
    this.fail(new Error('Native transport closed by its owner.'));
    return closed;
  }
}
function modelUnavailable(error: unknown): boolean {
  const message = cleanError(error);
  return (
    /model/i.test(message) &&
    /unavailable|unsupported|not supported|does not exist|not found|not available|cannot be used|cannot use|not allowed.*account/i.test(
      message,
    ) &&
    !/rate limit|quota|network|authentication|unauthorized|credential|api key/i.test(message)
  );
}
function validateAcknowledgment(value: any, root: string, model: string, effort: string): void {
  if (
    !value ||
    typeof value.model !== 'string' ||
    typeof value.modelProvider !== 'string' ||
    typeof value.thread?.id !== 'string' ||
    typeof value.cwd !== 'string'
  )
    throw new Error('Native thread acknowledgment is missing required model provenance.');
  if (value.model !== model)
    throw new Error(
      `Native thread selected ${value.model}, but strict routing requested ${model}.`,
    );
  if (value.reasoningEffort !== effort)
    throw new Error(
      `Native thread reasoning effort is ${value.reasoningEffort ?? 'unavailable'}; ${effort} is required.`,
    );
  if (resolve(value.cwd).toLowerCase() !== resolve(root).toLowerCase())
    throw new Error('Native thread acknowledgment belongs to another project directory.');
}
class NativeSession {
  transport: RpcTransport | null = null;
  receipt: NativeReceipt;
  completion: Promise<void>;
  resolveCompletion!: () => void;
  events: RpcMessage[] = [];
  baseConfiguration: Record<string, any> = {};
  closing: Promise<void> | null = null;
  turnResolvers = new Map<string, (value: any) => void>();
  constructor(
    readonly root: string,
    receipt: NativeReceipt,
    readonly options: NativeOptions,
  ) {
    this.receipt = receipt;
    this.completion = new Promise((fulfill) => {
      this.resolveCompletion = fulfill;
    });
  }
  update(patch: Partial<NativeReceipt>): void {
    Object.assign(this.receipt, patch);
    persist(this.root, this.receipt);
  }
  settle(state: NativeReceipt['state'], error: string | null = null): void {
    this.update({ state, error, inference_completed: state === 'completed' });
    void this.releaseTransport().finally(() => {
      this.resolveCompletion();
      active.delete(`${this.root}:${this.receipt.id}`);
    });
  }
  releaseTransport(): Promise<void> {
    if (this.closing) return this.closing;
    this.closing = (async () => {
      if (this.transport && !this.transport.closed && this.receipt.native_thread_id)
        await this.transport
          .request('thread/unsubscribe', { threadId: this.receipt.native_thread_id })
          .catch(() => {});
      await this.transport?.close();
    })();
    return this.closing;
  }
  onMessage(message: RpcMessage): void {
    if (this.closing) return;
    const params = message.params;
    if (message.id !== undefined && message.method) {
      const reason = cleanError(
        params?.reason ??
          params?.message ??
          `Native host action required: ${message.method}${params?.serverName ? ` (${params.serverName})` : ''}`,
      );
      this.update({
        state: 'waiting-native-permission',
        permissions: [
          ...this.receipt.permissions,
          { method: message.method, request_id: message.id, reason, at: now() },
        ],
      });
      // Leave native approval requests pending. Existing host policy, not this bridge, owns authorization.
      return;
    }
    if (
      params?.threadId &&
      this.receipt.native_thread_id &&
      params.threadId !== this.receipt.native_thread_id
    )
      return;
    if (message.method === 'model/rerouted') {
      this.update({
        reroutes: [
          ...this.receipt.reroutes,
          { from: params.fromModel, to: params.toModel, reason: String(params.reason), at: now() },
        ],
        confirmed_model: params.toModel,
        state: 'blocked',
        error: 'Native model rerouting requires a fresh invocation and reassessment.',
      });
      if (this.receipt.native_turn_id)
        void this.transport
          ?.request('turn/interrupt', {
            threadId: this.receipt.native_thread_id,
            turnId: this.receipt.native_turn_id,
          })
          .catch(() => {});
    }
    if (message.method === 'item/agentMessage/delta' && typeof params?.delta === 'string')
      this.update({ output: (this.receipt.output + params.delta).slice(0, 64000) });
    if (
      message.method === 'item/completed' &&
      params?.item?.type === 'agentMessage' &&
      typeof params.item.text === 'string'
    )
      this.update({ output: params.item.text.slice(0, 64000) });
    if (message.method === 'turn/completed' && typeof params?.turn?.id === 'string') {
      const waiting = this.turnResolvers.get(params.turn.id);
      if (waiting) {
        this.turnResolvers.delete(params.turn.id);
        waiting(params.turn);
      } else this.events.push(message);
    }
  }
  async turnResult(id: string): Promise<any> {
    const cached = this.events.find((message) => message.params?.turn?.id === id);
    if (cached) {
      this.events = this.events.filter((message) => message !== cached);
      return cached.params.turn;
    }
    return new Promise((fulfill) => this.turnResolvers.set(id, fulfill));
  }
  async begin(runtime: RuntimeInfo, resumeThread?: string): Promise<void> {
    this.transport = new RpcTransport(runtime, this.root, this.options.rpc_timeout_ms ?? 30000);
    this.transport.onMessage = (message) => this.onMessage(message);
    this.transport.onClose = (error) => {
      if (!terminalStates.includes(this.receipt.state)) this.settle('orphaned', cleanError(error));
    };
    this.update({
      server_pid: this.transport.child.pid ?? null,
      client_version: runtime.version,
      runtime_integrity: runtime.integrity,
      protocol_sha256: runtime.protocol_sha256,
      configuration_hashes: routingConfigurationHashes(this.root),
    });
    await this.transport.request('initialize', {
      clientInfo: {
        name: 'verythinker',
        title: 'VeryThinker managed engineering',
        version: '0.1.0-alpha.3',
      },
      capabilities: { experimentalApi: false },
    });
    this.transport.notify('initialized');
    const configuration = await this.transport.request('config/read', {
      includeLayers: false,
      cwd: this.root,
    });
    this.baseConfiguration = configuration.config ?? {};
    this.update({ effective_configuration_sha256: hash(canonicalJson(configuration.config)) });
    await this.launch(resumeThread);
  }
  async launch(resumeThread?: string): Promise<void> {
    const transport = this.transport!;
    const spec = roleModelPolicy(this.root, this.receipt.role);
    const cli = fileURLToPath(new URL('./cli.js', import.meta.url));
    const contract = roleCapabilitiesForReceipt(this.root, this.receipt);
    const operations = contract.operations;
    const previousGateway = this.baseConfiguration.mcp_servers?.verythinker ?? {};
    for (const operation of operations) {
      const explicit = previousGateway.tools?.[operation]?.approval_mode;
      if (explicit && explicit !== 'approve')
        throw new Error(
          `Authored VeryThinker tool approval policy for ${operation} requires ${explicit}; preserve it and review the configuration before automatic execution.`,
        );
    }
    if (
      Array.isArray(previousGateway.enabled_tools) &&
      operations.some((operation) => !previousGateway.enabled_tools.includes(operation))
    )
      throw new Error(
        'Authored VeryThinker enabled_tools restricts this role. Review the native tool configuration before execution.',
      );
    if (
      Array.isArray(previousGateway.disabled_tools) &&
      previousGateway.disabled_tools.some((operation: string) => operations.includes(operation))
    )
      throw new Error(
        'Authored VeryThinker disabled_tools conflicts with this role; preserve the restriction and review configuration.',
      );
    let fastContext = Boolean(this.receipt.fast_grant);
    if (!fastContext && this.receipt.role === 'reviewer' && this.receipt.workflow_id) {
      try { fastContext = getRecord(this.root, this.receipt.workflow_id).meta.data.execution_policy === 'fast'; }
      catch { /* Unresolved or fixture bindings retain their ordinary role instructions. */ }
    }
    // A composite planning stage is not the full Standard coordinator. Loading
    // contradictory delegation/closure instructions wastes turns and cannot
    // grant those operations. Current core gates and exact routing are unchanged.
    const instructionPaths = fastContext
      ? [...(this.receipt.fast_grant?.stage === 'planner' ? [] : [`roles/${this.receipt.role}.md`]), 'guides/fast-workflow.md']
      : [`roles/${this.receipt.role}.md`, 'guides/workflow.md', ...(this.receipt.role === 'manager' ? ['guides/manager.md'] : [])];
    const instructions = instructionPaths
      .map((path) => {
        const installed = safePath(this.root, `.verythinker/${path}`);
        const source = existsSync(installed) ? installed : join(resourceRoot, path);
        return existsSync(source)
          ? `\n## Installed instruction ${path}\n${readFileSync(source, 'utf8')}`
          : '';
      })
      .join('')
      .slice(0, 32000);
    const authoringGuidance =
      this.receipt.role === 'developer'
        ? ' For an existing small edit, obtain the SHA-256 through project_read, then prefer task_file_write with replacement:{before,after} matching exactly one literal occurrence. The core preserves unrelated bytes, including newline escapes. Omit content or set it null with replacement. Set operation_id:null (or omit it) for each new edit so core allocates a distinct UUID. Reuse a returned operation UUID only for its identical lost-response payload; never reuse an invocation ID across different edits. Full content supports whole-file/new-file work; null expected_hash is only for a missing file. Cornell artifacts use note_create. Reviewed scope, protected artifacts and native permissions still apply.'
        : this.receipt.role === 'check-executor'
          ? ' For a reviewed inspection_items rubric, read the current plan through record_get with explicit data_fields and include_body:false. Inspect every exact item, obtain file SHA-256 values through project_read or full record fingerprints through record_get, then submit actual observations and limitations through check_inspect. Report fail/gap when the expected criterion is not demonstrated. This records model-performed inspection, not automatic semantic proof; independent review and actual executable checks remain distinct.'
          : '';
    const fastGuidance = this.receipt.fast_grant
      ? this.receipt.fast_grant.stage === 'planner'
        ? ' This invocation has a core-issued Fast planner grant: combine requirements, architecture and verification strategy in ONE scoped planning artifact. Do not delegate specialists or execute implementation. The core owns independent plan review, production, final review and closure. Use fast_plan_submit last; do not call manager_decide or manager_finish. Your actual native role remains manager and performed responsibilities are derived by the gateway.'
        : ' This invocation has a core-issued Fast producer grant: implement only the reviewed task and execute its prescribed checks. Use task_start (or task_resume for persisted interrupted work), task_file_write, check_run/check_inspect and task_submit. Do not change planning artifacts, protected expectations or review your work. The core owns final independent review and closure.'
      : '';
    const params = {
      model: this.receipt.requested_model,
      cwd: this.root,
      ...(spec.strong ? { sandbox: 'read-only' } : {}),
      config: {
        model_reasoning_effort: spec.reasoning_effort,
        'mcp_servers.verythinker': {
          command: process.execPath,
          args: [cli, 'mcp', '--project', this.root, '--invocation', this.receipt.id],
          enabled_tools: operations,
          tools: Object.fromEntries(
            operations.map((operation) => [operation, { approval_mode: 'approve' }]),
          ),
        },
      },
      developerInstructions: `VeryThinker native invocation ${this.receipt.id}; role ${this.receipt.role}; workflow ${this.receipt.workflow_id ?? 'unassigned'}; task ${this.receipt.task_id ?? 'unassigned'}. Use the invocation-bound VeryThinker MCP operations. Work only within your role and task contract. Do not invoke manager_run recursively. The manager has already created the workflow. Every durable change and review must reference this invocation. Before ending your assignment, call assignment_report with substantive Objective, Inputs and Sources, Decisions and Rationale, Results, Evidence, Limitations, and Lessons sections. A producer's task_submit with the full seven-section work_record satisfies this reporting requirement instead. Reviewers report after their actual review; check executors report after executing checks and inspecting the result. For a follow-up report, explicitly list any covered prior invocation IDs of your own role and assignment. Do not fabricate another agent's narrative. Native authorization belongs to the existing client policy.${authoringGuidance}${fastGuidance} The installed role and workflow instructions are included below; use MCP record and recipe operations to inspect engineering state rather than shell commands just to reload these instructions.${instructions}`,
    };
    let ack: any;
    this.update({
      native_tool_scope: operations,
      gateway_policy_sha256: hash(canonicalJson(params.config['mcp_servers.verythinker'])),
    });
    try {
      ack = await transport.request(resumeThread ? 'thread/resume' : 'thread/start', {
        ...params,
        ...(resumeThread ? { threadId: resumeThread, excludeTurns: true } : {}),
      });
    } catch (error) {
      if (
        !spec.strong &&
        this.receipt.requested_model === 'gpt-6-luna' &&
        modelUnavailable(error)
      ) {
        this.update({
          requested_model: 'gpt-5.6-terra',
          fallback_evidence: { model: 'gpt-6-luna', reason: cleanError(error), at: now() },
        });
        return this.launch(resumeThread);
      }
      throw error;
    }
    validateAcknowledgment(ack, this.root, this.receipt.requested_model, spec.reasoning_effort);
    if (resumeThread && ack.thread.id !== resumeThread)
      throw new Error('Native resume acknowledged a different thread identity.');
    if (spec.strong && ack.sandbox?.type !== 'readOnly')
      throw new Error(
        'The native client did not acknowledge read-only shell access for the strategic role.',
      );
    this.update({
      confirmed_model: ack.model,
      model_provider: ack.modelProvider,
      native_sandbox: ack.sandbox?.type ?? null,
      confirmed_reasoning_effort: ack.reasoningEffort,
      native_thread_id: ack.thread.id,
    });
    if (resumeThread) {
      // Retrieve only recent turn metadata: a saved conversation can exceed the
      // transport bound when resume hydrates every historical item.
      const page = await transport.request('thread/turns/list', {
        threadId: resumeThread,
        limit: 100,
        sortDirection: 'desc',
        itemsView: 'notLoaded',
      });
      if (!Array.isArray(page?.data))
        throw new Error('Native resume did not return bounded turn metadata.');
      const running = page.data.filter((turn: any) => turn.status === 'inProgress');
      if (ack.thread.status?.type === 'active' && running.length === 0)
        throw new Error('The active native thread could not be reconciled from recent turn metadata.');
      for (const turn of running) {
        await transport.request('turn/interrupt', { threadId: resumeThread, turnId: turn.id });
        const completed = await Promise.race([
          this.turnResult(turn.id),
          new Promise((_, reject) =>
            setTimeout(
              () => reject(new Error('The previous native turn could not be reconciled.')),
              30000,
            ),
          ),
        ]);
        if (!completed || (completed as any).status === 'inProgress')
          throw new Error('The previous native turn still owns its transport.');
      }
    }
    const started = await transport.request('turn/start', {
      threadId: ack.thread.id,
      input: [{ type: 'text', text: this.receipt.input_text, text_elements: [] }],
      effort: spec.reasoning_effort,
      clientUserMessageId: this.receipt.id,
    });
    if (typeof started?.turn?.id !== 'string')
      throw new Error('Native turn start acknowledgment has no turn identity.');
    this.update({ native_turn_id: started.turn.id, state: 'running' });
    void this.completeTurn(started.turn.id);
  }
  async completeTurn(id: string): Promise<void> {
    try {
      const turn = await this.turnResult(id);
      if (this.receipt.reroutes.length)
        return this.settle('blocked', 'Native model rerouted; outputs require reassessment.');
      if (
        turn.status === 'failed' &&
        !roleModelPolicy(this.root, this.receipt.role).strong &&
        this.receipt.requested_model === 'gpt-6-luna' &&
        modelUnavailable(turn.error?.message ?? JSON.stringify(turn.error))
      ) {
        this.update({
          requested_model: 'gpt-5.6-terra',
          confirmed_model: null,
          native_thread_id: null,
          native_turn_id: null,
          state: 'starting',
          output: '',
          fallback_evidence: {
            model: 'gpt-6-luna',
            reason: cleanError(turn.error?.message ?? JSON.stringify(turn.error)),
            at: now(),
          },
        });
        return await this.launch();
      }
      if (turn.status !== 'completed')
        return this.settle(
          turn.status === 'interrupted' ? 'interrupted' : 'failed',
          cleanError(turn.error?.message ?? `Native turn ended with ${turn.status}.`),
        );
      const configuration = await this.transport!.request('config/read', {
        includeLayers: false,
        cwd: this.root,
      });
      if (
        hash(canonicalJson(configuration.config)) !== this.receipt.effective_configuration_sha256 ||
        canonicalJson(routingConfigurationHashes(this.root)) !==
          canonicalJson(this.receipt.configuration_hashes)
      )
        return this.settle('blocked', 'Native configuration changed during inference.');
      this.update({ state: 'completed', inference_completed: true, error: null });
      if (
        this.receipt.role === 'manager' && this.receipt.workflow_id &&
        this.receipt.fast_grant?.stage !== 'planner'
      ) {
        try {
          const workflow = getRecord(this.root, this.receipt.workflow_id);
          if (workflow.meta.data.phase === 'awaiting-native-completion') {
            const { finishWorkflow } = await import('./manager.js');
            finishWorkflow(this.root, this.receipt.workflow_id, {});
          }
        } catch (error) {
          // Publication/closure failures do not rewrite a frozen accepted snapshot
          // or turn successful native inference into a failed inference claim.
          atomicWrite(
            safePath(this.root, `.verythinker/native/completion/${this.receipt.id}.json`),
            JSON.stringify(
              {
                schema_version: 1,
                workflow_id: this.receipt.workflow_id,
                invocation_id: this.receipt.id,
                error: cleanError(error),
                at: now(),
              },
              null,
              2,
            ) + '\n',
          );
        }
      }
      // The completed receipt may now be frozen in an archive. Do not re-sign it.
      await this.releaseTransport();
      this.resolveCompletion();
      active.delete(`${this.root}:${this.receipt.id}`);
    } catch (error) {
      this.settle('blocked', cleanError(error));
    }
  }
}
function newReceipt(root: string, input: NativeStartInput, prior?: NativeReceipt): NativeReceipt {
  if (typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 64000)
    throw new Error(
      'Native invocation needs a non-empty bounded prompt (maximum 64000 characters).',
    );
  if (
    input.request_id !== undefined &&
    (typeof input.request_id !== 'string' ||
      !input.request_id.trim() ||
      input.request_id.length > 256)
  )
    throw new Error('Native request ID must be a non-empty bounded string.');
  const spec = roleModelPolicy(root, input.role);
  const id = randomUUID();
  return {
    schema_version: 1,
    issuer: 'verythinker-codex-app-server',
    execution_mode: 'native',
    id,
    receipt_path: `.verythinker/native/receipts/${id}.json`,
    project_id: readConfig(root).project_id,
    role: input.role,
    workflow_id: input.workflow_id ?? null,
    task_id: input.task_id ?? null,
    request_id: input.request_id ?? null,
    prior_invocation_id: prior?.id ?? null,
    input_text: input.prompt,
    input_sha256: hash(input.prompt),
    requested_model: spec.models[0]!,
    confirmed_model: null,
    model_provider: null,
    native_sandbox: null,
    native_tool_scope: [],
    gateway_policy_sha256: null,
    reasoning_effort: spec.reasoning_effort,
    confirmed_reasoning_effort: null,
    client_version: runtimeVersion,
    runtime_integrity: '',
    protocol_sha256: '',
    routing_sha256: hash(canonicalJson(readRoutingPolicy(root))),
    configuration_hashes: routingConfigurationHashes(root),
    effective_configuration_sha256: null,
    native_thread_id: null,
    native_turn_id: null,
    state: 'starting',
    inference_completed: false,
    output: '',
    error: null,
    fallback_evidence: null,
    reroutes: [],
    permissions: [],
    owner_pid: process.pid,
    server_pid: null,
    created_at: now(),
    updated_at: now(),
    key_id: '',
    signature: '',
  };
}
function requireCurrentRouting(root: string): void {
  const policy = requireRoutingPolicy(root);
  if (policy.strong_model !== 'gpt-6-luna' || policy.strong_effort !== 'max')
    throw new Error(
      'New native dispatch requires the current Luna/max routing policy. Complete the project update after any existing native invocation is settled.',
    );
}
/** Uncertain owners quarantine overlapping execution, not unrelated read-only planning. */
export function nativeScopeConflict(root: string, input: NativeStartInput, prior: NativeReceipt): boolean {
  if (!input.workflow_id || !prior.workflow_id || input.workflow_id === prior.workflow_id) return true;
  if (!input.task_id && ['manager', 'requirements', 'architect', 'component-owner', 'verifier', 'reviewer'].includes(input.role)) return false;
  // Assigned write paths cannot establish isolation for compilers, scripts,
  // simulators or shared tool state. Uncertain execution remains quarantined
  // until its transport is demonstrably absent or owned control resolves it.
  return true;
}
async function startOwned(
  root: string,
  input: NativeStartInput,
  options: NativeOptions,
  prior?: NativeReceipt,
  resumeThread?: string,
): Promise<NativeReceipt> {
  root = resolve(root);
  requireRoutingPolicy(root);
  const receipt = withOperationLock(root, 'native-dispatch', () => {
    const receipts = allReceipts(root);
    if (input.request_id) {
      const existing = receipts.find((receipt) => receipt.request_id === input.request_id);
      if (existing) {
        if (
          existing.input_sha256 !== hash(input.prompt) ||
          existing.role !== input.role ||
          existing.workflow_id !== (input.workflow_id ?? null) ||
          existing.task_id !== (input.task_id ?? null) ||
          existing.fast_grant?.stage !== (options.fast_stage ?? undefined)
        )
          throw new Error('Native request ID is already bound to different work.');
        return existing;
      }
    }
    requireCurrentRouting(root);
    const running = receipts.filter((receipt) => invocationIsActive(receipt));
    const abandoned = running.find((receipt) => !ownerIsAlive(receipt.owner_pid) && nativeScopeConflict(root, input, receipt));
    if (abandoned)
      throw new Error(
        `Native invocation ${abandoned.id} has an absent owner; reconcile it before dispatching more work.`,
      );
    if (input.task_id && running.some((receipt) => receipt.task_id === input.task_id))
      throw new Error('This task already has a live native invocation.');
    if (
      input.role !== 'manager' &&
      running.filter((receipt) => receipt.role !== 'manager').length >= readConfig(root).max_workers
    )
      throw new Error('The project already has its maximum concurrent native workers.');
    const created = newReceipt(root, input, prior);
    if (options.runtime) created.execution_mode = 'protocol-fixture';
    if (options.fast_stage) {
      if (options.runtime) throw new Error('Fast stage grants cannot be minted for protocol fixtures.');
      created.fast_grant = issueFastGrant(
        root,
        created,
        options.fast_stage,
        options.fast_stage === 'producer' ? input.task_id ?? null : null,
      );
    }
    persist(root, created, options.provisioning_hook);
    return created;
  });
  const key = `${root}:${receipt.id}`;
  if (
    active.has(key) ||
    receipt.owner_pid !== process.pid ||
    receipt.state !== 'starting' ||
    receipt.server_pid !== null
  )
    return receipt;
  const session = new NativeSession(root, receipt, options);
  active.set(key, session);
  try {
    if (receipt.task_id) {
      const task = getRecord(root, receipt.task_id);
      const required = task.meta.data.required_tools;
      if (required !== undefined) {
        if (
          !Array.isArray(required) ||
          required.some(
            (id) => typeof id !== 'string' || !toolCatalog.some((provider) => provider.id === id),
          )
        )
          throw new Error('Task required_tools must name approved provider IDs.');
        if (required.length)
          await resolveCapabilities(root, {
            role: receipt.role,
            required: required as ProviderId[],
          });
      }
    }
    const runtime = await (options.runtime ?? ensureNativeRuntime)(root);
    await session.begin(runtime, resumeThread ?? prior?.native_thread_id ?? undefined);
  } catch (error) {
    session.settle('blocked', cleanError(error));
  }
  return readInvocation(root, receipt.id);
}
export function startNative(
  root: string,
  input: NativeStartInput,
  ownerToken?: string,
): Promise<NativeReceipt> {
  return startOwned(root, input, { owner_token: ownerToken });
}
/** Core-controller-only native entry. The ordinary native_dispatch API has no grant input. */
export async function startFastNative(
  root: string,
  input: NativeStartInput,
  stage: FastStage,
  ownerToken?: string,
): Promise<NativeReceipt> {
  const role = stage === 'planner' ? 'manager' : 'developer';
  if (input.role !== role)
    throw new Error(`Fast ${stage} stage must retain the standard ${role} base role.`);
  if (!input.workflow_id)
    throw new Error('Fast native stage requires an exact workflow binding.');
  if (stage === 'planner' && input.task_id)
    throw new Error('Fast planner authority is workflow scoped and cannot bind to a task.');
  if (stage === 'producer') {
    if (!input.task_id) throw new Error('Fast producer stage requires its exact assigned task.');
    await assertFastProducerReady(resolve(root), input.task_id);
  }
  // The verified runtime lock is part of the signed authority configuration.
  // Finish cold preparation before minting a grant, so installation itself
  // cannot invalidate a newly issued stage before its first model turn.
  await ensureNativeRuntime(resolve(root));
  return startOwned(root, input, { owner_token: ownerToken, fast_stage: stage });
}
export function nativeStatus(root: string, id?: string): NativeReceipt | NativeReceipt[] {
  return id ? readInvocation(root, id) : allReceipts(root);
}
export async function waitNative(root: string, id: string, waitMs = 10000): Promise<NativeReceipt> {
  if (!Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > 60000)
    throw new Error('Native wait must be between 0 and 60000 milliseconds.');
  root = resolve(root);
  const session = active.get(`${root}:${id}`);
  if (session && waitMs > 0)
    await Promise.race([session.completion, new Promise((fulfill) => setTimeout(fulfill, waitMs))]);
  return readInvocation(root, id);
}
export async function interruptNative(root: string, id: string): Promise<NativeReceipt> {
  root = resolve(root);
  const receipt = readInvocation(root, id);
  if (!invocationIsActive(receipt) && receipt.state !== 'blocked') return receipt;
  const session = active.get(`${root}:${id}`);
  if (!session) {
    if (ownerIsAlive(receipt.owner_pid))
      throw new Error(
        'The live native transport is owned by another process. Interrupt it through that owner.',
      );
    if (receipt.server_pid && ownerIsAlive(receipt.server_pid))
      throw new Error(
        'The orphaned native server remains alive; stop the original transport before resuming.',
      );
    receipt.state = 'orphaned';
    receipt.inference_completed = false;
    receipt.error =
      'The previous owner and transport are absent; a resumed invocation must reconcile native turn history.';
    return persist(root, receipt);
  }
  if (
    receipt.native_thread_id &&
    receipt.native_turn_id &&
    session.transport &&
    !session.transport.closed
  ) {
    try {
      await session.transport.request('turn/interrupt', {
        threadId: receipt.native_thread_id,
        turnId: receipt.native_turn_id,
      });
      await waitNative(root, id, 1000);
    } catch {
      /* Closing the owned transport below preserves an interrupted receipt. */
    }
  }
  if (active.has(`${root}:${id}`))
    session.settle('interrupted', 'Native invocation interrupted by its owner.');
  return readInvocation(root, id);
}
/** Internal managed-intake recovery. It never interrupts or kills a live/uncertain transport. */
export function reconcileNativeOrphans(
  root: string,
  invocationIds: string[],
  authorization: 'managed-intake',
): OrphanReconcileResult {
  if (authorization !== 'managed-intake') throw new Error('Orphan reconciliation is reserved for managed intake.');
  if (!Array.isArray(invocationIds) || !invocationIds.length || invocationIds.length > 32)
    throw new Error('Orphan reconciliation requires 1 to 32 explicit invocation IDs.');
  root = resolve(root);
  const reconciled: string[] = [];
  const quarantined: OrphanReconcileResult['quarantined'] = [];
  for (const id of [...new Set(invocationIds)]) {
    const receipt = readInvocation(root, id);
    if (!invocationIsActive(receipt)) continue;
    if (ownerIsAlive(receipt.owner_pid)) {
      quarantined.push({ invocation_id: id, reason: 'Recorded native owner is still alive.' });
      continue;
    }
    if (!receipt.server_pid || ownerIsAlive(receipt.server_pid)) {
      quarantined.push({ invocation_id: id, reason: 'Native transport is live or its liveness is uncertain.' });
      continue;
    }
    const priorBytes = readFileSync(nativeReceiptPath(root, id));
    appendEvent(root, `native-${id}`, {
      kind: 'native-orphan-reconciled',
      invocation_id: id,
      prior_state: receipt.state,
      prior_receipt_sha256: hash(priorBytes),
      prior_receipt_bytes_base64: priorBytes.toString('base64'),
      owner_pid: receipt.owner_pid,
      server_pid: receipt.server_pid,
      terminal_state: 'orphaned',
      inference_completed: false,
    });
    receipt.state = 'orphaned';
    receipt.inference_completed = false;
    receipt.error = 'Managed intake reconciled an absent owner and absent native transport; prior signed bytes are preserved in the reconciliation audit event.';
    persist(root, receipt);
    reconciled.push(id);
  }
  return { reconciled, quarantined };
}
/** Find only a signed same-assignment ancestor; never invent a thread acknowledgment. */
export function nativeResumeTarget(root: string, receipt: NativeReceipt): NativeReceipt | undefined {
  if (receipt.native_thread_id) return receipt;
  const visited = new Set([receipt.id]);
  let current = receipt;
  for (let depth = 0; current.prior_invocation_id && depth < 128; depth++) {
    if (current.state !== 'blocked' || current.native_turn_id || current.inference_completed)
      throw new Error('Only a blocked pre-acknowledgment resume can recover its prior thread.');
    const id = current.prior_invocation_id;
    if (visited.has(id)) throw new Error('Native resume lineage contains a cycle.');
    visited.add(id);
    const ancestor = readInvocation(root, id);
    if (
      ancestor.project_id !== receipt.project_id || ancestor.role !== receipt.role ||
      ancestor.workflow_id !== receipt.workflow_id || ancestor.task_id !== receipt.task_id
    ) throw new Error('Native resume lineage belongs to another assignment.');
    if (ancestor.native_thread_id) {
      if (ancestor.state !== 'completed' || !ancestor.inference_completed)
        throw new Error('The acknowledged ancestor must be completed before retrying a failed resume.');
      return ancestor;
    }
    current = ancestor;
  }
  if (current.prior_invocation_id) throw new Error('Native resume lineage exceeds its bounded depth.');
  return undefined;
}
async function resumeOwned(
  root: string,
  id: string,
  input: NativeResumeInput,
  options: NativeOptions,
): Promise<NativeReceipt> {
  root = resolve(root);
  withOperationLock(root, 'native-dispatch', () => requireCurrentRouting(root));
  let prior = readInvocation(root, id);
  if (prior.fast_grant) {
    if (options.fast_stage !== prior.fast_grant.stage)
      throw new Error('Fast invocations must be resumed through the private Fast controller entry.');
    const grantProblems = fastGrantProblems(root, prior, { historical: true });
    if (grantProblems.length)
      throw new Error(`Prior Fast authority is not valid for resume: ${grantProblems.join('; ')}`);
  } else if (options.fast_stage) {
    throw new Error('Fast resume requires a previously signed Fast stage grant.');
  }
  if (invocationIsActive(prior)) prior = await interruptNative(root, id);
  const ending = active.get(`${root}:${id}`);
  if (ending?.closing) await ending.closing;
  if (prior.server_pid && ownerIsAlive(prior.server_pid) && !active.has(`${root}:${id}`))
    throw new Error('The prior native transport has not exited; retry after reconciliation.');
  const target = nativeResumeTarget(root, prior);
  if (!target?.native_thread_id)
    throw new Error(
      'This invocation has no acknowledged native thread to resume. Start a new bounded invocation after resolving its blocker.',
    );
  return startOwned(
    root,
    {
      role: prior.role,
      prompt: input.prompt ?? prior.input_text,
      ...(prior.workflow_id ? { workflow_id: prior.workflow_id } : {}),
      ...(prior.task_id ? { task_id: prior.task_id } : {}),
      ...(input.request_id ? { request_id: input.request_id } : {}),
    },
    options,
    prior,
    target.native_thread_id,
  );
}
export function resumeNative(
  root: string,
  id: string,
  input: NativeResumeInput = {},
  ownerToken?: string,
): Promise<NativeReceipt> {
  return resumeOwned(root, id, input, { owner_token: ownerToken });
}
/** Core-controller-only resume that reissues the same stage with a fresh signed receipt and grant. */
export async function resumeFastNative(
  root: string,
  id: string,
  input: NativeResumeInput = {},
  ownerToken?: string,
): Promise<NativeReceipt> {
  root = resolve(root);
  const prior = readInvocation(root, id);
  const stage = prior.fast_grant?.stage;
  if (!stage) throw new Error('Fast resume requires a previously signed Fast stage grant.');
  const problems = fastGrantProblems(root, prior, { historical: true });
  if (problems.length)
    throw new Error(`Prior Fast authority is not valid for resume: ${problems.join('; ')}`);
  if (stage === 'producer') await assertFastProducerReady(root, prior.task_id!);
  return resumeOwned(root, id, input, { owner_token: ownerToken, fast_stage: stage });
}
/** Dependency-injected transport factory for protocol fixtures; never exposed by CLI or MCP. */
export function createNativeBridge(options: NativeOptions): {
  start: typeof startNative;
  resume: typeof resumeNative;
  status: typeof nativeStatus;
  wait: typeof waitNative;
  interrupt: typeof interruptNative;
} {
  return {
    start: (root, input) => startOwned(root, input, options),
    resume: (root, id, input = {}) => resumeOwned(root, id, input, options),
    status: nativeStatus,
    wait: waitNative,
    interrupt: interruptNative,
  };
}
export async function shutdownNative(root?: string, ownerToken?: string): Promise<void> {
  for (const session of [...active.values()].filter(
    (session) =>
      (!root || session.root === resolve(root)) &&
      (!ownerToken || session.options.owner_token === ownerToken),
  )) {
    await interruptNative(session.root, session.receipt.id);
    await session.releaseTransport();
    await session.completion;
  }
}
process.once('beforeExit', () => {
  for (const session of active.values())
    session.settle('interrupted', 'Native owner is shutting down.');
});
