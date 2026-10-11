import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  initialize,
  beginWorkflow,
  discussWorkflow,
  decideWorkflow,
  workflowStatus,
  finishWorkflow,
  readAutomationPolicy,
  ensureAutomationPolicy,
  createRecord,
  updateRecord,
  getRecord,
  loadRecords,
  startTask,
  runCheck,
  archiveEvidence,
  submitTask,
  reviewTask,
  reviewRecord,
  submitContribution,
} from '../dist/index.js';

function fixture(t, plan = true) {
  const root = mkdtempSync(join(tmpdir(), 'verythinker-manager-'));
  t.after(() => {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    rmSync(root, { recursive: true, force: true });
  });
  initialize(root, { project_id: 'MANAGER', profile: 'basic' });
  const parent = beginWorkflow(root, {
    requirement: 'Provide a documented module exporting integer one.',
    invocation_id: 'manager-fixture',
    request_id: 'request-fixture',
  });
  const requirement = updateRecord(root, parent.meta.data.requirement_id, {
    data: { acceptance_criteria: ['The named value export is integer one.'] },
  });
  mkdirSync(join(root, 'src'));
  mkdirSync(join(root, 'docs'));
  writeFileSync(join(root, 'src/value.mjs'), 'export const value = 1;\n');
  writeFileSync(join(root, 'docs/value.md'), '# Value\nThe module exports integer one.\n');
  const task = createRecord(root, {
    type: 'task',
    title: 'Deliver documented value',
    owner: 'developer',
    links: [{ type: 'satisfies', target: requirement.meta.id }],
    data: {
      acceptance_criteria: ['Export one and document its interface.'],
      allowed_paths: ['src', 'docs'],
      documentation_paths: ['docs/value.md'],
      outputs: ['src/value.mjs', 'docs/value.md'],
    },
  });
  const check = createRecord(root, {
    type: 'check',
    title: 'Verify exported value',
    owner: 'verifier',
    links: [{ type: 'verifies', target: requirement.meta.id }],
    data: {
      command: [
        process.execPath,
        '--input-type=module',
        '-e',
        'import {value} from "./src/value.mjs"; if(value!==1) process.exit(1)',
      ],
      baseline_paths: ['src'],
      method: 'unit',
    },
  });
  const work = { root, parent, requirement, task, check };
  if (plan) {
    discussions(work);
    decideWorkflow(root, parent.meta.id, {
      summary: 'Use a named export and a focused executable assertion.',
      rationale: 'The requested invariant requires no runtime dependency or service.',
      task_ids: [task.meta.id],
    });
  }
  return work;
}
function discussions(work) {
  for (const role of ['requirements', 'verifier'])
    discussWorkflow(work.root, work.parent.meta.id, {
      role,
      invocation_id: `${role}-discussion-fixture`,
      summary:
        role === 'requirements'
          ? 'The export and documentation provide measurable outcomes.'
          : 'An executable import assertion verifies the observable module contract.',
      rationale:
        'This small scope can use the basic V-model profile with a separately reviewed result.',
      source_ids: [work.requirement.meta.id],
      risks: [],
    });
}
function submitted(work, independentReview = true) {
  startTask(work.root, work.task.meta.id, undefined, undefined, 'developer-fixture');
  const evidence = runCheck(work.root, work.check.meta.id, work.task.meta.id);
  archiveEvidence(work.root, evidence.meta.id);
  const body =
    `# Objective\nDeliver ${work.task.meta.id} with the documented named numeric export.\n\n` +
    `# Inputs and Sources\nInspected requirement ${work.requirement.meta.id}, the value module, and its documented interface.\n\n` +
    '# Decisions and Rationale\nUsed one named export because the requested numeric invariant needs no parser or external dependencies.\n\n' +
    '# Results\nThe value module exports integer one and docs/value.md describes the expected interface.\n\n' +
    `# Evidence\nExecuted check ${work.check.meta.id}; collected ${evidence.meta.id} and archived its log and receipt.\n\n` +
    '# Limitations\nThe fixture verifies a small module contract; native model identity and broader application behavior remain unobserved.\n\n' +
    '# Lessons\nA focused executable assertion gives repeatable evidence for a fixed export without additional testing dependencies.\n';
  submitTask(
    work.root,
    work.task.meta.id,
    'Delivered and verified the documented numeric export.',
    body,
  );
  if (independentReview)
    reviewTask(work.root, work.task.meta.id, 'reviewer', 'pass', [], 'reviewer-fixture');
}
function candidate(work, reviewed = true) {
  const record = createRecord(work.root, {
    type: 'knowledge',
    title: 'Focused verification for fixed module exports',
    owner: 'curator',
    links: [{ type: 'references', target: work.task.meta.id }],
    data: {
      kind: 'generalized-candidate',
      workflow_id: work.parent.meta.id,
      invocation_id: 'curator-fixture',
      generalization:
        'For a fixed module export, an executable import assertion can establish the stated value on a recorded source baseline.',
      applicability: ['Small deterministic module contracts'],
      provenance: ['https://nodejs.org/api/assert.html'],
      assumptions: ['The observable contract is the export value.'],
      limitations: ['Does not assess production reliability.'],
    },
    body: 'This candidate generalizes the reviewed verification procedure without private project records.',
  });
  if (reviewed)
    reviewRecord(work.root, record.meta.id, 'reviewer', 'pass', [], 'generalization-fixture', true);
  return record;
}
function githubFixture() {
  const calls = [];
  const request = (method, endpoint, body) => {
    calls.push({ method, endpoint, body });
    if (method === 'GET' && endpoint === 'repos/VuThach3001/VeryThinker')
      return { default_branch: 'main' };
    if (endpoint.includes('/git/ref/heads/')) return { object: { sha: 'base' } };
    if (method === 'GET' && endpoint.includes('/git/commits/'))
      return { sha: 'base', tree: { sha: 'tree' } };
    if (endpoint.endsWith('/git/trees')) return { sha: 'new-tree' };
    if (endpoint.endsWith('/git/commits')) return { sha: 'new-commit' };
    if (endpoint.endsWith('/git/refs')) return {};
    if (method === 'POST' && endpoint.endsWith('/pulls'))
      return { html_url: 'https://github.com/VuThach3001/VeryThinker/pull/123' };
    throw new Error(`Unexpected fixture request: ${method} ${endpoint}`);
  };
  return {
    calls,
    publish: (root, id, upstream) => submitContribution(root, id, upstream, request),
  };
}

