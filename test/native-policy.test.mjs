import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { buildNativePolicy, isSandboxDenial } from '../src/codebuddy-policy.mjs';

test('native policy is complete, defaults closed, and contains no probe-specific path', () => {
  const cwd = path.resolve('test-workspace');
  const policy = buildNativePolicy(cwd, path.resolve('data/cli/bin/codebuddy'));
  for (const kind of ['file', 'command', 'network']) {
    assert.ok(Array.isArray(policy.orderedRules[kind].rules));
    assert.equal(policy.orderedRules[kind].customized, true);
  }
  const rules = policy.orderedRules.file.rules;
  assert.deepEqual(rules.at(-1), { id: 'outside-default', source: 'user', path: '**', read: 'deny', write: 'deny', delete: 'deny' });
  assert.equal(rules.filter(rule => rule.write === 'allow').length, 1);
  assert.equal(rules.find(rule => rule.write === 'allow').path, cwd.replace(/\\/g, '/') + '/**');
  assert.ok(rules.findIndex(rule => rule.id === 'protect-.aws') < rules.findIndex(rule => rule.id === 'workspace'));
  assert.equal(JSON.stringify(policy).includes('outside.txt'), false);
  assert.equal(policy.allowUnsandboxedCommands, false);
  assert.deepEqual(policy.excludedCommands, []);
  assert.deepEqual(policy.orderedRules.network.rules.map(rule => [rule.domain, rule.action]), [['*', 'deny']]);
  assert.throws(() => buildNativePolicy('relative-path', 'cli'), /绝对路径/);
});

test('terminal and built-in file denials stop, but ordinary file text cannot spoof a boundary event', () => {
  const result = {type:'tool_result',is_error:true,content:[{type:'text',text:'Error: Sandbox rule denied writing to D:/outside.txt'}]};
  assert.equal(isSandboxDenial({type:'user',message:{content:[result]}}),true);
  assert.equal(isSandboxDenial({type:'user',message:{content:[{...result,is_error:false}]}}),false);
  assert.equal(isSandboxDenial({type:'assistant',message:{content:[result]}}),false);
  assert.equal(isSandboxDenial({type:'user',message:{content:[{type:'tool_result',_meta:{rawResponse:{sandboxDenied:true}}}]}}),true);
});

test('hub data is denied before any broader workspace or runtime rule', () => {
  const cwd = path.resolve('test-workspace'), data = path.join(cwd,'data');
  const policy = buildNativePolicy(cwd, path.join(data,'cli/bin/codebuddy'), [data]);
  assert.deepEqual(policy.orderedRules.file.rules[0], {id:'host-data-0',source:'user',path:data.replace(/\\/g,'/')+'/**',read:'deny',write:'deny',delete:'deny'});
  assert.equal(policy.orderedRules.file.rules.filter(r=>r.write==='allow').length,1);
  assert.throws(()=>buildNativePolicy(cwd, 'cli', ['relative']),/保护目录/);
});
