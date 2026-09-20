#!/usr/bin/env python3
"""Shared local note-library writer. Source archives are never modified."""
import argparse
import csv
import ctypes
import hashlib
import io
import json
import os
import re
import shutil
import tempfile
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote, urlsplit, parse_qs, urlencode

DEFAULT_ROOT = Path(__file__).resolve().parents[2] / '资料库'
SCHEMA = 'rednote-library-note-v1'


def now():
    return datetime.now(timezone.utc).isoformat()


def digest(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()


def atomic_text(path, text):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, temporary = tempfile.mkstemp(prefix='.' + path.name + '.', suffix='.tmp', dir=path.parent)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as stream:
            stream.write(text)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, 0o600)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def save_json(path, value):
    atomic_text(path, json.dumps(value, ensure_ascii=False, indent=2) + '\n')


def read_jsonl(path):
    # Text-file iteration uses LF/CRLF records; str.splitlines also splits valid
    # JSON string characters such as U+0085, U+2028, and U+2029.
    with Path(path).open(encoding='utf-8') as stream:
        return [json.loads(line) for line in stream if line.strip()]


def note_dir(root, note_id):
    if not re.fullmatch(r'[0-9a-f]{24}', note_id):
        raise ValueError('Invalid note ID')
    return Path(root) / '笔记' / note_id


def relative_source(root, path):
    return str(Path(path).resolve().relative_to(Path(root).resolve()))


def copy_preserving(source, destination, expected_sha256=None):
    """Use APFS copy-on-write clones; never writable hard links."""
    source, destination = Path(source), Path(destination)
    if source.is_symlink() or not source.is_file():
        raise ValueError('Source must be a regular file')
    size = source.stat().st_size
    sha = digest(source)
    if expected_sha256 is not None and sha != expected_sha256:
        raise ValueError('Source checksum mismatch')
    destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    if destination.exists():
        if destination.stat().st_size != size or digest(destination) != sha:
            raise ValueError('Refusing to overwrite different content')
        return {'bytes': size, 'sha256': sha, 'copy_mode': 'reused'}
    temporary = destination.with_name('.' + destination.name + '.copy-' + str(os.getpid()))
    if temporary.exists():
        raise ValueError('Unfinished local copy requires inspection')
    method = 'copy'
    try:
        if os.uname().sysname == 'Darwin':
            lib = ctypes.CDLL('/usr/lib/libSystem.B.dylib', use_errno=True)
            lib.clonefile.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_int]
            lib.clonefile.restype = ctypes.c_int
            if lib.clonefile(os.fsencode(source), os.fsencode(temporary), 0) == 0:
                method = 'apfs_clone'
        if not temporary.exists():
            if shutil.disk_usage(destination.parent).free < size + 2 * 1024 ** 3:
                raise OSError('Insufficient disk reserve for a copy')
            shutil.copyfile(source, temporary)
        if temporary.stat().st_size != size or digest(temporary) != sha:
            raise ValueError('Copied file checksum mismatch')
        os.chmod(temporary, 0o600)
        os.rename(temporary, destination)
    finally:
        if temporary.exists():
            temporary.unlink()
    return {'bytes': size, 'sha256': sha, 'copy_mode': method}


def install_media(root, note_id, source, kind, ordinal, *, expected_sha256=None, verification=None, source_ref=None):
    """Install local bytes and return a common media entry (paths relative to note)."""
    if kind not in ('image', 'video', 'audio', 'subtitle', 'attachment'):
        raise ValueError('Unexpected media kind')
    source = Path(source)
    sha = expected_sha256 or digest(source)
    suffix = source.suffix.lower()
    if not re.fullmatch(r'\.[a-z0-9]{1,8}', suffix):
        suffix = '.bin'
    filename = f'{kind}-{int(ordinal):03d}-{sha[:12]}{suffix}'
    target = note_dir(root, note_id) / 'media' / filename
    receipt = copy_preserving(source, target, sha)
    return {'id': f'{kind}-{int(ordinal):03d}', 'kind': kind, 'path': 'media/' + filename,
            'status': 'available', 'bytes': receipt['bytes'], 'sha256': receipt['sha256'],
            'verification': verification or {'method': 'source_and_copy_sha256', 'full_decode': 'not_performed'},
            'source_ref': source_ref, 'storage': receipt['copy_mode']}


