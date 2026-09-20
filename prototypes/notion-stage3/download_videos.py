#!/usr/bin/env python3
"""Download all unique video links in original Notion variants into private supplements."""
import argparse, collections, concurrent.futures, hashlib, json, os, shutil, subprocess, threading, time
import urllib.request, urllib.error, re
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit
from audit_export import split_page, links, ID

RESERVE = 2 * 1024**3
STOP = threading.Event()


def save(path, value):
    temporary = path.with_suffix('.json.tmp')
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')
    temporary.chmod(0o600)
    temporary.replace(path)


def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as f:
        for block in iter(lambda: f.read(1024**2), b''):
            h.update(block)
    return h.hexdigest()


class Redirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        target = urlsplit(newurl)
        if target.scheme != 'https' or not target.hostname or not target.hostname.endswith('.xhscdn.com'):
            raise ValueError('Unexpected redirect destination')
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def request(url, method='GET', headers=None):
    return urllib.request.build_opener(Redirect()).open(urllib.request.Request(url, method=method, headers={
        'User-Agent': 'Rednote-Sync-LocalArchiveCheck/1.0', 'Accept-Encoding': 'identity', **(headers or {})}), timeout=40)


def error_result(error):
    if isinstance(error, urllib.error.HTTPError):
        if error.code in (401, 403, 429, 461):
            STOP.set()
        return {'status': 'http_error', 'http_status': error.code}
    return {'status': 'failed', 'error_type': type(error).__name__}


def inventory(root):
    corpus = [json.loads(line) for line in (root/'normalized/corpus.jsonl').read_text().splitlines()]
    primary = {}
    for n in corpus:
        for m in n['media']:
            if m['kind'] == 'video' and m['storage'] == 'remote_reference':
                u = urlsplit(m['url'])
                primary[n['id']] = urlunsplit(('https', u.netloc, u.path, u.query, ''))
    found = {}
    for page in sorted((root/'source/export').rglob('*.md')):
        _, props, body = split_page(page.read_text(encoding='utf-8-sig'))
        note_id = props.get('resourceId', '').lower()
        if not ID.fullmatch(note_id):
            continue
        for *_, raw in links(body):
            u = urlsplit(raw.strip('<>'))
            if u.scheme not in ('http', 'https') or not u.path.lower().endswith('.mp4'):
                continue
            if u.hostname not in ('sns-bak-v1.xhscdn.com', 'sns-bak-v6.xhscdn.com') or u.query:
                raise ValueError('Unexpected source URL shape; inspect before requesting')
            url = urlunsplit(('https', u.netloc, u.path, '', ''))
            item = found.setdefault(url, {'url': url, 'key': hashlib.sha256(url.encode()).hexdigest(), 'note_ids': [], 'source_pages': []})
            if note_id not in item['note_ids']:
                item['note_ids'].append(note_id)
            item['source_pages'].append(str(page.relative_to(root)))
    items = []
    for url, item in sorted(found.items()):
        note_id = sorted(item['note_ids'])[0]
        suffix = '' if primary.get(note_id) == url else '-' + item['key'][:10]
        item['file'] = 'supplemental/videos/' + note_id + suffix + '.mp4'
        items.append(item)
    assert len({i['file'] for i in items}) == len(items)
    return items


def head(item):
    if STOP.is_set():
        return {'status': 'not_attempted'}
    try:
        with request(item['url'], 'HEAD') as r:
            result = {'status': 'available', 'http_status': r.status, 'content_type': r.headers.get('Content-Type'), 'bytes': int(r.headers.get('Content-Length', '0'))}
        time.sleep(.15)
        return result
    except urllib.error.HTTPError as error:
        if error.code not in (404, 405):
            return error_result(error)
        try:
            with request(item['url'], 'GET', {'Range': 'bytes=0-0'}) as r:
                total = int(r.headers.get('Content-Range', '').rsplit('/', 1)[1]) if r.status == 206 else int(r.headers.get('Content-Length', '0'))
                r.read(1)
                return {'status': 'available', 'http_status': r.status, 'head_status': error.code, 'method': 'GET Range bytes=0-0', 'content_type': r.headers.get('Content-Type'), 'bytes': total}
        except Exception as retry_error:
            return error_result(retry_error)
    except Exception as error:
        return error_result(error)


