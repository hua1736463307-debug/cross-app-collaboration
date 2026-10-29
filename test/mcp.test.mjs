import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BRIDGE = resolve(dirname(fileURLToPath(import.meta.url)), '../src/mcp.mjs');
const TOKEN = 'fixture-local-token-only';
const LEASE = 'fixture-lease';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(check, message, timeout = 3000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = check();
    if (value) return value;
    await delay(10);
  }
  throw new Error('等待超时：' + message);
}
async function fixture(t, actor = 'codex') {
  const dataDir = await mkdtemp(join(tmpdir(), 'cross-app-mcp-test-'));
  await writeFile(join(dataDir, actor + '.token'), TOKEN);
  const calls = [];
  let releaseSlow;
  const slowGate = new Promise(resolve => { releaseSlow = resolve; });
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    res.setHeader('content-type', 'application/json');
    if (req.headers['x-agent-token'] !== TOKEN || req.url !== '/api/agent') {
      res.writeHead(403); res.end(JSON.stringify({ error: '认证失败' })); return;
    }
    const request = JSON.parse(body);
    calls.push(request);
    const args = request.arguments;
    if (args.taskId === 'slow' || args.taskId === 'slow-claim') await slowGate;
    let response;
    if (request.tool === 'claim_task') {
      if (args.taskId === 'busy') {
        res.writeHead(409); res.end(JSON.stringify({ error: '项目已有执行者' })); return;
      }
      response = { task: { id: args.taskId, status: 'planning' }, leaseId: LEASE, packet: '真实 fixture 任务包' };
    } else if (request.tool === 'list_tasks') response = { tasks: [{ id: 'task-1' }], projects: [] };
    else if (request.tool === 'get_task') response = { task: { id: args.taskId }, packet: 'fixture' };
    else if (request.tool === 'heartbeat' && !args.taskId) response = { ok: true };
    else {
      if (args.leaseId !== LEASE) {
        res.writeHead(409); res.end(JSON.stringify({ error: '租约无效' })); return;
      }
      response = request.tool === 'heartbeat' ? { ok: true, pauseRequested: true } : { task: { id: args.taskId, status: 'ready' } };
    }
    res.end(JSON.stringify(response));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const child = spawn(process.execPath, [BRIDGE, '--actor', actor], {
    env: { ...process.env, HUB_DATA_DIR: dataDir, HUB_URL: 'http://127.0.0.1:' + server.address().port },
    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true
  });
  const pending = new Map();
  const allResponses = [];
  let nextId = 1, output = '', diagnostics = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', value => { diagnostics += value; });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    output += chunk;
    let index;
    while ((index = output.indexOf('\n')) >= 0) {
      const line = output.slice(0, index); output = output.slice(index + 1);
      let value;
      try { value = JSON.parse(line); } catch {
        for (const callback of pending.values()) callback.reject(new Error('stdout 包含非协议文本：' + line));
        continue;
      }
      allResponses.push(value);
      const callback = pending.get(value.id);
      if (callback) { pending.delete(value.id); callback.resolve(value); }
    }
  });
  child.on('exit', code => {
    for (const callback of pending.values()) callback.reject(new Error('MCP 意外退出 ' + code + ': ' + diagnostics));
    pending.clear();
  });
  t.after(async () => {
    releaseSlow();
    for (const callback of pending.values()) callback.reject(new Error('测试结束'));
    pending.clear();
    child.stdin.end();
    if (child.exitCode === null) {
      const finished = once(child, 'exit');
      const timer = setTimeout(() => child.kill(), 1000);
      await finished; clearTimeout(timer);
    }
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  });
  function send(method, params = {}) {
    const id = nextId++;
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    return id;
  }
  function rpc(method, params = {}) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('MCP 响应超时 ' + method)); }, 5000);
      pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
  function notify(method, params = {}) { child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n'); }
  return { rpc, send, notify, child, calls, allResponses, dataDir, releaseSlow, diagnostics: () => diagnostics };
}
async function initialize(client, version = '2025-06-18') {
  const response = await client.rpc('initialize', { protocolVersion: version, capabilities: {}, clientInfo: { name: 'test-client', version: '1' } });
  assert.equal(response.result.protocolVersion, version);
  client.notify('notifications/initialized');
  return response.result;
}
function tool(client, name, args = {}) { return client.rpc('tools/call', { name, arguments: args }); }
function content(response) {
  assert.equal(response.result.isError, false, JSON.stringify(response));
  return JSON.parse(response.result.content[0].text);
}

