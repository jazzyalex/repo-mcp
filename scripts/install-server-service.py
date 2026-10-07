"""Install the stable repository-agnostic Repo MCP launchd definition.

This script never embeds repository, policy, task, or tunnel credentials in the plist and
never claims the service is ready. `npm run coord -- service start` owns load/reload plus
permanent-broker process attestation; repository/task selection is separate and does not restart it.
"""
from prerequisites import require_python
require_python()

import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import plistlib
import shutil
import socket
import stat
import sys
import tempfile
import uuid

p = argparse.ArgumentParser()
p.add_argument('--state-dir', help='Operator state directory; defaults to Application Support/repo-mcp/state')
p.add_argument('--install', action='store_true', help='Install/upgrade the stable definition; otherwise print the preview plist to stdout')
a = p.parse_args()
if sys.platform != 'darwin':
    p.error('This service installer supports macOS only.')
base = Path(__file__).resolve().parents[1]
node = shutil.which('node')
if not node or not Path(node).is_absolute() or not os.access(node, os.X_OK) or not (base/'dist/src/service-main.js').is_file():
    p.error('Absolute Node executable and built stable server required; run npm ci and npm run build first.')
state = Path(a.state_dir).expanduser().resolve() if a.state_dir else Path.home()/'Library/Application Support/repo-mcp/state'
runtime = state.parent/'server'
label = 'local.repo-mcp.server'
plist = {
    'Label': label,
    'ProgramArguments': [node, str(base/'dist/src/service-main.js')],
    'WorkingDirectory': str(base),
    'EnvironmentVariables': {'REPO_MCP_STATE_DIR': str(state)},
    'RunAtLoad': True, 'KeepAlive': True, 'ThrottleInterval': 10,
    'StandardOutPath': str(runtime/'stdout.log'),
    'StandardErrorPath': str(runtime/'stderr.log')
}

def xml_escape(value):
    return str(value).replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;').replace('"', '&quot;')

def plist_node(value):
    if isinstance(value, bool):
        return '<true/>' if value else '<false/>'
    if isinstance(value, str):
        return f'<string>{xml_escape(value)}</string>'
    if isinstance(value, int):
        return f'<integer>{value}</integer>'
    if isinstance(value, list):
        return '<array>' + ''.join(plist_node(item) for item in value) + '</array>'
    if isinstance(value, dict):
        return '<dict>' + ''.join(f'<key>{xml_escape(key)}</key>{plist_node(child)}' for key, child in value.items()) + '</dict>'
    raise TypeError(f'Unsupported plist value: {type(value).__name__}')

def stable_plist_bytes(value):
    text = '<?xml version="1.0" encoding="UTF-8"?>\n' \
        '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' \
        '<plist version="1.0">\n' + plist_node(value) + '\n</plist>\n'
    return text.encode('utf-8')

bytes_out = stable_plist_bytes(plist)
if not a.install:
    sys.stdout.buffer.write(bytes_out)
    sys.exit(0)

state.mkdir(parents=True, exist_ok=True, mode=0o700)
state.chmod(0o700)
runtime.mkdir(parents=True, exist_ok=True, mode=0o700)
runtime.chmod(0o700)
target = Path.home()/'Library/LaunchAgents'/(label+'.plist')
target.parent.mkdir(parents=True, exist_ok=True)
install_path = state/'control/install.json'

def read_install():
    try:
        record = json.loads(install_path.read_text())
    except FileNotFoundError:
        return None
    except Exception as exc:
        p.error(f'Existing install record is unreadable: {exc}')
    if record.get('version') != 1 or record.get('kind') != 'install' or not isinstance(record.get('data'), dict):
        p.error('Existing install record has an unsupported version/kind.')
    return record['data']

def fsync_dir(directory):
    fd = os.open(directory, os.O_RDONLY)
    try: os.fsync(fd)
    finally: os.close(fd)

claim_prefix = f'.{target.name}.claim-'

