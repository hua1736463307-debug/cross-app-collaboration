import { buildNativePolicy, isSandboxDenial } from './codebuddy-policy.mjs';
// Dedicated process: no session or permission configuration leaks into another run.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
import readline from 'node:readline';
import { randomUUID } from 'node:crypto';
import { authenticateCodeBuddy } from './codebuddy-auth.mjs';

const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const pending = new Map();
const lines = readline.createInterface({ input: process.stdin });
let initialized = false;
let stopActive;
let disconnected = false;
lines.on('line', async line => {
  try {
    const input = JSON.parse(line);
    if (initialized) {
      const waiter = pending.get(input.id);
      if (waiter) { pending.delete(input.id); waiter(input.allow === true); }
      return;
    }
    initialized = true;
    if (process.platform !== 'win32') throw new Error('原生隔离执行当前仅支持 Windows');
    const policy = buildNativePolicy(input.cwd, input.cli, input.protectedDirectories || []);
    if (fs.realpathSync(input.cwd).toLowerCase() !== path.resolve(input.cwd).toLowerCase())
      throw new Error('执行目录的真实路径已变化，请在任务详情重新核对并授权');
    const packageRoot = path.dirname(path.dirname(input.cli));
    if (JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8')).version !== '2.177.1')
      throw new Error('原生隔离仅验收过 CodeBuddy 2.177.1，请重新验证后升级；不会退回无沙箱执行');
    if (!input.model) throw new Error('必须由用户明确选择 CodeBuddy 模型');
    const login = await authenticateCodeBuddy();
    if (disconnected) throw new Error('调度连接已关闭，取消执行');
    if (!login.userinfo?.token) throw new Error('CodeBuddy 登录不可用');
    const sdk = await import(pathToFileURL(path.join(path.dirname(path.dirname(input.cli)), 'server.mjs')).href);
    const host = await sdk.start({ sandboxUnavailable: 'fail', settingSources: [], env: { CODEBUDDY_INTERNET_ENVIRONMENT: 'internal' } });
    try {
      if (disconnected) throw new Error('调度连接已关闭，取消执行');
      const sessionId = randomUUID();
      stopActive = () => sdk.interrupt(sessionId).catch(() => {});
      const subscription = sdk.subscribe(sessionId, event => {
        send(event);
        if (isSandboxDenial(event)) {
          send({ type: 'hub.boundary', message: '原生沙箱拒绝了越界操作。请在任务详情核对证据；确认执行停止后，可调整执行目录并明确重试。不会绕过沙箱或自动扩大范围。' });
          process.exitCode = 1; stopActive?.();
        }
        if (event.type === 'system' && event.subtype === 'init' && event.model && event.model !== input.model) {
          send({ type: 'result', is_error: true, errors: '客户端模型与用户选择不一致，已中断' });
          process.exitCode = 1; stopActive?.();
        }
      }, { format: 'messages' });
      const result = await sdk.query(sessionId, input.prompt, {
        cwd: input.cwd, sandboxEnabled: true, model: input.model, effort: input.effort || undefined,
        auth: { accessToken: login.userinfo.token },
        account: { uid: login.userinfo.userId, enterpriseId: login.userinfo.enterpriseId },
        aiTitle: false, permissionMode: 'acceptEdits', agent: 'cli', maxTurns: 40,
        settingSources: [], strictMcpConfig: true, pluginRoots: [], remoteAgentsUrl: '', agentTeams: false,
        tools: ['Read', 'Write', 'Edit', 'Bash', 'PowerShell', 'Glob', 'Grep'],
        allowedTools: ['mcp__cross-app-workbuddy__get_task', 'mcp__cross-app-workbuddy__claim_task',
          'mcp__cross-app-workbuddy__heartbeat', 'mcp__cross-app-workbuddy__submit_result',
          'mcp__cross-app-workbuddy__report_blocked', 'mcp__cross-app-workbuddy__acknowledge_pause'],
        settings: { sandbox: policy,
          ...(input.probeApproval === true ? { permissions: { ask: ['Read'] } } : {}) },
        mcpServers: input.mcpServers,
        canUseTool: async (tool, args, options) => {
          // Approval does not authorize disabling the enforced sandbox.
          if (args?.dangerouslyDisableSandbox) return { behavior: 'deny', message: '本系统禁止绕过沙箱，请在任务外处理额外访问。' };
          const id = randomUUID();
          const allowed = await new Promise(resolve => {
            const timer = setTimeout(() => { pending.delete(id); resolve(false); }, 300000);
            pending.set(id, answer => { clearTimeout(timer); resolve(answer); });
            options?.signal?.addEventListener('abort', () => { clearTimeout(timer); pending.delete(id); resolve(false); }, { once: true });
            send({ type: 'hub.permission', id, tool, input: args });
          });
          send({ type: 'hub.permission_closed', id, allowed });
          return allowed ? { behavior: 'allow', updatedInput: args } : { behavior: 'deny', message: '用户拒绝或审批超时' };
        }
      });
      subscription.unsubscribe?.();
      send({ type: 'result', is_error: result.stopReason === 'error' || result.stopReason === 'aborted', errors: result.errorMessage || (result.stopReason === 'aborted' ? '执行已中断' : undefined) });
      if (['error','aborted'].includes(result.stopReason)) process.exitCode = 1;
    } finally { stopActive = null; await host.stop(); lines.close(); process.stdin.destroy(); }
  } catch (error) {
    send({ type: 'result', is_error: true, errors: error.message });
    process.exitCode = 1; lines.close(); process.stdin.destroy();
  }
});
lines.on('close', () => { disconnected = true; for (const answer of pending.values()) answer(false); pending.clear(); stopActive?.(); });
