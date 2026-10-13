import { randomUUID } from 'node:crypto';
import { getRecord, hash, loadRecords, now } from './storage.js';
import {
  canonicalJson,
  readInvocation,
  readRoutingPolicy,
  roleModelPolicy,
  routingConfigurationHashes,
  type FastStageGrant,
  type NativeReceipt,
} from './routing.js';
import {
  validateFastSelection as validatePolicySelection,
  type FastSelection,
} from './fast-policy.js';
import type { RoleCapabilities } from './tools.js';
import { assertFastSelectionSeal } from './native.js';
import { executionScope, requirementScope } from './engineering.js';

const plannerOperations = [
  'project_status', 'project_read', 'assignment_report', 'record_list', 'record_get',
  'record_trace', 'verify', 'task_context', 'memory_search', 'manager_status', 'manager_progress',
  'native_status', 'native_wait', 'capability_describe', 'recipe_list', 'recipe_resolve',
  'note_validate', 'pack_list', 'pack_suggest', 'record_create', 'record_update', 'fast_plan_submit',
];
const producerOperations = [
  'project_status', 'project_read', 'assignment_report', 'record_list', 'record_get',
  'record_trace', 'verify', 'task_context', 'memory_search', 'manager_status', 'manager_progress',
  'native_status', 'native_wait', 'capability_describe', 'recipe_list', 'recipe_resolve',
  'note_validate', 'pack_list', 'pack_suggest', 'task_start', 'task_resume', 'task_submit',
  'note_create', 'recipe_run', 'task_file_write',
  'check_run', 'check_inspect',
];

export type FastStage = FastStageGrant['stage'];
export interface FastGrantTarget {
  operation?: string;
  workflow_id?: string;
  task_id?: string;
  path?: string;
  paths?: string[];
  record_id?: string;
  record_type?: string;
  record_owner?: string;
  links?: unknown;
  check_id?: string;
  record_data?: unknown;
  task_ids?: string[];
  providers?: string[];
  provider?: string;
  recipe_instance_id?: string;
}

function digest(value: unknown): string {
  return hash(canonicalJson(value));
}
function selectionOfWorkflow(root: string, workflowId: string): FastSelection {
  const workflow = getRecord(root, workflowId);
  if (workflow.meta.data.kind !== 'manager-workflow')
    throw new Error('Fast stage grant requires its managed workflow record.');
  const selection = workflow.meta.data.execution_policy_selection as FastSelection | undefined;
  if (!selection || selection.workflow_id !== workflowId)
    throw new Error('Fast workflow has no matching persisted execution policy selection.');
  validatePolicySelection(root, selection);
  return selection;
}

/** Validate policy material against the persisted workflow selection, not an agent-supplied copy. */
export function validateFastSelection(
  root: string,
  selection: FastSelection,
  options: { baseline?: boolean } = {},
): void {
  if (!selection || typeof selection.workflow_id !== 'string')
    throw new Error('Fast policy selection is missing its workflow binding.');
  const stored = selectionOfWorkflow(root, selection.workflow_id);
  if (canonicalJson(stored) !== canonicalJson(selection))
    throw new Error('Fast policy selection differs from the current persisted workflow selection.');
  validatePolicySelection(root, stored, options);
}

