import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer, assertTaskOutputPaths } from '../dist/mcp.js';
import { initialize, createRecord, loadRecords } from '../dist/storage.js';
import { cornellKinds, cornellQuote } from '../dist/notes.js';

async function legacyClient(t) {
  const root = mkdtempSync(join(tmpdir(), 'verythinker-cornell-schema-'));
  // This explicitly uninstalled legacy fixture tests schema/core mechanics, never native access.
  initialize(root, { project_id: 'CORNELL-SCHEMA', name: 'Cornell schema mechanics fixture' });
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src/answer.mjs'), 'export const answer = 42;\n');
  const server = createMcpServer(root);
  const client = new Client({ name: 'cornell-schema-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => {
    await client.close();
    await server.close();
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    rmSync(root, { recursive: true, force: true });
  });
  return { root, client };
}

function noteInput() {
  return {
    topic: 'Named numeric export',
    kind: 'codebase-analysis',
    path: 'docs/knowledge/answer.md',
    owner: 'curator',
    date: '2026-10-11',
    context: 'The local module provides a fixed named export for a runnable demonstration.',
    constraints: ['Node.js executes the module without additional dependencies.'],
    cues: ['Which named export contains the numeric answer?'],
    main_notes:
      '[source-reported] The local module exports answer with value 42 [S1]. [expected] Importing it yields the same number.',
    sources: [
      {
        id: 'S1',
        title: 'Local numeric export module',
        uri: 'src/answer.mjs',
        retrieved_at: '2026-10-11T00:00:00Z',
        locator: 'line 1',
      },
    ],
    demonstration: {
      body: 'Import the named answer export and inspect its value.',
      expected: 'The named answer export evaluates to numeric value 42.',
      command: [
        process.execPath,
        '--input-type=module',
        '-e',
        'import { answer } from "./src/answer.mjs"; console.log(answer)',
      ],
    },
    failure_cases: ['Changing the export name causes named-import resolution to fail.'],
    practice: {
      exercise_path: 'docs/practice/answer-exercise.md',
      exercise: '# Exercise\nCreate a named export and explain how an import resolves its value.\n',
      answer_path: 'docs/practice/answer-key.md',
      answer:
        '# Answer\nDeclare a named export and use its matching named import in the consumer.\n',
      solution_path: 'docs/practice/my-answer.mjs',
      starter: '// Write your own named-export demonstration.\n',
      command: [
        process.execPath,
        '--input-type=module',
        '-e',
        'import { answer } from "./src/answer.mjs"; if(answer !== 42) process.exit(1)',
      ],
    },
    summary:
      'A named export gives callers a stable symbolic interface to the declared numeric value.',
  };
}

test('Cornell MCP discovery exposes paths, source ledger, commands, and diagnostic fields', async (t) => {
  const { client } = await legacyClient(t);
  const tool = (await client.listTools()).tools.find((item) => item.name === 'note_create');
  assert.ok(tool);
  assert.equal(tool.inputSchema.properties.revision_id.type, 'string');
  assert.equal(tool.inputSchema.properties.expected_revision.type, 'integer');
  assert.deepEqual(tool.inputSchema.required, ['note']);
  const note = tool.inputSchema.properties.note;
  assert.equal(note.type, 'object');
  assert.equal(note.additionalProperties, false);
  assert.deepEqual(note.properties.kind.enum, [...cornellKinds]);
  assert.match(note.properties.path.description, /task-bound/);
  assert.ok(!note.required.includes('path'), 'Keep the legacy core default path compatible.');
  assert.ok(note.required.includes('practice'));
  for (const path of ['exercise_path', 'answer_path']) {
    assert.equal(note.properties.practice.properties[path].type, 'string');
    assert.ok(note.properties.practice.required.includes(path));
  }
  for (const section of ['demonstration', 'practice']) {
    assert.equal(note.properties[section].properties.command.type, 'array');
    assert.equal(note.properties[section].properties.command.items.type, 'string');
  }
  assert.equal(note.properties.sources.items.properties.retrieved_at.type, 'string');
  assert.equal(note.properties.sources.items.properties.record_id.type, 'string');
  assert.deepEqual(note.properties.root_cause.properties.conclusion.enum, [
    'confirmed',
    'unresolved',
  ]);
});

