// Protocol fixture only. This process does not authenticate or perform inference.
import { createInterface } from 'node:readline';
const scenario = process.argv[2] ?? 'success';
let model;
let effort;
let cwd;
let counter = 0;
let currentThread;
let currentTurn;
let changed = false;
let configuration;
const send = (value) => process.stdout.write(JSON.stringify(value) + '\n');
const result = (id, value) => send({ id, result: value });
const error = (id, message) => send({ id, error: { code: -32000, message } });
const finish = (status, failure) =>
  send({
    method: 'turn/completed',
    params: {
      threadId: currentThread,
      turn: {
        id: currentTurn,
        status,
        items: [],
        ...(failure ? { error: { message: failure } } : {}),
      },
    },
  });
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  const { id, method, params } = message;
  if (method === 'initialize') {
    if (scenario === 'initialize-timeout') continue;
    result(id, { userAgent: 'codex-cli/0.162.1' });
  }
  if (method === 'initialized') continue;
  if (method === 'thread/unsubscribe') {
    result(id, { status: 'unsubscribed' });
    continue;
  }
  if (method === 'thread/turns/list') {
    result(id, { data: [], nextCursor: null });
    continue;
  }
  if (method === 'config/read')
    result(id, {
      config: {
        model_provider: 'openai',
        changed,
        ...(scenario === 'explicit-tool-policy'
          ? { mcp_servers: { verythinker: { tools: { record_get: { approval_mode: 'prompt' } } } } }
          : {}),
      },
      origins: {},
    });
  if (method === 'thread/start' || method === 'thread/resume') {
    if (method === 'thread/resume' && scenario === 'large-resume' && !params.excludeTurns) {
      result(id, { thread: { id: params.threadId, turns: [{ items: ['x'.repeat(9 * 1024 * 1024)] }] } });
      continue;
    }
    if (method === 'thread/resume' && scenario === 'resume-pre-ack-failure') {
      error(id, 'Transient native resume failure before acknowledgment.');
      continue;
    }
    model = params.model;
    configuration = params;
    effort = params.config.model_reasoning_effort;
    cwd = params.cwd;
    if (scenario === 'unavailable' && model === 'gpt-6-luna') {
      error(id, 'Model gpt-6-luna is not supported with this account.');
      continue;
    }
    if (scenario === 'auth-missing') {
      error(id, 'Authentication credentials missing for model access.');
      continue;
    }
    currentThread = params.threadId ?? `thread-${++counter}`;
    const nativeModel = scenario === 'wrong-model' ? 'gpt-6-astra' : model;
    const response = {
      model: nativeModel,
      modelProvider: 'openai',
      reasoningEffort: effort,
      cwd,
      approvalPolicy: 'on-request',
      approvalsReviewer: 'user',
      sandbox: {
        type: scenario === 'wrong-sandbox'
          ? 'readOnly'
          : configuration.sandbox === 'read-only'
            ? 'readOnly'
            : 'workspaceWrite',
      },
      thread: { id: currentThread, turns: [] },
    };
    if (scenario === 'missing-model') delete response.model;
    if (scenario === 'missing-sandbox') delete response.sandbox;
    if (scenario === 'wrong-effort') response.reasoningEffort = 'low';
    result(id, response);
  }
  if (method === 'turn/start') {
    currentTurn = `turn-${++counter}`;
    result(id, { turn: { id: currentTurn, status: 'inProgress', items: [] } });
    if (scenario === 'hang') continue;
    if (scenario === 'permission') {
      setTimeout(
        () =>
          send({
            id: 900,
            method: 'item/commandExecution/requestApproval',
            params: {
              threadId: currentThread,
              turnId: currentTurn,
              reason: 'Native command requires existing user approval.',
            },
          }),
        20,
      );
      continue;
    }
    setTimeout(() => {
      if (scenario === 'approval-scope')
        send({
          method: 'item/agentMessage/delta',
          params: {
            threadId: currentThread,
            turnId: currentTurn,
            delta: JSON.stringify({
              config: configuration.config,
              approvalPolicy: configuration.approvalPolicy ?? null,
              sandbox: configuration.sandbox ?? null,
            }),
          },
        });
      if (scenario === 'turn-unavailable' && model === 'gpt-6-luna')
        return finish('failed', 'Model gpt-6-luna is unavailable for this account.');
      if (scenario === 'reroute')
        send({
          method: 'model/rerouted',
          params: {
            threadId: currentThread,
            turnId: currentTurn,
            fromModel: model,
            toModel: 'gpt-6-astra',
            reason: 'quota',
          },
        });
      if (scenario === 'changed-config') changed = true;
      if (scenario !== 'approval-scope')
        send({
          method: 'item/agentMessage/delta',
          params: {
            threadId: currentThread,
            turnId: currentTurn,
            delta: 'Protocol fixture output.',
          },
        });
      finish('completed');
    }, 30);
  }
  if (method === 'turn/interrupt') {
    result(id, {});
    finish('interrupted');
  }
}
