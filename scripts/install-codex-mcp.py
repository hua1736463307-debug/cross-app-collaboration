"""Add only this project's MCP entry; never display credentials or rewrite history."""
import argparse
import copy
import datetime
import hashlib
import json
import os
from pathlib import Path
import shutil
import tomllib


def install(apply=False):
    root = Path(__file__).resolve().parents[1]
    home = Path(os.environ.get('CODEX_HOME', str(Path.home() / '.codex')))
    target = home / 'config.toml'
    original = target.read_bytes()
    before = tomllib.loads(original.decode('utf-8-sig'))
    node = shutil.which('node')
    if not node:
        raise RuntimeError('Node.js is not available')
    name = 'cross-app-codex'
    entry = {'command': node, 'args': [str(root / 'src' / 'mcp.mjs'), '--actor', 'codex'],
             'env': {'HUB_URL': 'http://127.0.0.1:4318', 'HUB_DATA_DIR': str(root / 'data')}}
    existing = before.get('mcp_servers', {}).get(name)
    if existing is not None:
        if existing != entry:
            raise RuntimeError('Existing MCP entry differs; manual review required, no changes made')
        return {'status': 'already_configured', 'config': str(target)}
    quote = lambda value: json.dumps(value, ensure_ascii=False)
    suffix = '\n\n# Local cross-application collaboration system\n[mcp_servers."' + name + '"]\n'
    suffix += 'command = ' + quote(node) + '\nargs = ' + json.dumps(entry['args'], ensure_ascii=False) + '\n'
    suffix += '\n[mcp_servers."' + name + '".env]\n'
    suffix += ''.join(key + ' = ' + quote(value) + '\n' for key, value in entry['env'].items())
    candidate = original + suffix.encode('utf-8')
    parsed = tomllib.loads(candidate.decode('utf-8-sig'))
    expected = copy.deepcopy(before)
    expected.setdefault('mcp_servers', {})[name] = entry
    if parsed != expected:
        raise RuntimeError('Configuration delta is not limited to the MCP entry')
    digest = lambda raw: hashlib.sha256(raw).hexdigest()
    result = {'status': 'ready', 'config': str(target), 'before_sha256': digest(original),
              'provider_preserved': True, 'only_added': 'mcp_servers.' + name}
    if not apply:
        return result
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    backup = target.with_name(target.name + '.bak-cross-app-' + stamp)
    with backup.open('xb') as handle:
        handle.write(original)
    if backup.read_bytes() != original or target.read_bytes() != original:
        raise RuntimeError('Backup mismatch or concurrent configuration drift; no update applied')
    temporary = target.with_name(target.name + '.cross-app-' + stamp + '.tmp')
    with temporary.open('xb') as handle:
        handle.write(candidate)
    if target.read_bytes() != original:
        temporary.unlink()
        raise RuntimeError('Concurrent configuration change; no update applied')
    os.replace(temporary, target)
    if target.read_bytes() != candidate or backup.read_bytes() != original:
        raise RuntimeError('Post-write verification failed; review the named backup')
    return {**result, 'status': 'configured', 'backup': str(backup),
            'backup_sha256': digest(backup.read_bytes()), 'after_sha256': digest(candidate)}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--apply', action='store_true')
    options = parser.parse_args()
    print(json.dumps(install(options.apply), ensure_ascii=False))
