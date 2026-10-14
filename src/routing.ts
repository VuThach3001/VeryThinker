import { createPublicKey, verify } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { ensureNativeTrustFiles } from './trust.js';
import { hasFastResponsibility, fastGrantProblems } from './fast-grants.js';
import {
  atomicWrite,
  getRecord,
  hash,
  now,
  readConfig,
  safePath,
  withOperationLock,
} from './storage.js';

export const strongRoles = [
  'manager',
  'requirements',
  'architect',
  'component-owner',
  'verifier',
  'reviewer',
] as const;
export const workerRoles = [
  'researcher',
  'codebase-analyst',
  'curator',
  'developer',
  'check-executor',
  'release',
] as const;
export type NativeRole = (typeof strongRoles)[number] | (typeof workerRoles)[number];
export type NativeState =
  | 'starting'
  | 'running'
  | 'waiting-native-permission'
  | 'completed'
  | 'failed'
  | 'interrupted'
  | 'blocked'
  | 'orphaned';
interface RoutingPolicyBase {
  schema_version: 1;
  enabled: true;
  platform: 'codex';
  runtime_version: '0.162.1';
  worker_models: ['gpt-6-luna', 'gpt-5.6-terra'];
  worker_effort: 'medium';
}
export interface LegacyRoutingPolicy extends RoutingPolicyBase {
  strong_model: 'gpt-6.1-sol';
  strong_effort: 'high';
}
export interface CurrentRoutingPolicy extends RoutingPolicyBase {
  strong_model: 'gpt-6-luna';
  strong_effort: 'max';
}
export type RoutingPolicy = CurrentRoutingPolicy | LegacyRoutingPolicy;
export type ApprovedRoutingPolicy = RoutingPolicy;
export interface NativeReceipt {
  schema_version: 1;
  issuer: 'verythinker-codex-app-server';
  execution_mode: 'native' | 'protocol-fixture';
  id: string;
  receipt_path: string;
  project_id: string;
  role: NativeRole;
  workflow_id: string | null;
  task_id: string | null;
  request_id: string | null;
  /** Core-issued, immutable stage authority. Historical receipts omit this field. */
  fast_grant?: FastStageGrant;
  prior_invocation_id: string | null;
  input_text: string;
  input_sha256: string;
  requested_model: string;
  confirmed_model: string | null;
  model_provider: string | null;
  /** Requested client sandbox for new invocations; historical receipts omit it. */
  requested_sandbox?: 'readOnly' | 'workspaceWrite' | null;
  native_sandbox: string | null;
  native_tool_scope: string[];
  gateway_policy_sha256: string | null;
  reasoning_effort: 'high' | 'xhigh' | 'max' | 'medium';
  confirmed_reasoning_effort: string | null;
  client_version: string;
  runtime_integrity: string;
  protocol_sha256: string;
  routing_sha256: string;
  configuration_hashes: Record<string, string>;
  effective_configuration_sha256: string | null;
  native_thread_id: string | null;
  native_turn_id: string | null;
  state: NativeState;
  inference_completed: boolean;
  output: string;
  error: string | null;
  fallback_evidence: { model: string; reason: string; at: string } | null;
  reroutes: { from: string; to: string; reason: string; at: string }[];
  permissions: { method: string; request_id: string | number; reason: string; at: string }[];
  owner_pid: number;
  server_pid: number | null;
  created_at: string;
  updated_at: string;
  key_id: string;
  signature: string;
}
export interface FastStageGrant {
  schema_version: 1;
  grant_id: string;
  stage: 'planner' | 'producer';
  phase: 'planning' | 'production';
  invocation_id: string;
  owner_pid: number;
  workflow_id: string;
  task_id: string | null;
  allowed_operations: string[];
  allowed_paths: string[];
  protected_check_ids: string[];
  configuration_hashes: Record<string, string>;
  selection_sha256: string;
  plan_sha256: string;
  issued_at: string;
  expires_at: string;
}
export interface RoutingBinding {
  workflow_id?: string;
  task_id?: string;
  require_completed?: boolean;
}

