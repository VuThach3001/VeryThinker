import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createRecord,
  ensureRoutingPolicy,
  hasCurrentReview,
  initialize,
  reviewRecord,
  reviewStatus,
  updateRecord,
} from '../dist/index.js';

function project(t) {
  const root = mkdtempSync(join(tmpdir(), 'verythinker-review-diagnostics-'));
  initialize(root, { project_id: 'REVIEW-DIAGNOSTICS', profile: 'software' });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function requirement(root) {
  return createRecord(root, {
    type: 'requirement',
    title: 'Review scope requirement',
    owner: 'requirements',
    data: { acceptance_criteria: ['The review scope is recorded.'] },
  });
}

test('review diagnostics identify a current passing review and its input fingerprints', (t) => {
  const root = project(t);
  const target = requirement(root);
  const review = reviewRecord(root, target.meta.id, 'independent-reviewer', 'pass', [], 'review-1');

  const status = reviewStatus(root, target.meta.id);
  assert.equal(status.selected_id, review.meta.id);
  assert.deepEqual(status.candidate_ids, [review.meta.id]);
  assert.equal(status.stored_target_fingerprint, status.current_target_fingerprint);
  assert.equal(status.stored_baseline_hash, status.current_baseline_hash);
  assert.equal(status.stored_baseline_version, 2);
  assert.equal(status.current_baseline_version, 2);
  assert.equal(status.decision, 'pass');
  assert.deepEqual(status.findings, []);
  assert.deepEqual(status.native_routing_reasons, []);
  assert.equal(status.current, true);
  assert.equal(status.disposition, 'current');
  assert.equal(hasCurrentReview(root, target.meta.id), status.current);
});

test('review diagnostics report a changed target as stale', (t) => {
  const root = project(t);
  const target = requirement(root);
  reviewRecord(root, target.meta.id, 'independent-reviewer', 'pass', [], 'review-target');
  updateRecord(root, target.meta.id, { data: { acceptance_criteria: ['Updated scope.'] } });

  const status = reviewStatus(root, target.meta.id);
  assert.equal(status.disposition, 'stale');
  assert.equal(status.current, false);
  assert.notEqual(status.stored_target_fingerprint, status.current_target_fingerprint);
  assert.ok(status.reasons.some((reason) => reason.code === 'target-changed'));
});

test('review diagnostics report a changed related baseline as stale', (t) => {
  const root = project(t);
  const requirementRecord = requirement(root);
  const design = createRecord(root, {
    type: 'design',
    title: 'Design under review',
    owner: 'architect',
    links: [{ type: 'satisfies', target: requirementRecord.meta.id }],
    data: { interfaces: ['First interface.'] },
  });
  reviewRecord(root, design.meta.id, 'independent-reviewer', 'pass', [], 'review-baseline');
  updateRecord(root, requirementRecord.meta.id, {
    data: { acceptance_criteria: ['Changed related scope.'] },
  });

  const status = reviewStatus(root, design.meta.id);
  assert.equal(status.disposition, 'stale');
  assert.equal(status.current, false);
  assert.equal(status.stored_target_fingerprint, status.current_target_fingerprint);
  assert.notEqual(status.stored_baseline_hash, status.current_baseline_hash);
  assert.ok(status.reasons.some((reason) => reason.code === 'baseline-changed'));
});

test('the latest failed review overrides an earlier passing review', async (t) => {
  const root = project(t);
  const target = requirement(root);
  const passed = reviewRecord(
    root,
    target.meta.id,
    'independent-reviewer',
    'pass',
    [],
    'review-pass',
  );
  await new Promise((resolve) => setTimeout(resolve, 5));
  const failed = reviewRecord(
    root,
    target.meta.id,
    'independent-reviewer',
    'fail',
    ['The rationale is incomplete.'],
    'review-fail',
  );

  const status = reviewStatus(root, target.meta.id);
  assert.deepEqual(status.candidate_ids, [failed.meta.id, passed.meta.id]);
  assert.equal(status.selected_id, failed.meta.id);
  assert.equal(status.decision, 'fail');
  assert.deepEqual(status.findings, ['The rationale is incomplete.']);
  assert.ok(status.reasons.some((reason) => reason.code === 'latest-review-failed'));
  assert.equal(status.disposition, 'failed');
  assert.equal(status.current, false);
  assert.equal(hasCurrentReview(root, target.meta.id), false);
});

test('review diagnostics explain a target with no review candidates', (t) => {
  const root = project(t);
  const target = requirement(root);

  const status = reviewStatus(root, target.meta.id);
  assert.deepEqual(status.candidate_ids, []);
  assert.equal(status.selected_id, null);
  assert.equal(status.disposition, 'missing');
  assert.deepEqual(status.reasons, [
    { code: 'latest-review-missing', message: 'No review is recorded for this target.' },
  ]);
  assert.equal(status.current, false);
  assert.equal(hasCurrentReview(root, target.meta.id), false);
});

test('review diagnostics report invalid strict native provenance without exposing receipt details', (t) => {
  const root = project(t);
  const target = requirement(root);
  const review = reviewRecord(
    root,
    target.meta.id,
    'independent-reviewer',
    'pass',
    [],
    'receipt-not-found',
  );
  ensureRoutingPolicy(root);
  updateRecord(root, review.meta.id, { data: { routing_required: true } });

  const status = reviewStatus(root, target.meta.id);
  assert.equal(status.disposition, 'unconfirmed');
  assert.equal(status.current, false);
  assert.deepEqual(status.native_routing_reasons, [
    'The native reviewer receipt could not be verified.',
  ]);
  assert.ok(status.reasons.some((reason) => reason.code === 'receipt-invalid'));
  assert.ok(!status.native_routing_reasons.join(' ').includes('receipt-not-found'));
});

test('review diagnostics identify reviewer independence and missing native receipt failures', (t) => {
  const root = project(t);
  const target = requirement(root);
  const review = reviewRecord(
    root,
    target.meta.id,
    'independent-reviewer',
    'pass',
    [],
    'review-owner',
  );
  updateRecord(root, review.meta.id, { owner: target.meta.owner });
  const nonIndependent = reviewStatus(root, target.meta.id);
  assert.ok(nonIndependent.reasons.some((reason) => reason.code === 'reviewer-not-independent'));
  ensureRoutingPolicy(root);
  updateRecord(root, review.meta.id, {
    owner: 'independent-reviewer',
    data: { invocation_id: '', routing_required: true },
  });

  const status = reviewStatus(root, target.meta.id);
  assert.equal(status.disposition, 'unconfirmed');
  assert.ok(status.reasons.some((reason) => reason.code === 'receipt-missing'));
  assert.ok(
    status.native_routing_reasons.includes('No confirmed native reviewer receipt is available.'),
  );
});
