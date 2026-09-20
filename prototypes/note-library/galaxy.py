#!/usr/bin/env python3
"""Galaxy detail/media adapter for the shared library; billing limits live on the platform."""
import argparse
import concurrent.futures
import contextlib
import copy
import errno
import fcntl
import getpass
import hashlib
import json
import math
import os
import re
import shutil
import subprocess
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

import subtitle_media
from cdn_transport import CDNHTTPSHandler
from library import (DEFAULT_ROOT, copy_preserving, digest, install_media, note_dir,
                     now, put_note, relative_source, save_json, enrich_record)

ORIGIN = 'https://api.galaxysapi.com'
API_PATHS = {'normal': '/api/get_note_detail', 'video': '/api/get_note_detail_video'}
QUOTED_COST = {'normal': '0.03', 'video': '0.04'}  # Evidence only, never a local spending gate.
RESERVE_BYTES = 2 * 1024 ** 3
ALLOWED_CDN = ('xhscdn.com', 'rednotecdn.com')
STOP_CODES = {401, 402, 403, 429, 461}
MAX_BUSY_RETRIES = 2
LEDGER_SCHEMA = 'galaxy-library-ledger-v1'
JOB_METADATA_FIELDS = ('role', 'language', 'languages', 'subtitle_labels', 'subtitle_role',
                       'provider_subtitle_type', 'provider_subtitle_format')


def job_metadata(job):
    return {key: copy.deepcopy(job[key]) for key in JOB_METADATA_FIELDS if key in job}


class BatchStop(Exception):
    """A shared platform/storage condition requiring the whole invocation to stop."""


def emit(event, **fields):
    print(json.dumps({'event': event, **fields}, ensure_ascii=False), flush=True)


def read_json(path):
    return json.loads(Path(path).read_text(encoding='utf-8'))


def local_path(base, relative):
    path = (Path(base) / relative).resolve()
    path.relative_to(Path(base).resolve())
    return path


@contextlib.contextmanager
def process_lock(root):
    path = Path(root) / '导出记录' / '.galaxy.lock'
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with path.open('a+') as lock:
        os.chmod(path, 0o600)
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise BatchStop('another_galaxy_process_is_running') from None
        try:
            yield
        finally:
            fcntl.flock(lock, fcntl.LOCK_UN)


def check_space(root, incoming=0):
    if shutil.disk_usage(root).free < RESERVE_BYTES + max(0, incoming):
        raise BatchStop('disk_reserve_reached')


def load_plan(path):
    value = read_json(path)
    entries = value.get('notes') if isinstance(value, dict) else value
    if not isinstance(entries, list):
        raise ValueError('Plan must contain a notes list')
    result = {}
    for item in entries:
        if not isinstance(item, dict) or not re.fullmatch(r'[0-9a-f]{24}', str(item.get('note_id', ''))):
            raise ValueError('Invalid plan note ID')
        if item.get('type') not in API_PATHS:
            raise ValueError('Invalid plan note type')
        if item['note_id'] in result:
            raise ValueError('Duplicate plan note ID')
        result[item['note_id']] = item
    if isinstance(value, dict) and 'count' in value and value['count'] != len(result):
        raise ValueError('Plan count does not match its entries')
    return result


def inner_envelope(payload):
    inner = payload.get('data') if isinstance(payload, dict) else None
    if isinstance(inner, str):
        try:
            inner = json.loads(inner)
        except ValueError:
            return {}
    return inner if isinstance(inner, dict) else {}


def select_note(payload, kind, note_id):
    inner = inner_envelope(payload)
    if not isinstance(payload, dict) or payload.get('code') != 200 or inner.get('success') is not True or inner.get('code') != 0:
        return None
    rows = inner.get('data')
    if not isinstance(rows, list):
        return None
    candidates = []
    for row in rows:
        if isinstance(row, dict):
            candidates.extend(row['note_list'] if isinstance(row.get('note_list'), list) else [row])
    matches = [row for row in candidates if isinstance(row, dict) and row.get('id') == note_id
               and row.get('model_type') == 'note' and row.get('type') == kind]
    return matches[0] if len(matches) == 1 else None


def envelope_signals(payload):
    """Inspect service envelopes only, never a note's user-authored text."""
    layers = [payload, inner_envelope(payload)] if isinstance(payload, dict) else []
    codes, messages = [], []
    for layer in layers:
        for name in ('code', 'status', 'error_code'):
            try:
                codes.append(int(layer[name]))
            except (KeyError, ValueError, TypeError):
                pass
        for name in ('message', 'msg', 'error_message', 'error'):
            value = layer.get(name)
            if isinstance(value, str):
                messages.append(value.casefold())
            elif isinstance(value, dict):
                nested_codes, nested_messages = envelope_signals(value)
                codes.extend(nested_codes); messages.append(nested_messages)
    return codes, ' '.join(messages)


def platform_stop(http_status, payload):
    codes, message = envelope_signals(payload)
    if http_status in STOP_CODES or any(code in STOP_CODES for code in codes):
        return 'platform_auth_quota_or_rate_limit'
    phrases = ('余额不足', '额度不足', '超过限额', '达到限额', '额度用尽', '次数用尽',
               '账号封禁', '账户封禁', '账号被封', '账户被封', '账号禁用', '账户禁用',
               '账号冻结', '账户冻结', '密钥无效', '无效密钥', '未授权', '认证失败',
               '请求过于频繁', '请求频繁', '触发限流', 'insufficient balance',
               'insufficient funds', 'quota exceeded', 'limit exceeded', 'rate limit',
               'too many requests', 'invalid api key', 'unauthorized', 'account banned',
               'account suspended')
    return 'platform_auth_quota_or_rate_limit' if any(p in message for p in phrases) else None