/** Canonical representation used for native receipt signatures. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
export function defaultRoutingPolicy(): CurrentRoutingPolicy {
  return {
    schema_version: 1,
    enabled: true,
    platform: 'codex',
    runtime_version: '0.162.1',
    strong_model: 'gpt-6-luna',
    worker_models: ['gpt-6-luna', 'gpt-5.6-terra'],
    strong_effort: 'max',
    worker_effort: 'medium',
  };
}
export function priorDefaultRoutingPolicy(): LegacyRoutingPolicy {
  return {
    schema_version: 1,
    enabled: true,
    platform: 'codex',
    runtime_version: '0.162.1',
    strong_model: 'gpt-6.1-sol',
    worker_models: ['gpt-6-luna', 'gpt-5.6-terra'],
    strong_effort: 'high',
    worker_effort: 'medium',
  };
}
export function readRoutingPolicy(root: string): RoutingPolicy | null {
  const path = safePath(root, '.verythinker/routing.json');
  if (!existsSync(path)) return null;
  const value = JSON.parse(readFileSync(path, 'utf8'));
  if (
    canonicalJson(value) !== canonicalJson(defaultRoutingPolicy()) &&
    canonicalJson(value) !== canonicalJson(priorDefaultRoutingPolicy())
  )
    throw new Error(
      'Routing configuration differs from the approved strategic Luna/max policy and its exact Sol/high legacy default. Review the migration conflict before strict execution.',
    );
  return value as ApprovedRoutingPolicy;
}
export function ensureRoutingPolicy(root: string): RoutingPolicy {
  readConfig(root);
  return withOperationLock(root, 'routing-policy', () => {
    const existing = readRoutingPolicy(root);
    if (existing) return existing;
    const policy = defaultRoutingPolicy();
    atomicWrite(
      safePath(root, '.verythinker/routing.json'),
      JSON.stringify(policy, null, 2) + '\n',
    );
    return policy;
  });
}
export function requireRoutingPolicy(root: string): RoutingPolicy {
  const policy = readRoutingPolicy(root);
  if (!policy)
    throw new Error(
      'Strict native routing policy is missing; restore it before native operations.',
    );
  return policy;
}
export function roleModelPolicy(
  root: string,
  role: string,
): {
  role: NativeRole;
  models: string[];
  reasoning_effort: 'high' | 'max' | 'medium';
  strong: boolean;
} {
  const policy = requireRoutingPolicy(root);
  const mappings = readConfig(root).models;
  for (const [tier, expected] of [
    ['strong', policy.strong_model],
    ['economy', 'gpt-6-luna'],
    ['balanced', 'gpt-6-luna'],
  ] as const) {
    const mapping = mappings[tier];
    const codexModel =
      typeof mapping === 'string'
        ? mapping
        : mapping && typeof mapping === 'object'
          ? mapping.codex
          : null;
    if (codexModel && codexModel !== expected)
      throw new Error(
        `Authored Codex ${tier} model mapping conflicts with the approved strategic routing defaults. Review the migration candidate before dispatch.`,
      );
  }
  if (
    !(strongRoles as readonly string[]).includes(role) &&
    !(workerRoles as readonly string[]).includes(role)
  )
    throw new Error(`Unsupported native role: ${role}.`);
  const strong = (strongRoles as readonly string[]).includes(role);
  return {
    role: role as NativeRole,
    strong,
    models: strong ? [policy.strong_model] : [...policy.worker_models],
    reasoning_effort: strong ? policy.strong_effort : policy.worker_effort,
  };
}
export function routingConfigurationHashes(root: string): Record<string, string> {
  const paths = [
    '.verythinker/config.json',
    '.verythinker/routing.json',
    '.verythinker/native-runtime.lock.json',
    '.verythinker/tools.json',
    '.codex/config.toml',
  ];
  return Object.fromEntries(
    paths.map((path) => [
      path,
      existsSync(safePath(root, path)) ? hash(readFileSync(safePath(root, path))) : 'absent',
    ]),
  );
}
export function nativeReceiptPath(root: string, id: string): string {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id))
    throw new Error('Native invocation IDs must be bridge-issued UUIDs.');
  return safePath(root, `.verythinker/native/receipts/${id}.json`);
}
export function readInvocation(root: string, id: string): NativeReceipt {
  const value = JSON.parse(readFileSync(nativeReceiptPath(root, id), 'utf8')) as NativeReceipt;
  const { signature, ...unsigned } = value;
  if (
    value.schema_version !== 1 ||
    value.issuer !== 'verythinker-codex-app-server' ||
    value.id !== id ||
    value.project_id !== readConfig(root).project_id ||
    value.receipt_path !== `.verythinker/native/receipts/${id}.json` ||
    !/^[a-f0-9]{64}$/.test(value.key_id)
  )
    throw new Error('Native invocation receipt identity is invalid.');
  if (
    !existsSync(safePath(root, '.verythinker/native/trust.json')) ||
    !existsSync(safePath(root, `.verythinker/native/keys/${value.key_id}.pem`))
  )
    ensureNativeTrustFiles(root);
  const trusted = JSON.parse(
    readFileSync(safePath(root, '.verythinker/native/trust.json'), 'utf8'),
  ) as { keys: string[] };
  const key = readFileSync(safePath(root, `.verythinker/native/keys/${value.key_id}.pem`), 'utf8');
  if (
    !Array.isArray(trusted.keys) ||
    !trusted.keys.includes(value.key_id) ||
    hash(key) !== value.key_id ||
    typeof signature !== 'string' ||
    !verify(
      null,
      Buffer.from(canonicalJson(unsigned)),
      createPublicKey(key),
      Buffer.from(signature, 'base64'),
    )
  )
    throw new Error('Native invocation receipt signature or trusted public key is invalid.');
  return value;
}
export function invocationIsActive(receipt: NativeReceipt): boolean {
  return ['starting', 'running', 'waiting-native-permission'].includes(receipt.state);
}

/** Expected client sandbox follows the role's current assignment. A reviewer
 * receives write access only while producing its own assigned task; review
 * invocations and unbound reviewer sessions remain read-only. */