test('one requirement intake is resumable and idempotent by explicit request identity', (t) => {
  const work = fixture(t, false);
  const again = beginWorkflow(work.root, {
    requirement: 'Provide a documented module exporting integer one.',
    request_id: 'request-fixture',
  });
  assert.equal(again.meta.id, work.parent.meta.id);
  assert.equal(loadRecords(work.root).filter((r) => r.meta.type === 'requirement').length, 1);
  assert.throws(
    () =>
      beginWorkflow(work.root, { requirement: 'Different intent', request_id: 'request-fixture' }),
    /different requirement/,
  );
  assert.match(workflowStatus(work.root, work.parent.meta.id).next_action, /specialist/);
});
test('project policy preserves configured targets and disables entrypoint only when requested', (t) => {
  const work = fixture(t, false);
  const policy = readAutomationPolicy(work.root);
  assert.equal(policy.upstream, 'VuThach3001/VeryThinker');
  writeFileSync(
    join(work.root, '.verythinker/automation.json'),
    JSON.stringify({ ...policy, upstream: 'example/library', automatic_pr: false }),
  );
  assert.equal(ensureAutomationPolicy(work.root).upstream, 'example/library');
  assert.equal(ensureAutomationPolicy(work.root).automatic_pr, false);
  writeFileSync(
    join(work.root, '.verythinker/automation.json'),
    JSON.stringify({ ...policy, manager_enabled: false }),
  );
  assert.throws(() => beginWorkflow(work.root, { requirement: 'Another requirement' }), /disabled/);
});
test('discussion and decision require bounded distinct current specialist inputs', (t) => {
  const work = fixture(t, false);
  const input = {
    role: 'requirements',
    invocation_id: 'manager-fixture',
    summary: 'Requirement is measurable.',
    rationale: 'Use the module output.',
    source_ids: [work.requirement.meta.id],
  };
  assert.throws(() => discussWorkflow(work.root, work.parent.meta.id, input), /own invocation/);
  assert.throws(
    () =>
      discussWorkflow(work.root, work.parent.meta.id, {
        ...input,
        invocation_id: 'specialist',
        round: 4,
      }),
    /bounded/,
  );
  const decision = {
    summary: 'Use a module.',
    rationale: 'A focused contract suffices.',
    task_ids: [work.task.meta.id],
  };
  assert.throws(
    () => decideWorkflow(work.root, work.parent.meta.id, decision),
    /two specialist roles/,
  );
  discussions(work);
  updateRecord(work.root, work.requirement.meta.id, {
    data: { acceptance_criteria: ['The module now exports two.'] },
  });
  assert.throws(
    () => decideWorkflow(work.root, work.parent.meta.id, decision),
    /current contributions/,
  );
});
test('a manager plan cannot substitute tasks unrelated to the stakeholder requirement', (t) => {
  const work = fixture(t, false);
  discussions(work);
  const unrelated = createRecord(work.root, {
    type: 'requirement',
    title: 'Unrelated outcome',
    data: { acceptance_criteria: ['Another invariant.'] },
  });
  updateRecord(work.root, work.task.meta.id, {
    links: [{ type: 'satisfies', target: unrelated.meta.id }],
  });
  assert.throws(
    () =>
      decideWorkflow(work.root, work.parent.meta.id, {
        summary: 'Implement something else.',
        rationale: 'A different objective is easier.',
        task_ids: [work.task.meta.id],
      }),
    /trace to the stakeholder/,
  );
});
test('closure validates documentation and review, accepts tasks and persists one final report', (t) => {
  const work = fixture(t);
  assert.equal(getRecord(work.root, work.task.meta.id).meta.data.documentation_required, true);
  submitted(work);
  assert.throws(
    () => finishWorkflow(work.root, work.parent.meta.id, { no_lesson_reason: 'n/a' }),
    /no-lesson rationale/,
  );
  const disposition = {
    no_lesson_reason:
      'This fixture repeats an existing basic verification lesson and supplies no new reusable insight.',
  };
  const result = finishWorkflow(work.root, work.parent.meta.id, disposition);
  assert.equal(result.phase, 'completed');
  assert.equal(getRecord(work.root, work.task.meta.id).meta.status, 'accepted');
  assert.match(result.final_report, /Documentation and separate review were validated/);
  const resumed = finishWorkflow(work.root, work.parent.meta.id, {});
  assert.equal(resumed.final_report_id, result.final_report_id);
  assert.equal(
    loadRecords(work.root).filter((r) => r.meta.title === 'Manager final report').length,
    1,
  );
});
test('missing independent review or changed documented output blocks automatic closure', (t) => {
  const work = fixture(t);
  submitted(work, false);
  assert.throws(
    () =>
      finishWorkflow(work.root, work.parent.meta.id, {
        no_lesson_reason: 'There is no additional reusable insight beyond the existing procedure.',
      }),
    /independent review/,
  );
  reviewTask(work.root, work.task.meta.id, 'reviewer', 'pass', [], 'reviewer-fixture');
  writeFileSync(
    join(work.root, 'docs/value.md'),
    '# Changed interface\nThe output is now undocumented.\n',
  );
  assert.throws(
    () =>
      finishWorkflow(work.root, work.parent.meta.id, {
        no_lesson_reason: 'There is no additional reusable insight beyond the existing procedure.',
      }),
    /Documentation files changed/,
  );
});
test('requirement changes invalidate the integrated decision and saved completion', (t) => {
  const work = fixture(t);
  submitted(work);
  finishWorkflow(work.root, work.parent.meta.id, {
    no_lesson_reason:
      'This repeats the existing procedure and adds no qualified reusable knowledge.',
  });
  updateRecord(work.root, work.requirement.meta.id, {
    data: { acceptance_criteria: ['The value must now be two.'] },
  });
  assert.equal(workflowStatus(work.root, work.parent.meta.id).phase, 'reassessment-required');
  assert.throws(() => finishWorkflow(work.root, work.parent.meta.id, {}), /Requirement changed/);
});
test('replacement plans preserve reports and published lessons without imposing them on the new increment', (t) => {
  const work = fixture(t);
  submitted(work);
  const lesson = candidate(work);
  const github = githubFixture();
  const first = finishWorkflow(
    work.root,
    work.parent.meta.id,
    { knowledge_ids: [lesson.meta.id] },
    github.publish,
  );
  updateRecord(work.root, work.requirement.meta.id, {
    data: { acceptance_criteria: ['The named value export remains one after reassessment.'] },
  });
  discussions(work);
  const replacement = createRecord(work.root, {
    type: 'task',
    title: 'Reassess the documented export',
    owner: 'developer',
    links: [{ type: 'satisfies', target: work.requirement.meta.id }],
    data: {
      acceptance_criteria: ['Verify and document the retained named export.'],
      allowed_paths: ['src', 'docs'],
      documentation_paths: ['docs/value.md'],
    },
  });
  decideWorkflow(work.root, work.parent.meta.id, {
    summary: 'Reassess the retained contract on a fresh baseline.',
    rationale:
      'The revised requirement needs a new checked increment while history remains intact.',
    task_ids: [replacement.meta.id],
  });
  assert.equal(getRecord(work.root, work.task.meta.id).meta.status, 'superseded');
  assert.equal(getRecord(work.root, work.parent.meta.id).meta.data.knowledge_ids.length, 0);
  assert.equal(
    workflowStatus(work.root, work.parent.meta.id).history[0].final_report_id,
    first.final_report_id,
  );
  const reassessment = { ...work, task: replacement };
  submitted(reassessment);
  const second = finishWorkflow(work.root, work.parent.meta.id, {
    no_lesson_reason:
      'The reassessment confirms existing knowledge and adds no distinct reusable engineering insight.',
  });
  assert.equal(second.phase, 'completed');
  assert.notEqual(second.final_report_id, first.final_report_id);
  assert.ok(getRecord(work.root, first.final_report_id).body.includes(lesson.meta.id));
  assert.equal(
    github.calls.filter((c) => c.method === 'POST' && c.endpoint.endsWith('/pulls')).length,
    1,
  );
});
test('automatic draft PR uses reviewed generalized material and retry creates no duplicate PR', (t) => {
  const work = fixture(t);
  submitted(work);
  const lesson = candidate(work);
  const github = githubFixture();
  const result = finishWorkflow(
    work.root,
    work.parent.meta.id,
    { knowledge_ids: [lesson.meta.id] },
    github.publish,
  );
  assert.equal(result.phase, 'completed');
  assert.equal(
    result.publications[0].upstream_pr,
    'https://github.com/VuThach3001/VeryThinker/pull/123',
  );
  const sent = JSON.stringify(github.calls);
  assert.ok(!sent.includes(work.parent.meta.id));
  assert.ok(!sent.includes(work.task.meta.id));
  assert.ok(github.calls.some((c) => c.endpoint.endsWith('/pulls') && c.body.draft === true));
  finishWorkflow(work.root, work.parent.meta.id, {}, github.publish);
  assert.equal(
    github.calls.filter((c) => c.method === 'POST' && c.endpoint.endsWith('/pulls')).length,
    1,
  );
  assert.ok(!github.calls.some((c) => /merge/.test(c.endpoint)));
});
test('unreviewed knowledge cannot be published and credentials failure remains a specific recoverable blocker', (t) => {
  const work = fixture(t);
  submitted(work);
  const lesson = candidate(work, false);
  assert.throws(
    () =>
      finishWorkflow(work.root, work.parent.meta.id, { knowledge_ids: [lesson.meta.id] }, () => {
        throw new Error('Should not publish.');
      }),
    /generalization review/,
  );
  reviewRecord(work.root, lesson.meta.id, 'reviewer', 'pass', [], 'generalization-fixture', true);
  const blocked = finishWorkflow(
    work.root,
    work.parent.meta.id,
    { knowledge_ids: [lesson.meta.id] },
    () => {
      throw new Error('GitHub credentials unavailable.');
    },
  );
  assert.equal(blocked.phase, 'completed-with-blockers');
  assert.equal(getRecord(work.root, work.task.meta.id).meta.status, 'accepted');
  assert.deepEqual(blocked.publication_blockers, ['GitHub credentials unavailable.']);
  const github = githubFixture();
  assert.equal(
    finishWorkflow(work.root, work.parent.meta.id, {}, github.publish).phase,
    'completed',
  );
});
test('missing upstream is recorded and policy opt-out keeps prepared knowledge local', (t) => {
  const work = fixture(t);
  submitted(work);
  const lesson = candidate(work);
  const policy = readAutomationPolicy(work.root);
  const policyPath = join(work.root, '.verythinker/automation.json');
  writeFileSync(policyPath, JSON.stringify({ ...policy, upstream: null }));
  const blocked = finishWorkflow(
    work.root,
    work.parent.meta.id,
    { knowledge_ids: [lesson.meta.id] },
    () => {
      throw new Error('Should not publish.');
    },
  );
  assert.equal(blocked.phase, 'completed-with-blockers');
  writeFileSync(policyPath, JSON.stringify({ ...policy, automatic_pr: false }));
  const local = finishWorkflow(work.root, work.parent.meta.id, {}, () => {
    throw new Error('Should not publish.');
  });
  assert.equal(local.phase, 'completed');
  assert.equal(local.publications[0].status, 'prepared-locally');
  assert.ok(
    readFileSync(
      join(work.root, '.verythinker/contributions', lesson.meta.id.toLowerCase(), 'lesson.md'),
      'utf8',
    ).includes('executable import assertion'),
  );
});

