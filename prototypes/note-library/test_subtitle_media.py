"""Synthetic, offline subtitle checks. No source files or network are used."""
import copy
import json
import socket
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import subtitle_media


SRT = ('1\n00:00:01,020 --> 00:00:03,450\n第一行\nSecond line\n\n'
       '2\n00:00:03,000 --> 00:00:04,200\nAnother cue\n')


def note(tracks):
    return {'video_info_v2': {'media': {'video': {'subtitles': tracks}}}}


def track(url, language='zh-CN', type_value=0, format_value=0):
    return {'url': url, 'language': language, 'type': type_value, 'format': format_value}


class SubtitleMediaTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / 'synthetic.srt'
        guard = patch.object(socket.socket, 'connect', side_effect=AssertionError('Network forbidden'))
        guard.start(); self.addCleanup(guard.stop)

    def test_realistic_language_entries_keep_all_different_urls(self):
        tracks = {'en-US': [track('https://example.invalid/en.srt', 'en-US')],
                  'source': [track('https://example.invalid/source.srt')],
                  'zh-CN': [track('https://example.invalid/zh.srt')]}
        value = note(tracks); before = copy.deepcopy(value)
        jobs, gaps = subtitle_media.media_jobs(value)
        self.assertEqual(gaps, [])
        self.assertEqual([j['id'] for j in jobs], ['subtitle-source-001', 'subtitle-en-US-001', 'subtitle-zh-CN-001'])
        self.assertTrue(all(j['kind'] == 'subtitle' for j in jobs))
        self.assertEqual(jobs[0]['language'], 'zh-CN')
        self.assertEqual(jobs[0]['subtitle_role'], 'source')
        self.assertEqual(jobs[0]['provider_subtitle_type'], 0)
        self.assertEqual(jobs[0]['provider_subtitle_format'], 0)
        self.assertEqual(value, before)
        self.assertEqual(subtitle_media.media_jobs(note(dict(reversed(list(tracks.items()))))), (jobs, gaps))

    def test_only_exact_urls_merge_and_source_metadata_wins(self):
        shared = 'https://example.invalid/a.srt?version=1'
        jobs, gaps = subtitle_media.media_jobs(note({
            'en-US': [track(shared, 'en-US', 2, 'srt')],
            'zh-CN': [track('https://example.invalid/a.srt?version=2')],
            'source': [track(shared, 'zh-CN', 0, 0)]}))
        self.assertEqual(gaps, [])
        self.assertEqual(len(jobs), 2)
        self.assertEqual(jobs[0]['id'], 'subtitle-source-001')
        self.assertEqual(jobs[0]['language'], 'zh-CN')
        self.assertEqual(jobs[0]['languages'], ['zh-CN', 'en-US'])
        self.assertEqual(jobs[0]['subtitle_labels'], ['source', 'en-US'])
        self.assertEqual(jobs[0]['provider_subtitle_type'], 0)
        self.assertEqual(jobs[0]['urls'], [shared])
        self.assertEqual(jobs[1]['id'], 'subtitle-zh-CN-001')

    def test_bad_labels_shapes_and_missing_urls_are_explicit_gaps(self):
        jobs, gaps = subtitle_media.media_jobs(note({
            1: [track('https://example.invalid/a.srt')],
            '../escape': [track('https://example.invalid/b.srt')],
            'en-US': {'url': 'https://example.invalid/c.srt'},
            'source': [None, {'url': ''}, track('https://example.invalid/d.srt', ['zh-CN'])]}))
        self.assertEqual(jobs, [])
        self.assertEqual(len(gaps), 6)
        self.assertTrue(all(g['kind'] == 'subtitle' and g['status'] == 'missing' for g in gaps))
        self.assertTrue(all('/' not in g['id'] and '..' not in g['id'] for g in gaps))
        self.assertNotIn('https://', json.dumps(gaps))
        self.assertEqual(subtitle_media.media_jobs({}), ([], []))
        self.assertEqual(subtitle_media.media_jobs(note(None)), ([], []))
        self.assertEqual(subtitle_media.media_jobs(note([]))[1][0]['reason'], 'invalid_subtitle_list')

    def test_case_variant_labels_do_not_collide_on_case_insensitive_filesystems(self):
        jobs, _ = subtitle_media.media_jobs(note({'en-US': [track('https://example.invalid/a.srt', 'en-US')],
                                                  'en-us': [track('https://example.invalid/b.srt', 'en-us')]}))
        self.assertEqual(len(jobs), 2)
        self.assertEqual(len({job['id'].casefold() for job in jobs}), 2)

    def test_sniff_handles_bom_crlf_and_truncated_multibyte_cue(self):
        header = b'1\r\n00:00:01,000 --> 00:00:02,000\r\n'
        self.assertEqual(subtitle_media.extension(b'\xef\xbb\xbf' + header + b'\xe4\xb8'), '.srt')
        for data in (b'<html>error</html>', b'WEBVTT\n\n00:00.000 --> 00:01.000',
                     b'1\n00:61:00,000 --> 00:62:00,000\ntext', b'1\n00:00:01.000 --> 00:00:02.000\ntext'):
            with self.subTest(data=data[:10]), self.assertRaises(ValueError):
                subtitle_media.extension(data)

    def test_verify_utf8_bom_multiline_overlap_and_source_preservation(self):
        for raw in (SRT.encode(), b'\xef\xbb\xbf' + SRT.replace('\n', '\r\n').encode()):
            self.path.write_bytes(raw)
            receipt = subtitle_media.verify(self.path)
            self.assertEqual(receipt['cue_count'], 2)
            self.assertEqual(receipt['start_ms'], 1020)
            self.assertEqual(receipt['end_ms'], 4200)
            self.assertEqual(receipt['bytes'], len(raw))
            self.assertEqual(receipt['utf8_bom'], raw.startswith(b'\xef\xbb\xbf'))
            self.assertEqual(receipt['full_parse'], 'passed')
            self.assertNotIn('full_decode', receipt)
            self.assertNotIn('Second line', json.dumps(receipt))
            self.assertEqual(self.path.read_bytes(), raw)

    def test_verify_rejects_invalid_indexes_times_empty_cues_and_encoding(self):
        bad = [b'', b'\xff\xfe1\x00', b'1\n00:00:01,000 --> 00:00:02,000\n\xff',
               SRT.replace('2\n00:00:03', '3\n00:00:03').encode(),
               SRT.replace('2\n00:00:03', '1\n00:00:03').encode(),
               SRT.replace('00:00:03,450', '00:00:01,020').encode(),
               SRT.replace('00:00:03,450', '00:00:00,999').encode(),
               b'1\n00:60:00,000 --> 01:01:00,000\ntext',
               b'1\n00:00:01,000 --> 00:00:02,000\n   \n',
               SRT.replace('Second line\n\n2', 'Second line\n2').encode(),
               b'1\n00:00:01,000 --> 00:00:02,000\ntext\x00']
        for raw in bad:
            with self.subTest(number=bad.index(raw)):
                self.path.write_bytes(raw)
                with self.assertRaises(ValueError): subtitle_media.verify(self.path)


if __name__ == '__main__':
    unittest.main()
