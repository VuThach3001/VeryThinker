import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { resolveExecutableCommand } from '../dist/execution.js';

test('Windows npm resolution preserves argv and never evaluates shell syntax', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'vt-npm arguments-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cli = join(root, 'npm-cli.js');
  writeFileSync(cli, 'process.stdout.write(JSON.stringify(process.argv.slice(2)));\n');
  const sentinel = join(root, 'must-not-exist');
  const args = [
    'run',
    'check',
    '--',
    'two words',
    '"quoted"',
    `$(${sentinel})`,
    `& echo unsafe > ${sentinel}`,
    '%PATH%',
  ];
  const launch = resolveExecutableCommand(['npm', ...args], {
    platform: 'win32',
    env: { npm_execpath: cli, PATH: '' },
  });
  assert.equal(launch.resolved_via, 'node-npm-cli');
  const actual = spawnSync(launch.executable, launch.args, { encoding: 'utf8', shell: false });
  assert.equal(actual.status, 0, actual.stderr);
  assert.deepEqual(JSON.parse(actual.stdout), args);
  assert.equal(existsSync(sentinel), false);
});

test('explicit npm path resolves its own installation rather than another environment CLI', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'vt-npm explicit-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, 'node_modules', 'npm', 'bin');
  mkdirSync(bin, { recursive: true });
  const cli = join(bin, 'npm-cli.js');
  writeFileSync(cli, 'process.exit(0);\n');
  const result = resolveExecutableCommand([join(root, 'npm.cmd'), '--version'], {
    platform: 'win32',
    env: { npm_execpath: join(root, 'different', 'npm-cli.js') },
  });
  assert.deepEqual(result.args, [cli, '--version']);
});

test('missing Windows npm CLI fails precisely and other executables retain their arguments', () => {
  assert.throws(
    () =>
      resolveExecutableCommand(['npm', 'test'], {
        platform: 'win32',
        execPath: join(tmpdir(), 'nonexistent-vt-node', 'node.exe'),
        env: { PATH: '' },
      }),
    /installed npm-cli.js/,
  );
  for (const platform of ['linux', 'darwin', 'win32']) {
    assert.deepEqual(resolveExecutableCommand(['compiler', 'a b', '&literal'], { platform }), {
      executable: 'compiler',
      args: ['a b', '&literal'],
      resolved_via: 'direct',
    });
  }
  assert.deepEqual(resolveExecutableCommand(['npm', 'test'], { platform: 'linux' }).args, ['test']);
});
