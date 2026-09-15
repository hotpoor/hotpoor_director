"""Private comment threads and bounded, doubly linked message packs in director1."""
import hashlib
import json
import math
import re
import time
import uuid
from urllib.parse import urlsplit

from psycopg.types.json import Jsonb
from tornado.web import HTTPError
from backend.workspace import PrivateHandler, owned, ID


def batch_size(value):
    if type(value) is not int or not 25 <= value <= 100:
        raise HTTPError(400, reason='每包评论数需为 25–100 的整数')
    return value


def identifier(value):
    if not isinstance(value, str) or not ID.fullmatch(value):
        raise HTTPError(400, reason='评论或素材 ID 不正确')
    return value


def web_url(value):
    if not isinstance(value, str) or len(value) > 8000 or any(ord(c) < 33 for c in value):
        raise HTTPError(400, reason='请输入完整的 HTTP / HTTPS 图片或视频地址')
    try:
        parts = urlsplit(value)
        if parts.scheme not in ('http', 'https') or not parts.hostname or parts.username or parts.password:
            raise ValueError()
        parts.port
    except ValueError:
        raise HTTPError(400, reason='图片或视频地址格式不正确')
    return value


def review_data(value, media):
    if value is None:return None
    if not isinstance(value,dict) or value.get('kind')!=media:raise HTTPError(400,reason='标注类型与素材不一致')
    def number(n,lo=0,hi=1):
        return type(n) in (int,float) and math.isfinite(n) and lo<=n<=hi
    if media=='video':
        start,end=value.get('start'),value.get('end')
        if not number(start,0,86400) or not number(end,0,86400) or end<=start:raise HTTPError(400,reason='视频选段需为有效起止秒数，结束时间须大于开始时间')
        start,end=round(start,3),round(end,3)
        if end<=start:raise HTTPError(400,reason='视频选段至少需要 1 毫秒')
        return dict(kind='video',start=start,end=end)
    shapes=value.get('shapes')
    if not isinstance(shapes,list) or len(shapes)>50:raise HTTPError(400,reason='图片最多 50 处标注')
    result=[];point_count=0
    for shape in shapes:
        if not isinstance(shape,dict):raise HTTPError(400,reason='图片标注格式不正确')
        color=shape.get('color','#ff5c5c');width=shape.get('width',3)
        if not isinstance(color,str) or not re.fullmatch(r'#[0-9a-fA-F]{6}',color) or not number(width,1,10):raise HTTPError(400,reason='标注颜色或线宽不正确')
        item=dict(type=shape.get('type'),color=color,width=width)
        if item['type']=='rect':
            if not all(number(shape.get(k)) for k in ('x','y','w','h')) or shape['w']<=0 or shape['h']<=0 or shape['x']+shape['w']>1.000001 or shape['y']+shape['h']>1.000001:raise HTTPError(400,reason='框选范围须在图片内')
            item.update({k:round(shape[k],6) for k in ('x','y','w','h')})
        elif item['type']=='path':
            points=shape.get('points')
            if not isinstance(points,list) or not 2<=len(points)<=1000 or any(not isinstance(p,list) or len(p)!=2 or not all(number(n) for n in p) for p in points):raise HTTPError(400,reason='涂鸦坐标不正确')
            point_count+=len(points)
            if point_count>4000:raise HTTPError(400,reason='涂鸦点数过多，请简化标注')
            item['points']=[[round(n,6) for n in p] for p in points]
        else:raise HTTPError(400,reason='仅支持 SVG 框选或涂鸦坐标')
        result.append(item)
    return dict(kind='image',shapes=result)


