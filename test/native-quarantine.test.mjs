import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { initialize, createRecord } from '../dist/storage.js';
import { nativeScopeConflict } from '../dist/native.js';

test('uncertain unrelated owners allow separate planning but quarantine unknown or overlapping execution', t => {
  const root=mkdtempSync(join(tmpdir(),'vt-quarantine-'));
  t.after(()=>{assert.ok(relative(tmpdir(),resolve(root)).startsWith('vt-quarantine-'));rmSync(root,{recursive:true,force:true});});
  initialize(root);
  const prior={workflow_id:'OLD',task_id:null};
  const input={role:'manager',workflow_id:'NEW',prompt:'Independent planning only.'};
  assert.equal(nativeScopeConflict(root,input,prior),false);
  assert.equal(nativeScopeConflict(root,{...input,workflow_id:'OLD'},prior),true);
  assert.equal(nativeScopeConflict(root,{...input,role:'developer'},prior),true);
  const task=paths=>createRecord(root,{type:'task',title:'Bounded source change',owner:'developer',data:{allowed_paths:paths}}).meta.id;
  const old=task(['app/first.mjs']), independent=task(['docs/second.md']), overlap=task(['app']);
  assert.equal(nativeScopeConflict(root,{...input,role:'developer',task_id:independent},{...prior,task_id:old}),true);
  assert.equal(nativeScopeConflict(root,{...input,role:'developer',task_id:overlap},{...prior,task_id:old}),true);
  assert.equal(nativeScopeConflict(root,{...input,role:'developer',task_id:'MISSING'},{...prior,task_id:old}),true);
  assert.equal(nativeScopeConflict(root,{...input,role:'developer',task_id:independent},prior),true);
});
