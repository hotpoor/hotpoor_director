import asyncio, json, os, re, uuid
import asyncpg
import jieba
import tornado.web
import tornado.ioloop
def terms(text):
    return {token.strip() for token in jieba.cut(text.lower(), cut_all=False)
            if token.strip() and not token.isspace()}

def entity_db(block_id):
    return "wiki1" if block_id.int % 2 == 0 else "wiki2"

def json_body(value):
    return json.loads(value) if isinstance(value, str) else value

def row_payload(row):
    payload = dict(row)
    payload["body"] = json_body(payload["body"])
    return payload

MAX_PAGE_SIZE = 100
DEFAULT_PAGE_SIZE = 20


def pagination(handler):
    try:
        size = int(handler.get_argument("page_size", handler.get_argument("limit", DEFAULT_PAGE_SIZE)))
        page = int(handler.get_argument("page", "1"))
        offset = int(handler.get_argument("offset", "-1"))
    except ValueError:
        raise tornado.web.HTTPError(400, reason="page, page_size, limit and offset must be integers")
    if size < 1 or size > MAX_PAGE_SIZE:
        raise tornado.web.HTTPError(400, reason=f"page_size must be between 1 and {MAX_PAGE_SIZE}")
    if offset < 0:
        if page < 1:
            raise tornado.web.HTTPError(400, reason="page must be at least 1")
        offset = (page - 1) * size
    return offset, size


def page_meta(total, offset, size):
    return {"total": total, "page": offset // size + 1, "page_size": size,
            "pages": (total + size - 1) // size, "has_next": offset + size < total,
            "has_previous": offset > 0}


def detail_level(handler, default="summary"):
    value = handler.get_argument("include", default).lower()
    if value not in {"summary", "markdown", "lines", "full"}:
        raise tornado.web.HTTPError(400, reason="include must be summary, markdown, lines or full")
    return value


def document_payload(row, include="summary", line_offset=0, line_limit=DEFAULT_PAGE_SIZE):
    body = json_body(row["body"])
    result = {"block_id": row["block_id"], "kind": body.get("kind"),
              "title": body.get("title"), "path": body.get("path"),
              "paths": body.get("paths", []), "createtime": row["createtime"],
              "updatetime": row["updatetime"]}
    if include in {"markdown", "full"}:
        result["markdown"] = body.get("markdown", "")
    if include in {"lines", "full"}:
        lines = body.get("line_blocks", [])
        result["lines"] = lines[line_offset:line_offset + line_limit]
        result["line_total"] = len(lines)
        result["line_offset"] = line_offset
        result["line_limit"] = line_limit
        result["line_has_next"] = line_offset + line_limit < len(lines)
    return result

class Base(tornado.web.RequestHandler):
    def prepare(self):
        import hmac
        token = self.request.headers.get('X-Director-Knowledge', '')
        if not token or not hmac.compare_digest(token, self.application.token):
            raise tornado.web.HTTPError(403)

    def write_json(self, value):
        self.set_header("Content-Type", "application/json; charset=utf-8")
        self.write(json.dumps(value, ensure_ascii=False, default=str))

class Root(Base):
    async def get(self):
        self.write_json({
            "service": "wiki_test",
            "ok": True,
            "endpoints": {
                "health": "/health",
                "search": "/api/search?q=关键词",
                "tree": "/api/tree",
                "block": "/api/blocks/{block_id}",
            },
        })

class Favicon(Base):
    async def get(self):
        self.set_status(204)

class Health(Base):
    async def get(self):
        await self.application.pools["wiki"].fetchval("SELECT 1")
        await self.application.pools["wiki1"].fetchval("SELECT 1")
        await self.application.pools["wiki2"].fetchval("SELECT 1")
        self.write_json({"ok": True, "databases": ["wiki", "wiki1", "wiki2"]})

class Resolve(Base):
    async def post(self):
        try:
            body = json.loads(self.request.body)
            paths = body['paths']
            if not isinstance(paths, list) or any(not isinstance(p, str) or not p for p in paths):
                raise ValueError()
        except (ValueError, KeyError, TypeError):
            raise tornado.web.HTTPError(400, reason="paths must be an array of nonempty strings")
        wanted = set(paths)
        found = {}
        if wanted:
            for name in ("wiki1", "wiki2"):
                rows = await self.application.pools[name].fetch(
                    "SELECT block_id, body->'paths' AS paths FROM entities "
                    "WHERE body->>'kind'='document' AND (body->'paths') ?| $1::text[]", sorted(wanted))
                for row in rows:
                    for path in json_body(row['paths']):
                        if path in wanted:
                            found.setdefault(path, set()).add(str(row['block_id']))
        self.write_json({"items": [{"path": p, "block_ids": sorted(ids)} for p, ids in sorted(found.items())],
                         "block_ids": sorted({bid for ids in found.values() for bid in ids}),
                         "missing_paths": sorted(wanted - found.keys())})


