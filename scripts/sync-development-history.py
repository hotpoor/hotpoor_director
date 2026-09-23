"""Synchronize the chronological biography and daily counts from the development log."""
import argparse
from datetime import date, timedelta
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
    latest = date.fromisoformat(max(re.match(r'## (\d{4}-\d{2}-\d{2})', entry)[1] for entry in entries))
    start = latest - timedelta(days=364)
    return ('### 每日工作记录分布\n\n'
            f'{start.isoformat()} 至 {latest.isoformat()}，最近 365 天。横向每列一周，纵向周日到周六，每格一天；绿色越深，开发记录越多。浅灰表示没有日志记录，并非 GitHub 账号的提交统计。\n\n'
            '![过去一年开发记录贡献格](docs/charts/development-activity.svg)\n\n'
            '完整日期与数量见上表，图表随最新日志日期自动更新。')


def activity_svg(entries):
    counts = Counter(re.match(r'## (\d{4}-\d{2}-\d{2})', entry)[1] for entry in entries)
    latest = date.fromisoformat(max(counts))
    start = latest - timedelta(days=364)
    grid_start = start - timedelta(days=(start.weekday() + 1) % 7)
    period = {day: count for day, count in counts.items() if start.isoformat() <= day <= latest.isoformat()}
    colors = ['#ebedf0', '#9be9a8', '#40c463', '#30a14e', '#216e39']
    def level(count):
        return 0 if count == 0 else 1 if count <= 3 else 2 if count <= 7 else 3 if count <= 14 else 4
    parts = ['<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="282" viewBox="0 0 1000 282" role="img" aria-labelledby="title desc">',
             '<title id="title">过去一年开发记录贡献格</title>',
             f'<desc id="desc">{start.isoformat()} 至 {latest.isoformat()}，共 {sum(period.values())} 条开发记录。每列一周，纵向按星期排列，颜色越深记录越多。不是 GitHub 账号提交数量。</desc>',
             '<rect x="0.5" y="0.5" width="999" height="281" rx="10" fill="#ffffff" stroke="#d1d9e0"/>',
             '<g font-family="Arial, PingFang SC, Microsoft YaHei, sans-serif" fill="#1f2328">',
             f'<text x="24" y="35" font-size="22" font-weight="600">{sum(period.values())} 条开发记录 · 过去一年</text>',
             f'<text x="976" y="35" text-anchor="end" font-size="12" fill="#59636e">{start.isoformat()} — {latest.isoformat()}</text>']
    for row, label in [(1, '周一'), (3, '周三'), (5, '周五')]:
        parts.append(f'<text x="23" y="{94 + row * 17}" font-size="12" fill="#59636e">{label}</text>')
    for offset in range(365):
        day = start + timedelta(days=offset)
        index = (day - grid_start).days
        column, row = divmod(index, 7)
        x, y = 70 + column * 17, 84 + row * 17
        count = counts.get(day.isoformat(), 0)
        if day.day == 1 or (offset == 0 and day.day <= 10):
            parts.append(f'<text x="{x}" y="69" font-size="12" fill="#59636e">{day.month}月</text>')
        parts += [f'<g><title>{day.isoformat()}：{count} 条开发记录</title>',
                  f'<rect data-date="{day.isoformat()}" data-count="{count}" x="{x}" y="{y}" width="13" height="13" rx="2" fill="{colors[level(count)]}" stroke="#d1d9e0" stroke-width="0.5"/>', '</g>']
    parts += [f'<text x="24" y="244" font-size="12" fill="#59636e">{len(period)} 个有记录日期 · 每格一天 · 数量来源于开发日志</text>',
              '<text x="575" y="244" font-size="12" fill="#59636e">少</text>']
    for i, (color, label) in enumerate(zip(colors, ['0', '1–3', '4–7', '8–14', '15+'])):
        x = 600 + i * 69
        parts += [f'<rect x="{x}" y="231" width="13" height="13" rx="2" fill="{color}" stroke="#d1d9e0" stroke-width="0.5"/>',
                  f'<text x="{x + 18}" y="242" font-size="10" fill="#59636e">{label}</text>']
    parts += ['<text x="960" y="244" font-size="12" fill="#59636e">多</text>', '</g>', '</svg>']
    return '\n'.join(parts) + '\n'


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
    chart_path = ROOT / 'docs/charts/development-activity.svg'
    expected_chart = activity_svg(entries)
    if args.check:
        if (source != expected_log or not target.exists() or target.read_text(encoding='utf-8') != expected_history
                or not chart_path.exists() or chart_path.read_text(encoding='utf-8') != expected_chart):
            print('Development docs are out of sync; run scripts/sync-development-history.py', file=sys.stderr)
            return 1
        print(f'Verified {len(entries)} matching entries, recording order and daily counts.')
    else:
        chart_path.parent.mkdir(parents=True, exist_ok=True)
        chart_path.write_text(expected_chart, encoding='utf-8')
        log_path.write_text(expected_log, encoding='utf-8')
        target.write_text(expected_history, encoding='utf-8')
        print(f'Synchronized {len(entries)} entries and daily counts.')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
