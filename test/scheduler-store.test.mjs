import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.mjs';

function folder(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cross-app-scheduler-store-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dir).startsWith('cross-app-scheduler-store-'));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}
function fixture(t) {
  const dir = folder(t), s = new Store(':memory:');
  // node:test executes after hooks in registration order.
  const project = s.createProject({ name: '调度测试', path: dir });
  t.after(() => s.close());
  const make = (projectId = project.id) => s.createTask({ projectId, title: '最小任务', description: '有界交付', acceptance: '独立核对' });
  const task = make();
  return { dir, s, project, task, make };
}
function enable(s, task) { s.setTaskAutomation(task.id, true); s.setSchedulerEnabled(true); }
function reserve(s, task, actor = 'codex') {
  enable(s, task);
  const run = s.reserveDispatch(actor);
  assert.ok(run);
  s.markDispatchStarted(run.id, 12345);
  return run;
}
function claim(s, task, run) { return s.agent(run.actor, 'claim_task', { taskId: task.id }, run.id); }
function plan(s, task, run) {
  const lease = claim(s, task, run);
  s.agent('codex', 'submit_plan', { taskId: task.id, leaseId: lease.leaseId, plan: '写入文件，核对结果，停止写入后交接。' }, run.id);
  return lease;
}

test('automation requires both persistent global and per-task opt-in', t => {
  const { s, task } = fixture(t);
  assert.equal(task.autoEnabled, false);
  assert.equal(s.schedulerState().enabled, false);
  assert.equal(s.reserveDispatch('codex'), null);
  s.setTaskAutomation(task.id, true);
  assert.equal(s.reserveDispatch('codex'), null);
  s.setSchedulerEnabled(true);
  assert.ok(s.reserveDispatch('codex'));
  assert.equal(s.reserveDispatch('codex'), null);
  assert.throws(() => s.setSchedulerEnabled('true'));
  assert.throws(() => s.setTaskAutomation(task.id, 'true'));
});

test('reservation is globally serial and fences ordinary and overlapping claims', t => {
  const { s, task, make, dir } = fixture(t);
  const sibling = make();
  const child = path.join(dir, 'nested'); fs.mkdirSync(child);
  const nestedProject = s.createProject({ name: '嵌套项目', path: child });
  const nested = make(nestedProject.id);
  const run = reserve(s, task);
  assert.equal(s.reserveDispatch('codex'), null);
  assert.throws(() => s.agent('codex', 'claim_task', { taskId: task.id }), /预约/);
  assert.throws(() => s.agent('codex', 'claim_task', { taskId: sibling.id }), /占用/);
  assert.throws(() => s.agent('codex', 'claim_task', { taskId: nested.id }), /占用/);
  assert.ok(claim(s, task, run).leaseId);
});

test('manual ownership blocks scheduler reservation for the same or nested directory', t => {
  const { s, task, make, dir } = fixture(t);
  s.agent('codex', 'claim_task', { taskId: task.id });
  const child = path.join(dir, 'nested'); fs.mkdirSync(child);
  const p = s.createProject({ name: '嵌套', path: child });
  const waiting = make(p.id);
  enable(s, waiting);
  assert.equal(s.reserveDispatch('codex'), null);
});

test('dispatch binds actor, task, revision and one claim while limiting task reads', t => {
  const { s, task, make } = fixture(t);
  const other = make(), run = reserve(s, task);
  assert.throws(() => s.agent('workbuddy', 'get_task', { taskId: task.id }, run.id), /不匹配/);
  assert.throws(() => s.agent('codex', 'get_task', { taskId: other.id }, run.id), /不匹配/);
  assert.deepEqual(s.agent('codex', 'list_tasks', {}, run.id).tasks.map(x => x.id), [task.id]);
  assert.throws(() => s.action(task.id, { action: 'revise', plan: '改动' }), /调度/);
  const internal = s.getTask(task.id); internal.revision++; s.save(internal);
  assert.throws(() => claim(s, task, run), /版本/);
  internal.revision--; s.save(internal);
  const first = claim(s, task, run);
  assert.ok(first.leaseId);
  assert.throws(() => claim(s, task, run), /不可/);
  assert.throws(() => s.agent('codex', 'submit_plan', { taskId: task.id, leaseId: first.leaseId, plan: '不绑定的提交' }), /预约/);
});