def validate_note(record):
    if record.get('schema_version') != SCHEMA:
        raise ValueError('Wrong note schema version')
    note_dir('.', record['note_id'])
    for key in ('title', 'body_text', 'body_markdown', 'type', 'source_url'):
        if not isinstance(record.get(key), str):
            raise ValueError('Missing or invalid text field: ' + key)
    for key in ('media', 'sources', 'relations'):
        if not isinstance(record.get(key), list):
            raise ValueError('Missing list field: ' + key)
    if record['type'] not in ('normal', 'video', 'unknown'):
        raise ValueError('Invalid note type')
    if record.get('author') is not None and not isinstance(record['author'], dict):
        raise ValueError('Author must be an object or null')
    if record.get('content_status') == 'detail_unavailable':
        if record['body_text'] or record['body_markdown'] or record['media'] or record.get('media_status') != 'not_fetched':
            raise ValueError('Unavailable details must not declare body or media content')
        error = record.get('acquisition_error')
        if (not isinstance(error, dict) or error.get('status') != 'detail_unavailable'
                or not isinstance(error.get('reason'), str) or not error['reason']
                or not isinstance(error.get('source_ref'), str)
                or not isinstance(error.get('source_sha256'), str)
                or not re.fullmatch('[0-9a-f]{64}', error['source_sha256'])):
            raise ValueError('Unavailable details require acquisition evidence')
        if error.get('http_code') is not None and type(error['http_code']) is not int:
            raise ValueError('Invalid acquisition HTTP code')
    for relation in record['relations']:
        if (not isinstance(relation, dict) or relation.get('kind') not in ('liked', 'collected', 'unknown')
                or not isinstance(relation.get('value'), bool) or not isinstance(relation.get('provider'), str)):
            raise ValueError('Invalid relationship evidence')
    for item in record['media']:
        if item.get('status') == 'available':
            p = Path(item['path'])
            if p.is_absolute() or '..' in p.parts or not p.parts or p.parts[0] != 'media':
                raise ValueError('Media path escapes the note')
            if not re.fullmatch('[0-9a-f]{64}', item['sha256']) or item['bytes'] <= 0:
                raise ValueError('Missing media receipt')


def enrich_record(record, url_candidates=(), author_candidates=()):
    """Normalize private reading links and authors without inventing access data.

    Candidate URLs may be strings or {url, source_ref}; supplied candidates win
    ties, while a previously complete link is never replaced by an incomplete one.
    Parameter completeness is not a live availability check.
    """
    record = dict(record)
    candidates = list(url_candidates) + record.get('source_url_candidates', [])
    candidates.append({'url': record.get('source_url', ''),
                       'source_ref': record.get('source_url_source_ref', 'existing_metadata')})
    for variant in record.get('variants', []):
        props = variant.get('source_properties', {})
        candidates.append({'url': props.get('Url', ''), 'source_ref': variant.get('source', {}).get('path')})
    valid = []
    for candidate in candidates:
        item = {'url': candidate} if isinstance(candidate, str) else dict(candidate)
        url = item.get('url')
        if not isinstance(url, str) or any(c in url for c in '\r\n<>'):
            continue
        try:
            parsed = urlsplit(url)
            if (parsed.scheme != 'https' or parsed.hostname not in ('www.xiaohongshu.com', 'xiaohongshu.com')
                    or parsed.username or parsed.password or parsed.port not in (None, 443)
                    or parsed.path.rstrip('/') not in ('/explore/' + record['note_id'],
                                                        '/discovery/item/' + record['note_id'])):
                continue
            query = parse_qs(parsed.query)
        except ValueError:
            continue
        token = any(v.strip() and not any(marker in v.lower() for marker in ('redacted', 'removed', 'scrubbed'))
                    for v in query.get('xsec_token', []))
        source = any(v.strip() for v in query.get('xsec_source', []))
        item['status'] = ('complete_parameters' if token and source else
                          'partial_access_parameters' if token else 'missing_access_parameters')
        if not any(x['url'] == url for x in valid):
            valid.append(item)
    rank = {'complete_parameters': 2, 'partial_access_parameters': 1, 'missing_access_parameters': 0}
    if valid:
        chosen = max(valid, key=lambda x: (bool(x.get('method') == 'user_export_id_token' and x['status'] != 'missing_access_parameters'), rank[x['status']]))
        record['source_url'] = chosen['url']
        record['source_url_status'] = ('user_export_token' if chosen.get('method') == 'user_export_id_token' and chosen['status'] != 'missing_access_parameters' else chosen['status'])
        record['source_url_source_ref'] = chosen.get('source_ref')
    else:
        record['source_url'] = 'https://www.xiaohongshu.com/explore/' + record['note_id']
        record['source_url_status'] = 'missing_access_parameters'
        record['source_url_source_ref'] = None
    record['source_url_candidates'] = valid
    record['source_url_availability'] = 'not_checked'
    author = dict(record.get('author') or {})
    fallbacks = list(author_candidates) + [v.get('source_properties', {}).get('作者') for v in record.get('variants', [])]
    for fallback in fallbacks:
        if isinstance(fallback, str):
            fallback = {'name': fallback}
        if not isinstance(fallback, dict):
            continue
        # Do not attach an ID from a different named author to an existing name.
        if author.get('name') and fallback.get('name') and author['name'] != fallback['name']:
            continue
        for key in ('name', 'id', 'profile_url'):
            if not author.get(key) and fallback.get(key):
                author[key] = fallback[key]
    record['author'] = author or None
    return record