function taskPlan(root: string, taskId: string): { sha256: string; checks: string[] } {
  const task = getRecord(root, taskId);
  if (task.meta.type !== 'task') throw new Error('Fast producer requires an assigned task.');
  const requirements = [
    ...new Set([
      ...(Array.isArray(task.meta.data.requirements)
        ? task.meta.data.requirements.filter((v): v is string => typeof v === 'string')
        : []),
      ...task.meta.links.filter((link) => link.type === 'satisfies').map((link) => link.target),
    ]),
  ];
  if (!requirements.length) throw new Error('Fast producer task has no requirement scope.');
  const all = loadRecords(root);
  const executionIds = new Set([
    ...executionScope(all, task),
    ...requirementScope(all, requirements),
    ...task.meta.links.filter((link) => link.type === 'implements').map((link) => link.target),
  ]);
  const checks = all
    .filter((record) => record.meta.type === 'check' && record.meta.status !== 'superseded')
    .filter((record) => record.meta.links.some((link) =>
      link.type === 'verifies' && executionIds.has(link.target),
    ))
    .map((record) => record.meta.id)
    .sort();
  if (!checks.length) throw new Error('Fast producer task has no protected reviewed checks.');
  const selection = selectionOfWorkflow(root, task.meta.data.workflow_id as string);
  const checkRecords = all.filter((record) => checks.includes(record.meta.id));
  const missingProtectedPaths = Object.keys(selection.protected_inputs).filter((path) =>
    !checkRecords.some((check) => {
      const oraclePaths = stringArray(check.meta.data.oracle_paths);
      const baselinePaths = stringArray(check.meta.data.baseline_paths);
      return oraclePaths.includes(path) || baselinePaths.includes(path);
    }),
  );
  if (missingProtectedPaths.length)
    throw new Error(`Fast producer plan has no applicable check oracle or baseline for protected input(s): ${missingProtectedPaths.join(', ')}.`);
  const requirementsAndContracts = all
    .filter((record) =>
      (record.meta.type === 'requirement' && executionIds.has(record.meta.id)) ||
      (record.meta.type === 'design' && record.meta.status !== 'superseded' && executionIds.has(record.meta.id)) ||
      checks.includes(record.meta.id),
    )
    .sort((a, b) => a.meta.id.localeCompare(b.meta.id))
    .map((record) => ({
      meta: {
        schema_version: record.meta.schema_version,
        id: record.meta.id,
        type: record.meta.type,
        title: record.meta.title,
        owner: record.meta.owner,
        status: record.meta.status,
        links: record.meta.links,
        data: record.meta.data,
      },
      body: record.body,
    }));
  // Only known execution bookkeeping is excluded. All other fields, including future fields,
  // remain semantic and therefore invalidate an approved plan when they change.
  const executionOnlyData = new Set([
    'invocation_id', 'prior_invocation_ids', 'requested_model', 'confirmed_model',
    'blocked_reason', 'resumed_at', 'attempts', 'escalation_required',
    'escalation_reason', 'escalation_attempt', 'escalation_feedback_sha256',
    'escalation_invocation_id', 'repair_requested_at', 'submission', 'workspace_writes',
    'output_paths',
  ]);
  const semanticTask = {
    meta: {
      schema_version: task.meta.schema_version,
      id: task.meta.id,
      type: task.meta.type,
      title: task.meta.title,
      owner: task.meta.owner,
      links: task.meta.links,
      data: Object.fromEntries(Object.entries(task.meta.data).filter(([key]) => !executionOnlyData.has(key))),
    },
    body: task.body,
  };
  return { sha256: digest({ semanticTask, requirementsAndContracts }), checks };
}

/** Stable semantic fingerprint shared by the planner freeze and each production grant. */
export function fastPlanFingerprint(root: string, workflowId: string, requestedTaskIds?: string[]): string {
  const workflow = getRecord(root, workflowId);
  if (workflow.meta.data.kind !== 'manager-workflow') throw new Error('Fast plan fingerprint requires a managed workflow.');
  const taskIds = requestedTaskIds
    ? [...requestedTaskIds].sort()
    : Array.isArray(workflow.meta.data.task_ids)
      ? workflow.meta.data.task_ids.filter((value): value is string => typeof value === 'string').sort()
      : [];
  if (!taskIds.length) throw new Error('Fast plan fingerprint requires frozen task IDs.');
  return digest({ workflow_id: workflowId, tasks: taskIds.map((id) => ({ id, plan: taskPlan(root, id).sha256 })) });
}

function issueGrant(
  root: string,
  receipt: NativeReceipt,
  stage: FastStage,
  selection: FastSelection,
  taskId: string | null,
): FastStageGrant {
  const issuedAt = now();
  const paths = stage === 'producer'
    ? stringArray(getRecord(root, taskId!).meta.data.allowed_paths).slice().sort()
    : [];
  const operationList = stage === 'planner' ? plannerOperations : producerOperations;
  const planSha = stage === 'producer' ? fastPlanFingerprint(root, selection.workflow_id) : digest({
    workflow_id: receipt.workflow_id,
    selection_sha256: digest(selection),
    stage: 'planning',
  });
  return {
    schema_version: 1,
    grant_id: randomUUID(),
    stage,
    phase: stage === 'planner' ? 'planning' : 'production',
    invocation_id: receipt.id,
    owner_pid: receipt.owner_pid,
    workflow_id: selection.workflow_id,
    task_id: taskId,
    allowed_operations: [...operationList],
    allowed_paths: paths,
    protected_check_ids: stage === 'producer' ? taskPlan(root, taskId!).checks : [],
    configuration_hashes: routingConfigurationHashes(root),
    selection_sha256: digest(selection),
    plan_sha256: planSha,
    issued_at: issuedAt,
    expires_at: new Date(Date.parse(issuedAt) + 30 * 60 * 1000).toISOString(),
  };
}

