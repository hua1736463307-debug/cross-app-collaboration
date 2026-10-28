import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/store.mjs';
import { createHub } from '../src/server.mjs';

const cleanupStacks = new WeakMap();
function cleanup(t, fn) {
  if (!cleanupStacks.has(t)) {
    cleanupStacks.set(t, []);
    t.after(async () => {
      for (const callback of cleanupStacks.get(t).reverse()) await callback();
    });
  }
  cleanupStacks.get(t).push(fn);
}
function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cross-app-hub-test-'));
  cleanup(t, () => {
    const resolved = path.resolve(dir);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('cross-app-hub-test-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  return dir;
}
function fixture(t) {
  const dir = temp(t), s = new Store(':memory:');
  cleanup(t, () => s.close());
  const project = s.createProject({ name: '测试项目', path: dir });
  const make = (extra = {}) => s.createTask({ projectId: project.id, title: '实现接口', description: '按要求实现', acceptance: '测试通过并人工验收', ...extra });
  return { s, project, make, dir };
}
function ready(s, task) {
  const claim = s.agent('codex', 'claim_task', { taskId: task.id });
  s.agent('codex', 'submit_plan', { taskId: task.id, leaseId: claim.leaseId, plan: '先修改接口，再执行测试，出现错误停止上报。' });
}

test('完整工作流：计划→实施阻塞→Codex诊断→继续→人工验收', t => {
  const { s, make } = fixture(t), task = make();
  ready(s, task);
  let claim = s.agent('workbuddy', 'claim_task', { taskId: task.id });
  let report = s.agent('workbuddy', 'report_blocked', { taskId: task.id, leaseId: claim.leaseId, summary: '构建失败', evidence: '错误码 E_TEST' });
  assert.equal(report.task.status, 'blocked');
  claim = s.agent('codex', 'claim_task', { taskId: task.id });
  assert.equal(claim.task.status, 'diagnosing');
  s.agent('codex', 'submit_plan', { taskId: task.id, leaseId: claim.leaseId, plan: '修复导入，再测试。' });
  claim = s.agent('workbuddy', 'claim_task', { taskId: task.id });
  report = s.agent('workbuddy', 'submit_result', { taskId: task.id, leaseId: claim.leaseId, summary: '已完成', evidence: '构建退出码0，测试3项通过' });
  assert.equal(report.task.status, 'review');
  assert.throws(() => s.action(task.id, { action: 'approve', evidence: '' }));
  assert.equal(s.action(task.id, { action: 'approve', evidence: '人工验证接口结果正确' }).status, 'done');
  assert.equal(s.state().tasks[0].revision, 2);
  assert.match(s.packet(task.id), /E_TEST/);
  assert.equal(s.state().tasks[0].leaseId, undefined);
});

test('两个客户端不能重复领取同项目任务，嵌套项目也被保护', t => {
  const { s, make, dir } = fixture(t), first = make(), second = make();
  s.agent('codex', 'claim_task', { taskId: first.id });
  assert.throws(() => s.agent('codex', 'claim_task', { taskId: first.id }), /不可/);
  assert.throws(() => s.agent('codex', 'claim_task', { taskId: second.id }), /占用/);
  const child = path.join(dir, 'nested'); fs.mkdirSync(child);
  const p = s.createProject({ name: '嵌套目录', path: child });
  const nested = s.createTask({ projectId: p.id, title: '嵌套任务', description: '测试', acceptance: '通过' });
  assert.throws(() => s.agent('codex', 'claim_task', { taskId: nested.id }), /占用/);
});

test('角色与租约限制阻止伪造提交', t => {
  const { s, make } = fixture(t), task = make();
  assert.throws(() => s.agent('workbuddy', 'claim_task', { taskId: task.id }), /不可/);
  const claim = s.agent('codex', 'claim_task', { taskId: task.id });
  assert.throws(() => s.agent('workbuddy', 'submit_plan', { taskId: task.id, leaseId: claim.leaseId, plan: '错误角色' }), /租约/);
  assert.throws(() => s.agent('codex', 'submit_plan', { taskId: task.id, leaseId: 'invalid', plan: '错误租约' }), /租约/);
  assert.throws(() => s.agent('codex', 'submit_result', { taskId: task.id, leaseId: claim.leaseId, summary: '跳过计划', evidence: '无' }), /阶段/);
  assert.equal(s.state().tasks[0].status, 'planning');
});

test('暂停等待执行端确认，不直接释放租约', t => {
  const { s, make } = fixture(t), task = make();
  ready(s, task);
  const claim = s.agent('workbuddy', 'claim_task', { taskId: task.id });
  const paused = s.action(task.id, { action: 'request_pause' });
  assert.equal(paused.status, 'implementing');
  assert.equal(paused.owner, 'workbuddy');
  assert.equal(s.agent('workbuddy', 'heartbeat', { taskId: task.id, leaseId: claim.leaseId }).pauseRequested, true);
  assert.throws(() => s.agent('workbuddy', 'submit_result', { taskId: task.id, leaseId: claim.leaseId, summary: '忽略暂停', evidence: '测试' }), /暂停/);
  s.agent('workbuddy', 'acknowledge_pause', { taskId: task.id, leaseId: claim.leaseId, summary: '所有子任务已停止，文件已保存' });
  assert.equal(s.state().tasks[0].owner, null);
  assert.equal(s.action(task.id, { action: 'resume' }).status, 'ready');
});

test('反复阻塞后转人工，明确接手后 Codex 才能实施', t => {
  const { s, make } = fixture(t), task = make({ maxRetries: 1 });
  ready(s, task);
  let claim = s.agent('workbuddy', 'claim_task', { taskId: task.id });
  s.agent('workbuddy', 'report_blocked', { taskId: task.id, leaseId: claim.leaseId, summary: '无法继续', evidence: '详细错误' });
  assert.equal(s.state().tasks[0].status, 'needs_human');
  assert.throws(() => s.action(task.id, { action: 'takeover' }), /确认/);
  s.action(task.id, { action: 'takeover', stopped: true });
  claim = s.agent('codex', 'claim_task', { taskId: task.id });
  assert.equal(claim.task.status, 'fixing');
  const report = s.agent('codex', 'submit_result', { taskId: task.id, leaseId: claim.leaseId, summary: '修复完成', evidence: '测试通过' });
  assert.equal(report.task.status, 'review');
});

test('心跳过期保留项目占用，旧租约不能继续提交', t => {
  const { s, make } = fixture(t), task = make();
  const claim = s.agent('codex', 'claim_task', { taskId: task.id });
  const internal = s.getTask(task.id); internal.heartbeatAt = '2000-01-01T00:00:00Z'; s.save(internal);
  s.expire();
  assert.equal(s.state().tasks[0].status, 'needs_human');
  assert.equal(s.state().tasks[0].owner, 'codex');
  assert.throws(() => s.agent('codex', 'claim_task', { taskId: make().id }), /占用/);
  assert.throws(() => s.agent('codex', 'submit_plan', { taskId: task.id, leaseId: claim.leaseId, plan: '迟到的计划' }), /租约/);
  assert.equal(s.action(task.id, { action: 'retry', stopped: true }).status, 'planning_queue');
});

test('重启保留诊断阶段和历史，人工确认后回到诊断队列', t => {
  const dir = temp(t), filename = path.join(dir, 'test.sqlite');
  let s = new Store(filename);
  const p = s.createProject({ name: '持久化测试', path: dir });
  const task = s.createTask({ projectId: p.id, title: '任务', description: '测试', acceptance: '通过' });
  ready(s, task);
  let claim = s.agent('workbuddy', 'claim_task', { taskId: task.id });
  s.agent('workbuddy', 'report_blocked', { taskId: task.id, leaseId: claim.leaseId, summary: '错误', evidence: '日志' });
  s.agent('codex', 'claim_task', { taskId: task.id });
  s.close();
  s = new Store(filename);
  try {
    assert.equal(s.state().tasks[0].status, 'needs_human');
    assert.equal(s.state().tasks[0].owner, 'codex');
    assert.equal(s.action(task.id, { action: 'retry', stopped: true }).status, 'blocked');
    assert.match(s.packet(task.id), /服务重新启动/);
  } finally { s.close(); }
});

test('输入验证与失败事务不改变状态', t => {
  const { s, make, dir } = fixture(t), task = make();
  assert.throws(() => s.createProject({ name: '重复', path: dir }), /已添加/);
  assert.throws(() => s.createProject({ name: '相对', path: 'relative' }), /绝对/);
  assert.throws(() => s.createTask({ title: '缺项目' }), /项目 ID/);
  assert.throws(() => make({ maxRetries: 0 }), /轮数/);
  const claim = s.agent('codex', 'claim_task', { taskId: task.id });
  const count = s.state().events.length;
  assert.throws(() => s.agent('codex', 'submit_plan', { taskId: task.id, leaseId: claim.leaseId, plan: '' }));
  assert.equal(s.state().events.length, count);
  assert.equal(s.state().tasks[0].status, 'planning');
});

async function live(t) {
  const dir = temp(t), hub = createHub({ dataDir: path.join(dir, 'data') });
  hub.server.listen(0, '127.0.0.1'); await once(hub.server, 'listening');
  const url = 'http://127.0.0.1:' + hub.server.address().port;
  cleanup(t, () => new Promise(resolve => hub.server.close(resolve)));
  const post = async (route, value, headers = {}) => {
    const response = await fetch(url + route, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-ui': '1', ...headers }, body: JSON.stringify(value) });
    return { status: response.status, value: await response.json() };
  };
  return { dir, hub, url, post };
}
test('HTTP 拒绝跨站修改与假客户端，不泄露租约和令牌', async t => {
  const { dir, hub, url, post } = await live(t);
  assert.equal((await post('/api/projects', { name: '跨站', path: dir }, { origin: 'https://example.com' })).status, 403);
  assert.equal((await post('/api/projects', { name: '无标记', path: dir }, { 'x-hub-ui': '' })).status, 403);
  assert.equal((await post('/api/agent', { tool: 'heartbeat' }, { 'x-agent-token': 'bad' })).status, 401);
  const p = await post('/api/projects', { name: 'HTTP项目', path: dir });
  assert.equal(p.status, 201);
  const task = await post('/api/tasks', { projectId: p.value.id, title: '测试', description: '测试', acceptance: '通过' });
  const token = fs.readFileSync(path.join(hub.dataDir, 'codex.token'), 'utf8').trim();
  const claimed = await post('/api/agent', { tool: 'claim_task', arguments: { taskId: task.value.id } }, { 'x-agent-token': token });
  assert.equal(claimed.value.task.status, 'planning');
  const state = await (await fetch(url + '/api/state')).text();
  assert.ok(!state.includes(token)); assert.ok(!state.includes(claimed.value.leaseId));
  assert.equal((await fetch(url + '/data/codex.token')).status, 404);
  assert.throws(() => createHub({ dataDir: hub.dataDir }), /已被/);
});

function bridge(t, url, dataDir, actor) {
  const entry = fileURLToPath(new URL('../src/mcp.mjs', import.meta.url));
  const child = spawn(process.execPath, [entry, '--actor', actor], { env: { ...process.env, HUB_URL: url, HUB_DATA_DIR: dataDir }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let serial = 0, buffer = '';
  const pending = new Map();
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    buffer += chunk;
    let at;
    while ((at = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
      if (line.trim()) {
        const message = JSON.parse(line);
        const entry = pending.get(message.id);
        if (entry) { pending.delete(message.id); clearTimeout(entry.timer); entry.resolve(message); }
      }
    }
  });
  child.stderr.resume();
  cleanup(t, async () => {
    for (const p of pending.values()) clearTimeout(p.timer);
    if (child.exitCode === null) { const ended = once(child, 'exit'); child.kill(); await ended; }
  });
  return (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++serial;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('MCP request timeout')); }, 8000);
    pending.set(id, { resolve, timer });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}
test('真实 MCP 子进程→HTTP→SQLite，双角色交接到人工验收', async t => {
  const { dir, hub, url, post } = await live(t);
  const p = await post('/api/projects', { name: '真实协议闭环', path: dir });
  const task = await post('/api/tasks', { projectId: p.value.id, title: '任务', description: '协议验收', acceptance: '证据完整' });
  const codex = bridge(t, url, hub.dataDir, 'codex'), workbuddy = bridge(t, url, hub.dataDir, 'workbuddy');
  for (const call of [codex, workbuddy]) {
    const init = await call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    assert.equal(init.result.protocolVersion, '2025-06-18');
  }
  const tool = async (call, name, args) => {
    const reply = await call('tools/call', { name, arguments: args });
    assert.equal(reply.result.isError, false, JSON.stringify(reply));
    return JSON.parse(reply.result.content[0].text);
  };
  let claim = await tool(codex, 'claim_task', { taskId: task.value.id });
  await tool(codex, 'submit_plan', { taskId: task.value.id, leaseId: claim.leaseId, plan: '执行协议测试并报告真实结果。' });
  claim = await tool(workbuddy, 'claim_task', { taskId: task.value.id });
  await tool(workbuddy, 'report_blocked', { taskId: task.value.id, leaseId: claim.leaseId, summary: '测试阻塞场景', evidence: '这是自动测试注入的失败，不是真实模型结果。' });
  claim = await tool(codex, 'claim_task', { taskId: task.value.id });
  await tool(codex, 'submit_plan', { taskId: task.value.id, leaseId: claim.leaseId, plan: '修订计划，继续验证。' });
  claim = await tool(workbuddy, 'claim_task', { taskId: task.value.id });
  const result = await tool(workbuddy, 'submit_result', { taskId: task.value.id, leaseId: claim.leaseId, summary: '协议完成', evidence: '测试执行已到提交节点。' });
  assert.equal(result.task.status, 'review');
  const approved = await post('/api/tasks/' + task.value.id + '/action', { action: 'approve', evidence: '自动测试验证状态流转；非真实客户端验收。' });
  assert.equal(approved.value.status, 'done');
});

test('桥仍续租但暂停未确认，超过期限仍转人工且保留占用', t => {
  const { s, make } = fixture(t), task = make();
  ready(s, task);
  const claim = s.agent('workbuddy', 'claim_task', { taskId: task.id });
  s.action(task.id, { action: 'request_pause' });
  const internal = s.getTask(task.id);
  assert.ok(internal.pauseRequestedAt);
  internal.pauseRequestedAt = '2000-01-01T00:00:00Z';
  internal.heartbeatAt = new Date().toISOString();
  s.save(internal);
  s.expire();
  assert.equal(s.state().tasks[0].status, 'needs_human');
  assert.equal(s.state().tasks[0].owner, 'workbuddy');
  assert.throws(() => s.agent('workbuddy', 'heartbeat', { taskId: task.id, leaseId: claim.leaseId }), /租约/);
  assert.equal(s.action(task.id, { action: 'takeover', stopped: true }).status, 'codex_fix_queue');
});
