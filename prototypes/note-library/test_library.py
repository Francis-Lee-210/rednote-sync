import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import library


class LibraryPreservation(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.note_id = 'a' * 24

    def record(self, **extra):
        return {'note_id': self.note_id, 'title': 'Example', 'body_text': 'Original body',
                'type': 'normal', 'sources': [{'provider': 'synthetic'}], **extra}

    def test_user_export_token_overrides_full_link_and_survives_reimport(self):
        library.put_note(self.root, self.record(source_url='https://www.xiaohongshu.com/explore/' + self.note_id + '?xsec_token=old&xsec_source=pc_collect'))
        source = self.root / 'input.json'
        source.write_text(json.dumps({'notes': [{'note_id': self.note_id, 'xsec_token': 'post+token=', 'user.xsec_token': 'wrong-user-token'}]}))
        result = library.apply_export_links(self.root, source)
        self.assertEqual(result['eligible'], 1)
        path = self.root / '笔记' / self.note_id / '元数据.json'
        expected = 'https://www.xiaohongshu.com/explore/' + self.note_id + '?xsec_token=post%2Btoken%3D'
        self.assertEqual(json.loads(path.read_text())['source_url'], expected)
        library.put_note(self.root, self.record())
        saved = json.loads(path.read_text())
        self.assertEqual(saved['source_url'], expected)
        self.assertIn('[原帖]', library.render_note(saved))
        self.assertEqual(library.apply_export_links(self.root, source)['results'], {'reused': 1})

    def test_full_link_retains_all_parameters_and_rejects_wrong_note(self):
        url = 'https://www.xiaohongshu.com/discovery/item/' + self.note_id + '?xsec_token=abc%2B123&xsec_source=pc_collect&extra=keep%26this'
        wrong = url.replace(self.note_id, 'b' * 24)
        record = library.enrich_record(self.record(), [{'url': wrong}, {'url': url, 'source_ref': 'original.md'}])
        library.put_note(self.root, record)
        saved = json.loads((library.note_dir(self.root, self.note_id) / '元数据.json').read_text())
        self.assertEqual(saved['source_url'], url)
        self.assertEqual(saved['source_url_status'], 'complete_parameters')
        self.assertEqual(saved['source_url_source_ref'], 'original.md')
        self.assertIn('[原帖](<' + url + '>)', library.render_note(saved))
        self.assertEqual(library.put_note(self.root, record), 'reused')

    def test_incomplete_url_is_not_a_reading_link_and_author_is_visible(self):
        record = self.record(author={'name': 'A [name]', 'id': 'author-id'})
        library.put_note(self.root, record)
        saved = json.loads((library.note_dir(self.root, self.note_id) / '元数据.json').read_text())
        rendered = library.render_note(saved)
        self.assertIn('完整链接缺失', rendered)
        self.assertNotIn('[原帖]', rendered)
        self.assertIn('author-id', rendered)
        self.assertIn(r'A \[name\]', rendered)
        partial = library.enrich_record(record, ['https://www.xiaohongshu.com/explore/' + self.note_id + '?xsec_token=known'])
        self.assertEqual(partial['source_url_status'], 'partial_access_parameters')

    def test_author_fallback_does_not_mix_different_identities(self):
        record = library.enrich_record(self.record(author={'name': 'Alice'}), author_candidates=[{'name': 'Bob', 'id': 'bob'}, {'name': 'Alice', 'id': 'alice'}])
        self.assertEqual(record['author'], {'name': 'Alice', 'id': 'alice'})

    def test_old_complete_link_survives_new_import_without_parameters(self):
        url = 'https://www.xiaohongshu.com/explore/' + self.note_id + '?xsec_token=known&xsec_source=pc_collect'
        library.put_note(self.root, self.record(source_url=url, author={'name': 'Alice'}))
        library.put_note(self.root, self.record(body_text='Updated'))
        saved = json.loads((library.note_dir(self.root, self.note_id) / '元数据.json').read_text())
        self.assertEqual(saved['source_url'], url)
        self.assertEqual(saved['author']['name'], 'Alice')

    def test_existing_legacy_history_remains_unchanged(self):
        library.put_note(self.root, self.record())
        folder = library.note_dir(self.root, self.note_id)
        path = folder / '元数据.json'
        legacy = json.loads(path.read_text())
        for key in list(legacy):
            if key.startswith('source_url_'):
                del legacy[key]
        library.save_json(path, legacy)
        library.atomic_text(folder / '正文.md', library.render_note(legacy, legacy=True))
        history = folder / '历史版本' / library.digest(path)[:16]
        library.copy_preserving(path, history / '元数据.json')
        old_view = library.render_note(legacy, legacy=True)
        library.atomic_text(history / '正文.md', old_view)
        library.put_note(self.root, self.record(body_text='Changed'))
        self.assertEqual((history / '正文.md').read_text(), old_view)

    def test_media_copy_is_independent_and_verified(self):
        source = self.root / 'original.bin'
        source.write_bytes(b'original media bytes')
        item = library.install_media(self.root, self.note_id, source, 'attachment', 1)
        target = library.note_dir(self.root, self.note_id) / item['path']
        self.assertEqual(library.digest(source), item['sha256'])
        target.write_bytes(b'local edit')
        self.assertEqual(source.read_bytes(), b'original media bytes')
        with self.assertRaises(ValueError):
            library.install_media(self.root, self.note_id, source, 'attachment', 1)

    def test_audio_media_keeps_note_type_and_is_linked_and_counted(self):
        source = self.root / 'voice.m4a'
        source.write_bytes(b'synthetic m4a bytes for the local-copy contract')
        item = library.install_media(self.root, self.note_id, source, 'audio', 1)
        self.assertEqual((item['id'], item['kind']), ('audio-001', 'audio'))
        self.assertTrue(item['path'].endswith('.m4a'))
        library.put_note(self.root, self.record(type='video', media=[item]))
        folder = library.note_dir(self.root, self.note_id)
        saved = json.loads((folder / '元数据.json').read_text())
        self.assertEqual((saved['type'], saved['media_status']), ('video', 'complete'))
        rendered = (folder / '正文.md').read_text()
        self.assertIn('[audio-001](' + item['path'] + ')', rendered)
        self.assertNotIn('![audio-001]', rendered)
        library.build_index(self.root)
        result = library.verify_library(self.root)
        self.assertEqual(result['status'], 'passed')
        self.assertEqual(result['counts']['audio_files'], 1)

    def test_idempotent_import_and_content_revision_preserve_previous_text(self):
        record = self.record()
        self.assertEqual(library.put_note(self.root, record), 'written')
        folder = library.note_dir(self.root, self.note_id)
        before = (folder / '元数据.json').read_bytes()
        self.assertEqual(library.put_note(self.root, record), 'reused')
        self.assertEqual((folder / '元数据.json').read_bytes(), before)
        library.put_note(self.root, self.record(body_text='New body'))
        history = list((folder / '历史版本').glob('*/元数据.json'))
        self.assertEqual(len(history), 1)
        self.assertEqual(json.loads(history[0].read_text())['body_text'], 'Original body')

    def test_embedded_media_is_not_duplicated_and_variant_media_stays_visible(self):
        source = self.root / 'a.webp'; source.write_bytes(b'synthetic bytes')
        first = library.install_media(self.root, self.note_id, source, 'image', 1)
        source2 = self.root / 'b.webp'; source2.write_bytes(b'other synthetic bytes')
        second = library.install_media(self.root, self.note_id, source2, 'image', 2)
        record = self.record(body_markdown='Body\n![image](' + first['path'] + ')', media=[first, second])
        library.put_note(self.root, record)
        rendered = (library.note_dir(self.root, self.note_id) / '正文.md').read_text()
        self.assertEqual(rendered.count(first['path']), 1)
        self.assertEqual(rendered.count(second['path']), 1)
        library.put_note(self.root, self.record(body_text='Updated', media=[first, second]))
        old = next(library.note_dir(self.root, self.note_id).glob('历史版本/*/正文.md')).read_text()
        self.assertIn('](../../' + first['path'] + ')', old)

    def test_wrong_hash_does_not_create_output(self):
        source = self.root / 'a.bin'; source.write_bytes(b'true content')
        target = self.root / 'copy.bin'
        with self.assertRaises(ValueError):
            library.copy_preserving(source, target, '0' * 64)
        self.assertFalse(target.exists())

    def test_retry_after_metadata_commit_failure_preserves_original_revision(self):
        library.put_note(self.root, self.record())
        folder = library.note_dir(self.root, self.note_id)
        with patch.object(library, 'save_json', side_effect=OSError('synthetic interruption')):
            with self.assertRaises(OSError):
                library.put_note(self.root, self.record(body_text='Updated body'))
        library.put_note(self.root, self.record(body_text='Updated body'))
        history = [p for p in (folder / '历史版本').glob('*/元数据.json')]
        self.assertEqual(len(history), 1)
        self.assertIn('Original body', (history[0].parent / '正文.md').read_text())
        self.assertNotIn('Updated body', (history[0].parent / '正文.md').read_text())

    def test_same_record_repairs_missing_or_changed_view_with_recovery_copy(self):
        record = self.record()
        library.put_note(self.root, record)
        folder = library.note_dir(self.root, self.note_id)
        view = folder / '正文.md'
        view.unlink()
        library.put_note(self.root, record)
        self.assertIn('Original body', view.read_text())
        view.write_text('manual change')
        library.put_note(self.root, record)
        backup = next(folder.glob('历史版本/unmatched-view-*/正文原件.md'))
        self.assertEqual(backup.read_text(), 'manual change')
        self.assertIn('Original body', view.read_text())

    def test_unavailable_detail_is_distinct_from_empty_source_and_has_no_fake_body(self):
        record = self.record(body_text='', body_markdown='', content_status='detail_unavailable',
                             acquisition_error={'status': 'detail_unavailable', 'http_code': 200,
                                                'provider_code': 404, 'reason': 'provider_reported_not_found',
                                                'source_ref': '原始来源/failure.json', 'source_sha256': '0' * 64})
        library.put_note(self.root, record)
        folder = library.note_dir(self.root, self.note_id)
        saved = json.loads((folder / '元数据.json').read_text())
        self.assertEqual(saved['body_text'], '')
        self.assertEqual(saved['body_markdown'], '')
        self.assertEqual(saved['content_status'], 'detail_unavailable')
        self.assertEqual(saved['media_status'], 'not_fetched')
        self.assertEqual(saved['media'], [])
        rendered = (folder / '正文.md').read_text()
        self.assertIn('未取得正文，详情见元数据中的下载状态', rendered)
        self.assertNotIn('来源中没有正文', rendered)
        library.build_index(self.root)
        self.assertEqual(library.verify_library(self.root)['status'], 'passed')
        with self.assertRaises(ValueError):
            library.put_note(self.root, {**record, 'body_text': 'Invented failure explanation'})

    def test_unavailable_detail_cannot_replace_existing_body_or_media(self):
        source = self.root / 'synthetic-image.bin'
        source.write_bytes(b'synthetic existing image')
        media_note = 'b' * 24
        media = library.install_media(self.root, media_note, source, 'image', 1)
        for record in (self.record(), self.record(note_id=media_note, body_text='', body_markdown='', media=[media])):
            with self.subTest(note_id=record['note_id']):
                library.put_note(self.root, record)
                folder = library.note_dir(self.root, record['note_id'])
                metadata_before, view_before = (folder / '元数据.json').read_bytes(), (folder / '正文.md').read_bytes()
                failure = self.record(note_id=record['note_id'], body_text='', body_markdown='',
                                      content_status='detail_unavailable',
                                      acquisition_error={'status': 'detail_unavailable', 'http_code': 200,
                                                         'provider_code': 404, 'reason': 'provider_reported_not_found',
                                                         'source_ref': '原始来源/failure.json', 'source_sha256': '0' * 64})
                self.assertEqual(library.put_note(self.root, failure), 'preserved')
                self.assertEqual((folder / '元数据.json').read_bytes(), metadata_before)
                self.assertEqual((folder / '正文.md').read_bytes(), view_before)
        self.assertEqual(library.digest(library.note_dir(self.root, media_note) / media['path']), media['sha256'])

    def test_unsafe_identity_or_media_path_is_rejected(self):
        with self.assertRaises(ValueError):
            library.put_note(self.root, self.record(note_id='../escape'))
        record = self.record(media=[{'kind': 'image', 'status': 'available', 'path': '../secret', 'sha256': 'a' * 64, 'bytes': 1}])
        with self.assertRaises(ValueError):
            library.put_note(self.root, record)

    def test_jsonl_preserves_unicode_separators_inside_text_fields(self):
        body = 'First\u2028second\u2029third\u0085fourth'
        library.put_note(self.root, self.record(title='A\u2028title', body_text=body))
        library.put_note(self.root, self.record(note_id='b' * 24))
        library.build_index(self.root)
        records = library.read_jsonl(self.root / '索引/笔记.jsonl')
        self.assertEqual(len(records), 2)
        self.assertEqual(records[0]['body_text'], body)
        self.assertEqual(records[0]['title'], 'A\u2028title')
        self.assertEqual(library.verify_library(self.root)['status'], 'passed')
        external = self.root / 'crlf.jsonl'
        external.write_bytes((json.dumps({'body': body}, ensure_ascii=False) + '\r\n\r\n').encode('utf-8'))
        self.assertEqual(library.read_jsonl(external), [{'body': body}])

    def test_verification_requires_consistent_indexes_and_markdown(self):
        library.put_note(self.root, self.record())
        self.assertEqual(library.verify_library(self.root)['status'], 'failed')
        library.build_index(self.root)
        self.assertEqual(library.verify_library(self.root)['status'], 'passed')
        view = library.note_dir(self.root, self.note_id) / '正文.md'
        view.write_text('incorrect body')
        self.assertEqual(library.verify_library(self.root)['status'], 'failed')
        library.put_note(self.root, self.record())
        csv_file = self.root / '索引/笔记清单.csv'
        csv_file.write_text(csv_file.read_text().replace('Example', 'wrong title'))
        self.assertEqual(library.verify_library(self.root)['status'], 'failed')


if __name__ == '__main__':
    unittest.main()
