import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, relative, resolve, sep } from 'node:path';
import {
  atomicWrite,
  filesUnder,
  getRecord,
  hash,
  loadRecords,
  now,
  readConfig,
  safePath,
  withLock,
  withOperationLock,
} from './storage.js';
import {
  assignmentDocumentationProblems,
  dependenciesFor,
  hasCurrentReview,
  recordFingerprint,
  strings,
  verify,
} from './engineering.js';
import { assertRouting, readRoutingPolicy } from './routing.js';
import {
  evidenceInputArtifactPaths,
  recoverLegacyEvidenceInputs,
  validateEvidenceInputs,
  type EvidenceInputSnapshot,
} from './evidence-inputs.js';
import type { ProjectRecord } from './types.js';

export type ArchiveRequest = (method: string, endpoint: string, body?: unknown) => any;
export interface ArchivePolicy {
  schema_version: 1;
  enabled: boolean;
  repository: string;
  namespace: string;
  project_id: string;
  baseline_commit: string | null;
  last_release: string | null;
  last_snapshot_id: string | null;
}
export interface ArchiveManifest {
  schema_version: 1;
  snapshot_id: string;
  project_id: string;
  workflow_id: string;
  increment_id: string;
  disposition: 'working' | 'accepted';
  release: string | null;
  change_type: 'breaking-change' | 'feature' | 'fix';
  created_at: string;
  captured_baseline: string | null;
  source_revision: string | null;
  namespace: string;
  repository: string;
  files: { path: string; hash: string; mode: '100644' | '100755'; bytes: number }[];
  records: { id: string; path: string; fingerprint: string; revision: number }[];
  deleted_paths: string[];
  omissions: string[];
  evidence_inputs?: Record<string, EvidenceInputSnapshot>;
  submodules: { path: string; commit: string }[];
  reproduction: string[];
}
export interface ArchiveSnapshot {
  snapshot_id: string;
  path: string;
  manifest_hash: string;
  manifest: ArchiveManifest;
}
export interface ArchivePublication {
  schema_version: 1;
  snapshot_id: string;
  manifest_hash: string;
  repository: string;
  status:
    | 'planned'
    | 'blobs-created'
    | 'tree-created'
    | 'commit-created'
    | 'baseline-advanced'
    | 'release-created'
    | 'completed';
  base_commit?: string;
  base_tree?: string;
  increment_parent?: string | null;
  blobs: Record<string, string>;
  tree?: string;
  commit?: string;
  completed_at?: string;
}
export interface AcceptedArchive {
  snapshot: ArchiveSnapshot;
  publication: ArchivePublication;
  derived: boolean;
}
const policyPath = '.verythinker/archive.json';
const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const snapshotPattern = /^[a-f0-9-]{36}$/;
function releaseParts(value: string): [number, number, number] {
  if (!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(value))
    throw new Error('Project release must use major.minor.patch SemVer without leading zeros.');
  const parts = value.split('.').map(Number);
  if (parts.some((part) => !Number.isSafeInteger(part)))
    throw new Error('Project release components exceed supported integer bounds.');
  return parts as [number, number, number];
}
function branchName(value: string): string {
  if (
    !value.startsWith('codex/projects/') ||
    /[\x00-\x20~^:?*\[\\]|\.\.|@\{|\/\/|\/$|\.$/.test(value) ||
    value.split('/').some((part) => !part || part.startsWith('.') || part.endsWith('.lock'))
  )
    throw new Error('Archive namespace is not a valid managed Git reference.');
  return value;
}
export function readArchivePolicy(root: string): ArchivePolicy | null {
  const path = safePath(root, policyPath);
  if (!existsSync(path)) return null;
  const policy = JSON.parse(readFileSync(path, 'utf8')) as ArchivePolicy;
  if (
    policy.schema_version !== 1 ||
    typeof policy.enabled !== 'boolean' ||
    !repositoryPattern.test(policy.repository) ||
    policy.project_id !== readConfig(root).project_id ||
    (policy.last_release !== null && !/^\d+\.\d+\.\d+$/.test(policy.last_release))
  )
    throw new Error('Archive policy is invalid; inspect it before publication.');
  branchName(policy.namespace);
  if (policy.last_release !== null) releaseParts(policy.last_release);
  const restorationPath = safePath(root, '.verythinker/archive-restoration.json');
  if (existsSync(restorationPath)) {
    const restoration = JSON.parse(readFileSync(restorationPath, 'utf8'));
    if (
      restoration.schema_version !== 1 ||
      !snapshotPattern.test(restoration.snapshot_id) ||
      typeof restoration.manifest_hash !== 'string'
    )
      throw new Error('Archive restoration receipt is malformed.');
    if (
      restoration.repository === policy.repository &&
      restoration.namespace === policy.namespace &&
      restoration.captured_baseline === policy.baseline_commit
    ) {
      const snapshot = readSnapshot(root, restoration.snapshot_id);
      const publication = JSON.parse(
        readFileSync(safePath(root, `${snapshot.path}/publication.json`), 'utf8'),
      ) as ArchivePublication;
      if (
        snapshot.manifest_hash !== restoration.manifest_hash ||
        snapshot.manifest.disposition !== 'accepted' ||
        snapshot.manifest.release !== restoration.release ||
        publication.status !== 'completed' ||
        publication.manifest_hash !== snapshot.manifest_hash ||
        publication.commit !== restoration.baseline_commit ||
        publication.repository !== policy.repository
      )
        throw new Error(
          'Archive restoration baseline cannot be verified against its frozen snapshot and publication receipt.',
        );
      return {
        ...policy,
        baseline_commit: restoration.baseline_commit,
        last_release: restoration.release,
        last_snapshot_id: restoration.snapshot_id,
      };
    }
  }
  return policy;
}
export function ensureArchivePolicy(root: string): ArchivePolicy {
  return withOperationLock(root, 'archive-policy', () => {
    const prior = readArchivePolicy(root);
    if (prior) return prior;
    const config = readConfig(root);
    const slug =
      basename(resolve(root))
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 48) || 'project';
    const policy: ArchivePolicy = {
      schema_version: 1,
      enabled: true,
      repository: 'VuThach3001/VeryThinker-Project-Archives',
      namespace: branchName(`codex/projects/${slug}-${config.project_id.toLowerCase()}`),
      project_id: config.project_id,
      baseline_commit: null,
      last_release: null,
      last_snapshot_id: null,
    };
    atomicWrite(safePath(root, policyPath), JSON.stringify(policy, null, 2) + '\n');
    return policy;
  });
}
function policyFor(root: string): ArchivePolicy {
  const policy = readArchivePolicy(root);
  if (!policy?.enabled) throw new Error('Project archiving is disabled or has not been installed.');
  return policy;
}
function nextRelease(prior: string | null, change: ArchiveManifest['change_type']): string {
  if (!prior) return '1.0.0';
  const [major, minor, patch] = releaseParts(prior);
  const next =
    change === 'breaking-change'
      ? `${major + 1}.0.0`
      : change === 'feature'
        ? `${major}.${minor + 1}.0`
        : `${major}.${minor}.${patch + 1}`;
  releaseParts(next);
  return next;
}
function workflow(root: string, id: string): ProjectRecord {
  const parent = getRecord(root, id);
  if (parent.meta.data.kind !== 'manager-workflow')
    throw new Error('Archive requires a manager workflow.');
  if (
    typeof parent.meta.data.increment_id !== 'string' ||
    !snapshotPattern.test(parent.meta.data.increment_id)
  )
    throw new Error('Workflow has no stable increment ID.');
  return parent;
}
function accepted(root: string, parent: ProjectRecord): void {
  if (
    readRoutingPolicy(root) &&
    parent.meta.data.routing_required !== true &&
    (!['completed', 'completed-with-blockers'].includes(String(parent.meta.data.phase)) ||
      typeof parent.meta.data.final_report_id !== 'string')
  )
    throw new Error(
      'Pending legacy workflow requires alpha.3 migration and confirmed strategic coordination before archive acceptance.',
    );
  if (parent.meta.data.routing_required === true) {
    if (!readRoutingPolicy(root))
      throw new Error('Strict archive acceptance requires the installed native routing policy.');
    assertRouting(
      root,
      'manager',
      typeof parent.meta.data.invocation_id === 'string'
        ? parent.meta.data.invocation_id
        : undefined,
      { workflow_id: parent.meta.id, require_completed: true },
    );
    const documentation = assignmentDocumentationProblems(root, parent.meta.id);
    if (documentation.length)
      throw new Error(
        `Archive assignment documentation is incomplete: ${documentation.join('; ')}`,
      );
  }
  const ids = strings(parent.meta.data.task_ids);
  if (!ids.length || strings(parent.meta.data.open_questions).length)
    throw new Error('Archive acceptance requires a resolved workflow with tasks.');
  if (typeof parent.meta.data.decision_id !== 'string')
    throw new Error('Archive acceptance requires a recorded manager decision.');
  const decision = getRecord(root, parent.meta.data.decision_id);
  if (
    decision.meta.data.kind !== 'manager-decision' ||
    decision.meta.data.workflow_id !== parent.meta.id
  )
    throw new Error('Archive manager decision does not belong to this workflow.');
  const baseline = decision.meta.data.requirement_baseline;
  if (!baseline || typeof baseline !== 'object')
    throw new Error('Archive manager decision has no requirement baseline.');
  for (const [id, fingerprint] of Object.entries(baseline))
    if (recordFingerprint(getRecord(root, id)) !== fingerprint)
      throw new Error(`Archive manager decision requires reassessment: ${id}`);
  for (const id of ids) {
    const task = getRecord(root, id);
    if (task.meta.data.workflow_id !== parent.meta.id)
      throw new Error(`Task belongs to another workflow: ${id}`);
    const result = verify(root, id, 'accepted');
    if (!result.ok)
      throw new Error(
        `Archive acceptance gate failed for ${id}: ${result.findings.map((f) => f.message).join('; ')}`,
      );
  }
}
function closure(
  root: string,
  parent: ProjectRecord,
  prior: ArchiveManifest | null,
): ProjectRecord[] {
  const records = loadRecords(root);
  const byId = new Map(records.map((record) => [record.meta.id, record]));
  const ids = new Set([
    parent.meta.id,
    ...strings(parent.meta.data.task_ids),
    ...strings(parent.meta.data.requirement_ids),
    ...(typeof parent.meta.data.requirement_id === 'string'
      ? [parent.meta.data.requirement_id]
      : []),
    ...(prior?.records.map((record) => record.id) ?? []),
  ]);
  const permittedTaskIds = new Set([
    ...strings(parent.meta.data.task_ids),
    ...strings(parent.meta.data.prior_task_ids),
    ...(Array.isArray(parent.meta.data.history)
      ? parent.meta.data.history.flatMap((entry) => strings(entry?.task_ids))
      : []),
    ...(prior?.records
      .filter((record) => byId.get(record.id)?.meta.type === 'task')
      .map((record) => record.id) ?? []),
  ]);
  const dependencies = [...strings(parent.meta.data.task_ids)];
  for (const id of dependencies)
    for (const dependency of byId.has(id) ? dependenciesFor(byId.get(id)!) : [])
      if (!permittedTaskIds.has(dependency)) {
        permittedTaskIds.add(dependency);
        dependencies.push(dependency);
      }
  let changed = true;
  while (changed) {
    changed = false;
    for (const record of records) {
      let include = ids.has(record.meta.id);
      if (
        !include &&
        !['task', 'requirement'].includes(record.meta.type) &&
        record.meta.data.kind !== 'manager-workflow'
      ) {
        // A shared requirement does not authorize importing another active
        // increment's reviews, work records, or implementation tasks.
        if (
          (typeof record.meta.data.workflow_id === 'string' &&
            record.meta.data.workflow_id !== parent.meta.id) ||
          (typeof record.meta.data.task_id === 'string' && !ids.has(record.meta.data.task_id)) ||
          record.meta.links.some(
            (link) =>
              byId.get(link.target)?.meta.type === 'task' && !permittedTaskIds.has(link.target),
          )
        )
          continue;
        include =
          record.meta.data.workflow_id === parent.meta.id ||
          Boolean(record.meta.data.task_id && ids.has(String(record.meta.data.task_id))) ||
          (record.meta.type !== 'evidence' &&
            record.meta.links.some(
              (link) =>
                ids.has(link.target) &&
                (record.meta.type === 'review' || ['documents', 'verifies'].includes(link.type)),
            ));
      }
      if (!include) continue;
      if (!ids.has(record.meta.id)) {
        ids.add(record.meta.id);
        changed = true;
      }
      for (const link of record.meta.links) {
        if (byId.get(link.target)?.meta.type === 'task' && !permittedTaskIds.has(link.target))
          throw new Error(
            `Archive traceability references a task outside this increment and its dependencies: ${link.target}`,
          );
        if (!ids.has(link.target)) {
          ids.add(link.target);
          changed = true;
        }
      }
      for (const field of [
        'task_ids',
        'requirement_ids',
        'knowledge_ids',
        'prior_task_ids',
        'recipe_instance_ids',
        'dependencies',
        'requirements',
      ])
        for (const id of strings(record.meta.data[field])) {
          if (byId.get(id)?.meta.type === 'task' && !permittedTaskIds.has(id))
            throw new Error(
              `Archive traceability references a task outside this increment and its dependencies: ${id}`,
            );
          if (!ids.has(id)) {
            ids.add(id);
            changed = true;
          }
        }
      for (const field of [
        'decision_id',
        'final_report_id',
        'work_record_id',
        'design_id',
        'check_id',
        'note_id',
        'change_id',
      ])
        if (
          typeof record.meta.data[field] === 'string' &&
          !ids.has(record.meta.data[field] as string)
        ) {
          ids.add(record.meta.data[field] as string);
          changed = true;
        }
      const submission = record.meta.data.submission as Record<string, unknown> | undefined;
      if (typeof submission?.work_record_id === 'string' && !ids.has(submission.work_record_id)) {
        ids.add(submission.work_record_id);
        changed = true;
      }
      for (const field of ['record_baseline', 'protected_records', 'requirement_baselines']) {
        const baseline = record.meta.data[field];
        if (baseline && typeof baseline === 'object')
          for (const id of Object.keys(baseline))
            if (!ids.has(id)) {
              ids.add(id);
              changed = true;
            }
      }
      for (const history of Array.isArray(record.meta.data.history)
        ? record.meta.data.history
        : []) {
        if (!history || typeof history !== 'object') continue;
        for (const field of ['task_ids', 'knowledge_ids'])
          for (const id of strings(history[field]))
            if (!ids.has(id)) {
              ids.add(id);
              changed = true;
            }
        for (const field of ['decision_id', 'final_report_id'])
          if (typeof history[field] === 'string' && !ids.has(history[field])) {
            ids.add(history[field]);
            changed = true;
          }
      }
    }
  }
  for (const id of ids)
    if (!byId.has(id))
      throw new Error(`Archive traceability closure contains a missing record: ${id}`);
  return records.filter((record) => ids.has(record.meta.id));
}
function canonical(path: string): string {
  if (
    !path ||
    path.includes('\\') ||
    path.startsWith('/') ||
    /^[a-z]:/i.test(path) ||
    path.split('/').some((part) => !part || part === '.' || part === '..')
  )
    throw new Error(`Archive input requires a canonical project-relative path: ${path}`);
  return path;
}
function prohibited(path: string): boolean {
  const envTemplate = /(?:^|\/)\.env\.(?:example|sample|template)$/i.test(path);
  return (
    /(?:^|\/)(?:\.git|node_modules|cache|operations|contributions|archives|archive-intents|archive-reassessments|runs)(?:\/|$)/i.test(
      path,
    ) ||
    /^\.verythinker\/(?:tools|raw|sessions|capabilities)(?:\/|$)/i.test(path) ||
    (/(?:^|\/)(?:\.env(?:\.[^/]+)?|credentials[^/]*|id_rsa|id_ed25519|private-key\.pem|[^/]+\.sqlite(?:-[^/]*)?|[^/]+\.(?:lock|tmp))$/i.test(
      path,
    ) &&
      !/(?:pack|recipe|tool|native-runtime)-lock\.json$/.test(path) &&
      !envTemplate)
  );
}
function secretCheck(path: string, content: Buffer): void {
  const text = content.toString('utf8');
  if (
    /-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----|\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16}|sk-[A-Za-z0-9]{20,})\b|\b(?:password|secret|authorization|(?:access|bearer|auth)[_-]?token|api[_-]?key)["']?\s*[=:]\s*["']?(?:Bearer\s+)?(?!null\b|undefined\b|process\.env\b|\$\{)[A-Za-z0-9_+\/-]{16,}/i.test(
      text,
    )
  )
    throw new Error(
      `Sensitive content blocks archive export: ${path}. Inspect and resolve the source without rewriting frozen records.`,
    );
}
function previous(root: string, policy: ArchivePolicy): ArchiveManifest | null {
  return policy.last_snapshot_id ? readSnapshot(root, policy.last_snapshot_id).manifest : null;
}
function collectFiles(
  root: string,
  parent: ProjectRecord,
  records: ProjectRecord[],
  prior: ArchiveManifest | null,
  sourcePaths: string[],
  evidenceInputs: Record<string, EvidenceInputSnapshot>,
): { paths: string[]; omissions: string[] } {
  const paths = new Set<string>();
  const approved = new Set<string>();
  const taskIds = new Set(strings(parent.meta.data.task_ids));
  const pending = [...taskIds];
  for (const id of pending)
    for (const dependency of dependenciesFor(getRecord(root, id)))
      if (!taskIds.has(dependency)) {
        taskIds.add(dependency);
        pending.push(dependency);
      }
  const reviewedPaths = new Set<string>();
  const current = closure(root, parent, null).filter((record) =>
    record.meta.type === 'task'
      ? taskIds.has(record.meta.id)
      : typeof record.meta.data.workflow_id === 'string'
        ? record.meta.data.workflow_id === parent.meta.id ||
          (typeof record.meta.data.task_id === 'string' && taskIds.has(record.meta.data.task_id))
        : typeof record.meta.data.task_id !== 'string' || taskIds.has(record.meta.data.task_id),
  );
  const currentIds = new Set(current.map((record) => record.meta.id));
  for (const historical of prior?.records ?? []) {
    if (currentIds.has(historical.id)) continue;
    const record = getRecord(root, historical.id);
    if (recordFingerprint(record) === historical.fingerprint) continue;
    if (record.meta.data.kind === 'manager-workflow' && prior) {
      const frozen = getRecord(
        safePath(root, `.verythinker/archives/${prior.snapshot_id}/workspace`),
        historical.id,
      );
      const contract = (value: ProjectRecord) => ({
        title: value.meta.title,
        owner: value.meta.owner,
        links: value.meta.links,
        body: value.body,
        data: Object.fromEntries(
          Object.entries(value.meta.data).filter(
            ([field]) =>
              ![
                'phase',
                'closed_at',
                'final_report_id',
                'knowledge_ids',
                'no_lesson_reason',
                'publications',
                'archive',
                'publication_history',
                'publication_retirements',
              ].includes(field),
          ),
        ),
      });
      if (JSON.stringify(contract(record)) === JSON.stringify(contract(frozen))) continue;
    }
    throw new Error(
      `Historical archive engineering record changed outside this increment's traceability scope: ${historical.id}. Obtain a scoped reassessment before export.`,
    );
  }
  const remember = (path: string) =>
    reviewedPaths.add(relative(resolve(root), safePath(root, path)).replaceAll('\\', '/') || '.');
  for (const record of current) {
    for (const field of [
      'outputs',
      'documentation_paths',
      'baseline_paths',
      'protected_paths',
      'protected_acceptance_paths',
      'verification_artifact_paths',
      'oracle_paths',
      'acceptance_paths',
      'output_paths',
      ...(record.meta.type === 'task' ? ['allowed_paths'] : []),
    ])
      for (const path of strings(record.meta.data[field])) remember(path);
    for (const field of ['file_baseline', 'artifact_hashes', 'protected_files']) {
      const inputs = record.meta.data[field];
      if (inputs && typeof inputs === 'object')
        for (const path of Object.keys(inputs)) remember(path);
    }
    const practice = record.meta.data.practice as Record<string, unknown> | undefined;
    for (const field of ['exercise_path', 'answer_path', 'solution_path'])
      if (typeof practice?.[field] === 'string') remember(practice[field] as string);
    for (const source of Array.isArray(record.meta.data.sources) ? record.meta.data.sources : [])
      if (
        source &&
        typeof source.uri === 'string' &&
        !/^[a-z]+:/i.test(source.uri) &&
        !source.record_id
      )
        remember(source.uri);
  }
  const covered = (path: string) =>
    [...reviewedPaths].some(
      (scope) => scope === '.' || path === scope || path.startsWith(scope + '/'),
    );
  const control = (path: string) =>
    path.startsWith('.verythinker/records/') ||
    path.startsWith('.verythinker/native/keys/') ||
    [
      '.verythinker/config.json',
      '.verythinker/id-sequence.json',
      '.verythinker/automation.json',
      policyPath,
      '.verythinker/archive-restoration.json',
      '.verythinker/routing.json',
      '.verythinker/tools.json',
      '.verythinker/pack-lock.json',
      '.verythinker/tool-lock.json',
      '.verythinker/tools.lock.json',
      '.verythinker/native-runtime.lock.json',
      '.verythinker/native/trust.json',
    ].includes(path);
  for (const file of prior?.files ?? []) {
    if (control(file.path) || covered(file.path)) continue;
    if (
      !existsSync(safePath(root, file.path)) ||
      hash(readFileSync(safePath(root, file.path))) !== file.hash
    )
      throw new Error(
        `Historical archive input changed outside this increment's reviewed source and allowed scope: ${file.path}. Preserve unrelated work and obtain a scoped reassessment before export.`,
      );
  }
  const add = (path: string, optional = false) => {
    canonical(path);
    if (prohibited(path))
      throw new Error(
        `Archive references excluded or sensitive storage: ${path}. Archive evidence logs before review.`,
      );
    const target = safePath(root, path);
    // Reject links, including links pointing inside the project, to preserve portable membership.
    let current = target;
    while (current !== resolve(root)) {
      if (existsSync(current) && lstatSync(current).isSymbolicLink())
        throw new Error(`Archive input is a symbolic link: ${path}`);
      current = dirname(current);
    }
    if (!existsSync(target)) {
      if (optional) return;
      throw new Error(`Required archive input is missing: ${path}`);
    }
    const candidates = lstatSync(target).isDirectory()
      ? filesUnder(root, path).map((file) => file.replaceAll('\\', '/'))
      : [path];
    for (const file of candidates) {
      if (prohibited(file)) throw new Error(`Archive input contains excluded storage: ${file}`);
      paths.add(canonical(file));
    }
  };
  for (const record of records) {
    add(record.path);
    const data = record.meta.data;
    for (const field of [
      'outputs',
      'documentation_paths',
      'protected_paths',
      'acceptance_paths',
      'output_paths',
      'protected_acceptance_paths',
      'verification_artifact_paths',
      'oracle_paths',
    ])
      for (const path of strings(data[field])) {
        approved.add(path);
        add(path, prior?.files.some((file) => file.path === path) ?? false);
      }
    for (const field of ['artifact_hashes', 'protected_files']) {
      const map = data[field];
      if (map && typeof map === 'object')
        for (const path of Object.keys(map)) {
          approved.add(path);
          add(path);
        }
    }
    const practice = data.practice as Record<string, unknown> | undefined;
    for (const key of ['exercise_path', 'answer_path', 'solution_path'])
      if (typeof practice?.[key] === 'string') {
        approved.add(practice[key] as string);
        add(practice[key] as string);
      }
    for (const source of Array.isArray(data.sources) ? data.sources : [])
      if (
        source &&
        typeof source.uri === 'string' &&
        !/^[a-z]+:/i.test(source.uri) &&
        !source.record_id
      ) {
        approved.add(source.uri);
        add(source.uri);
      }
    const baseline = data.file_baseline;
    if (baseline && typeof baseline === 'object')
      for (const path of Object.keys(baseline)) {
        approved.add(path);
        if (
          record.meta.type === 'evidence' &&
          evidenceInputs[record.meta.id] &&
          !existsSync(safePath(root, path))
        )
          continue;
        // Historical evidence may refer to a file removed by this increment.
        // Current acceptance gates still require every current evidence input.
        add(path, prior?.files.some((file) => file.path === path) ?? false);
      }
    if (record.meta.type === 'evidence' && evidenceInputs[record.meta.id])
      for (const path of evidenceInputArtifactPaths(root, evidenceInputs[record.meta.id]!))
        add(path);
    const submission = data.submission as Record<string, unknown> | undefined;
    if (submission?.documentation_snapshot && typeof submission.documentation_snapshot === 'object')
      for (const path of Object.keys(submission.documentation_snapshot)) {
        approved.add(path);
        add(path, prior?.files.some((file) => file.path === path) ?? false);
      }
    for (const [key, value] of Object.entries(data)) {
      if (key.endsWith('_path') && typeof value === 'string' && !/^(?:[a-z]+:|\/)/i.test(value)) {
        approved.add(value);
        add(value);
      }
      if (
        /(?:receipt|invocation)_id$/.test(key) &&
        typeof value === 'string' &&
        snapshotPattern.test(value)
      )
        add(`.verythinker/native/receipts/${value}.json`);
    }
    for (const id of [
      data.invocation_id,
      ...strings(data.prior_invocation_ids),
      ...strings(data.covered_invocation_ids),
    ])
      if (
        typeof id === 'string' &&
        snapshotPattern.test(id) &&
        existsSync(safePath(root, `.verythinker/native/receipts/${id}.json`))
      )
        add(`.verythinker/native/receipts/${id}.json`);
  }
  for (const path of sourcePaths) {
    canonical(path);
    if (![...approved].some((input) => path === input || path.startsWith(`${input}/`)))
      throw new Error(
        `Additional archive input is outside reviewed task outputs and evidence: ${path}`,
      );
    add(path);
  }
  // Old accepted files remain part of project history, except files explicitly absent now.
  for (const file of prior?.files ?? []) if (!prohibited(file.path)) add(file.path, true);
  for (const path of [
    '.verythinker/config.json',
    '.verythinker/id-sequence.json',
    '.verythinker/automation.json',
    policyPath,
    '.verythinker/routing.json',
    '.verythinker/tools.json',
    '.verythinker/archive-restoration.json',
    '.verythinker/pack-lock.json',
    '.verythinker/recipe-lock.json',
    '.verythinker/tool-lock.json',
    '.verythinker/tools.lock.json',
    '.verythinker/native-runtime.lock.json',
    '.verythinker/native/trust.json',
    '.verythinker/native/keys',
    '.codex/config.toml',
  ])
    add(path, true);
  const packsPath = safePath(root, '.verythinker/pack-lock.json');
  if (existsSync(packsPath))
    for (const pack of JSON.parse(readFileSync(packsPath, 'utf8')).packs ?? []) {
      if (typeof pack.path !== 'string') throw new Error('Locked pack has no portable path.');
      add(pack.path);
    }
  const toolsPath = safePath(root, '.verythinker/tool-lock.json');
  if (existsSync(toolsPath))
    for (const provider of JSON.parse(readFileSync(toolsPath, 'utf8')).providers ?? []) {
      if (
        typeof provider.dependency_lock_path !== 'string' ||
        typeof provider.dependency_lock_hash !== 'string'
      )
        throw new Error(
          `Locked provider lacks reproducible dependency-lock identity: ${String(provider.id)}`,
        );
      const path = canonical(provider.dependency_lock_path);
      if (!path.startsWith('.verythinker/tool-locks/'))
        throw new Error(`Provider dependency lock is outside project lock storage: ${path}`);
      if (
        !existsSync(safePath(root, path)) ||
        hash(readFileSync(safePath(root, path))) !== provider.dependency_lock_hash
      )
        throw new Error(`Provider dependency lock is missing or changed: ${path}`);
      add(path);
    }
  return {
    paths: [...paths].sort(),
    omissions: [
      'Derived SQLite indexes, caches, installed tools, operation locks, raw sessions, credentials, and unrelated active records are excluded.',
    ],
  };
}
export function prepareArchive(
  root: string,
  workflowId: string,
  options: { disposition?: 'working' | 'accepted'; source_paths?: string[] } = {},
): ArchiveSnapshot {
  return withOperationLock(root, 'archive-prepare', () => {
    const policy = policyFor(root);
    const parent = workflow(root, workflowId);
    const disposition = options.disposition ?? 'accepted';
    if (!['working', 'accepted'].includes(disposition))
      throw new Error('Unknown archive disposition.');
    if (disposition === 'accepted') accepted(root, parent);
    const change = parent.meta.data.change_type ?? 'feature';
    if (!['breaking-change', 'feature', 'fix'].includes(String(change)))
      throw new Error('Archive change classification requires breaking-change, feature, or fix.');
    const prior = previous(root, policy);
    const records = closure(root, parent, prior);
    const evidenceInputs: Record<string, EvidenceInputSnapshot> = {};
    let candidates: string[] | null = null;
    for (const record of records.filter((item) => item.meta.type === 'evidence')) {
      const data = record.meta.data;
      const reference =
        (data.input_snapshot as EvidenceInputSnapshot | undefined) ??
        prior?.evidence_inputs?.[record.meta.id];
      const expected = {
        files: data.file_baseline as Record<string, string>,
        record_fingerprints: data.record_baseline as Record<string, string>,
        check_id: typeof data.check_id === 'string' ? data.check_id : undefined,
        check_fingerprint:
          typeof data.check_fingerprint === 'string' ? data.check_fingerprint : undefined,
      };
      if (reference) {
        evidenceInputArtifactPaths(root, reference, expected);
        evidenceInputs[record.meta.id] = reference;
      } else {
        if (!candidates) {
          candidates = [];
          for (const id of existsSync(safePath(root, '.verythinker/archives'))
            ? readdirSync(safePath(root, '.verythinker/archives'))
            : []) {
            if (!snapshotPattern.test(id)) continue;
            const cached = readSnapshot(root, id);
            if (cached.manifest.project_id === policy.project_id)
              candidates.push(safePath(root, `${cached.path}/workspace`));
          }
        }
        evidenceInputs[record.meta.id] = recoverLegacyEvidenceInputs(root, record, candidates);
      }
      const version = validateEvidenceInputs(root, evidenceInputs[record.meta.id]!);
      for (const [path, artifact] of [
        ...Object.entries(version.files),
        ...Object.entries(version.context_files),
        ...Object.values(version.records).map((item) => [item.path, item] as const),
      ]) {
        if (prohibited(path))
          throw new Error(
            `Historical evidence ${record.meta.id} references excluded or sensitive original input: ${path}. Export requires a reviewed nonsensitive reproduction.`,
          );
        secretCheck(path, readFileSync(safePath(root, artifact.blob_path)));
      }
    }
    const inputs = collectFiles(
      root,
      parent,
      records,
      prior,
      options.source_paths ?? [],
      evidenceInputs,
    );
    const snapshotId = randomUUID();
    const directory = `.verythinker/archives/${snapshotId}`;
    const fileEntries = inputs.paths.map((path) => {
      const bytes = readFileSync(safePath(root, path));
      secretCheck(path, bytes);
      const mode: '100644' | '100755' =
        lstatSync(safePath(root, path)).mode & 0o111 ? '100755' : '100644';
      atomicWrite(safePath(root, `${directory}/workspace/${path}`), bytes);
      return { path, hash: hash(bytes), mode, bytes: bytes.length };
    });
    const git = spawnSync('git', ['rev-parse', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 5000,
    });
    const submodules = spawnSync('git', ['ls-files', '--stage'], {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 5000,
    });
    const modules = (submodules.status === 0 ? submodules.stdout : '')
      .split('\n')
      .flatMap((line) => {
        const match = /^160000 ([a-f0-9]+) \d\t(.+)$/.exec(line);
        return match ? [{ path: match[2]!, commit: match[1]! }] : [];
      });
    for (const module of modules)
      if (inputs.paths.some((path) => path === module.path || path.startsWith(module.path + '/')))
        throw new Error(
          `Referenced submodule source requires an explicitly reviewed reproducible input export: ${module.path}`,
        );
    const manifest: ArchiveManifest = {
      schema_version: 1,
      snapshot_id: snapshotId,
      project_id: policy.project_id,
      workflow_id: parent.meta.id,
      increment_id: String(parent.meta.data.increment_id),
      disposition,
      release:
        disposition === 'accepted'
          ? nextRelease(policy.last_release, change as ArchiveManifest['change_type'])
          : null,
      change_type: change as ArchiveManifest['change_type'],
      created_at: now(),
      captured_baseline: policy.baseline_commit,
      source_revision: git.status === 0 ? git.stdout.trim() : null,
      namespace: policy.namespace,
      repository: policy.repository,
      files: fileEntries,
      records: records.map((record) => ({
        id: record.meta.id,
        path: record.path,
        fingerprint: recordFingerprint(record),
        revision: record.meta.revision,
      })),
      deleted_paths: (prior?.files ?? [])
        .filter((file) => !fileEntries.some((entry) => entry.path === file.path))
        .map((file) => file.path),
      omissions: inputs.omissions,
      evidence_inputs: evidenceInputs,
      submodules: modules,
      reproduction: [
        'Restore into a new empty directory with archive restore.',
        'Install the recorded Node/runtime and approved tools from their lockfiles; tool installations are excluded.',
        'Rebuild the derived index, then run traceability and acceptance checks against the restored records.',
        'Evidence remains limited to its recorded environment; rerun checks when the environment changes.',
      ],
    };
    const encoded = JSON.stringify(manifest, null, 2) + '\n';
    atomicWrite(safePath(root, `${directory}/manifest.json`), encoded);
    atomicWrite(
      safePath(root, `${directory}/identity.json`),
      JSON.stringify({ schema_version: 1, manifest_hash: hash(encoded) }, null, 2) + '\n',
    );
    return readSnapshot(root, snapshotId);
  });
}
function readSnapshot(root: string, id: string): ArchiveSnapshot {
  if (!snapshotPattern.test(id)) throw new Error('Invalid archive snapshot ID.');
  const path = `.verythinker/archives/${id}`;
  const encoded = readFileSync(safePath(root, `${path}/manifest.json`));
  const manifest = JSON.parse(encoded.toString('utf8')) as ArchiveManifest;
  const identity = JSON.parse(readFileSync(safePath(root, `${path}/identity.json`), 'utf8'));
  if (
    manifest.schema_version !== 1 ||
    manifest.snapshot_id !== id ||
    !Array.isArray(manifest.files) ||
    !Array.isArray(manifest.records) ||
    identity.manifest_hash !== hash(encoded)
  )
    throw new Error('Archive manifest identity is invalid or changed.');
  if (
    new Set(manifest.files.map((file) => canonical(file.path))).size !== manifest.files.length ||
    new Set(manifest.records.map((record) => record.id)).size !== manifest.records.length
  )
    throw new Error('Archive contains duplicate paths or record IDs.');
  const actual = filesUnder(root, `${path}/workspace`)
    .map((file) => file.replaceAll('\\', '/').slice(`${path}/workspace/`.length))
    .sort();
  if (JSON.stringify(actual) !== JSON.stringify(manifest.files.map((file) => file.path).sort()))
    throw new Error('Archive workspace membership differs from its manifest.');
  for (const file of manifest.files) {
    const content = readFileSync(safePath(root, `${path}/workspace/${canonical(file.path)}`));
    if (hash(content) !== file.hash || content.length !== file.bytes)
      throw new Error(`Archive file is changed: ${file.path}`);
  }
  return { snapshot_id: id, path, manifest_hash: hash(encoded), manifest };
}
function githubRequest(method: string, endpoint: string, body?: unknown): any {
  const result = spawnSync(
    'gh',
    ['api', '--method', method, endpoint, ...(body === undefined ? [] : ['--input', '-'])],
    {
      input: body === undefined ? undefined : JSON.stringify(body),
      encoding: 'utf8',
      windowsHide: true,
      timeout: 60000,
      maxBuffer: 8 * 1024 * 1024,
    },
  );
  if (result.error || result.status !== 0)
    throw new Error(
      `Archive GitHub request failed: ${result.error?.message ?? result.stderr.trim()}`,
    );
  return JSON.parse(result.stdout);
}
/** Check the publication boundary before freezing a new manager archive intent. */
export function assertPrivateArchiveDestination(
  root: string,
  options: { request?: ArchiveRequest } = {},
): ArchivePolicy {
  const policy = policyFor(root);
  const request = options.request ?? githubRequest;
  if (request('GET', `repos/${policy.repository}`).private !== true)
    throw new Error(
      'Project archives require a confirmed private upstream repository. No project records were uploaded.',
    );
  return policy;
}
function ref(request: ArchiveRequest, repository: string, name: string): string | null {
  try {
    const value = request('GET', `repos/${repository}/git/ref/heads/${encodeURIComponent(name)}`);
    if (typeof value.object?.sha !== 'string')
      throw new Error('GitHub reference has no commit identity.');
    return value.object.sha;
  } catch (error) {
    if ((error as { status?: number }).status === 404 || /\bHTTP\s*404\b/i.test(String(error)))
      return null;
    throw error;
  }
}
function currentInputs(root: string, snapshot: ArchiveSnapshot): void {
  for (const file of snapshot.manifest.files)
    if (
      !existsSync(safePath(root, file.path)) ||
      hash(readFileSync(safePath(root, file.path))) !== file.hash
    )
      throw new Error(
        `Archive input changed before publication: ${file.path}. Prepare a new reviewed snapshot.`,
      );
  if (snapshot.manifest.disposition === 'accepted')
    accepted(root, workflow(root, snapshot.manifest.workflow_id));
}
export function publishArchive(
  root: string,
  id: string,
  options: { request?: ArchiveRequest } = {},
): ArchivePublication {
  return withOperationLock(root, 'archive-publication', () => {
    const snapshot = readSnapshot(root, id);
    const manifest = snapshot.manifest;
    const policy = policyFor(root);
    const request = options.request ?? githubRequest;
    const statePath = safePath(root, `${snapshot.path}/publication.json`);
    const prior = existsSync(statePath)
      ? (JSON.parse(readFileSync(statePath, 'utf8')) as ArchivePublication)
      : null;
    if (
      prior &&
      (prior.snapshot_id !== id ||
        prior.manifest_hash !== snapshot.manifest_hash ||
        prior.repository !== policy.repository)
    )
      throw new Error('Archive publication belongs to different frozen content or upstream.');
    if (manifest.namespace !== policy.namespace || manifest.repository !== policy.repository)
      throw new Error('Archive policy changed; prepare a new snapshot.');
    const state: ArchivePublication = prior ?? {
      schema_version: 1,
      snapshot_id: id,
      manifest_hash: snapshot.manifest_hash,
      repository: policy.repository,
      status: 'planned',
      blobs: {},
    };
    const persist = () => atomicWrite(statePath, JSON.stringify(state, null, 2) + '\n');
    const repo = request('GET', `repos/${policy.repository}`);
    if (repo.private !== true)
      throw new Error(
        'Project archives require a confirmed private upstream repository. No project records were uploaded.',
      );
    if (state.status === 'completed') return state;
    persist();
    if (manifest.disposition === 'accepted') accepted(root, workflow(root, manifest.workflow_id));
    const baselineBranch = `${manifest.namespace}/baseline`;
    const incrementBranch = `${manifest.namespace}/increments/${manifest.increment_id}`;
    const releaseBranch = manifest.release
      ? `${manifest.namespace}/releases/${manifest.release}`
      : null;
    let remoteBaseline = ref(request, policy.repository, baselineBranch);
    const releaseRef = releaseBranch ? ref(request, policy.repository, releaseBranch) : null;
    if (releaseRef && releaseRef !== state.commit)
      throw new Error(
        'Immutable archive release already exists with different content. Reassess classification and baseline.',
      );
    const incrementRef = ref(request, policy.repository, incrementBranch);
    const archiveDirectory = safePath(root, '.verythinker/archives');
    for (const item of existsSync(archiveDirectory) ? readdirSync(archiveDirectory) : []) {
      if (item === id || !snapshotPattern.test(item)) continue;
      const publicationPath = safePath(root, `.verythinker/archives/${item}/publication.json`);
      if (!existsSync(publicationPath)) continue;
      const publication = JSON.parse(readFileSync(publicationPath, 'utf8')) as ArchivePublication;
      if (!['baseline-advanced', 'release-created', 'completed'].includes(publication.status))
        continue;
      const historical = readSnapshot(root, item).manifest;
      if (
        historical.disposition === 'accepted' &&
        historical.increment_id === manifest.increment_id
      )
        throw new Error('Accepted increment is frozen; begin a new increment.');
    }
    if (policy.last_snapshot_id && policy.last_snapshot_id !== id) {
      const last = readSnapshot(root, policy.last_snapshot_id).manifest;
      if (last.increment_id === manifest.increment_id)
        throw new Error('Accepted increment is frozen; begin a new increment.');
    }
    const isOwnBaseline = !!state.commit && remoteBaseline === state.commit;
    let baselineIncludesCommit = isOwnBaseline;
    if (state.commit && remoteBaseline && !isOwnBaseline && manifest.disposition === 'accepted') {
      const comparison = request(
        'GET',
        `repos/${policy.repository}/compare/${state.commit}...${remoteBaseline}`,
      );
      baselineIncludesCommit = comparison.status === 'ahead' || comparison.status === 'identical';
    }
    if (
      !baselineIncludesCommit &&
      (policy.baseline_commit !== manifest.captured_baseline ||
        remoteBaseline !== manifest.captured_baseline)
    )
      throw new Error(
        'Project archive baseline moved after preparation. Reassess affected work and prepare a fresh snapshot.',
      );
    if (!baselineIncludesCommit) currentInputs(root, snapshot);
    if (!state.base_commit) {
      if (remoteBaseline) state.base_commit = remoteBaseline;
      else {
        if (typeof repo.default_branch !== 'string')
          throw new Error('Private upstream has no default branch.');
        state.base_commit = ref(request, policy.repository, repo.default_branch) ?? undefined;
      }
      if (!state.base_commit) throw new Error('Private upstream has no initial commit.');
      const base = request('GET', `repos/${policy.repository}/git/commits/${state.base_commit}`);
      if (typeof base.tree?.sha !== 'string')
        throw new Error('Archive baseline has no tree identity.');
      state.base_tree = base.tree.sha;
      state.increment_parent = incrementRef;
      persist();
    }
    const prefix = `projects/${manifest.project_id}/workspace`;
    if (!state.tree) {
      for (const file of manifest.files)
        if (!state.blobs[file.path]) {
          const blob = request('POST', `repos/${policy.repository}/git/blobs`, {
            content: readFileSync(
              safePath(root, `${snapshot.path}/workspace/${file.path}`),
            ).toString('base64'),
            encoding: 'base64',
          });
          if (typeof blob.sha !== 'string')
            throw new Error('GitHub did not return an archive blob identity.');
          state.blobs[file.path] = blob.sha;
          persist();
        }
      state.status = 'blobs-created';
      persist();
      const tree = request('POST', `repos/${policy.repository}/git/trees`, {
        base_tree: state.base_tree,
        tree: [
          ...manifest.files.map((file) => ({
            path: `${prefix}/${file.path}`,
            mode: file.mode,
            type: 'blob',
            sha: state.blobs[file.path],
          })),
          ...manifest.deleted_paths.map((path) => ({
            path: `${prefix}/${path}`,
            mode: '100644',
            type: 'blob',
            sha: null,
          })),
          {
            path: `projects/${manifest.project_id}/manifests/${id}.json`,
            mode: '100644',
            type: 'blob',
            content: JSON.stringify(manifest, null, 2) + '\n',
          },
          {
            path: `projects/${manifest.project_id}/manifest.json`,
            mode: '100644',
            type: 'blob',
            content: JSON.stringify(manifest, null, 2) + '\n',
          },
        ],
      });
      if (typeof tree.sha !== 'string')
        throw new Error('GitHub did not return an archive tree identity.');
      state.tree = tree.sha;
      state.status = 'tree-created';
      persist();
    }
    if (!state.commit) {
      // Fixed attribution/date makes Git object creation idempotent when a successful
      // response is lost before the local commit identity can be persisted.
      const attribution = {
        name: 'VeryThinker Archive',
        email: 'archive@verythinker.invalid',
        date: manifest.created_at,
      };
      const commit = request('POST', `repos/${policy.repository}/git/commits`, {
        message: `${manifest.disposition === 'accepted' ? `Archive ${manifest.project_id} ${manifest.release}` : `Checkpoint ${manifest.project_id}`} increment ${manifest.increment_id}`,
        tree: state.tree,
        parents: [...new Set([state.base_commit, state.increment_parent].filter(Boolean))],
        author: attribution,
        committer: attribution,
      });
      if (typeof commit.sha !== 'string')
        throw new Error('GitHub did not return an archive commit identity.');
      state.commit = commit.sha;
      state.status = 'commit-created';
      persist();
    }
    const advance = (branch: string, expected: string | null, immutable = false) => {
      const actual = ref(request, policy.repository, branch);
      if (actual === state.commit) return;
      if (actual !== expected)
        throw new Error(
          `Archive reference moved during publication: ${branch}. Reassess before retrying.`,
        );
      if (actual && immutable)
        throw new Error(`Immutable archive reference already exists: ${branch}`);
      if (actual)
        request(
          'PATCH',
          `repos/${policy.repository}/git/refs/heads/${encodeURIComponent(branch)}`,
          { sha: state.commit, force: false },
        );
      else
        request('POST', `repos/${policy.repository}/git/refs`, {
          ref: `refs/heads/${branch}`,
          sha: state.commit,
        });
    };
    if (manifest.disposition === 'accepted') {
      if (!baselineIncludesCommit) {
        currentInputs(root, snapshot);
        advance(baselineBranch, manifest.captured_baseline);
      }
      state.status = 'baseline-advanced';
      persist();
      advance(releaseBranch!, null, true);
      state.status = 'release-created';
      persist();
    }
    advance(incrementBranch, state.increment_parent ?? null);
    if (manifest.disposition === 'accepted') {
      // Publication metadata is separate from the frozen workspace and does not claim its later revision was archived.
      const latest = policyFor(root);
      if (
        latest.baseline_commit !== state.commit &&
        latest.baseline_commit !== manifest.captured_baseline &&
        !baselineIncludesCommit
      )
        throw new Error(
          'Local archive baseline moved; recover publication history before continuing.',
        );
      remoteBaseline = ref(request, policy.repository, baselineBranch);
      if (remoteBaseline === state.commit)
        atomicWrite(
          safePath(root, policyPath),
          JSON.stringify(
            {
              ...latest,
              baseline_commit: state.commit,
              last_release: manifest.release,
              last_snapshot_id: id,
            },
            null,
            2,
          ) + '\n',
        );
    }
    state.status = 'completed';
    state.completed_at = now();
    persist();
    return state;
  });
}
export function archiveStatus(root: string, id?: string): unknown {
  if (!id) {
    const directory = safePath(root, '.verythinker/archives');
    return {
      policy: readArchivePolicy(root),
      snapshots: existsSync(directory)
        ? readdirSync(directory)
            .filter(
              (item) =>
                snapshotPattern.test(item) &&
                existsSync(safePath(root, `.verythinker/archives/${item}/manifest.json`)),
            )
            .map((item) => archiveStatus(root, item))
        : [],
    };
  }
  const snapshot = readSnapshot(root, id);
  const path = safePath(root, `${snapshot.path}/publication.json`);
  return {
    ...snapshot,
    publication: existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null,
  };
}
/** Recover a proven accepted publication while keeping its engineering baseline frozen. */
export function acceptedArchiveForWorkflow(
  root: string,
  workflowId: string,
): AcceptedArchive | null {
  const parent = workflow(root, workflowId);
  const candidates = new Set<string>();
  const policy = readArchivePolicy(root);
  if (policy?.last_snapshot_id) candidates.add(policy.last_snapshot_id);
  const stored = parent.meta.data.archive as Record<string, unknown> | undefined;
  if (typeof stored?.snapshot_id === 'string') candidates.add(stored.snapshot_id);
  const intentPath = safePath(root, `.verythinker/archive-intents/${hash(workflowId)}.json`);
  if (existsSync(intentPath)) {
    const intent = JSON.parse(readFileSync(intentPath, 'utf8'));
    if (typeof intent.snapshot_id === 'string') candidates.add(intent.snapshot_id);
  }
  const restorationPath = safePath(root, '.verythinker/archive-restoration.json');
  if (existsSync(restorationPath)) {
    const restoration = JSON.parse(readFileSync(restorationPath, 'utf8'));
    if (typeof restoration.snapshot_id === 'string') candidates.add(restoration.snapshot_id);
  }
  for (const id of candidates) {
    const snapshot = readSnapshot(root, id);
    if (
      snapshot.manifest.workflow_id !== workflowId ||
      snapshot.manifest.disposition !== 'accepted'
    )
      continue;
    const publicationPath = safePath(root, `${snapshot.path}/publication.json`);
    if (!existsSync(publicationPath)) continue;
    const publication = JSON.parse(readFileSync(publicationPath, 'utf8')) as ArchivePublication;
    if (publication.status !== 'completed') continue;
    if (
      publication.snapshot_id !== id ||
      publication.manifest_hash !== snapshot.manifest_hash ||
      publication.repository !== snapshot.manifest.repository ||
      typeof publication.commit !== 'string'
    )
      throw new Error('Accepted archive publication identity cannot be verified.');
    const frozenParent = getRecord(safePath(root, `${snapshot.path}/workspace`), workflowId);
    for (const field of [
      'increment_id',
      'requirement_id',
      'requirement_ids',
      'task_ids',
      'decision_id',
      'change_type',
      'original_requirement',
      'original_requirements',
      'routing_required',
      'open_questions',
    ])
      if (JSON.stringify(parent.meta.data[field]) !== JSON.stringify(frozenParent.meta.data[field]))
        throw new Error(
          `Accepted archive workflow contract changed: ${field}. Begin a new managed increment.`,
        );
    const archivedIds = new Set(snapshot.manifest.records.map((record) => record.id));
    for (const current of closure(root, parent, null))
      if (
        !archivedIds.has(current.meta.id) &&
        ['task', 'requirement', 'design', 'check', 'evidence', 'review'].includes(current.meta.type)
      )
        throw new Error(
          `Accepted archive engineering closure changed: ${current.meta.id}. Begin a new managed increment.`,
        );
    const ignored = new Set([
      parent.path,
      '.verythinker/id-sequence.json',
      '.verythinker/archive.json',
      '.verythinker/archive-restoration.json',
    ]);
    for (const record of snapshot.manifest.records) {
      if (record.id === workflowId) continue;
      const current = getRecord(root, record.id);
      if (current.path !== record.path || recordFingerprint(current) !== record.fingerprint)
        throw new Error(
          `Accepted archive engineering record changed: ${record.id}. Begin a new managed increment.`,
        );
    }
    for (const file of snapshot.manifest.files) {
      if (ignored.has(file.path) || file.path.startsWith('.verythinker/native/completion/'))
        continue;
      if (
        !existsSync(safePath(root, file.path)) ||
        hash(readFileSync(safePath(root, file.path))) !== file.hash
      )
        throw new Error(
          `Accepted archive implementation, evidence, or lock changed: ${file.path}. Begin a new managed increment.`,
        );
    }
    for (const deleted of snapshot.manifest.deleted_paths)
      if (existsSync(safePath(root, deleted)))
        throw new Error(
          `Accepted archive deletion changed: ${deleted}. Begin a new managed increment.`,
        );
    return { snapshot, publication, derived: stored?.snapshot_id !== id };
  }
  return null;
}
export interface ArchiveReassessment {
  schema_version: 1;
  reassessment_id: string;
  workflow_id: string;
  change_id: string;
  change_fingerprint: string;
  reason: string;
  snapshot_id: string;
  retired_snapshot_id: string | null;
  manifest_hash: string;
  observed_baseline: string | null;
  status: 'ready-for-fresh-preparation' | 'integration-required';
  reconciled_snapshot_id: string | null;
  blocker: string | null;
  next_action: string;
  created_at: string;
  receipt_path: string;
}
/** Retire a reviewed, demonstrably unpublished acceptance intent without deleting history. */
export function reassessArchive(
  root: string,
  workflowId: string,
  input: { change_id: string; reason: string; request?: ArchiveRequest },
): ArchiveReassessment {
  return withOperationLock(root, 'archive-publication', () => {
    const parent = workflow(root, workflowId);
    const policy = policyFor(root);
    const intentPath = safePath(root, `.verythinker/archive-intents/${hash(workflowId)}.json`);
    if (!existsSync(intentPath)) throw new Error('Workflow has no archive intent to reassess.');
    const intent = JSON.parse(readFileSync(intentPath, 'utf8'));
    // A retry after successful local transition returns the immutable receipt.
    if (!intent.snapshot_id && typeof intent.reassessment_id === 'string') {
      const receipt = JSON.parse(
        readFileSync(
          safePath(root, `.verythinker/archive-reassessments/${intent.reassessment_id}.json`),
          'utf8',
        ),
      ) as ArchiveReassessment;
      if (receipt.change_id !== input.change_id || receipt.reason !== input.reason.trim())
        throw new Error(
          'Retired archive intent is already bound to another reviewed reassessment.',
        );
      return receipt;
    }
    if (typeof intent.snapshot_id !== 'string')
      throw new Error('Workflow has no unpublished snapshot intent to reassess.');
    const snapshot = readSnapshot(root, intent.snapshot_id);
    const manifest = snapshot.manifest;
    if (
      manifest.workflow_id !== workflowId ||
      manifest.increment_id !== parent.meta.data.increment_id ||
      manifest.disposition !== 'accepted' ||
      manifest.namespace !== policy.namespace ||
      manifest.repository !== policy.repository
    )
      throw new Error('Archive intent does not belong to the current project increment.');
    if (typeof input.reason !== 'string')
      throw new Error('Archive reassessment requires a reason string.');
    const reason = input.reason.trim();
    if (reason.length < 24 || reason.split(/\s+/).length < 4)
      throw new Error('Archive reassessment requires a specific substantive reason.');
    const change = getRecord(root, input.change_id);
    if (
      change.meta.type !== 'change' ||
      !change.meta.links.some((link) => link.target === workflowId) ||
      change.meta.data.archive_snapshot_id !== snapshot.snapshot_id ||
      change.meta.data.reason !== reason ||
      !hasCurrentReview(root, change.meta.id)
    )
      throw new Error(
        'Archive reassessment requires a current independent review of a linked change naming this snapshot and exact reason.',
      );
    const changeFingerprint = recordFingerprint(change);
    const publicationPath = safePath(root, `${snapshot.path}/publication.json`);
    const publicationExists = existsSync(publicationPath);
    const publication = publicationExists
      ? (JSON.parse(readFileSync(publicationPath, 'utf8')) as ArchivePublication)
      : null;
    if (
      publication &&
      (publication.snapshot_id !== snapshot.snapshot_id ||
        publication.manifest_hash !== snapshot.manifest_hash ||
        publication.repository !== policy.repository)
    )
      throw new Error(
        'Archive publication identity is inconsistent; recover it before reassessment.',
      );
    const request = input.request ?? githubRequest;
    const privateUpstream = request('GET', `repos/${policy.repository}`).private;
    if (privateUpstream !== true && privateUpstream !== false)
      throw new Error('Archive reassessment requires a confirmed private upstream.');
    const baseline = ref(request, policy.repository, `${policy.namespace}/baseline`);
    const release = ref(
      request,
      policy.repository,
      `${policy.namespace}/releases/${manifest.release}`,
    );
    const increment = ref(
      request,
      policy.repository,
      `${policy.namespace}/increments/${manifest.increment_id}`,
    );
    if (
      privateUpstream === false &&
      (publicationExists || baseline !== null || release !== null || increment !== null)
    )
      throw new Error(
        'Public archive recovery requires a never-started snapshot with no publication receipt or project references. Preserve the intent and recover its recorded upstream history.',
      );
    let acceptedCommit = Boolean(
      publication?.commit && [baseline, release, increment].includes(publication.commit),
    );
    if (publication?.commit && baseline && !acceptedCommit) {
      const comparison = request(
        'GET',
        `repos/${policy.repository}/compare/${publication.commit}...${baseline}`,
      );
      if (!['ahead', 'identical', 'behind', 'diverged'].includes(comparison.status))
        throw new Error(
          'Upstream did not prove archive commit ancestry; reassessment cannot retire the intent.',
        );
      acceptedCommit = ['ahead', 'identical'].includes(comparison.status);
    }
    if (
      acceptedCommit ||
      (publication &&
        ['baseline-advanced', 'release-created', 'completed'].includes(publication.status))
    )
      throw new Error(
        'Accepted archive refs or publication history are frozen; preserve them and begin a new managed increment.',
      );
    let known: ArchiveSnapshot | null = null;
    let blocker: string | null = null;
    if (baseline !== policy.baseline_commit) {
      const directory = safePath(root, '.verythinker/archives');
      for (const id of existsSync(directory) ? readdirSync(directory) : []) {
        if (!snapshotPattern.test(id)) continue;
        const path = safePath(root, `.verythinker/archives/${id}/publication.json`);
        if (!existsSync(path)) continue;
        const state = JSON.parse(readFileSync(path, 'utf8')) as ArchivePublication;
        if (
          state.status !== 'completed' ||
          state.commit !== baseline ||
          state.repository !== policy.repository
        )
          continue;
        const candidate = readSnapshot(root, id);
        if (
          candidate.manifest.disposition !== 'accepted' ||
          candidate.manifest.project_id !== policy.project_id ||
          candidate.manifest.namespace !== policy.namespace ||
          candidate.manifest_hash !== state.manifest_hash ||
          candidate.manifest.repository !== policy.repository
        )
          continue;
        known = candidate;
        break;
      }
      if (!known)
        blocker = `Remote project baseline ${baseline ?? '(missing)'} has no verified completed snapshot in the local cache. Import/integrate that exact private baseline and reassess affected requirements, implementation, and evidence; remote archive hydration is not supported by this operation.`;
      else {
        const affectedPaths = strings(change.meta.data.affected_paths).map(canonical);
        const affectedRecords = new Set(strings(change.meta.data.affected_records));
        const scopeRecords = new Set(closure(root, parent, null).map((record) => record.meta.id));
        for (const id of affectedRecords)
          if (!scopeRecords.has(id))
            throw new Error(`Reviewed reassessment record is outside the workflow closure: ${id}`);
        const assigned = strings(parent.meta.data.task_ids).flatMap((id) =>
          strings(getRecord(root, id).meta.data.allowed_paths).map(
            (scope) => relative(resolve(root), safePath(root, scope)).replaceAll('\\', '/') || '.',
          ),
        );
        for (const path of affectedPaths)
          if (
            !assigned.some(
              (scope) =>
                scope === '.' || path === scope || path.startsWith(scope.replace(/\/$/, '') + '/'),
            )
          )
            throw new Error(`Reviewed reassessment path is outside the assigned scope: ${path}`);
        const ignored = new Set([
          getRecord(root, known.manifest.workflow_id).path,
          '.verythinker/id-sequence.json',
          '.verythinker/archive.json',
          '.verythinker/archive-restoration.json',
        ]);
        const deviations: string[] = [];
        for (const file of known.manifest.files) {
          if (
            ignored.has(file.path) ||
            affectedPaths.some((path) => file.path === path || file.path.startsWith(path + '/'))
          )
            continue;
          if (
            file.path.startsWith('.verythinker/records/') &&
            known.manifest.records.some(
              (record) => record.path === file.path && affectedRecords.has(record.id),
            )
          )
            continue;
          if (
            !existsSync(safePath(root, file.path)) ||
            hash(readFileSync(safePath(root, file.path))) !== file.hash
          )
            deviations.push(file.path);
        }
        if (deviations.length)
          blocker = `Known remote baseline needs local integration/revalidation for unreviewed differences: ${deviations.join(', ')}. Record affected_paths/affected_records within the assigned scope and obtain a fresh independent change review before retiring the snapshot.`;
      }
    }
    const directory = '.verythinker/archive-reassessments';
    const prior = existsSync(safePath(root, directory))
      ? filesUnder(root, directory)
          .filter((path) => path.endsWith('.json'))
          .map(
            (path) => JSON.parse(readFileSync(safePath(root, path), 'utf8')) as ArchiveReassessment,
          )
          .find(
            (receipt) =>
              receipt.workflow_id === workflowId &&
              receipt.change_id === input.change_id &&
              receipt.change_fingerprint === changeFingerprint &&
              receipt.snapshot_id === snapshot.snapshot_id &&
              receipt.observed_baseline === baseline &&
              receipt.blocker === blocker,
          )
      : undefined;
    const id = prior?.reassessment_id ?? randomUUID();
    const receipt: ArchiveReassessment = prior ?? {
      schema_version: 1,
      reassessment_id: id,
      workflow_id: workflowId,
      change_id: input.change_id,
      change_fingerprint: changeFingerprint,
      reason,
      snapshot_id: snapshot.snapshot_id,
      retired_snapshot_id: blocker ? null : snapshot.snapshot_id,
      manifest_hash: snapshot.manifest_hash,
      observed_baseline: baseline,
      status: blocker ? 'integration-required' : 'ready-for-fresh-preparation',
      reconciled_snapshot_id: known?.snapshot_id ?? null,
      blocker,
      next_action: blocker
        ? 'Integrate the observed private baseline and obtain reviewed affected-scope revalidation; preserve the current archive intent.'
        : 'Reassess affected tasks, requirements, and verification. Obtain fresh evidence/reviews and a current manager decision, then prepare a new snapshot. The previous snapshot and publication history are retained.',
      created_at: now(),
      receipt_path: `${directory}/${id}.json`,
    };
    return withLock(root, () => {
      if (
        recordFingerprint(getRecord(root, change.meta.id)) !== changeFingerprint ||
        !hasCurrentReview(root, change.meta.id)
      )
        throw new Error(
          'Archive reassessment change was modified during remote inspection. Obtain a current review.',
        );
      const currentIntent = JSON.parse(readFileSync(intentPath, 'utf8'));
      if (currentIntent.snapshot_id !== snapshot.snapshot_id)
        throw new Error(
          'Archive intent changed during reassessment; preserve both histories and inspect current state.',
        );
      if (!prior)
        atomicWrite(safePath(root, receipt.receipt_path), JSON.stringify(receipt, null, 2) + '\n');
      if (blocker) {
        atomicWrite(
          intentPath,
          JSON.stringify(
            { ...currentIntent, error: blocker, reassessment_receipt: receipt.receipt_path },
            null,
            2,
          ) + '\n',
        );
        return receipt;
      }
      if (known)
        atomicWrite(
          safePath(root, policyPath),
          JSON.stringify(
            {
              ...policy,
              baseline_commit: baseline,
              last_release: known.manifest.release,
              last_snapshot_id: known.snapshot_id,
            },
            null,
            2,
          ) + '\n',
        );
      atomicWrite(
        intentPath,
        JSON.stringify(
          {
            workflow_id: workflowId,
            ...(typeof currentIntent.report_id === 'string'
              ? { report_id: currentIntent.report_id }
              : {}),
            reassessment_id: receipt.reassessment_id,
            reassessment_receipt: receipt.receipt_path,
            state: 'reassessment-required',
          },
          null,
          2,
        ) + '\n',
      );
      return receipt;
    });
  });
}
export function restoreArchive(
  root: string,
  id: string,
  destination: string,
): {
  destination: string;
  snapshot_id: string;
  records: number;
  files: number;
  reconciliation: 'published-baseline-restored' | 'local-snapshot-only';
} {
  const snapshot = readSnapshot(root, id);
  const target = resolve(destination);
  const source = resolve(root);
  if (target === source || target.startsWith(source + sep))
    throw new Error('Archive restore requires a new directory outside the source project.');
  if (
    existsSync(target) &&
    (!lstatSync(target).isDirectory() ||
      lstatSync(target).isSymbolicLink() ||
      readdirSync(target).length)
  )
    throw new Error('Archive restore destination must be a new empty directory.');
  mkdirSync(target, { recursive: true });
  for (const file of snapshot.manifest.files) {
    const output = safePath(target, file.path);
    atomicWrite(output, readFileSync(safePath(root, `${snapshot.path}/workspace/${file.path}`)));
    if (process.platform !== 'win32') chmodSync(output, file.mode === '100755' ? 0o755 : 0o644);
  }
  const records = loadRecords(target);
  for (const expected of snapshot.manifest.records) {
    const record = records.find((item) => item.meta.id === expected.id);
    if (
      !record ||
      record.path !== expected.path ||
      record.meta.revision !== expected.revision ||
      recordFingerprint(record) !== expected.fingerprint
    )
      throw new Error(`Restored record differs from archive identity: ${expected.id}`);
  }
  let reconciliation: 'published-baseline-restored' | 'local-snapshot-only' = 'local-snapshot-only';
  const publicationPath = safePath(root, `${snapshot.path}/publication.json`);
  const publication = existsSync(publicationPath)
    ? (JSON.parse(readFileSync(publicationPath, 'utf8')) as ArchivePublication)
    : null;
  if (
    publication?.status === 'completed' &&
    snapshot.manifest.disposition === 'accepted' &&
    publication.snapshot_id === id &&
    publication.manifest_hash === snapshot.manifest_hash &&
    publication.repository === snapshot.manifest.repository &&
    typeof publication.commit === 'string'
  ) {
    // Derived recovery data is added after exact restoration and record validation.
    // Original workspace/config bytes remain unchanged; the overlay names the
    // later remote publication without claiming it existed in the frozen source.
    for (const file of snapshot.manifest.files)
      atomicWrite(
        safePath(target, `${snapshot.path}/workspace/${file.path}`),
        readFileSync(safePath(root, `${snapshot.path}/workspace/${file.path}`)),
      );
    for (const file of ['manifest.json', 'identity.json', 'publication.json'])
      atomicWrite(
        safePath(target, `${snapshot.path}/${file}`),
        readFileSync(safePath(root, `${snapshot.path}/${file}`)),
      );
    atomicWrite(
      safePath(target, '.verythinker/archive-restoration.json'),
      JSON.stringify(
        {
          schema_version: 1,
          snapshot_id: id,
          manifest_hash: snapshot.manifest_hash,
          repository: snapshot.manifest.repository,
          namespace: snapshot.manifest.namespace,
          captured_baseline: snapshot.manifest.captured_baseline,
          baseline_commit: publication.commit,
          release: snapshot.manifest.release,
          imported_at: now(),
          derivation:
            'Verified published snapshot restored; original record/config bytes are unchanged.',
        },
        null,
        2,
      ) + '\n',
    );
    readArchivePolicy(target);
    reconciliation = 'published-baseline-restored';
  }
  return {
    destination: target,
    snapshot_id: id,
    records: records.length,
    files: snapshot.manifest.files.length,
    reconciliation,
  };
}
