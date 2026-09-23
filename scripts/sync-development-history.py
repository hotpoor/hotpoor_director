"""Generate the chronological development biography from the newest-first log."""
import argparse
from pathlib import Path
import re
import sys

ROOT = Path(__file__).resolve().parent.parent
HEADER = """# 开发传记

从项目起点读到现在，按时间顺序回顾功能演进、验证与当时的限制。

本文件由 [开发日志](DEVELOPMENT_LOG.md) 自动生成，同一条记录的内容保持一致；开发日志最新在前，本传记从早到晚。日期使用北京时间（Asia/Shanghai）。旧记录没有精确时间，同一天按记录顺序阅读，不将其视为精确发生时刻。当前功能以 [README](README.md) 为准。

请修改开发日志后运行 `python3 scripts/sync-development-history.py`，不要单独修改本文件。校验两份文档是否同步：`python3 scripts/sync-development-history.py --check`。

"""


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true', help='Check without writing files')
    args = parser.parse_args()
    source = (ROOT / 'DEVELOPMENT_LOG.md').read_text(encoding='utf-8')
    headings = list(re.finditer(r'^## (\d{4}-\d{2}-\d{2})[^\n]*$', source, re.M))
    if not headings:
        parser.error('No dated development entries found')
    dates = [item[1] for item in headings]
    if dates != sorted(dates, reverse=True):
        parser.error('DEVELOPMENT_LOG.md must have newest dates first')
    entries = [source[item.start():headings[i + 1].start() if i + 1 < len(headings) else len(source)].strip()
               for i, item in enumerate(headings)]
    expected = HEADER + '\n\n'.join(reversed(entries)) + '\n'
    target = ROOT / 'DEVELOPMENT_HISTORY.md'
    if args.check:
        if not target.exists() or target.read_text(encoding='utf-8') != expected:
            print('Development biography is out of sync; run scripts/sync-development-history.py', file=sys.stderr)
            return 1
        print(f'Verified {len(entries)} matching entries in both reading orders.')
    else:
        target.write_text(expected, encoding='utf-8')
        print(f'Generated DEVELOPMENT_HISTORY.md with {len(entries)} chronological entries.')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
