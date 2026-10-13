import hashlib
import json
import asyncio
import os
import stat
import time
import uuid
from pathlib import Path

import jieba
TREE_NAMESPACE = "obsidian-file-tree"

def terms(text):
    result = set()
    for token in jieba.cut(text.lower(), cut_all=False):
        token = token.strip()
        if token and not token.isspace():
            result.add(token)
    return result

def content_block_id(text):
    # Content-only identity: changing Markdown creates a new UUID; path is metadata only.
    return uuid.UUID(hashlib.md5(text.encode("utf-8")).hexdigest())

def line_id(block_id, number, line):
    return hashlib.md5(f"{block_id}:{number}:{line}".encode("utf-8")).hexdigest()[:6]

def entity_db(block_id):
    return "wiki1" if block_id.int % 2 == 0 else "wiki2"

def now():
    return int(time.time() * 1000)

def line_blocks(block_id, text):
    from .positions import source_lines
    return list(source_lines(block_id, text))

def tree_block_id(root):
    return uuid.UUID(hashlib.md5(f"{TREE_NAMESPACE}:{root}".encode("utf-8")).hexdigest())

def build_tree(files, root):
    tree = {}
    for path in files:
        cursor = tree
        relative = path.relative_to(root)
        parts = relative.parts
        for directory in parts[:-1]:
            cursor = cursor.setdefault(directory, {"kind": "directory", "children": {}})["children"]
        cursor[parts[-1]] = {"kind": "file", "path": str(relative)}
    return tree

async def upsert_entity(pool, block_id, body, created=None):
    # Identical content can occur at multiple paths; preserve every reference in the entity.
    existing = await pool.fetchrow("SELECT body, createtime FROM entities WHERE block_id=$1", block_id)
    if existing and body.get("kind") == "document":
        previous = existing["body"]
        if isinstance(previous, str):
            previous = json.loads(previous)
        paths = set(previous.get("paths", []))
        paths.update(body.get("paths", []))
        body["paths"] = sorted(paths)
        for key in ('source_paths', 'book_links'):
            body[key] = sorted(set(previous.get(key, [])) | set(body.get(key, [])))
    timestamp = now()
    await pool.execute("""INSERT INTO entities(block_id, body, createtime, updatetime)
        VALUES($1, $2::jsonb, $3, $3)
        ON CONFLICT(block_id) DO UPDATE SET body=EXCLUDED.body, updatetime=EXCLUDED.updatetime""",
        block_id, json.dumps(body, ensure_ascii=False),
        existing["createtime"] if existing else (created or timestamp))

def markdown_files(root):
    """Enumerate supported documents without following links or dependency folders."""
    files = []
    skipped = 0
    def linked(path):
        return path.is_symlink() or bool(getattr(path.lstat(), 'st_file_attributes', 0) & getattr(stat, 'FILE_ATTRIBUTE_REPARSE_POINT', 0))
    def scan_error(error):
        raise error
    for directory, children, names in os.walk(root, followlinks=False, onerror=scan_error):
        children[:] = sorted(name for name in children if not name.startswith('.') and name not in ('node_modules', '__pycache__') and not linked(Path(directory) / name))
        for name in sorted(names):
            path = Path(directory) / name
            if name.startswith('.') or linked(path) or path.suffix.lower() not in ('.md', '.markdown'):
                skipped += 1
                continue
            files.append(path)
    return sorted(files), skipped


async def import_directory(root, pools, progress=None):
    root = Path(root).expanduser().resolve()
    if not root.is_dir():
        raise ValueError(f"Markdown root does not exist: {root}")
    index_db = pools['wiki']
    entity_dbs = {name: pools[name] for name in ('wiki1', 'wiki2')}
    if progress:
        progress({'phase': 'scanning', 'completed': 0, 'total': 0})
    files, skipped = await asyncio.to_thread(markdown_files, root)
    if not files:
        raise ValueError('所选文件夹及子目录中没有 .md 或 .markdown 文件；原目录未更改。')
    if progress:
        progress({'phase': 'importing', 'completed': 0, 'total': len(files), 'skipped': skipped})
    print(f"importing {len(files)} markdown files from {root}")
    for number, path in enumerate(files, 1):
        relative = path.relative_to(root).as_posix()
        text = path.read_text(encoding="utf-8", errors="replace").replace("\x00", "")
        block_id = content_block_id(text)
        body = {
            "kind": "document",
            "block_id": str(block_id),
            "md5": hashlib.md5(text.encode("utf-8")).hexdigest(),
            "title": path.name,
            "path": relative,
            "paths": [relative],
            "source_paths": [str(path.resolve())],
            "book_links": [],
            "markdown": text,
            "line_blocks": line_blocks(block_id, text),
        }
        entity_pool = entity_dbs[entity_db(block_id)]
        await upsert_entity(entity_pool, block_id, body)
        from .positions import index_document
        await index_document(index_db, block_id, text)
        if progress:
            progress({'phase': 'importing', 'completed': number, 'total': len(files), 'skipped': skipped})
        if number % 100 == 0:
            print(number)

    tree_id = tree_block_id(root)
    tree_body = {
        "kind": "file_tree",
        "block_id": str(tree_id),
        "root": str(root),
        "paths": [path.relative_to(root).as_posix() for path in files],
        "tree": build_tree(files, root),
    }
    await upsert_entity(entity_dbs[entity_db(tree_id)], tree_id, tree_body)
    print(f"stored file tree as {tree_id}")
    return {"documents": len(files), "skipped": skipped, "tree_block_id": str(tree_id)}
