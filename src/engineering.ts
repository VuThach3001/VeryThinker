import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
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
import type { Finding, Gate, ProjectRecord, Verification } from './types.js';

export const strings = (value: unknown): string[] =>
  Array.isArray(value) && value.every((v) => typeof v === 'string') ? value : [];
function workerInvocations(record: ProjectRecord): string[] {
  const current = record.meta.data.invocation_id;
  return [
    ...strings(record.meta.data.prior_invocation_ids),
    ...(typeof current === 'string' ? [current] : []),
  ];
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
  const { submission, requested_model, confirmed_model, attempts, ...data } = record.meta.data;
  return hash(
    JSON.stringify({
      type: record.meta.type,
      title: record.meta.title,
      owner: record.meta.owner,
      links: record.meta.links,
      data,
      body: record.body,
    }),
  );
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
  if (d.result !== 'pass') errors.push('Evidence result is not pass.');
  if (d.task_id !== task.meta.id) errors.push('Evidence was collected for another task.');
  if (d.check_fingerprint !== recordFingerprint(check))
    errors.push('Check procedure changed after this evidence was collected.');
  const packLock = safePath(root, '.verythinker/pack-lock.json');
  if (d.pack_lock_hash !== (existsSync(packLock) ? hash(readFileSync(packLock)) : null))
    errors.push('Knowledge-pack baseline changed.');
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
        JSON.stringify(receipt.record_baseline) !== JSON.stringify(d.record_baseline) ||
        JSON.stringify(receipt.file_baseline) !== JSON.stringify(d.file_baseline)
      )
        errors.push('Evidence does not match the collected execution receipt.');
    } catch {
      errors.push('Execution receipt is unreadable.');
    }
  }
  return errors;
}
function reviewBaseline(root: string, target: ProjectRecord, records = loadRecords(root)): string {
  const ids = new Set(verificationScope(records, target));
  if (target.meta.type === 'design')
    for (const id of requirementScope(
      records,
      target.meta.links.filter((link) => link.type === 'satisfies').map((link) => link.target),
    ))
      ids.add(id);
  const checks = records.filter(
    (r) =>
      r.meta.type === 'check' &&
      r.meta.links.some((l) => l.type === 'verifies' && ids.has(l.target)),
  );
  const baseline: Record<string, unknown> = {
    records: Object.fromEntries(
      records.filter((r) => ids.has(r.meta.id)).map((r) => [r.meta.id, recordFingerprint(r)]),
    ),
  };
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
    const designs = records.filter((r) => r.meta.type === 'design' && scope.includes(r.meta.id));
    const checks = records.filter(
      (r) =>
        r.meta.type === 'check' &&
        r.meta.links.some((l) => l.type === 'verifies' && scope.includes(l.target)),
    );
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
export function startTask(
  root: string,
  id: string,
  requestedModel?: string,
  confirmedModel?: string,
  invocationId: string = randomUUID(),
): ProjectRecord {
  if (typeof invocationId !== 'string' || !invocationId.trim())
    throw new Error('Task execution needs a non-empty invocation identity.');
  const task = getRecord(root, id);
  if (task.meta.type !== 'task' || !['draft', 'ready', 'blocked'].includes(task.meta.status))
    throw new Error('Only draft, ready, or blocked tasks can start.');
  if (task.meta.data.escalation_required && !requestedModel)
    throw new Error(
      'Repeated failure requires an explicit coordinator-selected model before restarting.',
    );
  const report = verify(root, id, 'ready');
  if (!report.ok) throw new Error(report.findings.map((f) => f.message).join('\n'));
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
      const currentGate = verify(root, id, 'ready');
      if (!currentGate.ok) throw new Error(currentGate.findings.map((f) => f.message).join('\n'));
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
  if (task.meta.status === 'in-progress') {
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
      },
    );
  }
  if (task.meta.status !== 'blocked')
    throw new Error('Only interrupted in-progress or blocked work can resume.');
  if (task.meta.data.escalation_required && !requestedModel)
    throw new Error(
      'Repeated failure requires an explicit coordinator-selected model before resuming.',
    );
  return startTask(
    root,
    id,
    requestedModel ?? (task.meta.data.requested_model as string | undefined),
    confirmedModel,
    invocationId,
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
export function runCheck(root: string, id: string, taskId: string): ProjectRecord {
  const check = getRecord(root, id);
  const task = getRecord(root, taskId);
  if (check.meta.type !== 'check' || task.meta.type !== 'task')
    throw new Error('Provide a check and a task.');
  const records = loadRecords(root);
  const scope = verificationScope(records, task);
  if (!check.meta.links.some((l) => l.type === 'verifies' && scope.includes(l.target)))
    throw new Error('Check does not verify this task or its requirements/design.');
  const command = strings(check.meta.data.command);
  if (!command.length)
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
  const run = randomUUID();
  const timeout = Number(check.meta.data.timeout_ms ?? 60000);
  if (!Number.isFinite(timeout) || timeout < 1 || timeout > 600000)
    throw new Error('Check timeout must be between 1 and 600000 ms.');
  appendEvent(root, run, {
    event: 'check-start',
    check_id: id,
    task_id: taskId,
    command,
    requested_model: task.meta.data.requested_model ?? null,
    confirmed_model: task.meta.data.confirmed_model ?? null,
  });
  const started = Date.now();
  const executed = spawnSync(command[0]!, command.slice(1), {
    cwd: root,
    shell: false,
    encoding: 'utf8',
    timeout,
    maxBuffer: 10 * 1024 * 1024,
    windowsHide: true,
  });
  const expected = Number(check.meta.data.expected_exit_code ?? 0);
  const result = executed.status === expected && !executed.error ? 'pass' : 'fail';
  const log = `Command: ${JSON.stringify(command)}\nExit code: ${executed.status}\nSignal: ${executed.signal}\nError: ${executed.error?.message ?? 'none'}\n\nSTDOUT\n${executed.stdout ?? ''}\nSTDERR\n${executed.stderr ?? ''}`;
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
    run_id: run,
    task_id: taskId,
    check_id: id,
    check_fingerprint: recordFingerprint(check),
    record_baseline,
    record_revisions: Object.fromEntries(
      records.filter((r) => scope.includes(r.meta.id)).map((r) => [r.meta.id, r.meta.revision]),
    ),
    file_baseline,
    pack_lock_hash: existsSync(safePath(root, '.verythinker/pack-lock.json'))
      ? hash(readFileSync(safePath(root, '.verythinker/pack-lock.json')))
      : null,
    revision: {
      git_commit: git.status === 0 ? git.stdout.trim() : null,
      workspace_hash: hash(JSON.stringify(file_baseline)),
    },
    tool_versions: { runner_node: process.version, declared: check.meta.data.tool_versions ?? {} },
    result,
    exit_code: executed.status,
    duration_ms: Date.now() - started,
    method: check.meta.data.method ?? 'test',
    environment: check.meta.data.environment ?? { os: process.platform, node: process.version },
    command,
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
    body: `# Results\n${result}; exit code ${executed.status}.\n\n# Evidence\n[Execution log](../../${log_path})\n\n# Limitations\nEvidence applies to the recorded inputs, method, and environment.\n`,
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
