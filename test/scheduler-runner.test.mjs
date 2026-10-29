import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createHub } from '../src/server.mjs';
import { buildLaunch } from '../src/launchers.mjs';

const fixtureClient = fileURLToPath(new URL('./fixtures/fake-client.mjs', import.meta.url));
const root = fileURLToPath(new URL('../', import.meta.url));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, detail) {
  const deadline = Date.now() + 7000;
  while (Date.now() < deadline) { if (predicate()) return; await delay(20); }
  assert.fail('Timed out: ' + detail);
}
async function setup(t, mode = 'success') {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cross-app-runner-test-'));
  const projectDir = path.join(temp, 'project with spaces');
  fs.mkdirSync(projectDir);
  const launches = [], children = new Set();
  const hub = createHub({ dataDir: path.join(temp, 'data'), schedulerOptions: {
    intervalMs: 100000, paths: { codex: fixtureClient, workbuddy: fixtureClient },
    launch(command, args, options) {
      assert.equal(options.shell, false); assert.equal(options.windowsHide, true); assert.equal(options.cwd, projectDir);
      const child = spawn(command, args, { ...options, env: { ...options.env, HUB_TEST_CLIENT_MODE: mode } });
      launches.push({ command, args, options, child }); children.add(child);
      child.once('close', () => children.delete(child)); return child;
    }
  } });
  t.after(async () => {
    hub.scheduler.close();
    const alive = [...children];
    const exits = alive.map(child => once(child, 'close'));
    for (const child of alive) child.kill();
    await Promise.all(exits);
    await new Promise(resolve => hub.server.close(resolve)); hub.dispose();
    assert.equal(path.dirname(path.resolve(temp)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(temp).startsWith('cross-app-runner-test-'));
    fs.rmSync(temp, { recursive: true, force: true });
  });
  hub.store.setModelSettings({ implementation: { model: 'fixture-explicit-model', effort: '' } });
  hub.server.listen(0, '127.0.0.1'); await once(hub.server, 'listening');
  const url = 'http://127.0.0.1:' + hub.server.address().port;
  const project = hub.store.createProject({ name: 'Scheduler fixture', path: projectDir });
  const makeTask = title => hub.store.createTask({ projectId: project.id, title, description: 'Fixture-only task', acceptance: 'Exact file content and manual review' });
  async function ui(route, body) {
    const response = await fetch(url + route, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-ui': '1' }, body: JSON.stringify(body) });
    assert.equal(response.status, 200, await response.clone().text()); return response.json();
  }
  return { hub, temp, projectDir, launches, url, makeTask, ui };
}

test('real spawned clients complete only opted-in tasks via bound MCP without duplicate dispatch', async t => {
  const f = await setup(t);
  const manual = f.makeTask('Remain manual'), automatic = f.makeTask('Automatic fixture');
  assert.equal(f.hub.scheduler.state().enabled, false); assert.equal(f.hub.store.getTask(automatic.id).autoEnabled, false);
  f.hub.scheduler.tick(); assert.equal(f.launches.length, 0);
  await f.ui('/api/scheduler', { enabled: true });
  f.hub.scheduler.tick(); assert.equal(f.launches.length, 0, 'Global enabling does not opt tasks in');
  await f.ui('/api/tasks/' + automatic.id + '/automation', { enabled: true });
  f.hub.scheduler.tick();
  for (let i = 0; i < 12; i++) f.hub.scheduler.tick();
  assert.equal(f.launches.length, 1);
  await until(() => f.hub.scheduler.state().runs[0]?.state === 'finished', 'Codex plan and exit');
  assert.equal(f.hub.store.getTask(automatic.id).status, 'ready');
  f.hub.scheduler.tick();
  await until(() => f.hub.scheduler.state().runs[1]?.state === 'finished', 'WorkBuddy result and exit');
  assert.equal(f.hub.store.getTask(automatic.id).status, 'review'); assert.equal(f.hub.store.getTask(automatic.id).owner, null);
  assert.equal(f.hub.store.getTask(manual.id).status, 'planning_queue');
  assert.equal(fs.readFileSync(path.join(f.projectDir, 'scheduler-proof.txt'), 'utf8'), 'scheduler-fixture-ok');
  const runs = f.hub.scheduler.state().runs;
  assert.deepEqual(runs.map(run => run.actor), ['codex', 'workbuddy']);
  assert.ok(runs.every(run => run.claimedAt && run.handedOff && run.exitCode === 0)); assert.notEqual(runs[0].id, runs[1].id);
  for (let i = 0; i < 12; i++) f.hub.scheduler.tick();
  assert.equal(f.launches.length, 2, 'Review is never automatically approved or repeated');
});

test('exit zero without lease-bound submission is uncertain and never retried automatically', async t => {
  const f = await setup(t, 'no-submit'), task = f.makeTask('Exit without submitting');
  f.hub.store.setSchedulerEnabled(true); f.hub.store.setTaskAutomation(task.id, true); f.hub.scheduler.tick();
  await until(() => f.hub.scheduler.state().runs[0]?.state === 'uncertain', 'zero-exit uncertainty');
  assert.equal(f.hub.store.getTask(task.id).status, 'needs_human'); assert.equal(f.hub.store.getTask(task.id).autoEnabled, false);
  for (let i = 0; i < 12; i++) f.hub.scheduler.tick();
  assert.equal(f.launches.length, 1); assert.match(f.hub.scheduler.state().runs[0].error, /未收到/);
});

test('structured authentication failure is actionable even when client exits zero', async t => {
  const f = await setup(t, 'auth-error'), task = f.makeTask('Login required');
  f.hub.store.setSchedulerEnabled(true); f.hub.store.setTaskAutomation(task.id, true); f.hub.scheduler.tick();
  await until(() => f.hub.scheduler.state().runs[0]?.state === 'uncertain', 'authentication failure');
  assert.match(f.hub.scheduler.state().runs[0].error, /登录/);
  assert.equal(f.hub.store.getTask(task.id).status, 'needs_human');
  f.hub.scheduler.tick(); assert.equal(f.launches.length, 1);
});

test('unavailable model reports error and never retries or falls back', async t => {
  const f = await setup(t, 'model-error'), task = f.makeTask('Unavailable model');
  await f.ui('/api/scheduler/model-settings', { planning: { model: 'unavailable-model', effort: 'high' } });
  f.hub.store.setSchedulerEnabled(true); f.hub.store.setTaskAutomation(task.id, true); f.hub.scheduler.tick();
  await until(() => f.hub.scheduler.state().runs[0]?.state === 'uncertain', 'model failure');
  const run = f.hub.scheduler.state().runs[0];
  assert.match(run.error, /模型.*不可用/); assert.equal(run.requestedModel.model, 'unavailable-model');
  assert.equal(run.reportedModel, null); assert.equal(f.hub.store.getTask(task.id).status, 'needs_human');
  f.hub.scheduler.tick(); assert.equal(f.launches.length, 1);
});

test('reported model mismatch is recorded and prevents dispatch of the next phase', async t => {
  const f = await setup(t, 'model-mismatch'), task = f.makeTask('Wrong reported model');
  await f.ui('/api/tasks/' + task.id + '/model-settings', { planning: { model: 'requested-model' } });
  f.hub.store.setSchedulerEnabled(true); f.hub.store.setTaskAutomation(task.id, true); f.hub.scheduler.tick();
  await until(() => f.hub.scheduler.state().runs[0]?.state === 'uncertain', 'model mismatch');
  const run = f.hub.scheduler.state().runs[0];
  assert.equal(run.reportedModel, 'different-model'); assert.equal(run.requestedModel.model, 'requested-model');
  assert.match(run.error, /不一致/); f.hub.scheduler.tick(); assert.equal(f.launches.length, 1);
});

test('child logs stop at one MiB and are never served as state or assets', async t => {
  const f = await setup(t, 'flood'), task = f.makeTask('Bounded log fixture');
  f.hub.store.setSchedulerEnabled(true); f.hub.store.setTaskAutomation(task.id, true); f.hub.scheduler.tick();
  await until(() => f.hub.scheduler.state().runs[0]?.state === 'uncertain', 'flood exit');
  const run = f.hub.scheduler.state().runs[0], log = path.join(f.hub.dataDir, 'runs', run.id, 'output.log');
  assert.equal(fs.statSync(log).size, 1024 * 1024);
  assert.equal((await (await fetch(f.url + '/api/state')).text()).includes('LOCAL_PRIVATE_LOG_MARKER'), false);
  assert.equal((await fetch(f.url + '/data/runs/' + run.id + '/output.log')).status, 404);
  assert.equal((await fetch(f.url + '/api/scheduler/runs/' + run.id + '/output.log')).status, 404);
});

test('HTTP rejects missing dispatch binding and wrong actor for an automatic reservation', async t => {
  const f = await setup(t, 'no-submit'), task = f.makeTask('Bound run');
  f.hub.store.setSchedulerEnabled(true); f.hub.store.setTaskAutomation(task.id, true);
  const run = f.hub.store.reserveDispatch('codex');
  async function claim(actor, dispatchId) {
    // The token belongs to the isolated test instance, never the user's running instance.
    const token = fs.readFileSync(path.join(f.hub.dataDir, actor + '.token'), 'utf8').trim();
    return fetch(f.url + '/api/agent', { method: 'POST', headers: { 'content-type': 'application/json', 'x-agent-token': token,
      ...(dispatchId ? { 'x-hub-dispatch-id': dispatchId } : {}) }, body: JSON.stringify({ tool: 'claim_task', arguments: { taskId: task.id } }) });
  }
  assert.equal((await claim('codex')).status, 409); assert.equal((await claim('workbuddy', run.id)).status, 403);
  const response = await claim('codex', run.id); assert.equal(response.status, 200); assert.ok((await response.json()).leaseId);
  assert.equal((await claim('codex', run.id)).status, 409);
});

test('WorkBuddy launch preserves normal approvals and uses only the generated MCP configuration', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cross-app-runner-launch-'));
  try {
    const spec = buildLaunch({ actor: 'workbuddy', paths: { workbuddy: fixtureClient }, root, dataDir: temp,
      url: 'http://127.0.0.1:4319', run: { id: 'fixture-run', taskId: 'fixture-task' }, project: { path: temp } });
    assert.equal(spec.args[spec.args.indexOf('--permission-mode') + 1], 'default');
    assert.ok(spec.args.includes('--strict-mcp-config')); assert.ok(spec.args.includes('--no-session-persistence'));
    assert.equal(spec.args.includes('--dangerously-skip-permissions'), false);
    assert.equal(spec.env.CODEBUDDY_FORCE_LITE_WB_BUNDLE, '1'); assert.equal(spec.env.CODEBUDDY_CODE_DISABLE_BACKGROUND_TASKS, '1');
    assert.equal(spec.env.WORKBUDDY_DATA_FOLDER_NAME, '.workbuddy');
    const config = JSON.parse(fs.readFileSync(spec.args[spec.args.indexOf('--mcp-config') + 1], 'utf8'));
    assert.deepEqual(Object.keys(config.mcpServers), ['cross-app-workbuddy']);
    assert.equal(config.mcpServers['cross-app-workbuddy'].env.HUB_DISPATCH_ID, 'fixture-run');
    assert.equal(config.mcpServers['cross-app-workbuddy'].env.HUB_DATA_DIR, temp);
  } finally {
    assert.equal(path.dirname(path.resolve(temp)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(temp).startsWith('cross-app-runner-launch-'));
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('revoking automation during OS spawn never sends a task prompt or crashes the service', async t => {
  const f = await setup(t), task = f.makeTask('Revoke while spawning');
  f.hub.store.setSchedulerEnabled(true);
  f.hub.store.setTaskAutomation(task.id, true);
  f.hub.scheduler.tick();
  f.hub.store.setTaskAutomation(task.id, false);
  await until(() => f.hub.scheduler.children.size === 0, 'revoked client exits');
  const run = f.hub.scheduler.state().runs[0];
  assert.equal(run.state, 'uncertain');
  assert.ok(Number.isInteger(run.pid));
  assert.equal(run.claimedAt, null);
  assert.equal(run.handedOff, false);
  assert.equal(f.hub.store.getTask(task.id).status, 'needs_human');
  assert.equal((await fetch(f.url + '/health')).status, 200);
  assert.equal(fs.existsSync(path.join(f.projectDir, 'scheduler-proof.txt')), false);
});
