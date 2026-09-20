#!/usr/bin/env python3
"""Reconcile a local export without requests, media rehashing, or source changes."""
import argparse
import collections
import json
import re
from decimal import Decimal, InvalidOperation
from pathlib import Path

import library


ID = re.compile(r'[0-9a-f]{24}')
CATEGORIES = ('image', 'video', 'live_photo_motion', 'audio', 'subtitle', 'other')


def read_json(path):
    return json.loads(Path(path).read_text(encoding='utf-8'))


def load_plan(path):
    raw = read_json(path)
    entries = raw if isinstance(raw, list) else raw.get('notes', raw.get('request_plan'))
    if not isinstance(entries, list):
        raise ValueError('Plan must contain notes or request_plan')
    result = {}
    for item in entries:
        note_id = item.get('note_id', '')
        if not ID.fullmatch(note_id) or note_id in result:
            raise ValueError('Plan IDs must be valid and unique')
        result[note_id] = item
    return result, raw if isinstance(raw, dict) else {}


def decimal_value(value):
    if isinstance(value, bool) or not isinstance(value, (str, int, float)):
        return None
    try:
        number = Decimal(str(value))
        return number if number.is_finite() else None
    except InvalidOperation:
        return None


def source_ref(root, path):
    path = Path(path).resolve()
    return str(path.relative_to(root)) if path.is_relative_to(root) else str(path)


def safe_code(value, fallback='unspecified'):
    return value if isinstance(value, str) and re.fullmatch(r'[A-Za-z0-9_.:-]{1,160}', value) else fallback


def local_file(base, relative):
    if not isinstance(relative, str):
        return None
    path = Path(relative)
    if path.is_absolute() or '..' in path.parts:
        return None
    candidate = Path(base) / path
    if candidate.is_symlink() or not candidate.resolve().is_relative_to(Path(base).resolve()):
        return None
    return candidate if candidate.is_file() else None


def category(item):
    kind = item.get('kind')
    if kind == 'video' and '-motion' in str(item.get('id', '')):
        return 'live_photo_motion'
    return kind if kind in ('image', 'video', 'audio', 'subtitle') else 'other'


def empty_media_counts():
    return {kind: {'entries': 0, 'available_files': 0, 'available_bytes': 0, 'gap_entries': 0}
            for kind in CATEGORIES}


def inspect_record(root, record):
    folder = root / '笔记' / record['note_id']
    issues, media_issues, counts = [], [], empty_media_counts()
    if not (folder / '正文.md').is_file():
        issues.append('missing_markdown')
    seen_paths = set()
    for item in record['media']:
        bucket = counts[category(item)]
        bucket['entries'] += 1
        reason = None
        if item.get('status') != 'available':
            reason = safe_code(item.get('reason'), safe_code(item.get('status')))
        else:
            path = local_file(folder, item.get('path'))
            if path is None:
                reason = 'local_media_missing_or_invalid_path'
            elif path.stat().st_size != item.get('bytes'):
                reason = 'local_media_size_mismatch'
            elif item['path'] in seen_paths:
                reason = 'duplicate_media_path'
            else:
                seen_paths.add(item['path'])
                bucket['available_files'] += 1
                bucket['available_bytes'] += path.stat().st_size
        if reason:
            bucket['gap_entries'] += 1
            media_issues.append({'media_id': item.get('id'), 'category': category(item),
                                 'reason': reason})
    if record.get('media_status') == 'partial' and not media_issues:
        issues.append('metadata_declares_partial_media')
    return {'issues': issues, 'media_issues': media_issues, 'media': counts}


