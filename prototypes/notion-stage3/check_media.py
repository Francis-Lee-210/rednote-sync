#!/usr/bin/env python3
"""Read-only decoding/metadata checks for media physically included in an export."""
import argparse
import collections
import concurrent.futures
import json
import subprocess
import warnings
from pathlib import Path

from PIL import Image


def check(item, root):
    path = (root / item['path']).resolve(strict=True)
    if not path.is_relative_to(root) or path.is_symlink():
        raise ValueError('Media path outside export')
    result = {'path': item['path'], 'kind': item['kind'], 'bytes': path.stat().st_size}
    try:
        if item['kind'] == 'image':
            if path.suffix.lower() == '.svg':
                return {**result, 'status': 'not_decoded', 'check': 'SVG outside raster decoder scope'}
            with warnings.catch_warnings():
                warnings.simplefilter('error', Image.DecompressionBombWarning)
                with Image.open(path) as image:
                    image.load()
                    result.update(status='decoded', check='first image frame decoded', width=image.width, height=image.height, format=image.format, frames=getattr(image, 'n_frames', 1))
        else:
            run = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration,size:stream=codec_type,codec_name,width,height', '-of', 'json', str(path)], capture_output=True, text=True, timeout=25, check=True)
            data = json.loads(run.stdout)
            result.update(status='metadata_read', check='ffprobe metadata only; full playback not verified', metadata=data)
    except Exception as error:
        result.update(status='failed', error_type=type(error).__name__)
    return result


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--export-dir', type=Path, required=True)
    p.add_argument('--inventory', type=Path, required=True)
    p.add_argument('--out', type=Path, required=True)
    a = p.parse_args()
    root = a.export_dir.resolve(strict=True)
    items = [item for item in json.loads(a.inventory.read_text()) if item['kind'] in ('image', 'video', 'audio')]
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(lambda item: check(item, root), items))
    summary = dict(collections.Counter(f"{item['kind']}:{item['status']}" for item in results))
    a.out.write_text(json.dumps({'scope': 'Only files physically present; cannot prove completeness against original Xiaohongshu posts', 'summary': summary, 'files': results}, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    a.out.chmod(0o600)
    print(json.dumps(summary, ensure_ascii=False))


if __name__ == '__main__':
    main()
