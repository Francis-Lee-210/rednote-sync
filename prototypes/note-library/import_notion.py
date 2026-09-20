#!/usr/bin/env python3
"""Import a preserved Notion archive into the common local library, offline."""
import argparse
import collections
import json
import os
import re
import runpy
from pathlib import Path
from urllib.parse import quote, urlsplit, urlunsplit

import library


# Reuse the audited parser, including literal '#' and parentheses in filenames.
_AUDIT = runpy.run_path(
    str(Path(__file__).resolve().parents[1] / 'notion-stage3' / 'audit_export.py'),
    run_name='notion_archive_parser',
)
ID = re.compile(r'[0-9a-f]{24}')
SHA256 = re.compile(r'[0-9a-f]{64}')


def archive_path(base, relative):
    """Resolve an archive-relative path without following symlinks or escaping."""
    relative = Path(relative)
    if relative.is_absolute() or '..' in relative.parts or not relative.parts:
        raise ValueError('Invalid archive-relative path')
    current = Path(base)
    for part in relative.parts:
        current /= part
        if current.is_symlink():
            raise ValueError('Archive paths must not contain symbolic links')
    if not current.resolve().is_relative_to(Path(base).resolve()):
        raise ValueError('Archive path escapes its root')
    return current


def video_url_key(url):
    """Match the source downloader's HTTP-to-HTTPS canonicalization, sans access data."""
    parsed = urlsplit(url)
    if parsed.scheme not in ('http', 'https') or not parsed.hostname:
        raise ValueError('Invalid archived video URL')
    return urlunsplit(('https', parsed.netloc.lower(), parsed.path, '', ''))


def append_unique(items, value):
    if value not in items:
        items.append(value)


