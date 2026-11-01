"""Canonical ZIP: sorted POSIX names, fixed DOS timestamp/mode, no extra fields.
Inputs are never edited. Reproducibility requires the recorded Python/zlib.
"""
import hashlib, json, pathlib, sys, zipfile
root, dest = map(lambda s: pathlib.Path(s).resolve(), sys.argv[1:3])
if not root.is_dir() or dest.exists():
    raise SystemExit('Input directory required; output must not already exist')
files = sorted(p for p in root.rglob('*') if p.is_file())
if any(p.is_symlink() for p in root.rglob('*')):
    raise SystemExit('Symlinks are not release inputs')
dest.parent.mkdir(parents=True, exist_ok=True)
manifest = {}
with zipfile.ZipFile(dest, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as out:
    for p in files:
        name = p.relative_to(root).as_posix()
        info = zipfile.ZipInfo(name, (2026, 1, 1, 0, 0, 0))
        info.create_system = 3
        info.external_attr = 0o100644 << 16
        info.compress_type = zipfile.ZIP_DEFLATED
        data = p.read_bytes()
        out.writestr(info, data, compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)
        manifest[name] = {'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()}
with zipfile.ZipFile(dest) as check:
    assert check.namelist() == list(manifest)
    for name, row in manifest.items():
        assert hashlib.sha256(check.read(name)).hexdigest() == row['sha256']
digest = hashlib.sha256(dest.read_bytes()).hexdigest()
dest.with_suffix(dest.suffix + '.sha256').write_text(f'{digest}  {dest.name}\n')
dest.with_suffix(dest.suffix + '.files.json').write_text(json.dumps(manifest, indent=2) + '\n')
print(json.dumps({'zip': str(dest), 'bytes': dest.stat().st_size, 'sha256': digest, 'files': len(files)}))
