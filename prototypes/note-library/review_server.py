#!/usr/bin/env python3
"""Loopback-only review board. Manual decisions are separate from archived notes."""
import argparse
import json
import mimetypes
import os
import re
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit

from library import DEFAULT_ROOT, now, save_json

STATUSES = {'pending', 'unliked', 'still_liked', 'uncertain'}
UI = Path(__file__).parent / 'review-board/index.html'


class BoardServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address, root):
        self.root = Path(root).resolve()
        self.folder = self.root / '复核看板'
        self.board = json.loads((self.folder / 'board.json').read_text())
        self.ids = {n['id'] for n in self.board['notes']}
        self.media = {}
        for note in self.board['notes']:
            for item in note['media']:
                url = item['url']
                if url.startswith('/preview/'):
                    path = (self.folder / 'previews' / unquote(url.removeprefix('/preview/'))).resolve()
                    expected = (self.folder / 'previews' / note['id']).resolve()
                else:
                    parts = unquote(url.removeprefix('/media/')).split('/', 1)
                    if len(parts) != 2 or parts[0] != note['id']:
                        raise ValueError('Invalid media note ID')
                    path = (self.root / '笔记' / parts[0] / 'media' / parts[1]).resolve()
                    expected = (self.root / '笔记' / note['id'] / 'media').resolve()
                if not path.is_relative_to(expected) or not path.is_file():
                    raise ValueError('Invalid board media path')
                self.media[unquote(url)] = path
        self.lock = threading.Lock()
        super().__init__(address, Handler)

    def reviews(self):
        p = self.folder / 'reviews.json'
        return json.loads(p.read_text()) if p.exists() else {}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass  # Never log original links or private note contents.

    def allowed(self, writing=False):
        host = self.headers.get('Host', '')
        port = self.server.server_port
        allowed = {f'127.0.0.1:{port}', f'localhost:{port}'}
        origin = self.headers.get('Origin')
        if host not in allowed or (origin and origin not in {'http://' + h for h in allowed}):
            self.send_error(403)
            return False
        if writing and (self.headers.get('Content-Type', '').split(';')[0] != 'application/json'
                        or self.headers.get('Sec-Fetch-Site') == 'cross-site'):
            self.send_error(403)
            return False
        return True

    def send_headers(self, status, kind, size, extra=None):
        self.send_response(status)
        self.send_header('Content-Type', kind)
        self.send_header('Content-Length', str(size))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Referrer-Policy', 'no-referrer')
        self.send_header('X-Content-Type-Options', 'nosniff')
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()

    def json(self, data, status=200, extra=None):
        body = json.dumps(data, ensure_ascii=False).encode()
        self.send_headers(status, 'application/json; charset=utf-8', len(body), extra)
        self.wfile.write(body)

    def do_GET(self):
        if not self.allowed():
            return
        path = unquote(urlsplit(self.path).path)
        if path == '/':
            content = UI.read_bytes()
            self.send_headers(200, 'text/html; charset=utf-8', len(content))
            self.wfile.write(content)
        elif path == '/api/board':
            with self.server.lock:
                self.json({**self.server.board, 'reviews': self.server.reviews()})
        elif path == '/api/export':
            with self.server.lock:
                self.json(self.server.reviews(), extra={'Content-Disposition': 'attachment; filename="reviews.json"'})
        elif path in self.server.media:
            self.serve_media(self.server.media[path])
        else:
            self.send_error(404)

    def serve_media(self, path):
        size = path.stat().st_size
        start, end, status = 0, size - 1, 200
        range_header = self.headers.get('Range')
        if range_header:
            match = re.fullmatch(r'bytes=(\d*)-(\d*)', range_header)
            if not match or not any(match.groups()):
                self.send_headers(416, 'text/plain', 0, {'Content-Range': f'bytes */{size}'})
                return
            left, right = match.groups()
            if left:
                start = int(left)
                end = min(int(right), size - 1) if right else size - 1
            else:
                start = max(0, size - int(right))
            if start > end or start >= size:
                self.send_headers(416, 'text/plain', 0, {'Content-Range': f'bytes */{size}'})
                return
            status = 206
        extra = {'Accept-Ranges': 'bytes'}
        if status == 206:
            extra['Content-Range'] = f'bytes {start}-{end}/{size}'
        self.send_headers(status, mimetypes.guess_type(path.name)[0] or 'application/octet-stream', end-start+1, extra)
        try:
            with path.open('rb') as stream:
                stream.seek(start)
                remaining = end-start+1
                while remaining:
                    chunk = stream.read(min(1024*1024, remaining))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    remaining -= len(chunk)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def do_POST(self):
        if not self.allowed(writing=True):
            return
        if self.path != '/api/review':
            self.send_error(404)
            return
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if length <= 0 or length > 32000:
                raise ValueError('Invalid body length')
            data = json.loads(self.rfile.read(length))
            if (data.get('id') not in self.server.ids
                    or ('status' in data and data['status'] not in STATUSES)
                    or ('decision' in data and data['decision'] not in ('delete', 'keep', None))
                    or not any(k in data for k in ('status', 'decision', 'note'))
                    or ('note' in data and (not isinstance(data['note'], str) or len(data['note']) > 5000))):
                raise ValueError('Invalid review')
            with self.server.lock:
                reviews = self.server.reviews()
                old = reviews.get(data['id'], {})
                review = {**old, 'status': data.get('status', old.get('status', 'pending')),
                          'note': data.get('note', old.get('note', '')),
                          'updated_at': now()}
                if 'decision' in data:
                    review['decision'] = data['decision']
                reviews[data['id']] = review
                save_json(self.server.folder / 'reviews.json', reviews)
            self.json({'ok': True, 'review': review})
        except (ValueError, TypeError, AttributeError):
            self.json({'ok': False, 'error': '复核内容无效，未保存'}, 400)
        except OSError:
            self.json({'ok': False, 'error': '文件保存失败，请重试'}, 500)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=DEFAULT_ROOT)
    parser.add_argument('--port', type=int, default=8765)
    args = parser.parse_args()
    os.umask(0o077)
    server = BoardServer(('127.0.0.1', args.port), args.root)
    print(f'http://127.0.0.1:{server.server_port}', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == '__main__':
    main()