def busy_rejection(payload):
    codes, message = envelope_signals(payload)
    unsuccessful = any(code not in (0, 200) for code in codes) or inner_envelope(payload).get('success') is False
    return unsuccessful and any(p in message for p in ('服务繁忙', '系统繁忙', '上游繁忙',
                                                       'service busy', 'server busy', 'temporarily unavailable'))


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ValueError('API redirects are not followed')


def redact(value, key):
    if isinstance(value, str):
        return value.replace(key, '[redacted]')
    if isinstance(value, list):
        return [redact(item, key) for item in value]
    if isinstance(value, dict):
        return {redact(k, key): redact(v, key) for k, v in value.items()}
    return value


class APIClient:
    def __init__(self, key):
        if not key:
            raise ValueError('API Key is empty')
        self.key = key

    def call(self, path, note_id=None):
        if path not in (*API_PATHS.values(), '/api/get_balance'):
            raise ValueError('Unrecognized API endpoint')
        url = ORIGIN + path
        if note_id is not None:
            if not re.fullmatch(r'[0-9a-f]{24}', note_id):
                raise ValueError('Invalid note ID')
            url += '?' + urllib.parse.urlencode({'note_id': note_id})
        request = urllib.request.Request(url, headers={'Authorization': self.key, 'Accept': 'application/json',
                                                       'User-Agent': 'Rednote-Sync-PersonalArchive/1.0'})
        opener = urllib.request.build_opener(NoRedirect())
        try:
            response = opener.open(request, timeout=95)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            body = response.read(16 * 1024 ** 2 + 1)
            if len(body) > 16 * 1024 ** 2:
                raise ValueError('API response exceeds the JSON limit')
            try:
                payload = json.loads(body.decode('utf-8'))
            except (UnicodeError, ValueError):
                # A successful HTTP transfer with invalid JSON may still have been billed.
                return response.status, {'parse_error': 'invalid_json', 'body_bytes': len(body),
                                       'body_sha256': hashlib.sha256(body).hexdigest()}
            return response.status, redact(payload, self.key)


def media_url(value):
    parsed = urllib.parse.urlsplit(value)
    host = parsed.hostname or ''
    if parsed.scheme not in ('https', 'http') or parsed.username or parsed.password or parsed.port not in (None, 443, 80):
        raise ValueError('Unexpected media URL shape')
    if not any(host == domain or host.endswith('.' + domain) for domain in ALLOWED_CDN):
        raise ValueError('Unrecognized media host')
    return urllib.parse.urlunsplit(('https', host, parsed.path, parsed.query, ''))


class CDRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return super().redirect_request(req, fp, code, msg, headers, media_url(newurl))


def extension(prefix, kind):
    if kind == 'subtitle':
        return subtitle_media.extension(prefix)
    if kind == 'image':
        for marker, suffix in ((b'\xff\xd8\xff', '.jpg'), (b'\x89PNG\r\n\x1a\n', '.png'),
                               (b'GIF87a', '.gif'), (b'GIF89a', '.gif')):
            if prefix.startswith(marker):
                return suffix
        if prefix.startswith(b'RIFF') and prefix[8:12] == b'WEBP':
            return '.webp'
    if kind == 'audio':
        if prefix.startswith(b'RIFF') and prefix[8:12] == b'WAVE':
            return '.wav'
        # An MPEG Layer III frame has a valid version, layer and sample-rate field.
        # ffprobe and the full decoder still determine whether all bytes are usable.
        mp3_frame = (len(prefix) >= 4 and prefix[0] == 0xff and prefix[1] & 0xe0 == 0xe0
                     and (prefix[1] >> 3) & 3 != 1 and prefix[1] & 6 == 2
                     and prefix[2] >> 4 != 15 and (prefix[2] >> 2) & 3 != 3)
        if prefix.startswith(b'ID3') or mp3_frame:
            return '.mp3'
    if prefix[4:8] == b'ftyp':
        end = min(int.from_bytes(prefix[:4], 'big'), len(prefix))
        brands = {prefix[8:12]} | {prefix[i:i + 4] for i in range(16, end, 4)}
        if kind == 'image':
            if brands & {b'avif', b'avis'}:
                return '.avif'
            if brands & {b'heic', b'heix', b'hevc', b'hevx'}:
                return '.heic'
            if brands & {b'mif1', b'msf1'}:
                return '.heif'
        elif kind == 'audio' and b'M4A ' in brands:
            return '.m4a'
        elif kind == 'video' and not brands & {b'heic', b'heix', b'avif', b'avis', b'mif1', b'msf1', b'M4A '}:
            return '.mp4'
    raise ValueError('Unrecognized media signature for its declared kind')


def verify_media(path, kind):
    if kind == 'subtitle':
        return subtitle_media.verify(path)
    probe = subprocess.run(['ffprobe', '-v', 'error', '-show_entries',
                            'format=duration,size:stream=codec_type,codec_name,width,height', '-of', 'json', str(path)],
                           capture_output=True, timeout=60, check=True)
    metadata = json.loads(probe.stdout)
    required_stream = 'audio' if kind == 'audio' else 'video'
    if not any(s.get('codec_type') == required_stream for s in metadata.get('streams', [])):
        raise ValueError('No decodable required media stream')
    if kind in ('video', 'audio'):
        duration = float(metadata.get('format', {}).get('duration') or 0)
        if not math.isfinite(duration) or duration <= 0:
            raise ValueError('Timed media has no positive finite duration')
    maps = ['-map', '0:a', '-map', '0:v?'] if kind == 'audio' else ['-map', '0:v', '-map', '0:a?']
    result = subprocess.run(['ffmpeg', '-v', 'error', '-xerror', '-nostdin', '-threads', '2', '-i', str(path),
                             *maps, '-f', 'null', '-'], capture_output=True, timeout=900)
    if result.returncode:
        raise ValueError('Media decode failed')
    return {'method': 'ffprobe_and_ffmpeg', 'full_decode': 'passed', 'full_decode_exit_code': 0,
            'decoder_threads': 2, 'probe': metadata}


