"""Owned dialogue attachments and bounded native multimodal inputs."""
import asyncio
import base64
import io
import os
from pathlib import Path
from urllib.parse import quote
import uuid
import zipfile
from xml.etree import ElementTree as ET

from psycopg.types.json import Jsonb
from tornado.web import HTTPError
from backend.workspace import PrivateHandler, owned, ID

MAX_FILE = 10 * 1024 * 1024
MAX_FILES = 5
MAX_BYTES = 20 * 1024 * 1024
MAX_TEXT = 80000
TEXT_EXTENSIONS = {'.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.yaml', '.yml', '.xml', '.html', '.css', '.js', '.ts', '.jsx', '.tsx', '.py', '.sh', '.sql', '.log', '.toml', '.ini', '.c', '.cpp', '.h', '.java', '.go', '.rs', '.vue'}


def inspect_file(name, raw):
    suffix = Path(name).suffix.lower()
    if not raw or len(raw) > MAX_FILE:
        raise HTTPError(400, reason='文件不能为空，单个文件最多 10 MB')
    if raw.startswith(b'\x89PNG\r\n\x1a\n'):
        return 'image/png', 'image', None
    if raw.startswith(b'\xff\xd8\xff'):
        return 'image/jpeg', 'image', None
    if raw.startswith(b'RIFF') and raw[8:12] == b'WEBP':
        return 'image/webp', 'image', None
    if suffix == '.pdf' and raw.startswith(b'%PDF-'):
        return 'application/pdf', 'pdf', None
    if suffix == '.docx':
        try:
            with zipfile.ZipFile(io.BytesIO(raw)) as archive:
                entry = archive.getinfo('word/document.xml')
                if entry.file_size > 5 * 1024 * 1024:
                    raise ValueError()
                xml = archive.read(entry)
                if b'<!DOCTYPE' in xml or b'<!ENTITY' in xml:
                    raise ValueError()
                tree = ET.fromstring(xml)
                ns = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'
                text = '\n'.join(''.join(p.itertext()) for p in tree.iter(ns + 'p'))
        except (zipfile.BadZipFile, KeyError, ValueError, ET.ParseError, RuntimeError):
            raise HTTPError(400, reason='无法读取此 Word 文件，请使用有效的 DOCX 文档') from None
        mime = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    elif suffix in TEXT_EXTENSIONS:
        text = None
        for encoding in ('utf-8-sig', 'utf-16' if raw.startswith((b'\xff\xfe', b'\xfe\xff')) else 'utf-8', 'gb18030'):
            try:
                text = raw.decode(encoding)
                break
            except UnicodeError:
                continue
        if text is None or '\x00' in text:
            raise HTTPError(400, reason='文件不是可读取的文本，请使用 UTF-8 / UTF-16 / GB18030 编码')
        mime = 'text/plain'
    else:
        raise HTTPError(400, reason='支持 PNG/JPEG/WebP、PDF、DOCX 和文本 / 代码文件')
    if not text.strip() or len(text) > MAX_TEXT:
        raise HTTPError(400, reason='文件无可读取文字，或文字超过 80000 字符；请拆分后添加')
    return mime, 'text', text


def public_file(row):
    body = row['body']
    return {'id': row['block_id'], **{k: body[k] for k in ('name', 'mime', 'size', 'format')},
            'url': '/api/dialogue/files/' + row['block_id']}


def attachment_ids(data):
    ids = data.get('attachments', [])
    if not isinstance(ids, list) or len(ids) > MAX_FILES or any(not isinstance(i, str) or not ID.fullmatch(i) for i in ids) or len(set(ids)) != len(ids):
        raise HTTPError(400, reason='每次最多添加 5 个文件，附件 ID 必须有效且不重复')
    return ids


async def file_for(conn, file_id, owner, conversation_id):
    row = await (await conn.execute("SELECT * FROM entities WHERE block_id=%s AND body->>'kind'='dialogue_file' AND body->>'owner_id'=%s AND body->>'conversation_id'=%s", (file_id, owner, conversation_id), block_id=file_id)).fetchone()
    if not row:
        raise HTTPError(404, reason='附件不存在或不属于此对话')
    return row


