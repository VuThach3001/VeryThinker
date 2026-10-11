import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, relative } from 'node:path';
import {
  appendEvent,
  atomicWrite,
  createRecord,
  getRecord,
  hash,
  loadRecords,
  now,
  readConfig,
  resourceRoot,
  safePath,
  saveStatus,
  snapshotPaths,
  updateRecord,
} from './storage.js';
import { ensureIndex } from './indexing.js';
import { listPacks } from './packs.js';
import { assertRouting, readInvocation, readRoutingPolicy, routingProblems } from './routing.js';
import { noteFreshnessProblems } from './notes.js';
import { verifyFrozenRecipe } from './recipes.js';
import { workspaceHistoryProblems, workspaceResumeOperations } from './workspace.js';
import { toolLockProblems } from './tools.js';
import {
  captureEvidenceInputs,
  validateEvidenceInputs,
  evidenceRecordFingerprint,
  type EvidenceInputSnapshot,
} from './evidence-inputs.js';
import type { Finding, Gate, ProjectRecord, Verification } from './types.js';

export const strings = (value: unknown): string[] =>
  Array.isArray(value) && value.every((v) => typeof v === 'string') ? value : [];
export function strictRecord(
  root: string,
  record: ProjectRecord,
  visited = new Set<string>(),
): boolean {
  if (record.meta.data.routing_required === true) return true;
  if (!existsSync(safePath(root, '.verythinker/routing.json'))) return false;
  const byId = new Map(loadRecords(root).map((item) => [item.meta.id, item]));
  function walk(item: ProjectRecord): boolean {
    if (visited.has(item.meta.id)) return false;
    visited.add(item.meta.id);
    if (item.meta.data.routing_required === true) return true;
    return [
      item.meta.data.workflow_id,
      item.meta.data.intake_workflow_id,
      ...item.meta.links.map((link) => link.target),
    ].some((id) => typeof id === 'string' && byId.has(id) && walk(byId.get(id)!));
  }
  return walk(record);
}
function strictExecution(root: string, record: ProjectRecord): boolean {
  return strictRecord(root, record) || readRoutingPolicy(root) !== null;
}
function invocationBinding(record: ProjectRecord): { workflow_id?: string; task_id?: string } {
  const workflow = record.meta.data.workflow_id ?? record.meta.data.intake_workflow_id;
  return {
    ...(typeof workflow === 'string' ? { workflow_id: workflow } : {}),
    ...(record.meta.type === 'task' ? { task_id: record.meta.id } : {}),
  };
}
function authoredRoutingProblems(
  root: string,
  record: ProjectRecord,
  workflowId?: string,
): string[] {
  const expected: Record<string, string[]> = {
    requirement: ['requirements'],
    design: ['architect', 'component-owner'],
    check: ['verifier'],
  };
  if (!expected[record.meta.type]) return [];
  const id = record.meta.data.invocation_id;
  if (typeof id !== 'string') return [`${record.meta.id} has no confirmed native author.`];
  try {
    const receipt = readInvocation(root, id);
    if (!expected[record.meta.type]!.includes(receipt.role))
      return [`${record.meta.id} was not authored by the required Sol role.`];
    return routingProblems(root, receipt.role, id, {
      ...invocationBinding(record),
      ...(workflowId ? { workflow_id: workflowId } : {}),
    }).map((problem) => `${record.meta.id}: ${problem}`);
  } catch (error) {
    return [`${record.meta.id}: ${String(error)}`];
  }
}
function workerInvocations(record: ProjectRecord): string[] {
  const current = record.meta.data.invocation_id;
  return [
    ...strings(record.meta.data.prior_invocation_ids),
    ...(typeof current === 'string' ? [current] : []),
  ];
}
function escalationProblems(root: string, task: ProjectRecord): string[] {
  const attempts = Number(task.meta.data.attempts ?? 0);
  if (attempts <= readConfig(root).repair_attempts && task.meta.data.escalation_required !== true)
    return [];
  const errors: string[] = [];
  const reason = task.meta.data.escalation_reason;
  if (typeof reason !== 'string' || reason.trim().length < 24)
    errors.push('Repeated failure requires substantive Sol diagnosis and reassessment.');
  if (
    task.meta.data.escalation_attempt !== attempts ||
    task.meta.data.escalation_feedback_sha256 !== hash(String(task.meta.data.feedback ?? ''))
  )
    errors.push('Sol reassessment must cover the current repair attempt and feedback.');
  const id = task.meta.data.escalation_invocation_id;
  if (typeof id !== 'string')
    return [...errors, 'Repeated failure needs a confirmed Sol reassessment receipt.'];
  try {
    const receipt = readInvocation(root, id);
    if (!['manager', 'architect', 'component-owner'].includes(receipt.role))
      errors.push('Only a Sol coordinator or designer can diagnose repeated failure.');
    else errors.push(...routingProblems(root, receipt.role, id, invocationBinding(task)));
    if (
      typeof task.meta.data.repair_requested_at === 'string' &&
      Date.parse(receipt.updated_at) < Date.parse(task.meta.data.repair_requested_at)
    )
      errors.push('Sol reassessment predates the latest repair request.');
  } catch (error) {
    errors.push(`Sol reassessment receipt cannot be verified: ${String(error)}`);
  }
  return errors;
}
const workRecordSections = [
  'Objective',
  'Inputs and Sources',
  'Decisions and Rationale',
  'Results',
  'Evidence',
  'Limitations',
  'Lessons',
] as const;
const workRecordScaffolding = [
  'State the assignment, role, task ID, and run identity when available.',
  'Identify baseline, requirements, context records, inspected sources, and requested/observed models.',
  'Record decisions made within authority, assumptions, and escalations.',
  'Describe completed artifacts, current task state, and observed outcomes.',
  'Link checks, results, logs, reviews, and their applicable revision/environment.',
  'Identify failures, unverified claims, unavailable observations, blockers, and the next executable action.',
  'State candidate lessons with conditions of applicability and pointers to supporting evidence.',
  'See linked task and design records.',
  'Review the verification report before acceptance.',
  'Record qualified lessons as separate knowledge records.',
];
function workRecordProblems(root: string, body: string): string[] {
  const headings = [...body.matchAll(/^(#{1,6})\s+(.*?)\s*#*\s*$/gm)];
  const scaffolding = [
    ...workRecordScaffolding,
    ...[
      safePath(root, '.verythinker/templates/work-record.md'),
      join(resourceRoot, 'templates/work-record.md'),
    ]
      .filter((path) => existsSync(path))
      .flatMap((path) =>
        readFileSync(path, 'utf8')
          .replace(/\r\n/g, '\n')
          .split(/^#{1,6}[^\n]*$/gm),
      )
      .map((part) => part.trim())
      .filter(Boolean),
  ].map((part) => part.replace(/\s+/g, ' ').toLowerCase());
  const errors: string[] = [];
  for (const section of workRecordSections) {
    const matches = headings.filter(
      (heading) =>
        heading[2]!
          .replace(/^\d+[.)]\s*/, '')
          .trim()
          .toLowerCase() === section.toLowerCase(),
    );
    if (matches.length !== 1) {
      errors.push(`Work record needs exactly one ${section} section.`);
      continue;
    }
    const heading = matches[0]!;
    const end = headings.find(
      (next) => next.index! > heading.index! && next[1]!.length <= heading[1]!.length,
    )?.index;
    const content = body.slice(heading.index! + heading[0].length, end).trim();
    const words = content.match(/[a-z0-9]+(?:[-_][a-z0-9]+)*/gi) ?? [];
    if (
      words.length < 4 ||
      content.replace(/\s/g, '').length < 24 ||
      /\b(?:TODO|TBD|insert here|fill in|to be completed)\b/i.test(content) ||
      /^(?:[\s\[\]<>.!:,;-]|done|complete|completed|pass|passed|none|n\/a|pending|placeholder|no issues|no limitations)+$/i.test(
        content,
      ) ||
      scaffolding.some((scaffold) =>
        content.replace(/\s+/g, ' ').toLowerCase().includes(scaffold),
      ) ||
      /^Run verythinker trace .* to inspect evidence\.$/i.test(content)
    )
      errors.push(
        `Work record ${section} section needs substantive content, not template scaffolding.`,
      );
  }
  return errors;
}
function documentationPaths(task: ProjectRecord): string[] {
  const value = task.meta.data.documentation_paths;
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((path) => typeof path !== 'string' || !path.trim()))
    throw new Error('documentation_paths must be an array of non-empty project-relative paths.');
  return [...new Set(value as string[])];
}
function documentationSnapshot(root: string, task: ProjectRecord): Record<string, string> {
  const snapshot: Record<string, string> = {};
  for (const path of documentationPaths(task)) {
    const canonicalPath = relative(root, safePath(root, path)).replaceAll('\\', '/');
    const files = snapshotPaths(root, [canonicalPath]);
    if (!Object.keys(files).length)
      throw new Error(`Documentation path contains no files: ${path}`);
    if (Object.keys(files).some((file) => file.startsWith('.verythinker/records/')))
      throw new Error(
        'Documentation paths cannot include managed records; use the linked work record.',
      );
    Object.assign(snapshot, files);
  }
  return snapshot;
}
function documentationProblems(
  root: string,
  task: ProjectRecord,
  records: ProjectRecord[],
): string[] {
  const errors: string[] = [];
  const submission = task.meta.data.submission as Record<string, unknown> | undefined;
  const record = records.find((r) => r.meta.id === submission?.work_record_id);
  if (!record || record.meta.type !== 'knowledge' || record.meta.data.kind !== 'work-record')
    return ['Submission needs its own linked knowledge record with kind: work-record.'];
  if (
    record.meta.owner !== task.meta.owner ||
    record.meta.links.length !== 1 ||
    record.meta.links[0]?.type !== 'documents' ||
    record.meta.links[0]?.target !== task.meta.id ||
    record.meta.data.task_id !== task.meta.id
  )
    errors.push('Submitted work record must be owned by the worker and document only this task.');
  if (
    typeof task.meta.data.invocation_id !== 'string' ||
    !task.meta.data.invocation_id.trim() ||
    record.meta.data.invocation_id !== task.meta.data.invocation_id
  )
    errors.push('Submitted work record does not match the task invocation.');
  if (
    record.meta.data.task_fingerprint !== recordFingerprint(task) ||
    submission?.task_fingerprint !== recordFingerprint(task)
  )
    errors.push('Work record was submitted against a different task baseline.');
  if (
    !submission?.submission_id ||
    record.meta.data.submission_id !== submission.submission_id ||
    record.meta.data.submitted_at !== submission.at ||
    recordFingerprint(record) !== submission.work_record_fingerprint
  )
    errors.push('Work record differs from the latest submitted documentation; resubmit it.');
  const latest = records
    .filter(
      (r) =>
        r.meta.type === 'knowledge' &&
        r.meta.data.kind === 'work-record' &&
        r.meta.owner === task.meta.owner &&
        r.meta.links.some((link) => link.type === 'documents' && link.target === task.meta.id),
    )
    .sort(
      (a, b) =>
        b.meta.created_at.localeCompare(a.meta.created_at) || b.meta.id.localeCompare(a.meta.id),
    )[0];
  if (latest?.meta.id !== record.meta.id)
    errors.push('Submission reuses an older work record; submit the latest documentation.');
  errors.push(...workRecordProblems(root, record.body));
  try {
    if (
      JSON.stringify(documentationSnapshot(root, task)) !==
      JSON.stringify(submission?.documentation_snapshot)
    )
      errors.push('Documentation files changed since submission; resubmit and review them.');
  } catch (error) {
    errors.push((error as Error).message);
  }
  return errors;
}
export function recordFingerprint(record: ProjectRecord): string {
  return evidenceRecordFingerprint(record);
}
export function requirementsFor(task: ProjectRecord): string[] {
  return [
    ...new Set([
      ...strings(task.meta.data.requirements),
      ...task.meta.links.filter((l) => l.type === 'satisfies').map((l) => l.target),
    ]),
  ];
}
export function requirementScope(records: ProjectRecord[], requirementIds: string[]): string[] {
  const byId = new Map(records.map((record) => [record.meta.id, record]));
  const reached = new Set<string>();
  const active = new Set<string>();
  function visit(id: string): void {
    const requirement = byId.get(id);
    if (!requirement || requirement.meta.type !== 'requirement')
      throw new Error(`Requirement ancestry target is missing or is not a requirement: ${id}`);
    if (active.has(id)) throw new Error(`Requirement ancestry contains a cycle: ${id}`);
    if (reached.has(id)) return;
    reached.add(id);
    active.add(id);
    for (const link of requirement.meta.links) if (link.type === 'derives-from') visit(link.target);
    active.delete(id);
  }
  for (const id of requirementIds) visit(id);
  return [...reached];
}
export function dependenciesFor(task: ProjectRecord): string[] {
  return [
    ...new Set([
      ...strings(task.meta.data.dependencies),
      ...task.meta.links.filter((l) => l.type === 'depends-on').map((l) => l.target),
    ]),
  ];
}
export function structuralFindings(records: ProjectRecord[]): Finding[] {
  const findings: Finding[] = [];
  const map = new Map(records.map((r) => [r.meta.id, r]));
  for (const record of records) {
    for (const link of record.meta.links)
      if (!map.has(link.target))
        findings.push({
          code: 'broken-link',
          record: record.meta.id,
          message: `Link target does not exist: ${link.target}`,
        });
    for (const link of record.meta.links) {
      const target = map.get(link.target);
      if (!target) continue;
      const allowed: Record<string, [string[], string[]]> = {
        satisfies: [['design', 'task'], ['requirement']],
        implements: [['task'], ['design', 'requirement']],
        verifies: [['check'], ['requirement', 'design', 'task']],
        'evidence-for': [['evidence'], ['check']],
        reviews: [
          ['review'],
          ['requirement', 'design', 'task', 'check', 'evidence', 'knowledge', 'change', 'problem'],
        ],
        'depends-on': [['task'], ['task']],
      };
      const rule = allowed[link.type];
      if (rule && (!rule[0].includes(record.meta.type) || !rule[1].includes(target.meta.type)))
        findings.push({
          code: 'invalid-link-type',
          record: record.meta.id,
          message: `Invalid ${link.type} relationship from ${record.meta.type} to ${target.meta.type}.`,
        });
    }
    if (record.meta.type === 'task') {
      for (const id of requirementsFor(record))
        if (map.get(id)?.meta.type !== 'requirement')
          findings.push({
            code: 'invalid-requirement',
            record: record.meta.id,
            message: `Requirement reference is missing or has the wrong type: ${id}`,
          });
      for (const id of dependenciesFor(record))
        if (map.get(id)?.meta.type !== 'task')
          findings.push({
            code: 'invalid-dependency',
            record: record.meta.id,
            message: `Dependency is missing or is not a task: ${id}`,
          });
    }
  }
  try {
    requirementScope(
      records,
      records
        .filter((record) => record.meta.type === 'requirement')
        .map((record) => record.meta.id),
    );
  } catch (error) {
    findings.push({ code: 'invalid-requirement-ancestry', message: (error as Error).message });
  }
  const visited = new Set<string>();
  const active = new Set<string>();
  function walk(id: string): void {
    if (active.has(id)) {
      findings.push({
        code: 'dependency-cycle',
        record: id,
        message: 'Task dependencies contain a cycle.',
      });
      return;
    }
    if (visited.has(id)) return;
    active.add(id);
    const r = map.get(id);
    if (r?.meta.type === 'task') for (const dep of dependenciesFor(r)) walk(dep);
    active.delete(id);
    visited.add(id);
  }
  for (const task of records.filter((r) => r.meta.type === 'task')) walk(task.meta.id);
  return findings;
}
export function traceRecord(root: string, id: string, impact = false): unknown {
  ensureIndex(root);
  const records = loadRecords(root);
  getRecord(root, id);
  const outgoing = records.find((r) => r.meta.id === id)!.meta.links;
  const incoming = records.flatMap((r) =>
    r.meta.links
      .filter((l) => l.target === id)
      .map((l) => ({ source: r.meta.id, type: l.type, target: id })),
  );
  const reached = new Set<string>([id]);
  if (impact) {
    let changed = true;
    while (changed) {
      changed = false;
      for (const r of records)
        if (
          !reached.has(r.meta.id) &&
          (r.meta.links.some((l) => reached.has(l.target)) ||
            (r.meta.type === 'task' &&
              [...requirementsFor(r), ...dependenciesFor(r)].some((t) => reached.has(t))))
        ) {
          reached.add(r.meta.id);
          changed = true;
        }
    }
  }
  return {
    id,
    outgoing,
    incoming,
    affected: impact
      ? records
          .filter((r) => reached.has(r.meta.id) && r.meta.id !== id)
          .map((r) => ({ id: r.meta.id, type: r.meta.type, status: r.meta.status }))
      : [],
  };
}
function verificationScope(records: ProjectRecord[], record: ProjectRecord): string[] {
  const ids = new Set<string>([record.meta.id]);
  if (record.meta.type === 'task')
    for (const id of requirementScope(records, requirementsFor(record))) ids.add(id);
  if (record.meta.type === 'requirement')
    for (const id of requirementScope(records, [record.meta.id])) ids.add(id);
  for (const r of records)
    if (
      r.meta.type === 'design' &&
      r.meta.status !== 'superseded' &&
      r.meta.links.some((l) => l.type === 'satisfies' && ids.has(l.target))
    )
      ids.add(r.meta.id);
  return [...ids];
}
function evidenceProblems(
  root: string,
  evidence: ProjectRecord,
  check: ProjectRecord,
  records: ProjectRecord[],
  task: ProjectRecord,
): string[] {
  const d = evidence.meta.data;
  const errors: string[] = [];
  let capturedInputs: ReturnType<typeof validateEvidenceInputs> | undefined;
  if (d.input_snapshot) {
    try {
      capturedInputs = validateEvidenceInputs(root, d.input_snapshot as EvidenceInputSnapshot, {
        files: d.file_baseline as Record<string, string>,
        record_fingerprints: d.record_baseline as Record<string, string>,
        check_id: check.meta.id,
        check_fingerprint: String(d.check_fingerprint),
      });
    } catch (error) {
      errors.push(`Verification input snapshot is invalid: ${String(error)}`);
    }
  } else if (strictRecord(root, task) || strictRecord(root, evidence))
    errors.push(
      'Strict verification evidence needs immutable input capture; rerun the prescribed check.',
    );
  if (strictRecord(root, task) || strictRecord(root, evidence)) {
    const invocation =
      typeof d.execution_invocation_id === 'string' ? d.execution_invocation_id : undefined;
    errors.push(...routingProblems(root, 'check-executor', invocation, invocationBinding(task)));
  }
  if (d.result !== 'pass') errors.push('Evidence result is not pass.');
  if (d.task_id !== task.meta.id) errors.push('Evidence was collected for another task.');
  if (d.check_fingerprint !== recordFingerprint(check))
    errors.push('Check procedure changed after this evidence was collected.');
  const packLock = safePath(root, '.verythinker/pack-lock.json');
  if (d.pack_lock_hash !== (existsSync(packLock) ? hash(readFileSync(packLock)) : null))
    errors.push('Knowledge-pack baseline changed.');
  if (strictRecord(root, task) || strictRecord(root, evidence)) {
    const toolLock = safePath(root, '.verythinker/tool-lock.json');
    if (d.tool_lock_hash !== (existsSync(toolLock) ? hash(readFileSync(toolLock)) : null))
      errors.push('Verification tool baseline changed.');
  }
  if (!d.record_baseline || typeof d.record_baseline !== 'object')
    errors.push('Evidence has no record baseline.');
  else
    for (const [id, fingerprint] of Object.entries(d.record_baseline)) {
      const r = records.find((r) => r.meta.id === id);
      if (!r || recordFingerprint(r) !== fingerprint)
        errors.push(`Record requires reassessment: ${id}`);
    }
  for (const id of verificationScope(records, task))
    if (!(d.record_baseline as Record<string, unknown> | undefined)?.[id])
      errors.push(`Evidence baseline omits required record: ${id}`);
  if (
    !d.file_baseline ||
    typeof d.file_baseline !== 'object' ||
    !Object.keys(d.file_baseline).length
  )
    errors.push('Evidence has no implementation baseline.');
  else
    for (const [path, fingerprint] of Object.entries(d.file_baseline)) {
      try {
        if (
          !existsSync(safePath(root, path)) ||
          hash(readFileSync(safePath(root, path))) !== fingerprint
        )
          errors.push(`Implementation input changed: ${path}`);
      } catch {
        errors.push(`Invalid implementation input: ${path}`);
      }
    }
  try {
    if (
      JSON.stringify(snapshotPaths(root, strings(check.meta.data.baseline_paths))) !==
      JSON.stringify(d.file_baseline)
    )
      errors.push('Implementation baseline membership or content changed.');
  } catch {
    errors.push('Implementation baseline inputs are unavailable.');
  }
  for (const key of ['log_path', 'receipt_path'] as const) {
    try {
      if (typeof d[key] !== 'string' || !existsSync(safePath(root, d[key] as string)))
        errors.push(`Evidence is missing ${key}.`);
    } catch {
      errors.push(`Invalid evidence ${key}.`);
    }
  }
  if (typeof d.log_hash !== 'string') errors.push('Evidence has no log hash.');
  if (typeof d.log_path === 'string' && typeof d.log_hash === 'string') {
    try {
      if (hash(readFileSync(safePath(root, d.log_path))) !== d.log_hash)
        errors.push('Evidence log hash does not match.');
    } catch {
      errors.push('Evidence log is unreadable.');
    }
  }
  if (typeof d.receipt_path === 'string') {
    try {
      const receipt = JSON.parse(readFileSync(safePath(root, d.receipt_path), 'utf8'));
      if (
        receipt.check_id !== check.meta.id ||
        receipt.check_fingerprint !== d.check_fingerprint ||
        receipt.result !== d.result ||
        receipt.log_hash !== d.log_hash ||
        receipt.execution_invocation_id !== d.execution_invocation_id ||
        JSON.stringify(receipt.inspection ?? null) !== JSON.stringify(d.inspection ?? null) ||
        JSON.stringify(receipt.input_snapshot) !== JSON.stringify(d.input_snapshot) ||
        JSON.stringify(receipt.record_baseline) !== JSON.stringify(d.record_baseline) ||
        JSON.stringify(receipt.file_baseline) !== JSON.stringify(d.file_baseline)
      )
        errors.push('Evidence does not match the collected execution receipt.');
    } catch {
      errors.push('Execution receipt is unreadable.');
    }
  }
  if (d.inspection && typeof d.inspection === 'object') {
    try {
      const inspected = d.inspection as { observations: InspectionInput['observations'] };
      for (const observation of inspected.observations)
        for (const source of observation.sources) {
          if (
            source.kind === 'file' &&
            (capturedInputs?.files[source.path] ?? capturedInputs?.context_files[source.path])
              ?.hash !== source.sha256
          )
            errors.push(
              `Inspection source differs from its immutable captured input: ${source.path}`,
            );
          if (
            source.kind === 'file' &&
            hash(readFileSync(safePath(root, source.path))) !== source.sha256
          )
            errors.push(`Inspection source changed: ${source.path}`);
          if (source.kind === 'record') {
            const current = records.find((record) => record.meta.id === source.record_id);
            if (!current || recordFingerprint(current) !== source.fingerprint)
              errors.push(`Inspection source changed: ${source.record_id}`);
          }
        }
    } catch {
      errors.push('Inspection observations or sources are malformed or unavailable.');
    }
  }
  return errors;
}
function reviewBaseline(root: string, target: ProjectRecord, records = loadRecords(root)): string {
  const ids = new Set(verificationScope(records, target));
  if (target.meta.type === 'check')
    for (const link of target.meta.links.filter((link) => link.type === 'verifies')) {
      const referenced = records.find((record) => record.meta.id === link.target);
      if (referenced) {
        for (const id of verificationScope(records, referenced)) ids.add(id);
        if (referenced.meta.type === 'design')
          for (const id of requirementScope(
            records,
            referenced.meta.links
              .filter((item) => item.type === 'satisfies')
              .map((item) => item.target),
          ))
            ids.add(id);
      }
    }
  if (target.meta.type === 'design')
    for (const id of requirementScope(
      records,
      target.meta.links.filter((link) => link.type === 'satisfies').map((link) => link.target),
    ))
      ids.add(id);
  const checks = records.filter(
    (r) =>
      r.meta.type === 'check' &&
      r.meta.status !== 'superseded' &&
      r.meta.links.some((l) => l.type === 'verifies' && ids.has(l.target)),
  );
  const baseline: Record<string, unknown> = {
    records: Object.fromEntries(
      records
        .filter((r) => ids.has(r.meta.id))
        .map((r) => [
          r.meta.id,
          target.meta.type === 'check' && r.meta.type === 'task'
            ? hash(
                JSON.stringify({
                  type: r.meta.type,
                  title: r.meta.title,
                  owner: r.meta.owner,
                  links: r.meta.links,
                  body: r.body,
                  requirements: requirementsFor(r),
                  acceptance_criteria: r.meta.data.acceptance_criteria,
                  allowed_paths: r.meta.data.allowed_paths,
                  dependencies: dependenciesFor(r),
                  protected_acceptance_paths: r.meta.data.protected_acceptance_paths,
                  recipe_instance_ids: r.meta.data.recipe_instance_ids,
                  required_tools: r.meta.data.required_tools,
                }),
              )
            : recordFingerprint(r),
        ]),
    ),
  };
  if (target.meta.type === 'check' || target.meta.type === 'design') {
    const protectedPaths = [
      ...strings(target.meta.data.protected_acceptance_paths),
      ...strings(target.meta.data.oracle_paths),
      ...strings(target.meta.data.verification_artifact_paths),
    ];
    if (protectedPaths.length) baseline.protected_files = snapshotPaths(root, protectedPaths);
  }
  if (target.meta.type === 'task') {
    baseline.checks = checks.map((r) => [r.meta.id, recordFingerprint(r)]);
    baseline.files = snapshotPaths(root, [
      ...new Set(checks.flatMap((c) => strings(c.meta.data.baseline_paths))),
    ]);
    baseline.evidence = checks.map((check) => {
      const e = latestEvidence(records, check.meta.id, target.meta.id);
      return [e?.meta.id ?? null, e ? recordFingerprint(e) : null];
    });
    baseline.submission = target.meta.data.submission ?? null;
    const submission = target.meta.data.submission as Record<string, unknown> | undefined;
    if (submission?.work_record_id || target.meta.data.documentation_required === true) {
      const workRecord = records.find((r) => r.meta.id === submission?.work_record_id);
      baseline.work_record = workRecord
        ? [workRecord.meta.id, recordFingerprint(workRecord)]
        : null;
      baseline.documentation =
        target.meta.data.documentation_required === true ? documentationSnapshot(root, target) : {};
    }
  }
  return hash(JSON.stringify(baseline));
}
function latestEvidence(
  records: ProjectRecord[],
  checkId: string,
  taskId: string,
): ProjectRecord | undefined {
  return records
    .filter(
      (r) =>
        r.meta.type === 'evidence' &&
        r.meta.data.task_id === taskId &&
        r.meta.links.some((l) => l.type === 'evidence-for' && l.target === checkId),
    )
    .sort(
      (a, b) =>
        b.meta.created_at.localeCompare(a.meta.created_at) || b.meta.id.localeCompare(a.meta.id),
    )[0];
}
function hasReview(root: string, target: ProjectRecord, records: ProjectRecord[]): boolean {
  if (strictRecord(root, target) && !readRoutingPolicy(root)) return false;
  let baseline: string;
  try {
    baseline = reviewBaseline(root, target, records);
  } catch {
    return false;
  }
  const reviews = records
    .filter(
      (r) =>
        r.meta.type === 'review' &&
        r.meta.links.some((l) => l.type === 'reviews' && l.target === target.meta.id),
    )
    .sort(
      (a, b) =>
        b.meta.created_at.localeCompare(a.meta.created_at) || b.meta.id.localeCompare(a.meta.id),
    );
  const review = reviews[0];
  if (review && strictRecord(root, review) && !readRoutingPolicy(root)) return false;
  if (
    review &&
    (strictRecord(root, target) || strictRecord(root, review)) &&
    routingProblems(
      root,
      'reviewer',
      typeof review.meta.data.invocation_id === 'string'
        ? review.meta.data.invocation_id
        : undefined,
      invocationBinding(target),
    ).length
  )
    return false;
  return Boolean(
    review &&
    review.meta.owner !== target.meta.owner &&
    review.meta.data.decision === 'pass' &&
    typeof review.meta.data.invocation_id === 'string' &&
    review.meta.data.invocation_id.trim().length > 0 &&
    !workerInvocations(target).includes(review.meta.data.invocation_id) &&
    review.meta.data.target_fingerprint === recordFingerprint(target) &&
    review.meta.data.baseline_hash === baseline &&
    strings(review.meta.data.findings).length === 0,
  );
}
export function hasCurrentReview(root: string, id: string): boolean {
  return hasReview(root, getRecord(root, id), loadRecords(root));
}
export function assignmentReport(
  root: string,
  input: {
    target_ids: string[];
    body: string;
    invocation_id: string;
    covered_invocation_ids?: string[];
  },
): ProjectRecord {
  const problems = workRecordProblems(root, input.body);
  if (problems.length) throw new Error(problems.join('\n'));
  if (!Array.isArray(input.target_ids) || !input.target_ids.length || input.target_ids.length > 32)
    throw new Error('Assignment reports require 1 to 32 target record IDs.');
  const receipt = readInvocation(root, input.invocation_id);
  assertRouting(root, receipt.role, input.invocation_id, { require_completed: false });
  const targets = [...new Set(input.target_ids)].map((id) => getRecord(root, id));
  if (!receipt.workflow_id)
    throw new Error('Assignment reports require a managed workflow binding.');
  if (receipt.task_id && !input.target_ids.includes(receipt.task_id))
    throw new Error('The report must document its assigned task.');
  for (const id of input.covered_invocation_ids ?? []) {
    const prior = readInvocation(root, id);
    if (
      prior.workflow_id !== receipt.workflow_id ||
      prior.role !== receipt.role ||
      prior.task_id !== receipt.task_id
    )
      throw new Error('A follow-up report cannot cover another role, workflow, or task.');
    assertRouting(root, prior.role, id, { workflow_id: receipt.workflow_id });
  }
  const identity = hash(
    JSON.stringify({
      invocation_id: receipt.id,
      targets: input.target_ids,
      body: input.body,
      covered: input.covered_invocation_ids ?? [],
    }),
  );
  const existing = loadRecords(root).find(
    (record) => record.meta.data.assignment_report_hash === identity,
  );
  if (existing) return existing;
  return createRecord(root, {
    type: 'knowledge',
    title: `${receipt.role} assignment report`,
    owner: receipt.role,
    links: targets.map((record) => ({ type: 'documents', target: record.meta.id })),
    data: {
      kind: 'work-record',
      assignment_report_hash: identity,
      workflow_id: receipt.workflow_id,
      task_id: receipt.task_id,
      invocation_id: receipt.id,
      covered_invocation_ids: input.covered_invocation_ids ?? [],
      requested_model: receipt.requested_model,
      confirmed_model: receipt.confirmed_model,
    },
    body: input.body,
  });
}
export function assignmentDocumentationProblems(root: string, workflowId: string): string[] {
  const path = safePath(root, '.verythinker/native/receipts');
  if (!existsSync(path)) return [];
  const reports = loadRecords(root).filter(
    (record) =>
      record.meta.data.kind === 'work-record' && record.meta.data.workflow_id === workflowId,
  );
  const problems: string[] = [];
  for (const file of readdirSync(path).filter((file) => /^[a-f0-9-]{36}\.json$/.test(file))) {
    const receipt = readInvocation(root, file.slice(0, -5));
    if (
      receipt.workflow_id !== workflowId ||
      receipt.role === 'manager' ||
      receipt.execution_mode !== 'native' ||
      receipt.state !== 'completed'
    )
      continue;
    const candidates = reports.filter(
      (report) =>
        report.meta.owner === receipt.role &&
        (report.meta.data.invocation_id === receipt.id ||
          strings(report.meta.data.covered_invocation_ids).includes(receipt.id)),
    );
    if (!candidates.some((report) => workRecordProblems(root, report.body).length === 0))
      problems.push(
        `Completed ${receipt.role} invocation ${receipt.id} needs its seven-section assignment report.`,
      );
  }
  return problems;
}
export function verify(
  root: string,
  id?: string,
  gate: Gate = 'accepted',
  ancestry = new Set<string>(),
): Verification {
  ensureIndex(root);
  const records = loadRecords(root);
  const findings = structuralFindings(records);
  const config = readConfig(root);
  const packs = listPacks(root) as { installed: { id: string; integrity: string }[] };
  for (const pack of packs.installed)
    if (pack.integrity !== 'valid')
      findings.push({
        code: 'pack-integrity',
        message: `Locked knowledge pack is changed or missing: ${pack.id}`,
      });
  const tasks = id
    ? [getRecord(root, id)]
    : records.filter((r) => r.meta.type === 'task' && r.meta.status !== 'superseded');
  if (!tasks.length)
    findings.push({ code: 'no-tasks', message: 'Create a task before verifying completion.' });
  for (const task of tasks) {
    if (task.meta.type !== 'task') {
      findings.push({
        code: 'not-task',
        record: task.meta.id,
        message: 'Completion gates apply to task records.',
      });
      continue;
    }
    const add = (code: string, message: string) =>
      findings.push({ code, record: task.meta.id, message });
    const strict = strictRecord(root, task);
    if (strict) for (const problem of toolLockProblems(root)) add('tool-integrity', problem);
    if (strict && !readRoutingPolicy(root))
      add(
        'native-routing-missing',
        'The strict routing policy is missing; restore the approved policy before continuing.',
      );
    for (const problem of noteFreshnessProblems(root, task)) add('knowledge-freshness', problem);
    for (const problem of verifyFrozenRecipe(root, task)) add('protected-recipe', problem);
    for (const problem of workspaceHistoryProblems(root, task)) add('workspace-history', problem);
    const reqs = requirementsFor(task);
    if (!reqs.length) add('missing-requirements', 'Task must link at least one requirement.');
    if (!strings(task.meta.data.acceptance_criteria).length)
      add('missing-acceptance', 'Task needs explicit acceptance criteria.');
    if (!strings(task.meta.data.allowed_paths).length)
      add('missing-scope', 'Task needs project-relative allowed_paths.');
    if (task.meta.data.documentation_required === true) {
      if (typeof task.meta.data.workflow_id !== 'string' || !task.meta.data.workflow_id.trim())
        add('missing-workflow', 'Documentation-required tasks need their workflow_id.');
      try {
        for (const path of documentationPaths(task)) safePath(root, path);
      } catch (error) {
        add('invalid-documentation-path', (error as Error).message);
      }
    }
    for (const path of strings(task.meta.data.allowed_paths))
      try {
        safePath(root, path);
      } catch {
        add('invalid-scope', `Invalid allowed path: ${path}`);
      }
    for (const dep of dependenciesFor(task)) {
      if (records.find((r) => r.meta.id === dep)?.meta.status !== 'accepted')
        add('dependency-not-accepted', `Dependency is not accepted: ${dep}`);
      else if (ancestry.has(dep) || dep === task.meta.id)
        add('dependency-cycle', `Dependency cycle reaches ${dep}`);
      else if (!verify(root, dep, 'accepted', new Set([...ancestry, task.meta.id])).ok)
        add('dependency-stale', `Dependency requires reassessment: ${dep}`);
    }
    if (task.meta.status === 'blocked' && gate !== 'ready') add('blocked', 'Task is blocked.');
    let scope: string[];
    try {
      scope = verificationScope(records, task);
    } catch (error) {
      add('invalid-requirement-ancestry', (error as Error).message);
      continue;
    }
    const designs = records.filter(
      (r) =>
        r.meta.type === 'design' && r.meta.status !== 'superseded' && scope.includes(r.meta.id),
    );
    const checks = records.filter(
      (r) =>
        r.meta.type === 'check' &&
        r.meta.status !== 'superseded' &&
        r.meta.links.some((l) => l.type === 'verifies' && scope.includes(l.target)),
    );
    if (strict) {
      for (const problem of escalationProblems(root, task))
        add('missing-sol-reassessment', problem);
      const workflowId =
        typeof task.meta.data.workflow_id === 'string' ? task.meta.data.workflow_id : undefined;
      for (const source of records
        .filter(
          (record) =>
            scope.includes(record.meta.id) && ['requirement', 'design'].includes(record.meta.type),
        )
        .concat(checks))
        for (const problem of authoredRoutingProblems(root, source, workflowId))
          add('native-author', problem);
      for (const check of checks)
        if (!hasReview(root, check, records))
          add(
            'missing-verification-plan-review',
            `Verification plan needs current Sol independent review: ${check.meta.id}`,
          );
      if (['verified', 'accepted'].includes(gate))
        for (const problem of routingProblems(
          root,
          task.meta.owner,
          typeof task.meta.data.invocation_id === 'string'
            ? task.meta.data.invocation_id
            : undefined,
          invocationBinding(task),
        ))
          add('native-worker', problem);
    }
    for (const req of reqs) {
      if (!checks.some((c) => c.meta.links.some((l) => l.type === 'verifies' && l.target === req)))
        add('missing-check', `Requirement lacks a verification procedure: ${req}`);
      const r = records.find((r) => r.meta.id === req);
      if (r && !strings(r.meta.data.acceptance_criteria).length)
        add('requirement-not-measurable', `Requirement needs acceptance criteria: ${req}`);
    }
    if (gate === 'ready') continue;
    if (config.profile !== 'basic')
      for (const req of reqs)
        if (
          !designs.some((d) => d.meta.links.some((l) => l.type === 'satisfies' && l.target === req))
        )
          add('missing-design', `Requirement lacks design allocation: ${req}`);
    if (
      config.profile === 'embedded' &&
      !designs.some((d) => d.meta.data.hardware_software_interface)
    )
      add('missing-hsi', 'Embedded tasks require a recorded hardware–software interface.');
    for (const design of designs)
      if (!hasReview(root, design, records))
        add(
          'missing-design-review',
          `Design needs a current independent review: ${design.meta.id}`,
        );
    if (gate === 'design-ready') continue;
    for (const check of checks) {
      const evidence = latestEvidence(records, check.meta.id, task.meta.id);
      const errors = evidence
        ? evidenceProblems(root, evidence, check, records, task)
        : ['no collected evidence'];
      if (errors.length) add('missing-valid-evidence', `${check.meta.id}: ${errors.join('; ')}`);
    }
    if (!checks.length) add('missing-checks', 'No checks apply to this task.');
    if (gate === 'verified') continue;
    if (!['submitted', 'accepted'].includes(task.meta.status))
      add('not-submitted', 'Task must be submitted before acceptance.');
    if (!hasReview(root, task, records))
      add(
        'missing-independent-review',
        'Need a passing independent review of the current submission, requirements, design, implementation and evidence, with no open findings.',
      );
    if (!task.meta.data.submission)
      add('missing-submission', 'Task needs a recorded worker submission.');
    if (task.meta.data.documentation_required === true)
      for (const problem of documentationProblems(root, task, records))
        add('invalid-work-record', problem);
  }
  return { ok: findings.length === 0, gate, findings, checked_at: now() };
}
function assertDispatchReadiness(
  root: string,
  task: ProjectRecord,
  recoveryInvocationId?: string,
): void {
  if (readRoutingPolicy(root) && !strictRecord(root, task))
    throw new Error(
      'Pending legacy work requires alpha.3 migration and Sol reassessment before dispatch.',
    );
  const report = verify(root, task.meta.id, strictExecution(root, task) ? 'design-ready' : 'ready');
  const recovered = recoveryInvocationId
    ? workspaceResumeOperations(root, task, recoveryInvocationId)
    : [];
  // A blocked lifecycle can be resumed only after every substantive gate is current.
  const failures = report.findings.filter(
    (finding) =>
      finding.code !== 'blocked' &&
      !(
        finding.code === 'workspace-history' &&
        recovered.some(
          (id) =>
            finding.message ===
            `File-write operation ${id} is incomplete; recover the same payload before verification.`,
        )
      ),
  );
  if (failures.length) throw new Error(failures.map((finding) => finding.message).join('\n'));
}
export function startTask(
  root: string,
  id: string,
  requestedModel?: string,
  confirmedModel?: string,
  invocationId: string = randomUUID(),
): ProjectRecord {
  return startTaskWithRecovery(root, id, requestedModel, confirmedModel, invocationId);
}
function startTaskWithRecovery(
  root: string,
  id: string,
  requestedModel: string | undefined,
  confirmedModel: string | undefined,
  invocationId: string,
  recoverInterruptedWrites = false,
): ProjectRecord {
  if (typeof invocationId !== 'string' || !invocationId.trim())
    throw new Error('Task execution needs a non-empty invocation identity.');
  const task = getRecord(root, id);
  if (strictExecution(root, task)) {
    const receipt = assertRouting(root, task.meta.owner, invocationId, {
      ...invocationBinding(task),
      require_completed: false,
    });
    requestedModel = receipt!.requested_model;
    confirmedModel = receipt!.confirmed_model ?? undefined;
  }
  if (task.meta.type !== 'task' || !['draft', 'ready', 'blocked'].includes(task.meta.status))
    throw new Error('Only draft, ready, or blocked tasks can start.');
  if (!strictExecution(root, task) && task.meta.data.escalation_required && !requestedModel)
    throw new Error(
      'Repeated failure requires an explicit coordinator-selected model before restarting.',
    );
  assertDispatchReadiness(root, task, recoverInterruptedWrites ? invocationId : undefined);
  const config = readConfig(root);
  if (
    loadRecords(root).filter((r) => r.meta.type === 'task' && r.meta.status === 'in-progress')
      .length >= config.max_workers
  )
    throw new Error('Concurrent worker limit reached.');
  return updateRecord(
    root,
    id,
    {
      status: 'in-progress',
      data: {
        invocation_id: invocationId,
        requested_model: requestedModel ?? null,
        confirmed_model: confirmedModel ?? null,
        blocked_reason: null,
        ...(task.meta.status === 'blocked' ||
        (typeof task.meta.data.invocation_id === 'string' &&
          task.meta.data.invocation_id.trim() &&
          task.meta.data.invocation_id !== invocationId)
          ? {
              prior_invocation_ids: [
                ...new Set([
                  ...strings(task.meta.data.prior_invocation_ids),
                  ...(typeof task.meta.data.invocation_id === 'string' &&
                  task.meta.data.invocation_id.trim()
                    ? [task.meta.data.invocation_id]
                    : []),
                ]),
              ],
              resumed_at: now(),
            }
          : {}),
      },
    },
    undefined,
    (current) => {
      if (
        current.meta.revision !== task.meta.revision ||
        !['draft', 'ready', 'blocked'].includes(current.meta.status)
      )
        throw new Error('Task changed before it could start.');
      if (
        loadRecords(root).filter((r) => r.meta.type === 'task' && r.meta.status === 'in-progress')
          .length >= readConfig(root).max_workers
      )
        throw new Error('Concurrent worker limit reached.');
      assertDispatchReadiness(root, current, recoverInterruptedWrites ? invocationId : undefined);
    },
  );
}
export function resumeTask(
  root: string,
  id: string,
  requestedModel?: string,
  confirmedModel?: string,
  invocationId?: string,
): ProjectRecord {
  if (invocationId !== undefined && (typeof invocationId !== 'string' || !invocationId.trim()))
    throw new Error('Task execution needs a non-empty invocation identity.');
  const task = getRecord(root, id);
  if (task.meta.type !== 'task') throw new Error('Resume requires a task.');
  if (strictExecution(root, task)) {
    const receipt = assertRouting(
      root,
      task.meta.owner,
      invocationId ??
        (typeof task.meta.data.invocation_id === 'string'
          ? task.meta.data.invocation_id
          : undefined),
      { ...invocationBinding(task), require_completed: false },
    );
    requestedModel = receipt!.requested_model;
    confirmedModel = receipt!.confirmed_model ?? undefined;
  }
  if (task.meta.status === 'in-progress') {
    if (strictExecution(root, task)) assertDispatchReadiness(root, task, invocationId);
    if (invocationId === undefined || invocationId === task.meta.data.invocation_id) return task;
    return updateRecord(
      root,
      id,
      {
        data: {
          invocation_id: invocationId,
          requested_model: requestedModel ?? task.meta.data.requested_model ?? null,
          confirmed_model: confirmedModel ?? null,
          prior_invocation_ids: [
            ...new Set([
              ...strings(task.meta.data.prior_invocation_ids),
              ...(typeof task.meta.data.invocation_id === 'string' &&
              task.meta.data.invocation_id.trim()
                ? [task.meta.data.invocation_id]
                : []),
            ]),
          ],
          resumed_at: now(),
        },
      },
      undefined,
      (current) => {
        if (current.meta.revision !== task.meta.revision || current.meta.status !== 'in-progress')
          throw new Error('Task changed before its invocation handoff could be recorded.');
        if (strictExecution(root, current)) assertDispatchReadiness(root, current, invocationId);
      },
    );
  }
  if (task.meta.status !== 'blocked')
    throw new Error('Only interrupted in-progress or blocked work can resume.');
  if (task.meta.data.escalation_required && !requestedModel)
    throw new Error(
      'Repeated failure requires an explicit coordinator-selected model before resuming.',
    );
  return startTaskWithRecovery(
    root,
    id,
    requestedModel ?? (task.meta.data.requested_model as string | undefined),
    confirmedModel,
    invocationId ?? randomUUID(),
    true,
  );
}
export function requestRepair(root: string, id: string, feedback: string): ProjectRecord {
  const task = getRecord(root, id);
  if (
    task.meta.type !== 'task' ||
    !['in-progress', 'submitted', 'failed'].includes(task.meta.status)
  )
    throw new Error('Repair feedback applies to in-progress, submitted or failed tasks.');
  if (!feedback.trim()) throw new Error('Repair feedback is required.');
  const attempts = Number(task.meta.data.attempts ?? 0) + 1;
  const blocked = attempts > readConfig(root).repair_attempts;
  return updateRecord(
    root,
    id,
    {
      status: blocked ? 'blocked' : 'ready',
      data: {
        attempts,
        feedback,
        repair_requested_at: now(),
        submission: null,
        escalation_required: blocked,
        blocked_reason: blocked ? 'Repeated failure requires coordinator escalation.' : null,
      },
    },
    undefined,
    (current) => {
      if (current.meta.revision !== task.meta.revision)
        throw new Error('Task changed before repair feedback could be recorded.');
    },
  );
}
export function submitTask(
  root: string,
  id: string,
  summary: string,
  workRecordBody?: string,
): ProjectRecord {
  const task = getRecord(root, id);
  if (task.meta.type !== 'task' || task.meta.status !== 'in-progress')
    throw new Error('Only an in-progress task can be submitted.');
  if (strictExecution(root, task))
    assertRouting(
      root,
      task.meta.owner,
      typeof task.meta.data.invocation_id === 'string' ? task.meta.data.invocation_id : undefined,
      { ...invocationBinding(task), require_completed: false },
    );
  if (!summary.trim()) throw new Error('A submission summary is required.');
  if (workRecordBody !== undefined && typeof workRecordBody !== 'string')
    throw new Error('Work record body must be a string.');
  const required = task.meta.data.documentation_required === true;
  if (required) {
    if (workRecordBody === undefined)
      throw new Error(
        'This task requires a substantive seven-section work record before submission.',
      );
    const problems = workRecordProblems(root, workRecordBody);
    if (problems.length) throw new Error(problems.join('\n'));
    if (typeof task.meta.data.invocation_id !== 'string' || !task.meta.data.invocation_id.trim())
      throw new Error('Documentation-required tasks need the worker invocation identity.');
    if (typeof task.meta.data.workflow_id !== 'string' || !task.meta.data.workflow_id.trim())
      throw new Error('Documentation-required tasks need their workflow_id.');
  }
  const documentation = required ? documentationSnapshot(root, task) : {};
  const taskFingerprint = recordFingerprint(task);
  const submissionId = randomUUID();
  const at = now();
  const workRecord = createRecord(root, {
    type: 'knowledge',
    title: `Work record: ${task.meta.title}`,
    owner: task.meta.owner,
    data: {
      kind: 'work-record',
      task_id: id,
      task_fingerprint: taskFingerprint,
      submission_id: submissionId,
      submitted_at: at,
      workflow_id: task.meta.data.workflow_id ?? null,
      invocation_id: task.meta.data.invocation_id,
      requested_model: task.meta.data.requested_model ?? null,
      confirmed_model: task.meta.data.confirmed_model ?? null,
    },
    links: [{ type: 'documents', target: id }],
    body:
      workRecordBody ??
      `# Objective\n${task.meta.title}\n\n# Inputs and Sources\n${requirementsFor(task).join('\n')}\n\n# Decisions and Rationale\nSee linked task and design records.\n\n# Results\n${summary}\n\n# Evidence\nRun verythinker trace ${id} to inspect evidence.\n\n# Limitations\nReview the verification report before acceptance.\n\n# Lessons\nRecord qualified lessons as separate knowledge records.\n`,
  });
  const workRecordFingerprint = recordFingerprint(getRecord(root, workRecord.meta.id));
  return updateRecord(
    root,
    id,
    {
      status: 'submitted',
      data: {
        submission: {
          summary,
          at,
          submission_id: submissionId,
          task_fingerprint: taskFingerprint,
          work_record_id: workRecord.meta.id,
          work_record_fingerprint: workRecordFingerprint,
          documentation_snapshot: documentation,
        },
      },
    },
    undefined,
    (current) => {
      if (current.meta.status !== 'in-progress' || recordFingerprint(current) !== taskFingerprint)
        throw new Error('Task changed before submission; inspect the work record and resubmit.');
      if (recordFingerprint(getRecord(root, workRecord.meta.id)) !== workRecordFingerprint)
        throw new Error('Work record changed before submission; inspect it and resubmit.');
      if (
        required &&
        JSON.stringify(documentationSnapshot(root, current)) !== JSON.stringify(documentation)
      )
        throw new Error('Documentation changed before submission; inspect it and resubmit.');
    },
  );
}
export function acceptTask(root: string, id: string): ProjectRecord {
  const result = verify(root, id, 'accepted');
  if (!result.ok) throw new Error(result.findings.map((f) => f.message).join('\n'));
  return saveStatus(root, id, 'accepted', () => {
    const current = verify(root, id, 'accepted');
    if (!current.ok) throw new Error(current.findings.map((f) => f.message).join('\n'));
  });
}
export function reviewTask(
  root: string,
  id: string,
  owner: string,
  decision: 'pass' | 'fail',
  findings: string[] = [],
  invocationId: string = randomUUID(),
): ProjectRecord {
  const task = getRecord(root, id);
  if (task.meta.type !== 'task') throw new Error('Review target must be a task.');
  if (!['submitted', 'accepted'].includes(task.meta.status))
    throw new Error('Submit the task before recording its acceptance review.');
  return reviewRecord(root, id, owner, decision, findings, invocationId);
}
export function reviewRecord(
  root: string,
  id: string,
  owner: string,
  decision: 'pass' | 'fail',
  findings: string[] = [],
  invocationId: string = randomUUID(),
  generalizationReview = false,
): ProjectRecord {
  const target = getRecord(root, id);
  if (strictExecution(root, target))
    assertRouting(root, 'reviewer', invocationId, {
      ...invocationBinding(target),
      require_completed: false,
    });
  if (target.meta.type === 'task' && !['submitted', 'accepted'].includes(target.meta.status))
    throw new Error('Submit the task before recording its acceptance review.');
  if (owner === target.meta.owner || workerInvocations(target).includes(invocationId))
    throw new Error('Review must use a different owner and invocation.');
  if (
    !['pass', 'fail'].includes(decision) ||
    !Array.isArray(findings) ||
    findings.some((f) => typeof f !== 'string') ||
    typeof invocationId !== 'string' ||
    !invocationId.trim()
  )
    throw new Error('Review needs a decision, findings array and invocation ID.');
  if (decision === 'pass' && findings.length)
    throw new Error(
      'A passing review requires findings: []; findings are unresolved defects. Put approval rationale and observations in the assignment report.',
    );
  const records = loadRecords(root);
  if (
    target.meta.type === 'task' &&
    target.meta.data.documentation_required === true &&
    decision === 'pass'
  ) {
    const problems = documentationProblems(root, target, records);
    if (problems.length) throw new Error(problems.join('\n'));
  }
  const targetFingerprint = recordFingerprint(target);
  const baseline = reviewBaseline(root, target, records);
  const current = getRecord(root, id);
  if (
    recordFingerprint(current) !== targetFingerprint ||
    reviewBaseline(root, current) !== baseline
  )
    throw new Error('Review inputs changed before the review could be recorded.');
  return createRecord(root, {
    type: 'review',
    title: `Review: ${target.meta.title}`,
    owner,
    status: 'reviewed',
    links: [{ type: 'reviews', target: id }],
    data: {
      decision,
      findings,
      target_fingerprint: targetFingerprint,
      baseline_hash: baseline,
      invocation_id: invocationId,
      generalization_review: generalizationReview,
    },
    body: `# Scope\n${id}\n\n# Decision\n${decision}\n\n# Findings\n${findings.length ? findings.join('\n') : 'No open findings reported.'}\n`,
  });
}
export type InspectionSource =
  | { kind: 'file'; path: string; sha256: string; locator?: string }
  | { kind: 'record'; record_id: string; fingerprint: string; locator?: string };
export interface InspectionInput {
  observations: {
    item_id: string;
    outcome: 'pass' | 'fail' | 'gap';
    observation: string;
    sources: InspectionSource[];
  }[];
  limitations: string[];
}

function checkedInspection(
  root: string,
  check: ProjectRecord,
  task: ProjectRecord,
  records: ProjectRecord[],
  scope: string[],
  files: Record<string, string>,
  input: InspectionInput,
): { observations: object[]; records: ProjectRecord[]; files: string[]; limitations: string[] } {
  const items = check.meta.data.inspection_items;
  if (
    !String(check.meta.data.method ?? '').includes('inspection') ||
    strings(check.meta.data.command).length ||
    !Array.isArray(items) ||
    !items.length ||
    items.length > 64
  )
    throw new Error(
      'Inspection requires a reviewed inspection method and item rubric, without an executable command.',
    );
  const rubric = new Map<string, Record<string, unknown>>();
  for (const item of items) {
    if (
      !item ||
      typeof item !== 'object' ||
      typeof item.id !== 'string' ||
      !item.id.trim() ||
      rubric.has(item.id) ||
      typeof item.criterion !== 'string' ||
      !item.criterion.trim() ||
      typeof item.expected !== 'string' ||
      !item.expected.trim()
    )
      throw new Error(
        'Inspection rubric needs unique IDs, criteria and authoritative expected outcomes.',
      );
    rubric.set(item.id, item);
  }
  if (
    !input ||
    !Array.isArray(input.observations) ||
    input.observations.length !== rubric.size ||
    !Array.isArray(input.limitations) ||
    !input.limitations.length ||
    input.limitations.length > 32 ||
    input.limitations.some(
      (text) => typeof text !== 'string' || !text.trim() || text.length > 16000,
    )
  )
    throw new Error('Inspection needs every reviewed item and explicit limitations.');
  const applicableCheckIds = new Set(
    records
      .filter(
        (record) =>
          record.meta.type === 'check' &&
          record.meta.links.some((link) => link.type === 'verifies' && scope.includes(link.target)),
      )
      .map((record) => record.meta.id),
  );
  const allowed = records.filter(
    (record) =>
      scope.includes(record.meta.id) ||
      record.meta.id === check.meta.id ||
      record.meta.data.task_id === task.meta.id ||
      (record.meta.type === 'review' &&
        record.meta.links.some(
          (link) =>
            link.type === 'reviews' &&
            (scope.includes(link.target) || applicableCheckIds.has(link.target)),
        )) ||
      (record.meta.data.workflow_id === task.meta.data.workflow_id &&
        record.meta.links.some(
          (link) =>
            ['verifies', 'documents', 'reviews', 'references'].includes(link.type) &&
            (scope.includes(link.target) || link.target === check.meta.id),
        )),
  );
  const byId = new Map(allowed.map((record) => [record.meta.id, record]));
  const allowedFiles = new Set(Object.keys(files));
  for (const record of allowed) {
    for (const field of [
      'verification_artifact_paths',
      'oracle_paths',
      'protected_acceptance_paths',
    ])
      for (const path of strings(record.meta.data[field]))
        allowedFiles.add(path);
    for (const field of ['artifact_path', 'log_path', 'receipt_path'])
      if (typeof record.meta.data[field] === 'string')
        allowedFiles.add(record.meta.data[field] as string);
    for (const field of ['artifact_hashes', 'file_baseline'])
      if (record.meta.data[field] && typeof record.meta.data[field] === 'object')
        for (const path of Object.keys(record.meta.data[field] as object)) allowedFiles.add(path);
  }
  const seen = new Set<string>(),
    sourceRecords = new Map<string, ProjectRecord>(),
    sourceFiles = new Set<string>();
  const observations = input.observations.map((observation) => {
    const item = rubric.get(observation?.item_id);
    if (
      !item ||
      seen.has(observation.item_id) ||
      !['pass', 'fail', 'gap'].includes(observation.outcome) ||
      typeof observation.observation !== 'string' ||
      observation.observation.trim().length < 20 ||
      observation.observation.length > 16000 ||
      !Array.isArray(observation.sources) ||
      !observation.sources.length ||
      observation.sources.length > 16
    )
      throw new Error(
        'Inspection observations need exact unique reviewed IDs, outcomes, substantive observations and bounded sources.',
      );
    seen.add(observation.item_id);
    for (const source of observation.sources) {
      if (
        !source ||
        (source.locator !== undefined &&
          (typeof source.locator !== 'string' || source.locator.length > 2000))
      )
        throw new Error('Inspection source locator is invalid.');
      if (source.kind === 'file') {
        if (
          !allowedFiles.has(source.path) ||
          !/^[a-f0-9]{64}$/.test(source.sha256) ||
          hash(readFileSync(safePath(root, source.path))) !== source.sha256
        )
          throw new Error(
            `Inspection file source is outside the verification inputs or changed: ${source.path}`,
          );
        sourceFiles.add(source.path);
      } else if (source.kind === 'record') {
        const record = byId.get(source.record_id);
        if (!record || source.fingerprint !== recordFingerprint(record))
          throw new Error(
            `Inspection record source is outside the task scope or changed: ${source.record_id}`,
          );
        sourceRecords.set(record.meta.id, record);
      } else
        throw new Error('Inspection source must identify a current file or engineering record.');
    }
    return {
      item_id: item.id,
      criterion: item.criterion,
      expected: item.expected,
      outcome: observation.outcome,
      observation: observation.observation.trim(),
      sources: observation.sources.map((source) => ({ ...source })),
    };
  });
  return {
    observations,
    records: [...sourceRecords.values()],
    files: [...sourceFiles],
    limitations: [...input.limitations],
  };
}

export function runCheck(
  root: string,
  id: string,
  taskId: string,
  invocationId?: string,
): ProjectRecord {
  return collectVerification(root, id, taskId, invocationId);
}
export function inspectCheck(
  root: string,
  id: string,
  taskId: string,
  input: InspectionInput,
  invocationId?: string,
): ProjectRecord {
  if (!input || !Array.isArray(input.observations))
    throw new Error('Inspection collection requires an observation payload.');
  return collectVerification(root, id, taskId, invocationId, input);
}
function collectVerification(
  root: string,
  id: string,
  taskId: string,
  invocationId?: string,
  inspection?: InspectionInput,
): ProjectRecord {
  const check = getRecord(root, id);
  const task = getRecord(root, taskId);
  if (check.meta.type !== 'check' || task.meta.type !== 'task')
    throw new Error('Provide a check and a task.');
  if (strictExecution(root, task)) {
    if (!readRoutingPolicy(root)) throw new Error('Strict routing policy is missing.');
    const executor = assertRouting(root, 'check-executor', invocationId, {
      ...invocationBinding(task),
      require_completed: false,
    });
    if (inspection && executor?.state !== 'running')
      throw new Error('Inspection collection requires a currently running native check executor.');
    if (inspection && !executor?.native_tool_scope.includes('check_inspect'))
      throw new Error('The native check executor did not confirm the check_inspect capability.');
    const errors = [
      ...authoredRoutingProblems(
        root,
        check,
        typeof task.meta.data.workflow_id === 'string' ? task.meta.data.workflow_id : undefined,
      ),
      ...verifyFrozenRecipe(root, task),
    ];
    if (!hasCurrentReview(root, id))
      errors.push('The verification procedure requires current Sol independent review.');
    if (errors.length) throw new Error(errors.join('\n'));
  }
  const records = loadRecords(root);
  const scope = verificationScope(records, task);
  if (!check.meta.links.some((l) => l.type === 'verifies' && scope.includes(l.target)))
    throw new Error('Check does not verify this task or its requirements/design.');
  const command = strings(check.meta.data.command);
  if (!inspection && !command.length)
    throw new Error('Check command must be a non-empty executable/argument array.');
  const baselinePaths = strings(check.meta.data.baseline_paths);
  if (!baselinePaths.length)
    throw new Error('Check needs baseline_paths for implementation inputs.');
  const file_baseline = snapshotPaths(root, baselinePaths);
  const record_baseline = Object.fromEntries(
    scope.map((id) => {
      const r = records.find((r) => r.meta.id === id);
      if (!r) throw new Error(`Missing baseline record ${id}`);
      return [id, recordFingerprint(r)];
    }),
  );
  const inspected = inspection
    ? checkedInspection(root, check, task, records, scope, file_baseline, inspection)
    : undefined;
  for (const source of inspected?.records ?? [])
    record_baseline[source.meta.id] = recordFingerprint(source);
  const run = randomUUID();
  const timeout = Number(check.meta.data.timeout_ms ?? 60000);
  if (!Number.isFinite(timeout) || timeout < 1 || timeout > 600000)
    throw new Error('Check timeout must be between 1 and 600000 ms.');
  const pack_lock_hash = existsSync(safePath(root, '.verythinker/pack-lock.json'))
    ? hash(readFileSync(safePath(root, '.verythinker/pack-lock.json')))
    : null;
  const tool_lock_hash = existsSync(safePath(root, '.verythinker/tool-lock.json'))
    ? hash(readFileSync(safePath(root, '.verythinker/tool-lock.json')))
    : null;
  const input_snapshot = captureEvidenceInputs(root, {
    files: file_baseline,
    records: records.filter(
      (record) =>
        scope.includes(record.meta.id) ||
        record.meta.id === check.meta.id ||
        inspected?.records.some((source) => source.meta.id === record.meta.id),
    ),
    record_fingerprints: { ...record_baseline, [check.meta.id]: recordFingerprint(check) },
    invocation_id: invocationId,
    additional_files: [
      ...strings(task.meta.data.protected_acceptance_paths),
      ...strings(check.meta.data.verification_artifact_paths),
      ...(inspected?.files ?? []),
    ],
  });
  if (inspection) {
    const captured = validateEvidenceInputs(root, input_snapshot);
    for (const observation of inspection.observations)
      for (const source of observation.sources)
        if (
          source.kind === 'file' &&
          (captured.files[source.path] ?? captured.context_files[source.path])?.hash !==
            source.sha256
        )
          throw new Error(
            `Inspection source differs from its immutable captured input: ${source.path}`,
          );
  }
  appendEvent(root, run, {
    event: 'check-start',
    check_id: id,
    task_id: taskId,
    command,
    requested_model: task.meta.data.requested_model ?? null,
    confirmed_model: task.meta.data.confirmed_model ?? null,
  });
  const started = Date.now();
  const executed = inspected
    ? null
    : spawnSync(command[0]!, command.slice(1), {
        cwd: root,
        shell: false,
        encoding: 'utf8',
        timeout,
        maxBuffer: 10 * 1024 * 1024,
        windowsHide: true,
      });
  const expected = Number(check.meta.data.expected_exit_code ?? 0);
  const result = inspected
    ? inspection!.observations.every((item) => item.outcome === 'pass')
      ? 'pass'
      : 'fail'
    : executed!.status === expected && !executed!.error
      ? 'pass'
      : 'fail';
  const log = inspected
    ? `Inspection observations submitted by ${invocationId ?? 'legacy observer'}; semantic correctness requires independent review.\n${JSON.stringify(inspected, (_key, value) => (_key === 'records' || _key === 'files' ? undefined : value), 2)}\n`
    : `Command: ${JSON.stringify(command)}\nExit code: ${executed!.status}\nSignal: ${executed!.signal}\nError: ${executed!.error?.message ?? 'none'}\n\nSTDOUT\n${executed!.stdout ?? ''}\nSTDERR\n${executed!.stderr ?? ''}`;
  const log_path = `.verythinker/runs/${run}/output.log`;
  const receipt_path = `.verythinker/runs/${run}/receipt.json`;
  const git = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    shell: false,
    encoding: 'utf8',
    timeout: 5000,
    windowsHide: true,
  });
  const receipt = {
    schema_version: 1,
    execution_invocation_id: invocationId ?? null,
    run_id: run,
    task_id: taskId,
    check_id: id,
    check_fingerprint: recordFingerprint(check),
    record_baseline,
    record_revisions: Object.fromEntries(
      records.filter((r) => scope.includes(r.meta.id)).map((r) => [r.meta.id, r.meta.revision]),
    ),
    file_baseline,
    input_snapshot,
    pack_lock_hash,
    tool_lock_hash,
    revision: {
      git_commit: git.status === 0 ? git.stdout.trim() : null,
      workspace_hash: hash(JSON.stringify(file_baseline)),
    },
    tool_versions: { runner_node: process.version, declared: check.meta.data.tool_versions ?? {} },
    result,
    exit_code: executed?.status ?? null,
    duration_ms: Date.now() - started,
    method: check.meta.data.method ?? 'test',
    environment: check.meta.data.environment ?? { os: process.platform, node: process.version },
    command,
    ...(inspected
      ? {
          inspection: {
            observations: inspected.observations,
            limitations: inspected.limitations,
            claim_kind: 'agent-observed-inspection',
            independent_semantic_review_required: true,
          },
        }
      : {}),
    at: now(),
    log_path,
    log_hash: hash(log),
  };
  atomicWrite(safePath(root, log_path), log);
  atomicWrite(safePath(root, receipt_path), JSON.stringify(receipt, null, 2) + '\n');
  appendEvent(root, run, {
    event: 'check-end',
    result,
    duration_ms: receipt.duration_ms,
    receipt_path,
  });
  return createRecord(root, {
    type: 'evidence',
    title: `${result}: ${check.meta.title}`,
    owner: 'verifier',
    status: result === 'pass' ? 'verified' : 'failed',
    links: [
      { type: 'evidence-for', target: id },
      { type: 'documents', target: taskId },
    ],
    data: { ...receipt, receipt_path },
    body: `# Results\n${result}; ${inspected ? 'recorded inspection observations' : `exit code ${executed!.status}`}.\n\n# Evidence\n[Execution log](../../${log_path})\n\n# Limitations\nEvidence applies to the recorded inputs, method, and environment.${inspected ? '\nInspection observations are agent judgements; independent semantic review remains required.\n' + inspected.limitations.join('\n') : ''}\n`,
  });
}
export function archiveEvidence(root: string, id: string): ProjectRecord {
  const evidence = getRecord(root, id);
  if (evidence.meta.type !== 'evidence') throw new Error('Archive requires an evidence record.');
  const data = evidence.meta.data;
  const log = readFileSync(safePath(root, String(data.log_path)));
  const receipt = JSON.parse(readFileSync(safePath(root, String(data.receipt_path)), 'utf8'));
  if (hash(log) !== data.log_hash || receipt.log_hash !== data.log_hash)
    throw new Error('Evidence log or receipt hash does not match.');
  const path = `.verythinker/evidence/${id}`;
  const log_path = `${path}/output.log`;
  const receipt_path = `${path}/receipt.json`;
  atomicWrite(safePath(root, log_path), log);
  atomicWrite(
    safePath(root, receipt_path),
    JSON.stringify({ ...receipt, log_path }, null, 2) + '\n',
  );
  return updateRecord(
    root,
    id,
    { data: { log_path, receipt_path, archived_at: now() } },
    `# Results\n${data.result}; exit code ${data.exit_code}.\n\n# Evidence\n[Archived verification log](../evidence/${id}/output.log)\n\n# Limitations\nEvidence applies to its recorded baseline. Inspect exported logs before sharing.\n`,
  );
}
export function contextPacket(root: string, id: string, maxChars = 18000): unknown {
  const task = getRecord(root, id);
  if (task.meta.type !== 'task') throw new Error('Context target must be a task.');
  const records = loadRecords(root);
  const config = readConfig(root);
  const ids = new Set([...verificationScope(records, task), ...dependenciesFor(task)]);
  const relevant = records.filter(
    (r) => ids.has(r.meta.id) || r.meta.links.some((l) => ids.has(l.target)),
  );
  const paths = strings(task.meta.data.allowed_paths);
  const existingPaths = paths.filter((path) => existsSync(safePath(root, path)));
  const baseline = {
    record_fingerprints: Object.fromEntries(
      records.filter((r) => ids.has(r.meta.id)).map((r) => [r.meta.id, recordFingerprint(r)]),
    ),
    source_inputs: snapshotPaths(root, existingPaths),
    missing_paths: paths.filter((path) => !existingPaths.includes(path)),
    declared: task.meta.data.baseline ?? null,
  };
  if (!Number.isSafeInteger(maxChars) || maxChars < 1000 || maxChars > 100000)
    throw new Error('Context budget must be an integer between 1000 and 100000 characters.');
  const lockPath = safePath(root, '.verythinker/pack-lock.json');
  const packs = existsSync(lockPath) ? JSON.parse(readFileSync(lockPath, 'utf8')).packs : [];
  const documentationRequired = task.meta.data.documentation_required === true;
  const documentPaths = documentationRequired ? documentationPaths(task) : [];
  const submission = task.meta.data.submission as Record<string, unknown> | undefined;
  const packet = {
    schema_version: 1,
    task_id: id,
    objective: task.meta.title,
    profile: config.profile,
    requirements: requirementsFor(task),
    dependencies: dependenciesFor(task),
    acceptance_criteria: task.meta.data.acceptance_criteria ?? [],
    allowed_paths: task.meta.data.allowed_paths ?? [],
    baseline,
    decisions: task.meta.data.decisions ?? [],
    assumptions: task.meta.data.assumptions ?? [],
    tools: task.meta.data.tools ?? [],
    routing:
      task.meta.data.routing_required === true
        ? {
            receipt_required: true,
            role: task.meta.owner,
            strong_model: 'gpt-6.1-sol',
            worker_models: ['gpt-6-luna', 'gpt-5.6-terra'],
            observation:
              'Native acknowledgment and successful inference are validated independently of agent-written strings.',
          }
        : { legacy: true },
    recipe_instance_ids: task.meta.data.recipe_instance_ids ?? [],
    protected_acceptance_paths: task.meta.data.protected_acceptance_paths ?? [],
    required_tools: task.meta.data.required_tools ?? [],
    outputs: [
      ...new Set([
        ...strings(task.meta.data.outputs),
        ...documentPaths,
        ...(documentationRequired
          ? ['Linked seven-section knowledge work record supplied with task submission.']
          : []),
      ]),
    ],
    documentation: documentationRequired
      ? {
          required: true,
          workflow_id: task.meta.data.workflow_id ?? null,
          paths: documentPaths,
          sections: workRecordSections,
          work_record_id: submission?.work_record_id ?? null,
          instructions:
            'Supply substantive section content when submitting. After documentation changes, repair, resubmit and obtain a new independent review.',
        }
      : null,
    verification_procedures: relevant
      .filter((r) => r.meta.type === 'check')
      .map((r) => ({ id: r.meta.id, command: r.meta.data.command, method: r.meta.data.method })),
    limits: { max_workers: config.max_workers, repair_attempts: config.repair_attempts },
    escalation: [
      'Conflicting requirements',
      'Missing inputs',
      'Interface or scope changes',
      'Repeated failure after one repair',
    ],
    model_tiers: config.models,
    role_path: `.verythinker/roles/${task.meta.owner}.md`,
    knowledge_packs: packs.map(
      (p: { id: string; version: string; hash: string; path: string }) => ({
        id: p.id,
        version: p.version,
        hash: p.hash,
        path: p.path,
      }),
    ),
    inputs: [] as {
      id: string;
      type: string;
      path: string;
      revision: number;
      body: string;
      truncated: boolean;
    }[],
    omitted_inputs: relevant.length,
  };
  if (JSON.stringify(packet).length > maxChars)
    throw new Error(
      'Task metadata exceeds the context budget. Increase max_chars or split the task.',
    );
  for (const record of relevant) {
    const input = {
      id: record.meta.id,
      type: record.meta.type,
      path: record.path,
      revision: record.meta.revision,
      body: '',
      truncated: true,
    };
    packet.inputs.push(input);
    packet.omitted_inputs--;
    if (JSON.stringify(packet).length > maxChars) {
      packet.inputs.pop();
      packet.omitted_inputs++;
      break;
    }
    let low = 0,
      high = record.body.length;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      input.body = record.body.slice(0, mid);
      if (JSON.stringify(packet).length <= maxChars) low = mid;
      else high = mid - 1;
    }
    input.body = record.body.slice(0, low);
    input.truncated = low < record.body.length;
  }
  return packet;
}