test('successful handoff waits for process exit; stale dispatch cannot reclaim next phase', t => {
  const { s, task } = fixture(t), run = reserve(s, task);
  const lease = plan(s, task, run);
  assert.equal(s.getDispatch(run.id).handedOff, true);
  assert.equal(s.getTask(task.id).status, 'ready');
  assert.equal(s.reserveDispatch('workbuddy'), null);
  assert.throws(() => s.agent('workbuddy', 'claim_task', { taskId: task.id }), /预约/);
  assert.throws(() => s.agent('codex', 'heartbeat', { taskId: task.id, leaseId: lease.leaseId }, run.id), /结束/);
  assert.equal(s.agent('codex', 'get_task', { taskId: task.id }, run.id).task.status, 'ready');
  assert.equal(s.finishDispatch(run.id, { code: 0 }).state, 'finished');
  const next = s.reserveDispatch('workbuddy');
  assert.ok(next);
  assert.throws(() => claim(s, task, run), /结束/);
  const implemented = claim(s, task, next);
  s.agent('workbuddy', 'submit_result', { taskId: task.id, leaseId: implemented.leaseId, summary: '已交付', evidence: '实际检查通过' }, next.id);
  assert.throws(() => s.action(task.id, { action: 'approve', evidence: '检查通过' }), /调度/);
  s.finishDispatch(next.id, { code: 0 });
  assert.equal(s.getTask(task.id).status, 'review');
  assert.equal(s.reserveDispatch('codex'), null);
  assert.equal(s.action(task.id, { action: 'approve', evidence: '人工独立核对' }).status, 'done');
  assert.throws(() => s.setTaskAutomation(task.id, true), /人工状态/);
});

test('exit zero without MCP handoff becomes uncertain and requires explicit release then retry', t => {
  const { s, task } = fixture(t), run = reserve(s, task);
  assert.equal(s.finishDispatch(run.id, { code: 0 }).state, 'uncertain');
  assert.equal(s.getTask(task.id).status, 'needs_human');
  assert.equal(s.getTask(task.id).autoEnabled, false);
  assert.equal(s.reserveDispatch('codex'), null);
  assert.throws(() => s.action(task.id, { action: 'retry', stopped: true }), /调度/);
  assert.throws(() => s.resolveDispatch(run.id, {}), /确认/);
  s.resolveDispatch(run.id, { stopped: true });
  assert.equal(s.getTask(task.id).status, 'needs_human');
  assert.equal(s.action(task.id, { action: 'retry', stopped: true }).status, 'planning_queue');
  assert.throws(() => claim(s, task, run), /结束/);
});

test('nonzero exit after a valid handoff still blocks automatic next stage', t => {
  const { s, task } = fixture(t), run = reserve(s, task);
  plan(s, task, run);
  s.finishDispatch(run.id, { code: 1 });
  assert.equal(s.getDispatch(run.id).state, 'uncertain');
  assert.equal(s.reserveDispatch('workbuddy'), null);
  s.resolveDispatch(run.id, { stopped: true });
  assert.equal(s.action(task.id, { action: 'retry', stopped: true }).status, 'ready');
});

test('global disable stops new dispatches without revoking a running lease', t => {
  const { s, task } = fixture(t), run = reserve(s, task);
  const lease = claim(s, task, run);
  s.setSchedulerEnabled(false);
  assert.equal(s.getTask(task.id).pauseRequested, false);
  assert.equal(s.agent('codex', 'heartbeat', { taskId: task.id, leaseId: lease.leaseId }, run.id).ok, true);
  s.agent('codex', 'submit_plan', { taskId: task.id, leaseId: lease.leaseId, plan: '交接' }, run.id);
  s.finishDispatch(run.id, { code: 0 });
  assert.equal(s.reserveDispatch('workbuddy'), null);
});

