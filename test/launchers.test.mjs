import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildLaunch, discoverLaunchers, launcherState, projectFileRules } from '../src/launchers.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cross-app-launchers-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dir).startsWith('cross-app-launchers-'));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}
function configure(dir, value) { fs.writeFileSync(path.join(dir, 'launchers.json'), JSON.stringify(value)); }
function withEnvironment(values, run) {
  const saved = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(values)) process.env[key] = value;
    return run();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}

test('invalid launcher JSON and root types disable adapters without throwing', t => {
  const dir = temp(t);
  for (const value of [null, [], false, 12, 'launcher']) {
    configure(dir, value);
    const result = discoverLaunchers(dir);
    assert.equal(result.codex, null); assert.equal(result.workbuddy, null); assert.ok(result.error);
  }
  fs.writeFileSync(path.join(dir, 'launchers.json'), '{invalid');
  assert.ok(discoverLaunchers(dir).error);
});

test('invalid launcher field types and executor values fail closed', t => {
  const dir = temp(t);
  for (const value of [{ codex: null }, { workbuddy: 1 }, { codex: [] }, { workbuddy: {} }, { codex: '' },
    { executor: null }, { executor: 'codebudddy' }]) {
    configure(dir, value);
    const result = discoverLaunchers(dir);
    assert.equal(result.codex, null); assert.equal(result.workbuddy, null); assert.ok(result.error);
  }
});

test('discovery handles missing paths, directories and failed stat without breaking the hub', t => {
  const dir = temp(t), missing = path.join(dir, 'missing.js');
  configure(dir, { codex: missing, workbuddy: dir });
  assert.equal(discoverLaunchers(dir).codex, null);
  assert.equal(discoverLaunchers(dir).workbuddy, null);
  configure(dir, { codex: path.join(dir, 'blocked.js'), workbuddy: missing });
  const originalStat = fs.statSync;
  try {
    fs.statSync = () => { const error = new Error('fixture access denied'); error.code = 'EACCES'; throw error; };
    const result = discoverLaunchers(dir);
    assert.equal(result.codex, null); assert.equal(result.workbuddy, null);
  } finally { fs.statSync = originalStat; }
});

test('executor selection keeps workbuddy as the task role and labels the independent CLI', t => {
  const dir = temp(t), file = path.join(dir, 'fixture-cli.js');
  fs.writeFileSync(file, '// test-only file, never executed');
  configure(dir, { codex: file, workbuddy: file });
  assert.equal(discoverLaunchers(dir).executor, 'workbuddy');
  configure(dir, { codex: file, workbuddy: file, executor: 'codebuddy' });
  const result = discoverLaunchers(dir);
  assert.equal(result.executor, 'codebuddy'); assert.equal(result.workbuddy, file);
  assert.equal(launcherState(result).workbuddy.label, 'CodeBuddy Code 独立会话');
});

test('Codex launcher explicitly retains workspace-write sandbox and automatic approval review', t => {
  const dir = temp(t);
  const spec = buildLaunch({ actor: 'codex', paths: { codex: path.join(dir, 'codex.js') }, root, dataDir: dir,
    url: 'http://127.0.0.1:4319', run: { id: 'fixture', taskId: 'fixture-task' }, project: { path: dir } });
  assert.ok(spec.args.includes('sandbox_mode="workspace-write"'));
  assert.equal(spec.args.includes('--sandbox'), false, 'CLI rejects --sandbox together with --approve-for-me');
  assert.ok(spec.args.includes('--approve-for-me'));
  assert.equal(spec.args.includes('--dangerously-bypass-approvals-and-sandbox'), false);
});

test('independent CodeBuddy drops inherited WorkBuddy roots and preserves default approvals', t => {
  const dir = temp(t);
  const contaminated = { CODEBUDDY_FORCE_LITE_WB_BUNDLE: '1', CODEBUDDY_CONFIG_DIR: 'fixture-workbuddy',
    WORKBUDDY_CONFIG_DIR: 'fixture-workbuddy', WORKBUDDY_DATA_FOLDER_NAME: '.workbuddy', WORKBUDDY_EXTRA_MODE: 'fixture',
    CODEBUDDY_CODE_DISABLE_BACKGROUND_TASKS: '0' };
  withEnvironment(contaminated, () => {
    const spec = buildLaunch({ actor: 'workbuddy', paths: { executor: 'codebuddy', workbuddy: path.join(dir, 'codebuddy.js') }, root,
      dataDir: dir, url: 'http://127.0.0.1:4319', run: { id: 'fixture', taskId: 'fixture-task' }, project: { path: dir } });
    for (const key of Object.keys(contaminated).filter(key => key !== 'CODEBUDDY_CODE_DISABLE_BACKGROUND_TASKS')) assert.equal(spec.env[key], undefined, key);
    assert.equal(spec.env.CODEBUDDY_CODE_DISABLE_BACKGROUND_TASKS, '1');
    assert.equal(spec.args[spec.args.indexOf('--permission-mode') + 1], 'default');
    const allowed = spec.args.slice(spec.args.indexOf('--allowedTools') + 1);
    assert.equal(allowed.length, 11);
    assert.ok(allowed.includes('mcp__cross-app-workbuddy__claim_task'));
    assert.deepEqual(allowed.filter(rule => !rule.startsWith('mcp__')), projectFileRules(dir));
    assert.equal(spec.env.CODEBUDDY_DEFER_TOOL_LOADING, '0');
    assert.ok(spec.args.includes('--strict-mcp-config'));
    const config = JSON.parse(fs.readFileSync(spec.args[spec.args.indexOf('--mcp-config') + 1], 'utf8'));
    assert.deepEqual(Object.keys(config.mcpServers), ['cross-app-workbuddy']);
    assert.equal(config.mcpServers['cross-app-workbuddy'].defer_loading, false);
    assert.deepEqual(config.mcpServers['cross-app-workbuddy'].args.slice(-2), ['--actor', 'workbuddy']);
    assert.equal(process.env.CODEBUDDY_CONFIG_DIR, 'fixture-workbuddy', 'parent environment is unchanged');
  });
});

test('file scopes retain absolute Chinese and space-containing directories as single CLI arguments', t => {
  const dir = temp(t), project = path.join(dir, '中文项目 with spaces');
  const expected = path.resolve(project).replace(/\\/g, '/') + '/**';
  assert.deepEqual(projectFileRules(project), ['Read', 'Edit', 'Write'].map(tool => tool + '(' + expected + ')'));
  const spec = buildLaunch({ actor: 'workbuddy', paths: { executor: 'codebuddy', workbuddy: path.join(dir, 'codebuddy.js') }, root,
    dataDir: dir, url: 'http://127.0.0.1:4319', run: { id: 'fixture', taskId: 'fixture-task' }, project: { path: project } });
  assert.ok(spec.args.includes('Write(' + expected + ')'));
  assert.equal(spec.args.includes('Write'), false);
});

test('ambiguous file scopes fail closed instead of becoming wider permission rules', t => {
  const dir = temp(t);
  for (const suffix of ['a,b', 'a(b)', 'a[bc]', 'a{b}', 'a*', 'a?', '!a', 'a+b', '@a', 'a|b', 'a\nb', 'a\u007fb']) {
    assert.throws(() => projectFileRules(path.join(dir, suffix)), /权限规则/);
  }
  assert.throws(() => projectFileRules('relative-project'), /权限规则/);
});
