#!/usr/bin/env python3
"""Build a private, offline review snapshot; never change canonical notes."""
import argparse
import json
import os
import posixpath
import re
import subprocess
import tempfile
from collections import Counter
from pathlib import Path
from urllib.parse import quote, urlencode, urlsplit
from xml.etree import ElementTree as ET
from zipfile import ZipFile

from library import DEFAULT_ROOT, copy_preserving, now, read_jsonl, save_json

NS = {'s': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}


def collection_rows(path):
    """Read string data only, without evaluating formulae or fetching links."""
    with ZipFile(path) as archive:
        workbook = ET.fromstring(archive.read('xl/workbook.xml'))
        sheets = workbook.findall('s:sheets/s:sheet', NS)
        sheet = next((s for s in sheets if s.attrib['name'] == '收藏夹'), None)
        if sheet is None:
            raise ValueError('Expected 收藏夹 worksheet')
        relation_id = sheet.attrib['{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id']
        rels = ET.fromstring(archive.read('xl/_rels/workbook.xml.rels'))
        relation = next(r for r in rels if r.attrib['Id'] == relation_id)
        if relation.attrib.get('TargetMode') == 'External':
            raise ValueError('External worksheet is not supported')
        target = posixpath.normpath(posixpath.join('xl', relation.attrib['Target']))
        if target.startswith('/'):
            target = target.lstrip('/')
        if not target.startswith('xl/'):
            raise ValueError('Invalid worksheet path')
        strings = []
        if 'xl/sharedStrings.xml' in archive.namelist():
            strings = [''.join(si.itertext()) for si in ET.fromstring(archive.read('xl/sharedStrings.xml'))]
        worksheet = ET.fromstring(archive.read(target))
        rows = []
        for row in worksheet.findall('s:sheetData/s:row', NS):
            cells = {}
            for cell in row.findall('s:c', NS):
                if cell.find('s:f', NS) is not None:
                    raise ValueError('Formula in source data; explicit review required')
                column = re.match(r'[A-Z]+', cell.attrib['r']).group()
                value = cell.findtext('s:v', '', NS)
                if cell.attrib.get('t') == 's':
                    value = strings[int(value)]
                elif cell.attrib.get('t') == 'inlineStr':
                    value = ''.join(t.text or '' for t in cell.findall('.//s:t', NS))
                cells[column] = value
            rows.append(cells)
        headers = rows[0]
        if not {'note_id', 'xsec_token'}.issubset(headers.values()):
            raise ValueError('Missing collection columns')
        return [{name: row.get(col, '') for col, name in headers.items()}
                for row in rows[1:] if any(row.values())]


def select_candidates(old_rows, liked_rows):
    old = {row['id']: row for row in old_rows}
    liked = {row['note_id']: row for row in liked_rows}
    missing = {nid for nid, row in old.items()
               if '点赞' in row.get('source_relations', []) and nid not in liked}
    conflicts = {nid for nid, row in liked.items() if row.get('interact_info.liked') is False}
    excluded = {nid for nid, row in old.items()
                if nid not in liked and '点赞' not in row.get('source_relations', [])}
    return missing, conflicts, excluded


def local_media(root, nid, entry):
    path = Path(entry['path'])
    base = root / '笔记' / nid
    if path.is_absolute() or '..' in path.parts or not path.parts or path.parts[0] != 'media':
        raise ValueError('Unsafe media path')
    full = base / path
    if full.is_symlink() or not full.is_file() or not full.resolve().is_relative_to((base / 'media').resolve()):
        raise ValueError('Missing or unsafe local media')
    return {'kind': entry['kind'], 'id': entry['id'],
            'url': '/media/' + nid + '/' + quote(path.relative_to('media').as_posix(), safe='/')}


def check_jpeg(path):
    with Path(path).open('rb') as stream:
        if stream.read(3) != b'\xff\xd8\xff':
            raise ValueError('Preview is not a JPEG')
        stream.seek(-2, os.SEEK_END)
        if stream.read() != b'\xff\xd9':
            raise ValueError('Truncated JPEG preview; macOS decoder may require sandbox permission')


