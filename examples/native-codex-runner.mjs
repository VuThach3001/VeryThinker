import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const options = {};
for (let i = 2; i < process.argv.length; i += 2) {
  if (!process.argv[i]?.startsWith('--') || !process.argv[i + 1]) throw new Error('Runner options require values.');
  options[process.argv[i].slice(2)] = process.argv[i + 1];
}
const executable = options.codex ?? 'codex';
const model = options['strong-model'];
const timeout = Number(options['timeout-ms'] ?? 240_000);
if (!model || !Number.isSafeInteger(timeout) || timeout < 1) throw new Error('Supply --strong-model and a positive optional --timeout-ms.');
let input = '';
for await (const chunk of process.stdin) input += chunk;
const packet = JSON.parse(input);
if (packet.configuration !== 'strong-single') throw new Error('This native wrapper supports strong-single only. Supply a platform-native multi-agent wrapper for the other configurations.');

async function invoke(stage, prompt) {
  const last = resolve(`${stage}-last-message.json`);
  const args = ['exec', '--ignore-user-config', '--model', model, '--sandbox', 'workspace-write',
    '--skip-git-repo-check', '--ephemeral', '--json', '--color', 'never',
    '-c', 'model_reasoning_effort="low"', '-c', 'approval_policy="never"',
    '--output-last-message', last, '-'];
  const child = spawn(executable, args, { cwd: packet.workspace, shell: false, windowsHide: true });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', data => { stdout += data; });
  child.stderr.on('data', data => { stderr += data; });
  const timer = setTimeout(() => child.kill(), timeout);
  child.stdin.end(prompt);
  const result = await new Promise(resolveResult => {
    child.on('error', error => resolveResult({ code: null, error: error.message }));
    child.on('close', (code, signal) => resolveResult({ code, signal }));
  });
  clearTimeout(timer);
  await writeFile(`${stage}.events.jsonl`, stdout);
  await writeFile(`${stage}.stderr.log`, stderr);
  const events = stdout.split(/\r?\n/).filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
  const actor = events.find(event => event.type === 'thread.started')?.thread_id ?? null;
  const usage = events.findLast(event => event.type === 'turn.completed')?.usage ?? null;
  let response = null;
  try { response = JSON.parse(await readFile(last, 'utf8')); } catch { /* unavailable */ }
  return { ...result, actor, usage, response, log: `${stage}.events.jsonl`, requested_model: model,
    confirmed_model: 'unavailable' };
}

const task = `Implement the ${packet.pilot} pilot in this isolated workspace.
Read task-packet.json and README.md for requirements and interfaces.
Edit the implementation files only; preserve README.md and tests. Do not access the completed VeryThinker source repository.
Use Node.js standard libraries. For the embedded pilot, implement the portable C controller too.
You are the single implementation agent; do not delegate.
Run the acceptance command from task-packet.json. Fix actual failures within the task scope.
Write work-record.md using Objective, Inputs and Sources, Decisions and Rationale, Results, Evidence, Limitations, Lessons.
All authored content must be English. Record unavailable information explicitly.
Return ONLY JSON: {"status":"submitted"|"failed","summary":"...","limitations":["..."]}.
Do not claim independent review or physical hardware validation.`;

try {
  const implementation = await invoke('implementation', task);
  let review = { status: 'unavailable', actor: null, artifact: null };
  let reviewed = null;
  if (implementation.code === 0 && implementation.response?.status === 'submitted') {
    const source = packet.pilot === 'software' ? 'config.mjs' : 'simulation.mjs';
    const sourceHash = createHash('sha256').update(await readFile(source)).digest('hex');
    reviewed = await invoke('review', `Perform a separate independent review of this ${packet.pilot} pilot.
Read README.md, task-packet.json, implementation sources, tests, and work-record.md.
Run the acceptance command. Inspect requirement coverage and failure behavior.
Do not modify source, tests, or requirements. Report observed evidence and limitations honestly.
All authored content must be English.
Return ONLY JSON: {"decision":"pass"|"fail","findings":["..."],"limitations":["..."]}.
Use pass only with no open material findings; distinguish simulation from hardware evidence.`);
    const unchanged = sourceHash === createHash('sha256').update(await readFile(source)).digest('hex');
    if (reviewed.code === 0 && reviewed.response && unchanged) {
      await writeFile('independent-review.md', `# Independent native review\n\nInvocation: ${reviewed.actor ?? 'unavailable'}\n\n${JSON.stringify(reviewed.response, null, 2)}\n`);
      const pass = reviewed.response.decision === 'pass' && Array.isArray(reviewed.response.findings) && reviewed.response.findings.length === 0;
      review = { status: pass ? 'accepted' : 'rejected', actor: reviewed.actor, artifact: 'independent-review.md' };
    }
  }
  const response = { implementation_actor: implementation.actor, review,
    requested_models: { implementation: model, review: model },
    confirmed_models: 'unavailable', metrics: { retries: null, escalations: null, escaped_defects: null,
      human_correction_minutes: null, cost_amount: null, cost_currency: null, quota_consumed: null },
    evidence: ['implementation.events.jsonl', 'implementation.stderr.log',
      ...(reviewed ? ['review.events.jsonl', 'review.stderr.log'] : [])],
    native_observations: { implementation, review: reviewed },
    limitations: ['The CLI JSON event stream did not expose a confirmed backend model ID.',
      'Reported token usage is not a measured price or account quota charge.'] };
  await writeFile('native-run-observations.json', `${JSON.stringify(response, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(response)}\n`);
  if (implementation.code !== 0 || implementation.response?.status !== 'submitted') process.exitCode = 1;
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