test('MCP negotiates supported protocols and advertises explicit-lease safety requirements', async t => {
  for (const version of ['2024-11-05', '2025-03-26', '2025-06-18']) {
    await t.test(version, async t => {
      const client = await fixture(t);
      const handshake = await initialize(client, version);
      assert.match(handshake.instructions, /不会自动唤醒/);
      assert.match(handshake.instructions, /每个实施步骤前必须显式调用 heartbeat/);
      assert.match(handshake.instructions, /自动桥心跳只证明连接存在/);
      assert.match(handshake.instructions, /共享桥不等于独立聊天/);
      assert.match(handshake.instructions, /停止所有相关写入及子任务/);
      assert.equal(handshake.serverInfo.name, 'cross-app-collaboration-codex');
      const response = await client.rpc('tools/list');
      assert.equal(response.result.tools.length, 9);
      const planTool = response.result.tools.find(t => t.name === 'submit_plan');
      assert.deepEqual(planTool.inputSchema.required, ['taskId', 'leaseId', 'plan']);
      assert.equal(planTool.inputSchema.additionalProperties, false);
      for (const name of ['submit_plan', 'report_blocked', 'submit_result', 'acknowledge_pause']) {
        assert.ok(response.result.tools.find(t => t.name === name).inputSchema.required.includes('leaseId'));
      }
      assert.match(planTool.description, /先停止全部相关写入和子任务/);
      assert.match(response.result.tools.find(t => t.name === 'submit_result').description, /先停止全部相关写入和子任务/);
      assert.deepEqual((await client.rpc('ping')).result, {});
      assert.ok(client.allResponses.every(response => response.jsonrpc === '2.0'));
    });
  }
});

test('MCP requires initialization and rejects unknown methods and tools', async t => {
  const client = await fixture(t);
  assert.equal((await client.rpc('tools/list')).error.code, -32002);
  await initialize(client);
  assert.equal((await client.rpc('not-a-method')).error.code, -32601);
  assert.equal((await tool(client, 'not-a-tool')).error.code, -32602);
  assert.equal((await client.rpc('initialize')).error.code, -32600);
});

test('MCP validates inputs before making a task API call', async t => {
  const client = await fixture(t);
  await initialize(client);
  for (const args of [{}, { taskId: '' }, { taskId: 'task-1', unexpected: true }, ['task-1'], 'task-1']) {
    assert.equal((await tool(client, 'claim_task', args)).result.isError, true);
  }
  assert.equal(client.calls.filter(call => call.tool === 'claim_task').length, 0);
});

test('MCP forwards explicit leases and never fills task tool arguments from shared cache', async t => {
  const client = await fixture(t);
  await initialize(client);
  assert.equal(content(await tool(client, 'list_tasks')).tasks[0].id, 'task-1');
  const claimed = content(await tool(client, 'claim_task', { taskId: 'task-1' }));
  assert.equal(claimed.leaseId, LEASE);
  assert.match(claimed.coordinationNotice, /共享桥不等于独立聊天/);
  for (const [name, args] of [
    ['heartbeat', { taskId: 'task-1' }],
    ['heartbeat', { leaseId: LEASE }],
    ['submit_plan', { taskId: 'task-1', plan: '计划' }],
    ['report_blocked', { taskId: 'task-1', summary: '阻塞', evidence: '证据' }],
    ['submit_result', { taskId: 'task-1', summary: '完成', evidence: '证据' }],
    ['acknowledge_pause', { taskId: 'task-1', summary: '已停' }]
  ]) assert.equal((await tool(client, name, args)).result.isError, true);
  assert.equal(client.calls.filter(call => call.arguments.taskId === 'task-1').length, 1);
  assert.equal(content(await tool(client, 'heartbeat', { taskId: 'task-1', leaseId: claimed.leaseId })).pauseRequested, true);
  content(await tool(client, 'submit_plan', { taskId: 'task-1', leaseId: claimed.leaseId, plan: '执行第一个步骤，并运行测试。' }));
  assert.equal(client.calls.find(call => call.tool === 'submit_plan').arguments.leaseId, LEASE);
  const invalidLease = await tool(client, 'heartbeat', { taskId: 'task-1', leaseId: 'incorrect-lease' });
  assert.equal(invalidLease.result.isError, true);
  assert.match(invalidLease.result.content[0].text, /租约无效/);
});

test('MCP surfaces project conflict without claiming success', async t => {
  const client = await fixture(t, 'workbuddy');
  await initialize(client);
  const response = await tool(client, 'claim_task', { taskId: 'busy' });
  assert.equal(response.result.isError, true);
  assert.match(response.result.content[0].text, /项目已有执行者/);
});

test('MCP reads credentials at request time and never prints token contents', async t => {
  const client = await fixture(t);
  await initialize(client);
  await writeFile(join(client.dataDir, 'codex.token'), '');
  const response = await tool(client, 'list_tasks');
  assert.equal(response.result.isError, true);
  assert.match(response.result.content[0].text, /凭据格式无效/);
  assert.ok(!client.diagnostics().includes(TOKEN));
  assert.ok(!JSON.stringify(client.allResponses).includes(TOKEN));
});