def download(item, root):
    if STOP.is_set():
        return {'status': 'not_attempted'}
    target = root/item['file']
    if target.exists():
        actual_hash = digest(target)
        expected_hash = item.get('download', {}).get('sha256')
        expected_size = item.get('plan', {}).get('bytes')
        if (expected_size and target.stat().st_size != expected_size) or (expected_hash and actual_hash != expected_hash):
            return {'status': 'existing_file_mismatch'}
        return {'status': 'downloaded', 'bytes': target.stat().st_size, 'sha256': actual_hash, 'reused': True}
    partial = target.with_suffix('.mp4.part')
    if partial.exists():
        if partial.is_symlink() or not partial.is_file():
            return {'status': 'failed', 'error_type': 'UnexpectedPartialPath'}
        partial.unlink()  # Only this downloader's incomplete temporary target; restart cleanly.
    for attempt in range(2):
        if STOP.is_set():
            return {'status': 'not_attempted'}
        try:
            count = 0
            checksum = hashlib.sha256()
            use_range = item.get('plan', {}).get('method', '').startswith('GET Range')
            with request(item['url'], headers={'Range': 'bytes=0-'} if use_range else None) as r:
                if r.status not in (200, 206):
                    raise ValueError('Expected complete response')
                expected = int(r.headers.get('Content-Length', '0'))
                if r.status == 206:
                    extent = re.fullmatch(r'bytes 0-(\d+)/(\d+)', r.headers.get('Content-Range', ''))
                    if not extent or int(extent.group(1)) + 1 != int(extent.group(2)):
                        raise ValueError('Range does not cover the complete video')
                    expected = int(extent.group(2))
                if expected and shutil.disk_usage(root).free < expected + RESERVE:
                    STOP.set()
                    return {'status': 'space_stop'}
                with partial.open('xb') as f:
                    while True:
                        block = r.read(1024**2)
                        if not block:
                            break
                        if shutil.disk_usage(root).free < RESERVE:
                            STOP.set()
                            raise OSError('Disk reserve reached')
                        count += len(block)
                        checksum.update(block)
                        f.write(block)
                if not count or (expected and count != expected):
                    raise ValueError('Incomplete response')
                with partial.open('rb') as f:
                    if f.read(8)[4:8] != b'ftyp':
                        raise ValueError('Not an ISO media container')
                partial.rename(target)
                return {'status': 'downloaded', 'bytes': count, 'sha256': checksum.hexdigest(), 'attempts': attempt + 1}
        except Exception as error:
            if partial.exists():
                partial.unlink()
            result = error_result(error)
            if STOP.is_set() or isinstance(error, urllib.error.HTTPError) or attempt == 1:
                return result
            time.sleep(2)


