"""Check normal macOS onboarding dependencies without changing local state."""
import argparse
import re
import shutil
import subprocess
import sys
from prerequisites import require_python

require_python()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--python-only", action="store_true")
    args = parser.parse_args()
    if args.python_only:
        print("Python 3.9+ prerequisite verified; pytest is optional.")
        return
    if sys.platform != "darwin":
        parser.error("Repo MCP normal installation supports macOS only.")
    for command in ("node", "npm", "/usr/bin/git"):
        executable = shutil.which(command)
        if not executable:
            parser.error("Missing prerequisite: " + command)
        try:
            result = subprocess.run([executable, "--version"], capture_output=True, text=True, timeout=10)
        except (OSError, subprocess.TimeoutExpired):
            parser.error("Cannot verify prerequisite within 10 seconds: " + command)
        if result.returncode:
            parser.error("Cannot verify prerequisite: " + command)
        if command == "node":
            match = re.fullmatch(r"v(\d+)\.\d+\.\d+\s*", result.stdout)
            if not match or int(match.group(1)) < 26:
                parser.error("Node 26 or newer is required.")
    print("macOS, Python 3.9+, Node 26+, npm and Git verified; pytest is optional.")


if __name__ == "__main__":
    main()
