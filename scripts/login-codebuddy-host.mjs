import { authenticateCodeBuddy } from '../src/codebuddy-auth.mjs';
try {
  const result = await authenticateCodeBuddy({ interactive: true });
  if (!result.userinfo?.token) throw new Error('未返回有效登录结果');
  console.log('CODEBUDDY_HOST_LOGIN_OK');
} catch { console.error('登录未完成，请检查浏览器和网络后重试。'); process.exitCode = 1; }
