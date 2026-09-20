"""Offline migration regressions using synthetic archives only."""
import hashlib
import json
import tempfile
import unittest
from pathlib import Path

import import_notion
import library


NOTE = '1' * 24
EMPTY_NOTE = '2' * 24


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def fixture(base):
    root = base / '资料库'
    archive = root / '原始来源' / '历史导出' / 'fixture'
    source = archive / 'source' / 'export'
    images = source / 'media (images)'
    images.mkdir(parents=True)
    first_image = images / 'dup (#one).webp'
    duplicate_image = images / 'duplicate.webp'
    extra_image = images / 'extra.webp'
    first_image.write_bytes(b'synthetic-shared-image')
    duplicate_image.write_bytes(first_image.read_bytes())
    extra_image.write_bytes(b'synthetic-variant-only-image')
    first = source / ('primary ' + 'a' * 32 + '.md')
    second = source / ('variant ' + 'b' * 32 + '.md')
    empty = source / ('empty ' + 'c' * 32 + '.md')
    first.write_text(
        '# Primary synthetic title\n\nresourceId: ' + NOTE + '\n类型: 点赞\n'
        'Url: https://www.xiaohongshu.com/explore/' + NOTE + '?example=one\n'
        '作者: Synthetic Author\n状态: Source value\n\n'
        'A longer primary description that must remain the selected body.\n\n'
        '![primary](media%20(images)/dup%20(#one).webp)\n\n'
        '[video](https://sns-bak-v1.xhscdn.com/fixture-primary.mp4)\n', encoding='utf-8')
    second.write_text(
        '# Alternate synthetic title\n\nresourceId: ' + NOTE + '\n类型: 收藏\n'
        'Url: https://www.xiaohongshu.com/explore/' + NOTE + '\n'
        '作者: Other source author value\n状态: Different source value\n\n'
        'Alternate body.\n\n![duplicate](media%20(images)/duplicate.webp)\n\n'
        '![extra](media%20(images)/extra.webp)\n\n'
        '[alternate video](https://sns-bak-v6.xhscdn.com/fixture-alternate.mp4)\n', encoding='utf-8')
    empty.write_text('# Empty source\n\nresourceId: ' + EMPTY_NOTE + '\n类型: 点赞\n\n', encoding='utf-8')
    inventory = [{'path': str(p.relative_to(source)), 'bytes': p.stat().st_size,
                  'sha256': sha(p), 'kind': 'image' if p.suffix == '.webp' else 'other'}
                 for p in sorted(source.rglob('*')) if p.is_file()]
    corpus = []
    for note_id, chosen, pages, relations in [(NOTE, first, [first, second], ['收藏', '点赞']),
                                              (EMPTY_NOTE, empty, [empty], ['点赞'])]:
        title, props, body = import_notion._AUDIT['split_page'](chosen.read_text())
        sanitized = import_notion._AUDIT['scrub_text'](body)
        corpus.append({'id': note_id, 'title': title, 'source_markdown': str(chosen.relative_to(source)),
                       'source_variants': [str(p.relative_to(source)) for p in pages],
                       'source_sha256': sha(chosen), 'source_relations': relations,
                       'source_url': import_notion._AUDIT['scrub_url'](props.get('Url', '')),
                       'body_markdown': sanitized, 'body_text': import_notion._AUDIT['plain'](sanitized),
                       'source_tags': [], 'source_tags_origin': 'Synthetic source'})
    normalized = archive / 'normalized'
    normalized.mkdir()
    (normalized / 'inventory.json').write_text(json.dumps(inventory), encoding='utf-8')
    (normalized / 'corpus.jsonl').write_text(''.join(json.dumps(row) + '\n' for row in corpus), encoding='utf-8')
    videos = archive / 'supplemental' / 'videos'
    videos.mkdir(parents=True)
    items = []
    for suffix, page, host in [('primary', first, 'v1'), ('alternate', second, 'v6')]:
        path = videos / (suffix + '.mp4')
        path.write_bytes(b'synthetic-same-video-content')
        digest = sha(path)
        items.append({'url': 'https://sns-bak-' + host + '.xhscdn.com/fixture-' + suffix + '.mp4',
                      'file': str(path.relative_to(archive)), 'note_ids': [NOTE],
                      'source_pages': [str(page.relative_to(archive))],
                      'download': {'status': 'downloaded', 'sha256': digest},
                      'verify': {'status': 'verified', 'sha256': digest, 'bytes': path.stat().st_size}})
    (archive / 'supplemental' / 'video-index.json').write_text(json.dumps({'items': items}), encoding='utf-8')
    return root, archive, duplicate_image


