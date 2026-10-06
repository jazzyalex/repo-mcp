"""Build an allowlisted source archive; never include runtime or private evidence."""
from prerequisites import require_python
require_python()
from pathlib import Path
import argparse
import gzip
import hashlib
import io
import json
import tarfile
import re

parser = argparse.ArgumentParser()
parser.add_argument('--output-dir', type=Path, help='Optional archive output directory (for isolated release validation)')
args = parser.parse_args()
base = Path(__file__).resolve().parents[1]
version = json.loads((base/'package.json').read_text())['version']
name = f'repo-mcp-{version}'
files = {p:base/p for p in ['package.json','package-lock.json','tsconfig.json','LICENSE','SETUP.md','SECURITY.md','AGENTS.md','CLAUDE.md','.gitignore']}
files['README.md'] = base/'docs/PUBLIC-README.md'
for doc in ['docs/MULTI-REPO-SPEC.md', 'docs/V1-HARDENING-SPEC.md', 'docs/DESIGN-2B-PATH-POLICY.md', 'docs/WORKFLOW-SPEC.md', 'docs/policy-readonly.json', 'docs/policy-coding.json']:
    files[doc] = base/doc
files['.claude/skills/repo-mcp-review/SKILL.md'] = base/'.claude/skills/repo-mcp-review/SKILL.md'
files['.claude/skills/repo-mcp/SKILL.md'] = base/'.claude/skills/repo-mcp/SKILL.md'
files['.codex/skills/repo-mcp/SKILL.md'] = base/'.codex/skills/repo-mcp/SKILL.md'
for folder in ['src','scripts','test','examples']:
    for p in sorted((base/folder).rglob('*')):
        if p.is_file() and p.suffix in {'.ts','.mjs','.py','.sh','.json'} and '__pycache__' not in p.parts:
            files[str(p.relative_to(base))] = p
# The packaging script needs its public README input when used from an extraction.
files['docs/PUBLIC-README.md'] = base/'docs/PUBLIC-README.md'
contents = {}
for relative, source in sorted(files.items()):
    if source.is_symlink():
        raise RuntimeError(f'Symlink refused: {relative}')
    data = source.read_bytes()
    if re.search(rb'/Users/[A-Za-z0-9._-]+/|sk-proj-[A-Za-z0-9_-]{24,}|tunnel_[0-9a-f]{32}', data):
        raise RuntimeError(f'Private-data marker in {relative}; review before packaging')
    contents[relative] = data
manifest = {n:hashlib.sha256(data).hexdigest() for n,data in contents.items()}
contents['SOURCE-MANIFEST.json'] = (json.dumps(manifest,indent=2)+'\n').encode()
output = args.output_dir or base/'release'; output.mkdir(parents=True, exist_ok=True)
archive = output/(name+'.tar.gz')
with archive.open('wb') as raw:
    with gzip.GzipFile(fileobj=raw,mode='wb',mtime=0,filename='') as gz:
        with tarfile.open(fileobj=gz,mode='w') as tar:
            for relative,data in sorted(contents.items()):
                info = tarfile.TarInfo(name+'/'+relative)
                info.size=len(data); info.mode=0o644; info.mtime=0
                tar.addfile(info,io.BytesIO(data))
digest=hashlib.sha256(archive.read_bytes()).hexdigest()
(output/(archive.name+'.sha256')).write_text(digest+'  '+archive.name+'\n')
print(json.dumps({'archive':str(archive),'files':len(contents),'sha256':digest},indent=2))
