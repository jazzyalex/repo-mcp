#!/usr/bin/env python3
"""Install Repo MCP's bundled Codex and Claude skills into user skill directories."""

import argparse
import os
from pathlib import Path
import shutil
import tempfile


ROOT = Path(__file__).resolve().parents[1]


def destinations() -> list[tuple[Path, Path]]:
    codex_home = Path(os.environ.get("CODEX_HOME", Path.home() / ".codex")).expanduser()
    claude_home = Path(os.environ.get("CLAUDE_HOME", Path.home() / ".claude")).expanduser()
    return [
        (ROOT / ".codex/skills/repo-mcp/SKILL.md", codex_home / "skills/repo-mcp/SKILL.md"),
        (ROOT / ".claude/skills/repo-mcp/SKILL.md", claude_home / "skills/repo-mcp/SKILL.md"),
        (ROOT / ".claude/skills/repo-mcp-review/SKILL.md", claude_home / "skills/repo-mcp-review/SKILL.md"),
    ]


def same(source: Path, target: Path) -> bool:
    try:
        return target.is_file() and not target.is_symlink() and target.read_bytes() == source.read_bytes()
    except OSError:
        return False


def install(source: Path, target: Path) -> None:
    if source.is_symlink() or not source.is_file():
        raise RuntimeError(f"Bundled skill is not a regular file: {source}")
    target.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
    if target.is_symlink() or (target.exists() and not target.is_file()):
        raise RuntimeError(f"Refusing to replace a non-regular skill file: {target}")
    fd, temporary = tempfile.mkstemp(prefix=".repo-mcp-skill-", dir=target.parent)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(source.read_bytes())
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary, 0o644)
        os.replace(temporary, target)
        os.chmod(target, 0o644)
        directory_fd = os.open(target.parent, os.O_RDONLY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass


def main() -> int:
    parser = argparse.ArgumentParser()
    action = parser.add_mutually_exclusive_group(required=True)
    action.add_argument("--install", action="store_true", help="Install or update the bundled skills")
    action.add_argument("--check", action="store_true", help="Check whether the bundled skills are current")
    args = parser.parse_args()

    stale: list[Path] = []
    for source, target in destinations():
        if not same(source, target):
            stale.append(target)
            if args.install:
                install(source, target)

    if args.check and stale:
        for target in stale:
            print(f"missing or stale: {target}")
        return 1
    if args.install:
        for _, target in destinations():
            print(f"installed: {target}")
    else:
        print("Repo MCP agent skills are current.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
