import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createHub } from '../src/server.mjs';

test('UI shutdown rejects cross-site and active leases, closes idle service and releases lock', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-exit-'));
  const hub = createHub({ dataDir: dir });
  try {
    hub.server.listen(0, '127.0.0.1'); await once(hub.server, 'listening');
    const url = 'http://127.0.0.1:' + hub.server.address().port;
    const meta = (await (await fetch(url + '/api/state')).json()).meta;
    assert.ok(meta.startedAt); assert.ok(meta.instanceId);
    const post = headers => fetch(url + '/api/shutdown', { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-ui': '1', ...headers }, body: '{}' });
    assert.equal((await post({ origin: 'https://example.com' })).status, 403);
    const project = hub.store.createProject({ name: 'test', path: dir });
    const task = hub.store.createTask({ projectId: project.id, title: 'test', description: 'test', acceptance: 'test' });
    const claim = hub.store.agent('codex', 'claim_task', { taskId: task.id });
    assert.equal((await post()).status, 409);
    hub.store.agent('codex', 'submit_plan', { taskId: task.id, leaseId: claim.leaseId, plan: 'test plan' });
    const closed = once(hub.server, 'close');
    assert.equal((await post()).status, 200); await closed;
    assert.equal(fs.existsSync(path.join(dir, 'server.lock')), false);
    const restarted = createHub({ dataDir: dir }); restarted.dispose();
  } finally {
    if (hub.server.listening) await new Promise(resolve => hub.server.close(resolve));
    hub.dispose(); fs.rmSync(dir, { recursive: true, force: true });
  }
});
