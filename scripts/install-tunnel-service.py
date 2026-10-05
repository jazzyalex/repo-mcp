"""Preview/install a standalone macOS tunnel service; no Codex dependency."""
import argparse
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import sys

p = argparse.ArgumentParser()
p.add_argument('--install', action='store_true')
p.add_argument('--port', type=int, default=8787)
p.add_argument('--client', help='Absolute path to the official tunnel-client')
a = p.parse_args()
if sys.platform != 'darwin' or not 1024 <= a.port <= 65535:
    p.error('Requires macOS and a port between 1024 and 65535.')
base = Path(__file__).resolve().parents[1]
state = base/'.trial'
state.mkdir(exist_ok=True, mode=0o700)
client = Path(a.client or shutil.which('tunnel-client') or state/'bin/tunnel-client').resolve(strict=True)
key = state/'runtime.key'
if not key.is_file() or key.stat().st_size == 0:
    p.error('Save a runtime key first: bash scripts/connect.sh --save-key')
if key.is_symlink() or key.stat().st_mode & 0o077:
    p.error('Runtime key must be a regular owner-only file (chmod 600).')
tunnel = (state/'tunnel-id').read_text().strip()
import re
if not re.fullmatch(r'tunnel_[a-zA-Z0-9_-]+', tunnel):
    p.error('Invalid saved tunnel ID.')
label = 'local.repo-mcp.tunnel'
plist = {
    'Label':label,
    'ProgramArguments':[str(client), 'run', '--control-plane.tunnel-id', tunnel,
        '--control-plane.api-key', 'file:'+str(key),
        '--mcp.server-url', f'http://127.0.0.1:{a.port}/mcp',
        '--mcp.startup-wait-timeout', '30s',
        '--health.listen-addr', '127.0.0.1:0',
        '--health.url-file', str(state/'standalone-tunnel-health.url')],
    'WorkingDirectory':str(base), 'RunAtLoad':True, 'KeepAlive':True,
    'ThrottleInterval':30,
    'StandardOutPath':str(state/'tunnel-stdout.log'),
    'StandardErrorPath':str(state/'tunnel-stderr.log')
}
for name in ['tunnel-stdout.log','tunnel-stderr.log']:
    f=state/name; f.touch(mode=0o600,exist_ok=True); f.chmod(0o600)
preview=state/(label+'.plist'); preview.write_bytes(plistlib.dumps(plist)); preview.chmod(0o600)
if not a.install:
    print(f'Preview written: {preview}. Stop any managed tunnel before --install.')
    sys.exit(0)
target=Path.home()/'Library/LaunchAgents'/(label+'.plist')
target.parent.mkdir(parents=True,exist_ok=True)
with target.open('xb') as f: f.write(plistlib.dumps(plist))
target.chmod(0o600)
subprocess.run(['launchctl','bootstrap',f'gui/{os.getuid()}',str(target)],check=True)
(state/'standalone-tunnel').write_text(label+'\n')
print('Standalone tunnel service installed. Verify polling with npm run connection:status.')
