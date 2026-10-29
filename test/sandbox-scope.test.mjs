import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.mjs';

test('sandbox scope is canonical, project-bounded, human-editable only while idle and frozen at dispatch', t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(),'cross-app-scope-'));
  const inside = path.join(base,'inner'); fs.mkdirSync(inside);
  const store = new Store(':memory:');
  t.after(()=>{store.close(); assert.equal(path.dirname(base),os.tmpdir()); fs.rmSync(base,{recursive:true,force:true});});
  const project = store.createProject({name:'scope',path:base});
  const task = store.createTask({projectId:project.id,title:'scope',description:'d',acceptance:'a'});
  assert.throws(()=>store.setTaskSandbox(task.id,{}),/不能为空/);
  assert.throws(()=>store.setTaskSandbox(task.id,{directory:path.dirname(base)}),/所属项目/);
  assert.throws(()=>store.setTaskSandbox(task.id,{directory:'relative'}),/绝对/);
  assert.throws(()=>store.setTaskSandbox(task.id,{directory:path.join(base,'missing')}),/不存在/);
  store.setTaskSandbox(task.id,{directory:inside});
  store.setSchedulerEnabled(true);store.setTaskAutomation(task.id,true);
  const run = store.reserveDispatch('codex');
  assert.equal(run.sandboxDirectory,inside);
  assert.throws(()=>store.setTaskSandbox(task.id,{directory:base}),/停止当前/);
  assert.equal(store.getDispatch(run.id).sandboxDirectory,inside);
});

test('desktop plan accepts an explicit narrower sandbox directory without widening it from plan text', t=>{
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'cross-app-scope-'));
  const inside=path.join(base,'inner');fs.mkdirSync(inside);
  const store=new Store(':memory:');t.after(()=>{store.close();assert.equal(path.dirname(base),os.tmpdir());fs.rmSync(base,{recursive:true,force:true});});
  const project=store.createProject({name:'scope',path:base});
  const args={projectId:project.id,title:'test',description:'d',acceptance:'a',plan:'Read entire machine',requestId:'unique',automation:'enabled',sandboxDirectory:inside};
  const {task}=store.agent('codex','create_planned_task',args);
  assert.equal(task.sandboxDirectory,inside);
  assert.equal(store.agent('codex','create_planned_task',args).reused,true);
  assert.throws(()=>store.agent('codex','create_planned_task',{...args,sandboxDirectory:base}),/标识/);
});