function malformedGrant(grant: FastStageGrant): string[] {
  const problems: string[] = [];
  if (!grant || grant.schema_version !== 1 || !['planner', 'producer'].includes(grant.stage))
    return ['Fast stage grant schema or stage is invalid.'];
  const expectedOps = grant.stage === 'planner' ? plannerOperations : producerOperations;
  if (canonicalJson(grant.allowed_operations) !== canonicalJson(expectedOps))
    problems.push('Fast stage grant operation contract was changed.');
  if (grant.phase !== (grant.stage === 'planner' ? 'planning' : 'production'))
    problems.push('Fast stage grant phase does not match its fixed stage contract.');
  if (!grant.grant_id || !grant.invocation_id || !grant.workflow_id ||
      !/^[a-f0-9]{64}$/.test(grant.selection_sha256) ||
      !/^[a-f0-9]{64}$/.test(grant.plan_sha256))
    problems.push('Fast stage grant identity or bound hashes are invalid.');
  if (grant.stage === 'planner' && (grant.task_id !== null || grant.allowed_paths.length || grant.protected_check_ids.length))
    problems.push('Planner grant exceeds workflow planning scope.');
  if (grant.stage === 'producer' && (!grant.task_id || !grant.allowed_paths.length || !grant.protected_check_ids.length))
    problems.push('Producer grant lacks exact task, editable paths, or protected checks.');
  if (new Set(grant.allowed_paths).size !== grant.allowed_paths.length ||
      new Set(grant.protected_check_ids).size !== grant.protected_check_ids.length)
    problems.push('Fast stage grant contains duplicate path or check identities.');
  return problems;
}

/** Verify the signed, persisted fast authority. Historical checks may omit editable baseline comparison. */
export function fastGrantProblems(
  root: string,
  receipt: NativeReceipt,
  options: { phase?: 'planning' | 'production'; target?: FastGrantTarget; historical?: boolean } = {},
): string[] {
  const grant = receipt.fast_grant;
  if (!grant) return ['Invocation has no Fast stage grant.'];
  const problems = malformedGrant(grant);
  if (receipt.execution_mode !== 'native') return [...problems, 'Protocol fixtures cannot establish Fast authority.'];
  try {
    const signed = readInvocation(root, receipt.id);
    const mutableBridgeFields = (value: NativeReceipt) => {
      const { output: _output, updated_at: _updatedAt, signature: _signature, ...identity } = value;
      return identity;
    };
    if (canonicalJson(mutableBridgeFields(signed)) !== canonicalJson(mutableBridgeFields(receipt)))
      problems.push('Fast authority input differs from its signed persisted native receipt.');
  } catch (error) {
    problems.push(`Fast authority receipt cannot be verified: ${error instanceof Error ? error.message : String(error)}.`);
  }
  if (grant.invocation_id !== receipt.id || grant.owner_pid !== receipt.owner_pid ||
      grant.workflow_id !== receipt.workflow_id || grant.task_id !== receipt.task_id)
    problems.push('Fast grant is bound to another invocation, owner, workflow, or task.');
  if (receipt.role !== (grant.stage === 'planner' ? 'manager' : 'developer'))
    problems.push('Fast grant stage does not match the native base role.');
  if (Date.parse(grant.expires_at) <= Date.now() && !options.historical)
    problems.push('Fast stage grant has expired.');
  if (options.phase && grant.phase !== options.phase)
    problems.push('Fast stage grant is outside its authorized phase.');
  if (canonicalJson(grant.configuration_hashes) !== canonicalJson(routingConfigurationHashes(root)))
    problems.push('Relevant native configuration changed after Fast grant issuance.');
  try {
    const selection = selectionOfWorkflow(root, grant.workflow_id);
    if (digest(selection) !== grant.selection_sha256)
      problems.push('Persisted Fast selection changed after grant issuance.');
    validatePolicySelection(root, selection, { baseline: false });
    if (grant.stage === 'producer') {
      const task = getRecord(root, grant.task_id!);
      if (task.meta.data.workflow_id !== grant.workflow_id)
        problems.push('Fast producer task belongs to a different workflow.');
      const freshPlan = taskPlan(root, grant.task_id!);
      if (canonicalJson(stringArray(task.meta.data.allowed_paths).slice().sort()) !== canonicalJson(grant.allowed_paths))
        problems.push('Fast producer editable paths changed after grant issuance.');
      if (canonicalJson(grant.protected_check_ids) !== canonicalJson(freshPlan.checks))
        problems.push('Fast producer protected check scope changed after approval.');
      if (!options.historical && grant.plan_sha256 !== fastPlanFingerprint(root, grant.workflow_id))
        problems.push('Fast producer plan changed after approval.');
    }
    if (options.target) problems.push(...targetProblems(root, grant, options.target));
  } catch (error) {
    problems.push(`Fast grant inputs are no longer valid: ${error instanceof Error ? error.message : String(error)}.`);
  }
  return problems;
}

