import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assessConformance,
  pinnedVersion,
  requiredChecks,
  runConformance,
} from '../scripts/codegraph-check.mjs';

test('CodeGraph support requires every pinned conformance check to pass', () => {
  assert.equal(pinnedVersion, '1.6.2');
  const checks = requiredChecks.map((id) => ({ id, status: 'passed' }));
  assert.equal(assessConformance(checks), 'supported-for-fixture');
  assert.equal(assessConformance(checks.slice(1)), 'unverified');
  assert.equal(
    assessConformance(
      checks.map((check) => (check.id === 'watch-modify' ? { ...check, status: 'failed' } : check)),
    ),
    'unverified',
  );
  assert.equal(assessConformance([]), 'unverified');
});

test('missing optional package produces an honest disabled report without downloads', async () => {
  const report = await runConformance();
  assert.equal(report.status, 'unverified');
  assert.equal(report.enabled, false);
  assert.equal(report.commands.length, 0);
  assert.match(report.limitations.join('\n'), /not installed/);
  assert.ok(report.checks.every((check) => check.status === 'unverified'));
});
