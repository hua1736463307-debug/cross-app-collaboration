import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import fs from 'node:fs';

export async function authenticateCodeBuddy({ interactive = false } = {}) {
  const packageFile = fileURLToPath(new URL('../data/clients/codebuddy-host/node_modules/@tencent-ai/agent-sdk/package.json', import.meta.url));
  if (JSON.parse(fs.readFileSync(packageFile, 'utf8')).version !== '0.3.294') throw new Error('请使用已验收的 Agent SDK 0.3.294；运行 scripts/setup-native-codebuddy.mjs 安装');
  const sdk = await import('../data/clients/codebuddy-host/node_modules/@tencent-ai/agent-sdk/lib/index.js');
  const cli = fileURLToPath(new URL('../data/clients/codebuddy/node_modules/@tencent-ai/codebuddy-code/bin/codebuddy', import.meta.url));
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^WORKBUDDY_/i.test(key) || ['CODEBUDDY_CONFIG_DIR', 'CODEBUDDY_FORCE_LITE_WB_BUNDLE', 'CODEBUDDY_API_KEY', 'CODEBUDDY_AUTH_TOKEN'].includes(key)) delete env[key];
  env.CODEBUDDY_INTERNET_ENVIRONMENT = 'internal';
  return sdk.unstable_v2_authenticate({ environment: 'internal', methodId: 'internal',
    pathToCodebuddyCode: cli, executable: process.execPath, env, timeout: interactive ? 300000 : 15000,
    onAuthUrl: async ({ authUrl }) => {
      if (!interactive) throw new Error('需要浏览器登录，请运行 node scripts/login-codebuddy-host.mjs');
      const url = new URL(authUrl);
      if (url.protocol !== 'https:') throw new Error('拒绝非 HTTPS 登录地址');
      const browser = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Start-Process -FilePath $env:HUB_CODEBUDDY_LOGIN_URL'],
        { windowsHide: true, stdio: 'ignore', env: { ...process.env, HUB_CODEBUDDY_LOGIN_URL: url.href } });
      await new Promise((resolve, reject) => { browser.once('error', reject); browser.once('exit', code => code === 0 ? resolve() : reject(new Error('无法打开登录页面'))); });
      console.log('请在浏览器完成 CodeBuddy 国内版登录。');
    } });
}
