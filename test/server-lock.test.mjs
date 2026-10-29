import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { lockDirectory } from '../src/server-lock.mjs';

function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-lock-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
test('OS ownership blocks duplicates and permits restart after release', t => {
  const dir = temp(t), release = lockDirectory(dir);
  try { assert.throws(() => lockDirectory(dir), /运行中的服务/); }
  finally { release(); }
  lockDirectory(dir)();
});
test('legacy unrelated PID is recovered but unknown owner is preserved', t => {
  const dir = temp(t), file = path.join(dir, 'server.lock');
  fs.writeFileSync(file, '1796');
  assert.throws(() => lockDirectory(dir, { inspectLegacy: () => 'unknown' }), /无法确认/);
  assert.equal(fs.readFileSync(file, 'utf8'), '1796');
  const release = lockDirectory(dir, { inspectLegacy: () => 'stale' });
  assert.equal(JSON.parse(fs.readFileSync(file)).version, 2);
  release();
});
test('forced process exit releases OS lock despite leftover metadata', async t => {
  let child;
  t.after(async () => { if (child && child.exitCode === null && child.signalCode === null) { const done = once(child, 'exit'); child.kill('SIGKILL'); await done; } });
  const dir = temp(t), moduleURL = new URL('../src/server-lock.mjs', import.meta.url).href;
  child = spawn(process.execPath, ['--input-type=module', '-e',
    `import { lockDirectory } from ${JSON.stringify(moduleURL)}; const release=lockDirectory(process.argv[1]); console.log('ready'); setInterval(()=>{ if (!release) process.exit(2); },1000);`, dir],
  { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { const done = once(child, 'exit'); child.kill('SIGKILL'); await done; } });
  const ready = await Promise.race([once(child.stdout, 'data'), once(child, 'exit').then(() => { throw new Error('child exited before lock'); })]);
  assert.match(String(ready[0]), /ready/);
  assert.throws(() => lockDirectory(dir), /运行中的服务/);
  const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
  assert.ok(fs.existsSync(path.join(dir, 'server.lock')));
  lockDirectory(dir)();
});