async def attachment(handler, item, project_id):
    if not isinstance(item, dict):
        raise HTTPError(400, reason='附件格式不正确')
    source = item.get('source')
    if source == 'url':
        media = item.get('media') or str(item.get('mime','')).split('/')[0]
        if media not in ('image', 'video'):
            raise HTTPError(400, reason='地址附件需指定图片或视频')
        result=dict(source=source, url=web_url(item.get('url')), mime=media + '/*', name=str(item.get('name') or '地址附件')[:254]);mime=result['mime']
    elif source in ('asset', 'cloud'):
        asset_id = identifier(item.get('id'))
        row = await owned(handler.projects, asset_id, handler.owner, 'asset' if source == 'asset' else 'cloud_upload')
        b = row['body']
        if source == 'cloud' and (b.get('status') != 'completed' or b.get('project_id') != project_id):
            raise HTTPError(400, reason='请选择本项目已完成上传的云素材')
        mime = b['mime']
        result = dict(source=source, id=asset_id, mime=mime, name=b['name'], url='/api/assets/' + asset_id if source == 'asset' else b['url'])
    elif source == 'output':
        job_id = identifier(item.get('id'))
        row = await owned(handler.jobs, job_id, handler.owner, 'generation')
        b = row['body']; index = item.get('index')
        if b.get('project_id') != project_id or b.get('status') != 'completed' or type(index) is not int or not 0 <= index < len(b.get('outputs', [])):
            raise HTTPError(400, reason='请选择本项目已完成的生成结果')
        mime = 'video/mp4' if b['type'] == 'video' else 'image/png'
        result = dict(source=source, id=job_id, index=index, mime=mime, name=b['model'], url=f'/api/outputs/{job_id}/{index}')
    else:
        raise HTTPError(400, reason='未知附件来源')
    if mime.split('/')[0] not in ('image', 'video'):
        raise HTTPError(400, reason='评论附件仅支持图片和视频')
    review=review_data(item.get('review'),mime.split('/')[0])
    if review is not None:result['review']=review
    return result


class CreateChatHandler(PrivateHandler):
    async def post(self, project_id):
        await owned(self.projects, project_id, self.owner, 'project')
        data = self.data(); size = batch_size(data.get('batch_size', 50))
        # Client-generated IDs make creation retryable after a lost response.
        chat_id = identifier(data.get('chat_id'))
        body = dict(kind='chat', owner_id=self.owner, project_id=project_id, batch_size=size,
                    head_id=None, tail_id=None, message_count=0, pack_count=0)
        async with self.projects.connection() as conn:
            await conn.execute('INSERT INTO entities(block_id,body) VALUES (%s,%s) ON CONFLICT DO NOTHING', (chat_id, Jsonb(body)), block_id=chat_id)
        row = await owned(self.projects, chat_id, self.owner, 'chat')
        if row['body']['project_id'] != project_id:
            raise HTTPError(409, reason='评论区 ID 已使用')
        self.finish(row)


class ChatHandler(PrivateHandler):
    async def get(self, chat_id):
        self.finish(await owned(self.projects, chat_id, self.owner, 'chat'))

    async def post(self, chat_id):
        size = batch_size(self.data().get('batch_size'))
        async with self.projects.connection() as conn:
            row = await (await conn.execute("SELECT * FROM entities WHERE block_id=%s AND body->>'owner_id'=%s AND body->>'kind'='chat' FOR UPDATE", (chat_id, self.owner), block_id=chat_id)).fetchone()
            if not row:
                raise HTTPError(404)
            # Existing packs retain their capacity. New packs use the new setting.
            row = await (await conn.execute('UPDATE entities SET body=body || %s WHERE block_id=%s RETURNING *', (Jsonb({'batch_size':size}), chat_id), block_id=chat_id)).fetchone()
        self.finish(row)