def validate_claim_path(claim):
    if (not claim.is_absolute() or claim.parent != target.parent or
            not claim.name.startswith(claim_prefix) or len(claim.name) <= len(claim_prefix)):
        p.error('Recorded server plist claim path is outside the trusted target directory or does not match the generated claim prefix.')

def claim_lstat(claim):
    validate_claim_path(claim)
    try:
        info = claim.lstat()
    except FileNotFoundError:
        return None
    if not stat.S_ISREG(info.st_mode):
        p.error('Recorded server plist claim is not a regular file; refusing cleanup or recovery.')
    return info

def read_claim_bytes(claim):
    if claim_lstat(claim) is None:
        return None
    return claim.read_bytes()

def unlink_claim(claim):
    if claim_lstat(claim) is None:
        return False
    claim.unlink()
    fsync_dir(claim.parent)
    return True

def staged_bytes(directory, data, mode=0o600):
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, temporary = tempfile.mkstemp(prefix='.tmp-', dir=directory)
    os.fchmod(fd, mode)
    with os.fdopen(fd, 'wb', closefd=True) as handle:
        handle.write(data); handle.flush(); os.fsync(handle.fileno())
    return temporary

def replace_record_bytes(destination, data, mode=0o600):
    temporary = staged_bytes(destination.parent, data, mode)
    try:
        os.replace(temporary, destination)
        destination.chmod(mode)
        fsync_dir(destination.parent)
    finally:
        try: os.unlink(temporary)
        except FileNotFoundError: pass

def try_create_bytes(path, data, mode=0o600):
    temporary = staged_bytes(path.parent, data, mode)
    try:
        try:
            os.link(temporary, path)
        except FileExistsError:
            return False
        path.chmod(mode)
        fsync_dir(path.parent)
        return True
    finally:
        try: os.unlink(temporary)
        except FileNotFoundError: pass

def create_bytes_if_absent(path, data, mode=0o600):
    if not try_create_bytes(path, data, mode):
        p.error(f'Refusing to overwrite a later occupant at {path}; reconcile the service plist manually.')

def parsed_bytes(data):
    try:
        value = plistlib.loads(data)
    except Exception as exc:
        p.error(f'Installed server plist is unreadable: {exc}')
    if not isinstance(value, dict):
        p.error('Installed server plist is not a dictionary.')
    return value

def install_data(installed_hash, transaction=None):
    retained = {}
    for key in ('migration_state', 'legacy_backup_path', 'legacy_backup_sha256', 'legacy_original_path'):
        if install and install.get(key) is not None:
            retained[key] = install[key]
    data = {
        'label': label,
        'target': str(target),
        'installed_plist_sha256': installed_hash,
        **retained,
        'updated_at': datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')
    }
    if transaction is not None:
        data['plist_transaction'] = transaction
    return data

def write_install_data(installed_hash, transaction=None):
    record = {'version': 1, 'kind': 'install', 'data': install_data(installed_hash, transaction)}
    replace_record_bytes(install_path, (json.dumps(record, separators=(',', ':'))+'\n').encode())

canonical_target = os.path.abspath(str(target))
lock_key = 'service-plist-' + hashlib.sha256((label+'\0'+canonical_target).encode('utf-8')).hexdigest()[:32]
lock_state = target.parent/'.repo-mcp-service-control'
lock_state.mkdir(parents=True, exist_ok=True, mode=0o700)
lock_state.chmod(0o700)
lock_path = lock_state/'locks'/(lock_key+'.json')
recovery_path = lock_state/'locks'/(lock_key+'.recovery.json')
lock_purpose = 'service plist transaction'

def read_state_record(path, kind):
    try:
        record = json.loads(path.read_text())
    except FileNotFoundError:
        return None
    except Exception:
        p.error(f'Corrupt {kind} state at {path}; manual inspection is required.')
    if record.get('version') != 1 or record.get('kind') != kind or not isinstance(record.get('data'), dict):
        p.error(f'Corrupt {kind} state at {path}; manual inspection is required.')
    return record['data']