def image_part(uri, path):
    return {'type': 'input_image', 'image_url': uri} if path == '/v1/responses' else {'type': 'image_url', 'image_url': {'url': uri}}


def pdf_part(name, uri, path):
    return {'type': 'input_file', 'filename': name, 'file_data': uri} if path == '/v1/responses' else {'type': 'file', 'file': {'filename': name, 'file_data': uri}}


async def prepare_messages(conn, messages, config, owner, conversation_id, path):
    output = []
    total_bytes = 0
    total_text = 0
    for message in messages:
        text = message['content']
        parts = []
        for ref in message.get('attachments', []):
            row = await file_for(conn, ref['id'], owner, conversation_id)
            body = row['body']
            total_bytes += body['size']
            if total_bytes > MAX_BYTES:
                raise HTTPError(400, reason='最近 20 轮附件合计超过 20 MB，请新建对话')
            if body['format'] == 'text':
                text += '\n\n【附件：' + body['name'] + '】\n' + body['text']
            else:
                file_path = config['data_dir'] / 'dialogue-files' / body['filename']
                try:
                    raw = await asyncio.to_thread(file_path.read_bytes)
                except OSError:
                    raise HTTPError(409, reason='附件文件不可读取，请重新添加或新建对话') from None
                if len(raw) != body['size']:
                    raise HTTPError(409, reason='附件文件发生变化，请重新添加')
                uri = 'data:' + body['mime'] + ';base64,' + base64.b64encode(raw).decode('ascii')
                parts.append(image_part(uri, path) if body['format'] == 'image' else pdf_part(body['name'], uri, path))
        total_text += len(text)
        if total_text > 120000:
            raise HTTPError(400, reason='最近 20 轮文字和附件内容超过 120000 字符，请拆分文件或新建对话')
        content = [{'type': 'input_text' if path == '/v1/responses' else 'text', 'text': text}, *parts] if parts else text
        output.append({'role': message['role'], 'content': content})
    return output


class DialogueUploadHandler(PrivateHandler):
    async def post(self, conversation_id):
        await owned(self.projects, conversation_id, self.owner, 'dialogue')
        files = self.request.files.get('file', [])
        if len(files) != 1:
            raise HTTPError(400, reason='请选择一个文件')
        name = Path(files[0]['filename'].replace('\\', '/')).name[:254]
        if not name or any(ord(c) < 32 for c in name):
            raise HTTPError(400, reason='文件名不正确')
        raw = files[0]['body']
        mime, kind, text = await asyncio.to_thread(inspect_file, name, raw)
        file_id = uuid.uuid4().hex
        directory = self.settings['config']['data_dir'] / 'dialogue-files'
        directory.mkdir(exist_ok=True, mode=0o700)
        filename = file_id + '.bin'
        def write():
            with os.fdopen(os.open(directory / filename, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'wb') as stream:
                stream.write(raw)
        await asyncio.to_thread(write)
        body = {'kind': 'dialogue_file', 'owner_id': self.owner, 'conversation_id': conversation_id,
                'filename': filename, 'name': name, 'mime': mime, 'format': kind, 'size': len(raw)}
        if text is not None:
            body['text'] = text
        try:
            async with self.projects.connection() as conn:
                row = await (await conn.execute('INSERT INTO entities(block_id,body) VALUES (%s,%s) RETURNING *', (file_id, Jsonb(body)), block_id=file_id)).fetchone()
        except BaseException:
            # An uncertain commit may already own this file; retain it for recovery.
            raise
        self.finish(public_file(row))


class DialogueFileHandler(PrivateHandler):
    async def get(self, file_id):
        row = await owned(self.projects, file_id, self.owner, 'dialogue_file')
        body = row['body']
        file_path = self.settings['config']['data_dir'] / 'dialogue-files' / body['filename']
        try:
            raw = await asyncio.to_thread(file_path.read_bytes)
        except OSError:
            raise HTTPError(404, reason='附件文件不存在') from None
        self.set_header('Content-Type', body['mime'] if body['format'] == 'image' else 'application/octet-stream')
        self.set_header('Content-Disposition', "attachment; filename*=UTF-8''" + quote(body['name'], safe=''))
        self.finish(raw)