def motion_fields(value):
    return sorted(str(k) for k, v in value.items() if v and
                  ('live' in str(k).casefold() or 'video' in str(k).casefold()
                   or (k in ('type', 'image_type') and isinstance(v, str) and 'live' in v.casefold())))


def mp4_job(info, media_id, ordinal):
    """Select one supplied MP4 rendition, for either a post video or a Live Photo."""
    media = info.get('media') if isinstance(info, dict) else None
    streams = media.get('stream') if isinstance(media, dict) else None
    choices = []
    for codec, items in (streams.items() if isinstance(streams, dict) else []):
        for item in items if isinstance(items, list) else []:
            if not isinstance(item, dict) or not isinstance(item.get('master_url'), str) or not item['master_url'] or item.get('format') != 'mp4':
                continue
            try:
                width, height, size = (int(item.get(k) or 0) for k in ('width', 'height', 'size'))
            except (TypeError, ValueError):
                continue
            if min(width, height, size) < 0:
                continue
            choices.append(((width * height, codec == 'h264', size), item))
    if not choices:
        return None
    score, best = max(choices, key=lambda candidate: candidate[0])
    backup = best.get('backup_urls') if isinstance(best.get('backup_urls'), list) else []
    return {'id': media_id, 'kind': 'video', 'ordinal': ordinal,
            'urls': [best['master_url']] + [u for u in backup if isinstance(u, str) and u],
            'expected_bytes': score[2]}


def media_jobs(note):
    jobs, gaps = [], []
    images = note.get('images_list') or []
    if not isinstance(images, list):
        images = []
        gaps.append({'id': 'image-list', 'kind': 'image', 'status': 'missing', 'reason': 'invalid_image_list'})
    for number, item in enumerate(images, 1):
        name = f'image-{number:03d}'
        if not isinstance(item, dict):
            gaps.append({'id': name, 'kind': 'image', 'status': 'missing', 'reason': 'invalid_image_entry'})
            continue
        levels = item.get('url_multi_level')
        levels = levels if isinstance(levels, dict) else {}
        urls = [item.get('original'), levels.get('high'), item.get('url_size_large'), item.get('url')]
        jobs.append({'id': name, 'kind': 'image', 'ordinal': number,
                     'urls': [u for u in urls if isinstance(u, str) and u]})
        fields = motion_fields(item)
        live = mp4_job(item.get('live_photo'), name + '-motion', number)
        if live:
            # Retain the still image and pair its motion component by a stable media ID.
            jobs.append(live)
            fields = [field for field in fields if field not in ('live_photo', 'live_photo_file_id')]
        if fields:
            gaps.append({'id': name + ('-extra-motion' if live else '-motion'), 'kind': 'video', 'status': 'unsupported',
                         'reason': 'live_or_video_component_not_collected', 'fields': fields})
    native_voice = note.get('native_voice_info')
    native_declared = bool(native_voice)
    audio_jobs = []
    for field, ordinal, role, reason in (
            ('native_voice_info', 1, 'original_audio', 'native_audio_url_unavailable'),
            ('simple_music_info', 2, 'background_music', 'background_music_url_unavailable')):
        info = note.get(field)
        if not info:
            continue
        audio = None
        audio_url = info.get('url') if isinstance(info, dict) else None
        if isinstance(audio_url, str) and audio_url.strip():
            try:
                audio = {'id': f'audio-{ordinal:03d}', 'kind': 'audio', 'ordinal': ordinal,
                         'role': role, 'urls': [media_url(audio_url)]}
            except ValueError:
                pass
        if audio:
            audio_jobs.append(audio)
        else:
            gaps.append({'id': f'audio-{ordinal:03d}', 'kind': 'audio', 'role': role,
                         'status': 'missing', 'reason': reason})
    if note['type'] == 'video':
        video = mp4_job(note.get('video_info_v2'), 'video-001', 1)
        if video:
            jobs.append(video)
        elif not native_declared:
            # Native-voice posts also use the platform's video note type. Their timed
            # content is audio, so an absent ordinary video stream is not a second gap.
            gaps.append({'id': 'video-001', 'kind': 'video', 'status': 'missing', 'reason': 'no_usable_mp4_stream'})
    elif not jobs:
        gaps.append({'id': 'image-list', 'kind': 'image', 'status': 'missing', 'reason': 'no_images_returned'})
    jobs.extend(audio_jobs)
    # This field describes the normal video's UI layout, not another media component.
    extra = [k for k in motion_fields(note) if k != 'video_preview_type'
             and (k != 'video_info_v2' or note['type'] != 'video')]
    if extra:
        gaps.append({'id': 'extra-motion', 'kind': 'video', 'status': 'unsupported',
                     'reason': 'additional_live_or_video_fields', 'fields': extra})
    subtitle_jobs, subtitle_gaps = subtitle_media.media_jobs(note)
    jobs.extend(subtitle_jobs)
    gaps.extend(subtitle_gaps)
    return jobs, gaps


def existing_media(root, note_id, receipt):
    if not receipt or receipt.get('status') != 'available':
        return False
    path = local_path(note_dir(root, note_id), receipt['path'])
    if not path.is_file() or path.stat().st_size != receipt['bytes'] or digest(path) != receipt['sha256']:
        raise ValueError('Previously verified media changed')
    return True