def validate_lock_record(record, description):
    if not isinstance(record, dict):
        p.error(f'Corrupt {description}; manual inspection is required.')
    pid = record.get('pid')
    fields = ('hostname', 'token', 'purpose', 'acquired_at')
    if type(pid) is not int or pid <= 0 or pid > (2**53 - 1) or any(not isinstance(record.get(k), str) or not record[k].strip() for k in fields):
        p.error(f'Corrupt {description}; manual inspection is required.')
    try:
        datetime.fromisoformat(record['acquired_at'].replace('Z', '+00:00'))
    except ValueError:
        p.error(f'Corrupt {description}; manual inspection is required.')
    return record

def pid_alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except PermissionError:
        return True
    except ProcessLookupError:
        return False
    except OSError as exc:
        p.error(f'Unable to verify plist lock owner process {pid}: {exc}')

def lock_envelope(data, kind='lock'):
    return (json.dumps({'version': 1, 'kind': kind, 'data': data}, separators=(',', ':'))+'\n').encode()

def acquire_service_plist_lock():
    now = datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')
    record = {
        'pid': os.getpid(),
        'hostname': socket.gethostname(),
        'token': uuid.uuid4().hex,
        'purpose': lock_purpose,
        'acquired_at': now
    }
    if try_create_bytes(lock_path, lock_envelope(record)):
        return record['token']
    existing = validate_lock_record(read_state_record(lock_path, 'lock'), 'service-plist lock')
    if existing['hostname'] != record['hostname']:
        p.error(f"service-plist lock is owned on {existing['hostname']}; refusing automatic recovery.")
    if pid_alive(existing['pid']):
        p.error(f"service-plist lock is owned by live process {existing['pid']}.")
    if existing['purpose'] != lock_purpose:
        p.error('service-plist stale lock has an unexpected purpose; manual inspection is required.')
    if not try_create_bytes(recovery_path, lock_envelope(record, 'lock-recovery')):
        holder = validate_lock_record(read_state_record(recovery_path, 'lock-recovery'), 'service-plist recovery marker')
        if holder['hostname'] == record['hostname'] and not pid_alive(holder['pid']):
            p.error(f"Stale service-plist recovery marker from exited process {holder['pid']}; manual inspection is required.")
        p.error(f"service-plist stale-lock recovery is already in progress by process {holder['pid']}.")
    try:
        current_raw = read_state_record(lock_path, 'lock')
        current = validate_lock_record(current_raw, 'service-plist lock') if current_raw is not None else None
        if current is not None and current['token'] != existing['token']:
            p.error('service-plist lock changed during stale recovery.')
        if current is not None:
            os.unlink(lock_path); fsync_dir(lock_path.parent)
        if not try_create_bytes(lock_path, lock_envelope(record)):
            p.error('service-plist lock was claimed concurrently during stale recovery.')
        return record['token']
    finally:
        try: os.unlink(recovery_path); fsync_dir(recovery_path.parent)
        except FileNotFoundError: pass

def release_service_plist_lock(token):
    current = read_state_record(lock_path, 'lock')
    if current is None:
        return
    current = validate_lock_record(current, 'service-plist lock')
    if current['token'] != token:
        return
    os.unlink(lock_path); fsync_dir(lock_path.parent)