function targetProblems(root: string, grant: FastStageGrant, target: FastGrantTarget): string[] {
  const errors: string[] = [];
  if (target.workflow_id !== undefined && target.workflow_id !== grant.workflow_id)
    errors.push('Fast stage operation escapes its workflow.');
  if (grant.task_id && target.task_id !== undefined && target.task_id !== grant.task_id)
    errors.push('Fast stage operation escapes its assigned task.');
  if (grant.stage === 'planner') {
    if (target.path && target.operation !== 'project_read') errors.push('Fast planner cannot write project files.');
    if (target.operation === 'record_create') {
      if (!target.record_type || !['requirement', 'design', 'check', 'task'].includes(target.record_type))
        errors.push('Fast planner may only author requirement, design, or check records.');
      const data = target.record_data as Record<string, unknown> | undefined;
      if (!data || !recordDataBelongsWorkflow(root, target.record_type!, data, target.links, grant.workflow_id))
        errors.push('Fast planning records must bind directly to the selected workflow.');
      if (target.record_type === 'task' && data) {
        const selection = selectionOfWorkflow(root, grant.workflow_id);
        if (target.record_owner !== 'developer') errors.push('Fast planning task must retain the standard developer owner.');
        const allowed = stringArray(data.allowed_paths);
        const docs = stringArray(data.documentation_paths);
        if (!allowed.length || allowed.some((path) => !selection.editable_paths.includes(path)))
          errors.push('Fast task allowed_paths must be a nonempty subset of selected editable_paths.');
        if (docs.some((path) => !allowed.includes(path) || Object.hasOwn(selection.protected_inputs, path)))
          errors.push('Fast task documentation_paths must stay in editable, unprotected task scope.');
        const linked = stringArray(data.requirements);
        const workflow = getRecord(root, grant.workflow_id);
        const required = stringArray(workflow.meta.data.requirement_ids);
        if (!linked.length || linked.some((id) => !required.includes(id)))
          errors.push('Fast planning task must reference only this workflow\'s established requirements.');
        const existingTasks = loadRecords(root).filter((record) =>
          record.meta.type === 'task' && record.meta.data.workflow_id === grant.workflow_id &&
          record.meta.status !== 'superseded',
        );
        if (existingTasks.length) errors.push('Fast planner may create only one bounded task for this workflow.');
      }
    }
    if (target.operation === 'fast_plan_submit') {
      const workflow = getRecord(root, grant.workflow_id);
      const tasks = loadRecords(root).filter((record) =>
        record.meta.type === 'task' && record.meta.data.workflow_id === grant.workflow_id &&
        record.meta.status !== 'superseded',
      ).map((record) => record.meta.id).sort();
      if (workflow.meta.data.fast_stage !== 'planning' || tasks.length !== 1 ||
          canonicalJson(target.task_ids?.slice().sort() ?? []) !== canonicalJson(tasks))
        errors.push('Fast plan submission must freeze the one current workflow task while planning is active.');
      else fastPlanFingerprint(root, grant.workflow_id, tasks);
    }
    if (target.record_id && target.operation === 'record_update') {
      try {
        const record = getRecord(root, target.record_id);
        if (!['requirement', 'design', 'check', 'task'].includes(record.meta.type) ||
            !recordBelongsWorkflow(root, record, grant.workflow_id))
          errors.push('Fast planner cannot update a record outside its workflow planning scope.');
        if (record.meta.type === 'task') {
          const patch = target.record_data as Record<string, unknown> | undefined;
          const allowedKeys = new Set(['allowed_paths', 'documentation_paths', 'documentation_required', 'acceptance_criteria', 'requirements', 'dependencies', 'workflow_id', 'outputs']);
          if (!patch || Object.keys(patch).some((key) => !allowedKeys.has(key)))
            errors.push('Fast planner task clarification includes a protected or unsupported field.');
          if (patch?.allowed_paths) {
            const selection = selectionOfWorkflow(root, grant.workflow_id);
            const allowed = stringArray(patch.allowed_paths);
            if (!allowed.length || allowed.some((path) => !selection.editable_paths.includes(path)))
              errors.push('Fast planner task paths exceed the selected editable scope.');
          }
        }
      } catch {
        errors.push('Fast planner update target cannot be verified.');
      }
    }
  } else {
    if (target.operation === 'task_start' || target.operation === 'task_resume') {
      if (target.workflow_id !== grant.workflow_id || target.task_id !== grant.task_id)
        errors.push('Fast producer task lifecycle operations require its exact assigned workflow and task.');
    }
    if (target.path && target.operation !== 'project_read' && !grant.allowed_paths.includes(target.path))
      errors.push(`Fast producer path is outside its exact editable scope: ${target.path}`);
    if (target.check_id && !grant.protected_check_ids.includes(target.check_id))
      errors.push('Fast producer cannot execute or inspect an unapproved check.');
    if (target.operation === 'task_file_write' || target.operation === 'note_create') {
      const paths = target.paths ?? (target.path ? [target.path] : []);
      if (!paths.length || paths.some((path) => !grant.allowed_paths.includes(path)))
        errors.push('Fast producer file operations require an exact approved path.');
    }
    if (['record_create', 'record_update', 'manager_discuss'].includes(target.operation ?? ''))
      errors.push('Fast producer cannot author planning records or strategic discussion.');
    if (target.operation === 'capability_resolve' || target.operation === 'capability_invoke') {
      try {
        const task = getRecord(root, grant.task_id!);
        const required = stringArray(task.meta.data.required_tools);
        const selected = target.operation === 'capability_resolve'
          ? (target.providers ?? [])
          : (target.provider ? [target.provider] : []);
        if (!selected.length || selected.some((provider) => !required.includes(provider)))
          errors.push('Fast producer capabilities are limited to providers required by its exact task.');
      } catch { errors.push('Fast producer capability scope cannot be verified.'); }
    }
    if (target.operation === 'recipe_run') {
      try {
        const selection = selectionOfWorkflow(root, grant.workflow_id);
        const instance = getRecord(root, target.recipe_instance_id ?? target.record_id ?? '');
        if (instance.meta.data.kind !== 'recipe-instance' ||
            instance.meta.data.task_id !== grant.task_id ||
            instance.meta.data.recipe_id !== selection.recipe.id ||
            instance.meta.data.recipe_version !== selection.recipe.version)
          errors.push('Fast producer may run only its task-bound selected recipe instance.');
      } catch { errors.push('Fast producer recipe instance cannot be verified.'); }
    }
  }
  return errors;
}

