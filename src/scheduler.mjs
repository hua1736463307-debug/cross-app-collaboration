import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { buildLaunch, discoverLaunchers, launcherState } from './launchers.mjs';
import { HubError } from './store.mjs';

export class Scheduler {
  constructor(store, { root, dataDir, getURL, launch = spawn, paths, intervalMs = 1000, claimMs = 180000, runMs = 1200000 } = {}) {
    Object.assign(this, { store, root, dataDir, getURL, launch, paths: paths || discoverLaunchers(dataDir), claimMs, runMs });
    this.children = new Map(); this.closed = false;
    this.timer = setInterval(() => this.tick(), intervalMs); this.timer.unref();
  }
  state() { return { ...this.store.schedulerState(), adapters: launcherState(this.paths) }; }
  tick() {
    if (this.closed || !this.getURL()) return;
    try {
      this.store.expireDispatches({ claimMs: this.claimMs, runMs: this.runMs });
      for (const actor of ['codex', 'workbuddy']) {
        const run = this.store.reserveDispatch(actor);
        if (!run) continue;
        try { this.start(run); }
        catch { this.store.failDispatch(run.id, '启动失败：请检查 CLI 路径、项目目录与本机日志，确认停止后再安排。'); }
        break;
      }
    } catch (error) { console.error('[scheduler]', error.message); }
  }
  start(run) {
    this.store.tx(() => { const record = this.store.getDispatch(run.id); record.adapterLabel = launcherState(this.paths)[run.actor].label; this.store.saveDispatch(record); });
    const spec = buildLaunch({ actor: run.actor, paths: this.paths, root: this.root, dataDir: this.dataDir,
      url: this.getURL(), run, project: this.store.getProject(this.store.getTask(run.taskId).projectId) });
    const child = this.launch(spec.command, spec.args, { cwd: spec.cwd, env: spec.env, shell: false, windowsHide: true, stdio: ['pipe','pipe','pipe'] });
    this.children.set(run.id, child);
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
          if (event.type === 'system' && event.subtype === 'init' && typeof event.model === 'string' && event.model.length <= 100) {
            this.store.tx(() => { const record = this.store.getDispatch(run.id); record.reportedModel = event.model; if (typeof event.reasoning_effort === 'string' && event.reasoning_effort.length <= 32) record.reportedEffort = event.reasoning_effort; this.store.saveDispatch(record); });
          }
          if ((event.type === 'result' && event.is_error) || event.type === 'turn.failed') {
            const message = JSON.stringify(event.errors || event.error || '');
            clientFailure = /authentication|login|sign in|unauthorized/i.test(message)
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
        child.stdin.end(spec.prompt);
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
      if (!this.closed) {
        const record = this.store.getDispatch(run.id);
        if (record.requestedModel?.model && record.reportedModel && record.requestedModel.model !== record.reportedModel) clientFailure = '客户端报告的模型与请求的模型不一致；已停止自动流转，请检查模型或客户端回退配置。';
        if (record.requestedModel?.effort && record.reportedEffort && record.requestedModel.effort !== record.reportedEffort) clientFailure = '客户端报告的推理强度与请求的强度不一致；已停止自动流转，请检查客户端配置。';
        if (clientFailure) this.store.failDispatch(run.id, clientFailure);
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