test('MCP rejects remote endpoints and invalid actor before any connection', async () => {
  for (const config of [{ actor: 'codex', url: 'https://example.com' }, { actor: 'codex', url: 'http://127.0.0.1:4318/extra' }, { actor: 'human', url: 'http://127.0.0.1:4318' }]) {
    const child = spawn(process.execPath, [BRIDGE, '--actor', config.actor], { env: { ...process.env, HUB_URL: config.url }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '', stderr = '';
    child.stdout.on('data', value => { stdout += value; });
    child.stderr.on('data', value => { stderr += value; });
    const [code] = await once(child, 'exit');
    assert.equal(code, 1);
    assert.equal(stdout, '');
    assert.ok(stderr.length > 0);
  }
});

test('MCP legacy batch returns one array with request results and no notification response', async t => {
  for (const version of ['2024-11-05', '2025-03-26']) {
    await t.test(version, async t => {
      const client = await fixture(t);
      await initialize(client, version);
      client.child.stdin.write(JSON.stringify([
        { jsonrpc: '2.0', id: 'batch-ping', method: 'ping' },
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        { jsonrpc: '2.0', id: 'batch-tools', method: 'tools/list' }
      ]) + '\n');
      const response = await waitFor(() => client.allResponses.find(Array.isArray), 'batch results');
      assert.equal(response.length, 2);
      assert.deepEqual(response.find(r => r.id === 'batch-ping').result, {});
      assert.equal(response.find(r => r.id === 'batch-tools').result.tools.length, 9);
    });
  }
});

test('MCP 2025-06-18 rejects batches without dispatching their operations', async t => {
  const client = await fixture(t);
  await initialize(client);
  client.child.stdin.write(JSON.stringify([{ jsonrpc: '2.0', id: 'modern-batch', method: 'tools/call', params: { name: 'claim_task', arguments: { taskId: 'task-1' } } }]) + '\n');
  const response = await waitFor(() => client.allResponses.find(r => r.id === null), 'batch rejection');
  assert.equal(response.error.code, -32600);
  assert.equal(client.calls.filter(call => call.tool === 'claim_task').length, 0);
});

test('MCP cancellation immediately removes queued mutation before HTTP dispatch', async t => {
  const client = await fixture(t);
  await initialize(client);
  const slow = tool(client, 'get_task', { taskId: 'slow' });
  await waitFor(() => client.calls.some(call => call.arguments.taskId === 'slow'), 'slow request started');
  const cancelledId = client.send('tools/call', { name: 'claim_task', arguments: { taskId: 'never-dispatched' } });
  client.notify('notifications/cancelled', { requestId: cancelledId, reason: 'User stopped task' });
  await delay(50);
  client.releaseSlow();
  content(await slow);
  await client.rpc('ping'); // Queue barrier.
  assert.equal(client.calls.filter(call => call.tool === 'claim_task').length, 0);
  assert.equal(client.allResponses.some(response => response.id === cancelledId), false);
});

test('MCP cancellation of already-dispatched mutation reports uncertainty and does not release', async t => {
  const client = await fixture(t);
  await initialize(client);
  const cancelledId = client.send('tools/call', { name: 'claim_task', arguments: { taskId: 'slow-claim' } });
  await waitFor(() => client.calls.some(call => call.arguments.taskId === 'slow-claim'), 'claim already dispatched');
  client.notify('notifications/cancelled', { requestId: cancelledId });
  await client.rpc('ping');
  client.releaseSlow();
  assert.equal(client.allResponses.some(response => response.id === cancelledId), false);
  assert.match(client.diagnostics(), /取消不能保证撤销/);
  assert.equal(client.calls.some(call => ['acknowledge_pause', 'submit_result', 'report_blocked', 'submit_plan'].includes(call.tool)), false);
});

test('MCP EOF stops queued mutations while preserving already-dispatched result uncertainty', async t => {
  const client = await fixture(t);
  await initialize(client);
  client.send('tools/call', { name: 'get_task', arguments: { taskId: 'slow' } });
  await waitFor(() => client.calls.some(call => call.arguments.taskId === 'slow'), 'slow request started');
  const queuedId = client.send('tools/call', { name: 'claim_task', arguments: { taskId: 'never-on-eof' } });
  const exited = once(client.child, 'exit');
  client.child.stdin.end();
  await delay(50);
  client.releaseSlow();
  await exited;
  assert.equal(client.calls.filter(call => call.tool === 'claim_task').length, 0);
  assert.equal(client.allResponses.some(response => response.id === queuedId), false);
  assert.match(client.diagnostics(), /已派发的操作可能生效/);
});

test('MCP disconnect does not send an automatic task release', async t => {
  const client = await fixture(t);
  await initialize(client);
  content(await tool(client, 'claim_task', { taskId: 'task-1' }));
  const exited = once(client.child, 'exit');
  client.child.stdin.end();
  await exited;
  assert.equal(client.calls.filter(call => ['acknowledge_pause', 'submit_result', 'report_blocked', 'submit_plan'].includes(call.tool)).length, 0);
});
