import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.mjs';

test('desktop plan skips planning, preserves acceptance and deduplicates retries', () => {
  const store = new Store(':memory:');
  try {
    const project = store.createProject({ name: '桌面交接测试', path: process.cwd() });
    const args = { projectId: project.id, title: '完成既定计划', description: '仅修改指定文件',
      acceptance: '检查通过并人工验收', plan: '步骤一：修改；步骤二：验证；失败停止上报。', requestId: 'desktop-test-1', automation: 'enabled' };
    assert.throws(() => store.agent('workbuddy', 'create_planned_task', args), /仅桌面/);
    assert.throws(() => store.agent('codex', 'create_planned_task', args, 'bad-dispatch'));
    const first = store.agent('codex', 'create_planned_task', args);
    assert.equal(first.task.status, 'ready');
    assert.equal(first.task.revision, 1);
    assert.equal(first.task.autoEnabled, true);
    assert.equal(first.task.acceptance, args.acceptance);
    assert.equal(store.agent('codex', 'create_planned_task', args).task.id, first.task.id);
    assert.throws(() => store.agent('codex', 'create_planned_task', { ...args, plan: 'changed' }), /其他内容/);
    assert.equal(store.state().tasks.length, 1);
    const claim = store.agent('workbuddy', 'claim_task', { taskId: first.task.id });
    assert.equal(claim.task.status, 'implementing');
    assert.ok(claim.leaseId);
  } finally { store.close(); }
});
