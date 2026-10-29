import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

function legacyOwner(pid) {
  if (process.platform === 'win32') {
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `$ErrorActionPreference='Stop'; $p=Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($p) { $p.ProcessName } else { 'ABSENT' }`],
    { encoding: 'utf8', windowsHide: true, timeout: 10000 });
    if (result.error || result.status !== 0) return 'unknown';
    const name = result.stdout.trim().toLowerCase();
    if (name === 'absent') return 'stale';
    // Only positively identified OS processes are safe legacy PID-reuse evidence.
    if (['csrss', 'wininit', 'winlogon', 'lsass', 'services', 'smss', 'system', 'idle'].includes(name)) return 'stale';
    return 'unknown';
  }
  try { process.kill(pid, 0); return 'unknown'; }
  catch (error) { return error.code === 'ESRCH' ? 'stale' : 'unknown'; }
}

export function lockDirectory(dataDir, { inspectLegacy = legacyOwner } = {}) {
  fs.mkdirSync(dataDir, { recursive: true });
  const filename = path.join(dataDir, 'server.lock');
  // Dedicated SQLite transaction holds an OS lock for the entire server lifetime.
  // Never delete this database: every contender must lock the same file.
  let db;
  try { db = new DatabaseSync(path.join(dataDir, 'server-ownership.sqlite')); db.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE;'); }
  catch (error) {
    db?.close();
    if (error.errcode === 5 || error.errcode === 6) throw new Error('此数据目录已被运行中的服务使用，请使用现有窗口。');
    throw error;
  }
  try {
    if (fs.existsSync(filename)) {
      const previous = fs.readFileSync(filename, 'utf8');
      let record;
      try { record = JSON.parse(previous); } catch {}
      if (Number.isInteger(record) && record > 0) {
        if (inspectLegacy(record) !== 'stale') throw new Error(`旧版服务锁记录进程 ${record}，无法确认其已退出。请核对该进程是否为本项目服务；不要直接结束其他进程。锁文件：${filename}`);
      } else if (!record || record.version !== 2 || typeof record.token !== 'string') {
        throw new Error(`服务锁内容异常，请核对：${filename}`);
      }
    }
    const contents = JSON.stringify({ version: 2, pid: process.pid, token: randomUUID(),
      executable: process.execPath, startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString() });
    fs.writeFileSync(filename, contents);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      try { if (fs.readFileSync(filename, 'utf8') === contents) fs.unlinkSync(filename); }
      catch {}
      finally { db.close(); }
    };
  } catch (error) { db.close(); throw error; }
}
