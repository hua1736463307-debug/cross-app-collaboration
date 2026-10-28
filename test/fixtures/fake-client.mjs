// Test-only client, consuming real launch arguments and using the actual MCP bridge.
// No model or user client configuration is read.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import assert from 'node:assert/strict';

const args = process.argv.slice(2), actor = args[0] === 'exec' ? 'codex' : 'workbuddy';
let bridge;
if (actor === 'codex') {
  bridge = { env: {} };
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== '-c') continue;
    const value = args[++i], eq = value.indexOf('=');
    const key = value.slice(0, eq).replace('mcp_servers.cross-app-codex.', '');
    if (key.startsWith('env.')) bridge.env[key.slice(4)] = JSON.parse(value.slice(eq + 1));
    else bridge[key] = JSON.parse(value.slice(eq + 1));
  }
} else bridge = JSON.parse(fs.readFileSync(args[args.indexOf('--mcp-config') + 1], 'utf8')).mcpServers['cross-app-workbuddy'];
let prompt = '';
for await (const chunk of process.stdin) prompt += chunk;
const taskId = prompt.match(/任务 ([a-f0-9-]{36})/u)?.[1];
assert.ok(taskId); assert.ok(bridge.env.HUB_DISPATCH_ID);
const mode = process.env.HUB_TEST_CLIENT_MODE || 'success';
if (mode === 'no-submit') process.exit(0);
if (mode === 'auth-error') {
  console.log(JSON.stringify({type:'result', is_error:true, errors:['Authentication required. Please use /login']}));
  process.exit(0);
}
if (mode === 'flood') {
  for (let i = 0; i < 8; i++) if (!process.stdout.write('LOCAL_PRIVATE_LOG_MARKER'.repeat(8000))) await once(process.stdout, 'drain');
  process.exit(0);
}
const child = spawn(bridge.command, bridge.args, { env: { ...process.env, ...bridge.env }, cwd: process.cwd(), shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
let nextId = 0;
const pending = new Map(), input = createInterface({ input: child.stdout });
input.on('line', line => {
  const message = JSON.parse(line), request = pending.get(message.id);
  if (!request) return;
  pending.delete(message.id);
  if (message.error) request.reject(new Error(message.error.message)); else request.resolve(message.result);
});
child.stderr.resume();
child.once('error', error => { for (const request of pending.values()) request.reject(error); });
function request(method, params) {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}
async function tool(name, arguments_ = {}) {
  const result = await request('tools/call', { name, arguments: arguments_ });
  assert.equal(result.isError, false, result.content?.[0]?.text);
  return JSON.parse(result.content[0].text);
}
try {
  await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'scheduler-fixture', version: '1' } });
  const listed = await tool('list_tasks');
  assert.deepEqual(listed.tasks.map(task => task.id), [taskId]);
  await tool('get_task', { taskId });
  const claim = await tool('claim_task', { taskId });
  await tool('heartbeat', { taskId, leaseId: claim.leaseId });
  if (actor === 'codex') {
    await tool('submit_plan', { taskId, leaseId: claim.leaseId, plan: 'Create scheduler-proof.txt in the authorized project, then read it back.' });
  } else {
    const file = path.join(process.cwd(), 'scheduler-proof.txt');
    fs.writeFileSync(file, 'scheduler-fixture-ok');
    assert.equal(fs.readFileSync(file, 'utf8'), 'scheduler-fixture-ok');
    await tool('submit_result', { taskId, leaseId: claim.leaseId, summary: 'Created and read back fixture file', evidence: 'scheduler-proof.txt exactly equals scheduler-fixture-ok' });
  }
  const finished = once(child, 'close'); child.stdin.end(); await finished;
  console.log(JSON.stringify({ fixture: true, actor, submitted: true }));
} catch (error) {
  child.stdin.end(); console.error(error.message); process.exitCode = 1;
}