def transfer(root, note_id, job, source_ref, *, before_request=None):
    folder = note_dir(root, note_id) / 'media'
    folder.mkdir(parents=True, exist_ok=True, mode=0o700)
    partial = folder / ('.' + job['id'] + '.part')
    # An interrupted free CDN transfer can be restarted; it never triggers a paid detail request.
    if partial.exists():
        partial.unlink()
    errors, seen = [], set()
    for number, candidate in enumerate(job['urls']):
        try:
            url = media_url(candidate)
            if url in seen:
                continue
            seen.add(url)
            check_space(root, job.get('expected_bytes', 0))
            if before_request is not None:
                before_request()
            request = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0', 'Accept-Encoding': 'identity',
                                                           'Referer': 'https://www.xiaohongshu.com/'})
            with urllib.request.build_opener(CDRedirect(), CDNHTTPSHandler()).open(request, timeout=65) as response:
                if response.status != 200:
                    raise ValueError('Media response was not complete')
                expected = int(response.headers.get('Content-Length', '0'))
                check_space(root, max(expected, job.get('expected_bytes', 0)))
                size = 0
                with partial.open('xb') as output:
                    while True:
                        chunk = response.read(1024 ** 2)
                        if not chunk:
                            break
                        check_space(root, len(chunk))
                        output.write(chunk); size += len(chunk)
                    output.flush(); os.fsync(output.fileno())
            if not size or (expected and expected != size) or (job.get('expected_bytes') and job['expected_bytes'] != size):
                raise ValueError('Media length mismatch')
            with partial.open('rb') as stream:
                suffix = extension(stream.read(128), job['kind'])
            verification = verify_media(partial, job['kind'])
            sha = digest(partial)
            target = folder / (job['id'] + '-' + sha[:12] + suffix)
            if target.exists():
                if digest(target) != sha:
                    raise ValueError('Media target collision')
                partial.unlink()
            else:
                partial.rename(target)
            return {'id': job['id'], 'kind': job['kind'], 'path': 'media/' + target.name, 'status': 'available',
                    'bytes': size, 'sha256': sha, 'verification': verification, 'source_ref': source_ref,
                    'storage': 'downloaded'}
        except BatchStop:
            raise
        except Exception as error:
            status = error.code if isinstance(error, urllib.error.HTTPError) else None
            if status in (401, 429, 461):
                raise BatchStop('cdn_auth_or_rate_limit') from None
            if isinstance(error, OSError) and error.errno == errno.ENOSPC:
                raise BatchStop('disk_reserve_reached') from None
            errors.append({'url_index': number, 'error_type': type(error).__name__, 'http_status': status})
        finally:
            if partial.exists():
                partial.unlink()
    return {'id': job['id'], 'kind': job['kind'], 'status': 'failed', 'reason': 'media_transfer_failed',
            'errors': errors, 'source_ref': source_ref}


