"""Offline subtitle jobs and strict UTF-8 SubRip verification.

The caller owns CDN validation, transfer, length/SHA receipts, and persistence.
This module neither requests URLs nor returns subtitle text in its receipts.
"""
import hashlib
import re
from pathlib import Path


_LABEL = re.compile(r'[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)*\Z')
_INDEX = re.compile(r'[0-9]+\Z')
_TIME = r'([0-9]{2,}):([0-5][0-9]):([0-5][0-9]),([0-9]{3})'
_TIMING = re.compile(_TIME + r'[ \t]+-->[ \t]+' + _TIME + r'\Z')
_BOM = b'\xef\xbb\xbf'


def _valid_label(value):
    return isinstance(value, str) and len(value) <= 64 and _LABEL.fullmatch(value) is not None


def _gap(identifier, reason, **metadata):
    return {'id': identifier, 'kind': 'subtitle', 'status': 'missing', 'reason': reason, **metadata}


def media_jobs(note):
    """Return (jobs, gaps) for video_info_v2.media.video.subtitles.

    IDs use validated entry labels and one-based positions. Exact URL strings
    alone may merge: source wins the primary ID/metadata, languages records the
    actual language tags, and subtitle_labels records all contributing keys.
    subtitle_role is the preferred key; provider type/format stay uninterpreted.
    """
    subtitles = note
    for key in ('video_info_v2', 'media', 'video', 'subtitles'):
        if not isinstance(subtitles, dict) or key not in subtitles:
            return [], []
        subtitles = subtitles[key]
    if subtitles is None:
        return [], []
    if not isinstance(subtitles, dict):
        return [], [_gap('subtitle-list', 'invalid_subtitle_list')]
    jobs, gaps, by_url, used_ids = [], [], {}, set()
    labels = []
    for position, label in enumerate(subtitles, 1):
        if not _valid_label(label):
            gaps.append(_gap(f'subtitle-invalid-label-{position:03d}', 'invalid_subtitle_label'))
        else:
            labels.append(label)
    for label in sorted(labels, key=lambda value: (value != 'source', value)):
        entries = subtitles[label]
        if not isinstance(entries, list):
            gaps.append(_gap(f'subtitle-{label}-list', 'invalid_subtitle_entries', subtitle_role=label))
            continue
        for ordinal, entry in enumerate(entries, 1):
            identifier = f'subtitle-{label}-{ordinal:03d}'
            if identifier.casefold() in used_ids:
                identifier += '-' + hashlib.sha256(label.encode('utf-8')).hexdigest()[:8]
            used_ids.add(identifier.casefold())
            if not isinstance(entry, dict):
                gaps.append(_gap(identifier, 'invalid_subtitle_entry', subtitle_role=label))
                continue
            language = entry.get('language')
            if language is not None and not _valid_label(language):
                gaps.append(_gap(identifier, 'invalid_subtitle_language', subtitle_role=label))
                continue
            metadata = {'language': language, 'languages': [language] if language is not None else [],
                        'subtitle_labels': [label], 'subtitle_role': label,
                        'provider_subtitle_type': entry.get('type'),
                        'provider_subtitle_format': entry.get('format')}
            url = entry.get('url')
            if not isinstance(url, str) or not url or url != url.strip():
                gaps.append(_gap(identifier, 'missing_subtitle_url', **metadata))
                continue
            if url in by_url:
                job = by_url[url]
                if language is not None and language not in job['languages']:
                    job['languages'].append(language)
                if label not in job['subtitle_labels']:
                    job['subtitle_labels'].append(label)
                continue
            job = {'id': identifier, 'kind': 'subtitle', 'ordinal': ordinal, 'urls': [url], **metadata}
            by_url[url] = job
            jobs.append(job)
    return jobs, gaps


def _timestamps(line):
    match = _TIMING.fullmatch(line.strip())
    if match is None:
        raise ValueError('Invalid SRT timestamp line')
    numbers = [int(value) for value in match.groups()]
    def milliseconds(parts):
        hours, minutes, seconds, millis = parts
        return ((hours * 60 + minutes) * 60 + seconds) * 1000 + millis
    start, end = milliseconds(numbers[:4]), milliseconds(numbers[4:])
    if end <= start:
        raise ValueError('SRT cue must end after its start')
    return start, end


def extension(prefix):
    """Recognize an SRT candidate from its ASCII header, even with a cut UTF-8 cue."""
    if not isinstance(prefix, (bytes, bytearray)):
        raise ValueError('Subtitle prefix must be bytes')
    prefix = bytes(prefix)
    if prefix.startswith(_BOM):
        prefix = prefix[len(_BOM):]
    lines = prefix.replace(b'\r\n', b'\n').replace(b'\r', b'\n').lstrip(b' \t\n').split(b'\n', 2)
    try:
        if len(lines) < 2 or _INDEX.fullmatch(lines[0].decode('ascii').strip()) is None or int(lines[0]) < 1:
            raise ValueError('Missing SRT index header')
        _timestamps(lines[1].decode('ascii'))
    except UnicodeError:
        raise ValueError('Invalid SRT header encoding') from None
    return '.srt'


def verify(path):
    """Read a complete UTF-8/BOM SRT; require consecutive indexes and nonempty cues.

    Cue ranges must be valid and have positive duration. Overlapping cues are
    allowed. The receipt contains timing/count metadata, never the cue text.
    """
    raw = Path(path).read_bytes()
    try:
        text = raw.decode('utf-8-sig')
    except UnicodeError:
        raise ValueError('Subtitle is not valid UTF-8') from None
    if '\x00' in text or '\ufeff' in text:
        raise ValueError('Unexpected SRT control character')
    lines = text.replace('\r\n', '\n').replace('\r', '\n').split('\n')
    position, count, starts, ends = 0, 0, [], []
    while position < len(lines):
        if not lines[position].strip():
            position += 1
            continue
        index = lines[position].strip()
        if _INDEX.fullmatch(index) is None or int(index) != count + 1:
            raise ValueError('SRT indexes must be consecutive from one')
        position += 1
        if position >= len(lines):
            raise ValueError('Missing SRT timestamp line')
        start, end = _timestamps(lines[position])
        position += 1
        cue_lines = []
        while position < len(lines) and lines[position].strip():
            if _TIMING.fullmatch(lines[position].strip()):
                raise ValueError('Missing SRT cue separator')
            cue_lines.append(lines[position])
            position += 1
        if not cue_lines:
            raise ValueError('SRT cue text is empty')
        count += 1
        starts.append(start); ends.append(end)
    if not count:
        raise ValueError('SRT has no cues')
    return {'method': 'utf8_srt_strict', 'format': 'srt', 'encoding': 'utf-8',
            'utf8_bom': raw.startswith(_BOM), 'full_parse': 'passed', 'cue_count': count,
            'start_ms': min(starts), 'end_ms': max(ends), 'bytes': len(raw)}