test('intermediate requirement changes invalidate allocation decisions and checked evidence', (t) => {
  const work = fixture(t, false);
  const middle = createRecord(work.root, {
    type: 'requirement',
    title: 'Allocate the numeric contract',
    links: [{ type: 'derives-from', target: work.requirement.meta.id }],
    data: { acceptance_criteria: ['Allocate integer one to the exported module.'] },
  });
  const leaf = createRecord(work.root, {
    type: 'requirement',
    title: 'Implement allocated export',
    links: [{ type: 'derives-from', target: middle.meta.id }],
    data: { acceptance_criteria: ['The named value export is integer one.'] },
  });
  updateRecord(work.root, work.task.meta.id, {
    links: [{ type: 'satisfies', target: leaf.meta.id }],
  });
  updateRecord(work.root, work.check.meta.id, {
    links: [{ type: 'verifies', target: leaf.meta.id }],
  });
  discussions(work);
  decideWorkflow(work.root, work.parent.meta.id, {
    summary: 'Use the allocated module contract.',
    rationale:
      'The system requirement is refined through an intermediate allocation and a measurable module contract.',
    task_ids: [work.task.meta.id],
  });
  submitted(work);
  const result = finishWorkflow(work.root, work.parent.meta.id, {
    no_lesson_reason:
      'The allocation reproduces established behavior and adds no distinct reusable engineering insight.',
  });
  assert.equal(result.phase, 'completed');
  updateRecord(work.root, middle.meta.id, {
    data: { acceptance_criteria: ['The module must now export integer two.'] },
  });
  const stale = workflowStatus(work.root, work.parent.meta.id);
  assert.equal(stale.phase, 'reassessment-required');
  assert.ok(stale.decision_findings.some((finding) => finding.includes(middle.meta.id)));
  assert.equal(stale.tasks[0].accepted.ok, false);
  assert.throws(() => finishWorkflow(work.root, work.parent.meta.id, {}), /Requirement changed/);
});

