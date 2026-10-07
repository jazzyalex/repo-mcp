#!/usr/bin/env python3
"""Install bundled skills without silently replacing foreign or modified copies."""
from prerequisites import require_python
require_python()

import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import stat
import tempfile
import uuid

ROOT = Path(__file__).resolve().parents[1]
HOME = Path.home().resolve()


def normalized(value):
    path = Path(value).expanduser().absolute()
    lexical_home = Path.home().absolute()
    try:
        return HOME / path.relative_to(lexical_home)
    except ValueError:
        return path


def validate_parents(path):
    for parent in reversed(path.parents):
        if parent.exists() or parent.is_symlink():
            info = parent.lstat()
            if not stat.S_ISDIR(info.st_mode):
                raise RuntimeError(f"Refusing non-directory or symlink skill parent: {parent}")
            if parent == HOME or HOME in parent.parents:
                if info.st_uid != os.getuid() or info.st_mode & 0o022:
                    raise RuntimeError(f"Skill parent is not owner-safe: {parent}")


def directory(path, private=False):
    validate_parents(path)
    if path.exists() or path.is_symlink():
        info = path.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o022:
            raise RuntimeError(f"Refusing unsafe directory: {path}")
        if private and info.st_mode & 0o077:
            raise RuntimeError(f"Ownership state must be owner-only: {path}")
    else:
        path.mkdir(parents=True, mode=0o700)
    return path


def regular_bytes(path, private=False):
    validate_parents(path)
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except FileNotFoundError:
        return None
    except OSError as error:
        raise RuntimeError(f"Refusing to replace a non-regular skill file or unsafe state: {path}") from error
    try:
        info = os.fstat(fd)
        if (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1
                or info.st_uid != os.getuid() or info.st_mode & (0o077 if private else 0o022)
                or info.st_size > 1024 * 1024):
            raise RuntimeError(f"Refusing unsafe regular file: {path}")
        with os.fdopen(fd, "rb", closefd=False) as handle:
            data = handle.read(1024 * 1024 + 1)
        after = os.fstat(fd)
        if len(data) > 1024 * 1024 or (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns) != (
                after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns):
            raise RuntimeError(f"File changed during bounded read: {path}")
        return data
    finally:
        os.close(fd)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def atomic_write(path, data, mode=0o600, exclusive=False):
    validate_parents(path)
    fd, temporary = tempfile.mkstemp(prefix=".repo-mcp-skill-", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary, mode)
        if exclusive:
            os.link(temporary, path)
        else:
            os.replace(temporary, path)
        directory_fd = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass


def destinations(client="all"):
    codex = normalized(os.environ.get("CODEX_HOME", HOME / ".codex"))
    claude = normalized(os.environ.get("CLAUDE_HOME", HOME / ".claude"))
    items = [
        ("codex", ROOT / ".codex/skills/repo-mcp/SKILL.md", codex / "skills/repo-mcp/SKILL.md"),
        ("claude", ROOT / ".claude/skills/repo-mcp/SKILL.md", claude / "skills/repo-mcp/SKILL.md"),
        ("claude", ROOT / ".claude/skills/repo-mcp-review/SKILL.md", claude / "skills/repo-mcp-review/SKILL.md"),
    ]
    return [(source, target) for owner, source, target in items if client in ("all", owner)]


def state_directory():
    support = normalized(os.environ.get("REPO_MCP_HOME", HOME / "Library/Application Support/repo-mcp"))
    ledger = support / "agent-skills"
    # Ownership metadata must never be served from this or another registered checkout.
    if ledger == ROOT or ROOT in ledger.parents:
        raise RuntimeError("Skill ownership state must remain outside the control checkout.")
    for ancestor in (ledger, *ledger.parents):
        if (ancestor / ".git").exists():
            raise RuntimeError("Skill ownership state must remain outside every Git checkout.")
    state = normalized(os.environ.get("REPO_MCP_STATE_DIR", support / "state"))
    catalog_bytes = regular_bytes(state / "control/multirepo-catalog.json", private=True)
    if catalog_bytes is not None:
        catalog = json.loads(catalog_bytes)
        if catalog.get("version") != 1 or not isinstance(catalog.get("data", {}).get("repositories"), dict):
            raise RuntimeError("Cannot verify registered checkout boundaries from catalog.")
        for registration in catalog["data"]["repositories"].values():
            root = Path(registration["root"]).resolve()
            if ledger == root or root in ledger.parents:
                raise RuntimeError("Skill ownership state must remain outside every served checkout.")
    directory(support, private=True)
    return directory(ledger, private=True)


