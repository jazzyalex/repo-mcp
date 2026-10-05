"""Preview/install the durable macOS Repo MCP tunnel service."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import plistlib
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import time
import urllib.request

LABEL = 'local.repo-mcp.tunnel'
TUNNEL_RE = re.compile(r'tunnel_[a-zA-Z0-9_-]+')


def private_dir(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    if path.is_symlink() or not path.is_dir():
        raise ValueError(f'Private state path is not a directory: {path}')
    path.chmod(0o700)


def private_file(path: Path, *, nonempty: bool = True) -> bytes:
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_mode & 0o077:
        raise ValueError(f'Private file must be a regular owner-only file (0600): {path}')
    data = path.read_bytes()
    if nonempty and not data:
        raise ValueError(f'Private file is empty: {path}')
    return data


def atomic_write(path: Path, data: bytes, mode: int = 0o600) -> None:
    private_dir(path.parent)
    fd, name = tempfile.mkstemp(prefix=path.name + '.', dir=path.parent)
    try:
        os.fchmod(fd, mode)
        with os.fdopen(fd, 'wb', closefd=True) as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(name, path)
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    except BaseException:
        try:
            os.close(fd)
        except OSError:
            pass
        Path(name).unlink(missing_ok=True)
        raise


def value_after(args: list[str], flag: str) -> str | None:
    try:
        index = args.index(flag)
        return args[index + 1]
    except (ValueError, IndexError):
        return None


def legacy_definition_matches(plist: dict, legacy_root: Path, tunnel_id: str) -> bool:
    state = legacy_root / '.trial'
    args = plist.get('ProgramArguments')
    expected_keys = {
        'Label', 'ProgramArguments', 'WorkingDirectory', 'RunAtLoad', 'KeepAlive',
        'ThrottleInterval', 'StandardOutPath', 'StandardErrorPath'
    }
    if set(plist) != expected_keys or not isinstance(args, list) or len(args) != 14:
        return False
    return (
        plist.get('Label') == LABEL
        and args[1:2] == ['run']
        and Path(args[0]).is_absolute()
        and value_after(args, '--control-plane.tunnel-id') == tunnel_id
        and value_after(args, '--control-plane.api-key') == 'file:' + str(state / 'runtime.key')
        and value_after(args, '--mcp.server-url') == 'http://127.0.0.1:8787/mcp'
        and value_after(args, '--mcp.startup-wait-timeout') == '30s'
        and value_after(args, '--health.listen-addr') == '127.0.0.1:0'
        and value_after(args, '--health.url-file') == str(state / 'standalone-tunnel-health.url')
        and plist.get('WorkingDirectory') == str(legacy_root)
        and plist.get('RunAtLoad') is True
        and plist.get('KeepAlive') is True
        and plist.get('ThrottleInterval') == 30
        and plist.get('StandardOutPath') == str(state / 'tunnel-stdout.log')
        and plist.get('StandardErrorPath') == str(state / 'tunnel-stderr.log')
    )


def desired_plist(client: Path, credentials: Path, tunnel: Path, tunnel_id: str, port: int) -> dict:
    return {
        'Label': LABEL,
        'ProgramArguments': [
            str(client), 'run', '--control-plane.tunnel-id', tunnel_id,
            '--control-plane.api-key', 'file:' + str(credentials / 'runtime.key'),
            '--mcp.server-url', f'http://127.0.0.1:{port}/mcp',
            '--mcp.startup-wait-timeout', '30s',
            '--health.listen-addr', '127.0.0.1:0',
            '--health.url-file', str(tunnel / 'health.url')
        ],
        'WorkingDirectory': str(tunnel),
        'RunAtLoad': True,
        'KeepAlive': True,
        'ThrottleInterval': 30,
        'StandardOutPath': str(tunnel / 'stdout.log'),
        'StandardErrorPath': str(tunnel / 'stderr.log')
    }


def launchctl(*args: str, check: bool = True) -> subprocess.CompletedProcess:
    return subprocess.run(['launchctl', *args], check=check, capture_output=True, text=True)


def bootout(target: Path) -> None:
    result = launchctl('bootout', f'gui/{os.getuid()}', str(target), check=False)
    if result.returncode not in (0, 113):
        raise RuntimeError('Could not stop the existing Repo MCP tunnel service.')


def wait_fresh_poll(health_file: Path, started: float, timeout: float = 50.0) -> None:
    deadline = time.monotonic() + timeout
    last_error = 'health URL was not published'
    while time.monotonic() < deadline:
        try:
            address = health_file.read_text().strip()
            from urllib.parse import urlparse
            parsed = urlparse(address)
            if parsed.scheme != 'http' or parsed.hostname != '127.0.0.1':
                raise ValueError('unexpected health address')
            with urllib.request.urlopen(address.rstrip('/') + '/health?details=true', timeout=2) as response:
                health = json.load(response)
            poll = health.get('components', {}).get('control-plane', {})
            details = poll.get('details', {})
            stamp = details.get('last_success', '')
            from datetime import datetime
            success = datetime.fromisoformat(stamp.replace('Z', '+00:00')).timestamp()
            if (health.get('live') is True and health.get('ready') is True
                    and poll.get('status') == 'ok'
                    and details.get('consecutive_failures') == 0 and success > started):
                return
            last_error = 'no successful post-restart control-plane poll'
        except Exception as error:
            last_error = type(error).__name__
        time.sleep(1)
    raise RuntimeError(f'Tunnel migration did not verify a fresh control-plane poll ({last_error}).')


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--install', action='store_true')
    parser.add_argument('--migrate', action='store_true')
    parser.add_argument('--legacy-root', type=Path)
    parser.add_argument('--state-dir', type=Path)
    parser.add_argument('--port', type=int, default=8787)
    parser.add_argument('--client', type=Path, help='Absolute path to the official tunnel-client')
    args = parser.parse_args()
    if sys.platform != 'darwin' or not 1024 <= args.port <= 65535:
        parser.error('Requires macOS and a port between 1024 and 65535.')
    if args.migrate and (not args.install or not args.legacy_root):
        parser.error('--migrate requires --install and an explicit --legacy-root.')

    root = (args.state_dir or (Path.home() / 'Library/Application Support/repo-mcp')).expanduser().resolve()
    credentials, tunnel, binaries = root / 'credentials', root / 'tunnel', root / 'bin'
    for directory in (root, credentials, tunnel, binaries):
        private_dir(directory)

    target = Path.home() / 'Library/LaunchAgents' / (LABEL + '.plist')
    target.parent.mkdir(parents=True, exist_ok=True)
    existing = target.read_bytes() if target.exists() else None
    legacy_root = args.legacy_root.expanduser().resolve() if args.legacy_root else None

    if args.migrate:
        assert legacy_root is not None
        legacy_state = legacy_root / '.trial'
        key_data = private_file(legacy_state / 'runtime.key')
        tunnel_data = private_file(legacy_state / 'tunnel-id')
        tunnel_id = tunnel_data.decode().strip()
        if not TUNNEL_RE.fullmatch(tunnel_id):
            parser.error('Invalid legacy tunnel ID.')
        if existing is None or not legacy_definition_matches(plistlib.loads(existing), legacy_root, tunnel_id):
            parser.error('Installed tunnel service is foreign or modified; migration refused without changing it.')
        legacy_client = Path(plistlib.loads(existing)['ProgramArguments'][0]).resolve(strict=True)
        selected_client = args.client.expanduser().resolve(strict=True) if args.client else legacy_client
        if legacy_root in selected_client.parents:
            copied = binaries / 'tunnel-client'
            atomic_write(copied, selected_client.read_bytes(), 0o700)
            selected_client = copied
        for destination, data in ((credentials / 'runtime.key', key_data), (credentials / 'tunnel-id', tunnel_data)):
            if destination.exists() and private_file(destination) != data:
                parser.error(f'Canonical credential already exists with different contents: {destination}')
            atomic_write(destination, data)
    else:
        private_file(credentials / 'runtime.key')
        tunnel_data = private_file(credentials / 'tunnel-id')
        tunnel_id = tunnel_data.decode().strip()
        if not TUNNEL_RE.fullmatch(tunnel_id):
            parser.error('Invalid saved tunnel ID.')
        selected_client = (args.client.expanduser().resolve(strict=True) if args.client
                           else Path(shutil.which('tunnel-client') or binaries / 'tunnel-client').resolve(strict=True))

    plist = desired_plist(selected_client, credentials, tunnel, tunnel_id, args.port)
    plist_bytes = plistlib.dumps(plist, sort_keys=True)
    for name in ('stdout.log', 'stderr.log'):
        destination = tunnel / name
        destination.touch(mode=0o600, exist_ok=True)
        destination.chmod(0o600)
    preview = tunnel / (LABEL + '.preview.plist')
    atomic_write(preview, plist_bytes)
    if not args.install:
        print(f'Preview written: {preview}. Install with --install after review.')
        return 0

    if existing is not None and not args.migrate and existing != plist_bytes:
        parser.error('Installed tunnel service differs from the expected durable definition; use explicit migration or inspect it manually.')

    backup = tunnel / (LABEL + '.legacy.plist')
    started = time.time()
    try:
        if existing is not None:
            atomic_write(backup, existing)
            bootout(target)
        atomic_write(target, plist_bytes)
        launchctl('bootstrap', f'gui/{os.getuid()}', str(target))
        if args.migrate:
            wait_fresh_poll(tunnel / 'health.url', started)
        record = {
            'version': 1,
            'label': LABEL,
            'client': str(selected_client),
            'port': args.port,
            'plist_sha256': hashlib.sha256(plist_bytes).hexdigest(),
            'installed_at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
        }
        atomic_write(tunnel / 'install.json', (json.dumps(record, sort_keys=True, indent=2) + '\n').encode())
    except BaseException:
        bootout(target)
        if existing is not None:
            atomic_write(target, existing)
            launchctl('bootstrap', f'gui/{os.getuid()}', str(target))
        else:
            target.unlink(missing_ok=True)
        raise

    if args.migrate:
        assert legacy_root is not None
        legacy_state = legacy_root / '.trial'
        warnings = []
        for old in ('standalone-tunnel', 'runtime.key', 'tunnel-id'):
            try:
                (legacy_state / old).unlink(missing_ok=True)
            except OSError:
                warnings.append(old)
        if warnings:
            print('WARNING: legacy private copies remain: ' + ', '.join(warnings), file=sys.stderr)
    print('Durable tunnel service installed. Verify with npm run connection:status, then prove the ChatGPT route with repo_info.')
    return 0


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except (ValueError, OSError, RuntimeError, plistlib.InvalidFileException) as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1)