class Search(Base):
    def get_argument(self, name, default=tornado.web._ARG_DEFAULT, strip=True):
        if hasattr(self, 'search_body') and name in self.search_body:
            value = self.search_body[name]
            if isinstance(value, (dict, list)) or value is None or isinstance(value, bool):
                raise tornado.web.HTTPError(400, reason="invalid search parameter")
            return str(value).strip() if strip else str(value)
        return super().get_argument(name, default, strip)

    async def post(self):
        try:
            self.search_body = json.loads(self.request.body)
            if not isinstance(self.search_body, dict):
                raise ValueError()
        except ValueError:
            raise tornado.web.HTTPError(400, reason="expected JSON object")
        await self.get()

    def scoped_ids(self):
        try:
            if hasattr(self, 'search_body') and 'block_ids' in self.search_body:
                values = self.search_body['block_ids']
            elif 'block_ids' in self.request.arguments:
                values = json.loads(super().get_argument('block_ids'))
            else:
                return None
            if not isinstance(values, list) or any(not isinstance(v, str) for v in values):
                raise ValueError()
            return sorted({uuid.UUID(v) for v in values})
        except (ValueError, TypeError, AttributeError):
            raise tornado.web.HTTPError(400, reason="block_ids must be a JSON array of UUID strings")

    async def get(self):
        query = self.get_argument("q", "").strip()
        offset, size = pagination(self)
        include = detail_level(self)
        block_ids = self.scoped_ids()
        if not query or block_ids == []:
            return self.write_json({"items": [], "pagination": page_meta(0, offset, size)})
        words = terms(query)
        where = "word=ANY($1::text[])"
        args = [list(words)]
        if block_ids is not None:
            args.append(block_ids)
            where += " AND block_id=ANY($2::uuid[])"
        total = await self.application.pools["wiki"].fetchval(
            "SELECT count(DISTINCT block_id) FROM index_search WHERE " + where, *args)
        index_rows = await self.application.pools["wiki"].fetch(
            "SELECT block_id, count(*) AS score FROM index_search WHERE " + where +
            f" GROUP BY block_id ORDER BY score DESC, block_id LIMIT ${len(args)+1} OFFSET ${len(args)+2}",
            *args, size, offset)
        selected = index_rows
        grouped = {"wiki1": [], "wiki2": []}
        scores = {}
        for row in selected:
            bid = row["block_id"]
            grouped[entity_db(bid)].append(bid)
            scores[bid] = row["score"]
        results = []
        for name, ids in grouped.items():
            if not ids:
                continue
            rows = await self.application.pools[name].fetch(
                "SELECT block_id, body, createtime, updatetime FROM entities WHERE block_id=ANY($1::uuid[])", ids)
            for row in rows:
                item = document_payload(row, include)
                item["score"] = scores[row["block_id"]]
                results.append(item)
        results.sort(key=lambda item: (-item["score"], str(item["block_id"])))
        self.write_json({"items": results, "pagination": page_meta(total, offset, size)})

class SemanticIndex(Search):
    async def get(self):
        ids = self.scoped_ids()
        if ids is None:
            raise tornado.web.HTTPError(400, reason="explicit block_ids required")
        ids = [str(x) for x in ids]
        try:
            if self.request.method == 'POST' and self.request.path.endswith('/index'):
                result = await self.application.semantic.start(ids, self.application.pools)
            else:
                result = await self.application.semantic.status(ids)
            self.write_json(result)
        except Exception as error:
            raise tornado.web.HTTPError(503, reason='Semantic service unavailable: ' + str(error))