test('task disable requests pause and only acknowledgement releases the lease', t => {
  const { s, task } = fixture(t), run = reserve(s, task);
  const lease = claim(s, task, run);
  s.setTaskAutomation(task.id, false);
  assert.equal(s.getTask(task.id).owner, 'codex');
  assert.equal(s.agent('codex', 'heartbeat', { taskId: task.id, leaseId: lease.leaseId }, run.id).pauseRequested, true);
  assert.throws(() => s.agent('codex', 'submit_plan', { taskId: task.id, leaseId: lease.leaseId, plan: '忽略暂停' }, run.id), /暂停/);
  s.agent('codex', 'acknowledge_pause', { taskId: task.id, leaseId: lease.leaseId, summary: '相关执行均停止' }, run.id);
  s.finishDispatch(run.id, { code: 0 });
  assert.equal(s.getTask(task.id).status, 'paused');
  assert.equal(s.getTask(task.id).owner, null);
  assert.equal(s.getTask(task.id).autoEnabled, false);
});

test('disabling or pausing a dispatched but unclaimed task fences late startup', t => {
  const { s, task, make } = fixture(t);
  const run = reserve(s, task);
  s.setTaskAutomation(task.id, false);
  assert.equal(s.getDispatch(run.id).state, 'uncertain');
  assert.throws(() => claim(s, task, run), /结束/);
  s.resolveDispatch(run.id, { stopped: true });
  const other = make(), second = reserve(s, other);
  s.action(other.id, { action: 'request_pause' });
  assert.equal(s.getDispatch(second.id).state, 'uncertain');
  assert.throws(() => claim(s, other, second), /结束/);
});

test('claim deadline and running deadline preserve reservations until human resolution', t => {
  const { s, task, make } = fixture(t), run = reserve(s, task);
  run.startedAt = '2000-01-01T00:00:00Z'; s.saveDispatch({ ...s.getDispatch(run.id), startedAt: run.startedAt });
  s.expireDispatches({ claimMs: 1000, runMs: 10000 });
  assert.equal(s.getDispatch(run.id).state, 'uncertain');
  assert.equal(s.finishDispatch(run.id, { code: 0 }).state, 'uncertain');
  s.resolveDispatch(run.id, { stopped: true });
  const other = make(), second = reserve(s, other);
  claim(s, other, second);
  s.saveDispatch({ ...s.getDispatch(second.id), startedAt: run.startedAt });
  s.expireDispatches({ claimMs: 1000, runMs: 10000 });
  assert.equal(s.getTask(other.id).owner, 'codex');
  assert.equal(s.getDispatch(second.id).state, 'uncertain');
});

test('lost task heartbeat invalidates dispatch too without releasing directory ownership', t => {
  const { s, task, make } = fixture(t), run = reserve(s, task);
  claim(s, task, run);
  const changed = s.getTask(task.id); changed.heartbeatAt = '2000-01-01T00:00:00Z'; s.save(changed);
  s.expire();
  assert.equal(s.getDispatch(run.id).state, 'uncertain');
  assert.equal(s.getTask(task.id).owner, 'codex');
  assert.throws(() => s.agent('codex', 'claim_task', { taskId: make().id }), /占用/);
});

test('restart recovers both unclaimed and handed-off runs without replaying them', t => {
  const dir = folder(t);
  for (const handedOff of [false, true]) {
    const filename = path.join(dir, 'case-' + handedOff + '.sqlite');
    let s = new Store(filename);
    try {
      const p = s.createProject({ name: '持久调度', path: dir });
      const task = s.createTask({ projectId: p.id, title: '任务', description: '测试', acceptance: '验证' });
      enable(s, task);
      const run = s.reserveDispatch('codex');
      if (handedOff) plan(s, task, run);
      s.close(); s = new Store(filename);
      assert.equal(s.schedulerState().enabled, true);
      assert.equal(s.getDispatch(run.id).state, 'uncertain');
      assert.equal(s.getTask(task.id).status, 'needs_human');
      assert.equal(s.getTask(task.id).autoEnabled, false);
      assert.equal(s.reserveDispatch('codex'), null);
      assert.equal(s.reserveDispatch('workbuddy'), null);
      s.resolveDispatch(run.id, { stopped: true });
      assert.equal(s.action(task.id, { action: 'retry', stopped: true }).status, handedOff ? 'ready' : 'planning_queue');
      assert.throws(() => claim(s, task, run), /结束/);
    } finally { s.close(); }
  }
});