function recordBelongsWorkflow(
  root: string,
  record: ReturnType<typeof getRecord>,
  workflowId: string,
): boolean {
  if (record.meta.data.workflow_id === workflowId || record.meta.data.intake_workflow_id === workflowId)
    return true;
  return record.meta.links.some((link) => {
    try {
      const parent = getRecord(root, link.target);
      return parent.meta.type === 'requirement' &&
        (parent.meta.data.workflow_id === workflowId || parent.meta.data.intake_workflow_id === workflowId);
    } catch { return false; }
  });
}

function recordDataBelongsWorkflow(
  root: string,
  type: string,
  data: Record<string, unknown>,
  rawLinks: unknown,
  workflowId: string,
): boolean {
  if (data.workflow_id === workflowId || data.intake_workflow_id === workflowId) return true;
  if (!['design', 'check'].includes(type) || !Array.isArray(rawLinks)) return false;
  return rawLinks.some((value) => {
    const link = value as { type?: unknown; target?: unknown };
    if (!['satisfies', 'verifies', 'depends-on', 'references'].includes(String(link?.type)) || typeof link?.target !== 'string') return false;
    try {
      const target = getRecord(root, link.target);
      return target.meta.type === 'requirement' &&
        (target.meta.data.workflow_id === workflowId || target.meta.data.intake_workflow_id === workflowId);
    } catch { return false; }
  });
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : [];
}

