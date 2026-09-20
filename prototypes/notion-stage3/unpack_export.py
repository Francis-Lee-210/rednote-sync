#!/usr/bin/env python3
"""Validate and extract a user-requested Notion ZIP without rewriting the archive."""
import argparse
import hashlib
import json
import os
import shutil
import stat
import zipfile
from pathlib import Path, PurePosixPath


def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()


def extract(archive, target):
    with zipfile.ZipFile(archive) as z:
        entries = z.infolist()
        planned = set()
        size = 0
        for entry in entries:
            path = PurePosixPath(entry.filename)
            mode = entry.external_attr >> 16
            if path.is_absolute() or '..' in path.parts or '\\' in entry.filename or '\x00' in entry.filename or stat.S_ISLNK(mode):
                raise ValueError('Unsafe archive entry; extraction refused')
            if not path.parts or ':' in path.parts[0]:
                raise ValueError('Ambiguous archive entry; extraction refused')
            key = str(path).casefold()
            if not entry.is_dir() and key in planned:
                raise ValueError('Duplicate case-insensitive archive path; extraction refused')
            if not entry.is_dir():
                planned.add(key)
            size += entry.file_size
        if size + 1024 ** 3 > shutil.disk_usage(target.parent).free:
            raise ValueError('Insufficient free space for complete archive extraction with 1 GiB reserve')
        if target.exists():
            raise ValueError('Destination already exists; refusing to merge or overwrite')
        target.mkdir(mode=0o700)
        for entry in entries:
            destination = target.joinpath(*PurePosixPath(entry.filename).parts)
            if entry.is_dir():
                destination.mkdir(mode=0o700, parents=True, exist_ok=True)
                continue
            destination.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            with z.open(entry) as src, destination.open('xb') as dst:
                shutil.copyfileobj(src, dst, length=1024 * 1024)
            destination.chmod(0o600)
    return {'files': len(planned), 'uncompressed_bytes': size, 'crc': 'verified while reading every ZIP member'}


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('archive', type=Path)
    p.add_argument('destination', type=Path)
    a = p.parse_args()
    os.umask(0o077)
    archive = a.archive.resolve(strict=True)
    target = a.destination.resolve()
    target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    print(json.dumps({'archive_sha256': digest(archive), **extract(archive, target)}, indent=2))


if __name__ == '__main__':
    main()
