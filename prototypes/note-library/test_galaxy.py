"""Offline checks: HTTP is substituted; decoder fixtures are generated locally."""
import io
import json
import socket
import tempfile
import threading
import unittest
import urllib.error
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

import galaxy
from library import digest, save_json


NOTE_A = 'a' * 24
NOTE_B = 'b' * 24
HEIC = (24).to_bytes(4, 'big') + b'ftypheic' + b'\0' * 4 + b'heicmif1'
M4A = (28).to_bytes(4, 'big') + b'ftypM4A ' + b'\0' * 4 + b'M4A mp42isom'


def payload(note_id=NOTE_A, kind='normal', **fields):
    note = {'id': note_id, 'model_type': 'note', 'type': kind, 'title': 'Test title', 'desc': 'Test body',
            'user': {'nickname': 'Author', 'userid': 'author-id'},
            'images_list': [{'original': 'https://ci.xhscdn.com/image?signature=private'}], **fields}
    return {'code': 200, 'balance': '0.01', 'data': {'success': True, 'code': 0, 'data': [{'note_list': [note]}]}}


class FakeClient:
    def __init__(self, responses, balance='50'):
        self.responses = list(responses)
        self.calls = []
        self.balance = balance

    def call(self, path, note_id=None):
        self.calls.append((path, note_id))
        if path == '/api/get_balance':
            return 200, {'message': '成功', 'data': {'balance': self.balance}}
        result = self.responses.pop(0)
        if isinstance(result, Exception):
            raise result
        return result

    @property
    def detail_calls(self):
        return [c for c in self.calls if c[1] is not None]


class Response(io.BytesIO):
    def __init__(self, data, *, status=200, length=None):
        super().__init__(data)
        self.status = status
        self.headers = {'Content-Length': str(len(data) if length is None else length)}


class GalaxyTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.plan = self.root / 'plan.json'
        save_json(self.plan, {'count': 1, 'notes': [{'note_id': NOTE_A, 'type': 'normal', 'liked': True}]})
        self.batch = self.root / '导出记录' / 'batch'
        self.network_guard = patch.object(socket.socket, 'connect', side_effect=AssertionError('Network forbidden in offline tests'))
        self.network_guard.start()
        self.output = patch('sys.stdout', new_callable=io.StringIO)
        self.output.start()
        self.sleep = patch.object(galaxy.time, 'sleep')
        self.sleep.start()

    def tearDown(self):
        self.sleep.stop(); self.output.stop(); self.network_guard.stop(); self.temp.cleanup()

    def runner(self, client=None, workers=1):
        return galaxy.Runner(self.root, self.plan, self.batch, client=client, delay=0, workers=workers)

    def many_posts(self, count):
        ids = [f'{number:024x}' for number in range(1, count + 1)]
        save_json(self.plan, {'notes': [{'note_id': note_id, 'type': 'normal', 'liked': True} for note_id in ids]})
        return ids

    def saved_media(self, root, note_id, job, source_ref, *, before_request=None):
        if before_request:
            before_request()
        folder = galaxy.note_dir(root, note_id) / 'media'
        folder.mkdir(parents=True, exist_ok=True)
        content, suffix = (M4A, '.m4a') if job['kind'] == 'audio' else (HEIC, '.heic')
        path = folder / (job['id'] + suffix)
        path.write_bytes(content)
        return {'id': job['id'], 'kind': job['kind'], 'path': 'media/' + path.name,
                'status': 'available', 'bytes': len(content), 'sha256': digest(path),
                'source_ref': source_ref, 'verification': {'full_decode': 'passed', 'full_decode_exit_code': 0}}

    def two_posts(self):
        save_json(self.plan, {'notes': [{'note_id': NOTE_A, 'type': 'normal', 'liked': True},
                                      {'note_id': NOTE_B, 'type': 'normal', 'liked': True}]})

    def test_plan_is_strict_and_future_size_is_unrestricted(self):
        self.two_posts()
        self.assertEqual(len(galaxy.load_plan(self.plan)), 2)
        save_json(self.plan, {'notes': [{'note_id': NOTE_A, 'type': 'unknown'}]})
        with self.assertRaises(ValueError): galaxy.load_plan(self.plan)
        save_json(self.plan, {'notes': [{'note_id': NOTE_A, 'type': 'normal'}] * 2})
        with self.assertRaises(ValueError): galaxy.load_plan(self.plan)

    def test_exact_id_type_and_uniqueness(self):
        value = payload()
        rows = value['data']['data'][0]['note_list']
        rows.insert(0, {**rows[0], 'type': 'video'})
        selected = galaxy.select_note(value, 'normal', NOTE_A)
        self.assertEqual(selected['type'], 'normal')
        self.assertIsNone(galaxy.select_note(value, 'normal', NOTE_B))
        rows.append(dict(selected))
        self.assertIsNone(galaxy.select_note(value, 'normal', NOTE_A))

    def test_unknown_paid_result_never_blindly_retried_across_runs(self):
        client = FakeClient([TimeoutError()])
        runner = self.runner(client)
        note, attempt, requested = runner.fetch(runner.plan[NOTE_A])
        self.assertIsNone(note); self.assertTrue(requested)
        self.assertEqual(attempt['status'], 'request_unknown')
        again = self.runner(client)
        self.assertEqual(again.fetch(again.plan[NOTE_A]), (None, None, False))
        self.assertEqual(len(client.detail_calls), 1)

    def test_busy_can_retry_twice_and_not_more_after_restart(self):
        busy = (200, {'code': 503, 'message': '服务繁忙，请稍后重试'})
        client = FakeClient([busy, busy, busy])
        runner = self.runner(client)
        runner.fetch(runner.plan[NOTE_A])
        self.assertEqual(len(client.detail_calls), 3)
        again = self.runner(client)
        self.assertEqual(again.fetch(again.plan[NOTE_A]), (None, None, False))
        self.assertEqual(len(again.ledger['attempts']), 3)

    def test_paid_cache_reused_and_tampered_raw_does_not_refetch(self):
        client = FakeClient([(200, payload())])
        runner = self.runner(client)
        _, receipt, _ = runner.fetch(runner.plan[NOTE_A])
        self.assertFalse(runner.fetch(runner.plan[NOTE_A])[2])
        (self.root / receipt['raw_file']).write_text('{}')
        with self.assertRaises(ValueError): runner.fetch(runner.plan[NOTE_A])
        self.assertEqual(len(client.detail_calls), 1)

    def test_saved_raw_recovers_started_attempt_without_new_charge(self):
        client = FakeClient([(200, payload())])
        runner = self.runner(client)
        original_save, saves = runner.save_ledger, 0
        def fail_after_response_saved():
            nonlocal saves
            saves += 1
            if saves == 2:
                raise OSError('Synthetic interruption before completed ledger commit')
            original_save()
        with patch.object(runner, 'save_ledger', side_effect=fail_after_response_saved):
            with self.assertRaises(OSError): runner.fetch(runner.plan[NOTE_A])
        self.assertEqual(galaxy.read_json(runner.ledger_path)['attempts'][0]['status'], 'started')
        raw = next(runner.raw_dir.glob('*.json'))
        before = raw.read_bytes()
        resumed = self.runner(FakeClient([]))
        note, receipt, requested = resumed.fetch(resumed.plan[NOTE_A])
        self.assertEqual(note['id'], NOTE_A)
        self.assertFalse(requested)
        self.assertEqual(resumed.client.detail_calls, [])
        self.assertEqual(raw.read_bytes(), before)
        saved = galaxy.read_json(resumed.ledger_path)['attempts'][0]
        self.assertEqual(saved['status'], 'detail_verified')
        self.assertEqual(saved['raw_sha256'], digest(raw))
        self.assertEqual(saved['raw_file'], receipt['raw_file'])
        self.assertIn('recovered_at', saved)
        # The response envelope proves content identity, not the lost HTTP status/time.
        self.assertIsNone(saved.get('http_status'))
        self.assertNotIn('finished_at', saved)

    def test_saved_raw_invalid_or_mismatched_does_not_promote(self):
        cases = [b'{invalid', json.dumps(payload(NOTE_B)).encode(),
                 json.dumps(payload(kind='video')).encode(),
                 json.dumps({**payload(), 'code': 403}).encode()]
        for raw_bytes in cases:
            with self.subTest(raw_bytes=raw_bytes[:20]):
                runner = self.runner(FakeClient([]))
                runner.ledger['attempts'] = [{'attempt_id': 1, 'note_id': NOTE_A, 'type': 'normal',
                                              'status': 'started', 'billing_status': 'unknown'}]
                runner.save_ledger()
                raw = runner.raw_dir / (NOTE_A + '-000001.json')
                raw.write_bytes(raw_bytes)
                resumed = self.runner(FakeClient([]))
                self.assertEqual(resumed.fetch(resumed.plan[NOTE_A]), (None, None, False))
                self.assertEqual(resumed.client.detail_calls, [])
                self.assertEqual(galaxy.read_json(resumed.ledger_path)['attempts'][0]['status'], 'started')
                self.assertEqual(raw.read_bytes(), raw_bytes)

    def test_retry_media_recovers_saved_raw_without_an_api_client(self):
        runner = self.runner()
        runner.ledger['attempts'] = [{'attempt_id': 1, 'note_id': NOTE_A, 'type': 'normal',
                                     'status': 'started', 'billing_status': 'unknown'}]
        runner.save_ledger()
        save_json(runner.raw_dir / (NOTE_A + '-000001.json'), payload())
        resumed = self.runner()
        with patch.object(resumed, 'process_media', return_value=('complete', 1, 1)) as process:
            resumed.run(retry_media=True)
        process.assert_called_once()
        self.assertEqual(galaxy.read_json(resumed.ledger_path)['attempts'][0]['status'], 'detail_verified')

    def test_balance_sources_are_separate_and_zero_is_not_a_local_cap(self):
        self.two_posts()
        client = FakeClient([(200, payload()), (200, payload(NOTE_B))], balance='0')
        runner = self.runner(client)
        with patch.object(runner, 'process_media', return_value=('complete', 1, 1)):
            runner.run()
        self.assertEqual(len(client.detail_calls), 2)
        self.assertEqual(runner.ledger['balance_observations'][0]['balance_raw'], '0')
        self.assertEqual(runner.ledger['attempts'][0]['detail_response_balance_raw'], '0.01')
        self.assertFalse(any('cap' in key for key in runner.ledger))

    def test_business_quota_stop_is_persisted_and_stops_whole_batch(self):
        self.two_posts()
        client = FakeClient([(200, {'code': 200, 'data': {'code': 402, 'message': '余额不足'}})])
        runner = self.runner(client)
        with self.assertRaises(galaxy.BatchStop): runner.run()
        self.assertEqual(len(client.detail_calls), 1)
        self.assertEqual(galaxy.read_json(runner.ledger_path)['attempts'][0]['status'], 'platform_stopped')
        self.assertTrue(galaxy.platform_stop(200, {'error': {'message': 'account suspended'}}))
        self.assertIsNone(galaxy.platform_stop(200, payload(desc='余额不足 is user-authored content')))

    def test_unavailable_post_continues_to_next_post(self):
        self.two_posts()
        client = FakeClient([(200, {'code': 404, 'message': '帖子不存在'}), (200, payload(NOTE_B))])
        runner = self.runner(client)
        with patch.object(runner, 'process_media', return_value=('complete', 1, 1)):
            runner.run()
        self.assertEqual(len(client.detail_calls), 2)
        self.assertEqual([a['status'] for a in runner.ledger['attempts']], ['detail_unavailable', 'detail_verified'])

    def test_unavailable_detail_preserves_plan_identity_and_failure_sources(self):
        save_json(self.plan, {'notes': [{'note_id': NOTE_A, 'type': 'normal', 'title': 'Saved list title', 'liked': True}]})
        client = FakeClient([(200, {'code': 404, 'message': '笔记不存在或已删除', 'data': None})])
        runner = self.runner(client)
        runner.run_one(1, runner.plan[NOTE_A], False)
        saved = galaxy.read_json(self.root / '笔记' / NOTE_A / '元数据.json')
        self.assertEqual((saved['note_id'], saved['title'], saved['type']), (NOTE_A, 'Saved list title', 'normal'))
        self.assertEqual((saved['body_text'], saved['body_markdown'], saved['media']), ('', '', []))
        self.assertEqual((saved['content_status'], saved['media_status']), ('detail_unavailable', 'not_fetched'))
        self.assertEqual(saved['acquisition_error']['reason'], 'provider_reported_not_found')
        self.assertEqual(saved['acquisition_error']['http_code'], 200)
        self.assertEqual(saved['acquisition_error']['provider_code'], 404)
        self.assertEqual(saved['relations'], [{'kind': 'liked', 'value': True, 'provider': 'latest_likes_list',
                                              'source_ref': runner.plan_ref}])
        self.assertEqual({s['provider'] for s in saved['sources']}, {'latest_likes_list', 'galaxy'})
        for source in saved['sources']:
            self.assertEqual(digest(self.root / source['path']), source['sha256'])
        self.assertEqual(saved['acquisition_error']['source_sha256'], digest(self.root / saved['acquisition_error']['source_ref']))

    def test_skipped_previous_failure_backfills_idempotently_without_api(self):
        runner = self.runner(FakeClient([(200, {'code': 404, 'data': None})]))
        runner.fetch(runner.plan[NOTE_A])
        resumed = self.runner(FakeClient([]))
        resumed.run_one(1, resumed.plan[NOTE_A], False)
        metadata = self.root / '笔记' / NOTE_A / '元数据.json'
        before = metadata.read_bytes()
        index_before = resumed.index_path.read_bytes()
        resumed.run_one(1, resumed.plan[NOTE_A], False)
        self.assertEqual(resumed.client.detail_calls, [])
        self.assertEqual(metadata.read_bytes(), before)
        self.assertEqual(resumed.index_path.read_bytes(), index_before)
        self.assertFalse((metadata.parent / '历史版本').exists())

    def test_record_failures_cli_is_offline_and_does_not_request_a_key(self):
        runner = self.runner(FakeClient([(200, {'code': 404, 'data': None})]))
        runner.fetch(runner.plan[NOTE_A])
        ledger_before = runner.ledger_path.read_bytes()
        arguments = ['galaxy.py', 'record-failures', '--root', str(self.root), '--plan', str(self.plan),
                     '--batch-dir', str(self.batch)]
        with patch('sys.argv', arguments), patch.object(galaxy, 'APIClient') as client, \
                patch.object(galaxy.getpass, 'getpass') as ask_key, \
                patch.object(galaxy.urllib.request, 'build_opener', side_effect=AssertionError('No network')):
            galaxy.main()
            metadata = self.root / '笔记' / NOTE_A / '元数据.json'
            before = metadata.read_bytes()
            galaxy.main()
        client.assert_not_called(); ask_key.assert_not_called()
        self.assertEqual(metadata.read_bytes(), before)
        self.assertEqual(runner.ledger_path.read_bytes(), ledger_before)

    def test_failure_backfill_preserves_successful_archived_content(self):
        galaxy.put_note(self.root, {'note_id': NOTE_A, 'title': 'Original title', 'type': 'normal',
                                   'body_text': 'Previously archived body', 'sources': [{'provider': 'notion'}]})
        folder = self.root / '笔记' / NOTE_A
        before = {name: (folder / name).read_bytes() for name in ('元数据.json', '正文.md')}
        runner = self.runner(FakeClient([(200, {'code': 404, 'data': None})]))
        runner.fetch(runner.plan[NOTE_A])
        self.assertEqual(runner.record_failures()['preserved'], 1)
        for name, content in before.items():
            self.assertEqual((folder / name).read_bytes(), content)
        self.assertFalse(runner.index_path.exists())

    def test_only_envelope_404_is_classified_as_provider_reported_not_found(self):
        ids = self.many_posts(3)
        client = FakeClient([(404, {'code': 500, 'message': 'upstream failed'}),
                             (200, {'code': 400, 'message': '404 or deleted appears only in text'}),
                             (200, {'code': 200, 'data': {'code': 404, 'message': '笔记不存在'}})])
        runner = self.runner(client)
        for number, note_id in enumerate(ids, 1):
            runner.run_one(number, runner.plan[note_id], False)
        errors = [galaxy.read_json(self.root / '笔记' / note_id / '元数据.json')['acquisition_error'] for note_id in ids]
        self.assertEqual([error['reason'] for error in errors],
                         ['detail_unavailable', 'detail_unavailable', 'provider_reported_not_found'])
        self.assertEqual([error['provider_code'] for error in errors], [500, 400, 404])

    def test_failure_backfill_never_converts_latest_uncertain_attempts(self):
        ids = self.many_posts(3)
        runner = self.runner(FakeClient([]))
        for number, (note_id, status) in enumerate(zip(ids, ('started', 'request_unknown', 'platform_stopped')), 1):
            attempt_id = number + 1
            raw = runner.raw_dir / f'{note_id}-{attempt_id:06d}.json'
            save_json(raw, {'code': 404, 'data': None})
            attempt = {'attempt_id': attempt_id, 'note_id': note_id, 'type': 'normal', 'status': status,
                       'http_status': 200, 'raw_file': str(raw.relative_to(runner.root)), 'raw_sha256': digest(raw)}
            if number == 1:
                previous_raw = runner.raw_dir / f'{note_id}-000001.json'
                save_json(previous_raw, {'code': 404, 'data': None})
                runner.ledger['attempts'].append({**attempt, 'attempt_id': 1, 'status': 'detail_unavailable',
                                                   'raw_file': str(previous_raw.relative_to(runner.root))})
            runner.ledger['attempts'].append(attempt)
        runner.save_ledger()
        self.assertEqual(runner.record_failures()['eligible_failures'], 0)
        for number, note_id in enumerate(ids, 1):
            runner.run_one(number, runner.plan[note_id], False)
            self.assertFalse((self.root / '笔记' / note_id / '元数据.json').exists())
        self.assertEqual(runner.client.detail_calls, [])

    def test_global_lock_rejects_second_writer(self):
        with galaxy.process_lock(self.root):
            with self.assertRaises(galaxy.BatchStop):
                with galaxy.process_lock(self.root): pass

    def test_cdn_hosts_redirects_and_api_auth_separation(self):
        self.assertEqual(galaxy.media_url('http://ci.xhscdn.com/path?a=1'), 'https://ci.xhscdn.com/path?a=1')
        for url in ['https://xhscdn.com.evil.example/x', 'https://evilxhscdn.com/x', 'https://key@ci.xhscdn.com/x']:
            with self.assertRaises(ValueError): galaxy.media_url(url)
        with self.assertRaises(ValueError):
            galaxy.NoRedirect().redirect_request(None, None, 302, '', {}, 'https://other.example')
        opener = Mock(); opener.open.return_value = Response(HEIC)
        job = {'id': 'image-001', 'kind': 'image', 'urls': ['https://ci.xhscdn.com/i?signature=private']}
        with patch.object(galaxy.urllib.request, 'build_opener', return_value=opener), patch.object(galaxy, 'verify_media', return_value={'full_decode': 'passed'}):
            result = galaxy.transfer(self.root, NOTE_A, job, 'source/raw.json')
        headers = dict(opener.open.call_args.args[0].header_items())
        self.assertNotIn('Authorization', headers)
        self.assertIn('Referer', headers)
        self.assertEqual(result['status'], 'available')
        self.assertTrue(result['path'].endswith('.heic'))
        self.assertNotIn('private', json.dumps(result))

    def test_declared_length_and_video_kind_are_checked(self):
        opener = Mock(); opener.open.return_value = Response(HEIC, length=len(HEIC) + 1)
        with patch.object(galaxy.urllib.request, 'build_opener', return_value=opener), patch.object(galaxy, 'verify_media') as decode:
            result = galaxy.transfer(self.root, NOTE_A, {'id': 'image-001', 'kind': 'image', 'urls': ['https://ci.xhscdn.com/i']}, 'raw.json')
        self.assertEqual(result['status'], 'failed'); decode.assert_not_called()
        with self.assertRaises(ValueError): galaxy.extension(b'\xff\xd8\xff' + b'\0' * 24, 'video')
        with self.assertRaises(ValueError): galaxy.extension(HEIC, 'video')

    def test_cdn_rate_limit_and_low_space_stop_globally(self):
        opener = Mock(); opener.open.side_effect = urllib.error.HTTPError('https://ci.xhscdn.com/i', 429, 'rate limit', {}, None)
        with patch.object(galaxy.urllib.request, 'build_opener', return_value=opener):
            with self.assertRaises(galaxy.BatchStop):
                galaxy.transfer(self.root, NOTE_A, {'id': 'image-001', 'kind': 'image', 'urls': ['https://ci.xhscdn.com/i']}, 'raw.json')
        with patch.object(galaxy.shutil, 'disk_usage', return_value=SimpleNamespace(free=galaxy.RESERVE_BYTES - 1)):
            with self.assertRaises(galaxy.BatchStop): galaxy.check_space(self.root)

    def test_motion_component_becomes_an_explicit_gap(self):
        value = payload(images_list=[{'url': 'https://ci.xhscdn.com/i', 'live_photo': True}])
        jobs, gaps = galaxy.media_jobs(galaxy.select_note(value, 'normal', NOTE_A))
        self.assertEqual(len(jobs), 1)
        self.assertEqual(gaps[0]['status'], 'unsupported')
        self.assertEqual(gaps[0]['kind'], 'video')

    def test_live_photo_h265_components_keep_image_pairs_sizes_and_backup_urls(self):
        images = [{'url': 'https://ci.xhscdn.com/still-1'}]
        for number in range(2, 13):
            images.append({'url': f'https://ci.xhscdn.com/still-{number}',
                           'live_photo_file_id': 'synthetic-file-id', 'live_photo': {
                               'media': {'video': {'duration': 3}, 'stream': {'h264': [], 'h265': [{
                                   'format': 'mp4', 'width': 1080, 'height': 1440, 'size': 392718,
                                   'duration': 2434, 'master_url': f'https://sns-video.xhscdn.com/live-{number}?signature=private',
                                   'backup_urls': [f'https://sns-video.xhscdn.com/backup-{number}',
                                                   f'https://sns-video.xhscdn.com/backup2-{number}']}]}}}})
        note = galaxy.select_note(payload(images_list=images), 'normal', NOTE_A)
        jobs, gaps = galaxy.media_jobs(note)
        self.assertEqual(gaps, [])
        self.assertEqual(sum(j['kind'] == 'image' for j in jobs), 12)
        motion = [j for j in jobs if j['kind'] == 'video']
        self.assertEqual([j['id'] for j in motion], [f'image-{number:03d}-motion' for number in range(2, 13)])
        self.assertTrue(all(j['expected_bytes'] == 392718 and len(j['urls']) == 3 for j in motion))
        self.assertEqual(len({j['id'] for j in jobs}), 23)

    def test_live_photo_file_id_without_stream_and_other_video_fields_remain_gaps(self):
        image = {'url': 'https://ci.xhscdn.com/still', 'live_photo_file_id': 'synthetic-file-id'}
        note = galaxy.select_note(payload(images_list=[image]), 'normal', NOTE_A)
        jobs, gaps = galaxy.media_jobs(note)
        self.assertEqual(len(jobs), 1)
        self.assertEqual(gaps[0]['fields'], ['live_photo_file_id'])
        image['live_photo'] = {'media': {'stream': {'h265': [{'format': 'mp4', 'master_url': 'https://sns-video.xhscdn.com/live', 'size': 500}]}}}
        image['extra_video_url'] = 'https://sns-video.xhscdn.com/separate-component'
        jobs, gaps = galaxy.media_jobs(note)
        self.assertEqual([j['id'] for j in jobs], ['image-001', 'image-001-motion'])
        self.assertEqual(gaps[0]['id'], 'image-001-extra-motion')
        self.assertEqual(gaps[0]['fields'], ['extra_video_url'])

    def test_live_motion_added_to_paid_cache_without_replacing_existing_stills(self):
        value = payload(images_list=[{'url': 'https://ci.xhscdn.com/1'}, {
            'url': 'https://ci.xhscdn.com/2', 'live_photo_file_id': 'synthetic-file-id',
            'live_photo': {'media': {'stream': {'h265': [{'format': 'mp4', 'size': 500,
                'master_url': 'https://sns-video.xhscdn.com/live?signature=private'}]}}}}])
        client = FakeClient([(200, value)])
        runner = self.runner(client)
        item = runner.plan[NOTE_A]
        note, attempt, _ = runner.fetch(item)
        jobs, _ = galaxy.media_jobs(note)
        old_jobs = [job for job in jobs if job['kind'] == 'image']
        old_gaps = [{'id': 'image-002-motion', 'kind': 'video', 'status': 'unsupported'}]
        with patch.object(galaxy, 'media_jobs', return_value=(old_jobs, old_gaps)), patch.object(galaxy, 'transfer', side_effect=self.saved_media):
            runner.process_media(item, note, attempt)
        originals = {m['id']: (m['path'], m['sha256']) for m in runner.entry(item)['media'].values()}
        with patch.object(galaxy, 'transfer', side_effect=self.saved_media) as download:
            status, available, total = runner.process_media(item, note, attempt)
        self.assertEqual((status, available, total), ('complete', 3, 3))
        self.assertEqual([call.args[2]['id'] for call in download.call_args_list], ['image-002-motion'])
        self.assertEqual(len(client.detail_calls), 1)
        metadata = galaxy.read_json(self.root / '笔记' / NOTE_A / '元数据.json')
        for receipt in metadata['media']:
            if receipt['kind'] == 'image':
                self.assertEqual((receipt['path'], receipt['sha256']), originals[receipt['id']])
                self.assertEqual(digest(self.root / '笔记' / NOTE_A / receipt['path']), receipt['sha256'])
        self.assertNotIn('signature', json.dumps(metadata))

    def test_video_preview_layout_is_not_an_extra_media_component(self):
        value = payload(kind='video', video_preview_type='full_vertical_screen',
                        video_info_v2={'media': {'stream': {'h264': [{'format': 'mp4',
                            'master_url': 'https://sns-video.xhscdn.com/video',
                            'width': 1080, 'height': 1920, 'size': 1000}]}}})
        jobs, gaps = galaxy.media_jobs(galaxy.select_note(value, 'video', NOTE_A))
        self.assertEqual([job['kind'] for job in jobs], ['image', 'video'])
        self.assertEqual(gaps, [])

    def test_native_voice_uses_audio_without_a_false_video_gap(self):
        note = galaxy.select_note(payload(kind='video', native_voice_info={
            'url': 'http://sns-v14-ae.rednotecdn.com/native?signature=private',
            'duration': 371930, 'sound_bg_music_type': 4,
            'cover': 'https://avatar.example/cover'}), 'video', NOTE_A)
        jobs, gaps = galaxy.media_jobs(note)
        self.assertEqual([(job['id'], job['kind']) for job in jobs],
                         [('image-001', 'image'), ('audio-001', 'audio')])
        self.assertEqual(gaps, [])
        self.assertEqual(note['type'], 'video')
        self.assertTrue(jobs[-1]['urls'][0].startswith('https://sns-v14-ae.rednotecdn.com/'))
        self.assertFalse(any('avatar.example' in url for job in jobs for url in job['urls']))

    def test_native_voice_and_real_video_are_both_kept(self):
        note = galaxy.select_note(payload(kind='video', native_voice_info={
            'url': 'https://sns-v14-ae.rednotecdn.com/native'}, video_info_v2={
                'media': {'stream': {'h264': [{'format': 'mp4', 'size': 1000,
                    'master_url': 'https://sns-video.xhscdn.com/video'}]}}}), 'video', NOTE_A)
        jobs, gaps = galaxy.media_jobs(note)
        self.assertEqual([job['kind'] for job in jobs], ['image', 'video', 'audio'])
        self.assertEqual(gaps, [])

    def test_native_voice_and_background_music_keep_stable_ids_and_roles(self):
        note = galaxy.select_note(payload(native_voice_info={'url': 'https://sns-v14-ae.rednotecdn.com/native'},
            simple_music_info={'url': 'http://sns-music.xhscdn.com/music.mp3'}), 'normal', NOTE_A)
        jobs, gaps = galaxy.media_jobs(note)
        self.assertEqual([(j['id'], j['role']) for j in jobs if j['kind'] == 'audio'],
                         [('audio-001', 'original_audio'), ('audio-002', 'background_music')])
        self.assertEqual(gaps, [])
        note.pop('native_voice_info')
        jobs, gaps = galaxy.media_jobs(note)
        self.assertEqual([(j['id'], j.get('role')) for j in jobs],
                         [('image-001', None), ('audio-002', 'background_music')])
        self.assertEqual(jobs[-1]['ordinal'], 2)
        self.assertTrue(jobs[-1]['urls'][0].startswith('https://sns-music.xhscdn.com/'))
        self.assertEqual(gaps, [])

    def test_declared_background_music_without_usable_url_remains_a_gap(self):
        for music in ({'music_id': 'synthetic'}, {'url': ''}, {'url': 42},
                      {'url': 'https://foreign.example/music.mp3'}, 'unexpected'):
            with self.subTest(music=music):
                note = galaxy.select_note(payload(simple_music_info=music), 'normal', NOTE_A)
                jobs, gaps = galaxy.media_jobs(note)
                self.assertEqual([job['kind'] for job in jobs], ['image'])
                self.assertEqual(gaps, [{'id': 'audio-002', 'kind': 'audio', 'role': 'background_music',
                                        'status': 'missing', 'reason': 'background_music_url_unavailable'}])

    def test_native_voice_without_an_allowed_url_remains_an_explicit_gap(self):
        for native in ({'duration': 371930}, {'url': ''}, {'url': 42},
                       {'url': 'https://other.example/audio'}, 'unexpected'):
            with self.subTest(native=native):
                note = galaxy.select_note(payload(kind='video', native_voice_info=native), 'video', NOTE_A)
                jobs, gaps = galaxy.media_jobs(note)
                self.assertEqual([job['kind'] for job in jobs], ['image'])
                self.assertEqual([(gap['kind'], gap['reason']) for gap in gaps],
                                 [('audio', 'native_audio_url_unavailable')])
                self.assertEqual(gaps[0]['role'], 'original_audio')
        for native in (None, {}):
            note = galaxy.select_note(payload(kind='video', native_voice_info=native), 'video', NOTE_A)
            _, gaps = galaxy.media_jobs(note)
            self.assertEqual(gaps[0]['reason'], 'no_usable_mp4_stream')

    def test_audio_signatures_and_audio_stream_duration_are_required(self):
        self.assertEqual(galaxy.extension(M4A, 'audio'), '.m4a')
        self.assertEqual(galaxy.extension(b'RIFF' + b'\0' * 4 + b'WAVE', 'audio'), '.wav')
        self.assertEqual(galaxy.extension(b'ID3' + b'\0' * 40, 'audio'), '.mp3')
        self.assertEqual(galaxy.extension(bytes.fromhex('fffb9064'), 'audio'), '.mp3')
        for signature, kind in ((M4A, 'video'), (M4A, 'image'), (HEIC, 'audio'),
                                (b'RIFF' + b'\0' * 4 + b'WEBP', 'audio'),
                                (bytes.fromhex('fff15000'), 'audio'), (bytes.fromhex('fffbfc64'), 'audio')):
            with self.subTest(kind=kind, signature=signature[:12]):
                with self.assertRaises(ValueError): galaxy.extension(signature, kind)
        probes = [{'streams': [{'codec_type': 'video'}], 'format': {'duration': '1'}}]
        probes.extend({'streams': [{'codec_type': 'audio'}], 'format': {'duration': duration}}
                      for duration in (None, '0', '-1', 'nan', 'inf'))
        for metadata in probes:
            with self.subTest(metadata=metadata):
                with patch.object(galaxy.subprocess, 'run', return_value=SimpleNamespace(stdout=json.dumps(metadata))) as command:
                    with self.assertRaises(ValueError): galaxy.verify_media(self.root / 'synthetic.m4a', 'audio')
                self.assertEqual(command.call_count, 1)

    def test_audio_full_decode_maps_audio_and_optional_visual_streams(self):
        metadata = {'streams': [{'codec_type': 'audio', 'codec_name': 'aac'}, {'codec_type': 'video'}],
                    'format': {'duration': '0.1', 'size': '2000'}}
        with patch.object(galaxy.subprocess, 'run', side_effect=[SimpleNamespace(stdout=json.dumps(metadata)),
                                                               SimpleNamespace(returncode=0)]) as command:
            receipt = galaxy.verify_media(self.root / 'synthetic.m4a', 'audio')
        decoder = command.call_args_list[1].args[0]
        self.assertEqual(decoder[decoder.index('-threads') + 1], '2')
        self.assertIn('-xerror', decoder)
        self.assertEqual([decoder[i + 1] for i, arg in enumerate(decoder) if arg == '-map'], ['0:a', '0:v?'])
        self.assertNotIn('-t', decoder)
        self.assertEqual((receipt['full_decode'], receipt['decoder_threads']), ('passed', 2))

    def test_real_offline_audio_transfers_verify_format_length_hash_and_full_decode(self):
        cases = [('m4a', '.m4a', ['-c:a', 'aac']), ('wav', '.wav', ['-c:a', 'pcm_s16le']),
                 ('mp3-tagged', '.mp3', ['-c:a', 'libmp3lame']),
                 ('mp3-frames', '.mp3', ['-c:a', 'libmp3lame', '-id3v2_version', '0', '-write_id3v1', '0'])]
        for name, suffix, options in cases:
            with self.subTest(name=name):
                fixture = self.root / (name + suffix)
                galaxy.subprocess.run(['ffmpeg', '-v', 'error', '-nostdin', '-f', 'lavfi', '-i',
                                       'sine=frequency=440:sample_rate=8000:duration=0.1',
                                       *options, '-threads', '1', str(fixture)],
                                      capture_output=True, check=True, timeout=30)
                contents = fixture.read_bytes()
                if name == 'mp3-frames': self.assertFalse(contents.startswith(b'ID3'))
                opener = Mock(); opener.open.return_value = Response(contents)
                # An intentionally wrong URL suffix cannot override the file signature.
                job = {'id': 'audio-001', 'kind': 'audio', 'urls': ['https://sns-v14-ae.rednotecdn.com/native.webp?signature=private']}
                with patch.object(galaxy.urllib.request, 'build_opener', return_value=opener):
                    result = galaxy.transfer(self.root, NOTE_A, job, 'source/raw.json')
                self.assertEqual(result['status'], 'available')
                self.assertTrue(result['path'].endswith(suffix))
                self.assertEqual(result['bytes'], len(contents))
                self.assertEqual(result['sha256'], digest(fixture))
                self.assertEqual(result['verification']['full_decode'], 'passed')
                self.assertEqual(result['verification']['probe']['streams'][0]['codec_type'], 'audio')
                self.assertNotIn('signature', json.dumps(result))
                self.assertNotIn('Authorization', dict(opener.open.call_args.args[0].header_items()))
                opener.open.return_value = Response(contents, length=len(contents) + 1)
                with patch.object(galaxy.urllib.request, 'build_opener', return_value=opener), patch.object(galaxy, 'verify_media') as decode:
                    result = galaxy.transfer(self.root, NOTE_B, job, 'source/raw.json')
                self.assertEqual(result['status'], 'failed')
                decode.assert_not_called()

    def test_cached_native_voice_retry_keeps_cover_and_type_without_api_refetch(self):
        save_json(self.plan, {'notes': [{'note_id': NOTE_A, 'type': 'video', 'liked': True}]})
        client = FakeClient([(200, payload(kind='video', native_voice_info={
            'url': 'https://sns-v14-ae.rednotecdn.com/native?signature=private'}))])
        runner = self.runner(client)
        item = runner.plan[NOTE_A]
        note, attempt, _ = runner.fetch(item)
        jobs, _ = galaxy.media_jobs(note)
        old_jobs = [job for job in jobs if job['kind'] == 'image']
        old_gaps = [{'id': 'video-001', 'kind': 'video', 'status': 'missing', 'reason': 'no_usable_mp4_stream'}]
        with patch.object(galaxy, 'media_jobs', return_value=(old_jobs, old_gaps)), patch.object(galaxy, 'transfer', side_effect=self.saved_media):
            self.assertEqual(runner.process_media(item, note, attempt)[0], 'partial')
        cover = dict(runner.entry(item)['media']['image-001'])
        with patch.object(galaxy, 'transfer', side_effect=self.saved_media) as download:
            runner.run(retry_media=True)
        self.assertEqual([call.args[2]['id'] for call in download.call_args_list], ['audio-001'])
        self.assertEqual(len(client.detail_calls), 1)
        metadata = galaxy.read_json(self.root / '笔记' / NOTE_A / '元数据.json')
        self.assertEqual((metadata['type'], metadata['media_status']), ('video', 'complete'))
        self.assertEqual([receipt['kind'] for receipt in metadata['media']], ['image', 'audio'])
        self.assertEqual(metadata['media'][1]['role'], 'original_audio')
        self.assertEqual(metadata['media'][0], cover)
        self.assertEqual(digest(self.root / '笔记' / NOTE_A / cover['path']), cover['sha256'])
        self.assertNotIn('signature', json.dumps(metadata))
        self.assertEqual(runner.entry(item)['gaps'], [])

    def test_cached_music_retry_adds_only_background_audio_and_backfills_roles(self):
        client = FakeClient([(200, payload(native_voice_info={'url': 'https://sns-v14-ae.rednotecdn.com/native'},
            simple_music_info={'url': 'https://sns-music.xhscdn.com/music?signature=private'}))])
        runner = self.runner(client)
        item = runner.plan[NOTE_A]
        note, attempt, _ = runner.fetch(item)
        jobs, _ = galaxy.media_jobs(note)
        old_jobs = [job for job in jobs if job['id'] != 'audio-002']
        with patch.object(galaxy, 'media_jobs', return_value=(old_jobs, [])), patch.object(galaxy, 'transfer', side_effect=self.saved_media):
            runner.process_media(item, note, attempt)
        prior = runner.entry(item)
        prior['media']['audio-001'].pop('role')
        runner.store_entry(NOTE_A, prior)
        originals = {key: (value['path'], value['sha256']) for key, value in prior['media'].items()}
        with patch.object(galaxy, 'transfer', side_effect=self.saved_media) as download:
            runner.run(retry_media=True)
        self.assertEqual([call.args[2]['id'] for call in download.call_args_list], ['audio-002'])
        self.assertEqual(len(client.detail_calls), 1)
        metadata = galaxy.read_json(self.root / '笔记' / NOTE_A / '元数据.json')
        self.assertEqual(metadata['media_status'], 'complete')
        self.assertEqual([(m['id'], m['role']) for m in metadata['media'] if m['kind'] == 'audio'],
                         [('audio-001', 'original_audio'), ('audio-002', 'background_music')])
        for media in metadata['media']:
            if media['id'] in originals:
                self.assertEqual((media['path'], media['sha256']), originals[media['id']])
        self.assertNotIn('signature', json.dumps(metadata))
        self.assertEqual(runner.entry(item)['media']['audio-001']['role'], 'original_audio')

    def test_cached_subtitles_transfer_parse_and_reuse_without_paid_requests(self):
        save_json(self.plan, {'notes': [{'note_id': NOTE_A, 'type': 'video', 'liked': True}]})
        subtitles = {label: [{'url': 'https://sns-subtitle-s8.rednotecdn.com/' + label + '.srt?sign=private',
                              'language': language, 'format': 0, 'type': 0}]
                     for label, language in [('source', 'zh-CN'), ('en-US', 'en-US')]}
        value = payload(kind='video', video_info_v2={'media': {
            'stream': {'h264': [{'format': 'mp4', 'master_url': 'https://ci.xhscdn.com/video',
                                 'width': 10, 'height': 10}]}, 'video': {'subtitles': subtitles}}})
        client = FakeClient([(200, value)])
        runner = self.runner(client); item = runner.plan[NOTE_A]
        note, attempt, _ = runner.fetch(item)
        jobs, gaps = galaxy.media_jobs(note)
        self.assertEqual(gaps, [])
        with patch.object(galaxy, 'media_jobs', return_value=([j for j in jobs if j['kind'] != 'subtitle'], [])), \
                patch.object(galaxy, 'transfer', side_effect=self.saved_media):
            runner.process_media(item, note, attempt)
        original = {key: (m['path'], m['sha256']) for key, m in runner.entry(item)['media'].items()}
        data = '1\n00:00:00,100 --> 00:00:01,000\n测试字幕\n\n'.encode('utf-8')
        opener = Mock(); opener.open.side_effect = lambda *a, **k: Response(data)
        with patch.object(galaxy.urllib.request, 'build_opener', return_value=opener), \
                patch.object(galaxy.subprocess, 'run', side_effect=AssertionError('SRT must use text parser')):
            runner.run(retry_media=True)
        self.assertEqual(opener.open.call_count, 2)
        self.assertEqual(len(client.detail_calls), 1)
        record = galaxy.read_json(self.root / '笔记' / NOTE_A / '元数据.json')
        self.assertEqual(record['media_status'], 'complete')
        entries = [m for m in record['media'] if m['kind'] == 'subtitle']
        self.assertEqual([m['subtitle_role'] for m in entries], ['source', 'en-US'])
        self.assertEqual([m['language'] for m in entries], ['zh-CN', 'en-US'])
        for media in entries:
            self.assertTrue(media['path'].endswith('.srt'))
            self.assertEqual(media['verification']['full_parse'], 'passed')
            self.assertEqual(media['verification']['cue_count'], 1)
            self.assertEqual(media['bytes'], len(data))
            self.assertEqual(media['sha256'], digest(self.root / '笔记' / NOTE_A / media['path']))
        for media in record['media']:
            if media['id'] in original:
                self.assertEqual((media['path'], media['sha256']), original[media['id']])
        self.assertNotIn('sign=private', json.dumps(record))
        with patch.object(galaxy.urllib.request, 'build_opener', side_effect=AssertionError('No repeated transfers')):
            runner.run(retry_media=True)
        self.assertEqual(len(client.detail_calls), 1)

    def test_sample_import_is_offline_idempotent_and_uses_common_schema(self):
        sample = self.root / '原始来源' / 'sample'
        (sample / 'raw').mkdir(parents=True)
        (sample / 'media').mkdir()
        raw = sample / 'raw' / 'sample.json'; save_json(raw, payload())
        image = sample / 'media' / 'image.heic'; image.write_bytes(HEIC)
        raw_hash = digest(raw)
        save_json(sample / 'api-ledger.json', {'attempts': [{'note_id': NOTE_A, 'type': 'normal', 'status': 'detail_verified',
                  'raw_file': 'raw/sample.json', 'raw_sha256': raw_hash, 'http_status': 200, 'expected_cost_cny': '0.03'}]})
        save_json(sample / 'download-index.json', {'posts': {NOTE_A: {'media': {'image-001': {'status': 'verified',
                  'file': 'media/image.heic', 'bytes': len(HEIC), 'sha256': digest(image), 'full_decode_exit_code': 0,
                  'metadata': {'format': {'size': str(len(HEIC))}}}}}}})
        runner = self.runner()
        with patch.object(galaxy.urllib.request, 'build_opener', side_effect=AssertionError('No network during import')):
            runner.import_sample(sample); runner.import_sample(sample)
        self.assertEqual(len(runner.ledger['attempts']), 1)
        self.assertEqual(digest(raw), raw_hash)
        metadata = galaxy.read_json(self.root / '笔记' / NOTE_A / '元数据.json')
        self.assertEqual(metadata['media_status'], 'complete')
        self.assertEqual(metadata['relations'][0]['kind'], 'liked')
        self.assertEqual(metadata['relations'][0]['provider'], 'latest_likes_list')
        self.assertEqual(metadata['author']['name'], 'Author')
        self.assertNotIn('signature', json.dumps(metadata))

    def test_decoder_uses_full_decode_and_rejects_failure(self):
        probe = SimpleNamespace(stdout=json.dumps({'streams': [{'codec_type': 'video'}], 'format': {'duration': '3'}}).encode())
        with patch.object(galaxy.subprocess, 'run', side_effect=[probe, SimpleNamespace(returncode=1)]) as run:
            with self.assertRaises(ValueError): galaxy.verify_media(Path('synthetic.mp4'), 'video')
        self.assertIn('-xerror', run.call_args_list[1].args[0])
        self.assertIn('null', run.call_args_list[1].args[0])

    def test_three_workers_write_complete_ledgers_indexes_and_files(self):
        ids = self.many_posts(9)
        api_barrier = threading.Barrier(3)
        media_barrier = threading.Barrier(3)
        calls, active, maximum = [], 0, 0
        counter_lock = threading.Lock()
        def call(path, note_id=None):
            nonlocal active, maximum
            if note_id is None:
                return 200, {'data': {'balance': '50'}}
            # Read the real on-disk ledger while other threads update it. The current
            # request must already have a complete durable record, and every ID is unique.
            ledger = galaxy.read_json(self.batch / 'api-ledger.json')
            self.assertTrue(any(a['note_id'] == note_id and a['status'] == 'started' for a in ledger['attempts']))
            self.assertEqual(len({a['attempt_id'] for a in ledger['attempts']}), len(ledger['attempts']))
            with counter_lock:
                calls.append(note_id); active += 1; maximum = max(maximum, active)
            api_barrier.wait(timeout=5)
            with counter_lock:
                active -= 1
            return 200, payload(note_id)
        def media(*args, **kwargs):
            kwargs['before_request']()
            media_barrier.wait(timeout=5)
            return self.saved_media(*args, **kwargs)
        runner = self.runner(SimpleNamespace(call=call), workers=3)
        with patch.object(galaxy, 'transfer', side_effect=media):
            result = runner.run()
        self.assertEqual(result['new_detail_posts'], 9)
        self.assertEqual(maximum, 3)
        self.assertCountEqual(calls, ids)
        ledger = galaxy.read_json(runner.ledger_path)
        self.assertEqual(sorted(a['attempt_id'] for a in ledger['attempts']), list(range(1, 10)))
        self.assertTrue(all(a['status'] == 'detail_verified' for a in ledger['attempts']))
        index = galaxy.read_json(runner.index_path)
        self.assertEqual(set(index['posts']), set(ids))
        self.assertTrue(all(entry['status'] == 'complete' for entry in index['posts'].values()))
        for attempt in ledger['attempts']:
            self.assertEqual(digest(self.root / attempt['raw_file']), attempt['raw_sha256'])
        for note_id in ids:
            metadata = galaxy.read_json(self.root / '笔记' / note_id / '元数据.json')
            receipt = metadata['media'][0]
            self.assertEqual(digest(self.root / '笔记' / note_id / receipt['path']), receipt['sha256'])

    def test_parallel_limit_counts_only_new_details_including_inflight_reservations(self):
        ids = self.many_posts(8)
        seed = self.runner(FakeClient([(200, payload(ids[0])), (200, payload(ids[-1]))]))
        seed.fetch(seed.plan[ids[0]]); seed.fetch(seed.plan[ids[-1]])
        calls = []
        def call(path, note_id=None):
            if note_id is None:
                return 200, {'data': {'balance': '50'}}
            calls.append(note_id)
            threading.Event().wait(0.01)
            return 200, payload(note_id)
        runner = self.runner(SimpleNamespace(call=call), workers=3)
        with patch.object(galaxy, 'transfer', side_effect=self.saved_media):
            result = runner.run(limit=2)
        self.assertEqual(result['new_detail_posts'], 2)
        self.assertEqual(len(calls), 2)
        self.assertNotIn(ids[0], calls); self.assertNotIn(ids[-1], calls)
        self.assertEqual(len(galaxy.read_json(runner.ledger_path)['attempts']), 4)
        # Cached posts later in the plan are still processed after the new-request limit.
        self.assertEqual(set(galaxy.read_json(runner.index_path)['posts']), {ids[0], ids[1], ids[2], ids[-1]})

    def test_parallel_platform_stop_saves_inflight_responses_without_more_admission(self):
        ids = self.many_posts(12)
        barrier = threading.Barrier(3)
        calls = []
        runner = self.runner(workers=3)
        def call(path, note_id=None):
            if note_id is None:
                return 200, {'data': {'balance': '50'}}
            calls.append(note_id)
            barrier.wait(timeout=5)
            if note_id == ids[0]:
                return 200, {'code': 429, 'message': '请求过于频繁'}
            self.assertTrue(runner.stop_event.wait(5))
            return 200, payload(note_id)
        runner.client = SimpleNamespace(call=call)
        with patch.object(galaxy, 'transfer') as media:
            with self.assertRaises(galaxy.BatchStop): runner.run()
        self.assertCountEqual(calls, ids[:3])
        media.assert_not_called()
        ledger = galaxy.read_json(runner.ledger_path)
        self.assertEqual(len(ledger['attempts']), 3)
        self.assertEqual(sum(a['status'] == 'platform_stopped' for a in ledger['attempts']), 1)
        self.assertEqual(sum(a['status'] == 'detail_verified' for a in ledger['attempts']), 2)
        self.assertTrue(all((self.root / a['raw_file']).is_file() for a in ledger['attempts']))
        self.assertEqual(len(galaxy.read_json(runner.index_path)['posts']), 2)

    def test_parallel_media_stop_finishes_current_files_and_claims_no_more_media(self):
        ids = self.many_posts(9)
        api_barrier, media_barrier = threading.Barrier(3), threading.Barrier(3)
        media_calls = []
        runner = self.runner(workers=3)
        def call(path, note_id=None):
            if note_id is None:
                return 200, {'data': {'balance': '50'}}
            api_barrier.wait(timeout=5)
            return 200, payload(note_id, images_list=[{'url': 'https://ci.xhscdn.com/1'}, {'url': 'https://ci.xhscdn.com/2'}])
        def media(root, note_id, job, source_ref, *, before_request=None):
            before_request()
            media_calls.append((note_id, job['id']))
            media_barrier.wait(timeout=5)
            if note_id == ids[0]:
                raise galaxy.BatchStop('cdn_auth_or_rate_limit')
            self.assertTrue(runner.stop_event.wait(5))
            # This transfer was already admitted: its completed bytes must still be saved.
            return self.saved_media(root, note_id, job, source_ref)
        runner.client = SimpleNamespace(call=call)
        with patch.object(galaxy, 'transfer', side_effect=media):
            with self.assertRaises(galaxy.BatchStop): runner.run()
        self.assertEqual(len(media_calls), 3)
        self.assertTrue(all(job_id == 'image-001' for _, job_id in media_calls))
        ledger = galaxy.read_json(runner.ledger_path)
        self.assertEqual(len(ledger['attempts']), 3)
        self.assertTrue(all(a['status'] == 'detail_verified' for a in ledger['attempts']))
        index = galaxy.read_json(runner.index_path)
        self.assertTrue(all(entry['status'] == 'paused' for entry in index['posts'].values()))
        self.assertEqual(sum(len(entry['media']) for entry in index['posts'].values()), 2)
        for note_id in ids[1:3]:
            metadata = galaxy.read_json(self.root / '笔记' / note_id / '元数据.json')
            self.assertEqual([m['status'] for m in metadata['media']], ['available', 'pending'])

    def test_worker_count_is_bounded_and_default_remains_serial(self):
        self.assertEqual(self.runner().workers, 1)
        with self.assertRaises(ValueError): self.runner(workers=4)


if __name__ == '__main__':
    unittest.main()