export function authorizeFastOperation(
  root: string,
  receipt: NativeReceipt,
  operation: string,
  target: FastGrantTarget = {},
): RoleCapabilities {
  const grant = receipt.fast_grant;
  if (!grant) throw new Error('Invocation has no Fast stage grant.');
  const scopedTarget = { ...target, operation };
  const problems = fastGrantProblems(root, receipt, { phase: grant.phase, target: scopedTarget });
  if (problems.length) throw new Error(problems.join(' '));
  if (!grant.allowed_operations.includes(operation))
    throw new Error(`Fast ${grant.stage} grant cannot use ${operation}.`);
  const workflow = getRecord(root, grant.workflow_id);
  const workflowStage = workflow.meta.data.fast_stage;
  const readOrReturnOps = new Set([
    'project_status', 'project_read', 'record_list', 'record_get', 'record_trace', 'verify',
    'task_context', 'memory_search', 'manager_status', 'manager_progress', 'native_status',
    'native_wait', 'capability_describe', 'recipe_list', 'recipe_resolve', 'note_validate',
    'pack_list', 'pack_suggest', 'assignment_report',
  ]);
  if (grant.stage === 'planner' && !readOrReturnOps.has(operation) && workflowStage !== 'planning')
    throw new Error('Fast planner mutating authority has ended; planning is frozen for independent review.');
  if (grant.stage === 'producer' && !readOrReturnOps.has(operation) && workflowStage !== 'production')
    throw new Error('Fast producer mutating authority is outside the active production phase.');
  if (grant.stage === 'planner' && ['record_create', 'record_update'].includes(operation)) {
    if (operation === 'record_create' && target.record_type && !['requirement', 'design', 'check', 'task'].includes(target.record_type))
      throw new Error('Fast planner may only create requirement, design, check, or scoped task records.');
    if (operation === 'record_update' && target.record_id) {
      const record = getRecord(root, target.record_id);
      if (!['requirement', 'design', 'check', 'task'].includes(record.meta.type))
        throw new Error('Fast planner may only update requirement, design, or check records.');
    }
  }
  if (grant.stage === 'producer' && operation !== 'project_read' && target.path && !grant.allowed_paths.includes(target.path))
    throw new Error(`Fast producer path is outside its exact editable scope: ${target.path}`);
  if (grant.stage === 'producer' && ['check_run', 'check_inspect'].includes(operation)) {
    if (!target.check_id || !grant.protected_check_ids.includes(target.check_id))
      throw new Error('Fast producer can only execute or inspect protected checks assigned to its task.');
  }
  if (grant.stage === 'producer' && ['record_create', 'record_update', 'manager_discuss'].includes(operation))
    throw new Error('Fast producer cannot author planning records or strategic discussion.');
  if (grant.stage === 'producer' && operation === 'recipe_run') {
    const selection = selectionOfWorkflow(root, grant.workflow_id);
    const instance = getRecord(root, target.recipe_instance_id ?? target.record_id ?? '');
    if (instance.meta.data.kind !== 'recipe-instance' || instance.meta.data.task_id !== grant.task_id ||
        instance.meta.data.recipe_id !== selection.recipe.id || instance.meta.data.recipe_version !== selection.recipe.version)
      throw new Error('Fast producer may run only its task-bound selected recipe instance.');
  }
  return fastCapabilities(root, receipt);
}

export function fastCapabilities(root: string, receipt: NativeReceipt): RoleCapabilities {
  const grant = receipt.fast_grant;
  if (!grant) throw new Error('Invocation has no Fast stage grant.');
  const problems = fastGrantProblems(root, receipt, { phase: grant.phase });
  if (problems.length) throw new Error(problems.join(' '));
  return {
    role: receipt.role,
    operations: [...grant.allowed_operations],
    providers: grant.stage === 'planner' ? ['codegraph', 'context7'] : ['codegraph', 'context7', 'playwright'],
    required: grant.stage === 'planner' ? ['engineering-core', 'native-coordination'] : ['engineering-core', 'assigned-editing', 'prescribed-execution'],
    optional: grant.stage === 'planner' ? ['code-analysis', 'library-documentation'] : ['code-analysis', 'library-documentation', 'browser-exploration'],
    native_tools: grant.stage === 'planner' ? ['read', 'search', 'web', 'coordination'] : ['read', 'search', 'edit', 'execute-prescribed'],
  };
}

