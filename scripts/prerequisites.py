"""Shared prerequisite gate; keep this module parseable on older Python 3."""
import sys

PYTHON_MINIMUM = (3, 9)


def require_python(version=None):
    current = sys.version_info if version is None else version
    if tuple(current[:2]) < PYTHON_MINIMUM:
        raise SystemExit("Repo MCP normal installation requires Python 3.9 or newer. "
                         "pytest is needed only for the optional Python fixture runner.")
