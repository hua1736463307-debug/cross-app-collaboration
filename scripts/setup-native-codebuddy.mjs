// Explicit setup command; never invoked automatically by a task or the scheduler.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
if (process.platform !== 'win32') throw new Error('Native CodeBuddy delivery requires Windows');
const npm = path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
if (!fs.existsSync(npm)) throw new Error('Use a Node.js installation including npm');
for (const [folder, dependency] of [['codebuddy','@tencent-ai/codebuddy-code@2.177.1'], ['codebuddy-host','@tencent-ai/agent-sdk@0.3.294']]) {
  const result = spawnSync(process.execPath, [npm, 'install', '--prefix', path.join(root,'data/clients',folder),
    dependency, '--ignore-scripts', '--no-audit', '--no-fund', '--save-exact'], {stdio:'inherit',windowsHide:true,shell:false});
  if (result.status !== 0 || result.error) throw new Error('Install failed: ' + dependency);
}
console.log('Dependencies installed. Run node scripts/login-codebuddy-host.mjs to check official CLI login. Existing launcher settings were not changed.');
