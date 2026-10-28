#!/usr/bin/env node
// Read-only. Never load auth files, local tokens, trust stores or the AI edition.
import { stat, readFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { get as httpGet } from 'node:http';
import { resolve, join, dirname, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BRIDGE = join(ROOT, 'src', 'mcp.mjs');
const DATA = resolve(process.env.HUB_DATA_DIR || join(ROOT, 'data'));
const MAX_CONFIG = 2 * 1024 * 1024, MAX_STATE = 8 * 1024 * 1024;
const help = [
  '跨应用协作系统 — 只读接入诊断', '',
  '用法：node scripts/check-integrations.mjs [--hub-url http://127.0.0.1:4318]',
  '      node scripts/check-integrations.mjs --help', '',
  '检查：当前 Node 版本与桥文件；Codex 指定 MCP 配置段；',
  '      国内版 ~/.workbuddy/mcp.json 的 cross-app-workbuddy 条目；',
  '      本机 GET /api/state 及其中 Codex/WorkBuddy 的最近心跳。', '',
  '不执行模型或 MCP 工具，不发心跳，不创建/修改任务，不修改配置。',
  '不读取 auth、trust、令牌文件，也不访问 .workbuddy-ai 或外部网络。',
  'Codex 检查只识别目标段中生成器使用的常见 TOML 字面量，不是完整 TOML 解析。',
  '不输出配置原文、任意配置值、任务内容或密钥。', '',
  '环境：HUB_URL（默认 http://127.0.0.1:4318）、HUB_DATA_DIR、CODEX_HOME。',
  '输出：脱敏 JSON。运行时、桥文件、配置和服务检查通过退出 0；基础检查失败退出 1。',
  '心跳是信息观察项，闲置/过期不影响退出码，也不表示配置损坏。心跳不证明模型运行或任务推进。'
].join('\n');
function samePath(a, b) {
  if (typeof a !== 'string' || !a || !isAbsolute(a)) return false;
  const normalize = value => {
    const path = resolve(value).replace(/[\\/]+$/, '');
    return process.platform === 'win32' ? path.toLowerCase() : path;
  };
  return normalize(a) === normalize(b);
}
function isObject(value) { return !!value && typeof value === 'object' && !Array.isArray(value); }
function safeError(error) {
  if (error?.code === 'ENOENT') return 'FILE_MISSING';
  if (error?.code === 'EACCES' || error?.code === 'EPERM') return 'ACCESS_DENIED';
  return error?.diagnosticCode || 'CHECK_FAILED';
}
function fail(code) { const error = new Error(code); error.diagnosticCode = code; throw error; }
async function fileExists(path) {
  try { return (await stat(path)).isFile(); } catch { return false; }
}
function hubURL(raw) {
  let url;
  try { url = new URL(raw); } catch { fail('INVALID_HUB_URL'); }
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
      url.username || url.password || url.search || url.hash || url.pathname !== '/') fail('NON_LOCAL_OR_INVALID_HUB_URL');
  return url;
}
function sameHub(a, expected) {
  try {
    const parsed = hubURL(a);
    const host = value => value === 'localhost' ? '127.0.0.1' : value;
    return host(parsed.hostname) === host(expected.hostname) && parsed.port === expected.port;
  } catch { return false; }
}
async function validNodeCommand(command) {
  // Never spawn a command obtained from config.
  if (samePath(command, process.execPath)) return fileExists(process.execPath);
  if (command !== 'node' && command !== 'node.exe') return false;
  for (const entry of (process.env.PATH || '').split(process.platform === 'win32' ? ';' : ':')) {
    if (!entry) continue;
    const candidate = join(entry.replace(/^"|"$/g, ''), process.platform === 'win32' ? 'node.exe' : 'node');
    if (await fileExists(candidate)) return samePath(candidate, process.execPath);
  }
  return false;
}
function restrictedLiteral(raw) {
  const value = raw.trim();
  if (value.startsWith("'") && value.endsWith("'") && !value.includes("'''")) return value.slice(1, -1);
  try { return JSON.parse(value); } catch { return undefined; }
}
async function codexTargetStanza(path) {
  const info = await stat(path);
  if (!info.isFile() || info.size > MAX_CONFIG) fail('CONFIG_NOT_FILE_OR_TOO_LARGE');
  const stream = createReadStream(path, { encoding: 'utf8' });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let scope = null, entrySeen = false, duplicate = false, envSeen = false, unsupported = false;
  const selected = {}, environment = {};
  const target = "(?:cross-app-codex|\"cross-app-codex\"|'cross-app-codex')";
  const baseHeader = new RegExp('^\\[\\s*mcp_servers\\s*\\.\\s*' + target + '\\s*\\]\\s*(?:#.*)?$');
  const envHeader = new RegExp('^\\[\\s*mcp_servers\\s*\\.\\s*' + target + '\\s*\\.\\s*env\\s*\\]\\s*(?:#.*)?$');
  try {
    for await (const sourceLine of lines) {
      const line = sourceLine.replace(/^\uFEFF/, '').trim();
      if (line.startsWith('[')) {
        if (baseHeader.test(line)) { duplicate ||= entrySeen; entrySeen = true; scope = 'entry'; }
        else if (envHeader.test(line)) { duplicate ||= envSeen; envSeen = true; scope = 'env'; }
        else scope = null;
        continue;
      }
      // Ignore every other section, including providers, trust and auth settings.
      if (!scope || !line || line.startsWith('#')) continue;
      const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
      if (!match) { unsupported = true; continue; }
      const allowed = scope === 'entry' ? ['command', 'args', 'enabled', 'env'] : ['HUB_URL', 'HUB_DATA_DIR'];
      if (!allowed.includes(match[1])) continue;
      if (match[1] === 'env') { unsupported = true; continue; }
      const destination = scope === 'entry' ? selected : environment;
      if (Object.hasOwn(destination, match[1])) duplicate = true;
      const parsed = restrictedLiteral(match[2]);
      if (parsed === undefined) unsupported = true;
      destination[match[1]] = parsed;
    }
  } finally { lines.close(); stream.destroy(); }
  return { entrySeen, duplicate, unsupported, selected, environment };
}
async function validateEntry(entry, actor, expectedHub, env = entry?.env || {}) {
  const args = entry?.args;
  const details = {
    nodeCommandMatches: await validNodeCommand(entry?.command),
    bridgeAndActorMatch: Array.isArray(args) && args.length === 3 && samePath(args[0], BRIDGE) && args[1] === '--actor' && args[2] === actor,
    enabled: entry?.enabled !== false && entry?.disabled !== true,
    stdio: !entry?.type || entry.type === 'stdio',
    localHubMatches: isObject(env) && sameHub(env.HUB_URL || 'http://127.0.0.1:4318', expectedHub),
    dataDirectoryMatches: isObject(env) && samePath(env.HUB_DATA_DIR || join(ROOT, 'data'), DATA)
  };
  return { ok: Object.values(details).every(value => value === true), ...details };
}
function fetchLocalState(url) {
  return new Promise((resolvePromise, reject) => {
    // node:http does not auto-discover proxies; avoid DNS by using numeric loopback.
    const hostname = url.hostname === 'localhost' ? '127.0.0.1' : url.hostname.replace(/^\[|\]$/g, '');
    let settled = false, timer;
    const finish = (error, value) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (error) reject(error); else resolvePromise(value);
    };
    const request = httpGet({ hostname, port: url.port || 80, path: '/api/state', headers: { accept: 'application/json' } }, response => {
      if (response.statusCode !== 200) {
        response.resume();
        const error = new Error('Local HTTP failure'); error.diagnosticCode = 'HUB_HTTP_' + response.statusCode;
        finish(error); return;
      }
      let total = 0;
      const chunks = [];
      response.on('data', chunk => {
        total += chunk.length;
        if (total > MAX_STATE) {
          const error = new Error('State too large'); error.diagnosticCode = 'HUB_RESPONSE_TOO_LARGE';
          finish(error); response.destroy(); request.destroy(); return;
        }
        chunks.push(chunk);
      });
      response.on('error', () => { const error = new Error('Response failed'); error.diagnosticCode = 'HUB_RESPONSE_FAILED'; finish(error); });
      response.on('end', () => {
        if (settled) return;
        try { finish(null, JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch { const error = new Error('Invalid JSON'); error.diagnosticCode = 'HUB_INVALID_JSON'; finish(error); }
      });
    });
    timer = setTimeout(() => {
      const error = new Error('Local timeout'); error.diagnosticCode = 'HUB_TIMEOUT';
      finish(error); request.destroy();
    }, 3500);
    request.on('error', () => {
      const error = new Error('Local connection failed'); error.diagnosticCode = 'HUB_UNREACHABLE';
      finish(error);
    });
  });
}
async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) { console.log(help); return; }
  if (args.length && !(args.length === 2 && args[0] === '--hub-url')) fail('INVALID_ARGUMENTS');
  const url = hubURL(args[1] || process.env.HUB_URL || 'http://127.0.0.1:4318');
  const checks = [];
  checks.push({ check: 'node_runtime', ok: Number(process.versions.node.split('.')[0]) >= 24 && await fileExists(process.execPath), version: process.versions.node });
  checks.push({ check: 'bridge_file', ok: await fileExists(BRIDGE), pathHint: '项目/src/mcp.mjs' });
  const codexPath = join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'config.toml');
  try {
    const stanza = await codexTargetStanza(codexPath);
    const fields = await validateEntry(stanza.selected, 'codex', url, stanza.environment);
    checks.push({
      check: 'codex_configuration', ok: stanza.entrySeen && !stanza.duplicate && !stanza.unsupported && fields.ok,
      pathHint: 'CODEX_HOME/config.toml', scope: 'mcp_servers.cross-app-codex only',
      method: 'target-stanza heuristic; not a complete TOML parse',
      sectionFound: stanza.entrySeen, duplicateSectionOrKey: stanza.duplicate,
      unsupportedLiteralLayout: stanza.unsupported, expectedFields: fields
    });
  } catch (error) { checks.push({ check: 'codex_configuration', ok: false, code: safeError(error), pathHint: 'CODEX_HOME/config.toml' }); }
  try {
    const target = join(homedir(), '.workbuddy', 'mcp.json');
    const info = await stat(target);
    if (!info.isFile() || info.size > MAX_CONFIG) fail('CONFIG_NOT_FILE_OR_TOO_LARGE');
    let document;
    try { document = JSON.parse((await readFile(target, 'utf8')).replace(/^\uFEFF/, '')); }
    catch { fail('WORKBUDDY_INVALID_JSON'); }
    const entry = isObject(document?.mcpServers) ? document.mcpServers['cross-app-workbuddy'] : undefined;
    const fields = await validateEntry(entry, 'workbuddy', url);
    checks.push({
      check: 'workbuddy_configuration', ok: isObject(entry) && fields.ok,
      pathHint: '[USERPROFILE]/.workbuddy/mcp.json', edition: 'WorkBuddy 国内版',
      entryFound: isObject(entry), expectedFields: fields
    });
  } catch (error) { checks.push({ check: 'workbuddy_configuration', ok: false, code: safeError(error), pathHint: '[USERPROFILE]/.workbuddy/mcp.json' }); }
  let state;
  try {
    state = await fetchLocalState(url);
    const valid = isObject(state) && Array.isArray(state.agents) && state.meta?.localOnly === true;
    checks.push({ check: 'local_hub_state', ok: valid, endpoint: url.origin + '/api/state', method: 'GET', localOnlyConfirmed: state?.meta?.localOnly === true });
    if (!valid) state = undefined;
  } catch (error) { checks.push({ check: 'local_hub_state', ok: false, code: safeError(error), endpoint: url.origin + '/api/state', method: 'GET' }); }
  const configurationAndServiceOk = checks.every(check => check.ok);
  for (const actor of ['codex', 'workbuddy']) {
    const record = state?.agents.find(item => item?.id === actor);
    const millis = typeof record?.lastSeen === 'string' ? Date.parse(record.lastSeen) : NaN;
    const age = Date.now() - millis;
    const validDate = Number.isFinite(millis) && age >= -30000;
    const fresh = validDate && age <= 90000 && record.connected === true;
    checks.push({
      check: actor + '_heartbeat', ok: !!fresh, fresh: !!fresh, severity: 'info', requiredForSuccess: false,
      lastSeen: validDate ? new Date(millis).toISOString() : null,
      ageSeconds: validDate ? Math.max(0, Math.round(age / 1000)) : null,
      recentBridgeActivity: !!fresh, modelRunningVerified: false,
      code: !state ? 'HUB_STATE_UNAVAILABLE' : fresh ? 'RECENT_BRIDGE_ACTIVITY_ONLY' : 'NO_RECENT_BRIDGE_ACTIVITY'
    });
  }
  const allClientsRecentlyActive = checks.filter(check => check.check.endsWith('_heartbeat')).every(check => check.fresh);
  const ok = configurationAndServiceOk;
  console.log(JSON.stringify({
    system: '跨应用协作系统', readOnly: true, ok, configurationAndServiceOk, allClientsRecentlyActive,
    note: '仅检查目标配置及现有心跳。总结果及退出码只依据运行时、桥文件、配置和服务；闲置心跳仅供观察，不代表接入损坏。未发送心跳、调用模型或修改任务；心跳不等同模型运行或任务进展。',
    codexParsingLimit: '只检查指定 MCP 段的常见字面量；失败可能需要人工检查该段格式，不代表整个 TOML 无效。',
    checks
  }, null, 2));
  process.exitCode = ok ? 0 : 1;
}
main().catch(error => {
  console.log(JSON.stringify({ system: '跨应用协作系统', readOnly: true, ok: false, code: safeError(error), hint: '运行 --help 查看本地诊断用法。' }, null, 2));
  process.exitCode = 1;
});