def _markdown_text(value):
    return re.sub(r'([\\`*_{}\[\]<>])', r'\\\1', str(value).replace('\n', ' ').replace('\r', ' '))


def render_note(record, *, legacy=False):
    title = record['title'].replace('\n', ' ').strip() or record['note_id']
    body = record['body_markdown'] or record['body_text']
    empty_message = ('未取得正文，详情见元数据中的下载状态'
                     if record.get('content_status') == 'detail_unavailable' else '（来源中没有正文）')
    author = record.get('author') or {}
    author_line = '作者：' + _markdown_text(author.get('name') or '作者未知')
    if author.get('id'):
        author_line += '（ID：' + _markdown_text(author['id']) + '）'
    link_line = ('[原帖](<' + record['source_url'] + '>)'
                 if record.get('source_url_status') in ('complete_parameters', 'user_export_token')
                 else '完整链接缺失（访问参数不齐全）')
    lines = ['# ' + title, '', author_line, '', '帖子 ID：`' + record['note_id'] + '`', '',
             link_line, '', body or empty_message, '']
    if legacy:
        lines = ['# ' + title, '', '帖子 ID：`' + record['note_id'] + '`', '',
                 '[原帖](' + record['source_url'] + ')', '', body or empty_message, '']
    media_lines = []
    for item in record['media']:
        if item.get('status') != 'available':
            media_lines.append(f'- {item.get("id", "媒体")}：{item.get("status", "missing")}')
            continue
        url = quote(item['path'], safe='/.-_')
        if item['path'] in body or url in body:
            continue
        if item['kind'] == 'image':
            media_lines.extend(['![' + item['id'] + '](' + url + ')', ''])
        else:
            media_lines.extend(['[' + item['id'] + '](' + url + ')', ''])
    if media_lines:
        lines.extend(['## 本地媒体', ''] + media_lines)
    return '\n'.join(lines).rstrip() + '\n'


def put_note(root, record):
    """Save one normalized note; retain prior text/metadata if its content changes."""
    record = dict(record)
    record.setdefault('schema_version', SCHEMA)
    record.setdefault('source_url', 'https://www.xiaohongshu.com/explore/' + record['note_id'])
    record.setdefault('body_markdown', record.get('body_text', ''))
    record.setdefault('relations', [])
    record.setdefault('sources', [])
    record.setdefault('media', [])
    record.setdefault('author', None)
    registry = Path(root) / '导出记录/用户导出链接.json'
    preferred = json.loads(registry.read_text()).get(record['note_id']) if registry.is_file() else None
    record = enrich_record(record, [preferred] if preferred else [])
    record['content_status'] = record.get('content_status') or ('available' if record['body_text'] or record['body_markdown'] else 'empty_in_source')
    record['media_status'] = ('not_fetched' if record['content_status'] == 'detail_unavailable' else
                              'none_in_source' if not record['media'] else
                              'complete' if all(m.get('status') == 'available' for m in record['media']) else 'partial')
    validate_note(record)
    folder = note_dir(root, record['note_id'])
    folder.mkdir(parents=True, exist_ok=True, mode=0o700)
    metadata, markdown = folder / '元数据.json', folder / '正文.md'
    if metadata.exists():
        old = json.loads(metadata.read_text())
        previous_urls = old.get('source_url_candidates', []) or [{'url': old.get('source_url', ''),
                                                               'source_ref': old.get('source_url_source_ref', 'previous_metadata')}]
        record = enrich_record(record, list(record.get('source_url_candidates', [])) + previous_urls, [old.get('author')])
        validate_note(record)
        if record['content_status'] == 'detail_unavailable' and (
                old.get('content_status') in ('available', 'empty_in_source')
                or old.get('body_text') or old.get('body_markdown')
                or any(m.get('status') == 'available' for m in old.get('media', []))):
            return 'preserved'
        # Volatile timestamps and clone/reuse bookkeeping do not make new revisions.
        def stable(value):
            value = json.loads(json.dumps(value))
            value.pop('imported_at', None)
            for media in value.get('media', []):
                media.pop('storage', None)
            return value
        if stable(old) == stable(record):
            expected_view = render_note(old)
            if not markdown.exists() or markdown.read_text() != expected_view:
                if markdown.exists():
                    recovery = folder / '历史版本' / ('unmatched-view-' + digest(markdown)[:16])
                    copy_preserving(markdown, recovery / '正文原件.md')
                atomic_text(markdown, expected_view)
            return 'reused'
        revision = folder / '历史版本' / digest(metadata)[:16]
        copy_preserving(metadata, revision / '元数据.json')
        old_view = render_note(old, legacy='source_url_status' not in old)
        prior_text = old_view.replace('](media/', '](../../media/')
        prior_view = revision / '正文.md'
        if prior_view.exists() and prior_view.read_text() != prior_text:
            raise ValueError('Existing historical view differs from its metadata')
        if not prior_view.exists():
            atomic_text(revision / '正文.md', prior_text)
        if markdown.exists() and markdown.read_text() != old_view:
            recovery = folder / '历史版本' / ('unmatched-view-' + digest(markdown)[:16])
            copy_preserving(markdown, recovery / '正文原件.md')
    record['imported_at'] = record.get('imported_at') or now()
    atomic_text(markdown, render_note(record))
    save_json(metadata, record)
    return 'written'