class Runner:
    def __init__(self, root, plan_path, batch_dir, *, client=None, delay=1, workers=1):
        if workers not in (1, 2, 3):
            raise ValueError('workers must be between 1 and 3')
        self.lock = threading.RLock()
        self.stop_event = threading.Event()
        self.stop_reason = None
        self.workers = workers
        self.requested_ids = set()
        self.root = Path(root).resolve()
        self.plan_path = Path(plan_path).resolve()
        self.plan = load_plan(self.plan_path)
        self.batch = Path(batch_dir).resolve()
        self.batch.relative_to(self.root)
        self.batch.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.raw_dir = self.batch / 'raw'; self.raw_dir.mkdir(exist_ok=True, mode=0o700)
        self.ledger_path = self.batch / 'api-ledger.json'
        self.index_path = self.batch / 'download-index.json'
        self.ledger = read_json(self.ledger_path) if self.ledger_path.exists() else {
            'schema_version': LEDGER_SCHEMA, 'provider': 'galaxy', 'created_at': now(),
            'billing_control': 'platform_configured_limit', 'attempts': [], 'balance_observations': []}
        if self.ledger.get('schema_version') != LEDGER_SCHEMA:
            raise ValueError('Unrecognized ledger schema')
        plan_sha = digest(self.plan_path)
        if self.ledger.get('plan_sha256', plan_sha) != plan_sha:
            raise ValueError('Plan changed; use a separate batch directory')
        self.ledger['plan_sha256'] = plan_sha
        try:
            self.plan_ref = relative_source(self.root, self.plan_path)
        except ValueError:
            snapshot = self.batch / 'plan.json'
            copy_preserving(self.plan_path, snapshot, plan_sha)
            self.plan_ref = relative_source(self.root, snapshot)
        self.index = read_json(self.index_path) if self.index_path.exists() else {'schema_version': 'galaxy-library-download-v1', 'posts': {}}
        self.client, self.delay = client, delay
        self.other_attempts = []
        for path in (self.root / '导出记录').glob('*/api-ledger.json'):
            if path.resolve() == self.ledger_path:
                continue
            previous = read_json(path)
            if previous.get('schema_version') == LEDGER_SCHEMA:
                self.other_attempts.extend(previous['attempts'])

    def save_ledger(self):
        with self.lock:
            self.ledger['updated_at'] = now()
            save_json(self.ledger_path, self.ledger)

    def store_entry(self, note_id, entry):
        with self.lock:
            self.index['posts'][note_id] = copy.deepcopy(entry)
            save_json(self.index_path, self.index)

    def entry(self, item):
        with self.lock:
            return copy.deepcopy(self.index['posts'].get(item['note_id'], {
                'note_id': item['note_id'], 'type': item['type'], 'media': {}}))

    def progress(self, event, **fields):
        with self.lock:
            emit(event, **fields)

    def stop_batch(self, reason):
        with self.lock:
            if not self.stop_event.is_set():
                self.stop_reason = reason
                self.stop_event.set()

    def check_running(self):
        with self.lock:
            if self.stop_event.is_set():
                raise BatchStop(self.stop_reason or 'batch_stopped')

    def attempts(self, note_id):
        with self.lock:
            return copy.deepcopy([a for a in self.other_attempts + self.ledger['attempts'] if a['note_id'] == note_id])

    def would_request(self, item):
        prior = self.attempts(item['note_id'])
        return not prior or (all(a.get('status') == 'busy_rejected' for a in prior) and len(prior) <= MAX_BUSY_RETRIES)

    def observe_balance(self):
        self.check_running()
        observation = {'checked_at': now(), 'source': 'get_balance'}
        try:
            status, payload = self.client.call('/api/get_balance')
            observation['http_status'] = status
            stop = platform_stop(status, payload)
            data = inner_envelope(payload)
            if isinstance(data.get('balance'), (str, int, float)):
                observation['balance_raw'] = str(data['balance'])
            else:
                observation['status'] = 'unavailable'
            with self.lock:
                self.ledger['balance_observations'].append(observation)
                self.save_ledger()
            if stop:
                self.stop_batch(stop)
                raise BatchStop(stop)
        except BatchStop:
            raise
        except Exception as error:
            observation.update({'status': 'unavailable', 'error_type': type(error).__name__})
            with self.lock:
                if observation not in self.ledger['balance_observations']:
                    self.ledger['balance_observations'].append(observation)
                self.save_ledger()

    def recover_saved_raw(self, item):
        """Recover a durable response whose final ledger commit was interrupted."""
        with self.lock:
            if any(a.get('status') == 'detail_verified' for a in self.attempts(item['note_id'])):
                return False
            for attempt in reversed(self.ledger['attempts']):
                if (attempt.get('note_id') != item['note_id'] or attempt.get('type') != item['type']
                        or attempt.get('status') not in ('started', 'request_unknown')):
                    continue
                number = attempt.get('attempt_id')
                if type(number) is not int or number < 1 or attempt.get('http_status') not in (None, 200):
                    continue
                path = self.raw_dir / f"{item['note_id']}-{number:06d}.json"
                if not path.exists():
                    continue
                if path.is_symlink() or not path.is_file():
                    raise ValueError('Saved raw response must be a regular file')
                raw = path.read_bytes()
                raw_sha = hashlib.sha256(raw).hexdigest()
                if attempt.get('raw_sha256') not in (None, raw_sha):
                    raise ValueError('Previously paid raw response changed')
                try:
                    payload = json.loads(raw)
                except (UnicodeError, ValueError):
                    continue
                if platform_stop(200, payload) or select_note(payload, item['type'], item['note_id']) is None:
                    continue
                # The saved envelope proves the detail identity. Do not invent the lost
                # HTTP status or completion timestamp, and never repeat the paid request.
                attempt.update({'status': 'detail_verified', 'billing_status': 'successful_detail',
                                'raw_file': relative_source(self.root, path), 'raw_sha256': raw_sha,
                                'recovered_at': now(), 'recovery': 'saved_raw_after_interrupted_commit'})
                self.save_ledger()
                return True
        return False

    def cached(self, item):
        self.recover_saved_raw(item)
        for attempt in reversed(self.attempts(item['note_id'])):
            if attempt.get('status') != 'detail_verified':
                continue
            path = local_path(self.root, attempt['raw_file'])
            if digest(path) != attempt['raw_sha256']:
                raise ValueError('Previously paid raw response changed')
            note = select_note(read_json(path), item['type'], item['note_id'])
            if note is None:
                raise ValueError('Previously paid raw response does not match the plan')
            return note, attempt
        return None

    def fetch(self, item):
        self.check_running()
        cached = self.cached(item)
        if cached:
            return *cached, False
        prior = self.attempts(item['note_id'])
        if prior and (any(a.get('status') != 'busy_rejected' for a in prior) or len(prior) > MAX_BUSY_RETRIES):
            return None, None, False
        for retry in range(len(prior), MAX_BUSY_RETRIES + 1):
            check_space(self.root)
            with self.lock:
                self.check_running()
                attempt = {'attempt_id': len(self.ledger['attempts']) + 1, 'note_id': item['note_id'],
                           'type': item['type'], 'api_path': API_PATHS[item['type']], 'started_at': now(),
                           'status': 'started', 'billing_status': 'unknown', 'quoted_cost_cny': QUOTED_COST[item['type']]}
                # Admission, ID allocation and the durable pre-request record are one transaction.
                self.ledger['attempts'].append(attempt)
                self.requested_ids.add(item['note_id'])
                self.save_ledger()
            try:
                status, payload = self.client.call(attempt['api_path'], item['note_id'])
            except Exception as error:
                with self.lock:
                    attempt.update({'status': 'request_unknown', 'error_type': type(error).__name__, 'finished_at': now()})
                    self.save_ledger()
                return None, attempt, True
            stop = platform_stop(status, payload)
            if stop:
                # Stop admission immediately; all responses already in flight still get saved.
                self.stop_batch(stop)
            path = self.raw_dir / f"{item['note_id']}-{attempt['attempt_id']:06d}.json"
            # Persist the response before interpreting it or requesting media.
            save_json(path, payload)
            note = select_note(payload, item['type'], item['note_id']) if status == 200 else None
            raw_sha = digest(path)
            busy = busy_rejection(payload)
            with self.lock:
                attempt.update({'http_status': status, 'raw_file': relative_source(self.root, path),
                                'raw_sha256': raw_sha, 'finished_at': now()})
                if isinstance(payload, dict) and isinstance(payload.get('balance'), (str, int, float)):
                    attempt['detail_response_balance_raw'] = str(payload['balance'])
                if stop:
                    attempt['status'] = 'platform_stopped'
                elif note is not None:
                    attempt.update({'status': 'detail_verified', 'billing_status': 'successful_detail'})
                elif busy:
                    attempt['status'] = 'busy_rejected'
                else:
                    attempt['status'] = 'request_unknown' if isinstance(payload, dict) and payload.get('parse_error') else 'detail_unavailable'
                self.save_ledger()
            if stop:
                raise BatchStop(stop)
            if note is not None:
                return note, attempt, True
            if busy:
                if retry < MAX_BUSY_RETRIES:
                    time.sleep(max(self.delay, 2) * (retry + 1))
                    continue
            return None, attempt, True

    def record_failure(self, item, attempt=None):
        """Publish only a known unavailable detail; uncertain attempts stay in the ledger."""
        if attempt is None:
            prior = self.attempts(item['note_id'])
            attempt = prior[-1] if prior else None
        if (not attempt or attempt.get('status') != 'detail_unavailable'
                or attempt.get('note_id') != item['note_id'] or attempt.get('type') != item['type']):
            return 'skipped'
        entry = self.entry(item)
        if any(m.get('status') == 'available' for m in entry['media'].values()):
            return 'preserved'
        raw_ref = attempt['raw_file']
        raw = local_path(self.root, raw_ref).read_bytes()
        if hashlib.sha256(raw).hexdigest() != attempt['raw_sha256']:
            raise ValueError('Previously saved failure response changed')
        payload = json.loads(raw)
        if (not isinstance(payload, dict) or payload.get('parse_error')
                or platform_stop(attempt.get('http_status'), payload)
                or select_note(payload, item['type'], item['note_id']) is not None):
            return 'skipped'
        codes, _ = envelope_signals(payload)
        provider_code = (404 if 404 in codes else
                         next((code for code in codes if code not in (0, 200)), codes[0] if codes else None))
        error = {'status': 'detail_unavailable', 'http_code': attempt.get('http_status'),
                 'provider_code': provider_code,
                 'reason': 'provider_reported_not_found' if provider_code == 404 else 'detail_unavailable',
                 'source_ref': raw_ref, 'source_sha256': attempt['raw_sha256']}
        plan_sha = self.ledger['plan_sha256']
        if digest(local_path(self.root, self.plan_ref)) != plan_sha:
            raise ValueError('Original plan changed')
        metadata_path = note_dir(self.root, item['note_id']) / '元数据.json'
        old = read_json(metadata_path) if metadata_path.exists() else {}
        relations = item.get('relations') if isinstance(item.get('relations'), list) else []
        if isinstance(item.get('liked'), bool):
            relations = relations + [{'kind': 'liked', 'value': item['liked'], 'provider': 'latest_likes_list',
                                      'source_ref': self.plan_ref}]
        sources = [{'provider': 'latest_likes_list', 'path': self.plan_ref, 'sha256': plan_sha},
                   {'provider': 'galaxy', 'path': raw_ref, 'sha256': attempt['raw_sha256'],
                    'collected_at': attempt.get('finished_at') or attempt.get('started_at')}]
        def union(values):
            return list({json.dumps(v, ensure_ascii=False, sort_keys=True): v for v in values}.values())
        record = {'note_id': item['note_id'], 'type': item['type'],
                  'title': item.get('title') if isinstance(item.get('title'), str) else '',
                  'body_text': '', 'body_markdown': '', 'content_status': 'detail_unavailable',
                  'media_status': 'not_fetched', 'media': [], 'acquisition_error': error,
                  'sources': union(old.get('sources', []) + sources),
                  'relations': union(old.get('relations', []) + relations)}
        outcome = put_note(self.root, record)
        if outcome != 'preserved':
            entry.update({'status': 'detail_unavailable', 'raw_file': raw_ref,
                          'raw_sha256': attempt['raw_sha256'], 'acquisition_error': error,
                          'updated_at': attempt.get('finished_at') or attempt.get('started_at')})
            self.store_entry(item['note_id'], entry)
        return outcome

    def record_failures(self):
        """Backfill current-batch failures from local evidence without an API client."""
        with self.lock:
            latest = {a['note_id']: copy.deepcopy(a) for a in self.ledger['attempts']
                      if a['note_id'] in self.plan}
        counts = {'eligible_failures': 0, 'written': 0, 'reused': 0, 'preserved': 0, 'skipped': 0}
        for note_id, attempt in latest.items():
            if attempt.get('status') == 'detail_unavailable':
                counts['eligible_failures'] += 1
                counts[self.record_failure(self.plan[note_id], attempt)] += 1
        return counts

    def publish(self, item, note, attempt, media):
        raw_ref = attempt['raw_file']
        user = note.get('user') or {}
        author = None
        if isinstance(user, dict) and user:
            author = {'name': user.get('nickname') or ''}
            author_id = user.get('userid') or user.get('user_id') or user.get('id')
            if author_id:
                author['id'] = author_id
        relations = item.get('relations') if isinstance(item.get('relations'), list) else []
        if isinstance(item.get('liked'), bool):
            relations = relations + [{'kind': 'liked', 'value': item['liked'], 'provider': 'latest_likes_list',
                                      'source_ref': self.plan_ref}]
        source = {'provider': 'galaxy', 'path': raw_ref, 'sha256': attempt['raw_sha256'],
                  'collected_at': attempt.get('finished_at') or attempt.get('started_at')}
        metadata_path = note_dir(self.root, item['note_id']) / '元数据.json'
        old = read_json(metadata_path) if metadata_path.exists() else {}
        def union(values):
            return list({json.dumps(v, ensure_ascii=False, sort_keys=True): v for v in values}.values())
        record = {'note_id': item['note_id'], 'type': item['type'], 'title': note.get('title') or '',
                  'body_text': note.get('desc') or '', 'body_markdown': note.get('desc') or '',
                  'source_url': 'https://www.xiaohongshu.com/explore/' + item['note_id'], 'author': author,
                  'sources': union(old.get('sources', []) + [source]),
                  'relations': union(old.get('relations', []) + relations), 'media': media}
        for key in ('variants', 'source_tags', 'source_tags_origin', 'source_relations', 'normalization_source'):
            if key in old:
                record[key] = old[key]
        candidates = [{'url': value, 'source_ref': ref}
                      for obj, ref in ((item, self.plan_ref), (note, raw_ref), (old, 'previous_metadata'))
                      for key in ('source_url', 'url', 'share_url')
                      if isinstance((value := obj.get(key)), str)]
        for field, key in (('share_info', 'link'), ('qq_mini_program_info', 'webpage_url'),
                           ('mini_program_info', 'webpage_url')):
            value = (note.get(field) or {}).get(key)
            if isinstance(value, str):
                candidates.append({'url': value, 'source_ref': raw_ref})
        candidates.extend(old.get('source_url_candidates', []))
        record = enrich_record(record, candidates, [old.get('author')])
        put_note(self.root, record)

    def process_media(self, item, note, attempt, *, retry_failed=False, sample_root=None, sample_media=None):
        jobs, gaps = media_jobs(note)
        # A worker owns this local copy; only store_entry touches the shared index.
        entry = self.entry(item)
        entry.update({'raw_file': attempt['raw_file'], 'raw_sha256': attempt['raw_sha256'], 'status': 'downloading'})
        raw_ref = attempt['raw_file']
        metadata_path = note_dir(self.root, item['note_id']) / '元数据.json'
        if not entry['media'] and metadata_path.exists():
            existing = read_json(metadata_path)
            if any(source.get('provider') == 'galaxy' and source.get('path') == raw_ref for source in existing.get('sources', [])):
                entry['media'] = {m['id']: m for m in existing['media'] if m.get('status') == 'available'}
        for job in jobs:
            prior = entry['media'].get(job['id'])
            if prior is not None:
                prior.update(job_metadata(job))
            if existing_media(self.root, item['note_id'], prior):
                continue
            if prior and not retry_failed and sample_root is None:
                continue
            try:
                self.check_running()
                if sample_root is not None:
                    legacy_name = 'video' if job['kind'] == 'video' else job['id']
                    old = (sample_media or {}).get(legacy_name)
                    if old and old.get('status') == 'verified' and old.get('full_decode_exit_code') == 0:
                        path = local_path(sample_root, old['file'])
                        if path.stat().st_size != old['bytes']:
                            raise ValueError('Sample media length changed')
                        verification = {'method': 'ffprobe_and_ffmpeg', 'full_decode': 'passed',
                                        'full_decode_exit_code': 0, 'probe': old['metadata']}
                        result = install_media(self.root, item['note_id'], path, job['kind'], job['ordinal'],
                                               expected_sha256=old['sha256'], verification=verification, source_ref=raw_ref)
                    else:
                        result = {'id': job['id'], 'kind': job['kind'], 'status': 'missing', 'reason': 'sample_media_unavailable', 'source_ref': raw_ref}
                else:
                    result = transfer(self.root, item['note_id'], job, raw_ref, before_request=self.check_running)
            except BatchStop as error:
                self.stop_batch(str(error))
                entry['status'] = 'paused'; self.store_entry(item['note_id'], entry)
                partial = [entry['media'].get(j['id'], {'id': j['id'], 'kind': j['kind'], 'status': 'pending',
                           **job_metadata(j)}) for j in jobs]
                self.publish(item, note, attempt, partial + gaps)
                raise
            result.update(job_metadata(job))
            entry['media'][job['id']] = result
            self.store_entry(item['note_id'], entry)
        media = [entry['media'][j['id']] for j in jobs] + gaps
        entry.update({'status': 'complete' if media and all(m['status'] == 'available' for m in media) else 'partial',
                      'gaps': gaps, 'updated_at': now()})
        self.store_entry(item['note_id'], entry)
        self.publish(item, note, attempt, media)
        return entry['status'], sum(m['status'] == 'available' for m in media), len(media)

    def import_sample(self, sample_root):
        sample_root = Path(sample_root).resolve()
        legacy = read_json(sample_root / 'api-ledger.json')
        download_index = read_json(sample_root / 'download-index.json')
        for old in legacy['attempts']:
            if old['note_id'] not in self.plan or old.get('status') != 'detail_verified':
                continue
            item = self.plan[old['note_id']]
            path = local_path(sample_root, old['raw_file'])
            if digest(path) != old['raw_sha256']:
                raise ValueError('Sample raw response changed')
            note = select_note(read_json(path), item['type'], item['note_id'])
            if note is None:
                raise ValueError('Sample response does not match the plan')
            try:
                source = relative_source(self.root, path)
            except ValueError:
                target = self.raw_dir / (item['note_id'] + '-sample.json')
                copy_preserving(path, target, old['raw_sha256']); source = relative_source(self.root, target)
            existing = self.cached(item)
            if existing:
                note, attempt = existing
            else:
                with self.lock:
                    attempt = {'attempt_id': len(self.ledger['attempts']) + 1, 'note_id': item['note_id'], 'type': item['type'],
                               'status': 'detail_verified', 'origin': 'imported_sample', 'http_status': old['http_status'],
                               'billing_status': 'successful_detail', 'quoted_cost_cny': old.get('expected_cost_cny'),
                               'raw_file': source, 'raw_sha256': old['raw_sha256'], 'started_at': old.get('started_at'),
                               'finished_at': old.get('finished_at'), 'detail_response_balance_raw': old.get('provider_balance_cny')}
                    self.ledger['attempts'].append(attempt); self.save_ledger()
            status, available, total = self.process_media(item, note, attempt, sample_root=sample_root,
                                                         sample_media=download_index['posts'][item['note_id']]['media'])
            self.progress('sample_imported', note_id=item['note_id'], type=item['type'], status=status, available_media=available, media_count=total)
        with self.lock:
            for observation in legacy.get('balance_observations', []):
                imported = {'source': 'get_balance', 'origin': 'imported_sample', 'checked_at': observation['checked_at'],
                            'http_status': observation['http_status'], 'balance_raw': observation['balance_cny']}
                if imported not in self.ledger['balance_observations']:
                    self.ledger['balance_observations'].append(imported)
            self.save_ledger()

    def run_one(self, number, item, retry_media):
        try:
            self.check_running()
            check_space(self.root)
            if retry_media:
                cached = self.cached(item)
                if not cached:
                    return
                note, attempt = cached; requested = False
            else:
                note, attempt, requested = self.fetch(item)
            if note is None:
                recorded = self.record_failure(item, attempt)
                status = attempt['status'] if attempt else 'skipped_previous_attempt'
                if recorded in ('written', 'reused'):
                    status = 'detail_unavailable'
                self.progress('post_finished', position=number, total=len(self.plan), note_id=item['note_id'], type=item['type'], status=status)
            else:
                status, available, total = self.process_media(item, note, attempt, retry_failed=retry_media)
                self.progress('post_finished', position=number, total=len(self.plan), note_id=item['note_id'], type=item['type'],
                              status=status, available_media=available, media_count=total, reused_detail=not requested)
        except BatchStop as error:
            self.stop_batch(str(error))
            raise
        except Exception as error:
            if isinstance(error, OSError) and error.errno == errno.ENOSPC:
                self.stop_batch('disk_reserve_reached')
                raise BatchStop('disk_reserve_reached') from None
            entry = self.entry(item)
            entry.update({'status': 'local_error', 'error_type': type(error).__name__, 'updated_at': now()})
            self.store_entry(item['note_id'], entry)
            self.progress('post_finished', position=number, total=len(self.plan), note_id=item['note_id'], type=item['type'],
                          status='local_error', error_type=type(error).__name__)

    def run(self, *, retry_media=False, limit=None):
        if limit is not None and limit < 1:
            raise ValueError('limit must be positive')
        with self.lock:
            self.requested_ids.clear()
        if not retry_media:
            self.observe_balance()
        items = iter(enumerate(self.plan.values(), 1))
        pending, reserved_new = {}, set()
        held, exhausted, dispatched = None, False, False
        try:
            # Submit at most workers whole-post tasks. No unbounded executor queue is built.
            with concurrent.futures.ThreadPoolExecutor(max_workers=self.workers, thread_name_prefix='galaxy-post') as pool:
                try:
                    while pending or not exhausted:
                        while len(pending) < self.workers and not self.stop_event.is_set() and not exhausted:
                            try:
                                number, item = held if held is not None else next(items)
                                held = None
                            except StopIteration:
                                exhausted = True
                                break
                            wants_new = not retry_media and self.would_request(item)
                            if wants_new and limit is not None:
                                with self.lock:
                                    requested = set(self.requested_ids)
                                if len(requested) >= limit:
                                    continue  # Other cached posts remain eligible and do not consume the limit.
                                if len(requested | reserved_new) >= limit:
                                    held = (number, item)
                                    break
                            if dispatched and self.delay and self.stop_event.wait(self.delay):
                                break
                            with self.lock:
                                if self.stop_event.is_set():
                                    break
                                if wants_new:
                                    reserved_new.add(item['note_id'])
                                future = pool.submit(self.run_one, number, item, retry_media)
                                pending[future] = item['note_id']
                                dispatched = True
                        if not pending:
                            if exhausted or self.stop_event.is_set():
                                break
                            continue
                        done, _ = concurrent.futures.wait(pending, return_when=concurrent.futures.FIRST_COMPLETED)
                        for future in done:
                            reserved_new.discard(pending.pop(future))
                            try:
                                future.result()
                            except BatchStop as error:
                                self.stop_batch(str(error))
                except BaseException:
                    self.stop_batch('interrupted_or_worker_failure')
                    raise
                # The executor context drains only the <= workers admitted tasks. Each worker
                # saves in-flight responses/files, and checks the stop event before more network work.
        finally:
            self.save_ledger()
        if self.stop_event.is_set():
            raise BatchStop(self.stop_reason or 'batch_stopped')
        if not retry_media:
            self.observe_balance()
        with self.lock:
            return {'new_detail_posts': len(self.requested_ids), 'planned_posts': len(self.plan), 'workers': self.workers}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=('import-sample', 'download', 'retry-media', 'record-failures'))
    parser.add_argument('--root', type=Path, default=DEFAULT_ROOT)
    parser.add_argument('--plan', required=True, type=Path)
    parser.add_argument('--sample-root', type=Path)
    parser.add_argument('--batch-dir', required=True, type=Path)
    parser.add_argument('--limit', type=int, help='Maximum new detail posts this invocation; no monetary cap')
    parser.add_argument('--delay', type=float, default=1, help='Seconds between scheduling posts')
    parser.add_argument('--workers', type=int, choices=(1, 2, 3), default=1, help='Concurrent whole-post tasks (default: 1)')
    args = parser.parse_args()
    if (args.limit is not None and args.limit < 1) or args.delay < 0:
        parser.error('limit must be positive and delay nonnegative')
    if args.command == 'import-sample' and args.sample_root is None:
        parser.error('import-sample requires --sample-root')
    os.umask(0o077)
    args.root.mkdir(parents=True, exist_ok=True, mode=0o700)
    with process_lock(args.root):
        client = APIClient(getpass.getpass('Galaxy API Key (hidden, process memory only): ').strip()) if args.command == 'download' else None
        runner = Runner(args.root, args.plan, args.batch_dir, client=client, delay=args.delay, workers=args.workers)
        if args.command == 'import-sample':
            runner.import_sample(args.sample_root)
        elif args.command == 'record-failures':
            emit('failures_recorded', **runner.record_failures())
        else:
            result = runner.run(retry_media=args.command == 'retry-media', limit=args.limit)
            emit('finished', **result)


if __name__ == '__main__':
    try:
        main()
    except BatchStop as error:
        emit('stopped', reason=str(error))
        raise SystemExit(2)
    except Exception as error:
        emit('stopped', error_type=type(error).__name__)
        raise SystemExit(1)
