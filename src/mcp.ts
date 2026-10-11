import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { createRecord, getRecord, loadRecords, readConfig, updateRecord } from './storage.js';
import {
  acceptTask,
  archiveEvidence,
  contextPacket,
  reviewTask,
  reviewRecord,
  runCheck,
  startTask,
  resumeTask,
  requestRepair,
  submitTask,
  traceRecord,
  verify,
} from './engineering.js';
import { searchMemory } from './indexing.js';
import { listPacks, installPack, prepareContribution, suggestPacks } from './packs.js';
import { recordTypes } from './types.js';
import { doctor } from './installer.js';
import { submitContribution } from './contributions.js';
import {
  beginWorkflow,
  discussWorkflow,
  decideWorkflow,
  discussionRoles,
  finishWorkflow,
  workflowStatus,
} from './manager.js';

export async function startMcp(root: string): Promise<void> {
  readConfig(root);
  const server = new McpServer({ name: 'verythinker', version: '0.1.0-alpha.2' });
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
    'manager_begin',
    'Start or recover a requirement workflow. The active native manager owns internal discussion, execution and closure.',
    {
      requirement: z.string(),
      title: z.string().optional(),
      invocation_id: z.string().optional(),
      request_id: z.string().optional(),
    },
    (i) => beginWorkflow(root, i),
    false,
  );
  tool(
    'manager_discuss',
    'Persist an actual specialist contribution with its invocation and inspected input baselines; bounded to three rounds.',
    {
      workflow_id: z.string(),
      role: z.enum(discussionRoles),
      invocation_id: z.string(),
      summary: z.string(),
      rationale: z.string(),
      risks: z.array(z.string()).optional(),
      source_ids: z.array(z.string()).optional(),
      round: z.number().int().optional(),
    },
    (i) => discussWorkflow(root, i.workflow_id, i),
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
    (i) => loadRecords(root).filter((r) => !i.type || r.meta.type === i.type),
  );
  tool('record_get', 'Read one engineering record.', { id: z.string() }, (i) =>
    getRecord(root, i.id),
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
    (i) => createRecord(root, i),
    false,
  );
  tool(
    'record_update',
    'Update record data or body. Acceptance is handled by task_accept.',
    {
      id: z.string(),
      data: z.record(z.string(), z.unknown()).optional(),
      body: z.string().optional(),
    },
    (i) => updateRecord(root, i.id, { data: i.data }, i.body),
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
    (i) => startTask(root, i.id, i.requested_model, i.confirmed_model, i.invocation_id),
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
    (i) => resumeTask(root, i.id, i.requested_model, i.confirmed_model, i.invocation_id),
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
    'task_submit',
    'Persist worker submission and standard work history.',
    { id: z.string(), summary: z.string(), work_record: z.string().optional() },
    (i) => submitTask(root, i.id, i.summary, i.work_record),
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
    (i) => runCheck(root, i.id, i.task),
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
    'Record an independent task review against its current fingerprint.',
    {
      id: z.string(),
      owner: z.string(),
      decision: z.enum(['pass', 'fail']),
      findings: z.array(z.string()).optional(),
      invocation_id: z.string().optional(),
    },
    (i) => reviewTask(root, i.id, i.owner, i.decision, i.findings, i.invocation_id),
    false,
  );
  tool(
    'record_review',
    'Record an independent design, requirement, or generalized knowledge review.',
    {
      id: z.string(),
      owner: z.string(),
      decision: z.enum(['pass', 'fail']),
      findings: z.array(z.string()).optional(),
      invocation_id: z.string().optional(),
      generalization_review: z.boolean().optional(),
    },
    (i) =>
      reviewRecord(
        root,
        i.id,
        i.owner,
        i.decision,
        i.findings,
        i.invocation_id,
        i.generalization_review,
      ),
    false,
  );
  tool(
    'memory_search',
    'Find project records using the local rebuildable FTS5 index.',
    { query: z.string() },
    (i) => searchMemory(root, i.query),
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
  await server.connect(new StdioServerTransport());
}