test('typed Cornell envelope creates valid artifacts and rejects malformed nested paths before writes', async (t) => {
  const { root, client } = await legacyClient(t);
  const malformed = noteInput();
  malformed.practice.paths = {
    exercise: malformed.practice.exercise_path,
    answer: malformed.practice.answer_path,
  };
  delete malformed.practice.exercise_path;
  delete malformed.practice.answer_path;
  const before = loadRecords(root).length;
  const refused = await client.callTool({ name: 'note_create', arguments: { note: malformed } });
  assert.equal(refused.isError, true);
  assert.match(
    refused.content.map((item) => item.text ?? '').join('\n'),
    /exercise_path|answer_path/,
  );
  assert.equal(loadRecords(root).length, before);
  assert.equal(existsSync(join(root, 'docs')), false);
  const wrongCommand = noteInput();
  wrongCommand.demonstration.command = 'node demo.mjs';
  const refusedCommand = await client.callTool({
    name: 'note_create',
    arguments: { note: wrongCommand },
  });
  assert.equal(refusedCommand.isError, true);
  assert.match(refusedCommand.content.map((item) => item.text ?? '').join('\n'), /command|array/);
  assert.equal(loadRecords(root).length, before);
  assert.equal(existsSync(join(root, 'docs')), false);
  const unprovenObservation = noteInput();
  unprovenObservation.demonstration.observed = 'The actual runtime returned the expected number.';
  const refusedObservation = await client.callTool({
    name: 'note_create',
    arguments: { note: unprovenObservation },
  });
  assert.equal(refusedObservation.isError, true);
  assert.match(
    refusedObservation.content.map((item) => item.text ?? '').join('\n'),
    /requires evidence/,
  );
  assert.equal(loadRecords(root).length, before);
  assert.equal(existsSync(join(root, 'docs')), false);
  mkdirSync(join(root, 'docs/practice'), { recursive: true });
  const authored = '// My own solution must remain intact.\n';
  writeFileSync(join(root, 'docs/practice/my-answer.mjs'), authored);
  const created = await client.callTool({ name: 'note_create', arguments: { note: noteInput() } });
  assert.notEqual(created.isError, true);
  const record = JSON.parse(created.content[0].text);
  assert.equal(record.meta.data.artifact_path, 'docs/knowledge/answer.md');
  assert.ok(
    readFileSync(join(root, record.meta.data.artifact_path), 'utf8').includes(cornellQuote),
  );
  assert.equal(readFileSync(join(root, 'docs/practice/my-answer.mjs'), 'utf8'), authored);
  const validation = await client.callTool({
    name: 'note_validate',
    arguments: { id: record.meta.id },
  });
  assert.equal(JSON.parse(validation.content[0].text).ok, true);
  assert.match(
    readFileSync(join(root, 'docs/knowledge/answer.md'), 'utf8'),
    /has not been executed/,
  );
  const corrected = noteInput();
  corrected.practice.exercise +=
    '\nComplete the independent assertion in the learner scaffold.\n```js\n// TODO: add the required numeric comparison.\n```\n';
  const revision = await client.callTool({
    name: 'note_create',
    arguments: {
      note: corrected,
      revision_id: record.meta.id,
      expected_revision: record.meta.revision,
      revision_reason:
        'Restore the intentional reviewed practice scaffold at the existing assigned artifact paths.',
    },
  });
  assert.notEqual(revision.isError, true);
  const revised = JSON.parse(revision.content[0].text);
  assert.equal(revised.meta.id, record.meta.id);
  assert.equal(revised.meta.data.revision_history.length, 1);
  assert.equal(readFileSync(join(root, 'docs/practice/my-answer.mjs'), 'utf8'), authored);
});

test('Cornell schema preserves the existing explicit task output boundary', async (t) => {
  const { root } = await legacyClient(t);
  const task = createRecord(root, {
    type: 'task',
    title: 'Document the assigned module',
    data: { allowed_paths: ['docs/knowledge', 'docs/practice'] },
  });
  const binding = { task_id: task.meta.id };
  const note = noteInput();
  const outputs = [
    note.path,
    note.practice.exercise_path,
    note.practice.answer_path,
    note.practice.solution_path,
  ];
  assert.doesNotThrow(() => assertTaskOutputPaths(root, binding, outputs));
  assert.throws(
    () => assertTaskOutputPaths(root, binding, [...outputs, 'docs/unrelated/answer.md']),
    /outside the assigned task scope/,
  );
  assert.throws(
    () => assertTaskOutputPaths(root, binding, [undefined, ...outputs.slice(1)]),
    /explicit output paths/,
  );
});