def build_index(root):
    root = Path(root)
    rows, counts = [], Counter()
    jsonl = []
    for p in sorted((root / '笔记').glob('*/元数据.json')):
        n = json.loads(p.read_text()); validate_note(n)
        counts[n['type']] += 1
        row = {'note_id': n['note_id'], 'title': n['title'], 'type': n['type'],
               'content_status': n['content_status'], 'media_status': n['media_status'],
               'media_count': len(n['media']), 'available_media': sum(m.get('status') == 'available' for m in n['media']),
               'providers': ','.join(sorted({s['provider'] for s in n['sources']})),
               'path': str(p.parent.relative_to(root)), 'source_url': n['source_url']}
        rows.append(row)
        jsonl.append(json.dumps(n, ensure_ascii=False))
    buffer = io.StringIO()
    fields = ['note_id', 'title', 'type', 'content_status', 'media_status', 'media_count', 'available_media', 'providers', 'path', 'source_url']
    writer = csv.DictWriter(buffer, fields); writer.writeheader()
    for row in rows:
        safe = {k: ("'" + v if isinstance(v, str) and v.lstrip().startswith(('=', '+', '-', '@')) else v) for k, v in row.items()}
        writer.writerow(safe)
    atomic_text(root / '索引' / '笔记清单.csv', '\ufeff' + buffer.getvalue())
    atomic_text(root / '索引' / '笔记.jsonl', '\n'.join(jsonl) + ('\n' if jsonl else ''))
    save_json(root / '索引' / '统计.json', {'generated_at': now(), 'posts': len(rows), 'types': dict(counts),
              'available_media': sum(r['available_media'] for r in rows),
              'posts_with_media_gaps': sum(r['media_status'] == 'partial' for r in rows)})
    return {'posts': len(rows), 'types': dict(counts)}