export function fastResponsibility(
  root: string,
  receipt: NativeReceipt,
  recordType: string,
): string | null {
  if (!receipt.fast_grant || fastGrantProblems(root, receipt, { historical: true }).length) return null;
  if (receipt.fast_grant.stage !== 'planner') return null;
  const expected: Record<string, string> = {
    requirement: 'requirements',
    design: 'architect',
    check: 'verifier',
    task: 'manager',
  };
  return expected[recordType] ?? null;
}

export function hasFastResponsibility(root: string, receipt: NativeReceipt, responsibility: string): boolean {
  if (receipt.fast_grant?.stage === 'producer')
    return ['developer', 'check-executor'].includes(responsibility) && fastGrantProblems(root, receipt, { historical: true }).length === 0;
  return ['requirement', 'design', 'check', 'task'].some(
    (type) => fastResponsibility(root, receipt, type) === responsibility,
  );
}

export function fastOperations(stage: FastStage): string[] {
  return [...(stage === 'planner' ? plannerOperations : producerOperations)];
}

export function issueFastGrant(
  root: string,
  receipt: NativeReceipt,
  stage: FastStage,
  taskId: string | null,
): FastStageGrant {
  const selection = selectionOfWorkflow(root, receipt.workflow_id ?? '');
  assertFastSelectionSeal(root, selection);
  validateFastSelection(root, selection, { baseline: stage === 'planner' || !receipt.prior_invocation_id });
  if (receipt.role !== (stage === 'planner' ? 'manager' : 'developer'))
    throw new Error('Fast stage does not match its allowed base native role.');
  if (receipt.execution_mode !== 'native')
    throw new Error('Fast grants require authenticated native execution.');
  if (stage === 'planner' && (receipt.task_id !== null || taskId !== null))
    throw new Error('Fast planner grants are workflow scoped and cannot bind to a task.');
  if (stage === 'producer') {
    const workflow = getRecord(root, selection.workflow_id);
    const frozen = workflow.meta.data.fast_plan as { fingerprint?: string } | undefined;
    if (!frozen?.fingerprint || fastPlanFingerprint(root, selection.workflow_id) !== frozen.fingerprint)
      throw new Error('Production authority cannot adopt a changed independently reviewed plan.');
    if (!taskId || receipt.task_id !== taskId) throw new Error('Fast producer grant requires its exact assigned task.');
    const task = getRecord(root, taskId);
    if (task.meta.data.workflow_id !== selection.workflow_id)
      throw new Error('Fast producer task is outside the selected workflow.');
    const paths = Array.isArray(task.meta.data.allowed_paths) ? task.meta.data.allowed_paths : [];
    if (selection.editable_paths.some((path) => !paths.includes(path)))
      throw new Error('Fast selection editable paths exceed the reviewed task allowed_paths.');
    const protectedInputs = Object.keys(selection.protected_inputs);
    if (paths.some((path) => protectedInputs.includes(String(path))))
      throw new Error('Fast producer task editable paths overlap protected verification inputs.');
    const docsPaths = stringArray(task.meta.data.documentation_paths);
    if (docsPaths.some((path) => !paths.includes(path) || protectedInputs.includes(path)))
      throw new Error('Fast producer documentation paths exceed editable, unprotected scope.');
    if (task.meta.owner !== 'developer') throw new Error('Fast producer task must use the standard developer role.');
  }
  return issueGrant(root, receipt, stage, selection, taskId);
}

/** Producer gate executed before the core signs a production grant. */
export async function assertFastProducerReady(root: string, taskId: string): Promise<void> {
  const { verify } = await import('./engineering.js');
  const report = verify(root, taskId, 'design-ready');
  if (!report.ok)
    throw new Error(`Fast producer requires a current independently reviewed design-ready task: ${report.findings.map((item) => item.message).join('; ')}`);
}

export function assertFastGrantModel(root: string, receipt: NativeReceipt): void {
  const stage = receipt.fast_grant?.stage;
  if (!stage) throw new Error('Fast grant is missing its stage.');
  const expected = stage === 'planner' ? 'manager' : 'developer';
  const policy = roleModelPolicy(root, expected);
  if (receipt.role !== expected || policy.strong !== (stage === 'planner'))
    throw new Error('Fast stage must retain its standard strong/worker model policy.');
  if (!readRoutingPolicy(root)) throw new Error('Fast authority requires current native routing policy.');
}
