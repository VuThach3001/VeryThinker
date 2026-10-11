import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { atomicWrite } from '../dist/storage.js';
test(
  'Windows atomic replacement tolerates a transient reader and preserves the old file on persistent refusal',
  { skip: process.platform !== 'win32' },
  async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'verythinker-atomic-'));
    const target = join(root, 'record.json');
    const script = join(root, 'reader.ps1');
    writeFileSync(
      script,
      `param([string]$TargetPath, [int]$HoldMilliseconds)
$readerStream = [System.IO.File]::Open($TargetPath, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)
[Console]::WriteLine('reader-open')
try { [System.Threading.Thread]::Sleep($HoldMilliseconds) } finally { $readerStream.Dispose() }
`,
    );
    const children = [];
    t.after(async () => {
      for (const child of children)
        if (child.exitCode === null) {
          child.kill();
          await once(child, 'exit');
        }
      assert.equal(dirname(resolve(root)), resolve(tmpdir()));
      rmSync(root, { recursive: true, force: true });
    });
    const hold = async (duration) => {
      const child = spawn(
        'powershell.exe',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, target, String(duration)],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      children.push(child);
      await new Promise((resolveReady, reject) => {
        child.once('error', reject);
        child.once('exit', () =>
          reject(new Error('Reader exited before acquiring the test file.')),
        );
        child.stdout.on('data', (chunk) => {
          if (String(chunk).includes('reader-open')) resolveReady();
        });
      });
      return child;
    };
    writeFileSync(target, 'old record\n');
    const transient = await hold(250);
    atomicWrite(target, 'new record\n');
    assert.equal(readFileSync(target, 'utf8'), 'new record\n');
    if (transient.exitCode === null) await once(transient, 'exit');
    await hold(2500);
    assert.throws(() => atomicWrite(target, 'forbidden replacement\n'), /EPERM|EACCES|EBUSY/);
    assert.equal(readFileSync(target, 'utf8'), 'new record\n');
  },
);
