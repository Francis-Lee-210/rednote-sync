import json
import tempfile
import threading
import unittest
import urllib.request
import urllib.error
from pathlib import Path

from review_server import BoardServer


class ReviewServerTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.addCleanup(self.temp.cleanup)
        folder = self.root / '复核看板'
        folder.mkdir()
        self.id = 'a'*24
        media = self.root / '笔记' / self.id / 'media'
        media.mkdir(parents=True)
        (media/'test.mp4').write_bytes(b'0123456789')
        self.url = '/media/' + self.id + '/test.mp4'
        preview = folder / 'previews' / self.id
        preview.mkdir(parents=True)
        (preview/'test.jpg').write_bytes(b'jpeg')
        self.preview_url = '/preview/' + self.id + '/test.jpg'
        (folder/'board.json').write_text(json.dumps({'summary': {}, 'notes': [{'id': self.id, 'media': [{'url': self.url}, {'url': self.preview_url}]}]}))
        self.server = BoardServer(('127.0.0.1', 0), self.root)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.stop)
        self.base = f'http://127.0.0.1:{self.server.server_port}'

    def stop(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()

    def test_save_reload_export_and_reject_unknown_id(self):
        data = {'id': self.id, 'status': 'uncertain', 'note': '测试备注'}
        req = urllib.request.Request(self.base+'/api/review', data=json.dumps(data).encode(), headers={'Content-Type':'application/json'})
        with urllib.request.urlopen(req) as response:
            self.assertTrue(json.load(response)['ok'])
        with urllib.request.urlopen(self.base+'/api/board') as response:
            self.assertEqual(json.load(response)['reviews'][self.id]['note'], '测试备注')
        self.assertEqual(self.server.reviews()[self.id]['status'], 'uncertain')
        data['id'] = 'b'*24
        req.data = json.dumps(data).encode()
        with self.assertRaises(urllib.error.HTTPError) as err:
            urllib.request.urlopen(req)
        self.assertEqual(err.exception.code, 400)
        with urllib.request.urlopen(self.base+'/api/export') as response:
            self.assertEqual(len(json.load(response)), 1)

    def test_retention_decision_is_independent_and_undoable(self):
        def post(payload):
            req = urllib.request.Request(self.base+'/api/review', data=json.dumps({'id':self.id,**payload}).encode(), headers={'Content-Type':'application/json'})
            with urllib.request.urlopen(req) as response:
                return json.load(response)['review']
        post({'status':'uncertain','note':'original'})
        changed = post({'decision':'delete'})
        self.assertEqual(changed['status'], 'uncertain')
        self.assertEqual(changed['note'], 'original')
        self.assertEqual(changed['decision'], 'delete')
        self.assertEqual(post({'decision':'keep'})['decision'], 'keep')
        restored = post({'decision':None})
        self.assertIsNone(restored['decision'])
        self.assertEqual(restored['note'], 'original')
        self.assertTrue((self.root/'笔记'/self.id/'media/test.mp4').exists())
        with self.assertRaises(urllib.error.HTTPError):
            post({'decision':'erase'})

    def test_ranges_and_no_arbitrary_files_or_cross_origin(self):
        req = urllib.request.Request(self.base+self.url, headers={'Range':'bytes=2-4'})
        with urllib.request.urlopen(req) as response:
            self.assertEqual(response.status, 206)
            self.assertEqual(response.read(), b'234')
        with urllib.request.urlopen(self.base+self.preview_url) as response:
            self.assertEqual(response.read(), b'jpeg')
        for path, headers, code in [('/api/board', {'Origin':'https://example.com'},403),('/media/../../etc/passwd',{},404),(self.url,{'Range':'bytes=20-'},416)]:
            with self.assertRaises(urllib.error.HTTPError) as err:
                urllib.request.urlopen(urllib.request.Request(self.base+path, headers=headers))
            self.assertEqual(err.exception.code,code)