def pricing_report(attempts, plan, plan_document):
    successful = [a for a in attempts if a.get('status') == 'detail_verified']
    totals, counts, quote_sources = collections.defaultdict(lambda: Decimal('0.00')), collections.Counter(), collections.Counter()
    missing = 0
    for attempt in successful:
        item = plan[attempt['note_id']]
        kind = item.get('type', 'unknown')
        quote = decimal_value(attempt.get('quoted_cost_cny'))
        basis = 'ledger.quoted_cost_cny'
        if quote is None:
            quote = decimal_value(item.get('estimated_cost_cny'))
            basis = 'plan.estimated_cost_cny'
        if quote is None:
            quote = decimal_value(plan_document.get('unit_price_cny', {}).get(kind))
            basis = 'plan.unit_price_cny'
        counts[kind] += 1
        if quote is None or quote < 0:
            missing += 1
            continue
        totals[kind] += quote
        quote_sources[basis] += 1
    groups = collections.defaultdict(list)
    # Balance values are observations with distinct provenance, never a cost calculation.
    for attempt in attempts:
        value = attempt.get('detail_response_balance_raw')
        if decimal_value(value) is not None:
            key = ('detail_response', 'balance', attempt.get('origin', 'current_batch'), attempt.get('api_path', attempt.get('type', 'unknown')))
            groups[key].append({'observed_at': attempt.get('finished_at') or attempt.get('started_at'),
                                'value_raw': str(value), 'note_id': attempt['note_id']})
    return {
        'method': 'successful_detail_attempt_quotes_only', 'actual_charged_cost_cny': None,
        'successful_detail_attempts': len(successful),
        'successful_detail_posts': len({a['note_id'] for a in successful}),
        'known_quote_total_cny': str(sum(totals.values(), Decimal('0.00'))),
        'attempts_without_quote': missing, 'quote_complete': missing == 0,
        'by_type': {kind: {'successful_attempts': count, 'known_quote_cny': str(totals[kind])}
                    for kind, count in sorted(counts.items())},
        'quote_sources': dict(quote_sources),
    }, groups