def browser_media(root, output, nid, entry):
    item = local_media(root, nid, entry)
    source = root / '笔记' / nid / entry['path']
    if entry['kind'] != 'image' or source.suffix.lower() not in ('.heic', '.heif'):
        return item
    # JPEGs are disposable browser previews. The archived HEIC stays untouched.
    target = output / 'previews' / nid / (source.stem + '.jpg')
    target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    if target.is_symlink():
        raise ValueError('Unsafe preview path')
    if not target.exists():
        fd, temporary = tempfile.mkstemp(suffix='.jpg', dir=target.parent)
        os.close(fd)
        try:
            subprocess.run(['/usr/bin/sips', '-s', 'format', 'jpeg', str(source), '--out', temporary],
                           check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=60)
            check_jpeg(temporary)
            os.chmod(temporary, 0o600)
            os.replace(temporary, target)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)
    check_jpeg(target)
    item['original_url'] = item['url']
    item['url'] = '/preview/' + nid + '/' + quote(target.name)
    return item


def build(root, liked_path, collection_path, corpus_path, output):
    root, output = Path(root).resolve(), Path(output).resolve()
    liked = json.loads(Path(liked_path).read_text())
    old = read_jsonl(corpus_path)
    collection = collection_rows(collection_path)
    collected = {}
    for row in collection:
        if not re.fullmatch(r'[0-9a-f]{24}', row['note_id']):
            raise ValueError('Invalid collection note ID')
        collected[row['note_id']] = row
    missing, conflicts, excluded = select_candidates(old, liked['notes'])
    sources = []
    for path in map(Path, (liked_path, collection_path, corpus_path)):
        destination = output / 'sources' / path.name
        receipt = copy_preserving(path, destination)
        sources.append({'path': str(destination.relative_to(output)), **receipt})
    notes = []
    for nid in sorted(missing | conflicts):
        if not re.fullmatch(r'[0-9a-f]{24}', nid):
            raise ValueError('Invalid note ID')
        record = json.loads((root / '笔记' / nid / '元数据.json').read_text())
        media = [browser_media(root, output, nid, item) for item in record['media'] if item.get('status') == 'available']
        source_url = record.get('source_url', '')
        source_ref = record.get('source_url_source_ref', 'canonical_metadata')
        if nid in collected and collected[nid].get('xsec_token', '').strip():
            source_url = 'https://www.xiaohongshu.com/explore/' + nid + '?' + urlencode({'xsec_token': collected[nid]['xsec_token'].strip()})
            source_ref = 'sources/' + Path(collection_path).name + '#收藏夹:note_id=' + nid
        parsed = urlsplit(source_url)
        if parsed.scheme != 'https' or parsed.hostname not in ('www.xiaohongshu.com', 'xiaohongshu.com', 'xhslink.com'):
            source_url = ''
        notes.append({'id': nid, 'title': record['title'],
                      'author': (record.get('author') or {}).get('name') or '作者未知',
                      'type': record['type'], 'reason': 'missing_liked' if nid in missing else 'liked_conflict',
                      'collected': nid in collected,
                      'cover': next((item['url'] for item in media if item['kind'] == 'image'), ''),
                      'body': record['body_text'], 'media': media, 'source_url': source_url,
                      'source_url_source_ref': source_ref})
    counts = Counter(note['reason'] for note in notes)
    summary = {'generated_at': now(), 'old_snapshot_date': '2026-09-12',
               'liked_exported_at': liked['exported_at'], 'collection_snapshot_date': '2026-09-20',
               'total': len(notes), 'missing_liked': counts['missing_liked'],
               'liked_conflict': counts['liked_conflict'], 'collection_rows': len(collection),
               'collection_unique': len(collected), 'candidate_collected': sum(n['collected'] for n in notes),
               'collection_only_excluded': len(excluded), 'sources': sources,
               'jpeg_previews': sum(item['url'].startswith('/preview/') for note in notes for item in note['media']),
               'caveat': '点赞快照为 2026-09-16，收藏快照为 2026-09-20；列表缺失不等于取消点赞，收藏缺失不等于取消收藏。请人工核对当前状态。'}
    save_json(output / 'board.json', {'summary': summary, 'notes': notes})
    return summary


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=DEFAULT_ROOT)
    parser.add_argument('--liked', type=Path, required=True)
    parser.add_argument('--collection', type=Path, required=True)
    parser.add_argument('--corpus', type=Path)
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    result = build(args.root, args.liked, args.collection,
                   args.corpus or args.root / '原始来源/历史导出/2026-09-12/normalized/corpus.jsonl',
                   args.output or args.root / '复核看板')
    print(json.dumps({k: v for k, v in result.items() if k != 'sources'}, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