export function expectedNativeSandbox(
  root: string,
  receipt: NativeReceipt,
): 'readOnly' | 'workspaceWrite' {
  if (receipt.fast_grant?.stage === 'planner') return 'readOnly';
  if (receipt.role !== 'reviewer') return 'workspaceWrite';
  if (receipt.task_id) {
    try {
      const task = getRecord(root, receipt.task_id);
      if (task.meta.type === 'task' && task.meta.owner === 'reviewer') return 'workspaceWrite';
    } catch {
      // An unknown task cannot confer reviewer editing authority.
    }
  }
  return 'readOnly';
}
export function ownerIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}
export function routingBindingProblems(
  root: string,
  receipt: NativeReceipt,
  binding: RoutingBinding,
): string[] {
  const problems: string[] = [];
  if (binding.workflow_id !== undefined && receipt.workflow_id !== binding.workflow_id)
    problems.push('Native invocation belongs to a different workflow.');
  if (binding.task_id !== undefined && receipt.task_id !== binding.task_id) {
    let workflowPlanning = false;
    if (
      receipt.task_id === null &&
      receipt.workflow_id &&
      binding.workflow_id === receipt.workflow_id &&
      (strongRoles as readonly string[]).includes(receipt.role)
    ) {
      try {
        const task = getRecord(root, binding.task_id);
        workflowPlanning =
          task.meta.type === 'task' && task.meta.data.workflow_id === receipt.workflow_id;
      } catch {
        /* An unknown task cannot establish planning scope. */
      }
    }
    if (!workflowPlanning) problems.push('Native invocation belongs to a different task.');
  }
  return problems;
}
export function routingProblems(
  root: string,
  role: string,
  invocationId: string | undefined,
  binding: RoutingBinding = {},
): string[] {
  if (!readRoutingPolicy(root)) return [];
  const errors: string[] = [];
  if (!invocationId) return ['Strict routing requires a bridge-issued native invocation receipt.'];
  let receipt: NativeReceipt;
  try {
    receipt = readInvocation(root, invocationId);
  } catch (error) {
    return [`Native routing receipt cannot be verified: ${String(error)}.`];
  }
  const policy = roleModelPolicy(root, role);
  if (receipt.execution_mode !== 'native')
    errors.push(
      'Protocol fixture receipts cannot establish authenticated native routing or strict acceptance.',
    );
  if (
    receipt.runtime_integrity !==
      'sha512-NWZdi/kxyjv/8EUGFupziGU38YyleugZRM4JXgY5XFH7FUmaFA33NZS2Bmq0HPazf7S3jJQQWsZ/jAK9jsrV3Q==' ||
    !/^[a-f0-9]{64}$/.test(receipt.protocol_sha256)
  )
    errors.push(
      'Native runtime integrity or protocol provenance does not match the pinned runtime.',
    );
  try {
    const runtime = JSON.parse(
      readFileSync(safePath(root, '.verythinker/native-runtime.lock.json'), 'utf8'),
    );
    if (
      runtime.version !== receipt.client_version ||
      runtime.integrity !== receipt.runtime_integrity ||
      runtime.protocol_sha256 !== receipt.protocol_sha256
    )
      errors.push('Native invocation differs from the pinned runtime lock.');
  } catch {
    errors.push('Pinned native runtime lock is unavailable.');
  }
  if (receipt.role !== role && !hasFastResponsibility(root, receipt, role))
    errors.push('Native invocation belongs to a different engineering role.');
  if (receipt.fast_grant) errors.push(...fastGrantProblems(root, receipt, { historical: true }));
  errors.push(...routingBindingProblems(root, receipt, binding));
  if (
    !policy.models.includes(receipt.requested_model) ||
    receipt.confirmed_model !== receipt.requested_model
  )
    errors.push('The native client did not acknowledge the permitted requested model.');
  if (
    receipt.requested_model === 'gpt-5.6-terra' &&
    (receipt.fallback_evidence?.model !== 'gpt-6-luna' || !receipt.fallback_evidence.reason)
  )
    errors.push('Terra requires native evidence that Luna was unavailable.');
  if (
    receipt.confirmed_reasoning_effort !== policy.reasoning_effort ||
    receipt.reasoning_effort !== policy.reasoning_effort
  )
    errors.push('Native reasoning effort does not match the role policy.');
  if (receipt.requested_sandbox !== undefined && receipt.requested_sandbox !== null) {
    if (receipt.requested_sandbox !== 'readOnly' && receipt.requested_sandbox !== 'workspaceWrite')
      errors.push('Native receipt records an unsupported requested sandbox.');
    if (receipt.native_sandbox !== receipt.requested_sandbox)
      errors.push(
        `Native sandbox ${receipt.native_sandbox ?? 'unobserved'} does not match the requested policy (${receipt.requested_sandbox}).`,
      );
  } else if (
    (strongRoles as readonly string[]).includes(receipt.role) &&
    receipt.native_sandbox !== 'readOnly'
  ) {
    // Historical strong-role receipts were launched read-only. Keep those
    // receipts valid based on their signed client acknowledgment.
    errors.push('Strategic role lacks native acknowledgment of read-only shell access.');
  }
  if (
    receipt.client_version !== '0.162.1' ||
    !receipt.model_provider ||
    !receipt.native_thread_id ||
    !receipt.native_turn_id
  )
    errors.push('The native acknowledgment lacks version, provider, thread, or turn provenance.');
  if (receipt.reroutes.length)
    errors.push(
      'The native client rerouted this invocation; reassessment with a fresh invocation is required.',
    );
  if (receipt.routing_sha256 !== hash(canonicalJson(readRoutingPolicy(root))))
    errors.push('Routing policy changed after this invocation started.');
  if (
    canonicalJson(receipt.configuration_hashes) !== canonicalJson(routingConfigurationHashes(root))
  )
    errors.push('Relevant native configuration changed after this invocation started.');
  if (
    binding.require_completed !== false &&
    (receipt.state !== 'completed' || !receipt.inference_completed)
  )
    errors.push('Native inference has not completed successfully for this invocation.');
  if (binding.require_completed === false && !['running', 'completed'].includes(receipt.state))
    errors.push(`Native invocation is ${receipt.state}; work is blocked.`);
  if (invocationIsActive(receipt) && !ownerIsAlive(receipt.owner_pid))
    errors.push('Native invocation owner is absent; reconcile its transport before resuming.');
  return errors;
}
export function assertRouting(
  root: string,
  role: string,
  invocationId: string | undefined,
  binding: RoutingBinding = {},
): NativeReceipt | null {
  requireRoutingPolicy(root);
  const errors = routingProblems(root, role, invocationId, binding);
  if (errors.length) throw new Error(errors.join(' '));
  return invocationId && readRoutingPolicy(root) ? readInvocation(root, invocationId) : null;
}

/** Validate a signed terminal attempt for history only, never for successful execution gates. */
export function assertTerminalHistory(
  root: string,
  role: string,
  invocationId: string,
  binding: { workflow_id: string; task_id: string | null },
): NativeReceipt {
  const receipt = readInvocation(root, invocationId);
  if (
    receipt.role !== role ||
    receipt.workflow_id !== binding.workflow_id ||
    receipt.task_id !== binding.task_id
  )
    throw new Error(
      `Covered invocation ${invocationId} belongs to another role, workflow, or task.`,
    );
  if (!['completed', 'failed', 'interrupted', 'blocked', 'orphaned'].includes(receipt.state))
    throw new Error(
      `Covered invocation ${invocationId} is still ${receipt.state}; report it after it ends.`,
    );
  return receipt;
}
