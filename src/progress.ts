import { existsSync, readFileSync } from 'node:fs';
import { loadRecords, safePath } from './storage.js';
import { invocationIsActive, nativeReceiptPath, readInvocation, ownerIsAlive } from './routing.js';
import type { ProjectRecord } from './types.js';

export interface WorkflowProgress {
  schema_version: 1;
  workflow_id: string;
  phase: string | null;
  status: string;
  task_metadata: Array<{ id: string; owner: string; status: string }>;
  pending_continuations: Array<{ id: string; invocation_id?: string; received_at?: string }>;
  native_current_state: null | {
    invocation_id: string;
    state: string;
    role: string;
    updated_at: string;
    owner_present: boolean | null;
    observation: 'verified' | 'missing' | 'invalid';
  };
  validation: { status: 'not-evaluated'; acceptance_proof: false };
  blockers: string[];
  execution_policy?: string;
  fast_stage?: string;
}

function compact(root: string, records: ProjectRecord[], record: ProjectRecord): WorkflowProgress {
  const data = record.meta.data;
  const pending = (Array.isArray(data.pending_continuations)
    ? data.pending_continuations.filter((entry) => {
        if (!entry || typeof entry !== 'object' || typeof (entry as { id?: unknown }).id !== 'string')
          return false;
        const id = (entry as { id: string }).id;
        const applied = Array.isArray(data.applied_continuation_ids)
          ? data.applied_continuation_ids
          : [];
        const transfers = Array.isArray(data.continuation_transfers)
          ? data.continuation_transfers
          : [];
        return !applied.includes(id) && !transfers.some((item) => item?.continuation_id === id);
      })
    : []).flatMap((entry) => {
      if (!entry || typeof entry !== 'object' || typeof (entry as { id?: unknown }).id !== 'string') return [];
      const item = entry as { id: string; invocation_id?: unknown; received_at?: unknown };
      return [{
        id: item.id,
        ...(typeof item.invocation_id === 'string' ? { invocation_id: item.invocation_id } : {}),
        ...(typeof item.received_at === 'string' ? { received_at: item.received_at } : {}),
      }];
    });
  const taskIds = Array.isArray(data.task_ids) ? data.task_ids.filter((id): id is string => typeof id === 'string') : [];
  const tasks = taskIds.flatMap((id) => {
    const task = records.find((candidate) => candidate.meta.id === id);
    return task ? [{ id, owner: task.meta.owner, status: task.meta.status }] : [];
  });
  const invocation = data.execution_policy === 'fast'
    ? data.fast_current_invocation ?? data.native_manager_attempt_id ?? data.invocation_id
    : data.native_manager_attempt_id ?? data.invocation_id;
  let native: WorkflowProgress['native_current_state'] = null;
  if (typeof invocation === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(invocation)) {
    let observation: 'missing' | 'invalid' = 'missing';
    try {
      const path = nativeReceiptPath(root, invocation);
      if (!existsSync(path)) throw new Error('missing');
      const raw = JSON.parse(readFileSync(path, 'utf8')) as { key_id?: unknown };
      if (typeof raw.key_id !== 'string' || !existsSync(safePath(root, `.verythinker/native/trust.json`)) || !existsSync(safePath(root, `.verythinker/native/keys/${raw.key_id}.pem`)))
        throw new Error('missing');
      observation = 'invalid';
      const receipt = readInvocation(root, invocation);
      native = {
        invocation_id: receipt.id,
        state: receipt.state,
        role: receipt.role,
        updated_at: receipt.updated_at,
        owner_present: invocationIsActive(receipt) ? ownerIsAlive(receipt.owner_pid) : null,
        observation: 'verified',
      };
      if (invocationIsActive(receipt) && !ownerIsAlive(receipt.owner_pid)) native.observation = 'invalid';
    } catch {
      native = {
        invocation_id: invocation,
        state: 'unknown',
        role: 'unknown',
        updated_at: '',
        owner_present: null,
        observation,
      };
    }
  }
  const blockers: string[] = [];
  if (typeof data.native_manager_blocker === 'string' && data.native_manager_blocker) blockers.push(data.native_manager_blocker);
  if (typeof data.fast_blocker === 'string' && data.fast_blocker) blockers.push(data.fast_blocker);
  const disposition = data.publication_disposition;
  if (disposition && typeof disposition === 'object') {
    const d = disposition as { status?: unknown; blockers?: unknown };
    if (d.status === 'pending' || d.status === 'blocked') blockers.push('Publication is pending.');
    if (Array.isArray(d.blockers)) blockers.push(...d.blockers.filter((item): item is string => typeof item === 'string'));
  }
  if (native?.observation === 'missing') blockers.push('Native receipt is missing or its signature could not be verified.');
  if (native?.observation === 'invalid') blockers.push('Native receipt owner is absent; completion is not established.');
  return {
    schema_version: 1,
    workflow_id: record.meta.id,
    phase: typeof data.phase === 'string' ? data.phase : null,
    status: record.meta.status,
    task_metadata: tasks,
    pending_continuations: pending,
    native_current_state: native,
    validation: { status: 'not-evaluated', acceptance_proof: false },
    ...(typeof data.execution_policy === 'string' ? { execution_policy: data.execution_policy } : {}),
    ...(typeof data.fast_stage === 'string' ? { fast_stage: data.fast_stage } : {}),
    blockers: [...new Set(blockers)],
  };
}

export function workflowProgress(root: string, id?: string): WorkflowProgress | WorkflowProgress[] {
  const records = loadRecords(root);
  const workflows = records.filter((record) => record.meta.data.kind === 'manager-workflow');
  if (id) {
    const record = workflows.find((workflow) => workflow.meta.id === id);
    if (!record) throw new Error(`Manager workflow not found: ${id}`);
    return compact(root, records, record);
  }
  return workflows.map((record) => compact(root, records, record));
}