def verify_library(root):
    root = Path(root)
    problems, totals = [], Counter()
    records = {}
    for p in sorted((root / '笔记').glob('*/元数据.json')):
        n = json.loads(p.read_text()); validate_note(n); totals['posts'] += 1
        if p.parent.name != n['note_id'] or n['note_id'] in records:
            problems.append({'note_id': n['note_id'], 'issue': 'metadata_identity_mismatch'})
        records[n['note_id']] = n
        if not (p.parent / '正文.md').is_file():
            problems.append({'note_id': n['note_id'], 'issue': 'missing_markdown'})
        elif (p.parent / '正文.md').read_text() != render_note(n):
            problems.append({'note_id': n['note_id'], 'issue': 'markdown_view_mismatch'})
        for m in n['media']:
            if m.get('status') != 'available':
                totals['declared_media_gaps'] += 1; continue
            f = p.parent / m['path']
            if not f.is_file() or f.stat().st_size != m['bytes'] or digest(f) != m['sha256']:
                problems.append({'note_id': n['note_id'], 'issue': 'media_receipt_mismatch', 'path': m['path']})
            totals[m['kind'] + '_files'] += 1
            totals['media_bytes'] += m['bytes']
    try:
        index_rows = read_jsonl(root / '索引/笔记.jsonl')
        if len(index_rows) != len(records) or {n['note_id']: n for n in index_rows} != records:
            problems.append({'issue': 'jsonl_index_mismatch'})
        with (root / '索引/笔记清单.csv').open(encoding='utf-8-sig', newline='') as stream:
            csv_rows = list(csv.DictReader(stream))
        if len(csv_rows) != len(records) or {r['note_id'] for r in csv_rows} != set(records):
            problems.append({'issue': 'csv_index_identity_mismatch'})
        else:
            for row in csv_rows:
                n = records[row['note_id']]
                title = n['title']
                if title.lstrip().startswith(('=', '+', '-', '@')):
                    title = "'" + title
                expected = {'title': title, 'type': n['type'], 'content_status': n['content_status'],
                            'media_status': n['media_status'], 'media_count': str(len(n['media'])),
                            'available_media': str(sum(m.get('status') == 'available' for m in n['media'])),
                            'providers': ','.join(sorted({s['provider'] for s in n['sources']})),
                            'path': '笔记/' + n['note_id'], 'source_url': n['source_url']}
                if any(row.get(k) != value for k, value in expected.items()):
                    problems.append({'note_id': n['note_id'], 'issue': 'csv_index_content_mismatch'})
        stats = json.loads((root / '索引/统计.json').read_text())
        expected_stats = {'posts': len(records), 'types': dict(Counter(n['type'] for n in records.values())),
                          'available_media': sum(m.get('status') == 'available' for n in records.values() for m in n['media']),
                          'posts_with_media_gaps': sum(n['media_status'] == 'partial' for n in records.values())}
        if any(stats.get(k) != value for k, value in expected_stats.items()):
            problems.append({'issue': 'statistics_index_mismatch'})
    except (OSError, ValueError, KeyError, TypeError):
        problems.append({'issue': 'index_missing_or_invalid'})
    result = {'verified_at': now(), 'status': 'passed' if not problems else 'failed', 'counts': dict(totals), 'problems': problems}
    save_json(root / '导出记录' / '本地校验.json', result)
    return result


def apply_export_links(root, source):
    """Register user's exported post tokens, update existing notes, never create posts."""
    root, source = Path(root), Path(source)
    payload = json.loads(source.read_text(encoding='utf-8'))
    notes = payload if isinstance(payload, list) else payload['notes']
    updates = {}
    for row in notes:
        note_id, token = row.get('note_id', ''), row.get('xsec_token')
        if not isinstance(note_id, str) or not re.fullmatch('[0-9a-f]{24}', note_id):
            raise ValueError('Invalid exported note ID')
        if not isinstance(token, str) or not token.strip():
            continue
        candidate = {'url': 'https://www.xiaohongshu.com/explore/' + note_id + '?' + urlencode({'xsec_token': token}),
                     'method': 'user_export_id_token'}
        if note_id in updates and updates[note_id] != candidate:
            raise ValueError('Conflicting exported tokens')
        updates[note_id] = candidate
    snapshot = root / '原始来源/用户JSON' / (digest(source) + '.json')
    copy_preserving(source, snapshot)
    for candidate in updates.values():
        candidate['source_ref'] = relative_source(root, snapshot)
    registry = root / '导出记录/用户导出链接.json'
    values = json.loads(registry.read_text()) if registry.is_file() else {}
    values.update(updates)
    save_json(registry, values)
    changed = Counter()
    for note_id in updates:
        path = root / '笔记' / note_id / '元数据.json'
        if path.is_file():
            changed[put_note(root, json.loads(path.read_text()))] += 1
        else:
            changed['not_in_library'] += 1
    build_index(root)
    result = {'updated_at': now(), 'eligible': len(updates), 'results': dict(changed),
              'source_ref': relative_source(root, snapshot), 'method': 'user_export_id_token',
              'availability': 'One sample confirmed by user; bulk links not checked online.'}
    save_json(root / '导出记录/用户JSON链接更新.json', result)
    return result


if __name__ == '__main__':
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['index', 'verify', 'apply-export-links'])
    parser.add_argument('--root', type=Path, default=DEFAULT_ROOT)
    parser.add_argument('--source', type=Path)
    args = parser.parse_args()
    if args.command == 'apply-export-links' and args.source is None:
        parser.error('--source is required')
    result = (apply_export_links(args.root, args.source) if args.command == 'apply-export-links' else
              build_index(args.root) if args.command == 'index' else verify_library(args.root))
    print(json.dumps(result, ensure_ascii=False))
    if result.get('status') == 'failed':
        raise SystemExit(1)
