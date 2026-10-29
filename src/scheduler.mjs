import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { buildLaunch, discoverLaunchers, launcherState } from './launchers.mjs';
import { HubError } from './store.mjs';

export class Scheduler {
  constructor(store, { root, dataDir, getURL, launch = spawn, paths, intervalMs = 1000, claimMs = 180000, runMs = 1200000 } = {}) {
    Object.assign(this, { store, root, dataDir, getURL, launch, paths: paths || discoverLaunchers(dataDir), claimMs, runMs });
    this.children = new Map(); this.closed = false;
    this.permissions = new Map(); this.nativeRuns = new Set();
    this.timer = setInterval(() => this.tick(), intervalMs); this.timer.unref();
  }
  state() { return { ...this.store.schedulerState(), adapters: launcherState(this.paths), permissions: [...this.permissions.values()].map(({ child, ...request }) => request) }; }
  decidePermission(id, allow) {
    const request = this.permissions.get(id);
    if (!request || !this.children.has(request.runId)) throw new HubError('审批已失效', 409);
    if (Date.now() - Date.parse(request.createdAt) >= 300000) {
      this.permissions.delete(id);
      this.store.failDispatch(request.runId, '工具审批超时，已停止自动流转，等待人工决定。');
      request.child.stdin.end?.();
      throw new HubError('审批已超时，不能继续授权', 409);
    }
    if (typeof allow !== 'boolean') throw new HubError('审批决定必须为布尔值');
    const run = this.store.getDispatch(request.runId);
    if (!['launching', 'running'].includes(run.state) || run.handedOff) throw new HubError('执行已结束，审批失效', 409);
    const task = this.store.getTask(run.taskId);
    if (task.pauseRequested || !task.autoEnabled) throw new HubError('任务已暂停或撤回自动执行授权', 409);
    request.child.stdin.write(JSON.stringify({ id, allow }) + '\n');
    this.permissions.delete(id);
    this.store.event(run.taskId, 'permission_decided', 'human', (allow ? '仅本次允许：' : '拒绝：') + request.tool);
    if (!allow) this.store.failDispatch(run.id, '用户拒绝本次工具操作。已停止自动流转，等待人工决定；不会改用其他工具重试。');
    return { ok: true };
  }
  tick() {
    if (this.closed || !this.getURL()) return;
    try {
      this.store.expireDispatches({ claimMs: this.claimMs, runMs: this.runMs });
      for (const id of this.nativeRuns) {
        const run = this.store.getDispatch(id), task = this.store.getTask(run.taskId);
        if (task.pauseRequested || !task.autoEnabled || run.state === 'uncertain') this.children.get(id)?.stdin.end();
      }
      for (const [id, request] of this.permissions) {
        if (Date.now() - Date.parse(request.createdAt) >= 300000) {
          request.child.stdin.write(JSON.stringify({id, allow:false}) + '\n'); this.permissions.delete(id);
          this.store.failDispatch(request.runId, '工具审批超时，已停止自动流转，等待人工决定。');
        }
      }
      for (const actor of ['codex', 'workbuddy']) {
        const run = this.store.reserveDispatch(actor);
        if (!run) continue;
        try { this.start(run); }
        catch (error) { this.store.failDispatch(run.id, error.code === 'MODEL_SELECTION_REQUIRED' ? error.message : '启动失败：请检查 CLI 路径、项目目录与本机日志，确认停止后再安排。'); }
        break;
      }
    } catch (error) { console.error('[scheduler]', error.message); }
  }
  start(run) {
    if (run.actor === 'workbuddy' && !run.requestedModel?.model) {
      const error = new Error('未选择 CodeBuddy 模型：请由用户在默认设置或本任务中明确选择模型后再安排执行；不会使用客户端默认模型。');
      error.code = 'MODEL_SELECTION_REQUIRED';
      throw error;
    }
    this.store.tx(() => { const record = this.store.getDispatch(run.id); record.adapterLabel = launcherState(this.paths)[run.actor].label; this.store.saveDispatch(record); });
    const spec = buildLaunch({ actor: run.actor, paths: this.paths, root: this.root, dataDir: this.dataDir,
      url: this.getURL(), run, project: this.store.getProject(this.store.getTask(run.taskId).projectId) });
    const child = this.launch(spec.command, spec.args, { cwd: spec.cwd, env: spec.env, shell: false, windowsHide: true, stdio: ['pipe','pipe','pipe'] });
    this.children.set(run.id, child);
    if (spec.host) this.nativeRuns.add(run.id);
    let bytes = 0, outputBuffer = '', clientFailure = null;
    const log = chunk => {
      if (bytes >= 1024 * 1024) return;
      const part = Buffer.from(chunk).subarray(0, 1024 * 1024 - bytes); bytes += part.length;
      try { fs.appendFileSync(path.join(spec.runDir, 'output.log'), part); } catch { /* Logging cannot change task ownership. */ }
    };
    child.stdout.on('data', log); child.stderr.on('data', log);
    child.stdout.on('data', chunk => {
      outputBuffer += chunk.toString();
      const lines = outputBuffer.split('\n'); outputBuffer = lines.pop().slice(-65536);
      for (const line of lines) {
        if (line.length > 65536) continue;
        try {
          const event = JSON.parse(line);
          if (event.type === 'hub.boundary' && spec.host) {
            clientFailure = '原生沙箱阻止越界操作，执行已中断。确认进程停止并释放预约后，可在任务详情调整执行目录，再明确重试；不会自动扩大范围。';
            this.store.failDispatch(run.id, clientFailure);
          }
          if (event.type === 'hub.permission' && spec.host && typeof event.id === 'string' && typeof event.tool === 'string') {
            this.permissions.set(event.id, { id: event.id, runId: run.id, taskId: run.taskId,
              tool: event.tool, input: event.input, createdAt: new Date().toISOString(), child });
          }
          if (event.type === 'hub.permission_closed' && spec.host && this.permissions.get(event.id)?.runId === run.id) {
            this.permissions.delete(event.id);
            if (event.allowed === false) this.store.failDispatch(run.id, '工具审批被拒绝、取消或超时，已停止自动流转。');
          }
          if (event.type === 'system' && event.subtype === 'init' && typeof event.model === 'string' && event.model.length <= 100) {
            this.store.tx(() => { const record = this.store.getDispatch(run.id); record.reportedModel = event.model; if (typeof event.reasoning_effort === 'string' && event.reasoning_effort.length <= 32) record.reportedEffort = event.reasoning_effort; this.store.saveDispatch(record); });
          }
          if ((event.type === 'result' && event.is_error) || event.type === 'turn.failed') {
            const message = JSON.stringify(event.errors || event.error || '');
            clientFailure ||= /authentication|login|sign in|unauthorized/i.test(message)
              ? '执行客户端尚未登录或登录失效，请通过该 CLI 的正规登录入口登录后重新安排。'
              : '执行客户端报告失败：所选模型或推理强度可能不可用，也可能是权限或其他客户端错误；请检查本机日志。本轮不会自动更换或重试。';
          }
        } catch { /* Non-JSON progress lines are local diagnostics only. */ }
      }
    });
    child.stdin.on('error', () => {});
    child.once('spawn', () => {
      if (this.closed) return;
      try {
        this.store.markDispatchStarted(run.id, child.pid);
        if (spec.host) child.stdin.write(JSON.stringify({ ...spec.host, prompt: spec.prompt }) + '\n');
        else child.stdin.end(spec.prompt);
      } catch {
        // A pause can invalidate the reservation while the OS is starting the child.
        this.store.tx(() => { const pending = this.store.getDispatch(run.id); pending.pid = child.pid; this.store.saveDispatch(pending); });
        child.stdin.end();
        this.store.failDispatch(run.id, '启动期间任务已暂停或授权被撤回；请核对新进程已停止。');
      }
    });
    child.once('error', () => { if (!this.closed) this.store.failDispatch(run.id, '无法启动执行进程，请检查本机 CLI 配置。'); });
    child.once('close', code => {
      this.children.delete(run.id);
      this.nativeRuns.delete(run.id);
      for (const [id, request] of this.permissions) if (request.runId === run.id) this.permissions.delete(id);
      if (!this.closed) {
        const record = this.store.getDispatch(run.id);
        if (record.requestedModel?.model && record.reportedModel && record.requestedModel.model !== record.reportedModel) clientFailure = '客户端报告的模型与请求的模型不一致；已停止自动流转，请检查模型或客户端回退配置。';
        if (record.requestedModel?.effort && record.reportedEffort && record.requestedModel.effort !== record.reportedEffort) clientFailure = '客户端报告的推理强度与请求的强度不一致；已停止自动流转，请检查客户端配置。';
        if (clientFailure && record.state !== 'uncertain') this.store.failDispatch(run.id, clientFailure);
        else this.store.finishDispatch(run.id, { code, error: code === 0 ? null : '执行进程异常退出；请检查所选模型、推理强度和本机日志。系统不会自动更换模型或降低强度。' });
      }
    });
  }
  resolve(id, input) {
    if (this.children.has(id)) throw new HubError('原执行进程尚未结束，请先停止并等待退出。', 409);
    const run = this.store.getDispatch(id);
    if (run.pid) {
      try { process.kill(run.pid, 0); throw new HubError('原执行进程仍在运行，请先在客户端停止，不能释放预约。', 409); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    return this.store.resolveDispatch(id, input);
  }
  close() {
    this.closed = true; clearInterval(this.timer);
    for (const [id, child] of this.children) {
      this.store.failDispatch(id, '服务停止，外部执行状态不确定；确认全部停止后再安排。');
      child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); child.unref();
    }
  }
}