class ChatMessagesHandler(PrivateHandler):
    async def get(self, chat_id):
        # Hold a consistent snapshot of the head/tail and one pack during appends.
        async with self.projects.connection() as conn:
            chat = await (await conn.execute("SELECT * FROM entities WHERE block_id=%s AND body->>'owner_id'=%s AND body->>'kind'='chat' FOR SHARE", (chat_id, self.owner), block_id=chat_id)).fetchone()
            if not chat:
                raise HTTPError(404)
            pack_id = self.get_query_argument('pack_id', None) or chat['body']['tail_id']
            pack = None
            if pack_id:
                identifier(pack_id)
                pack = await (await conn.execute("SELECT * FROM entities WHERE block_id=%s AND body->>'chat_id'=%s AND body->>'kind'='chat_pack' AND body->>'owner_id'=%s", (pack_id, chat_id, self.owner), block_id=pack_id)).fetchone()
                if not pack:
                    raise HTTPError(404)
        self.finish({'chat':chat, 'pack':pack})

    async def post(self, chat_id):
        data = self.data(); message_id = identifier(data.get('id'))
        content = data.get('content', ''); fmt = data.get('format', 'text'); items = data.get('attachments', [])
        if fmt not in ('text', 'markdown', 'html', 'rich') or not isinstance(content, str) or len(content) > 100000:
            raise HTTPError(400, reason='评论格式不正确或正文超过 100000 字符')
        if not isinstance(items, list) or len(items) > 10 or (not content.strip() and not items):
            raise HTTPError(400, reason='请输入评论或添加附件，每条最多 10 个附件')
        chat = await owned(self.projects, chat_id, self.owner, 'chat')
        attachments = [await attachment(self, item, chat['body']['project_id']) for item in items]
        fingerprint = hashlib.sha256(json.dumps([fmt,content,attachments], sort_keys=True, ensure_ascii=False).encode()).hexdigest()
        async with self.projects.connection() as conn:
            chat = await (await conn.execute("SELECT * FROM entities WHERE block_id=%s AND body->>'owner_id'=%s AND body->>'kind'='chat' FOR UPDATE", (chat_id,self.owner), block_id=chat_id)).fetchone()
            b = chat['body']
            existing = await (await conn.scan("SELECT body FROM entities WHERE body @> %s LIMIT 1", (Jsonb({'kind':'chat_pack','chat_id':chat_id,'messages':[{'id':message_id}]}),))).fetchone()
            if existing:
                message = next(m for m in existing['body']['messages'] if m['id']==message_id)
                if message['fingerprint'] != fingerprint:
                    raise HTTPError(409, reason='重复评论 ID 的内容不同，请刷新后重试')
                result = {'message':message, 'chat':chat, 'duplicate':True}
            else:
                pack = None
                if b['tail_id']:
                    pack = await (await conn.execute('SELECT * FROM entities WHERE block_id=%s', (b['tail_id'],), block_id=b['tail_id'])).fetchone()
                if not pack or len(pack['body']['messages']) >= pack['body']['capacity']:
                    pack_id = uuid.uuid4().hex
                    pack_body = dict(kind='chat_pack', owner_id=self.owner, project_id=b['project_id'], chat_id=chat_id,
                                     prev_id=b['tail_id'], next_id=None, capacity=b['batch_size'], messages=[])
                    if pack:
                        await conn.execute('UPDATE entities SET body=body || %s WHERE block_id=%s', (Jsonb({'next_id':pack_id}), pack['block_id']), block_id=pack['block_id'])
                    pack = await (await conn.execute('INSERT INTO entities(block_id,body) VALUES (%s,%s) RETURNING *', (pack_id,Jsonb(pack_body)), block_id=pack_id)).fetchone()
                    b['head_id'] = b['head_id'] or pack_id
                    b['tail_id'] = pack_id; b['pack_count'] += 1
                b['message_count'] += 1
                message = dict(id=message_id, seq=b['message_count'], author=self.user['login'], owner_id=self.owner,
                               created_at=time.time_ns()//1_000_000, format=fmt, content=content, attachments=attachments, fingerprint=fingerprint)
                pack['body']['messages'].append(message)
                await conn.execute('UPDATE entities SET body=%s WHERE block_id=%s', (Jsonb(pack['body']),pack['block_id']), block_id=pack['block_id'])
                chat = await (await conn.execute('UPDATE entities SET body=%s WHERE block_id=%s RETURNING *', (Jsonb(b),chat_id), block_id=chat_id)).fetchone()
                result = {'message':message, 'chat':chat, 'duplicate':False}
        self.finish(result)


class ChatMaterialsHandler(PrivateHandler):
    """Read one linked pack's media references without sending full comment bodies."""
    async def get(self,chat_id):
        chat=await owned(self.projects,chat_id,self.owner,'chat')
        pack_id=self.get_query_argument('pack_id',None) or chat['body']['tail_id']
        if not pack_id:
            self.finish({'pack_id':None,'prev_id':None,'sealed':True,'materials':[]});return
        identifier(pack_id)
        async with self.projects.connection() as conn:
            row=await (await conn.execute("SELECT body FROM entities WHERE block_id=%s AND body->>'chat_id'=%s AND body->>'kind'='chat_pack' AND body->>'owner_id'=%s",(pack_id,chat_id,self.owner), block_id=pack_id)).fetchone()
        if not row:raise HTTPError(404)
        b=row['body'];materials=[]
        for message in b['messages']:
            for index,item in enumerate(message['attachments']):
                materials.append(dict(attachment=item,message_id=message['id'],seq=message['seq'],index=index,text=message['content'][:500]))
        self.finish(dict(pack_id=pack_id,prev_id=b['prev_id'],sealed=len(b['messages'])>=b['capacity'],materials=materials))