def verify(item, root):
    target = root/item['file']
    if not target.is_file():
        return {'status': 'missing'}
    try:
        probe = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration,size:stream=codec_type,codec_name,width,height', '-of', 'json', str(target)], capture_output=True, timeout=60, check=True)
        metadata = json.loads(probe.stdout)
        if not any(s.get('codec_type') == 'video' for s in metadata['streams']):
            raise ValueError('No video stream')
        decoded = subprocess.run(['ffmpeg', '-v', 'error', '-xerror', '-nostdin', '-threads', '1', '-i', str(target), '-map', '0:v', '-map', '0:a?', '-f', 'null', '-'], capture_output=True, timeout=1800)
        current_hash = digest(target)
        expected_hash = item.get('download', {}).get('sha256')
        return {'status': 'verified' if decoded.returncode == 0 and (not expected_hash or current_hash == expected_hash) else 'decode_or_hash_failed', 'metadata': metadata, 'decode_exit_code': decoded.returncode, 'sha256': current_hash, 'bytes': target.stat().st_size}
    except Exception as error:
        return {'status': 'verification_failed', 'error_type': type(error).__name__}


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('action', choices=['plan', 'download', 'verify'])
    p.add_argument('--root', type=Path, required=True)
    p.add_argument('--workers', type=int, choices=range(1, 7), default=3)
    a = p.parse_args()
    os.umask(0o077)
    root = a.root.resolve(strict=True)
    folder = root/'supplemental/videos'
    folder.mkdir(parents=True, exist_ok=True, mode=0o700)
    manifest = root/'supplemental/video-index.json'
    data = json.loads(manifest.read_text()) if manifest.exists() else {'scope': 'All unique MP4 URLs across original Notion record variants; original export unchanged', 'transport': 'HTTPS on the same exported CDN hosts; no cookies or login APIs', 'items': inventory(root)}
    items = data['items']
    recheck = root/'supplemental/video-link-recheck.json'
    if recheck.exists():
        for row in json.loads(recheck.read_text())['items']:
            good = next((c for c in row['checks'] if c.get('status') in (200, 206)), None)
            if good:
                item = next(i for i in items if i['key'] == row['key'])
                previous = item['plan']
                item['plan'] = {'status': 'available', 'http_status': good['status'], 'method': 'GET Range bytes=0-0', 'head_status': previous.get('head_status', previous.get('http_status')), 'content_type': good.get('content_type'), 'bytes': int(good['content_range'].rsplit('/', 1)[1]) if good.get('content_range') else int(good.get('content_length') or 0)}
    if a.action == 'download':
        required = sum(i.get('plan', {}).get('bytes', 0) for i in items if not (root/i['file']).exists())
        free = shutil.disk_usage(root).free
        if free < required + RESERVE:
            print(json.dumps({'status': 'insufficient_space', 'required_bytes': required, 'free_bytes': free, 'reserve_bytes': RESERVE}), flush=True)
            return
        if any(i.get('plan', {}).get('http_status') in (401, 403, 429, 461) for i in items):
            print(json.dumps({'status': 'preflight_access_stop', 'counts': dict(collections.Counter(i.get('plan', {}).get('status') for i in items))}), flush=True)
            return
    key = 'plan' if a.action == 'plan' else a.action
    pending = list(items)  # Explicit verify checks every current file.
    if a.action == 'download':
        pending = [i for i in items if not (i.get('verify', {}).get('status') == 'verified' and (root/i['file']).is_file() and (root/i['file']).stat().st_size == i['verify'].get('bytes') and digest(root/i['file']) == i['verify'].get('sha256'))]
    def transfer_and_verify(item):
        if item.get('plan', {}).get('http_status') in (404, 410):
            return {'status': 'unavailable', 'http_status': item['plan']['http_status']}
        result = download(item, root)
        if result.get('status') == 'downloaded':
            result['verification'] = verify({**item, 'download': result}, root)
        return result
    fn = head if a.action == 'plan' else (transfer_and_verify if a.action == 'download' else lambda i: verify(i, root))
    workers = a.workers if a.action in ('plan', 'download') else min(a.workers, 2)
    started = time.monotonic()
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {pool.submit(fn, i): i for i in pending}
        for done, future in enumerate(concurrent.futures.as_completed(futures), 1):
            item = futures[future]
            result = future.result()
            item[key] = {**item.get(key, {}), **result}  # Preserve a previous successful hash on failure.
            if key == 'download':
                item.pop('verify', None)
            if key == 'download' and 'verification' in item[key]:
                item['verify'] = item[key].pop('verification')
            data['updated_at_unix'] = time.time()
            save(manifest, data)
            if done % 10 == 0 or item[key]['status'] not in ('available', 'downloaded', 'verified') or done == len(pending):
                counts = dict(collections.Counter(i.get(key, {}).get('status', 'pending') for i in items))
                print(json.dumps({'action': a.action, 'done': done, 'total': len(pending), 'counts': counts, 'elapsed_seconds': round(time.monotonic()-started), 'verified': sum(i.get('verify', {}).get('status') == 'verified' for i in items), 'free_gib': round(shutil.disk_usage(root).free/1024**3, 2)}), flush=True)
    print(json.dumps({'action': a.action, 'total_items': len(items), 'total_declared_bytes': sum(i.get('plan', {}).get('bytes', 0) for i in items), 'existing_files': sum((root/i['file']).is_file() for i in items), 'stop_triggered': STOP.is_set()}), flush=True)

if __name__ == '__main__':
    main()