class NotionImporter:
    def __init__(self, root, archive):
        self.root = Path(root).resolve()
        self.archive = Path(archive).resolve(strict=True)
        if not self.archive.is_relative_to(self.root):
            raise ValueError('Keep the source archive inside the library root')
        self.source = archive_path(self.archive, 'source/export')
        self.corpus_path = archive_path(self.archive, 'normalized/corpus.jsonl')
        self.inventory_path = archive_path(self.archive, 'normalized/inventory.json')
        self.video_index_path = archive_path(self.archive, 'supplemental/video-index.json')
        self.corpus = library.read_jsonl(self.corpus_path)
        self.corpus_sha256 = library.digest(self.corpus_path)
        inventory = json.loads(self.inventory_path.read_text(encoding='utf-8'))
        self.inventory = {}
        for item in inventory:
            path = item['path']
            archive_path(self.source, path)
            if path in self.inventory or not SHA256.fullmatch(item.get('sha256', '')):
                raise ValueError('Invalid or duplicate inventory entry')
            self.inventory[path] = item
        self.video_items = (json.loads(self.video_index_path.read_text(encoding='utf-8'))['items']
                            if self.video_index_path.is_file() else [])
        self.videos_by_note = collections.defaultdict(list)
        self.videos_by_url = {}
        for item in self.video_items:
            archive_path(self.archive, item['file'])
            for source_page in item.get('source_pages', []):
                archive_path(self.archive, source_page)
            for note_id in item['note_ids']:
                key = (note_id, video_url_key(item['url']))
                if key in self.videos_by_url:
                    raise ValueError('Ambiguous supplemental video mapping')
                self.videos_by_url[key] = item
                self.videos_by_note[note_id].append(item)
        ids = [row.get('id', '') for row in self.corpus]
        if any(not ID.fullmatch(note_id) for note_id in ids) or len(set(ids)) != len(ids):
            raise ValueError('Corpus IDs must be valid and unique')
        if set(self.videos_by_note) - set(ids):
            raise ValueError('Supplemental video refers to a note outside the corpus')

    def relative(self, path):
        return library.relative_source(self.root, path)

    def read_variant(self, row, relative):
        path = archive_path(self.source, relative)
        inventory = self.inventory.get(relative)
        if inventory is None or not path.is_file():
            raise ValueError('Source Markdown is missing from the archive or inventory')
        sha = library.digest(path)
        if sha != inventory['sha256']:
            raise ValueError('Source Markdown checksum mismatch')
        title, props, body = _AUDIT['split_page'](path.read_text(encoding='utf-8-sig'))
        source_id = props.get('resourceId', props.get('resourceid', '')).strip().lower()
        if source_id != row['id']:
            raise ValueError('Source Markdown note ID differs from the corpus')
        if relative == row['source_markdown'] and row.get('source_sha256') != sha:
            raise ValueError('Selected Markdown differs from the corpus checksum')
        page_id = re.search(r'([0-9a-f]{32})(?:_\d+)?$', path.stem, re.I)
        source = {'provider': 'notion', 'path': self.relative(path), 'sha256': sha,
                  'notion_page_id': page_id.group(1) if page_id else None,
                  'selected': relative == row['source_markdown']}
        sanitized = _AUDIT['scrub_text'](body)
        return {'path': path, 'source': source, 'title': _AUDIT['scrub_text'](title),
                'body_markdown': sanitized, 'body_text': _AUDIT['plain'](sanitized),
                'source_properties': {key: value if key == 'Url' else _AUDIT['scrub_text'](value) for key, value in props.items()}}

    def import_note(self, row):
        note_id = row['id']
        paths = row['source_variants']
        if not isinstance(paths, list) or len(set(paths)) != len(paths) or row['source_markdown'] not in paths:
            raise ValueError('Invalid source variant list')
        variants = {path: self.read_variant(row, path) for path in paths}
        selected = variants[row['source_markdown']]
        if selected['body_markdown'] != row['body_markdown']:
            raise ValueError('Selected body differs from the normalized corpus')
        relations = sorted({v['source_properties']['类型'] for v in variants.values()
                            if v['source_properties'].get('类型')})
        # These values are source relationships, not guesses about current account state.
        if sorted(row.get('source_relations', [])) != relations:
            raise ValueError('Source relationships differ from the corpus')

        media = []
        media_by_hash = {}
        unavailable_by_key = {}
        verified_sources = set()
        ordinals = collections.Counter()

        def install(path, kind, expected, reference, verification=None):
            if not SHA256.fullmatch(expected or ''):
                raise ValueError('Missing media checksum in source inventory')
            key = (kind, expected)
            source_key = (str(path), expected)
            if key not in media_by_hash:
                ordinals[kind] += 1
                entry = library.install_media(
                    self.root, note_id, path, kind, ordinals[kind],
                    expected_sha256=expected, verification=verification,
                    source_ref=self.relative(path),
                )
                entry['source_refs'] = []
                media.append(entry)
                media_by_hash[key] = entry
                verified_sources.add(source_key)
            else:
                entry = media_by_hash[key]
                # A duplicate checksum declaration does not prove the alternate source bytes.
                if source_key not in verified_sources:
                    if not path.is_file() or library.digest(path) != expected:
                        raise ValueError('Duplicate media source checksum mismatch')
                    verified_sources.add(source_key)
            append_unique(entry['source_refs'], reference)
            return entry

        def install_video(item, reference=None):
            path = archive_path(self.archive, item['file'])
            verify = item.get('verify', {})
            download = item.get('download', {})
            expected = verify.get('sha256') or download.get('sha256')
            if verify.get('sha256') and download.get('sha256') and verify['sha256'] != download['sha256']:
                raise ValueError('Supplemental video checksum records disagree')
            source_ref = {
                'provider': 'notion', 'path': self.relative(path), 'sha256': expected,
                'index_path': self.relative(self.video_index_path),
                'source_pages': [self.relative(archive_path(self.archive, p)) for p in item.get('source_pages', [])],
                'source_url': _AUDIT['scrub_url'](item['url']),
            }
            if reference is not None:
                source_ref['reference'] = reference
            return install(path, 'video', expected, source_ref, {
                'method': 'source_and_copy_sha256', 'full_decode': 'not_performed_during_import',
                'historical_source_verification': verify,
            })

        def resolve_media(ref, page, link_ordinal):
            reference = {'source_page': self.relative(page), 'link_ordinal': link_ordinal,
                         'label': ref.get('label', '')}
            kind = ref['kind'] if ref['kind'] in ('image', 'video') else 'attachment'
            if ref['storage'] == 'local':
                path = archive_path(self.source, ref['path'])
                inventory = self.inventory.get(ref['path'])
                if inventory is None:
                    raise ValueError('Local media is absent from the source inventory')
                source_ref = {'provider': 'notion', 'path': self.relative(path),
                              'sha256': inventory['sha256'], 'reference': reference}
                return install(path, kind, inventory['sha256'], source_ref)
            if ref['storage'] == 'missing_local':
                raise ValueError('Local media source is missing; preserve the archive and inspect it')
            if ref['storage'] == 'remote_reference' and kind == 'video':
                item = self.videos_by_url.get((note_id, video_url_key(ref['url'])))
                if item is not None:
                    return install_video(item, reference)
            # Preserve any unsupplemented remote reference explicitly; never fetch it here.
            key = (kind, ref['storage'], ref.get('url', ref.get('path', '')))
            if key not in unavailable_by_key:
                ordinals[kind] += 1
                entry = {'id': f'{kind}-{ordinals[kind]:03d}', 'kind': kind,
                         'status': ref['storage'], 'source_refs': []}
                if ref.get('url'):
                    entry['source_url'] = ref['url']
                media.append(entry)
                unavailable_by_key[key] = entry
            entry = unavailable_by_key[key]
            append_unique(entry['source_refs'], reference)
            return entry

        def rewrite(variant):
            body = variant['body_markdown']
            chunks, position, link_ordinal = [], 0, 0
            for start, end, is_image, label, raw in _AUDIT['links'](body):
                refs = _AUDIT['media_refs'](body[start:end], variant['path'], self.source)
                if not refs:
                    continue
                if len(refs) != 1:
                    raise ValueError('Ambiguous media link in source Markdown')
                link_ordinal += 1
                entry = resolve_media(refs[0], variant['path'], link_ordinal)
                if entry.get('status') != 'available':
                    continue
                replacement = ('!' if is_image else '') + '[' + label + ']('
                replacement += quote(entry['path'], safe='/.-_') + ')'
                chunks.extend((body[position:start], replacement))
                position = end
            chunks.append(body[position:])
            return ''.join(chunks)

        # Primary body order defines filenames; extra variant assets follow deterministically.
        for path in [row['source_markdown']] + [p for p in paths if p != row['source_markdown']]:
            variants[path]['rewritten_body'] = rewrite(variants[path])
        # Keep every supplemental source even when multiple URLs have identical video bytes.
        for item in self.videos_by_note[note_id]:
            install_video(item)

        source_url = row.get('source_url') or 'https://www.xiaohongshu.com/explore/' + note_id
        kind = ('video' if any(item['kind'] == 'video' for item in media) else
                'normal' if any(item['kind'] == 'image' for item in media) else 'unknown')
        source_properties = selected['source_properties']
        author_value = source_properties.get('作者')
        author = ({'name': _AUDIT['plain'](author_value), 'source_property': '作者',
                   'source_value': author_value} if author_value else None)
        record = {
            'note_id': note_id, 'title': selected['title'], 'body_text': selected['body_text'],
            'body_markdown': selected['rewritten_body'], 'type': kind,
            'source_url': source_url, 'author': author,
            'sources': [variants[path]['source'] for path in paths],
            'relations': [{'kind': {'点赞': 'liked', '收藏': 'collected'}.get(label, 'unknown'),
                           'value': True, 'provider': 'notion', 'source_label': label}
                          for label in relations],
            'source_relations': relations, 'media': media,
            'source_tags': row.get('source_tags', []),
            'source_tags_origin': row.get('source_tags_origin'),
            'normalization_source': {'provider': 'notion', 'path': self.relative(self.corpus_path),
                                     'sha256': self.corpus_sha256},
            'variants': [{
                'source': variants[path]['source'], 'title': variants[path]['title'],
                'body_text': variants[path]['body_text'],
                'body_markdown': variants[path]['rewritten_body'],
                'source_properties': variants[path]['source_properties'],
            } for path in paths],
        }
        status = library.put_note(self.root, record)
        return {'status': status, 'variants': len(paths), 'media': len(media),
                'available_media': sum(m.get('status') == 'available' for m in media), 'type': kind}

    def run(self):
        counts = collections.Counter()
        types = collections.Counter()
        for index, row in enumerate(self.corpus, 1):
            result = self.import_note(row)
            counts[result['status']] += 1
            counts['notes'] += 1
            for key in ('variants', 'media', 'available_media'):
                counts[key] += result[key]
            types[result['type']] += 1
            if index % 100 == 0:
                print(json.dumps({'event': 'progress', 'notes': index, 'total': len(self.corpus)}, ensure_ascii=False), flush=True)
        return {'status': 'complete', 'provider': 'notion', 'counts': dict(counts), 'types': dict(types)}


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--archive', type=Path, required=True)
    args = parser.parse_args()
    result = NotionImporter(args.root, args.archive).run()
    print(json.dumps(result, ensure_ascii=False), flush=True)


if __name__ == '__main__':
    main()
