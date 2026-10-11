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
} from './storage.js';
import {
  acceptTask,
  recordFingerprint,
  requirementsFor,
  requirementScope,
  strings,
  verify,
} from './engineering.js';
import { prepareContribution } from './packs.js';
import { submitContribution } from './contributions.js';
import type { ProjectRecord } from './types.js';

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
export function beginWorkflow(
  root: string,
  input: {
    requirement: string;
    title?: string;
    invocation_id?: string;
    request_id?: string;
  },
): ProjectRecord {
  return withOperationLock(root, 'manager-intake', () => beginWorkflowClaimed(root, input));
}
function beginWorkflowClaimed(
  root: string,
  input: {
    requirement: string;
    title?: string;
    invocation_id?: string;
    request_id?: string;
  },
): ProjectRecord {
  const policy = ensureAutomationPolicy(root);
  if (!policy.manager_enabled) throw new Error('The project manager entrypoint is disabled.');
  const requirement = text(input.requirement, 'Requirement');
  const requestId = text(input.request_id ?? randomUUID(), 'Request ID', 256);
  const title = text(input.title ?? requirement.slice(0, 100), 'Title', 256);
  let parent = loadRecords(root).find(
    (r) => r.meta.data.kind === 'manager-workflow' && r.meta.data.request_id === requestId,
  );
  if (parent && parent.meta.data.original_requirement !== requirement)
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
        invocation_id: input.invocation_id ?? randomUUID(),
        phase: 'intake',
        task_ids: [],
        open_questions: [],
        created_by: 'natural-language-requirement',
      },
      body: `# Objective\n${requirement}\n\n# Resumption\nRead manager_status for the next action.\n`,
    });
  let rootRequirement = loadRecords(root).find(
    (r) => r.meta.type === 'requirement' && r.meta.data.intake_workflow_id === parent!.meta.id,
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
  return parent;
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
  const summary = text(input.summary, 'Summary');
  const rationale = text(input.rationale, 'Rationale');
  const rootRequirement = getRecord(root, String(parent.meta.data.requirement_id));
  if (!strings(rootRequirement.meta.data.acceptance_criteria).length)
    throw new Error('Refine the stakeholder requirement into measurable acceptance criteria.');
  if (strings(parent.meta.data.open_questions).length)
    throw new Error('Resolve recorded product questions before deciding execution.');
  const participants = currentDiscussions(root, id).filter((r) => r.meta.owner !== 'manager');
  if (
    new Set(participants.map((r) => r.meta.owner)).size < 2 ||
    new Set(participants.map((r) => r.meta.data.invocation_id)).size < 2
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
  // Assign documentation responsibility before the task baseline is recorded.
  for (const task of tasks)
    updateRecord(root, task.meta.id, {
      data: {
        workflow_id: id,
        documentation_required: true,
        documentation_paths: task.meta.data.documentation_paths ?? [],
      },
    });
  const readyTasks = ids.map((taskId) => getRecord(root, taskId));
  for (const task of readyTasks) {
    // Dependencies inside this plan may be unaccepted; they gate dispatch, not planning.
    const report = verify(root, task.meta.id, 'design-ready');
    const failures = report.findings.filter(
      (f) => !['dependency-not-accepted', 'dependency-stale'].includes(f.code),
    );
    if (failures.length) throw new Error(failures.map((f) => f.message).join('\n'));
  }
  const requirementIds = requirementAncestry(root, [
    String(parent.meta.data.requirement_id),
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
  if (!id)
    return loadRecords(root)
      .filter((r) => r.meta.data.kind === 'manager-workflow')
      .map((r) => workflowStatus(root, r.meta.id));
  const parent = workflow(root, id);
  const questions = strings(parent.meta.data.open_questions);
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
  let nextAction: string;
  if (questions.length) nextAction = 'Clarify the recorded product questions with the user.';
  else if (decisionFindings.length)
    nextAction = 'Reassess changed requirements/contracts and record a fresh specialist decision.';
  else if (!parent.meta.data.decision_id)
    nextAction =
      'Collect specialist contributions, measurable requirements, reviewed design, and bounded tasks; record the manager decision.';
  else if (taskStates.some((t) => t.status === 'blocked'))
    nextAction =
      'Resolve the recorded blocker internally or report the specific external dependency.';
  else if (taskStates.some((t) => t.status !== 'accepted' || !t.accepted.ok))
    nextAction =
      'Dispatch ready tasks, collect complete documentation/evidence, obtain separate reviews, and accept validated submissions.';
  else if (parent.meta.data.phase === 'completed-with-blockers')
    nextAction =
      'Retry the saved publication blocker when credentials or the upstream become available.';
  else if (parent.meta.data.phase === 'completed')
    nextAction =
      'Deliver the saved final report; resume only for a new requirement or changed baseline.';
  else
    nextAction =
      'Curate qualified lessons and run manager_finish to prepare/submit documentation PRs and write the final report.';
  const phase = questions.length
    ? 'clarification-required'
    : decisionFindings.length
      ? 'reassessment-required'
      : parent.meta.data.decision_id &&
          taskStates.some((t) => t.status !== 'accepted' || !t.accepted.ok)
        ? 'execution'
        : parent.meta.data.phase;
  return {
    workflow_id: id,
    requirement_id: parent.meta.data.requirement_id,
    phase,
    persisted_phase: parent.meta.data.phase,
    policy: readAutomationPolicy(root),
    open_questions: questions,
    decision_findings: decisionFindings,
    tasks: taskStates,
    next_action: nextAction,
    final_report_id: parent.meta.data.final_report_id ?? null,
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
): unknown {
  return withOperationLock(root, `manager-${hash(id)}`, () =>
    finishWorkflowClaimed(root, id, input, publish),
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
): unknown {
  const parent = workflow(root, id);
  if (strings(parent.meta.data.open_questions).length)
    throw new Error('Resolve outstanding product questions before closing the workflow.');
  const decisionFindings = decisionProblems(root, parent);
  if (decisionFindings.length) throw new Error(decisionFindings.join('\n'));
  const taskIds = strings(parent.meta.data.task_ids);
  if (!taskIds.length) throw new Error('Workflow has no assigned tasks.');
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
  for (const disposition of retired) {
    if (
      !previousIds.includes(disposition.knowledge_id) ||
      retiredIds.has(disposition.knowledge_id) ||
      input.knowledge_ids?.includes(disposition.knowledge_id)
    )
      throw new Error(
        'Retire each saved candidate once, without selecting it again for this closure.',
      );
    const reason = text(disposition.reason, 'Candidate retirement reason');
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
    if (findings.length) throw new Error(findings.join('\n'));
  }
  assertCurrent(workflow(root, id));
  const decision = getRecord(root, String(parent.meta.data.decision_id));
  const publicationHistory = Array.isArray(parent.meta.data.publication_history)
    ? [...parent.meta.data.publication_history]
    : [];
  for (const batch of [parent.meta.data.publications, publications]) {
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
  }
  const body = `# Objective\n${parent.meta.data.original_requirement}\n\n# Inputs and Sources\nRequirement: ${parent.meta.data.requirement_id}\nTasks: ${taskIds.join(', ')}\n\n# Decisions and Rationale\n${decision.meta.data.summary}\n${decision.meta.data.rationale}\nDecision record: ${decision.meta.id}\n\n# Results\nAll ${taskIds.length} assigned tasks passed current acceptance checks.\nDocumentation and separate review were validated before closure.\n\n# Evidence\n${taskIds.map((taskId) => `Trace ${taskId} for checked baselines, work records, evidence, and review.`).join('\n')}\n\n# Limitations\n${blockers.length ? blockers.join('\n') : 'Native model identity and execution capabilities are limited to recorded observations.'}\n\n# Lessons\n${knowledgeIds.length ? knowledgeIds.map((knowledgeId) => `${knowledgeId}: ${JSON.stringify(publications.find((p) => p.knowledge_id === knowledgeId))}`).join('\n') : noLessonReason}\n`;
  let reportId =
    typeof parent.meta.data.final_report_id === 'string' ? parent.meta.data.final_report_id : null;
  if (reportId) {
    if (getRecord(root, reportId).body !== body) updateRecord(root, reportId, {}, body);
  } else
    reportId = createRecord(root, {
      type: 'knowledge',
      title: 'Manager final report',
      owner: 'manager',
      data: { kind: 'work-record', workflow_id: id, invocation_id: parent.meta.data.invocation_id },
      links: [{ type: 'documents', target: id }],
      body,
    }).meta.id;
  updateRecord(
    root,
    id,
    {
      status: 'verified',
      data: {
        phase: blockers.length ? 'completed-with-blockers' : 'completed',
        closed_at: now(),
        final_report_id: reportId,
        knowledge_ids: knowledgeIds,
        no_lesson_reason: noLessonReason ?? null,
        publications,
        publication_history: publicationHistory,
        publication_retirements: [
          ...(Array.isArray(parent.meta.data.publication_retirements)
            ? parent.meta.data.publication_retirements
            : []),
          ...retired.map((disposition) => ({
            ...disposition,
            retired_at: now(),
            previous_publications: publicationHistory
              .flatMap((entry) => entry.publications)
              .filter((p: Record<string, unknown>) => p.knowledge_id === disposition.knowledge_id),
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
