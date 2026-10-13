import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { readFileSync, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { relative } from 'node:path';
import {
  createRecord,
  getRecord,
  loadRecords,
  readConfig,
  updateRecord,
  safePath,
  hash,
} from './storage.js';
import {
  acceptTask,
  assignmentReport,
  archiveEvidence,
  contextPacket,
  reviewTask,
  reviewRecord,
  runCheck,
  inspectCheck,
  recordFingerprint,
  startTask,
  resumeTask,
  requestRepair,
  submitTask,
  traceRecord,
  verify,
  structuralFindings,
} from './engineering.js';
import { searchMemory } from './indexing.js';
import { listPacks, installPack, prepareContribution, suggestPacks } from './packs.js';
import { recordTypes } from './types.js';
import type { ProjectRecord, RecordType, Link } from './types.js';
import { doctor } from './installer.js';
import { submitContribution } from './contributions.js';
import {
  beginWorkflow,
  discussWorkflow,
  decideWorkflow,
  discussionRoles,
  finishWorkflow,
  workflowStatus,
  bindManagerInvocation,
  type WorkflowInput,
} from './manager.js';
import {
  startNative,
  nativeStatus,
  waitNative,
  interruptNative,
  resumeNative,
  shutdownNative,
} from './native.js';
import {
  readInvocation,
  readRoutingPolicy,
  strongRoles,
  workerRoles,
  type NativeReceipt,
} from './routing.js';
import {
  authorizeOperation,
  describeCapabilities,
  resolveCapabilities,
  invokeCapability,
  closeCapabilitySessions,
} from './tools.js';
import {
  prepareArchive,
  publishArchive,
  archiveStatus,
  restoreArchive,
  reassessArchive,
} from './archives.js';
import {
  createCornellNote,
  reviseCornellNote,
  validateCornellNote,
  cornellKinds,
  type CornellInput,
} from './notes.js';
import {
  listRecipes,
  resolveRecipe,
  prepareRecipe,
  runRecipe,
  reviseRecipe,
  type RecipeInput,
} from './recipes.js';
import { managedRun, type ManagedRunInput } from './managed.js';
import { workspaceWrite } from './workspace.js';
import { validateEvidenceInputs, type EvidenceInputSnapshot } from './evidence-inputs.js';

const cornellNoteSchema = z
  .object({
    topic: z.string().describe('The substantive engineering or learning topic.'),
    kind: z.enum(cornellKinds),
    path: z
      .string()
      .optional()
      .describe(
        'Visible project-relative note path using forward slashes. Explicitly required for task-bound native work; unbound legacy calls retain the core default.',
      ),
    owner: z
      .string()
      .optional()
      .describe('Legacy record owner; the native gateway supplies the actual bound role.'),
    date: z
      .string()
      .optional()
      .describe('Optional note date; the core supplies today when omitted.'),
    context: z.string(),
    constraints: z.array(z.string()),
    cues: z.array(z.string()),
    main_notes: z
      .string()
      .describe(
        'Source-cited notes labelled [observed], [source-reported], [expected], or [inferred].',
      ),
    sources: z.array(
      z
        .object({
          id: z
            .string()
            .describe('Citation identity such as S1, referenced as [S1] in the main notes.'),
          title: z.string(),
          uri: z
            .string()
            .describe('Official source URL, canonical local source path, or record:RECORD_ID.'),
          retrieved_at: z.string().describe('Actual ISO retrieval timestamp.'),
          locator: z.string().optional(),
          record_id: z.string().optional(),
          sha256: z.string().optional(),
        })
        .strict(),
    ),
    demonstration: z
      .object({
        body: z.string(),
        expected: z
          .string()
          .describe('Expected result stated separately from actual execution evidence.'),
        command: z
          .array(z.string())
          .optional()
          .describe(
            'Executable and individual arguments, for example ["node", "demo.mjs"]; never a shell-command string.',
          ),
        observed: z
          .string()
          .optional()
          .describe('Actual observation only; requires passing current evidence_ids.'),
        evidence_ids: z.array(z.string()).optional(),
      })
      .strict(),
    failure_cases: z.array(z.string()),
    practice: z
      .object({
        exercise_path: z
          .string()
          .describe('Canonical project-relative path of the separate practice exercise.'),
        exercise: z.string().describe('Substantive exercise artifact content.'),
        answer_path: z
          .string()
          .describe(
            'Canonical project-relative path of the separate answer artifact; distinct from exercise_path.',
          ),
        answer: z.string().describe('Substantive answer artifact content.'),
        command: z
          .array(z.string())
          .optional()
          .describe('Executable and individual arguments for runnable practice.'),
        solution_path: z
          .string()
          .optional()
          .describe(
            'Optional separate user solution path; existing authored solutions are preserved.',
          ),
        starter: z
          .string()
          .optional()
          .describe(
            'Initial solution content used only when solution_path does not already exist.',
          ),
      })
      .strict(),
    summary: z.string(),
    requirement_ids: z.array(z.string()).optional(),
    problem_ids: z.array(z.string()).optional(),
    root_cause: z
      .object({
        reproduction: z.string(),
        hypotheses: z.array(z.string()),
        eliminating_evidence: z.string(),
        conclusion: z.enum(['confirmed', 'unresolved']),
        cause: z.string(),
        repair: z.string(),
        regression: z.string(),
      })
      .strict()
      .optional()
      .describe(
        'Required by the core when kind is root-cause; distinguish confirmed diagnosis from unresolved hypotheses.',
      ),
  })
  .strict() satisfies z.ZodType<CornellInput>;

export interface McpBinding {
  invocation_id?: string;
}
function privateProjectPath(path: string): boolean {
  const lower = path.toLowerCase();
  return (
    lower.split('/').some((part) => part === '.git' || part === 'node_modules') ||
    /^\.verythinker\/(?:cache|tools|runs)(?:\/|$)/.test(lower) ||
    /(?:^|\/)(?:\.env(?:\.[^/]*)?|auth\.json|credentials?(?:\.json)?|private[^/]*\.pem|id_(?:rsa|ed25519)(?:\.pub)?)$/.test(
      lower,
    )
  );
}
export function projectRead(
  root: string,
  input: { path: string; max_chars?: number; start_line?: number },
  receipt: NativeReceipt | null = null,
): unknown {
  const maximum = input.max_chars ?? 12000;
  if (!Number.isSafeInteger(maximum) || maximum < 128 || maximum > 64000)
    throw new Error('Project read budget must be between 128 and 64000 characters.');
  if (
    input.start_line !== undefined &&
    (!Number.isSafeInteger(input.start_line) || input.start_line < 1)
  )
    throw new Error('Project read starting line must be positive.');
  const target = safePath(root, input.path),
    path = relative(root, target).replaceAll('\\', '/');
  const lower = path.toLowerCase();
  if (input.path !== path || privateProjectPath(path))
    throw new Error(
      'Private credentials, raw sessions, runtime caches, and noncanonical paths are unavailable through project_read.',
    );
  const inputArtifacts = new Set<string>();
  const privateInputArtifacts = new Set<string>();
  if (receipt && (receipt.task_id || lower.startsWith('.verythinker/evidence/inputs/'))) {
    const scope = recordScope(root, receipt);
    for (const evidence of loadRecords(root).filter(
      (record) => scope.has(record.meta.id) && record.meta.type === 'evidence',
    )) {
      const data = evidence.meta.data;
      if (!data.input_snapshot) continue;
      if (typeof data.task_id !== 'string') continue;
      const task = getRecord(root, data.task_id);
      if (
        (receipt.task_id && task.meta.id !== receipt.task_id) ||
        (receipt.workflow_id && task.meta.data.workflow_id !== receipt.workflow_id)
      )
        continue;
      const manifest = validateEvidenceInputs(root, data.input_snapshot as EvidenceInputSnapshot, {
        files: data.file_baseline as Record<string, string>,
        record_fingerprints: data.record_baseline as Record<string, string>,
        check_id: typeof data.check_id === 'string' ? data.check_id : undefined,
        check_fingerprint:
          typeof data.check_fingerprint === 'string' ? data.check_fingerprint : undefined,
      });
      inputArtifacts.add((data.input_snapshot as EvidenceInputSnapshot).manifest_path);
      for (const [originalPath, artifact] of [
        ...Object.entries(manifest.files),
        ...Object.entries(manifest.context_files),
        ...Object.values(manifest.records).map((artifact) => [artifact.path, artifact] as const),
      ]) {
        if (privateProjectPath(originalPath)) privateInputArtifacts.add(artifact.blob_path);
        else inputArtifacts.add(artifact.blob_path);
      }
    }
    for (const artifact of privateInputArtifacts) inputArtifacts.delete(artifact);
  }
  if (lower.startsWith('.verythinker/evidence/inputs/') && !inputArtifacts.has(path))
    throw new Error('Captured input artifact is outside the assigned verified evidence scope.');
  if (receipt?.task_id) {
    const scope = recordScope(root, receipt),
      task = getRecord(root, receipt.task_id),
      permitted = new Set<string>(inputArtifacts),
      exactReferences = new Set<string>();
    const addPaths = (data: Record<string, unknown>) => {
      for (const key of ['verification_artifact_paths', 'oracle_paths'])
        if (Array.isArray(data[key]))
          for (const reference of data[key] as unknown[])
            if (typeof reference === 'string') exactReferences.add(reference);
      for (const key of [
        'allowed_paths',
        'baseline_paths',
        'documentation_paths',
        'protected_acceptance_paths',
      ])
        for (const item of Array.isArray(data[key]) ? (data[key] as unknown[]) : [])
          if (typeof item === 'string')
            permitted.add(relative(root, safePath(root, item)).replaceAll('\\', '/'));
    };
    addPaths(task.meta.data);
    for (const record of loadRecords(root).filter((record) => scope.has(record.meta.id))) {
      permitted.add(record.path);
      if (record.meta.type === 'check' || record.meta.type === 'design') addPaths(record.meta.data);
      if (record.meta.type === 'evidence')
        for (const key of [
          'log_path',
          'receipt_path',
          'archived_log_path',
          'archived_receipt_path',
        ])
          if (typeof record.meta.data[key] === 'string')
            permitted.add(String(record.meta.data[key]));
      for (const key of ['file_baseline', 'protected_file_hashes', 'documentation_snapshot'])
        if (
          (record.meta.type === 'check' ||
            record.meta.type === 'evidence' ||
            record.meta.type === 'design') &&
          record.meta.data[key] &&
          typeof record.meta.data[key] === 'object'
        )
          for (const file of Object.keys(record.meta.data[key] as object)) permitted.add(file);
    }
    if (
      !exactReferences.has(path) &&
      ![...permitted].some(
        (prefix) => path === prefix || path.startsWith(prefix.replace(/\/$/, '') + '/'),
      )
    )
      throw new Error('Project source path is outside the assigned task inputs and outputs.');
  }
  const stat = statSync(target);
  if (!stat.isFile() || stat.size > 2 * 1024 * 1024)
    throw new Error('project_read accepts text files up to 2 MiB.');
  const bytes = readFileSync(target);
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (text.includes('\0')) throw new Error('Use an appropriate media tool for binary content.');
  const startLine = input.start_line ?? 1,
    excerpt = text
      .split(/\r?\n/)
      .slice(startLine - 1)
      .join('\n');
  return {
    path,
    sha256: hash(bytes),
    size_bytes: bytes.length,
    start_line: startLine,
    text: excerpt.slice(0, maximum),
    truncated: excerpt.length > maximum,
  };
}
export function assertTaskOutputPaths(
  root: string,
  receipt: NativeReceipt | null,
  paths: unknown[],
): void {
  if (!receipt?.task_id) return;
  const task = getRecord(root, receipt.task_id);
  const allowed = ['allowed_paths', 'documentation_paths']
    .flatMap((key) =>
      Array.isArray(task.meta.data[key]) ? (task.meta.data[key] as unknown[]) : [],
    )
    .filter((path): path is string => typeof path === 'string');
  for (const path of paths) {
    if (typeof path !== 'string')
      throw new Error('Task-bound documentation requires explicit output paths.');
    const normalized = relative(root, safePath(root, path)).replaceAll('\\', '/');
    if (
      normalized !== path ||
      !allowed.some(
        (prefix) => normalized === prefix || normalized.startsWith(prefix.replace(/\/$/, '') + '/'),
      )
    )
      throw new Error('Documentation output path is outside the assigned task scope.');
  }
}
function recordScope(root: string, receipt: NativeReceipt): Set<string> {
  const records = loadRecords(root);
  const seed = receipt.task_id ?? receipt.workflow_id;
  if (!seed) return new Set(records.map((record) => record.meta.id));
  const assignedTask = receipt.task_id;
  const scope = new Set([seed]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const record of records) {
      // A task may refer to its coordinator, but that structural reference must
      // not expand the packet into every sibling assignment in the increment.
      if (
        assignedTask &&
        ((record.meta.type === 'task' && record.meta.id !== assignedTask) ||
          record.meta.data.kind === 'manager-workflow' ||
          record.meta.data.kind === 'manager-decision' ||
          (record.meta.data.task_id && record.meta.data.task_id !== assignedTask))
      )
        continue;
      const links = assignedTask
        ? record.meta.links.filter((link) => link.target !== receipt.workflow_id)
        : record.meta.links;
      const linked = scope.has(record.meta.id) || links.some((link) => scope.has(link.target));
      if (!linked) continue;
      for (const id of [record.meta.id, ...links.map((link) => link.target)])
        if (!scope.has(id)) {
          scope.add(id);
          changed = true;
        }
    }
  }
  return scope;
}
function operationBinding(
  root: string,
  operation: string,
  input: any,
): { workflow_id?: string; task_id?: string } {
  const result: { workflow_id?: string; task_id?: string } = {};
  if (typeof input.workflow_id === 'string') result.workflow_id = input.workflow_id;
  if (typeof input.task_id === 'string' || typeof input.task === 'string')
    result.task_id = input.task_id ?? input.task;
  if (
    typeof input.id === 'string' &&
    !operation.startsWith('native_') &&
    !operation.startsWith('archive_') &&
    !operation.startsWith('recipe_resolve')
  ) {
    const record = getRecord(root, input.id);
    if (record.meta.type === 'task') result.task_id = record.meta.id;
    if (typeof record.meta.data.workflow_id === 'string')
      result.workflow_id = record.meta.data.workflow_id;
    if (typeof record.meta.data.task_id === 'string') result.task_id = record.meta.data.task_id;
  }
  return result;
}
function scopedRecord(
  root: string,
  receipt: NativeReceipt | null,
  id: string,
): ReturnType<typeof getRecord> {
  const record = getRecord(root, id);
  if (receipt && !recordScope(root, receipt).has(id))
    throw new Error('Record is outside the assigned native context.');
  return record;
}
function authoredData(
  receipt: NativeReceipt | null,
  data: Record<string, unknown> = {},
): Record<string, unknown> {
  if (!receipt) return data;
  return {
    ...data,
    invocation_id: receipt.id,
    author_invocation_id: receipt.id,
    invocation_role: receipt.role,
    routing_required: true,
    ...(receipt.workflow_id ? { workflow_id: receipt.workflow_id } : {}),
    ...(receipt.task_id ? { task_id: receipt.task_id } : {}),
  };
}
export function canAuthor(role: string, type: string): boolean {
  if (type === 'knowledge' || type === 'problem' || type === 'change') return role !== 'reviewer';
  if (type === 'requirement') return role === 'requirements';
  if (type === 'design') return ['architect', 'component-owner'].includes(role);
  if (type === 'check') return role === 'verifier';
  if (type === 'task')
    return ['manager', 'architect', 'component-owner', 'verifier'].includes(role);
  return false;
}
export function assertRecordPreview(
  root: string,
  input: { type: RecordType; title?: string; links?: Link[]; data?: Record<string, unknown> },
  prior?: ProjectRecord,
): void {
  const records = loadRecords(root);
  const candidate: ProjectRecord = {
    path: prior?.path ?? '',
    body: prior?.body ?? '',
    meta: {
      schema_version: 1,
      id: prior?.meta.id ?? '__verythinker_new_record_preview__',
      type: input.type,
      title: input.title ?? prior?.meta.title ?? 'Record preview',
      owner: prior?.meta.owner ?? 'system',
      status: prior?.meta.status ?? 'draft',
      revision: prior?.meta.revision ?? 1,
      created_at: prior?.meta.created_at ?? '',
      updated_at: prior?.meta.updated_at ?? '',
      links: input.links ?? prior?.meta.links ?? [],
      data: { ...prior?.meta.data, ...input.data },
    },
  };
  const existing = new Set(structuralFindings(records).map((finding) => JSON.stringify(finding)));
  const findings = structuralFindings([
    ...records.filter((record) => record.meta.id !== candidate.meta.id),
    candidate,
  ]).filter(
    (finding) =>
      (finding.record === candidate.meta.id &&
        ['broken-link', 'invalid-link-type', 'invalid-dependency', 'invalid-requirement'].includes(
          finding.code,
        )) ||
      !existing.has(JSON.stringify(finding)),
  );
  if (findings.length) throw new Error(findings.map((finding) => finding.message).join('\n'));
}
const executionFields = new Set([
  'invocation_id',
  'requested_model',
  'confirmed_model',
  'attempts',
  'repair_attempts',
  'repair_requested_at',
  'feedback',
  'escalation_required',
  'submission',
  'submission_revision',
  'prior_invocation_ids',
  'status',
  'started_at',
  'resumed_at',
  'blocked_reason',
  'submitted_at',
  'accepted_at',
  'escalation_attempt',
  'escalation_feedback_sha256',
  'work_record_id',
  'documentation_snapshot',
  'workspace_writes',
]);
export function taskAuthorData(
  receipt: NativeReceipt | null,
  data: Record<string, unknown> = {},
  task?: ReturnType<typeof getRecord>,
): Record<string, unknown> {
  if (!receipt) return data;
  if (Object.keys(data).some((key) => executionFields.has(key)))
    throw new Error(
      'Task execution, repair, submission, and acceptance fields require dedicated core operations.',
    );
  if (data.escalation_invocation_id !== undefined || data.escalation_reason !== undefined) {
    if (
      !['manager', 'architect', 'component-owner'].includes(receipt.role) ||
      typeof data.escalation_reason !== 'string' ||
      data.escalation_reason.trim().length < 24 ||
      data.escalation_reason.length > 8000 ||
      !task
    )
      throw new Error(
        'Escalation requires a bounded substantive diagnosis from its strategic author.',
      );
    data = {
      ...data,
      escalation_reason: data.escalation_reason.trim(),
      escalation_invocation_id: receipt.id,
      escalation_attempt: task.meta.data.attempts,
      escalation_feedback_sha256: hash(String(task.meta.data.feedback ?? '')),
    };
  }
  const { invocation_id, ...planning } = authoredData(receipt, data);
  return planning;
}
const reservedKinds = new Set([
  'manager-decision',
  'manager-discussion',
  'work-record',
  'recipe-instance',
]);