def main():
    parser = argparse.ArgumentParser()
    action = parser.add_mutually_exclusive_group(required=True)
    action.add_argument("--install", action="store_true")
    action.add_argument("--check", action="store_true")
    action.add_argument("--uninstall", action="store_true")
    parser.add_argument("--client", choices=("all", "codex", "claude"), default="all",
                        help="Limit the action to one client (default: all)")
    parser.add_argument("--replace", "--force", dest="replace", action="store_true",
                        help="Explicitly replace foreign/modified copies after making an owner-only backup")
    args = parser.parse_args()
    if args.replace and not args.install:
        parser.error("--replace requires --install")
    state_dir = state_directory()
    lock_path = state_dir / "install.lock"
    fd = os.open(lock_path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise RuntimeError("Unsafe skill installation lock.")
        fcntl.flock(fd, fcntl.LOCK_EX)
        state_path = state_dir / "installed.json"
        raw = regular_bytes(state_path, private=True)
        state = json.loads(raw) if raw is not None else {"version": 1, "skills": {}}
        if state.get("version") != 1 or not isinstance(state.get("skills"), dict):
            raise RuntimeError("Unrecognized skill ownership state.")
        def save():
            atomic_write(state_path, (json.dumps(state, indent=2) + "\n").encode())
        if args.uninstall:
            removals = []
            # Refuse the whole operation before removing any foreign or modified file.
            for _, target in destinations(args.client):
                current = regular_bytes(target)
                record = state["skills"].get(str(target), {})
                if not isinstance(record, dict):
                    raise RuntimeError(f"Invalid skill ownership record: {target}")
                owned_hashes = (record.get("sha256"), record.get("pending_sha256"))
                if current is not None and digest(current) not in owned_hashes:
                    raise RuntimeError(f"Foreign or user-modified skill preserved: {target}.")
                removals.append((target, current))
            for target, current in removals:
                if regular_bytes(target) != current:
                    raise RuntimeError(f"Skill changed after uninstall preflight; preserved: {target}")
                if current is not None:
                    target.unlink()
                    directory_fd = os.open(target.parent, os.O_RDONLY)
                    try:
                        os.fsync(directory_fd)
                    finally:
                        os.close(directory_fd)
                state["skills"].pop(str(target), None)
                save()
                print(f"removed: {target}" if current is not None else f"absent: {target}")
                try:
                    target.parent.rmdir()
                except OSError:
                    pass
            return 0
        plans = []
        stale = []
        # Preflight every destination before replacing any skill.
        for source, target in destinations(args.client):
            data = regular_bytes(source)
            if data is None:
                raise RuntimeError(f"Bundled skill is missing: {source}")
            current = regular_bytes(target)
            record = state["skills"].get(str(target), {})
            if not isinstance(record, dict):
                raise RuntimeError(f"Invalid skill ownership record: {target}")
            owned = current is not None and digest(current) in (record.get("sha256"), record.get("pending_sha256"))
            if current != data or not owned:
                stale.append(target)
            if args.install and current is not None and not owned and not args.replace:
                raise RuntimeError(f"Foreign or user-modified skill preserved: {target}. Use --install --replace to back it up and replace explicitly.")
            plans.append((target, data, current, record))
        if args.check:
            for target in stale:
                print(f"missing or stale: {target}")
            if not stale:
                print("Repo MCP agent skills are current.")
            return 1 if stale else 0
        for target, data, current, record in plans:
            directory(target.parent)
            if regular_bytes(target) != current:
                raise RuntimeError(f"Skill changed after preflight; preserved: {target}")
            if current == data and digest(current) in (record.get("sha256"), record.get("pending_sha256")):
                final_record = {**{key: value for key, value in record.items() if key != "pending_sha256"},
                                "sha256": digest(data)}
                if final_record != record:
                    state["skills"][str(target)] = final_record
                    save()
                print(f"current: {target}")
                continue
            if args.replace and current is not None:
                backups = directory(state_dir / "backups", private=True)
                backup = backups / (uuid.uuid4().hex + ".md")
                atomic_write(backup, current, exclusive=True)
                record = {**record, "backup": str(backup)}
            # A crash between replacement and final ownership publication is recognized
            # only by this exact pending hash, never by a filename or branding marker.
            state["skills"][str(target)] = {**record, "pending_sha256": digest(data)}
            save()
            if regular_bytes(target) != current:
                raise RuntimeError(f"Skill changed before publication; preserved: {target}")
            atomic_write(target, data, 0o644, exclusive=current is None)
            state["skills"][str(target)] = {**{key: value for key, value in record.items() if key != "pending_sha256"}, "sha256": digest(data)}
            save()
            print(f"installed: {target}")
        return 0
    finally:
        os.close(fd)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, RuntimeError) as error:
        print(str(error), file=__import__("sys").stderr)
        raise SystemExit(1)