test('slow publication cannot overwrite changed workflow or evidence with completion', (t) => {
  for (const change of ['workflow', 'documentation']) {
    const work = fixture(t);
    submitted(work);
    const lesson = candidate(work);
    assert.throws(
      () =>
        finishWorkflow(work.root, work.parent.meta.id, { knowledge_ids: [lesson.meta.id] }, () => {
          if (change === 'workflow')
            updateRecord(work.root, work.parent.meta.id, {
              data: { phase: 'reassessment-required' },
            });
          else
            writeFileSync(
              join(work.root, 'docs/value.md'),
              '# Changed output\nDocumentation changed during publication.\n',
            );
          return {
            status: 'draft-pr-created',
            upstream_pr: 'https://github.com/example/library/pull/123',
          };
        }),
      /Workflow changed during closure|Documentation files changed/,
    );
    assert.notEqual(getRecord(work.root, work.parent.meta.id).meta.data.phase, 'completed');
    assert.equal(getRecord(work.root, work.parent.meta.id).meta.data.final_report_id, null);
  }
});

test('corrected candidates replace old publication obligations only with a preserved disposition', (t) => {
  const work = fixture(t);
  submitted(work);
  const first = candidate(work);
  const github = githubFixture();
  finishWorkflow(
    work.root,
    work.parent.meta.id,
    { knowledge_ids: [first.meta.id] },
    github.publish,
  );
  updateRecord(work.root, first.meta.id, {
    data: {
      generalization:
        'Corrected generalization requires an updated independently reviewed publication candidate.',
    },
  });
  reviewRecord(
    work.root,
    first.meta.id,
    'reviewer',
    'pass',
    [],
    'corrected-generalization-fixture',
    true,
  );
  const replacement = candidate(work);
  updateRecord(work.root, replacement.meta.id, {
    data: {
      generalization:
        'A focused import assertion establishes only the recorded observable export contract, with no broader reliability conclusion.',
    },
  });
  reviewRecord(
    work.root,
    replacement.meta.id,
    'reviewer',
    'pass',
    [],
    'replacement-generalization-fixture',
    true,
  );
  const blocked = finishWorkflow(
    work.root,
    work.parent.meta.id,
    { knowledge_ids: [replacement.meta.id] },
    github.publish,
  );
  assert.equal(blocked.phase, 'completed-with-blockers');
  const repaired = finishWorkflow(
    work.root,
    work.parent.meta.id,
    {
      knowledge_ids: [replacement.meta.id],
      retired_candidates: [
        {
          knowledge_id: first.meta.id,
          reason:
            'Replaced the obsolete publication candidate with a corrected independently reviewed conclusion.',
        },
      ],
    },
    github.publish,
  );
  assert.equal(repaired.phase, 'completed');
  assert.deepEqual(getRecord(work.root, work.parent.meta.id).meta.data.knowledge_ids, [
    replacement.meta.id,
  ]);
  assert.equal(repaired.publication_retirements[0].knowledge_id, first.meta.id);
  assert.ok(repaired.publication_retirements[0].previous_publications.length);
  assert.ok(
    repaired.publication_retirements[0].previous_publications.some(
      (publication) => publication.upstream_pr,
    ),
  );
  assert.equal(
    finishWorkflow(work.root, work.parent.meta.id, {}, github.publish).phase,
    'completed',
  );
});
