import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { Store, HubError } from './store.mjs';
import { Scheduler } from './scheduler.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function json(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(payload));
}
async function body(req) {
  if (!(req.headers['content-type'] || '').startsWith('application/json')) throw new HubError('请使用 application/json', 415);
  let size = 0, chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1024 * 1024) throw new HubError('请求过大', 413);
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch { throw new HubError('JSON 格式不正确'); }
}
function lockDirectory(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const filename = path.join(dataDir, 'server.lock');
  try {
    fs.writeFileSync(filename, String(process.pid), { flag: 'wx' });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const pid = Number(fs.readFileSync(filename, 'utf8'));
    if (!Number.isInteger(pid) || pid <= 0) throw new Error('发现异常锁文件，请人工核对 ' + filename);
    let alive = true;
    try { process.kill(pid, 0); } catch (e) { if (e.code === 'ESRCH') alive = false; }
    if (alive) throw new Error('此数据目录已被运行中的服务使用，请使用现有窗口。');
    fs.unlinkSync(filename);
    fs.writeFileSync(filename, String(process.pid), { flag: 'wx' });
  }
  return () => {
    try { if (fs.readFileSync(filename, 'utf8') === String(process.pid)) fs.unlinkSync(filename); } catch {}
  };
}

export function createHub({ dataDir = path.join(root, 'data'), leaseMs = 90000, schedulerOptions = {} } = {}) {
  dataDir = path.resolve(dataDir);
  const unlock = lockDirectory(dataDir);
  let store;
  const tokens = {};
  try {
    for (const actor of ['codex', 'workbuddy']) {
      const filename = path.join(dataDir, actor + '.token');
      if (!fs.existsSync(filename)) fs.writeFileSync(filename, randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' });
      const value = fs.readFileSync(filename, 'utf8').trim();
      if (!/^[a-f0-9]{64}$/.test(value)) throw new Error('客户端令牌文件格式无效：' + actor);
      tokens[actor] = value;
    }
    store = new Store(path.join(dataDir, 'hub.sqlite'), { leaseMs });
  } catch (error) { unlock(); throw error; }
  let disposed = false;
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      const port = server.address()?.port;
      const hosts = ['127.0.0.1:' + port, 'localhost:' + port];
      if (!hosts.includes(req.headers.host)) throw new HubError('拒绝非本机地址请求', 403);
      const origin = req.headers.origin;
      if (origin && !hosts.some(host => origin === 'http://' + host)) throw new HubError('拒绝跨站请求', 403);
      const pageNavigation = req.method === 'GET' && req.url === '/' && req.headers['sec-fetch-mode'] === 'navigate' && req.headers['sec-fetch-dest'] === 'document';
      if (req.headers['sec-fetch-site'] === 'cross-site' && !pageNavigation) throw new HubError('拒绝跨站请求', 403);
      const url = new URL(req.url, 'http://127.0.0.1:' + port);
      const pathname = url.pathname;
      if (pathname === '/api/agent' && req.method === 'POST') {
        const header = req.headers['x-agent-token'];
        const actor = typeof header === 'string' ? Object.keys(tokens).find(key => {
          const a = Buffer.from(header), b = Buffer.from(tokens[key]);
          return a.length === b.length && timingSafeEqual(a, b);
        }) : null;
        if (!actor) throw new HubError('客户端身份校验失败', 401);
        const input = await body(req);
        return json(res, 200, store.agent(actor, input.tool, input.arguments || {}, req.headers['x-hub-dispatch-id']));
      }
      if (pathname.startsWith('/api/') && req.method === 'POST' && req.headers['x-hub-ui'] !== '1')
        throw new HubError('缺少本地工作台请求标记', 403);
      if (pathname === '/api/state' && req.method === 'GET') {
        return json(res, 200, { ...store.state(), scheduler: scheduler.state(), meta: {
          version: '0.3.0', localOnly: true, capabilities: { autoWake: true, existingDesktopChatControl: false },
          baseUrl: 'http://127.0.0.1:' + port
        } });
      }
      if (pathname === '/api/integration' && req.method === 'GET') {
        const config = actor => ({ mcpServers: {
          ['cross-app-' + actor]: { command: process.execPath, args: [path.join(root, 'src', 'mcp.mjs'), '--actor', actor],
            env: { HUB_URL: 'http://127.0.0.1:' + port, HUB_DATA_DIR: dataDir } }
        } });
        return json(res, 200, {
          configs: { codex: config('codex'), workbuddy: config('workbuddy') }, projectRoot: root,
          instructions: '先启动本地服务，再在各应用的 MCP 设置中新增对应 stdio 服务。不要覆盖现有配置。接入后，在应用内明确要求调用 list_tasks、claim_task 并按任务单执行。',
          limitations: [
            '可为授权任务自动启动独立 CLI 执行会话，不遥控已有桌面聊天。请先配置并启用自动协作。',
            '已连接仅表示最近 90 秒收到 MCP 调用或桥心跳，不表示模型正在工作。',
            '暂停为协作请求；只有执行端确认停止后才释放占用，不能强制终止外部进程。',
            '请勿同时从系统外让两边修改同一项目；本系统无法阻止绕过任务领取的写入。',
            '本地存储不等于模型离线。客户端发给模型的内容仍遵循各应用的数据策略。'
          ]
        });
      }
      if (pathname === '/api/projects' && req.method === 'POST') return json(res, 201, store.createProject(await body(req)));
      if (pathname === '/api/tasks' && req.method === 'POST') return json(res, 201, store.createTask(await body(req)));
      if (pathname === '/api/scheduler' && req.method === 'POST') return json(res, 200, store.setSchedulerEnabled((await body(req)).enabled));
      if (pathname === '/api/scheduler/model-settings' && req.method === 'POST') return json(res, 200, store.setModelSettings(await body(req)));
      const taskModelSettings = pathname.match(/^\/api\/tasks\/([a-f0-9-]+)\/model-settings$/);
      if (taskModelSettings && req.method === 'POST') return json(res, 200, store.setTaskModelSettings(taskModelSettings[1], await body(req)));
      const automation = pathname.match(/^\/api\/tasks\/([a-f0-9-]+)\/automation$/);
      if (automation && req.method === 'POST') return json(res, 200, store.setTaskAutomation(automation[1], (await body(req)).enabled));
      const resolution = pathname.match(/^\/api\/scheduler\/runs\/([a-f0-9-]+)\/resolve$/);
      if (resolution && req.method === 'POST') return json(res, 200, scheduler.resolve(resolution[1], await body(req)));
      const action = pathname.match(/^\/api\/tasks\/([a-f0-9-]+)\/action$/);
      if (action && req.method === 'POST') return json(res, 200, store.action(action[1], await body(req)));
      const packet = pathname.match(/^\/api\/tasks\/([a-f0-9-]+)\/packet$/);
      if (packet && req.method === 'GET') return json(res, 200, { text: store.packet(packet[1]) });
      if (pathname === '/health' && req.method === 'GET') return json(res, 200, { ok: true, name: '跨应用协作系统' });
      const assets = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'], '/favicon.ico': null };
      if (req.method === 'GET' && Object.hasOwn(assets, pathname)) {
        if (!assets[pathname]) { res.writeHead(204); return res.end(); }
        const [file, type] = assets[pathname];
        const content = fs.readFileSync(path.join(root, 'public', file));
        res.writeHead(200, { 'Content-Type': type + '; charset=utf-8', 'Cache-Control': 'no-cache' });
        return res.end(content);
      }
      throw new HubError('接口不存在', 404);
    } catch (error) {
      if (!res.headersSent) json(res, error.status || 500, { error: error.status ? error.message : '本地服务异常，请查看服务日志。' });
      else res.end();
      if (!error.status) console.error('[hub]', error.message);
    }
  });
  const scheduler = new Scheduler(store, { root, dataDir, getURL: () => server.listening ? 'http://127.0.0.1:' + server.address().port : null, ...schedulerOptions });
  const timer = setInterval(() => { try { store.expire(); } catch (e) { console.error('[hub]', e.message); } }, Math.min(15000, leaseMs));
  timer.unref();
  const dispose = () => {
    if (disposed) return;
    disposed = true; clearInterval(timer); scheduler.close(); store.close(); unlock();
  };
  server.once('close', dispose);
  server.once('error', dispose);
  return { server, store, scheduler, dataDir, dispose };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const port = Number(process.env.HUB_PORT || 4318);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('HUB_PORT 必须为 1024–65535');
    const hub = createHub({ dataDir: process.env.HUB_DATA_DIR || path.join(root, 'data') });
    hub.server.listen(port, '127.0.0.1', () => console.log('跨应用协作系统已启动：http://127.0.0.1:' + port + '\n数据仅存于：' + hub.dataDir + '\n按 Ctrl+C 停止服务。'));
    hub.server.on('error', error => { console.error('启动失败：' + error.message); process.exitCode = 1; });
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => hub.server.close(() => process.exit(0)));
  } catch (error) { console.error('启动失败：' + error.message); process.exitCode = 1; }
}