function intakeArguments<T>(input: Record<string, unknown>): T {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== null)) as T;
}
export function assertGenericRecordMutation(
  record: ReturnType<typeof getRecord>,
  receipt: NativeReceipt,
): void {
  if (reservedKinds.has(String(record.meta.data.kind)))
    throw new Error(
      'Reserved workflow decisions, submissions, and frozen recipes must use their dedicated core operation.',
    );
  if (record.meta.data.kind === 'manager-workflow' && receipt.role !== 'manager')
    throw new Error('Only the manager can update its workflow clarification state.');
  if (
    [
      'researcher',
      'codebase-analyst',
      'curator',
      'developer',
      'check-executor',
      'release',
    ].includes(receipt.role) &&
    (record.meta.owner !== receipt.role ||
      (receipt.task_id && record.meta.data.task_id !== receipt.task_id))
  )
    throw new Error('Worker can update only its own assigned project documentation records.');
}

export function createMcpServer(root: string, binding: McpBinding = {}): McpServer {
  readConfig(root);
  const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const server = new McpServer({ name: 'verythinker', version: packageJson.version });
  const ownerToken = randomUUID();
  server.server.onclose = () => {
    void shutdownNative(root, ownerToken);
    void closeCapabilitySessions(root, binding.invocation_id);
  };
  const bound = () => (binding.invocation_id ? readInvocation(root, binding.invocation_id) : null);
  const output = (value: unknown) => ({
    content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
  });
  const tool = (
    name: string,
    description: string,
    schema: Record<string, z.ZodType>,
    action: (input: any) => unknown,
    readOnly = true,
    external = false,
  ) => {
    server.registerTool(
      name,
      {
        description,
        inputSchema: schema,
        annotations: { readOnlyHint: readOnly, destructiveHint: false, openWorldHint: external },
      },
      async (input) => {
        try {
          const receipt = bound();
          if (receipt) {
            if (!readOnly && receipt.state !== 'running')
              throw new Error('New MCP mutations require a currently running native invocation.');
            if (
              name === 'native_wait' &&
              typeof input.invocation_id === 'string' &&
              input.invocation_id === receipt.id
            )
              throw new Error(
                'A bound invocation cannot wait for its own inference completion. Submit your work report, then return control; the coordinator waits on other workers.',
              );
            if (name === 'manager_run' || name === 'manager_begin')
              throw new Error(
                'A bound invocation must resume its existing workflow; recursive intake is forbidden.',
              );
            authorizeOperation(root, receipt.id, name, operationBinding(root, name, input));
            if (
              typeof input.id === 'string' &&
              !name.startsWith('native_') &&
              !name.startsWith('archive_') &&
              !name.startsWith('recipe_resolve')
            )
              scopedRecord(root, receipt, input.id);
          } else if (!readOnly && readRoutingPolicy(root) && name !== 'manager_run') {
            throw new Error(
              'Strict managed mutations require an invocation-bound MCP session. Start ordinary requirements through manager_run.',
            );
          }
          return output(await action(input));
        } catch (error) {
          return {
            ...output({ error: error instanceof Error ? error.message : String(error) }),
            isError: true,
          };
        }
      },
    );
  };
  tool(
    'project_status',
    'Inspect native adapter capability observations and configuration.',
    {},
    () => doctor(root),
  );
  tool(
    'project_read',
    'Read bounded relevant project text with a content hash; credentials, private native keys, raw sessions and runtime caches are excluded.',
    {
      path: z.string(),
      max_chars: z.number().int().min(128).max(64000).optional(),
      start_line: z.number().int().min(1).optional(),
    },
    (i) => projectRead(root, i, bound()),
  );
  tool(
    'manager_run',
    'Start or resume an engineering increment and its strategic coordinator. Supply requirement for one item OR requirements for a batch. Set the unused field to null or omit it. For resume, supply workflow_id; both requirement fields may be null.',
    {
      requirement: z
        .string()
        .nullable()
        .optional()
        .describe('One requirement. Use null or omit when supplying requirements.'),
      requirements: z
        .array(z.string())
        .nullable()
        .optional()
        .describe('A requirement batch. Use null or omit when supplying requirement.'),
      workflow_id: z.string().nullable().optional(),
      message: z.string().nullable().optional(),
      title: z.string().nullable().optional(),
      request_id: z.string().nullable().optional(),
      change_type: z.enum(['breaking', 'feature', 'fix']).nullable().optional(),
      providers: z
        .array(z.enum(['codegraph', 'context7', 'playwright']))
        .nullable()
        .optional(),
    },
    async (i) => {
      return managedRun(root, intakeArguments<ManagedRunInput>(i), ownerToken);
    },
    false,
  );
  tool(
    'manager_begin',
    'Start or recover a requirement workflow. Supply requirement OR requirements; set the unused field to null or omit it. The active native manager owns execution and closure.',
    {
      requirement: z.string().nullable().optional(),
      requirements: z.array(z.string()).nullable().optional(),
      title: z.string().nullable().optional(),
      invocation_id: z.string().nullable().optional(),
      request_id: z.string().nullable().optional(),
    },
    (i) => beginWorkflow(root, intakeArguments<WorkflowInput>(i)),
    false,
  );
  tool(
    'manager_discuss',
    'Persist an actual specialist contribution with its invocation and inspected input baselines; bounded to three rounds.',
    {
      workflow_id: z.string(),
      role: z.enum(discussionRoles),
      invocation_id: z.string().optional(),
      summary: z.string(),
      rationale: z.string(),
      risks: z.array(z.string()).optional(),
      source_ids: z.array(z.string()).optional(),
      round: z.number().int().optional(),
    },
    (i) => {
      const receipt = bound();
      return discussWorkflow(root, i.workflow_id, {
        ...i,
        ...(receipt ? { role: receipt.role, invocation_id: receipt.id } : {}),
      });
    },
    false,
  );
  tool(
    'manager_decide',
    'Integrate two current specialist contributions and a reviewed plan. Assign documentation responsibilities and report decisions without routine approval.',
    {
      workflow_id: z.string(),
      summary: z.string(),
      rationale: z.string(),
      task_ids: z.array(z.string()),
    },
    (i) => decideWorkflow(root, i.workflow_id, i),
    false,
  );
  tool(
    'manager_status',
    'Find saved workflows, current gates, changed decisions, and the next executable action.',
    { workflow_id: z.string().optional() },
    (i) => workflowStatus(root, i.workflow_id),
  );
  tool(
    'manager_finish',
    'Validate and accept documented independently reviewed tasks, curate knowledge disposition, submit qualified draft PRs under the saved project policy, and persist the final report. Never merges.',
    {
      workflow_id: z.string(),
      knowledge_ids: z.array(z.string()).optional(),
      no_lesson_reason: z.string().optional(),
      retired_candidates: z
        .array(z.object({ knowledge_id: z.string(), reason: z.string() }))
        .optional(),
    },
    (i) => finishWorkflow(root, i.workflow_id, i),
    false,
    true,
  );
  tool(
    'record_list',
    'Read authoritative engineering records.',
    { type: z.enum(recordTypes).optional() },
    (i) => {
      const receipt = bound();
      const scope = receipt ? recordScope(root, receipt) : null;
      return loadRecords(root).filter(
        (r) => (!i.type || r.meta.type === i.type) && (!scope || scope.has(r.meta.id)),
      );
    },
  );
  tool(
    'record_get',
    'Read one scoped engineering record and its full current fingerprint. Select data_fields and include_body:false for bounded current-state inspection; omitted options preserve the complete record.',
    {
      id: z.string(),
      data_fields: z.array(z.string().min(1).max(256)).max(64).optional(),
      include_body: z.boolean().optional(),
    },
    (i) => {
      const record = scopedRecord(root, bound(), i.id);
      return {
        meta: {
          ...record.meta,
          data:
            i.data_fields === undefined
              ? record.meta.data
              : Object.fromEntries(
                  i.data_fields
                    .filter((key: string) => Object.hasOwn(record.meta.data, key))
                    .map((key: string) => [key, record.meta.data[key]]),
                ),
        },
        path: record.path,
        ...(i.include_body !== false ? { body: record.body } : {}),
        fingerprint: recordFingerprint(record),
        ...(i.data_fields !== undefined || i.include_body !== undefined
          ? {
              projection: {
                data_fields: i.data_fields ?? null,
                include_body: i.include_body !== false,
              },
            }
          : {}),
      };
    },
  );
  tool(
    'record_create',
    'Create a project record. Supply explicit acceptance criteria and typed links in data.',
    {
      type: z.enum(recordTypes),
      title: z.string(),
      owner: z.string(),
      body: z.string().optional(),
      data: z.record(z.string(), z.unknown()).optional(),
      links: z
        .array(
          z.object({
            type: z.enum([
              'derives-from',
              'satisfies',
              'implements',
              'verifies',
              'evidence-for',
              'reviews',
              'depends-on',
              'documents',
              'supersedes',
              'references',
            ]),
            target: z.string(),
          }),
        )
        .optional(),
    },
    (i) => {
      const receipt = bound();
      if (
        receipt &&
        (reservedKinds.has(String(i.data?.kind)) ||
          i.data?.kind === 'manager-workflow' ||
          ['review', 'evidence'].includes(i.type))
      )
        throw new Error(
          'Reserved engineering state must be created through its dedicated core operation.',
        );
      if (receipt && !canAuthor(receipt.role, i.type))
        throw new Error(`Role ${receipt.role} cannot author ${i.type} records.`);
      if (
        receipt &&
        i.links?.some((link: { target: string }) => !recordScope(root, receipt).has(link.target))
      )
        throw new Error('Record links escape the assigned context.');
      assertRecordPreview(root, i);
      return createRecord(root, {
        ...i,
        ...(receipt ? { owner: i.type === 'task' ? i.owner : receipt.role } : {}),
        data: i.type === 'task' ? taskAuthorData(receipt, i.data) : authoredData(receipt, i.data),
      });
    },
    false,
  );
  tool(
    'record_update',
    'Update record data or body. Acceptance is handled by task_accept.',
    {
      id: z.string(),
      owner: z.string().optional(),
      data: z.record(z.string(), z.unknown()).optional(),
      body: z.string().optional(),
      links: z
        .array(
          z.object({
            type: z.enum([
              'derives-from',
              'satisfies',
              'implements',
              'verifies',
              'evidence-for',
              'reviews',
              'depends-on',
              'documents',
              'supersedes',
              'references',
            ]),
            target: z.string(),
          }),
        )
        .optional(),
    },
    (i) => {
      const receipt = bound();
      const record = scopedRecord(root, receipt, i.id);
      if (receipt) assertGenericRecordMutation(record, receipt);
      for (const link of i.links ?? []) scopedRecord(root, receipt, link.target);
      if (
        i.owner !== undefined &&
        (record.meta.type !== 'task' ||
          !['draft', 'ready', 'blocked'].includes(record.meta.status) ||
          (receipt &&
            !['manager', 'architect', 'component-owner', 'verifier'].includes(receipt.role)))
      )
        throw new Error('Only a planning role can reassign a task before implementation starts.');
      if (receipt && record.meta.data.kind === 'manager-workflow') {
        if (
          i.body !== undefined ||
          i.links !== undefined ||
          Object.keys(i.data ?? {}).some((key) => !['open_questions', 'change_type'].includes(key))
        )
          throw new Error(
            'Workflow updates expose clarification questions and reviewed release classification only.',
          );
        return updateRecord(root, i.id, { data: i.data });
      }
      if (receipt && !canAuthor(receipt.role, record.meta.type))
        throw new Error(`Role ${receipt.role} cannot author ${record.meta.type} records.`);
      assertRecordPreview(root, { type: record.meta.type, links: i.links, data: i.data }, record);
      return updateRecord(
        root,
        i.id,
        {
          data:
            record.meta.type === 'task'
              ? taskAuthorData(receipt, i.data, record)
              : authoredData(receipt, i.data),
          ...(record.meta.type === 'task' && i.owner !== undefined
            ? { owner: i.owner }
            : receipt && record.meta.type !== 'task'
              ? { owner: receipt.role }
              : {}),
          ...(i.links !== undefined ? { links: i.links } : {}),
        },
        i.body,
      );
    },
    false,
  );
  tool(
    'task_start',
    'Start a ready task and record requested/confirmed model observations.',
    {
      id: z.string(),
      requested_model: z.string().optional(),
      confirmed_model: z.string().optional(),
      invocation_id: z.string().optional(),
    },
    (i) => {
      const receipt = bound();
      return startTask(
        root,
        i.id,
        receipt?.requested_model ?? i.requested_model,
        receipt?.confirmed_model ?? i.confirmed_model,
        receipt?.id ?? i.invocation_id,
      );
    },
    false,
  );
  tool(
    'task_resume',
    'Resume persisted interrupted work; repeated failure requires coordinator-selected model.',
    {
      id: z.string(),
      requested_model: z.string().optional(),
      confirmed_model: z.string().optional(),
      invocation_id: z.string().optional(),
    },
    (i) => {
      const receipt = bound();
      return resumeTask(
        root,
        i.id,
        receipt?.requested_model ?? i.requested_model,
        receipt?.confirmed_model ?? i.confirmed_model,
        receipt?.id ?? i.invocation_id,
      );
    },
    false,
  );
  tool(
    'task_repair',
    'Record feedback, permit one repair, and escalate repeated failure.',
    { id: z.string(), feedback: z.string() },
    (i) => requestRepair(root, i.id, i.feedback),
    false,
  );
  tool(
    'task_file_write',
    'Create or replace an assigned UTF-8 implementation/documentation file using its current SHA-256 (null for a new file). Requires the running native Developer producer, reviewed task scope, and unchanged protected acceptance artifacts. Records immutable previous bytes and idempotent operation history; Cornell artifacts use note_create instead.',
    {
      task_id: z.string(),
      workflow_id: z.string().optional(),
      path: z.string().describe('Project-relative file inside the reviewed task allowed_paths.'),
      content: z.string().describe('Complete UTF-8 replacement content, at most 128 KiB.'),
      expected_hash: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .nullable()
        .describe(
          'Current file SHA-256 from project_read, or null only when creating a missing file.',
        ),
      operation_id: z
        .string()
        .uuid()
        .optional()
        .describe(
          'Reuse this UUID and identical payload to recover an interrupted or lost-response write.',
        ),
    },
    (i) => {
      const receipt = bound();
      if (!receipt)
        throw new Error('Task file writes require an invocation-bound native Developer session.');
      scopedRecord(root, receipt, i.task_id);
      return workspaceWrite(root, {
        ...i,
        workflow_id: i.workflow_id ?? receipt.workflow_id ?? '',
        invocation_id: receipt.id,
      });
    },
    false,
  );
  tool(
    'task_submit',
    'Persist worker submission and standard work history.',
    { id: z.string(), summary: z.string(), work_record: z.string().optional() },
    (i) => {
      const receipt = bound(),
        task = getRecord(root, i.id);
      if (
        receipt &&
        (receipt.role !== task.meta.owner || task.meta.data.invocation_id !== receipt.id)
      )
        throw new Error(
          'Task submission belongs to its active producer invocation; other assignments use assignment_report.',
        );
      return submitTask(root, i.id, i.summary, i.work_record);
    },
    false,
  );
  tool(
    'assignment_report',
    'Persist the seven-section account of this native assignment and any explicitly covered prior assignment of the same role and scope.',
    {
      target_ids: z.array(z.string()).min(1).max(32),
      body: z.string(),
      covered_invocation_ids: z.array(z.string()).optional(),
    },
    (i) => {
      const receipt = bound();
      if (!receipt) throw new Error('Assignment reporting requires a bound native invocation.');
      for (const id of i.target_ids) scopedRecord(root, receipt, id);
      return assignmentReport(root, { ...i, invocation_id: receipt.id });
    },
    false,
  );
  tool(
    'task_accept',
    'Accept a task only when current checks and independent review pass.',
    { id: z.string() },
    (i) => acceptTask(root, i.id),
    false,
  );
  tool(
    'task_context',
    'Build a bounded worker packet with source pointers and verification procedures.',
    { id: z.string(), max_chars: z.number().int().min(1000).max(100000).optional() },
    (i) => contextPacket(root, i.id, i.max_chars),
  );
  tool(
    'record_trace',
    'Inspect both directions of engineering links and change impact.',
    { id: z.string(), impact: z.boolean().optional() },
    (i) => traceRecord(root, i.id, i.impact),
  );
  tool(
    'verify',
    'Validate structural links and a task completion gate.',
    {
      id: z.string().optional(),
      gate: z.enum(['ready', 'design-ready', 'verified', 'accepted']).optional(),
    },
    (i) => verify(root, i.id, i.gate),
  );
  tool(
    'check_run',
    'Execute the project-defined verification command and collect real baseline-bound evidence.',
    { id: z.string(), task: z.string() },
    (i) => runCheck(root, i.id, i.task, bound()?.id),
    false,
  );
  tool(
    'check_inspect',
    'Record actual observations for every item in a reviewed inspection plan. Sources must match current project file SHA-256 values or record fingerprints; gaps and failures remain failing evidence. This captures model-performed inspection with limits, independently reviewed later; it does not run an executable or establish automatic semantic proof.',
    {
      id: z.string(),
      task: z.string(),
      observations: z
        .array(
          z
            .object({
              item_id: z.string(),
              outcome: z.enum(['pass', 'fail', 'gap']),
              observation: z.string().min(24).max(8000),
              sources: z
                .array(
                  z.discriminatedUnion('kind', [
                    z
                      .object({
                        kind: z.literal('file'),
                        path: z.string(),
                        sha256: z.string().regex(/^[a-f0-9]{64}$/),
                        locator: z.string().optional(),
                      })
                      .strict(),
                    z
                      .object({
                        kind: z.literal('record'),
                        record_id: z.string(),
                        fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
                        locator: z.string().optional(),
                      })
                      .strict(),
                  ]),
                )
                .min(1)
                .max(16),
            })
            .strict(),
        )
        .min(1)
        .max(64),
      limitations: z.array(z.string().min(8).max(2000)).min(1).max(32),
    },
    (i) => {
      const receipt = bound();
      if (!receipt)
        throw new Error(
          'Inspection evidence requires an invocation-bound native Check Executor session.',
        );
      scopedRecord(root, receipt, i.task);
      for (const item of i.observations)
        for (const source of item.sources) {
          if (source.kind === 'record') scopedRecord(root, receipt, source.record_id);
          else projectRead(root, { path: source.path, max_chars: 128 }, receipt);
        }
      return inspectCheck(
        root,
        i.id,
        i.task,
        { observations: i.observations, limitations: i.limitations },
        receipt.id,
      );
    },
    false,
  );
  tool(
    'evidence_archive',
    'Preserve verification receipt and log outside private runs. Inspect content before sharing; historical baselines remain unchanged.',
    { id: z.string() },
    (i) => archiveEvidence(root, i.id),
    false,
  );
  tool(
    'task_review',
    'Record an independent task review against its current fingerprint. A pass requires no unresolved findings; record positive observations in assignment_report.',
    {
      id: z.string(),
      owner: z.string(),
      decision: z.enum(['pass', 'fail']),
      findings: z
        .array(z.string())
        .describe(
          'Unresolved defects only. Use [] for pass; document positive observations in assignment_report.',
        )
        .optional(),
      invocation_id: z.string().optional(),
    },
    (i) => {
      const receipt = bound();
      return reviewTask(
        root,
        i.id,
        receipt?.role ?? i.owner,
        i.decision,
        i.findings,
        receipt?.id ?? i.invocation_id,
      );
    },
    false,
  );
  tool(
    'record_review',
    'Record an independent review. Findings contain unresolved defects only; a pass requires an empty findings array. Put positive observations and rationale in assignment_report.',
    {
      id: z.string(),
      owner: z.string(),
      decision: z.enum(['pass', 'fail']),
      findings: z
        .array(z.string())
        .describe(
          'Unresolved defects only. Use [] for pass; document positive observations in assignment_report.',
        )
        .optional(),
      invocation_id: z.string().optional(),
      generalization_review: z.boolean().optional(),
    },
    (i) =>
      reviewRecord(
        root,
        i.id,
        bound()?.role ?? i.owner,
        i.decision,
        i.findings,
        bound()?.id ?? i.invocation_id,
        i.generalization_review,
      ),
    false,
  );
  tool(
    'memory_search',
    'Find project records using the local rebuildable FTS5 index.',
    { query: z.string() },
    (i) => {
      const receipt = bound();
      const results = searchMemory(root, i.query);
      if (!receipt || !receipt.task_id) return results;
      const scope = recordScope(root, receipt);
      return results.filter((result) => scope.has((result as { id: string }).id));
    },
  );
  tool('pack_list', 'Inspect available and locked knowledge packs.', {}, () => listPacks(root));
  tool(
    'pack_install',
    'Install an exact local or bundled knowledge pack; replacing a locked version requires a reviewed owner decision.',
    { source: z.string(), decision_id: z.string().optional() },
    (i) => installPack(root, i.source, i.decision_id),
    false,
  );
  tool(
    'pack_suggest',
    'Find pack candidates; compatibility and applicability still require review.',
    { terms: z.array(z.string()) },
    (i) => suggestPacks(root, i.terms),
  );
  tool(
    'contribution_prepare',
    'Prepare reviewed generalized material locally. Human approval applies to merging; manager_finish can submit a draft under the saved project policy.',
    { id: z.string() },
    (i) => prepareContribution(root, i.id),
    false,
  );
  tool(
    'contribution_submit',
    'Manually submit a draft to a specifically authorized repository; never merges. For automatic closure use manager_finish and its saved upstream policy.',
    { id: z.string(), repository: z.string() },
    (i) => submitContribution(root, i.id, i.repository),
    false,
    true,
  );
  const nativeRole = z.enum([...strongRoles, ...workerRoles]);
  tool(
    'native_dispatch',
    'Launch one bounded exact-model native worker using the role contract and existing native permissions.',
    {
      role: nativeRole,
      prompt: z.string(),
      workflow_id: z.string().optional(),
      task_id: z.string().optional(),
      request_id: z.string().optional(),
    },
    (i) => {
      const receipt = bound();
      if (receipt && i.role === 'manager')
        throw new Error('The existing coordinator cannot recursively launch another coordinator.');
      return startNative(
        root,
        {
          ...i,
          ...(receipt?.workflow_id ? { workflow_id: receipt.workflow_id } : {}),
        },
        ownerToken,
      );
    },
    false,
  );
  const scopedInvocation = (id: string) => {
    const receipt = bound(),
      target = readInvocation(root, id);
    if (receipt && receipt.role !== 'manager' && target.id !== receipt.id)
      throw new Error('Worker can observe only its own native invocation.');
    if (receipt?.workflow_id && target.workflow_id !== receipt.workflow_id)
      throw new Error('Native invocation belongs to another workflow.');
    return target;
  };
  tool(
    'native_status',
    'Inspect persisted native model acknowledgment, lifecycle, permissions, and blockers.',
    { invocation_id: z.string().optional() },
    (i) => {
      const receipt = bound();
      if (i.invocation_id) return scopedInvocation(i.invocation_id);
      const all = nativeStatus(root) as NativeReceipt[];
      return all.filter(
        (target) =>
          !receipt ||
          (receipt.role === 'manager'
            ? target.workflow_id === receipt.workflow_id
            : target.id === receipt.id),
      );
    },
  );
  tool(
    'native_wait',
    'Wait at most 60 seconds for an owned invocation; a bound caller cannot wait for its own inference to complete.',
    { invocation_id: z.string(), wait_ms: z.number().int().min(0).max(60000).optional() },
    async (i) => {
      scopedInvocation(i.invocation_id);
      const waited = await waitNative(root, i.invocation_id, i.wait_ms);
      return {
        invocation: waited,
        ...(waited.workflow_id ? { workflow: workflowStatus(root, waited.workflow_id) } : {}),
      };
    },
  );
  tool(
    'native_interrupt',
    'Interrupt through the live transport owner. Orphaned transports must be reconciled before resuming.',
    { invocation_id: z.string() },
    (i) => {
      scopedInvocation(i.invocation_id);
      return interruptNative(root, i.invocation_id);
    },
    false,
  );
  tool(
    'native_resume',
    'Resume native history with a fresh acknowledged invocation and preserve the old receipt.',
    { invocation_id: z.string(), prompt: z.string().optional(), request_id: z.string().optional() },
    (i) => {
      scopedInvocation(i.invocation_id);
      return resumeNative(root, i.invocation_id, i, ownerToken);
    },
    false,
  );
  const provider = z.enum(['codegraph', 'context7', 'playwright']);
  tool(
    'capability_describe',
    'Inspect role-specific approved tools, required capabilities, and enforcement limits.',
    { role: nativeRole.optional() },
    (i) => describeCapabilities(root, bound()?.role ?? i.role ?? 'manager'),
  );
  tool(
    'capability_resolve',
    'Resolve applicable approved providers and install pinned packages automatically under saved policy.',
    {
      role: nativeRole.optional(),
      providers: z.array(provider).optional(),
      required: z.array(provider).optional(),
    },
    (i) => {
      const receipt = bound();
      const role =
        receipt && receipt.role !== 'manager'
          ? receipt.role
          : (i.role ?? receipt?.role ?? 'manager');
      return resolveCapabilities(root, { ...i, role });
    },
    false,
    true,
  );
  tool(
    'capability_invoke',
    'Invoke only an observed approved provider tool within the bound role and task scope.',
    {
      provider,
      tool: z.string(),
      arguments: z.record(z.string(), z.unknown()).optional(),
      workflow_id: z.string().optional(),
      task_id: z.string().optional(),
    },
    (i) => {
      const receipt = bound();
      if (!receipt) throw new Error('Capability invocation requires a bound native invocation.');
      return invokeCapability(root, {
        ...i,
        invocation_id: receipt.id,
        ...(receipt.workflow_id ? { workflow_id: receipt.workflow_id } : {}),
        ...(receipt.task_id ? { task_id: receipt.task_id } : {}),
      });
    },
    false,
    true,
  );
  tool(
    'archive_prepare',
    'Prepare a byte-preserving private project snapshot with evidence inputs and public invocation proofs.',
    {
      workflow_id: z.string(),
      disposition: z.enum(['working', 'accepted']).optional(),
      source_paths: z.array(z.string()).optional(),
    },
    (i) => prepareArchive(root, i.workflow_id, i),
    false,
  );
  tool(
    'archive_publish',
    'Publish the validated snapshot to the saved private upstream, preserving immutable release and increment history.',
    { snapshot_id: z.string() },
    (i) => {
      const receipt = bound();
      if (receipt?.workflow_id) {
        const snapshot = archiveStatus(root, i.snapshot_id) as any;
        if (
          snapshot?.manifest?.workflow_id &&
          snapshot.manifest.workflow_id !== receipt.workflow_id
        )
          throw new Error('Snapshot belongs to another workflow.');
      }
      return publishArchive(root, i.snapshot_id);
    },
    false,
    true,
  );
  tool(
    'archive_status',
    'Inspect snapshot manifests and resumable publication stages.',
    { snapshot_id: z.string().optional() },
    (i) => archiveStatus(root, i.snapshot_id),
  );
  tool(
    'archive_reassess',
    'Retire only a demonstrably unpublished archive intent after independent review of a precise linked change, preserving its history.',
    { workflow_id: z.string(), change_id: z.string(), reason: z.string() },
    (i) => {
      scopedRecord(root, bound(), i.change_id);
      return reassessArchive(root, i.workflow_id, i);
    },
    false,
    true,
  );
  tool(
    'archive_restore',
    'Restore a snapshot into a new empty directory and preserve authoritative fingerprints and evidence.',
    { snapshot_id: z.string(), destination: z.string() },
    (i) => restoreArchive(root, i.snapshot_id, i.destination),
    false,
  );
  tool(
    'note_create',
    'Create Cornell documentation with one {note: {...}} envelope. Supply note.path for task-bound work and practice.exercise_path/answer_path; commands are argument arrays. Expected results and observed evidence remain separate.',
    {
      note: cornellNoteSchema,
      revision_id: z
        .string()
        .optional()
        .describe(
          'Existing draft Cornell record ID for an owned fixed-path repair; omit for creation.',
        ),
      expected_revision: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('Required with revision_id; read the current record revision before repair.'),
      revision_reason: z
        .string()
        .optional()
        .describe(
          'Required substantive repair rationale with revision_id; prior bytes/native authorship remain immutable history.',
        ),
    },
    (i) => {
      const receipt = bound();
      if (i.revision_id) {
        const existing = scopedRecord(root, receipt, i.revision_id);
        if (receipt?.task_id && existing.meta.data.task_id !== receipt.task_id)
          throw new Error('Cornell revision belongs to a different assigned task.');
      } else if (i.expected_revision !== undefined || i.revision_reason !== undefined)
        throw new Error('Cornell revision fields require revision_id.');
      assertTaskOutputPaths(root, receipt, [
        i.note.path,
        i.note.practice?.exercise_path,
        i.note.practice?.answer_path,
        ...(i.note.practice?.solution_path ? [i.note.practice.solution_path] : []),
      ]);
      for (const id of [
        ...(i.note.requirement_ids ?? []),
        ...(i.note.problem_ids ?? []),
        ...(i.note.demonstration?.evidence_ids ?? []),
        ...(i.note.sources ?? []).flatMap((source: any) =>
          source.record_id ? [source.record_id] : [],
        ),
      ])
        scopedRecord(root, receipt, id);
      if (receipt)
        for (const source of i.note.sources)
          if (!source.record_id && !/^https:\/\//.test(source.uri))
            projectRead(root, { path: source.uri, max_chars: 128 }, receipt);
      const input = {
        ...i.note,
        ...(receipt ? { owner: receipt.role } : {}),
      } as CornellInput;
      const note = i.revision_id
        ? reviseCornellNote(root, i.revision_id, input, i.expected_revision, i.revision_reason)
        : createCornellNote(root, input);
      if (!receipt) return note;
      const attribution = authoredData(receipt);
      const links = [
        ...note.meta.links,
        ...(receipt.task_id &&
        !note.meta.links.some(
          (link) => link.type === 'documents' && link.target === receipt.task_id,
        )
          ? [{ type: 'documents' as const, target: receipt.task_id }]
          : []),
      ];
      if (
        Object.entries(attribution).every(
          ([key, value]) => JSON.stringify(note.meta.data[key]) === JSON.stringify(value),
        ) &&
        links.length === note.meta.links.length
      )
        return note;
      return updateRecord(
        root,
        note.meta.id,
        { data: attribution, links },
        undefined,
        (current) => {
          if (current.meta.revision !== note.meta.revision)
            throw new Error(
              'Cornell note changed before native attribution; read it before retrying.',
            );
        },
      );
    },
    false,
  );
  tool(
    'note_validate',
    'Validate Cornell structure, demonstration, practice, citations, links, and source freshness.',
    { id: z.string() },
    (i) => validateCornellNote(root, i.id),
  );
  tool(
    'recipe_list',
    'Inspect the three versioned parameterized engineering recipes and their demonstrated limitations.',
    {},
    () => listRecipes(),
  );
  tool(
    'recipe_resolve',
    'Resolve an exact recipe identity, version, generator hash, and parameter contract.',
    { recipe_id: z.string(), version: z.string().optional() },
    (i) => resolveRecipe(i.recipe_id, i.version),
  );
  tool(
    'recipe_prepare',
    'Prepare frozen parameters, implementation interfaces, verification cases, expected outputs, and oracle rationale for strategic review.',
    {
      recipe_id: z.string(),
      version: z.string().optional(),
      parameters: z.record(z.string(), z.unknown()),
      requirement_ids: z.array(z.string()),
      task_id: z.string().optional(),
      owner: z.string().optional(),
    },
    (i) => {
      const receipt = bound();
      if (receipt && i.requirement_ids.some((id: string) => !recordScope(root, receipt).has(id)))
        throw new Error('Recipe requirements escape the assigned context.');
      const before = new Set(loadRecords(root).map((record) => record.meta.id));
      const instance = prepareRecipe(root, {
        ...i,
        owner: i.owner ?? 'developer',
        ...(receipt?.workflow_id ? { workflow_id: receipt.workflow_id } : {}),
        ...(receipt?.task_id ? { task_id: receipt.task_id } : {}),
      } as RecipeInput);
      if (receipt)
        for (const record of loadRecords(root).filter((record) => !before.has(record.meta.id)))
          updateRecord(root, record.meta.id, { data: authoredData(receipt, record.meta.data) });
      return getRecord(root, instance.meta.id);
    },
    false,
  );
  tool(
    'recipe_run',
    'Execute the accepted parameterized generator and protected verification artifacts without weakening expectations.',
    { id: z.string() },
    (i) => runRecipe(root, i.id, bound()?.id),
    false,
  );
  tool(
    'recipe_revise',
    'Apply a reviewed specification/oracle correction and require fresh review and evidence.',
    {
      id: z.string(),
      change_id: z.string(),
      parameters: z.record(z.string(), z.unknown()),
      reason: z.string(),
    },
    (i) => reviseRecipe(root, i.id, i),
    false,
  );
  return server;
}

export async function startMcp(root: string, binding: McpBinding = {}): Promise<void> {
  const server = createMcpServer(root, binding);
  await server.connect(new StdioServerTransport());
}
