import {
  beginWorkflow,
  bindManagerInvocation,
  workflowStatus,
  finishWorkflow,
  normalizeWorkflowInput,
  type WorkflowInput,
} from './manager.js';
import { nativeStatus, startNative, resumeNative, interruptNative } from './native.js';
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
}
/** Shared native intake/resumption used by the CLI and MCP; no model strings are accepted. */
export async function managedRun(
  root: string,
  input: ManagedRunInput,
  ownerToken?: string,
): Promise<ManagedRunResult> {
  input = normalizeWorkflowInput(input);
  const parent = input.workflow_id
    ? getRecord(root, input.workflow_id)
    : beginWorkflow(root, input);
  if (parent.meta.type !== 'knowledge' || parent.meta.data.kind !== 'manager-workflow')
    throw new Error('Managed resumption requires an existing manager workflow.');
  const originals = parent.meta.data.original_requirements ?? [
    parent.meta.data.original_requirement,
  ];
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
  if (current.phase === 'completed') return { workflow: current };
  let previous: NativeReceipt | undefined;
  const priorId = parent.meta.data.native_manager_attempt_id ?? parent.meta.data.invocation_id;
  if (typeof priorId === 'string')
    try {
      previous = readInvocation(root, priorId);
    } catch {
      /* Legacy or intake placeholder identities do not establish native execution. */
    }
  if (previous && invocationIsActive(previous) && ownerIsAlive(previous.owner_pid))
    return { workflow: current, invocation: previous };
  const intentPath = safePath(root, `.verythinker/archive-intents/${hash(parent.meta.id)}.json`);
  const pendingIntent = existsSync(intentPath)
    ? typeof JSON.parse(readFileSync(intentPath, 'utf8')).snapshot_id === 'string'
    : false;
  if (
    ['awaiting-native-completion', 'completed-with-blockers'].includes(current.phase ?? '') ||
    ['awaiting-native-completion', 'completed-with-blockers'].includes(
      String(parent.meta.data.phase),
    ) ||
    pendingIntent
  ) {
    try {
      if (!previous || previous.state !== 'completed')
        throw new Error(
          'Saved completion requires its successfully completed native coordinator before publication recovery.',
        );
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
    const requestId = input.request_id ?? `manager-${parent.meta.id}-${previous?.id ?? 'initial'}`;
    const receipt = previous?.native_thread_id
      ? await resumeNative(root, previous.id, { prompt, request_id: requestId }, ownerToken)
      : await startNative(
          root,
          { role: 'manager', workflow_id: parent.meta.id, prompt, request_id: requestId },
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