def build_report(root, plan_path, notion_corpus, batch_dir):
    """Read a snapshot and return data only. Writing requires write_report or the CLI."""
    root, batch = Path(root).resolve(), Path(batch_dir).resolve()
    plan, plan_document = load_plan(plan_path)
    notion = library.read_jsonl(notion_corpus)
    notion_ids = {row.get('id') for row in notion}
    if len(notion_ids) != len(notion) or any(not isinstance(n, str) or not ID.fullmatch(n) for n in notion_ids):
        raise ValueError('Notion corpus IDs must be valid and unique')
    expected = notion_ids | set(plan)
    ledger_path, index_path = batch / 'api-ledger.json', batch / 'download-index.json'
    def stamp(path):
        return (path.stat().st_mtime_ns, path.stat().st_size) if path.is_file() else None
    before = {p: stamp(p) for p in (ledger_path, index_path)}
    ledger = read_json(ledger_path) if ledger_path.is_file() else {'attempts': [], 'balance_observations': []}
    index = read_json(index_path) if index_path.is_file() else {'posts': {}}
    attempts = [a for a in ledger.get('attempts', []) if a.get('note_id') in plan]
    by_note = collections.defaultdict(list)
    for attempt in attempts:
        by_note[attempt['note_id']].append(attempt)

    records, invalid = {}, []
    for path in sorted((root / '笔记').glob('*/元数据.json')):
        try:
            record = read_json(path)
            library.validate_note(record)
            if record['note_id'] != path.parent.name or record['note_id'] in records:
                raise ValueError('Metadata ID mismatch')
            records[record['note_id']] = record
        except (ValueError, KeyError, TypeError):
            invalid.append({'path': source_ref(root, path), 'reason': 'invalid_note_metadata'})
    actual = set(records)
    views = {note_id: inspect_record(root, n) for note_id, n in records.items() if note_id in expected}
    media, media_by_provider = empty_media_counts(), {'notion': empty_media_counts(), 'galaxy': empty_media_counts()}
    for note_id, view in views.items():
        providers = {s.get('provider') for s in records[note_id]['sources']}
        destinations = [media] + [media_by_provider[p] for p in media_by_provider if p in providers]
        for destination in destinations:
            for kind in CATEGORIES:
                for field, value in view['media'][kind].items():
                    destination[kind][field] += value

    galaxy_rows, states = [], collections.Counter()
    detail_success = 0
    for note_id in plan:
        prior, n, entry = by_note[note_id], records.get(note_id), index.get('posts', {}).get(note_id)
        verified = [a for a in prior if a.get('status') == 'detail_verified']
        reasons, gaps = [], []
        if not verified:
            latest = prior[-1].get('status') if prior else None
            if prior:
                state = 'request_unconfirmed' if latest in ('started', 'request_unknown') else 'detail_failed'
                reasons.append(safe_code(latest))
                if n and isinstance(n.get('acquisition_error'), dict):
                    reason = safe_code(n['acquisition_error'].get('reason'))
                    if reason not in reasons:
                        reasons.append(reason)
            elif entry or (n and any(s.get('provider') == 'galaxy' for s in n['sources'])):
                state = 'evidence_inconsistent'
                reasons.append('no_verified_detail_in_batch_ledger')
            else:
                state = 'not_requested'; reasons.append('no_request_record')
        else:
            detail_success += 1
            if not any(local_file(root, a.get('raw_file')) for a in verified):
                reasons.append('raw_response_missing')
            if n is None:
                reasons.append('normalized_note_missing')
            else:
                view = views[note_id]
                reasons.extend(view['issues']); gaps.extend(view['media_issues'])
                if not any(s.get('provider') == 'galaxy' for s in n['sources']):
                    reasons.append('galaxy_source_missing')
                if n.get('type') != plan[note_id].get('type'):
                    reasons.append('note_type_mismatch')
                if not n['media']:
                    reasons.append('no_media_declared_for_galaxy_detail')
            if entry is None:
                reasons.append('download_index_entry_missing')
            else:
                if entry.get('status') != 'complete':
                    reasons.append('batch_status_' + safe_code(entry.get('status')))
                for item in list(entry.get('media', {}).values()) + entry.get('gaps', []):
                    if item.get('status') != 'available':
                        gap = {'media_id': item.get('id'), 'category': category(item),
                               'reason': safe_code(item.get('reason'), safe_code(item.get('status')))}
                        if gap not in gaps: gaps.append(gap)
                if n is not None:
                    indexed_ids = set(entry.get('media', {})) | {g.get('id') for g in entry.get('gaps', [])}
                    if indexed_ids != {m.get('id') for m in n['media']}:
                        reasons.append('metadata_index_media_set_mismatch')
            if gaps or (entry and entry.get('status') == 'partial') or (n and n.get('media_status') == 'partial'):
                state = 'media_gaps'
            elif reasons:
                state = 'detail_incomplete'
            else:
                state = 'complete'
        states[state] += 1
        galaxy_rows.append({'note_id': note_id, 'type': plan[note_id].get('type'), 'status': state,
                            'detail_verified': bool(verified), 'reasons': reasons, 'media_gaps': gaps})

    notion_issues = []
    for note_id in sorted(notion_ids & actual):
        view = views[note_id]
        reasons = list(view['issues'])
        if not any(s.get('provider') == 'notion' for s in records[note_id]['sources']):
            reasons.append('notion_source_missing')
        if reasons or view['media_issues']:
            notion_issues.append({'note_id': note_id, 'reasons': reasons, 'media_gaps': view['media_issues']})
    fees, balance_groups = pricing_report(attempts, plan, plan_document)
    for observation in ledger.get('balance_observations', []):
        value = observation.get('balance_raw')
        key = (observation.get('source', 'get_balance'), 'data.balance', observation.get('origin', 'current_batch'), '/api/get_balance')
        clean = {'observed_at': observation.get('checked_at'), 'http_status': observation.get('http_status')}
        if decimal_value(value) is not None: clean['value_raw'] = str(value)
        else: clean['status'] = 'unavailable'
        balance_groups[key].append(clean)
    balances = [{'source': key[0], 'field': key[1], 'origin': key[2], 'endpoint': key[3],
                 'observations': sorted(values, key=lambda item: item.get('observed_at') or '')}
                for key, values in sorted(balance_groups.items())]
    changed = any(stamp(path) != before[path] for path in before)
    missing, extra = sorted(expected - actual), sorted(actual - expected)
    incomplete = [row for row in galaxy_rows if row['status'] != 'complete']
    original_empty = sorted(row['id'] for row in notion if row.get('body_chars') == 0
                            or ('body_chars' not in row and not str(row.get('body_text', '')).strip()))
    empty_current = {provider: sorted(note_id for note_id in ids & actual
                                     if not records[note_id]['body_text'].strip()
                                     and records[note_id].get('content_status') != 'detail_unavailable')
                     for provider, ids in [('notion', notion_ids), ('galaxy', set(plan))]}
    return {
        'schema_version': 'rednote-library-export-report-v1', 'generated_at': library.now(),
        'status': 'complete' if not (missing or extra or invalid or incomplete or notion_issues or changed) else 'incomplete',
        'inputs': {'plan': source_ref(root, plan_path), 'notion_corpus': source_ref(root, notion_corpus),
                   'galaxy_ledger': source_ref(root, ledger_path), 'galaxy_index': source_ref(root, index_path)},
        'verification_scope': 'Metadata and ledger reconciliation, local file existence and size; no requests, media hashing or decoding.',
        'snapshot_changed_during_read': changed,
        'reconciliation': {'notion_expected': len(notion_ids), 'galaxy_expected': len(plan),
                           'overlap': len(notion_ids & set(plan)), 'expected': len(expected),
                           'actual': len(actual), 'present_expected': len(expected & actual),
                           'missing_ids': missing, 'extra_ids': extra, 'invalid_metadata': invalid},
        'galaxy': {'planned': len(plan), 'detail_success': detail_success, 'media_complete': states['complete'],
                   'media_gap_posts': states['media_gaps'], 'detail_failed': states['detail_failed'],
                   'not_requested': states['not_requested'], 'unfinished': len(incomplete),
                   'state_counts': dict(states), 'unfinished_posts': incomplete},
        'notion_issues': notion_issues,
        'empty_body': {'notion_original_ids': original_empty, 'current_empty_text_ids': empty_current,
                       'policy': 'Empty text already present in the source is reported separately, not treated as download failure.'},
        'media': {'scope': 'expected IDs present in normalized metadata', 'counts': media,
                  'by_provider': media_by_provider, 'provider_groups_can_overlap': bool(notion_ids & set(plan))},
        'pricing': fees, 'balance_observations': balances,
        'balance_policy': 'Values remain separated by source, field, origin and endpoint. No balance differences are used as charges.',
    }


