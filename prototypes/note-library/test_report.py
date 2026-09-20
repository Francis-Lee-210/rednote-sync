"""Completion reports use real synthetic files and never contact a provider."""
import hashlib
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import library
import report


def note_id(number):
    return f'{number:024x}'


class Fixture:
    def __init__(self, base, planned):
        self.root = Path(base) / 'library'
        self.batch = self.root / '导出记录' / 'batch'
        self.batch.mkdir(parents=True)
        self.plan = self.root / 'plan.json'
        self.corpus = self.root / 'corpus.jsonl'
        self.items = [{'note_id': note_id(n), 'type': kind} for n, kind in planned]
        self.plan.write_text(json.dumps({'notes': self.items}))
        self.corpus.write_text(json.dumps({'id': note_id(1), 'body_chars': 0, 'body_text': ''}) + '\n')
        self.ledger = {'attempts': [], 'balance_observations': []}
        self.index = {'posts': {}}
        self.publish(1, 'unknown', [], provider='notion', body='')

    def media(self, number, media_id, kind='image', content=b'fixture-media', status='available'):
        if status != 'available':
            return {'id': media_id, 'kind': kind, 'status': status, 'reason': 'synthetic_transfer_failure'}
        folder = library.note_dir(self.root, note_id(number)) / 'media'
        folder.mkdir(parents=True, exist_ok=True)
        path = folder / (media_id + {'video': '.mp4', 'audio': '.mp3', 'subtitle': '.srt'}.get(kind, '.webp'))
        path.write_bytes(content)
        return {'id': media_id, 'kind': kind, 'status': 'available', 'path': 'media/' + path.name,
                'bytes': len(content), 'sha256': hashlib.sha256(content).hexdigest()}

    def raw(self, number):
        path = self.batch / (note_id(number) + '.json')
        path.write_text('{}')
        return str(path.relative_to(self.root))

    def publish(self, number, kind, media, *, provider='galaxy', body='Synthetic body'):
        source = self.raw(number)
        library.put_note(self.root, {'note_id': note_id(number), 'title': 'Synthetic title', 'type': kind,
                                    'body_text': body, 'body_markdown': body,
                                    'sources': [{'provider': provider, 'path': source}],
                                    'relations': [], 'media': media})

    def attempt(self, number, status='detail_verified', kind='normal', quote='0.03', balance=None):
        item = {'note_id': note_id(number), 'type': kind, 'status': status,
                'api_path': '/api/get_note_detail' + ('_video' if kind == 'video' else ''),
                'quoted_cost_cny': quote, 'raw_file': self.raw(number),
                'finished_at': '2026-09-17T00:00:00Z'}
        if balance is not None: item['detail_response_balance_raw'] = balance
        self.ledger['attempts'].append(item)

    def entry(self, number, media, status='complete'):
        self.index['posts'][note_id(number)] = {'note_id': note_id(number), 'status': status,
                                               'media': {m['id']: m for m in media}, 'gaps': []}

    def save(self):
        library.save_json(self.batch / 'api-ledger.json', self.ledger)
        library.save_json(self.batch / 'download-index.json', self.index)

    def build(self):
        self.save()
        return report.build_report(self.root, self.plan, self.corpus, self.batch)


