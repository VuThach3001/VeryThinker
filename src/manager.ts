import { existsSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import {
  atomicWrite,
  createRecord,
  getRecord,
  hash,
  loadRecords,
  now,
  readConfig,
  safePath,
  updateRecord,
  withLock,
  withOperationLock,
  withRecordReadSnapshot,
} from './storage.js';
import {
  acceptTask,
  recordFingerprint,
  requirementsFor,
  requirementScope,
  strings,
  verify,
  assignmentDocumentationProblems,
} from './engineering.js';
import { prepareContribution } from './packs.js';
import { submitContribution } from './contributions.js';
import type { ProjectRecord } from './types.js';
import { readRoutingPolicy, routingProblems, assertRouting, readInvocation } from './routing.js';
import { fastGrantProblems } from './fast-grants.js';
import { validateFastSelection, type FastSelection, type PolicyRequest } from './fast-policy.js';
import {
  readArchivePolicy,
  prepareArchive,
  publishArchive,
  archiveStatus,
  acceptedArchiveForWorkflow,
  assertPrivateArchiveDestination,
} from './archives.js';

export interface WorkflowInput {
  requirement?: string | null;
  requirements?: string[] | null;
  title?: string;
  invocation_id?: string;
  request_id?: string;
  change_type?: 'breaking' | 'breaking-change' | 'feature' | 'fix';
  execution_policy?: PolicyRequest;
}

/** Strict tool clients may send explicit placeholders for every optional field. */
export function normalizeWorkflowInput<T extends WorkflowInput>(input: T): T {
  const normalized = { ...input };
  for (const key of Object.keys(normalized) as (keyof T)[])
    if (normalized[key] === null) delete normalized[key];
  if (normalized.requirement !== undefined) {
    if (typeof normalized.requirement !== 'string')
      throw new Error('Requirement must be text or an unused null placeholder.');
    if (!normalized.requirement.trim()) delete normalized.requirement;
  }
  if (normalized.requirements !== undefined) {
    if (!Array.isArray(normalized.requirements))
      throw new Error('Requirements must be an array or an unused null placeholder.');
    if (!normalized.requirements.length) delete normalized.requirements;
  }
  return normalized;
}

export interface AutomationPolicy {
  schema_version: 1;
  manager_enabled: boolean;
  documentation_required: true;
  automatic_pr: boolean;
  upstream: string | null;
  max_discussion_rounds: number;
}
export function defaultAutomationPolicy(): AutomationPolicy {
  const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const repository =
    typeof packageJson.repository === 'string'
      ? packageJson.repository
      : packageJson.repository?.url;
  const upstream =
    typeof repository === 'string'
      ? (/github\.com[/:]([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(repository)?.[1] ??
        null)
      : null;
  return {
    schema_version: 1,
    manager_enabled: true,
    documentation_required: true,
    automatic_pr: true,
    upstream,
    max_discussion_rounds: 3,
  };
}
export function readAutomationPolicy(root: string): AutomationPolicy {
  const path = safePath(root, '.verythinker/automation.json');
  const policy = existsSync(path)
    ? JSON.parse(readFileSync(path, 'utf8'))
    : defaultAutomationPolicy();
  if (
    !policy ||
    policy.schema_version !== 1 ||
    typeof policy.manager_enabled !== 'boolean' ||
    policy.documentation_required !== true ||
    typeof policy.automatic_pr !== 'boolean' ||
    (policy.upstream !== null &&
      (typeof policy.upstream !== 'string' ||
        !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(policy.upstream))) ||
    !Number.isInteger(policy.max_discussion_rounds) ||
    policy.max_discussion_rounds < 1 ||
    policy.max_discussion_rounds > 3
  )
    throw new Error('Invalid manager automation policy.');
  return policy;
}
/** Project-owned policy: upgrades never replace a configured upstream or an opt-out. */
export function ensureAutomationPolicy(root: string): AutomationPolicy {
  readConfig(root);
  return withLock(root, () => {
    const path = safePath(root, '.verythinker/automation.json');
    if (!existsSync(path))
      atomicWrite(path, JSON.stringify(defaultAutomationPolicy(), null, 2) + '\n');
    return readAutomationPolicy(root);
  });
}
function text(value: string, name: string, maximum = 20000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum)
    throw new Error(`${name} must contain between 1 and ${maximum} characters.`);
  return value.trim();
}
function workflow(root: string, id: string): ProjectRecord {
  const record = getRecord(root, id);
  if (record.meta.type !== 'knowledge' || record.meta.data.kind !== 'manager-workflow')
    throw new Error('Provide a manager workflow ID.');
  return record;
}
export function beginWorkflow(root: string, input: WorkflowInput): ProjectRecord {
  return withOperationLock(root, 'manager-intake', () =>
    beginWorkflowClaimed(root, normalizeWorkflowInput(input)),
  );
}
function beginWorkflowClaimed(root: string, input: WorkflowInput): ProjectRecord {
  const policy = ensureAutomationPolicy(root);
  if (!policy.manager_enabled) throw new Error('The project manager entrypoint is disabled.');
  if (input.requirement !== undefined && input.requirements !== undefined)
    throw new Error('Provide requirement or requirements, rather than both.');
  const originals = input.requirements ?? [input.requirement!];
  if (!Array.isArray(originals) || !originals.length || originals.length > 32)
    throw new Error('Provide between one and 32 requirements.');
  const requirements = originals.map((item, index) => text(item, `Requirement ${index + 1}`));
  const requirement =
    requirements.length === 1
      ? requirements[0]!
      : requirements.map((item, index) => `${index + 1}. ${item}`).join('\n');
  const changeType =
    input.change_type === 'breaking' ? 'breaking-change' : (input.change_type ?? 'feature');
  if (!['breaking-change', 'feature', 'fix'].includes(changeType))
    throw new Error('Invalid change classification.');
  const requestId = text(input.request_id ?? randomUUID(), 'Request ID', 256);
  const title = text(input.title ?? requirement.slice(0, 100), 'Title', 256);
  let parent = loadRecords(root).find(
    (r) => r.meta.data.kind === 'manager-workflow' && r.meta.data.request_id === requestId,
  );
  if (
    parent &&
    (parent.meta.data.original_requirement !== requirement ||
      JSON.stringify(
        parent.meta.data.original_requirements ?? [parent.meta.data.original_requirement],
      ) !== JSON.stringify(requirements))
  )
    throw new Error('Request ID already belongs to a different requirement.');
  if (!parent)
    parent = createRecord(root, {
      type: 'knowledge',
      title: `Workflow: ${title}`,
      owner: 'manager',
      status: 'in-progress',
      data: {
        kind: 'manager-workflow',
        request_id: requestId,
        original_requirement: requirement,
        original_requirements: requirements,
        increment_id: randomUUID(),
        change_type: changeType,
        routing_required: readRoutingPolicy(root) !== null,
        invocation_id: input.invocation_id ?? randomUUID(),
        phase: 'intake',
        task_ids: [],
        open_questions: [],
        created_by: 'natural-language-requirement',
        ...(input.execution_policy ? { execution_policy_requested: input.execution_policy } : {}),
      },
      body: `# Objective\n${requirement}\n\n# Resumption\nRead manager_status for the next action.\n`,
    });
  let rootRequirement = loadRecords(root).find(
    (r) =>
      r.meta.type === 'requirement' &&
      r.meta.data.intake_workflow_id === parent!.meta.id &&
      r.meta.data.batch_item === undefined,
  );
  if (!rootRequirement)
    rootRequirement = createRecord(root, {
      type: 'requirement',
      title,
      owner: 'requirements',
      data: { intake_workflow_id: parent.meta.id, acceptance_criteria: [], source: 'user-request' },
      body: `# Stakeholder requirement\n${requirement}\n\n# Acceptance criteria\nRefine measurable criteria from the request and clarification.\n`,
    });
  if (parent.meta.data.requirement_id !== rootRequirement.meta.id)
    parent = updateRecord(root, parent.meta.id, {
      data: { requirement_id: rootRequirement.meta.id },
      links: [{ type: 'documents', target: rootRequirement.meta.id }],
    });
  const leaves: string[] = [];
  if (requirements.length > 1) {
    for (const [index, item] of requirements.entries()) {
      let leaf = loadRecords(root).find(
        (record) =>
          record.meta.type === 'requirement' &&
          record.meta.data.intake_workflow_id === parent!.meta.id &&
          record.meta.data.batch_item === index,
      );
      if (!leaf)
        leaf = createRecord(root, {
          type: 'requirement',
          title: item.slice(0, 100),
          owner: 'requirements',
          data: {
            intake_workflow_id: parent.meta.id,
            batch_item: index,
            acceptance_criteria: [],
            source: 'user-request',
          },
          links: [{ type: 'derives-from', target: rootRequirement.meta.id }],
          body: `# Stakeholder requirement\n${item}\n\n# Acceptance criteria\nRefine measurable criteria for this independently verifiable outcome.\n`,
        });
      leaves.push(leaf.meta.id);
    }
  } else leaves.push(rootRequirement.meta.id);
  if (JSON.stringify(parent.meta.data.requirement_ids) !== JSON.stringify(leaves))
    parent = updateRecord(root, parent.meta.id, {
      data: { requirement_ids: leaves },
      links: [
        { type: 'documents', target: rootRequirement.meta.id },
        ...leaves
          .filter((target) => target !== rootRequirement.meta.id)
          .map((target) => ({ type: 'documents' as const, target })),
      ],
    });
  return parent;
}
export function bindManagerInvocation(
  root: string,
  id: string,
  invocationId: string,
): ProjectRecord {
  const parent = workflow(root, id);
  assertRouting(root, 'manager', invocationId, { workflow_id: id, require_completed: false });
  // Acknowledging the same observed invocation must not churn record revisions.
  if (parent.meta.data.invocation_id === invocationId) return parent;
  return updateRecord(root, id, { data: { invocation_id: invocationId } }, undefined, (current) => {
    if (current.meta.revision !== parent.meta.revision)
      throw new Error('Workflow changed before manager assignment.');
  });
}
/** A manager acknowledges itself without granting workflow lifecycle overrides. */
export function acknowledgeManagerInvocation(
  root: string,
  id: string,
  invocationId: string,
): ProjectRecord {
  const parent = workflow(root, id);
  const receipt = assertRouting(root, 'manager', invocationId, {
    workflow_id: id,
    require_completed: false,
  });
  if (
    !receipt ||
    receipt.execution_mode !== 'native' ||
    receipt.state !== 'running' ||
    receipt.task_id !== null
  )
    throw new Error(
      'Manager acknowledgment requires the active signed taskless coordinator for this workflow.',
    );
  if (
    ['completed', 'completed-with-blockers'].includes(String(parent.meta.data.phase)) ||
    parent.meta.data.closed_at
  )
    throw new Error(
      'A closed workflow requires manager_run continuation rather than acknowledgment rebinding.',
    );
  return bindManagerInvocation(root, id, invocationId);
}
export const discussionRoles = [
  'researcher',
  'requirements',
  'architect',
  'component-owner',
  'developer',
  'verifier',
  'reviewer',
  'release',
  'curator',
  'manager',
  'codebase-analyst',
  'check-executor',
] as const;
export function discussWorkflow(
  root: string,
  id: string,
  input: {
    role: string;
    invocation_id: string;
    summary: string;
    rationale: string;
    risks?: string[];
    source_ids?: string[];
    round?: number;
  },
): ProjectRecord {
  const parent = workflow(root, id);
  const policy = readAutomationPolicy(root);
  if (!discussionRoles.includes(input.role as (typeof discussionRoles)[number]))
    throw new Error('Discussion role must match an installed role contract.');
  const invocationId = text(input.invocation_id, 'Invocation ID', 256);
  if (parent.meta.data.routing_required === true)
    assertRouting(root, input.role, invocationId, { workflow_id: id, require_completed: false });
  if (input.role !== 'manager' && invocationId === parent.meta.data.invocation_id)
    throw new Error('Specialist discussion needs its own invocation identity.');
  const round = input.round ?? 1;
  if (!Number.isInteger(round) || round < 1 || round > policy.max_discussion_rounds)
    throw new Error('Discussion round exceeds the bounded project policy.');
  const sources = [...new Set(input.source_ids ?? [String(parent.meta.data.requirement_id)])];
  if (!sources.length || sources.length > 32)
    throw new Error('Discussion requires 1 to 32 inspected source record IDs.');
  const sourceBaseline = Object.fromEntries(
    sources.map((source) => {
      const r = getRecord(root, source);
      if (r.meta.data.kind === 'manager-workflow')
        throw new Error('Reference engineering inputs rather than mutable workflow state.');
      return [source, recordFingerprint(r)];
    }),
  );
  const risks = input.risks ?? [];
  if (risks.some((r) => typeof r !== 'string' || !r.trim()))
    throw new Error('Discussion risks must be nonempty strings.');
  return createRecord(root, {
    type: 'knowledge',
    title: `Discussion: ${input.role}`,
    owner: input.role,
    data: {
      kind: 'manager-discussion',
      workflow_id: id,
      invocation_id: invocationId,
      round,
      source_baseline: sourceBaseline,
      summary: text(input.summary, 'Summary'),
      rationale: text(input.rationale, 'Rationale'),
      risks,
    },
    links: [
      { type: 'documents', target: id },
      ...sources.map((target) => ({ type: 'references' as const, target })),
    ],
    body: `# Contribution\n${input.summary}\n\n# Rationale\n${input.rationale}\n\n# Risks\n${risks.length ? risks.join('\n') : 'No unresolved risk reported.'}\n\n# Sources\n${sources.join('\n')}\n`,
  });
}
function currentDiscussions(root: string, id: string): ProjectRecord[] {
  const latest = new Map<string, ProjectRecord>();
  for (const record of loadRecords(root)
    .filter((r) => r.meta.data.kind === 'manager-discussion' && r.meta.data.workflow_id === id)
    .sort((a, b) => a.meta.id.localeCompare(b.meta.id)))
    latest.set(record.meta.owner, record);
  return [...latest.values()].filter((record) => {
    const parent = workflow(root, id);
    if (
      parent.meta.data.routing_required === true &&
      routingProblems(root, record.meta.owner, String(record.meta.data.invocation_id), {
        workflow_id: id,
        require_completed: true,
      }).length
    )
      return false;
    const baseline = record.meta.data.source_baseline as Record<string, string>;
    return (
      baseline &&
      Object.entries(baseline).every(([source, fingerprint]) => {
        try {
          return recordFingerprint(getRecord(root, source)) === fingerprint;
        } catch {
          return false;
        }
      })
    );
  });
}
function taskContract(task: ProjectRecord): string {
  return hash(
    JSON.stringify({
      owner: task.meta.owner,
      requirements: requirementsFor(task),
      acceptance_criteria: task.meta.data.acceptance_criteria,
      allowed_paths: task.meta.data.allowed_paths,
      dependencies: task.meta.data.dependencies,
      links: task.meta.links,
      documentation_paths: task.meta.data.documentation_paths,
      outputs: task.meta.data.outputs,
      documentation_required: task.meta.data.documentation_required,
      routing_required: task.meta.data.routing_required,
      workflow_id: task.meta.data.workflow_id,
      recipe_instance_ids: task.meta.data.recipe_instance_ids,
      protected_acceptance_paths: task.meta.data.protected_acceptance_paths,
      required_tools: task.meta.data.required_tools,
    }),
  );
}
function requirementAncestry(root: string, ids: string[]): string[] {
  return requirementScope(loadRecords(root), ids);
}
function allocatedTo(root: string, task: ProjectRecord, requirementId: string): boolean {
  return requirementAncestry(root, requirementsFor(task)).includes(requirementId);
}
export function decideWorkflow(
  root: string,
  id: string,
  input: {
    summary: string;
    rationale: string;
    task_ids: string[];
  },
): ProjectRecord {
  return withOperationLock(root, `manager-${hash(id)}`, () =>
    decideWorkflowClaimed(root, id, input),
  );
}
function decideWorkflowClaimed(
  root: string,
  id: string,
  input: {
    summary: string;
    rationale: string;
    task_ids: string[];
  },
): ProjectRecord {
  const parent = workflow(root, id);
  if (readRoutingPolicy(root) && parent.meta.data.routing_required !== true)
    throw new Error(
      'Legacy workflow planning requires alpha.3 migration and strategic reassessment; use a new increment for closed history.',
    );
  const archiveIntent = safePath(root, `.verythinker/archive-intents/${hash(id)}.json`);
  if (
    parent.meta.data.archive ||
    acceptedArchiveForWorkflow(root, id) ||
    (existsSync(archiveIntent) && JSON.parse(readFileSync(archiveIntent, 'utf8')).snapshot_id)
  )
    throw new Error(
      'This increment has a frozen archive. Reconcile publication or start a new workflow increment; accepted history cannot be replanned.',
    );
  if (parent.meta.data.routing_required === true)
    assertRouting(root, 'manager', String(parent.meta.data.invocation_id), {
      workflow_id: id,
      require_completed: false,
    });
  const summary = text(input.summary, 'Summary');
  const rationale = text(input.rationale, 'Rationale');
  const rootRequirement = getRecord(root, String(parent.meta.data.requirement_id));
  if (!strings(rootRequirement.meta.data.acceptance_criteria).length)
    throw new Error('Refine the stakeholder requirement into measurable acceptance criteria.');
  if (strings(parent.meta.data.open_questions).length)
    throw new Error('Resolve recorded product questions before deciding execution.');
  const participants = currentDiscussions(root, id).filter((r) => r.meta.owner !== 'manager');
  const fast = parent.meta.data.execution_policy === 'fast';
  if (fast) {
    validateFastSelection(root, parent.meta.data.execution_policy_selection as FastSelection);
    const planner = readInvocation(root, String(parent.meta.data.invocation_id));
    const errors = fastGrantProblems(root, planner, { historical: true });
    if (
      planner.fast_grant?.stage !== 'planner' ||
      planner.state !== 'completed' ||
      !planner.inference_completed ||
      errors.length
    )
      throw new Error(`Fast decision needs its completed confirmed planner: ${errors.join(' ')}`);
    const submitted = parent.meta.data.fast_plan as { task_ids?: string[] } | undefined;
    if (
      !submitted ||
      JSON.stringify(submitted.task_ids) !== JSON.stringify(input.task_ids) ||
      input.task_ids.length !== 1
    )
      throw new Error('Fast decision must use its frozen single-task planning submission.');
  }
  if (
    !fast &&
    (new Set(participants.map((r) => r.meta.owner)).size < 2 ||
      new Set(participants.map((r) => r.meta.data.invocation_id)).size < 2)
  )
    throw new Error(
      'Execution needs current contributions from two specialist roles in separate invocations.',
    );
  const ids = [...new Set(input.task_ids)];
  if (!ids.length) throw new Error('Decision needs at least one bounded task.');
  const replacedIds = strings(parent.meta.data.task_ids).filter((taskId) => !ids.includes(taskId));
  for (const taskId of replacedIds) {
    const prior = getRecord(root, taskId);
    if (prior.meta.data.workflow_id !== id)
      throw new Error('Prior assignment belongs to a different workflow.');
    if (prior.meta.status === 'in-progress')
      throw new Error(
        'Stop and hand off the active native worker before replacing its assignment.',
      );
  }
  const tasks = ids.map((taskId) => getRecord(root, taskId));
  const leafRequirements = strings(parent.meta.data.requirement_ids).length
    ? strings(parent.meta.data.requirement_ids)
    : [rootRequirement.meta.id];
  for (const requirementId of leafRequirements) {
    if (!strings(getRecord(root, requirementId).meta.data.acceptance_criteria).length)
      throw new Error(
        `Refine measurable acceptance criteria for every requirement: ${requirementId}`,
      );
  }
  for (const task of tasks) {
    if (task.meta.type !== 'task' || !['draft', 'ready', 'blocked'].includes(task.meta.status))
      throw new Error('Plan tasks before implementation starts.');
    if (task.meta.data.workflow_id && task.meta.data.workflow_id !== id)
      throw new Error('Task already belongs to another workflow.');
    if (!allocatedTo(root, task, rootRequirement.meta.id))
      throw new Error(
        'Each task must trace to the stakeholder requirement or a derived requirement.',
      );
  }
  for (const requirementId of leafRequirements)
    if (!tasks.some((task) => allocatedTo(root, task, requirementId)))
      throw new Error(`Every requirement needs a bounded implementation task: ${requirementId}`);
  // Assign documentation responsibility before the task baseline is recorded.
  for (const task of tasks)
    updateRecord(root, task.meta.id, {
      data: {
        workflow_id: id,
        documentation_required: true,
        routing_required: parent.meta.data.routing_required === true,
        documentation_paths: task.meta.data.documentation_paths ?? [],
      },
    });
  const readyTasks = ids.map((taskId) => getRecord(root, taskId));
  for (const task of readyTasks) {
    // Dependencies inside this plan may be unaccepted; they gate dispatch, not planning.
    const report = verify(root, task.meta.id, 'design-ready');
    const failures = report.findings.filter(
      (f) => !['dependency-not-accepted', 'dependency-stale', 'blocked'].includes(f.code),
    );
    if (failures.length) throw new Error(failures.map((f) => f.message).join('\n'));
  }
  const requirementIds = requirementAncestry(root, [
    String(parent.meta.data.requirement_id),
    ...leafRequirements,
    ...readyTasks.flatMap(requirementsFor),
  ]);
  const requirements = Object.fromEntries(
    requirementIds.map((source) => [source, recordFingerprint(getRecord(root, source))]),
  );
  const decision = createRecord(root, {
    type: 'knowledge',
    title: 'Manager execution decision',
    owner: 'manager',
    data: {
      kind: 'manager-decision',
      workflow_id: id,
      invocation_id: parent.meta.data.invocation_id,
      summary,
      rationale,
      discussion_ids: participants.map((r) => r.meta.id),
      requirement_baseline: requirements,
      task_contracts: Object.fromEntries(
        readyTasks.map((task) => [task.meta.id, taskContract(task)]),
      ),
    },
    links: [
      { type: 'documents', target: id },
      ...ids.map((target) => ({ type: 'references' as const, target })),
    ],
    body: `# Decision\n${summary}\n\n# Rationale\n${rationale}\n\n# Specialist contributions\n${participants.map((r) => r.meta.id).join('\n')}\n\n# Assignments\n${ids.join('\n')}\n`,
  });
  const history = Array.isArray(parent.meta.data.history) ? [...parent.meta.data.history] : [];
  if (parent.meta.data.decision_id)
    history.push({
      decision_id: parent.meta.data.decision_id,
      task_ids: parent.meta.data.task_ids,
      final_report_id: parent.meta.data.final_report_id ?? null,
      knowledge_ids: parent.meta.data.knowledge_ids ?? [],
      publications: parent.meta.data.publications ?? [],
      closed_at: parent.meta.data.closed_at ?? null,
    });
  for (const taskId of replacedIds) updateRecord(root, taskId, { status: 'superseded' });
  return updateRecord(
    root,
    id,
    {
      data: {
        phase: 'execution',
        task_ids: ids,
        decision_id: decision.meta.id,
        history,
        final_report_id: null,
        closed_at: null,
        knowledge_ids: [],
        no_lesson_reason: null,
        publications: [],
      },
      links: [
        { type: 'documents', target: String(parent.meta.data.requirement_id) },
        { type: 'references', target: decision.meta.id },
        ...ids.map((target) => ({ type: 'references' as const, target })),
        ...replacedIds.map((target) => ({ type: 'references' as const, target })),
      ],
    },
    undefined,
    (current) => {
      if (current.meta.revision !== parent.meta.revision)
        throw new Error(
          'Workflow changed during planning; reassess the current decision before retrying.',
        );
    },
  );
}
function decisionProblems(root: string, parent: ProjectRecord): string[] {
  const decisionId = parent.meta.data.decision_id;
  if (typeof decisionId !== 'string') return ['No integrated manager decision is recorded.'];
  const decision = getRecord(root, decisionId);
  if (
    decision.meta.data.kind !== 'manager-decision' ||
    decision.meta.data.workflow_id !== parent.meta.id
  )
    return ['Manager decision does not belong to this workflow.'];
  const problems: string[] = [];
  const leaves = strings(parent.meta.data.requirement_ids);
  for (const requirementId of leaves)
    if (
      !strings(parent.meta.data.task_ids).some((taskId) =>
        allocatedTo(root, getRecord(root, taskId), requirementId),
      )
    )
      problems.push(`Requirement no longer has implementation coverage: ${requirementId}`);
  for (const [id, fingerprint] of Object.entries(
    decision.meta.data.requirement_baseline as Record<string, string>,
  ))
    if (recordFingerprint(getRecord(root, id)) !== fingerprint)
      problems.push(`Requirement changed after the decision: ${id}`);
  for (const [id, fingerprint] of Object.entries(
    decision.meta.data.task_contracts as Record<string, string>,
  ))
    if (taskContract(getRecord(root, id)) !== fingerprint)
      problems.push(`Task contract changed after the decision: ${id}`);
  for (const id of strings(parent.meta.data.task_ids))
    if (!allocatedTo(root, getRecord(root, id), String(parent.meta.data.requirement_id)))
      problems.push(`Task no longer traces to the stakeholder requirement: ${id}`);
  return problems;
}
export function workflowStatus(root: string, id?: string): unknown {
  return withRecordReadSnapshot(root, () => workflowStatusSnapshot(root, id));
}
function workflowStatusSnapshot(root: string, id?: string): unknown {
  if (!id)
    return loadRecords(root)
      .filter((r) => r.meta.data.kind === 'manager-workflow')
      .map((r) => workflowStatusSnapshot(root, r.meta.id));
  const parent = workflow(root, id);
  let recoveredArchive: ReturnType<typeof acceptedArchiveForWorkflow> = null;
  let archiveError: string | null = null;
  try {
    recoveredArchive = acceptedArchiveForWorkflow(root, id);
  } catch (error) {
    archiveError = String(error);
  }
  const intentPath = safePath(root, `.verythinker/archive-intents/${hash(id)}.json`);
  const intent = existsSync(intentPath)
    ? (JSON.parse(readFileSync(intentPath, 'utf8')) as { snapshot_id?: string; error?: string })
    : null;
  const completionPath =
    typeof parent.meta.data.invocation_id === 'string' &&
    /^[a-f0-9-]{36}$/.test(parent.meta.data.invocation_id)
      ? safePath(root, `.verythinker/native/completion/${parent.meta.data.invocation_id}.json`)
      : null;
  const completionError =
    completionPath && existsSync(completionPath)
      ? JSON.parse(readFileSync(completionPath, 'utf8')).error
      : null;
  const savedPublicationDisposition = parent.meta.data.publication_disposition as
    Record<string, unknown> | undefined;
  const questions = strings(parent.meta.data.open_questions);
  const appliedContinuations = strings(parent.meta.data.applied_continuation_ids);
  const transferredContinuations = (
    Array.isArray(parent.meta.data.continuation_transfers)
      ? parent.meta.data.continuation_transfers
      : []
  ).map((entry) => entry.continuation_id);
  const pendingContinuations = (
    Array.isArray(parent.meta.data.pending_continuations)
      ? parent.meta.data.pending_continuations
      : []
  ).filter(
    (entry) =>
      typeof entry.id === 'string' &&
      !appliedContinuations.includes(entry.id) &&
      !transferredContinuations.includes(entry.id),
  );
  const managerAttemptId =
    parent.meta.data.native_manager_attempt_id ?? parent.meta.data.invocation_id;
  let managerAttempt: ReturnType<typeof readInvocation> | null = null;
  if (typeof managerAttemptId === 'string')
    try {
      managerAttempt = readInvocation(root, managerAttemptId);
    } catch {
      // Historical intake identities are not native invocation observations.
    }
  const managerBlocker = recoveredArchive
    ? null
    : (parent.meta.data.native_manager_blocker ??
      (managerAttempt && ['blocked', 'waiting-native-permission'].includes(managerAttempt.state)
        ? (managerAttempt.error ?? managerAttempt.state)
        : null));
  const ids = strings(parent.meta.data.task_ids);
  const taskStates = ids.map((taskId) => {
    const task = getRecord(root, taskId);
    return {
      id: taskId,
      owner: task.meta.owner,
      status: task.meta.status,
      documentation_required: task.meta.data.documentation_required === true,
      ready: verify(root, taskId, 'ready'),
      accepted: verify(root, taskId, 'accepted'),
    };
  });
  const decisionFindings = parent.meta.data.decision_id ? decisionProblems(root, parent) : [];
  const savedLocalDelivery = parent.meta.data.local_delivery as Record<string, unknown> | undefined;
  const reportFindings: string[] = [];
  if (savedLocalDelivery)
    try {
      const report = getRecord(root, String(savedLocalDelivery.report_id));
      const currentHash = hash(readFileSync(safePath(root, report.path)));
      if (report.path !== savedLocalDelivery.report_path)
        reportFindings.push('The saved final report path changed after local delivery.');
      if (currentHash !== savedLocalDelivery.report_hash)
        reportFindings.push('The saved final report bytes changed after local delivery.');
      if (parent.meta.data.final_report_id !== report.meta.id)
        reportFindings.push('The workflow no longer points to its saved final report.');
    } catch {
      reportFindings.push('The saved final report is missing or unreadable.');
    }
  const deliveryFindings = [
    ...decisionFindings,
    ...strings(parent.meta.data.open_questions).map(
      (question) => `Unresolved product question: ${question}`,
    ),
    ...reportFindings,
    ...(pendingContinuations.length
      ? ['New user continuations require incorporation and reassessment.']
      : []),
    ...(parent.meta.data.phase === 'reassessment-required'
      ? ['Workflow is marked for reassessment.']
      : []),
    ...taskStates.flatMap((task) =>
      task.accepted.ok
        ? []
        : task.accepted.findings.map((finding) => `${task.id}: ${finding.message}`),
    ),
    ...(parent.meta.data.routing_required === true
      ? assignmentDocumentationProblems(root, id)
      : []),
  ];
  const localDelivery = savedLocalDelivery
    ? {
        ...savedLocalDelivery,
        status: deliveryFindings.length ? 'stale' : savedLocalDelivery.status,
        ...(deliveryFindings.length ? { stale_findings: deliveryFindings } : {}),
      }
    : null;
  const publicationBlockers = Array.isArray(savedPublicationDisposition?.blockers)
    ? (savedPublicationDisposition.blockers as string[])
    : [];
  const archiveRequired = readArchivePolicy(root)?.enabled === true;
  const archiveConfirmed =
    !archiveRequired ||
    recoveredArchive !== null ||
    (parent.meta.data.archive as { status?: string } | undefined)?.status === 'completed';
  const nativeComplete =
    parent.meta.data.routing_required !== true ||
    (managerAttempt?.state === 'completed' && managerAttempt.inference_completed === true);
  const currentLocalClosure =
    parent.meta.data.phase === 'completed' &&
    decisionFindings.length === 0 &&
    deliveryFindings.length === 0 &&
    taskStates.every((task) => task.accepted.ok);
  const oldPublicationErrorsResolved =
    currentLocalClosure && nativeComplete && archiveConfirmed && publicationBlockers.length === 0;
  const closureBlockers = [
    ...(intent?.error && !oldPublicationErrorsResolved ? [intent.error] : []),
    ...(completionError && !oldPublicationErrorsResolved ? [completionError] : []),
    ...(archiveError && !recoveredArchive ? [archiveError] : []),
    ...publicationBlockers,
  ];
  const nativeCompletionFindings =
    parent.meta.data.routing_required === true &&
    ['completed', 'completed-with-blockers', 'awaiting-native-completion'].includes(
      String(parent.meta.data.phase),
    )
      ? routingProblems(
          root,
          'manager',
          typeof parent.meta.data.invocation_id === 'string'
            ? parent.meta.data.invocation_id
            : undefined,
          { workflow_id: id },
        )
      : [];
  let nextAction: string;
  if (pendingContinuations.length)
    nextAction =
      'Incorporate the saved user continuations, record their IDs as applied, and reassess affected contracts before further dispatch.';
  else if (questions.length) nextAction = 'Clarify the recorded product questions with the user.';
  else if (managerBlocker)
    nextAction = 'Resolve the recorded native coordinator blocker and resume the saved increment.';
  else if (decisionFindings.length)
    nextAction = 'Reassess changed requirements/contracts and record a fresh specialist decision.';
  else if (savedLocalDelivery && deliveryFindings.length)
    nextAction = 'Reassess the saved local report against current deliverables and evidence.';
  else if (!parent.meta.data.decision_id)
    nextAction =
      'Collect specialist contributions, measurable requirements, reviewed design, and bounded tasks; record the manager decision.';
  else if (taskStates.some((t) => t.status === 'blocked'))
    nextAction =
      'Resolve the recorded blocker internally or report the specific external dependency.';
  else if (taskStates.some((t) => t.status !== 'accepted' || !t.accepted.ok))
    nextAction =
      'Dispatch ready tasks, collect complete documentation/evidence, obtain separate reviews, and accept validated submissions.';
  else if (nativeCompletionFindings.length)
    nextAction =
      'Wait for the native coordinator completion and automatic archive, or inspect its recorded blocker.';
  else if (parent.meta.data.phase === 'completed-with-blockers' || closureBlockers.length)
    nextAction =
      'Retry the saved publication blocker when credentials or the upstream become available.';
  else if (parent.meta.data.phase === 'completed')
    nextAction =
      'Deliver the saved final report; resume only for a new requirement or changed baseline.';
  else
    nextAction =
      'Curate qualified lessons and run manager_finish to prepare/submit documentation PRs and write the final report.';
  const phase = pendingContinuations.length
    ? 'reassessment-required'
    : questions.length
      ? 'clarification-required'
      : managerBlocker
        ? 'native-blocked'
        : decisionFindings.length
          ? 'reassessment-required'
          : savedLocalDelivery && deliveryFindings.length
            ? 'reassessment-required'
            : parent.meta.data.decision_id &&
                taskStates.some((t) => t.status !== 'accepted' || !t.accepted.ok)
              ? 'execution'
              : nativeCompletionFindings.length
                ? 'awaiting-native-completion'
                : closureBlockers.length
                  ? 'completed-with-blockers'
                  : recoveredArchive
                    ? 'completed'
                    : parent.meta.data.phase;
  let finalReportPath: string | null = null;
  let finalReportHash: string | null = null;
  if (typeof parent.meta.data.final_report_id === 'string')
    try {
      const report = getRecord(root, parent.meta.data.final_report_id);
      finalReportPath = report.path;
      finalReportHash = hash(readFileSync(safePath(root, report.path)));
    } catch {
      // Keep status readable when a saved report path has been removed or damaged.
    }
  return {
    workflow_id: id,
    requirement_id: parent.meta.data.requirement_id,
    requirement_ids: parent.meta.data.requirement_ids ?? [parent.meta.data.requirement_id],
    increment_id: parent.meta.data.increment_id ?? null,
    change_type: parent.meta.data.change_type ?? 'feature',
    phase,
    persisted_phase: parent.meta.data.phase,
    policy: readAutomationPolicy(root),
    open_questions: questions,
    pending_continuations: pendingContinuations,
    continuation_transfers: parent.meta.data.continuation_transfers ?? [],
    decision_findings: decisionFindings,
    native_completion_findings: nativeCompletionFindings,
    native_manager_attempt_id: typeof managerAttemptId === 'string' ? managerAttemptId : null,
    native_manager_state: managerAttempt?.state ?? null,
    native_manager_blocker: managerBlocker,
    archive: parent.meta.data.archive ?? recoveredArchive?.publication ?? null,
    closure_blockers: closureBlockers,
    tasks: taskStates,
    next_action: nextAction,
    final_report_id: parent.meta.data.final_report_id ?? null,
    final_report_path: finalReportPath,
    final_report_hash: finalReportHash,
    local_delivery: localDelivery,
    publication_disposition: parent.meta.data.publication_disposition ?? null,
    history: parent.meta.data.history ?? [],
    publications: parent.meta.data.publications ?? [],
    publication_history: parent.meta.data.publication_history ?? [],
    publication_retirements: parent.meta.data.publication_retirements ?? [],
    orchestration:
      'The active native manager dispatches workers; this core records and validates state.',
  };
}
export function finishWorkflow(
  root: string,
  id: string,
  input: {
    knowledge_ids?: string[];
    no_lesson_reason?: string;
    retired_candidates?: { knowledge_id: string; reason: string }[];
  },
  publish: typeof submitContribution = submitContribution,
  archivePublisher: typeof publishArchive = publishArchive,
): unknown {
  return withOperationLock(root, `manager-${hash(id)}`, () =>
    finishWorkflowClaimed(root, id, input, publish, archivePublisher),
  );
}
function finishWorkflowClaimed(
  root: string,
  id: string,
  input: {
    knowledge_ids?: string[];
    no_lesson_reason?: string;
    retired_candidates?: { knowledge_id: string; reason: string }[];
  },
  publish: typeof submitContribution,
  archivePublisher: typeof publishArchive,
): unknown {
  let parent = workflow(root, id);
  if (
    readRoutingPolicy(root) &&
    parent.meta.data.routing_required !== true &&
    (!['completed', 'completed-with-blockers'].includes(String(parent.meta.data.phase)) ||
      typeof parent.meta.data.final_report_id !== 'string')
  )
    throw new Error(
      'Pending legacy workflow requires alpha.3 migration and confirmed strategic coordination before closure.',
    );
  let managerCompleted = true;
  if (parent.meta.data.routing_required === true) {
    const receipt = assertRouting(
      root,
      'manager',
      typeof parent.meta.data.invocation_id === 'string'
        ? parent.meta.data.invocation_id
        : undefined,
      { workflow_id: id, require_completed: false },
    );
    managerCompleted = receipt!.state === 'completed' && receipt!.inference_completed;
  }
  if (strings(parent.meta.data.open_questions).length)
    throw new Error('Resolve outstanding product questions before closing the workflow.');
  const applied = strings(parent.meta.data.applied_continuation_ids);
  const transferred = (
    Array.isArray(parent.meta.data.continuation_transfers)
      ? parent.meta.data.continuation_transfers
      : []
  ).map((entry) => entry.continuation_id);
  if (
    (Array.isArray(parent.meta.data.pending_continuations)
      ? parent.meta.data.pending_continuations
      : []
    ).some(
      (entry) =>
        typeof entry.id === 'string' &&
        !applied.includes(entry.id) &&
        !transferred.includes(entry.id),
    )
  )
    throw new Error(
      'Incorporate the saved user continuations and reassess affected contracts before closing the workflow.',
    );
  const decisionFindings = decisionProblems(root, parent);
  if (decisionFindings.length) throw new Error(decisionFindings.join('\n'));
  const taskIds = strings(parent.meta.data.task_ids);
  if (!taskIds.length) throw new Error('Workflow has no assigned tasks.');
  if (parent.meta.data.routing_required === true) {
    const problems = assignmentDocumentationProblems(root, id);
    if (problems.length) throw new Error(problems.join('\n'));
  }
  for (const taskId of taskIds) {
    const task = getRecord(root, taskId);
    if (task.meta.data.workflow_id !== id || task.meta.data.documentation_required !== true)
      throw new Error('Workflow assignments must retain their documentation contract.');
    const report = verify(root, taskId, 'accepted');
    if (!report.ok)
      throw new Error(report.findings.map((f) => `${taskId}: ${f.message}`).join('\n'));
  }
  const retired = input.retired_candidates ?? [];
  const previousIds = strings(parent.meta.data.knowledge_ids);
  const retiredIds = new Set<string>();
  const savedRetirementReasons = new Map(
    (Array.isArray(parent.meta.data.publication_retirements)
      ? parent.meta.data.publication_retirements
      : []
    ).map((item) => [item.knowledge_id, item.reason]),
  );
  for (const disposition of retired) {
    const reason = text(disposition.reason, 'Candidate retirement reason');
    const repeatedRetirement = savedRetirementReasons.get(disposition.knowledge_id) === reason;
    if (
      (!previousIds.includes(disposition.knowledge_id) && !repeatedRetirement) ||
      retiredIds.has(disposition.knowledge_id) ||
      input.knowledge_ids?.includes(disposition.knowledge_id)
    )
      throw new Error(
        'Retire each saved candidate once, without selecting it again for this closure.',
      );
    if (reason.split(/\s+/).length < 4 || reason.length < 24)
      throw new Error(
        'Candidate retirement needs a specific documented replacement or withdrawal reason.',
      );
    retiredIds.add(disposition.knowledge_id);
  }
  const knowledgeIds = [
    ...new Set([
      ...previousIds.filter((candidate) => !retiredIds.has(candidate)),
      ...(input.knowledge_ids ?? []),
    ]),
  ];
  const noLessonReason =
    input.no_lesson_reason ?? (parent.meta.data.no_lesson_reason as string | undefined);
  if (!knowledgeIds.length && !noLessonReason?.trim())
    throw new Error('Closure requires qualified lessons or an explicit no-lesson rationale.');
  if (
    !knowledgeIds.length &&
    (noLessonReason!.trim().split(/\s+/).length < 8 || noLessonReason!.trim().length < 40)
  )
    throw new Error(
      'The no-lesson rationale must explain why this reviewed work adds no qualified reusable insight.',
    );
  const closureIntentPath = safePath(root, `.verythinker/archive-intents/${hash(id)}.json`);
  const savedClosureIntent = existsSync(closureIntentPath)
    ? (JSON.parse(readFileSync(closureIntentPath, 'utf8')) as Record<string, unknown>)
    : {};
  const previousClosureInputs = savedClosureIntent.closure_inputs as
    | {
        knowledge_ids?: unknown;
        no_lesson_reason?: unknown;
        retired_candidates?: { knowledge_id: string; reason: string }[];
      }
    | undefined;
  const sameSavedCandidateDisposition =
    JSON.stringify(previousClosureInputs?.knowledge_ids) === JSON.stringify(knowledgeIds) &&
    (previousClosureInputs?.no_lesson_reason ?? null) === (noLessonReason ?? null);
  const closureInputs = {
    knowledge_ids: knowledgeIds,
    no_lesson_reason: noLessonReason ?? null,
    retired_candidates:
      retired.length || !sameSavedCandidateDisposition
        ? retired.map(({ knowledge_id, reason }) => ({ knowledge_id, reason }))
        : (previousClosureInputs?.retired_candidates ?? []),
  };
  const closureInputsHash = hash(JSON.stringify(closureInputs));
  const recoveredFrozen = acceptedArchiveForWorkflow(root, id);
  const storedSnapshotId = (parent.meta.data.archive as { snapshot_id?: string } | undefined)
    ?.snapshot_id;
  const frozenSnapshotId =
    typeof savedClosureIntent.snapshot_id === 'string'
      ? savedClosureIntent.snapshot_id
      : (storedSnapshotId ?? recoveredFrozen?.snapshot.snapshot_id);
  const frozenSnapshot = typeof frozenSnapshotId === 'string';
  if (typeof frozenSnapshotId === 'string') {
    const snapshotManifest = (
      archiveStatus(root, frozenSnapshotId) as {
        manifest?: {
          workflow_id?: string;
          disposition?: string;
          records?: { id: string; fingerprint: string }[];
        };
      }
    ).manifest;
    if (snapshotManifest?.workflow_id !== id || snapshotManifest?.disposition !== 'accepted')
      throw new Error(
        'The saved frozen snapshot does not belong to this accepted workflow; preserve it and reassess publication.',
      );
    const savedReportId = parent.meta.data.final_report_id ?? savedClosureIntent.report_id ?? null;
    const snapshotRecordsMatch =
      typeof savedReportId === 'string' &&
      [savedReportId, ...knowledgeIds].every((recordId) => {
        const frozen = snapshotManifest?.records?.find((record) => record.id === recordId);
        return frozen && recordFingerprint(getRecord(root, recordId)) === frozen.fingerprint;
      });
    if (typeof savedClosureIntent.closure_inputs_hash === 'string') {
      if (savedClosureIntent.closure_inputs_hash !== closureInputsHash)
        throw new Error(
          'A frozen archive snapshot is bound to different closure inputs; reassess archive publication before changing the report or candidates.',
        );
      if (!snapshotRecordsMatch)
        throw new Error(
          'A frozen archive snapshot no longer matches the saved final report or selected candidates; preserve it and reassess archive publication.',
        );
    } else {
      const savedKnowledgeIds = parent.meta.data.knowledge_ids;
      const savedRetirements = Array.isArray(parent.meta.data.publication_retirements)
        ? parent.meta.data.publication_retirements.map((item) => ({
            knowledge_id: item.knowledge_id,
            reason: item.reason,
          }))
        : [];
      if (
        !Array.isArray(savedKnowledgeIds) ||
        JSON.stringify(savedKnowledgeIds) !== JSON.stringify(knowledgeIds) ||
        (parent.meta.data.no_lesson_reason ?? null) !== (noLessonReason ?? null) ||
        JSON.stringify(savedRetirements) !== JSON.stringify(closureInputs.retired_candidates) ||
        !snapshotRecordsMatch
      )
        throw new Error(
          'The legacy frozen archive snapshot has no matching saved closure-input binding; preserve it and reassess archive publication before retrying.',
        );
    }
  }
  for (const knowledgeId of knowledgeIds) {
    const candidate = getRecord(root, knowledgeId);
    if (
      candidate.meta.type !== 'knowledge' ||
      candidate.meta.data.workflow_id !== id ||
      !candidate.meta.links.some((l) => taskIds.includes(l.target))
    )
      throw new Error('A contribution must link this workflow and one of its reviewed tasks.');
    prepareContribution(root, knowledgeId);
  }
  const candidateBaseline = Object.fromEntries(
    knowledgeIds.map((knowledgeId) => [
      knowledgeId,
      recordFingerprint(getRecord(root, knowledgeId)),
    ]),
  );
  for (const taskId of taskIds)
    if (getRecord(root, taskId).meta.status !== 'accepted') acceptTask(root, taskId);
  const policy = readAutomationPolicy(root);
  const publications: Record<string, unknown>[] = [];
  const blockers: string[] = [];
  let reportBaseline: { id: string; path: string; hash: string } | null = null;
  function assertCurrent(current: ProjectRecord): void {
    if (
      current.meta.revision !== parent.meta.revision ||
      current.meta.data.decision_id !== parent.meta.data.decision_id
    )
      throw new Error(
        'Workflow changed during closure; preserve publication state and reassess the current decision.',
      );
    const findings = decisionProblems(root, current);
    if (strings(current.meta.data.open_questions).length)
      findings.push('Outstanding product questions require clarification.');
    if (JSON.stringify(readAutomationPolicy(root)) !== JSON.stringify(policy))
      findings.push('Automation policy changed during closure.');
    for (const taskId of taskIds) {
      const report = verify(root, taskId, 'accepted');
      if (!report.ok) findings.push(...report.findings.map((f) => `${taskId}: ${f.message}`));
    }
    for (const [candidateId, fingerprint] of Object.entries(candidateBaseline)) {
      if (recordFingerprint(getRecord(root, candidateId)) !== fingerprint)
        findings.push(`Knowledge candidate changed during closure: ${candidateId}`);
      prepareContribution(root, candidateId);
    }
    if (reportBaseline) {
      try {
        const currentReport = getRecord(root, reportBaseline.id);
        if (
          currentReport.path !== reportBaseline.path ||
          hash(readFileSync(safePath(root, currentReport.path))) !== reportBaseline.hash
        )
          findings.push(
            'Final report changed during closure; preserve publication state and reassess.',
          );
      } catch {
        findings.push(
          'Final report is missing during closure; preserve publication state and reassess.',
        );
      }
    }
    if (findings.length) throw new Error(findings.join('\n'));
  }
  assertCurrent(workflow(root, id));
  const decision = getRecord(root, String(parent.meta.data.decision_id));
  const publicationHistory = Array.isArray(parent.meta.data.publication_history)
    ? [...parent.meta.data.publication_history]
    : [];
  const body = `# Objective\n${parent.meta.data.original_requirement}\n\n# Inputs and Sources\nRequirement: ${parent.meta.data.requirement_id}\nTasks: ${taskIds.join(', ')}\n\n# Decisions and Rationale\n${decision.meta.data.summary}\n${decision.meta.data.rationale}\nDecision record: ${decision.meta.id}\n\n# Results\nAll ${taskIds.length} assigned tasks passed current acceptance checks.\nDocumentation and separate review were validated before closure.\n\n# Evidence\n${taskIds.map((taskId) => `Trace ${taskId} for checked baselines, work records, evidence, and review.`).join('\n')}\n\n# Limitations\nThis report records local delivery. External publication state and retry blockers are tracked on the workflow. Native model identity and execution capabilities are limited to recorded observations.\n\n# Lessons\n${knowledgeIds.length ? knowledgeIds.join('\n') : noLessonReason}\n`;
  let reportId =
    typeof parent.meta.data.final_report_id === 'string' ? parent.meta.data.final_report_id : null;
  if (!reportId) {
    if (typeof savedClosureIntent.report_id === 'string')
      reportId = getRecord(root, savedClosureIntent.report_id).meta.id;
    else {
      const historicalReports = (
        Array.isArray(parent.meta.data.history) ? parent.meta.data.history : []
      ).map((item) => item.final_report_id);
      reportId =
        loadRecords(root).find(
          (record) =>
            record.meta.owner === 'manager' &&
            record.meta.title === 'Manager final report' &&
            record.meta.data.workflow_id === id &&
            !historicalReports.includes(record.meta.id),
        )?.meta.id ?? null;
    }
  }
  if (reportId) {
    if (getRecord(root, reportId).body !== body) {
      if (frozenSnapshot)
        throw new Error(
          'A frozen archive snapshot is bound to a different final report; preserve it and reassess archive publication.',
        );
      updateRecord(root, reportId, {}, body);
    }
  } else
    reportId = createRecord(root, {
      type: 'knowledge',
      title: 'Manager final report',
      owner: 'manager',
      data: { kind: 'work-record', workflow_id: id, invocation_id: parent.meta.data.invocation_id },
      links: [{ type: 'documents', target: id }],
      body,
    }).meta.id;
  const report = getRecord(root, reportId);
  const reportHash = hash(readFileSync(safePath(root, report.path)));
  reportBaseline = { id: reportId, path: report.path, hash: reportHash };
  const localDelivery = {
    status: 'complete',
    report_id: reportId,
    report_path: report.path,
    report_hash: reportHash,
    persisted_at:
      (parent.meta.data.local_delivery as Record<string, unknown> | undefined)?.persisted_at ??
      now(),
  };
  const initialPublicationBlockers =
    knowledgeIds.length && policy.automatic_pr && !policy.upstream
      ? ['Configure the shared knowledge upstream once before draft PR submission.']
      : [];
  const initialPublicationDisposition = {
    status: knowledgeIds.length
      ? policy.automatic_pr && policy.upstream
        ? 'queued'
        : policy.automatic_pr
          ? 'blocked'
          : 'prepared-locally'
      : 'not-required',
    knowledge_ids: knowledgeIds,
    publications: [],
    blockers: initialPublicationBlockers,
  };
  updateRecord(
    root,
    id,
    {
      status: 'verified',
      data: {
        phase: managerCompleted ? 'completed-with-blockers' : 'awaiting-native-completion',
        final_report_id: reportId,
        knowledge_ids: knowledgeIds,
        no_lesson_reason: noLessonReason ?? null,
        local_delivery: localDelivery,
        publication_disposition: initialPublicationDisposition,
      },
    },
    undefined,
    assertCurrent,
  );
  parent = workflow(root, id);
  if (readArchivePolicy(root)?.enabled) {
    atomicWrite(
      closureIntentPath,
      JSON.stringify(
        {
          ...savedClosureIntent,
          workflow_id: id,
          report_id: reportId,
          closure_inputs: closureInputs,
          closure_inputs_hash: closureInputsHash,
        },
        null,
        2,
      ) + '\n',
    );
  }
  for (const knowledgeId of knowledgeIds) {
    if (!policy.automatic_pr) {
      publications.push({
        knowledge_id: knowledgeId,
        status: 'prepared-locally',
        reason: 'Project policy disables automatic PRs.',
      });
    } else if (!policy.upstream) {
      blockers.push('Configure the shared knowledge upstream once before draft PR submission.');
      publications.push({ knowledge_id: knowledgeId, status: 'blocked', reason: blockers.at(-1) });
    } else {
      try {
        const submission = publish(root, knowledgeId, policy.upstream) as Record<string, unknown>;
        if (
          submission.status !== 'draft-pr-created' ||
          typeof submission.upstream_pr !== 'string' ||
          !submission.upstream_pr
        )
          throw new Error('Upstream submission did not confirm a draft PR URL.');
        publications.push({ knowledge_id: knowledgeId, status: 'draft-pr-created', ...submission });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        blockers.push(message);
        publications.push({ knowledge_id: knowledgeId, status: 'blocked', reason: message });
      }
    }
  }
  for (const batch of [parent.meta.data.publications, publications])
    if (
      Array.isArray(batch) &&
      batch.length &&
      !publicationHistory.some(
        (entry) => JSON.stringify(entry.publications) === JSON.stringify(batch),
      )
    )
      publicationHistory.push({
        decision_id: parent.meta.data.decision_id,
        recorded_at: now(),
        publications: batch,
      });
  const contributionDisposition = {
    status: blockers.length
      ? 'blocked'
      : !knowledgeIds.length
        ? 'not-required'
        : policy.automatic_pr
          ? 'published'
          : 'prepared-locally',
    knowledge_ids: knowledgeIds,
    publications,
    blockers: [...blockers],
  };
  updateRecord(
    root,
    id,
    {
      data: {
        publication_disposition: contributionDisposition,
        publications,
        publication_history: publicationHistory,
      },
    },
    undefined,
    assertCurrent,
  );
  parent = workflow(root, id);
  const recovered = acceptedArchiveForWorkflow(root, id);
  let archive: unknown = parent.meta.data.archive ?? recovered?.publication ?? null;
  if (managerCompleted && readArchivePolicy(root)?.enabled) {
    const intentPath = safePath(root, `.verythinker/archive-intents/${hash(id)}.json`);
    try {
      assertCurrent(workflow(root, id));
      const priorSnapshot =
        (archive as { snapshot_id?: string } | null)?.snapshot_id ??
        (existsSync(intentPath)
          ? JSON.parse(readFileSync(intentPath, 'utf8')).snapshot_id
          : undefined);
      // Check destination setup before binding an immutable snapshot to it.
      // Injected publishers are offline transaction fixtures, not native publication proof.
      if (!priorSnapshot && archivePublisher === publishArchive)
        assertPrivateArchiveDestination(root);
      const snapshot = priorSnapshot
        ? (archiveStatus(root, priorSnapshot) as { snapshot_id: string })
        : prepareArchive(root, id, { disposition: 'accepted' });
      atomicWrite(
        intentPath,
        JSON.stringify(
          {
            ...(existsSync(intentPath)
              ? JSON.parse(readFileSync(intentPath, 'utf8'))
              : savedClosureIntent),
            workflow_id: id,
            report_id: reportId,
            closure_inputs: closureInputs,
            closure_inputs_hash: closureInputsHash,
            snapshot_id: snapshot.snapshot_id,
          },
          null,
          2,
        ) + '\n',
      );
      const publication = archivePublisher(root, snapshot.snapshot_id);
      archive = { ...publication };
    } catch (error) {
      blockers.push(`Project archive: ${error instanceof Error ? error.message : String(error)}`);
      if (existsSync(intentPath))
        atomicWrite(
          intentPath,
          JSON.stringify(
            { ...JSON.parse(readFileSync(intentPath, 'utf8')), error: blockers.at(-1), at: now() },
            null,
            2,
          ) + '\n',
        );
      // Publication intents live outside frozen records so an interrupted write can retry the same snapshot.
    }
  }
  updateRecord(
    root,
    id,
    {
      status: 'verified',
      data: {
        phase: managerCompleted
          ? blockers.length
            ? 'completed-with-blockers'
            : 'completed'
          : 'awaiting-native-completion',
        closed_at: now(),
        final_report_id: reportId,
        local_delivery: localDelivery,
        publication_disposition: {
          ...contributionDisposition,
          status: blockers.length ? 'blocked' : contributionDisposition.status,
          blockers,
          archive: archive ?? { status: 'not-published' },
        },
        knowledge_ids: knowledgeIds,
        no_lesson_reason: noLessonReason ?? null,
        publications,
        archive,
        publication_history: publicationHistory,
        publication_retirements: [
          ...(Array.isArray(parent.meta.data.publication_retirements)
            ? parent.meta.data.publication_retirements
            : []),
          ...retired
            .filter((disposition) => !savedRetirementReasons.has(disposition.knowledge_id))
            .map((disposition) => ({
              ...disposition,
              retired_at: now(),
              previous_publications: publicationHistory
                .flatMap((entry) => entry.publications)
                .filter(
                  (p: Record<string, unknown>) => p.knowledge_id === disposition.knowledge_id,
                ),
            })),
        ],
      },
    },
    undefined,
    assertCurrent,
  );
  return {
    ...(workflowStatus(root, id) as object),
    final_report: body,
    publication_blockers: blockers,
  };
}
