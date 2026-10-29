import path from 'node:path';
import os from 'node:os';

export function isSandboxDenial(event) {
  return event.type === 'user' && Array.isArray(event.message?.content) && event.message.content.some(item =>
    item.type === 'tool_result' && (item._meta?.rawResponse?.sandboxDenied === true ||
      (item.is_error === true && Array.isArray(item.content) && item.content.some(part =>
        part.type === 'text' && /^Error: Sandbox rule denied (reading|writing|deleting|access)/i.test(part.text || '')))));
}

export function buildNativePolicy(cwd, cli, protectedDirectories = []) {
  if (!path.isAbsolute(cwd) || /[*?\[\]{}]/.test(cwd)) throw new Error('沙箱目录必须为不含通配符的绝对路径');
  const normalize = value => path.resolve(value).replace(/\\/g, '/');
  const rules = [];
  const add = (id, target, read, write = 'deny', del = 'deny') => rules.push({ id, source: 'user', path: target, read, write, delete: del });
  protectedDirectories.forEach((dir, index) => {
    if (!path.isAbsolute(dir) || /[*?\[\]{}]/.test(dir)) throw new Error('保护目录格式无效');
    add('host-data-' + index, normalize(dir) + '/**', 'deny');
  });
  for (const name of ['.git', '.codex', '.aws', '.ssh', '.codebuddy']) add('protect-' + name, normalize(cwd) + '/' + name + '/**', 'deny');
  add('protect-env', normalize(cwd) + '/.env*', 'deny');
  add('workspace', normalize(cwd) + '/**', 'allow', 'allow', 'allow');
  // Runtime dependencies are read-only. No user home or whole-drive allowance.
  const runtimeRoots = [path.dirname(process.execPath), path.dirname(path.dirname(cli)),
    process.env.SystemRoot, process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Git')].filter(Boolean);
  runtimeRoots.forEach((root, index) => add('runtime-' + index, normalize(root) + '/**', 'allow'));
  // Windows loads localized system messages from this OS-managed package.
  // This exception is read-only and does not include other WindowsApps packages.
  if (process.env.ProgramFiles) add('windows-language-resources', normalize(process.env.ProgramFiles) + '/WindowsApps/Microsoft.LanguageExperiencePack*/Windows/**', 'allow');
  add('shell-payload', normalize(os.tmpdir()) + '/codebuddy-shell-payload-*/**', 'allow');
  add('outside-default', '**', 'deny');
  const group = rules => ({ presetVersion: 3, customized: true, rules });
  return { enabled: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: false,
    excludedCommands: [], filesystem: { allowWrite: [cwd], denyRead: [], denyWrite: [] },
    orderedRules: { file: group(rules), command: group([]),
      network: group([{ id: 'network-default', source: 'user', domain: '*', action: 'deny' }]) } };
}