def render_markdown(report):
    r, g = report['reconciliation'], report['galaxy']
    lines = ['# 本次导出结果', '', '状态：' + ('完成' if report['status'] == 'complete' else '内容有缺口'), '',
             f"预期 {r['expected']} 篇（Notion {r['notion_expected']} ＋ Galaxy {r['galaxy_expected']}，交集 {r['overlap']}）；",
             f"实际有效元数据 {r['actual']} 篇，预期范围内 {r['present_expected']} 篇，缺失 {len(r['missing_ids'])}，多余 {len(r['extra_ids'])}。", '',
             f"Galaxy：详情成功 {g['detail_success']}；媒体完整 {g['media_complete']}；媒体缺口 {g['media_gap_posts']}；",
             f"详情失败 {g['detail_failed']}；未请求 {g['not_requested']}；总计未完成 {g['unfinished']}。", '',
             '## 本地媒体', '', '| 类型 | 条目 | 可用文件 | 可用字节 | 缺口条目 |', '|---|---:|---:|---:|---:|']
    labels = {'image': '图片', 'video': '普通视频', 'live_photo_motion': 'LivePhoto 动态部分（-motion）',
              'audio': '音频', 'subtitle': '字幕', 'other': '其他'}
    for kind, value in report['media']['counts'].items():
        lines.append(f"| {labels[kind]} | {value['entries']} | {value['available_files']} | {value['available_bytes']} | {value['gap_entries']} |")
    p = report['pricing']
    lines += ['', '## 费用与余额来源', '',
              f"成功详情 {p['successful_detail_attempts']} 次的已知报价合计 ¥{p['known_quote_total_cny']}；缺少报价的成功调用 {p['attempts_without_quote']} 次。",
              '该数值是报价估算，实际扣费未由本工具认定。余额按字段、接口和来源分组保留，没有用余额差额推算费用。', '']
    for group in report['balance_observations']:
        observations = group['observations']
        first, last = observations[0], observations[-1]
        def point(item):
            return item.get('value_raw', '不可用') + '（' + str(item.get('observed_at') or '时间未记录') + '）'
        lines.append(f"- {group['source']} / {group['field']} / {group['origin']} / {group['endpoint']}："
                     f"{len(observations)} 次；首笔 {point(first)}；末笔 {point(last)}。")
    lines += ['', '## 原始空正文', '',
              f"Notion 原始空正文：{len(report['empty_body']['notion_original_ids'])} 篇。来源中本来没有文字不计作下载失败。", '',
              ', '.join(report['empty_body']['notion_original_ids']) or '无', '',
              f"当前 Galaxy 文字为空：{len(report['empty_body']['current_empty_text_ids']['galaxy'])} 篇。", '',
              '## 缺口与未完成帖子', '', '| 帖子 ID | 状态 | 原因 |', '|---|---|---|']
    state_labels = {'media_gaps': '媒体未齐', 'detail_failed': '详情未取得',
                    'not_requested': '未请求', 'request_unconfirmed': '请求结果待确认',
                    'detail_incomplete': '归档未齐', 'evidence_inconsistent': '记录不一致'}
    reason_labels = {'detail_unavailable': '接口未返回有效详情',
                     'provider_reported_not_found': '平台提示笔记不存在或已删除'}
    for row in g['unfinished_posts']:
        reasons = [reason_labels.get(reason, reason) for reason in row['reasons']]
        reasons += [str(m.get('media_id', 'media')) + ':' + m['reason'] for m in row['media_gaps']]
        lines.append(f"| {row['note_id']} | {state_labels.get(row['status'], row['status'])} | {'; '.join(reasons)} |")
    if not g['unfinished_posts']: lines.append('| — | 无 | — |')
    for label, ids in [('缺失元数据', r['missing_ids']), ('多余元数据', r['extra_ids'])]:
        lines += ['', f"{label}（{len(ids)}）：" + (', '.join(ids) or '无')]
    for row in report['notion_issues']:
        reasons = row['reasons'] + [str(m.get('media_id', 'media')) + ':' + m['reason'] for m in row['media_gaps']]
        lines.append('\nNotion ' + row['note_id'] + '：' + '; '.join(reasons))
    if r['invalid_metadata']: lines.append(f"\n无法读取为统一记录的元数据：{len(r['invalid_metadata'])}，详见 JSON。")
    if report['snapshot_changed_during_read']: lines.append('\n读取时下载账本仍有变化；此报告是未完成快照。')
    lines += ['', '本工具核对记录、文件存在和大小；未重复进行媒体哈希或解码。', '']
    return '\n'.join(lines)


def write_report(root, report):
    destination = Path(root) / '导出记录'
    library.save_json(destination / '本次导出结果.json', report)
    library.atomic_text(destination / '本次导出结果.md', render_markdown(report))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('root', 'plan', 'notion-corpus', 'batch-dir'):
        parser.add_argument('--' + name, required=True, type=Path)
    args = parser.parse_args()
    report = build_report(args.root, args.plan, args.notion_corpus, args.batch_dir)
    write_report(args.root, report)
    r, g = report['reconciliation'], report['galaxy']
    print(json.dumps({'status': report['status'], 'expected': r['expected'], 'actual': r['actual'],
                      'missing': len(r['missing_ids']), 'extra': len(r['extra_ids']),
                      'galaxy_detail_success': g['detail_success'], 'galaxy_media_complete': g['media_complete'],
                      'galaxy_unfinished': g['unfinished']}, ensure_ascii=False))


if __name__ == '__main__':
    main()
