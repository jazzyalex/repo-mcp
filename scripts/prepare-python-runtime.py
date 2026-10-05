"""Copy installed pytest dependencies into a private, operator-owned pilot runtime.

No downloads or installations. Refuses to overwrite an existing runtime.
"""
from pathlib import Path
import importlib.util
import json
import shutil
import sys

root = Path(__file__).resolve().parents[1]
destination = root / '.trial' / 'python-runtime'
destination.mkdir(parents=True, exist_ok=False)
for name in ['pytest', '_pytest', 'pluggy', 'iniconfig', 'packaging', 'pygments', 'py']:
    spec = importlib.util.find_spec(name)
    if spec is None or spec.origin is None:
        raise RuntimeError(f'Required installed dependency missing: {name}')
    source = Path(spec.origin)
    if spec.submodule_search_locations:
        shutil.copytree(source.parent, destination / name,
                        ignore=shutil.ignore_patterns('__pycache__', '*.pyc'))
    else:
        shutil.copyfile(source, destination / source.name)
print(json.dumps({'kind': 'python-pytest', 'executable': str(Path(sys.executable).resolve()),
                  'dependencies': str(destination)}, indent=2))