class ReportTest(unittest.TestCase):
    def test_complete_separates_empty_body_live_motion_quotes_and_balances(self):
        with tempfile.TemporaryDirectory() as directory:
            f = Fixture(directory, [(2, 'normal'), (3, 'video')])
            still = f.media(2, 'image-001', content=b'12')
            motion = f.media(2, 'image-001-motion', 'video', content=b'123')
            video = f.media(3, 'video-001', 'video', content=b'1234')
            f.publish(2, 'normal', [still, motion]); f.publish(3, 'video', [video])
            f.entry(2, [still, motion]); f.entry(3, [video])
            f.attempt(2, balance='79.97'); f.attempt(3, kind='video', quote='0.04', balance='79.93')
            f.ledger['balance_observations'] = [{'source': 'get_balance', 'origin': 'imported_sample',
                                                'balance_raw': '10000', 'checked_at': '2026-09-17T00:00:00Z'}]
            result = f.build()
            self.assertEqual(result['status'], 'complete')
            self.assertEqual(result['reconciliation']['expected'], 3)
            self.assertEqual(result['galaxy']['detail_success'], 2)
            self.assertEqual(result['galaxy']['media_complete'], 2)
            self.assertEqual(result['empty_body']['notion_original_ids'], [note_id(1)])
            counts = result['media']['counts']
            self.assertEqual((counts['image']['available_files'], counts['image']['available_bytes']), (1, 2))
            self.assertEqual((counts['video']['available_files'], counts['video']['available_bytes']), (1, 4))
            self.assertEqual((counts['live_photo_motion']['available_files'], counts['live_photo_motion']['available_bytes']), (1, 3))
            self.assertEqual(result['pricing']['known_quote_total_cny'], '0.07')
            self.assertIsNone(result['pricing']['actual_charged_cost_cny'])
            self.assertEqual(len(result['balance_observations']), 3)
            self.assertEqual({o['value_raw'] for group in result['balance_observations'] for o in group['observations']},
                             {'10000', '79.97', '79.93'})
            self.assertFalse((f.root / '导出记录' / '本次导出结果.json').exists())
            self.assertFalse((f.root / '导出记录' / '本次导出结果.md').exists())

    def test_partial_failed_unknown_and_unrequested_are_not_complete(self):
        with tempfile.TemporaryDirectory() as directory:
            f = Fixture(directory, [(n, 'normal') for n in range(2, 7)])
            good = [f.media(2, 'image-001')]
            partial = [f.media(3, 'image-001'), f.media(3, 'image-001-motion', 'video', status='failed')]
            f.publish(2, 'normal', good); f.publish(3, 'normal', partial)
            f.entry(2, good); f.entry(3, partial, status='partial')
            f.attempt(2); f.attempt(3); f.attempt(4, status='detail_unavailable'); f.attempt(6, status='request_unknown')
            result = f.build()
            self.assertEqual(result['status'], 'incomplete')
            self.assertEqual(result['galaxy']['detail_success'], 2)
            self.assertEqual(result['galaxy']['media_complete'], 1)
            self.assertEqual(result['galaxy']['media_gap_posts'], 1)
            self.assertEqual(result['galaxy']['detail_failed'], 1)
            self.assertEqual(result['galaxy']['not_requested'], 1)
            self.assertEqual(result['galaxy']['state_counts']['request_unconfirmed'], 1)
            self.assertEqual(result['galaxy']['unfinished'], 4)
            self.assertEqual(result['reconciliation']['missing_ids'], [note_id(n) for n in (4, 5, 6)])
            self.assertEqual(result['media']['counts']['live_photo_motion']['gap_entries'], 1)
            self.assertEqual(result['pricing']['successful_detail_attempts'], 2)
            self.assertEqual(result['pricing']['known_quote_total_cny'], '0.06')

    def test_audio_and_subtitles_are_counted_separately_from_source_post_type(self):
        with tempfile.TemporaryDirectory() as directory:
            f = Fixture(directory, [(2, 'video')])
            audio = [f.media(2, 'audio-001', 'audio', content=b'fixture-audio'),
                     f.media(2, 'subtitle-source-001', 'subtitle', content=b'fixture-subtitle')]
            f.publish(2, 'video', audio); f.entry(2, audio); f.attempt(2, kind='video', quote='0.04')
            result = f.build()
            self.assertEqual(result['status'], 'complete')
            self.assertEqual(result['media']['counts']['audio']['available_files'], 1)
            self.assertEqual(result['media']['counts']['subtitle']['available_files'], 1)
            self.assertEqual(result['media']['counts']['video']['available_files'], 0)
            self.assertIn('| 音频 | 1 | 1 |', report.render_markdown(result))
            self.assertIn('| 字幕 | 1 | 1 |', report.render_markdown(result))

    def test_missing_file_overrides_complete_receipts(self):
        with tempfile.TemporaryDirectory() as directory:
            f = Fixture(directory, [(2, 'normal')])
            media = [f.media(2, 'image-001')]
            f.publish(2, 'normal', media); f.entry(2, media); f.attempt(2)
            (library.note_dir(f.root, note_id(2)) / media[0]['path']).unlink()
            result = f.build()
            self.assertEqual(result['status'], 'incomplete')
            self.assertEqual(result['galaxy']['media_complete'], 0)
            self.assertEqual(result['galaxy']['media_gap_posts'], 1)
            self.assertEqual(result['media']['counts']['image']['available_bytes'], 0)
            self.assertEqual(result['galaxy']['unfinished_posts'][0]['media_gaps'][0]['reason'],
                             'local_media_missing_or_invalid_path')

    def test_unavailable_placeholder_is_not_an_original_empty_body(self):
        with tempfile.TemporaryDirectory() as directory:
            f = Fixture(directory, [(2, 'normal'), (3, 'normal')])
            raw = f.raw(2)
            library.put_note(f.root, {'note_id': note_id(2), 'title': 'Known from list', 'type': 'normal',
                'body_text': '', 'body_markdown': '', 'content_status': 'detail_unavailable',
                'sources': [{'provider': 'galaxy', 'path': raw}], 'relations': [], 'media': [],
                'acquisition_error': {'status': 'detail_unavailable', 'reason': 'provider_reported_not_found',
                    'provider_code': 404, 'source_ref': raw, 'source_sha256': library.digest(f.root / raw)}})
            f.attempt(2, status='detail_unavailable')
            media = [f.media(3, 'image-001')]
            f.publish(3, 'normal', media, body=''); f.entry(3, media); f.attempt(3)
            result = f.build()
            self.assertEqual(result['reconciliation']['missing_ids'], [])
            self.assertEqual(result['galaxy']['media_complete'], 1)
            self.assertEqual(result['galaxy']['detail_failed'], 1)
            self.assertEqual(result['empty_body']['current_empty_text_ids']['galaxy'], [note_id(3)])
            self.assertIn('provider_reported_not_found', result['galaxy']['unfinished_posts'][0]['reasons'])
            self.assertEqual(result['status'], 'incomplete')

    def test_partial_index_and_unpublished_detail_are_incomplete(self):
        with tempfile.TemporaryDirectory() as directory:
            f = Fixture(directory, [(2, 'normal'), (3, 'normal')])
            media = [f.media(2, 'image-001')]
            f.publish(2, 'normal', media); f.entry(2, media, status='partial'); f.attempt(2)
            f.entry(3, []); f.attempt(3)
            result = f.build()
            self.assertEqual(result['status'], 'incomplete')
            self.assertEqual(result['galaxy']['media_gap_posts'], 1)
            self.assertEqual(result['galaxy']['media_complete'], 0)
            posts = {p['note_id']: p for p in result['galaxy']['unfinished_posts']}
            self.assertIn('normalized_note_missing', posts[note_id(3)]['reasons'])

    def test_extra_ids_and_invalid_metadata_are_visible(self):
        with tempfile.TemporaryDirectory() as directory:
            f = Fixture(directory, [])
            f.publish(9, 'unknown', [], provider='notion')
            folder = library.note_dir(f.root, note_id(8)); folder.mkdir(parents=True)
            (folder / '元数据.json').write_text('{invalid')
            result = f.build()
            self.assertEqual(result['status'], 'incomplete')
            self.assertEqual(result['reconciliation']['extra_ids'], [note_id(9)])
            self.assertEqual(len(result['reconciliation']['invalid_metadata']), 1)

    def test_markdown_summarizes_balances_but_json_keeps_each_observation(self):
        with tempfile.TemporaryDirectory() as directory:
            f = Fixture(directory, [])
            f.ledger['balance_observations'] = [
                {'source': 'get_balance', 'balance_raw': '1000.00', 'checked_at': '2026-09-17T00:00:00Z'},
                {'source': 'get_balance', 'balance_raw': '999.99', 'checked_at': '2026-09-17T00:01:00Z'},
                {'source': 'get_balance', 'balance_raw': '999.98', 'checked_at': '2026-09-17T00:02:00Z'},
            ]
            result = f.build()
            self.assertEqual(len(result['balance_observations'][0]['observations']), 3)
            markdown = report.render_markdown(result)
            self.assertIn('3 次', markdown)
            self.assertIn('首笔 1000.00', markdown)
            self.assertIn('末笔 999.98', markdown)
            self.assertNotIn('999.99', markdown)

    def test_cli_writes_private_reports_and_prints_aggregates_only(self):
        with tempfile.TemporaryDirectory() as directory:
            f = Fixture(directory, [(2, 'normal')]); f.save()
            completed = subprocess.run([sys.executable, '-B', str(Path(report.__file__)),
                                        '--root', str(f.root), '--plan', str(f.plan),
                                        '--notion-corpus', str(f.corpus), '--batch-dir', str(f.batch)],
                                       check=True, capture_output=True, text=True)
            result = json.loads(completed.stdout)
            self.assertEqual(result['status'], 'incomplete')
            self.assertEqual(result['galaxy_unfinished'], 1)
            self.assertNotIn(note_id(2), completed.stdout)
            self.assertEqual(completed.stderr, '')
            saved = json.loads((f.root / '导出记录' / '本次导出结果.json').read_text())
            self.assertEqual(saved['galaxy']['unfinished_posts'][0]['note_id'], note_id(2))
            self.assertIn(note_id(2), (f.root / '导出记录' / '本次导出结果.md').read_text())


if __name__ == '__main__':
    unittest.main()