class Hybrid(Search):
    async def get(self):
        from .semantic import fuse
        import time
        ids = self.scoped_ids()
        if ids is None:
            raise tornado.web.HTTPError(400, reason="explicit block_ids required")
        query = self.get_argument('q', '').strip()
        offset, size = pagination(self)
        include = detail_level(self)
        try:
            threshold = float(self.get_argument('semantic_threshold', '0.35'))
            if not 0 <= threshold <= 1:
                raise ValueError()
        except ValueError:
            raise tornado.web.HTTPError(400, reason="semantic_threshold must be between 0 and 1")
        if not ids or not query:
            return self.write_json({'items': [], 'pagination': page_meta(0, offset, size),
                                    'retrieval': {'strategy': 'hybrid_union_rrf', 'lexical_count': 0, 'semantic_count': 0, 'union_count': 0}})
        key = (query, tuple(str(x) for x in ids), threshold)
        cached = self.application.hybrid_cache.get(key)
        if cached and time.monotonic() - cached[0] < 120:
            ranked, stats = cached[1:]
        else:
            async def lexical():
                rows = await self.application.pools['wiki'].fetch(
                    "SELECT block_id, count(*) AS score FROM index_search "
                    "WHERE word=ANY($1::text[]) AND block_id=ANY($2::uuid[]) "
                    "GROUP BY block_id ORDER BY score DESC, block_id", list(terms(query)), ids)
                return [dict(row) for row in rows]
            try:
                lex, sem = await asyncio.gather(lexical(), self.application.semantic.search(query, list(key[1]), threshold))
            except Exception as error:
                raise tornado.web.HTTPError(503, reason='Hybrid search requires both channels: ' + str(error))
            ranked = fuse(lex, sem)
            both = sum(len(item['channels']) == 2 for item in ranked)
            stats = {'strategy': 'hybrid_union_rrf', 'lexical_count': len(lex), 'semantic_count': len(sem),
                     'overlap_count': both, 'union_count': len(ranked), 'lexical_only': len(lex)-both,
                     'semantic_only': len(sem)-both, 'semantic_threshold': threshold, 'rrf_k': 60,
                     'scope_count': len(ids), 'model': self.application.semantic.signature,
                     'index_complete': True, 'passages_per_document': 3}
            if len(self.application.hybrid_cache) >= 8:
                self.application.hybrid_cache.pop(next(iter(self.application.hybrid_cache)))
            self.application.hybrid_cache[key] = (time.monotonic(), ranked, stats)
        results = []
        for item in ranked[offset:offset+size]:
            bid = uuid.UUID(item['block_id'])
            row = await self.application.pools[entity_db(bid)].fetchrow(
                'SELECT block_id, body, createtime, updatetime FROM entities WHERE block_id=$1', bid)
            if row is None:
                raise tornado.web.HTTPError(409, reason='Retrieved document missing')
            results.append({**document_payload(row, include), **item})
        self.write_json({'items': results, 'pagination': page_meta(len(ranked), offset, size), 'retrieval': stats})


def flatten_tree(tree, prefix=""):
    entries = []
    for name, value in sorted(tree.items()):
        path = f"{prefix}/{name}" if prefix else name
        entry = {"name": name, "path": path, "kind": value.get("kind")}
        if value.get("kind") == "directory":
            entry["child_count"] = len(value.get("children", {}))
            entries.append(entry)
            entries.extend(flatten_tree(value.get("children", {}), path))
        else:
            entries.append(entry)
    return entries

class Tree(Base):
    async def get(self):
        offset, size = pagination(self)
        rows = []
        for name in ("wiki1", "wiki2"):
            row = await self.application.pools[name].fetchrow(
                "SELECT block_id, body, createtime, updatetime FROM entities WHERE body->>'kind'='file_tree' ORDER BY updatetime DESC LIMIT 1")
            if row:
                rows.append(row)
        if not rows:
            self.write_json({"block_id": None, "kind": "file_tree", "root": None,
                             "imported": False, "items": [],
                             "pagination": page_meta(0, offset, size)})
            return
        row = max(rows, key=lambda item: item["updatetime"])
        body = json_body(row["body"])
        prefix = self.get_argument("prefix", "").strip("/")
        kind = self.get_argument("kind", "all").lower()
        if kind not in {"all", "file", "directory"}:
            raise tornado.web.HTTPError(400, reason="kind must be all, file or directory")
        items = flatten_tree(body.get("tree", {}))
        if prefix:
            items = [item for item in items if item["path"] == prefix or item["path"].startswith(prefix + "/")]
        if kind != "all":
            items = [item for item in items if item["kind"] == kind]
        total = len(items)
        payload = {"block_id": row["block_id"], "kind": "file_tree", "root": body.get("root"),
                   "items": items[offset:offset + size], "pagination": page_meta(total, offset, size)}
        self.write_json(payload)

class Block(Base):
    async def get(self, block_id):
        try:
            bid = uuid.UUID(block_id)
        except ValueError:
            raise tornado.web.HTTPError(400, reason="invalid UUID")
        row = await self.application.pools[entity_db(bid)].fetchrow("SELECT block_id, body, createtime, updatetime FROM entities WHERE block_id=$1", bid)
        if not row:
            raise tornado.web.HTTPError(404)
        include = detail_level(self, "full")
        line_offset, line_limit = pagination(self)
        self.write_json(document_payload(row, include, line_offset, line_limit))

class Application(tornado.web.Application):
    def __init__(self, token, semantic_root):
        self.token = token
        super().__init__([(r"/", Root), (r"/favicon.ico", Favicon), (r"/health", Health), (r"/api/search", Search), (r"/api/hybrid/search", Hybrid), (r"/api/semantic/index", SemanticIndex), (r"/api/semantic/status", SemanticIndex), (r"/api/resolve", Resolve), (r"/api/tree", Tree), (r"/api/blocks/([0-9a-f-]+)", Block)], debug=False)
        from .semantic import Semantic
        self.semantic = Semantic(semantic_root)
        self.hybrid_cache = {}
        self.pools = {}