class NotionImportTest(unittest.TestCase):
    def test_variants_media_links_and_repeat_import_are_preserved(self):
        with tempfile.TemporaryDirectory() as directory:
            root, archive, _ = fixture(Path(directory))
            before = {p.relative_to(archive): sha(p) for p in archive.rglob('*') if p.is_file()}
            result = import_notion.NotionImporter(root, archive).run()
            self.assertEqual(result['counts']['notes'], 2)
            self.assertEqual(result['counts']['variants'], 3)
            self.assertEqual(result['counts']['available_media'], 3)
            folder = library.note_dir(root, NOTE)
            record = json.loads((folder / '元数据.json').read_text())
            self.assertEqual(record['type'], 'video')
            self.assertEqual(record['relations'], [
                {'kind': 'collected', 'value': True, 'provider': 'notion', 'source_label': '收藏'},
                {'kind': 'liked', 'value': True, 'provider': 'notion', 'source_label': '点赞'},
            ])
            self.assertEqual(record['source_relations'], ['收藏', '点赞'])
            self.assertEqual(len(record['variants']), 2)
            self.assertEqual(len(record['sources']), 2)
            self.assertNotEqual(record['variants'][0]['body_text'], record['variants'][1]['body_text'])
            self.assertNotEqual(record['variants'][0]['source_properties'], record['variants'][1]['source_properties'])
            self.assertEqual(len(record['media']), 3)
            self.assertNotIn('xhscdn.com', record['body_markdown'])
            self.assertNotIn('media%20', record['body_markdown'])
            for variant in record['variants']:
                for _, _, _, _, path in import_notion._AUDIT['links'](variant['body_markdown']):
                    self.assertTrue((folder / path).is_file())
            duplicate = next(m for m in record['media'] if m['sha256'] == hashlib.sha256(b'synthetic-shared-image').hexdigest())
            self.assertEqual(len(duplicate['source_refs']), 2)
            video = next(m for m in record['media'] if m['kind'] == 'video')
            self.assertEqual(len({r['path'] for r in video['source_refs']}), 2)
            for item in record['media']:
                self.assertEqual(sha(folder / item['path']), item['sha256'])
                for reference in item['source_refs']:
                    self.assertFalse(Path(reference['path']).is_absolute())
                    self.assertTrue((root / reference['path']).is_file())
            unknown = json.loads((library.note_dir(root, EMPTY_NOTE) / '元数据.json').read_text())
            self.assertEqual(unknown['type'], 'unknown')
            self.assertEqual(unknown['content_status'], 'empty_in_source')
            self.assertIsNone(unknown['author'])
            result = import_notion.NotionImporter(root, archive).run()
            self.assertEqual(result['counts']['reused'], 2)
            self.assertFalse((folder / '历史版本').exists())
            after = {p.relative_to(archive): sha(p) for p in archive.rglob('*') if p.is_file()}
            self.assertEqual(before, after)

    def test_alternate_duplicate_bytes_are_checked(self):
        with tempfile.TemporaryDirectory() as directory:
            root, archive, duplicate = fixture(Path(directory))
            duplicate.write_bytes(b'changed-synthetic-image')
            with self.assertRaisesRegex(ValueError, 'Duplicate media source checksum mismatch'):
                import_notion.NotionImporter(root, archive).run()
            self.assertFalse((library.note_dir(root, NOTE) / '元数据.json').exists())

    def test_source_body_change_is_rejected_before_note_is_written(self):
        with tempfile.TemporaryDirectory() as directory:
            root, archive, _ = fixture(Path(directory))
            primary = archive / 'source' / 'export' / ('primary ' + 'a' * 32 + '.md')
            primary.write_text(primary.read_text() + '\nChanged after auditing.\n')
            with self.assertRaisesRegex(ValueError, 'Source Markdown checksum mismatch'):
                import_notion.NotionImporter(root, archive).run()
            self.assertFalse((library.note_dir(root, NOTE) / '元数据.json').exists())

    def test_archive_paths_cannot_escape_or_follow_symlinks(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            with self.assertRaisesRegex(ValueError, 'archive-relative path'):
                import_notion.archive_path(base, '../outside.webp')
            (base / 'real').mkdir()
            (base / 'alias').symlink_to(base / 'real', target_is_directory=True)
            with self.assertRaisesRegex(ValueError, 'symbolic links'):
                import_notion.archive_path(base, 'alias/file.webp')


if __name__ == '__main__':
    unittest.main()
