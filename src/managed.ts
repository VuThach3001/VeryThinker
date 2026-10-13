import {
  beginWorkflow,
  bindManagerInvocation,
  workflowStatus,
  finishWorkflow,
  normalizeWorkflowInput,
  type WorkflowInput,
} from './manager.js';
import { nativeStatus, startNative, resumeNative, interruptNative, nativeResumeTarget } from './native.js';
import {
  invocationIsActive,
  ownerIsAlive,
  readInvocation,
  readRoutingPolicy,
  assertRouting,
  type NativeReceipt,
} from './routing.js';
import { getRecord, updateRecord, hash, safePath } from './storage.js';
import { existsSync, readFileSync } from 'node:fs';
import { resolveCapabilities, type ProviderId } from './tools.js';

export interface ManagedRunInput extends WorkflowInput {
  workflow_id?: string;
  providers?: ProviderId[];
  message?: string;
}
export interface ManagedRunResult {
  workflow: unknown;
  invocation?: NativeReceipt;
  blocker?: string;
  continuation?: { id?: string; status: 'queued' | 'not-applied'; observation: string };
}
/** Shared native intake/resumption used by the CLI and MCP; no model strings are accepted. */
export async function managedRun(
  root: string,
  input: ManagedRunInput,
  ownerToken?: string,
  execution: { start: typeof startNative; resume: typeof resumeNative } = {
    start: startNative,
    resume: resumeNative,
  },
): Promise<ManagedRunResult> {
  input = normalizeWorkflowInput(input);
  const parent = input.workflow_id
    ? getRecord(root, input.workflow_id)
    : beginWorkflow(root, input);
  if (parent.meta.type !== 'knowledge' || parent.meta.data.kind !== 'manager-workflow')
    throw new Error('Managed resumption requires an existing manager workflow.');
  const savedOriginals = parent.meta.data.original_requirements ?? [
    parent.meta.data.original_requirement,
  ];
  if (!Array.isArray(savedOriginals) || !savedOriginals.every((entry) => typeof entry === 'string'))
    throw new Error(
      'Saved manager requirements are invalid; recover the authoritative intake record.',
    );
  const originals: string[] = savedOriginals;
  if (input.workflow_id && (input.requirement !== undefined || input.requirements !== undefined)) {
    if (input.requirement !== undefined && input.requirements !== undefined)
      throw new Error('Provide requirement or requirements, rather than both.');
    const provided = (input.requirements ?? [input.requirement!]).map((item) => item.trim());
    if (JSON.stringify(provided) !== JSON.stringify(originals))
      throw new Error(
        'Resumption requirements differ from the saved increment. Submit a new requirement or record a reviewed change.',
      );
  }
  const current = workflowStatus(root, parent.meta.id) as { phase?: string };
  if (current.phase === 'completed')
    return {
      workflow: current,
      ...(input.message?.trim()
        ? {
            continuation: {
              status: 'not-applied',
              observation:
                'This increment is closed; start the changed intent as a new requirement.',
            },
          }
        : {}),
    };
  let previous: NativeReceipt | undefined;
  const priorId = parent.meta.data.native_manager_attempt_id ?? parent.meta.data.invocation_id;
  if (typeof priorId === 'string')
    try {
      previous = readInvocation(root, priorId);
    } catch {
      /* Legacy or intake placeholder identities do not establish native execution. */
    }
  if (previous && invocationIsActive(previous) && ownerIsAlive(previous.owner_pid)) {
    const message = input.message?.trim();
    if (!message) return { workflow: current, invocation: previous };
    if (message.length > 20000) throw new Error('A continuation must not exceed 20000 characters.');
    const continuationId = hash(`${input.request_id ?? parent.meta.id}\n${message}`);
    const pending = Array.isArray(parent.meta.data.pending_continuations)
      ? parent.meta.data.pending_continuations
      : [];
    if (!pending.some((entry) => entry.id === continuationId)) {
      if (pending.length >= 32)
        throw new Error('Incorporate the saved continuations before queuing more input.');
      updateRecord(root, parent.meta.id, {
        data: {
          pending_continuations: [
            ...pending,
            {
              id: continuationId,
              message,
              message_hash: hash(message),
              invocation_id: previous.id,
              received_at: new Date().toISOString(),
            },
          ],
        },
      });
    }
    return {
      workflow: workflowStatus(root, parent.meta.id),
      invocation: previous,
      continuation: {
        id: continuationId,
        status: 'queued',
        observation:
          'Saved for the existing coordinator; native inference has not yet acknowledged incorporation.',
      },
    };
  }
  const intentPath = safePath(root, `.verythinker/archive-intents/${hash(parent.meta.id)}.json`);
  const pendingIntent = existsSync(intentPath)
    ? typeof JSON.parse(readFileSync(intentPath, 'utf8')).snapshot_id === 'string'
    : false;
  const handled = new Set([
    ...(Array.isArray(parent.meta.data.applied_continuation_ids)
      ? parent.meta.data.applied_continuation_ids
      : []),
    ...(Array.isArray(parent.meta.data.continuation_transfers)
      ? parent.meta.data.continuation_transfers.map((entry) => entry.continuation_id)
      : []),
  ]);
  const continuations = (
    Array.isArray(parent.meta.data.pending_continuations)
      ? parent.meta.data.pending_continuations
      : []
  ).filter((entry) => typeof entry.id === 'string' && !handled.has(entry.id));
  const hasContinuation = continuations.length > 0 || Boolean(input.message?.trim());
  if (pendingIntent && hasContinuation && previous?.state === 'completed') {
    const messages = [
      ...new Set([
        ...continuations.map((entry) => entry.message),
        ...(input.message?.trim() ? [input.message.trim()] : []),
      ]),
    ];
    const nextRequest = `continuation-${hash(`${parent.meta.id}\n${JSON.stringify(messages)}`)}`;
    const next = beginWorkflow(root, {
      requirement: `Revise the previously frozen engineering outcome. Prior requirements provide baseline context and are superseded where these later user changes conflict.\nPrior requirements:\n${JSON.stringify(originals)}\nAuthoritative user changes:\n${JSON.stringify(messages)}\nReuse valid existing outputs and verify the affected changes.`,
      request_id: nextRequest,
      title: 'Follow-up to a frozen engineering increment',
      change_type: input.change_type ?? 'fix',
    });
    if (next.meta.data.prior_workflow_id !== parent.meta.id)
      updateRecord(root, next.meta.id, { data: { prior_workflow_id: parent.meta.id } });
    const transfers = Array.isArray(parent.meta.data.continuation_transfers)
      ? parent.meta.data.continuation_transfers
      : [];
    const fresh = continuations.filter(
      (entry) => !transfers.some((prior) => prior.continuation_id === entry.id),
    );
    if (fresh.length)
      updateRecord(root, parent.meta.id, {
        data: {
          continuation_transfers: [
            ...transfers,
            ...fresh.map((entry) => ({ continuation_id: entry.id, workflow_id: next.meta.id })),
          ],
        },
      });
    return managedRun(
      root,
      {
        workflow_id: next.meta.id,
        request_id: nextRequest,
        message:
          'Reassess the saved follow-ups against the prior frozen increment; preserve its snapshot and reuse valid engineering outputs.',
      },
      ownerToken,
      execution,
    );
  }
  if (pendingIntent && previous?.state !== 'completed')
    return {
      workflow: current,
      blocker:
        'A frozen archive snapshot is pending, but its original native coordinator has no completed receipt. Preserve the snapshot and resolve or reassess that coordinator before publication recovery.',
    };
  if (
    previous?.state === 'completed' &&
    !hasContinuation &&
    (['awaiting-native-completion', 'completed-with-blockers'].includes(current.phase ?? '') ||
      ['awaiting-native-completion', 'completed-with-blockers'].includes(
        String(parent.meta.data.phase),
      ) ||
      pendingIntent)
  ) {
    try {
      assertRouting(root, 'manager', previous.id, { workflow_id: parent.meta.id });
      const result = finishWorkflow(root, parent.meta.id, {}) as {
        publication_blockers?: string[];
      };
      return {
        workflow: result,
        ...(result.publication_blockers?.length
          ? { blocker: result.publication_blockers.join('\n') }
          : {}),
      };
    } catch (error) {
      // Frozen snapshots retain the original coordinator and closure records.
      // Reassessment is explicit; a retry must not launch a replacement turn.
      return {
        workflow: workflowStatus(root, parent.meta.id),
        blocker: error instanceof Error ? error.message : String(error),
      };
    }
  }
  try {
    if (!readRoutingPolicy(root))
      throw new Error('Strict native routing must be installed before managed execution.');
    for (const provider of input.providers ?? [])
      await resolveCapabilities(root, {
        role: provider === 'playwright' ? 'developer' : 'manager',
        providers: [provider],
      });
    // Reconcile only absent local owners. A still-live transport or native refusal
    // remains a blocker, never an excuse to duplicate its outstanding work.
    for (const receipt of nativeStatus(root) as NativeReceipt[])
      if (
        receipt.workflow_id === parent.meta.id &&
        invocationIsActive(receipt) &&
        !ownerIsAlive(receipt.owner_pid)
      )
        await interruptNative(root, receipt.id);
    const prompt = `Continue the existing VeryThinker workflow ${parent.meta.id}. Interpret the saved requirements, obtain scoped specialist contributions, establish measurable requirements and independently reviewed architecture/check definitions, delegate bounded implementation and check execution, collect Cornell documentation, perform independent review and acceptance, publish the qualified project archive and report final decisions. Do not create another workflow or recursively call manager_run. Use project_read and approved core/recipe operations; installed instructions are preloaded. Use capability_describe/project_status for discovery; never call capability_resolve with empty provider lists. Resolve an external provider only when it is actually applicable. Original requirement batch:\n${JSON.stringify(originals, null, 2)}${input.message ? `\nUser clarification or continuation:\n${input.message}` : ''}`;
    const continuationText = continuations.length
      ? `\nSaved user continuations to incorporate and mark applied:\n${JSON.stringify(continuations, null, 2)}`
      : '';
    const requestId = input.request_id ?? `manager-${parent.meta.id}-${previous?.id ?? 'initial'}`;
    const receipt = previous && nativeResumeTarget(root, previous)
      ? await execution.resume(
          root,
          previous.id,
          { prompt: prompt + continuationText, request_id: requestId },
          ownerToken,
        )
      : await execution.start(
          root,
          {
            role: 'manager',
            workflow_id: parent.meta.id,
            prompt: prompt + continuationText,
            request_id: requestId,
          },
          ownerToken,
        );
    updateRecord(root, parent.meta.id, {
      data: {
        native_manager_attempt_id: receipt.id,
        native_manager_blocker: receipt.state === 'blocked' ? receipt.error : null,
      },
    });
    if (receipt.state === 'running' || receipt.state === 'completed')
      bindManagerInvocation(root, parent.meta.id, receipt.id);
    return {
      workflow: workflowStatus(root, parent.meta.id),
      invocation: receipt,
      ...(receipt.state === 'blocked'
        ? { blocker: receipt.error ?? 'Native coordinator could not start.' }
        : {}),
    };
  } catch (error) {
    const blocker = error instanceof Error ? error.message : String(error);
    updateRecord(root, parent.meta.id, { data: { native_manager_blocker: blocker } });
    return { workflow: workflowStatus(root, parent.meta.id), blocker };
  }
}
