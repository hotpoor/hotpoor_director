"""Synchronize the chronological biography and daily counts from the development log."""
import argparse
from html import escape
from collections import Counter
from pathlib import Path
import re
import sys

ROOT = Path(__file__).resolve().parent.parent
SUMMARY_PATTERN = r'<!-- daily-summary:start -->.*?<!-- daily-summary:end -->'
HEADER = """# 开发传记

从项目起点读到现在，按时间顺序回顾功能演进、验证与当时的限制。

本文件由 [开发日志](DEVELOPMENT_LOG.md) 自动生成，同一条记录的内容保持一致；开发日志最新在前，本传记从早到晚。日期使用北京时间（Asia/Shanghai）。当前功能以 [README](README.md) 为准。

新条目的标题精确到小时分钟，表示记录时间；旧条目中的“首次提交时间”来自 Git 提交者时间（含合并提交），表示日志首次入库时间，不代表实际完成时刻或耗时。一次提交可包含多项工作；旧条目的日内顺序保留原记录顺序。

请修改开发日志后运行 `python3 scripts/sync-development-history.py`，不要单独修改本文件。校验两份文档及每日统计：`python3 scripts/sync-development-history.py --check`。

"""


def daily_summary(entries, reverse):
    counts = Counter(re.match(r'## (\d{4}-\d{2}-\d{2})', entry)[1] for entry in entries)
    timed = Counter()
    for entry in entries:
        match = re.match(r'## (\d{4}-\d{2}-\d{2}) \d{2}:\d{2}', entry)
        if match:
            timed[match[1]] += 1
    lines = ['## 每日记录概览', '',
             f'共 **{len(entries)} 条开发记录**，覆盖 **{len(counts)} 个日期**。一条代表一个记录阶段，可能含多项改动；数量用于回顾记录，不等同于独立功能数或工作小时。', '',
             '| 日期 | 开发记录 | 分钟级记录时间 | 仅有首次提交时间 |',
             '| --- | ---: | ---: | ---: |']
    for day in sorted(counts, reverse=reverse):
        committed = sum(entry.startswith('## ' + day) and '> 首次提交时间：' in entry for entry in entries)
        lines.append(f'| {day} | {counts[day]} | {timed[day]} | {committed} |')
    return '\n'.join(lines)


def activity_chart(entries):
    counts = Counter(re.match(r'## (\d{4}-\d{2}-\d{2})', entry)[1] for entry in entries)
    days = sorted(counts, reverse=True)[:14]
    labels = ', '.join('"' + day + ' · ' + str(counts[day]) + ' 条"' for day in days)
    values = ', '.join(str(counts[day]) for day in days)
    return ('### 每日工作记录分布\n\n最近 14 个有记录日期；条形长度表示记录数量，不表示耗时。完整数据见上表。\n\n'
            '```mermaid\nxychart-beta horizontal\n'
            '    title "每日开发记录"\n'
            f'    x-axis [{labels}]\n'
            f'    y-axis "记录数" 0 --> {max(counts[day] for day in days) + 2}\n'
            f'    bar [{values}]\n```')


def history_chart(entries):
    chronological = list(reversed(entries))
    counts = Counter(re.match(r'## (\d{4}-\d{2}-\d{2})', entry)[1] for entry in entries)
    examples = {}
    for entry in chronological:
        day = re.match(r'## (\d{4}-\d{2}-\d{2})', entry)[1]
        title = re.sub(r'^## \d{4}-\d{2}-\d{2}(?: \d{2}:\d{2})?\s*[·：:]?\s*', '', entry.splitlines()[0])
        # Escape text inside Mermaid quoted labels without changing source records.
        title = '<br/>'.join(escape(title[i:i + 12], quote=True) for i in range(0, len(title), 12))
        examples.setdefault(day, title)
    days = sorted(counts)
    parts = ['## 开发时间线', '', '从左向右阅读，每组最多 5 个日期。节点展示当日记录数及一条记录示例；间距不代表实际时间跨度，完整事项见下方正文。', '']
    for offset in range(0, len(days), 5):
        group = days[offset:offset + 5]
        parts += [f'### {group[0]} 至 {group[-1]}', '', '```mermaid', 'flowchart LR']
        for i, day in enumerate(group):
            parts.append(f'    d{i}["{day}<br/>{counts[day]} 条记录<br/>{examples[day]}"]')
        if len(group) > 1:
            parts.append('    ' + ' --> '.join(f'd{i}' for i in range(len(group))))
        parts += ['```', '']
    return '\n'.join(parts).rstrip()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true', help='Check without writing files')
    args = parser.parse_args()
    log_path = ROOT / 'DEVELOPMENT_LOG.md'
    source = log_path.read_text(encoding='utf-8')
    headings = list(re.finditer(r'^## (\d{4}-\d{2}-\d{2})[^\n]*$', source, re.M))
    if not headings:
        parser.error('No dated development entries found')
    dates = [item[1] for item in headings]
    if dates != sorted(dates, reverse=True):
        parser.error('DEVELOPMENT_LOG.md must have newest dates first')
    entries = [source[item.start():headings[i + 1].start() if i + 1 < len(headings) else len(source)].strip()
               for i, item in enumerate(headings)]
    # Legacy entries have dates only; compare times only among timestamped records.
    timed = re.findall(r'^## (\d{4}-\d{2}-\d{2} \d{2}:\d{2})', source, re.M)
    if timed != sorted(timed, reverse=True):
        parser.error('Timestamped entries must have newest recording times first')
    summary = '<!-- daily-summary:start -->\n' + daily_summary(entries, True) + '\n\n' + activity_chart(entries) + '\n<!-- daily-summary:end -->'
    if len(re.findall(SUMMARY_PATTERN, source, re.S)) != 1:
        parser.error('Expected one daily-summary marker pair in development log')
    expected_log = re.sub(SUMMARY_PATTERN, lambda _: summary, source, flags=re.S)
    expected_history = HEADER + history_chart(entries) + '\n\n' + daily_summary(entries, False) + '\n\n' + '\n\n'.join(reversed(entries)) + '\n'
    target = ROOT / 'DEVELOPMENT_HISTORY.md'
    if args.check:
        if source != expected_log or not target.exists() or target.read_text(encoding='utf-8') != expected_history:
            print('Development docs are out of sync; run scripts/sync-development-history.py', file=sys.stderr)
            return 1
        print(f'Verified {len(entries)} matching entries, recording order and daily counts.')
    else:
        log_path.write_text(expected_log, encoding='utf-8')
        target.write_text(expected_history, encoding='utf-8')
        print(f'Synchronized {len(entries)} entries and daily counts.')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
