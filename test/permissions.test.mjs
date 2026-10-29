import test from 'node:test';
import assert from 'node:assert/strict';
import { Scheduler } from '../src/scheduler.mjs';

test('approval only reaches its live run once; rejection is explicit and closed runs cannot approve', () => {
  const sent = [], events = [];
  const run = { id: 'run', taskId: 'task', state: 'running', handedOff: false };
  const scheduler = Object.create(Scheduler.prototype);
  scheduler.children = new Map([['run', {}]]);
  scheduler.permissions = new Map();
  const task = { autoEnabled: true, pauseRequested: false };
  scheduler.store = { getDispatch: () => run, getTask: () => task, event: (...args) => events.push(args), failDispatch: () => {} };
  const add = () => scheduler.permissions.set('request', { id: 'request', runId: 'run', createdAt: new Date().toISOString(), tool: 'Bash', child: { stdin: { write: data => sent.push(JSON.parse(data)) } } });
  add();
  assert.throws(() => scheduler.decidePermission('request', 'true'), /布尔/);
  scheduler.decidePermission('request', false);
  assert.deepEqual(sent, [{ id: 'request', allow: false }]);
  assert.throws(() => scheduler.decidePermission('request', true), /失效/);
  add(); run.handedOff = true;
  assert.throws(() => scheduler.decidePermission('request', true), /失效/);
  assert.equal(sent.length, 1);
  assert.equal(events.length, 1);
  run.handedOff = false; add(); task.pauseRequested = true;
  assert.throws(() => scheduler.decidePermission('request', true), /暂停/);
  task.pauseRequested = false; add();
  scheduler.permissions.get('request').createdAt = new Date(Date.now() - 301000).toISOString();
  assert.throws(() => scheduler.decidePermission('request', true), /超时/);
  assert.equal(sent.length, 1);
});

test('missing selected model is rejected before any client is launched', () => {
  const scheduler = Object.create(Scheduler.prototype);
  assert.throws(() => scheduler.start({ actor: 'workbuddy', requestedModel: { model: null } }), /未选择 CodeBuddy 模型/);
});