desired_hash = hashlib.sha256(bytes_out).hexdigest()
lock_token = acquire_service_plist_lock()
try:
    install = read_install()
    current = target.read_bytes() if target.exists() else None
    current_hash = hashlib.sha256(current).hexdigest() if current is not None else None
    transaction = install.get('plist_transaction') if install else None

    if transaction is not None:
        if install.get('target') != str(target) or transaction.get('desired_sha256') != desired_hash:
            p.error('Prepared server plist transaction does not match the current desired definition.')
        claim_value = transaction.get('claim_path')
        claim = Path(claim_value) if isinstance(claim_value, str) and claim_value else None
        claim_bytes = read_claim_bytes(claim) if claim is not None else None
        if current_hash == desired_hash:
            previous_hash = transaction.get('previous_sha256')
            cleanup_pending = transaction.get('cleanup_pending', False)
            if type(cleanup_pending) is not bool:
                p.error('Prepared server plist cleanup state is invalid.')
            if claim is not None:
                if previous_hash is None:
                    p.error('Fresh-install transaction unexpectedly contains a claim path.')
                if claim_bytes is not None and hashlib.sha256(claim_bytes).hexdigest() != previous_hash:
                    p.error('Prepared server plist cleanup claim does not match its durable previous hash.')
                if not cleanup_pending:
                    if claim_bytes is None:
                        p.error('Prepared cleanup claim disappeared before durable cleanup-pending state was published.')
                    transaction = {**transaction, 'cleanup_pending': True}
                    write_install_data(desired_hash, transaction)
                    install = read_install()
                    cleanup_pending = True
                if claim_bytes is not None:
                    cleanup_claim = read_claim_bytes(claim)
                    if cleanup_claim is not None:
                        if hashlib.sha256(cleanup_claim).hexdigest() != previous_hash:
                            p.error('Prepared server plist cleanup claim changed after durable cleanup-pending publication.')
                        unlink_claim(claim)
            elif cleanup_pending:
                p.error('Cleanup-pending transaction is missing its durable claim path.')
            write_install_data(desired_hash)
            install = read_install()
            transaction = None
        elif transaction.get('previous_sha256') is None:
            if current is not None:
                p.error('A later occupant appeared during the prepared fresh install; refusing overwrite.')
        else:
            previous_hash = transaction.get('previous_sha256')
            claim_matches = claim_bytes is not None and hashlib.sha256(claim_bytes).hexdigest() == previous_hash
            if current_hash != previous_hash and not (current is None and claim_matches):
                p.error('Installed server plist matches neither side of the prepared transaction; refusing reconciliation.')
            if claim is None:
                claim = target.parent/f'{claim_prefix}{uuid.uuid4()}'
                transaction = {**transaction, 'claim_path': str(claim), 'desired_definition': plist}
                write_install_data(install.get('installed_plist_sha256'), transaction)
                install = read_install()
            print('Trusted older Repo MCP definition retained with a prepared exact-claim upgrade transaction. Run npm run coord -- service start; the coordinator will claim, verify, replace, and attest it.')
            sys.exit(0)

    if current is None:
        if transaction is None:
            write_install_data(None, {'previous_sha256': None, 'desired_sha256': desired_hash, 'desired_definition': plist})
            install = read_install()
        create_bytes_if_absent(target, bytes_out)
        installed = target.read_bytes()
        if hashlib.sha256(installed).hexdigest() != desired_hash:
            p.error('Fresh stable plist publication did not preserve the desired bytes.')
        write_install_data(desired_hash)
    elif current_hash == desired_hash:
        if install is None or install.get('target') != str(target) or install.get('installed_plist_sha256') != current_hash or install.get('plist_transaction') is not None:
            p.error('Installed stable server plist no longer matches its trusted install record.')
    else:
        exact = parsed_bytes(current)
        if install is None or install.get('target') != str(target) or install.get('installed_plist_sha256') != current_hash:
            p.error('Unexpected or modified pre-existing server plist; refusing to overwrite it.')
        installed_base = exact.get('WorkingDirectory')
        if installed_base != str(base):
            p.error(
                f'Existing Repo MCP service is bound to {installed_base or "an unknown checkout"}. '
                'Run the installer from that control checkout; automatic relocation is refused.'
            )
        if exact == plist:
            p.error('Stable plist bytes differ from the canonical desired serialization; refusing implicit rewrite.')
        claim = target.parent/f'{claim_prefix}{uuid.uuid4()}'
        write_install_data(current_hash, {
            'previous_sha256': current_hash,
            'desired_sha256': desired_hash,
            'claim_path': str(claim),
            'previous_definition': exact,
            'desired_definition': plist
        })
        print('Trusted older Repo MCP definition retained with a prepared exact-claim upgrade transaction. Run npm run coord -- service start; the coordinator will claim, verify, replace, and attest it.')
        sys.exit(0)

    print(f'Installed stable definition: {target}. Bind a task and run npm run coord -- service start to load and attest it.')
finally:
    release_service_plist_lock(lock_token)
