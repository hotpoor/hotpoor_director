"""Scoped browser-direct uploads and authenticated reads of owned cloud images."""
import asyncio
import hashlib
import ipaddress
import json
import os
import re
import socket
import time
import uuid
from urllib.parse import quote, urlsplit, urljoin

from psycopg.types.json import Jsonb
from tornado.httpclient import AsyncHTTPClient, HTTPRequest
import tornado.web

from backend.workspace import PrivateHandler, owned

PROVIDERS = {
    'qiniu': dict(name='七牛 Kodo', key_label='AccessKey（AK）', secret_label='SecretKey（SK）',
        regions=[['z0','华东 · 浙江'],['cn-east-2','华东 · 浙江2'],['z1','华北 · 河北'],['z2','华南 · 广东'],['as0','亚太 · 新加坡'],['na0','北美 · 洛杉矶']],
        bucket_hint='七牛空间名称', domain_required=True,
        help='七牛使用 AccessKey / SecretKey，不是 AppID / AppSecret。必须填写已绑定空间的公网访问域名。'),
    'aliyun': dict(name='阿里云 OSS', key_label='AccessKeyId', secret_label='AccessKeySecret',
        regions=[['cn-hangzhou','华东1 · 杭州'],['cn-shanghai','华东2 · 上海'],['cn-beijing','华北2 · 北京'],['cn-shenzhen','华南1 · 深圳'],['cn-hongkong','中国香港'],['ap-southeast-1','新加坡']],
        bucket_hint='OSS Bucket 名称', domain_required=False,
        help='填写 RAM 用户的 AccessKeyId / AccessKeySecret。域名可留空，使用 Bucket 公网访问地址。'),
    'tencent': dict(name='腾讯云 COS', key_label='SecretId', secret_label='SecretKey',
        regions=[['ap-guangzhou','广州'],['ap-shanghai','上海'],['ap-beijing','北京'],['ap-chengdu','成都'],['ap-hongkong','中国香港'],['ap-singapore','新加坡']],
        bucket_hint='完整名称，例如 my-bucket-1250000000', domain_required=False,
        help='使用 SecretId / SecretKey；Bucket 必须包含 APPID 后缀，例如 my-bucket-1250000000，无需另填 AppSecret。'),
}
TTL=600
MIMES={'image/png':'.png','image/jpeg':'.jpg','image/webp':'.webp','video/mp4':'.mp4','video/webm':'.webm',
       'audio/mpeg':'.mp3','audio/mp3':'.mp3','audio/wav':'.wav','audio/x-wav':'.wav','audio/ogg':'.ogg',
       'audio/mp4':'.m4a','audio/x-m4a':'.m4a','audio/webm':'.webm'}


class StorageError(Exception):
    pass


def load(config):
    path=config['data_dir']/'.cloud-storage.json'
    return json.loads(path.read_text()) if path.exists() else {'active_provider':None,'profiles':{}}


def save(config, value):
    path=config['data_dir']/'.cloud-storage.json'
    temporary=path.with_name('.cloud-storage-'+uuid.uuid4().hex+'.tmp')
    try:
        fd=os.open(temporary,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
        with os.fdopen(fd,'w') as stream:json.dump(value,stream,ensure_ascii=False,indent=2)
        os.replace(temporary,path)
    finally:temporary.unlink(missing_ok=True)


def endpoint(provider, region):
    if provider=='qiniu':return f'https://up-{region}.qiniup.com'
    if provider=='aliyun':return f'https://oss-{region}.aliyuncs.com'
    if provider=='tencent':return f'https://cos.{region}.myqcloud.com'
    raise ValueError('请选择存储厂商')


def origin(value):
    if not isinstance(value,str):raise ValueError('域名格式不正确')
    value=value.strip().rstrip('/')
    if '://' not in value:value='https://'+value
    parts=urlsplit(value)
    if parts.scheme not in ('http','https') or not parts.hostname or parts.username or parts.password or parts.query or parts.fragment or parts.path or parts.port not in (None,80,443):
        raise ValueError('请输入域名或完整 http(s) 域名，不带路径、参数或账号密码')
    host=parts.hostname.lower()
    if not re.fullmatch(r'[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?',host) or '.' not in host or host.endswith(('.local','.localhost')):
        raise ValueError('请填写公网域名')
    try:
        if not ipaddress.ip_address(host).is_global:raise ValueError('请填写公网域名')
    except ValueError as error:
        if str(error)=='请填写公网域名':raise
    return f'{parts.scheme}://{parts.netloc.lower()}'


def normalize_prefix(value):
    if not isinstance(value,str):raise ValueError('路径前缀格式不正确')
    value=value.strip().strip('/')
    if not value:return ''
    if len(value.encode('utf-8'))>512 or not re.fullmatch(r'[\w ./-]+',value):
        raise ValueError('路径前缀请使用文字、数字、空格、下划线、连字符和斜杠，不包含 URL 或参数')
    parts=[part for part in value.split('/') if part]
    if any(part.strip() in ('.','..','') for part in parts):raise ValueError('路径前缀不能包含 . 或 .. 目录')
    return '/'.join(parts)


def object_key(profile,owner,upload_id,mime,project_id=None):
    # Preserve the layout of profiles saved before configurable prefixes existed.
    prefix=profile.get('path_prefix',f'director/references/{owner}')
    return '/'.join(filter(None,[prefix,project_id,upload_id+MIMES[mime]]))


def normalize(data, previous=None):
    provider=data.get('provider')
    if provider not in PROVIDERS:raise ValueError('请选择七牛、阿里云或腾讯云')
    previous=previous or {}
    value={'provider':provider}
    for key in ('access_key_id','access_key_secret'):
        raw=data.get(key) or previous.get(key,'')
        if not isinstance(raw,str) or not 5<=len(raw.strip())<=4096 or any(c.isspace() for c in raw.strip()):raise ValueError('请填写完整的访问密钥；留空只能保留当前配置已保存的密钥')
        value[key]=raw.strip()
    bucket=data.get('bucket_name','')
    if not isinstance(bucket,str) or not re.fullmatch(r'[a-z0-9][a-z0-9-]{1,61}[a-z0-9]',bucket):raise ValueError('Bucket 名称需为 3–63 位小写字母、数字或连字符')
    if provider=='tencent' and not re.fullmatch(r'[a-z0-9][a-z0-9-]*-\d{5,20}',bucket):raise ValueError('腾讯云 Bucket 必须包含 APPID 后缀，如 my-bucket-1250000000')
    region=data.get('region','')
    if not isinstance(region,str) or not re.fullmatch(r'[a-z][a-z0-9-]{1,40}',region):raise ValueError('请填写地域代码')
    if provider=='qiniu' and region not in ('z0','z1','z2','cn-east-2','as0','na0','ap-southeast-2','ap-southeast-3'):raise ValueError('请选择支持的七牛存储区域')
    ep=origin(data.get('endpoint') or endpoint(provider,region))
    suffix={'qiniu':'.qiniup.com','aliyun':'.aliyuncs.com','tencent':'.myqcloud.com'}[provider]
    if not ep.startswith('https://') or not urlsplit(ep).hostname.endswith(suffix):raise ValueError('上传 Endpoint 必须使用当前厂商官方 HTTPS 地址')
    # Endpoint is a service address, not a bucket domain. Prevent double bucket prefixes.
    host=urlsplit(ep).hostname
    if provider=='aliyun' and not host.startswith('oss-'):raise ValueError('OSS Endpoint 请填写 oss-地域.aliyuncs.com，不包含 Bucket')
    if provider=='tencent' and not host.startswith('cos.'):raise ValueError('COS Endpoint 请填写 cos.地域.myqcloud.com，不包含 Bucket')
    domain=data.get('domain','')
    if not isinstance(domain,str):raise ValueError('访问域名格式不正确')
    domain=origin(domain) if domain.strip() else ''
    if provider=='qiniu' and not domain:raise ValueError('七牛必须填写已绑定空间的访问域名')
    value.update(bucket_name=bucket,region=region,endpoint=ep,domain=domain,
        path_prefix=normalize_prefix(data.get('path_prefix',previous.get('path_prefix','director/references'))))
    return value


def access_domain(profile):
    return profile['domain'] or 'https://'+profile['bucket_name']+'.'+urlsplit(profile['endpoint']).netloc


def active_id(value):
    return value.get('active_profile_id', value.get('active_provider'))


def public_view(value):
    profiles={}
    for profile_id,p in value['profiles'].items():
        profiles[profile_id]={k:v for k,v in p.items() if k not in ('access_key_id','access_key_secret')}
        profiles[profile_id].update(id=profile_id,name=p.get('name') or PROVIDERS[p['provider']]['name'],credentials_configured=bool(p.get('access_key_id') and p.get('access_key_secret')),access_domain=access_domain(p))
    selected=active_id(value)
    return dict(active_profile_id=selected,active_provider=value['profiles'].get(selected,{}).get('provider'),profiles=profiles,providers=PROVIDERS)


def fingerprint(profile):
    return hashlib.sha256(json.dumps({k:v for k,v in profile.items() if k not in ('name','id')},sort_keys=True).encode()).hexdigest()


def aliyun(profile):
    import oss2
    return oss2.Bucket(oss2.AuthV4(profile['access_key_id'],profile['access_key_secret']),profile['endpoint'],profile['bucket_name'],region=profile['region'],connect_timeout=15)


def tencent(profile):
    from qcloud_cos import CosConfig,CosS3Client
    return CosS3Client(CosConfig(Region=profile['region'],SecretId=profile['access_key_id'],SecretKey=profile['access_key_secret'],
        Scheme='https',Endpoint=urlsplit(profile['endpoint']).netloc,Timeout=15,AllowRedirects=False))


def qiniu_manager(profile):
    import qiniu
    return qiniu.BucketManager(qiniu.Auth(profile['access_key_id'],profile['access_key_secret']),preferred_scheme='https')


def sign_upload(profile,key,mime,size):
    headers={'Content-Type':mime}
    if profile['provider']=='qiniu':
        import qiniu
        token=qiniu.Auth(profile['access_key_id'],profile['access_key_secret']).upload_token(profile['bucket_name'],key,TTL,
            policy={'insertOnly':1,'fsizeLimit':size,'mimeLimit':mime})
        return dict(method='POST',url=profile['endpoint'],fields={'token':token,'key':key},headers={})
    if profile['provider']=='aliyun':
        url=aliyun(profile).sign_url('PUT',key,TTL,headers=headers)
    else:
        url=tencent(profile).get_presigned_url(Bucket=profile['bucket_name'],Key=key,Method='PUT',Expired=TTL,Headers=headers.copy())
    return dict(method='PUT',url=url,headers=headers)


def probe(profile):
    try:
        if profile['provider']=='qiniu':
            _,info=qiniu_manager(profile).stat(profile['bucket_name'],'director/connection-check-'+uuid.uuid4().hex)
            if info.status_code not in (200,612):raise StorageError('七牛鉴权或空间访问失败')
        elif profile['provider']=='aliyun':aliyun(profile).get_bucket_info()
        else:tencent(profile).head_bucket(Bucket=profile['bucket_name'])
    except Exception:
        raise StorageError('无法访问存储空间，请检查密钥、Bucket、地域和读取权限；配置未改动') from None


def verify_object(profile,key,size,mime):
    try:
        if profile['provider']=='qiniu':
            result,info=qiniu_manager(profile).stat(profile['bucket_name'],key)
            if info.status_code!=200:raise ValueError()
            actual_size,actual_mime=result['fsize'],result['mimeType']
        elif profile['provider']=='aliyun':
            result=aliyun(profile).head_object(key)
            actual_size,actual_mime=result.content_length,result.content_type
        else:
            result=tencent(profile).head_object(Bucket=profile['bucket_name'],Key=key)
            actual_size,actual_mime=int(result['Content-Length']),result['Content-Type']
        if actual_size!=size or actual_mime.split(';')[0]!=mime:raise ValueError()
    except Exception:
        raise StorageError('未能确认文件上传完成，或大小/类型不一致；请检查对象读取权限后重试') from None


async def verify_public(url,size):
    try:
        for _ in range(5):
            parts=urlsplit(url)
            if parts.scheme not in ('http','https') or not parts.hostname or parts.username or parts.password or parts.port not in (None,80,443):raise ValueError()
            addresses=await asyncio.get_running_loop().getaddrinfo(parts.hostname,parts.port or (443 if parts.scheme=='https' else 80),type=socket.SOCK_STREAM)
            if not addresses or any(not ipaddress.ip_address(item[4][0]).is_global for item in addresses):raise ValueError()
            response=await AsyncHTTPClient().fetch(HTTPRequest(url,method='HEAD',connect_timeout=5,request_timeout=15,follow_redirects=False),raise_error=False)
            if response.code in (301,302,303,307,308):
                url=urljoin(url,response.headers['Location']);continue
            if response.code!=200 or int(response.headers.get('Content-Length',-1))!=size:raise ValueError()
            return url
        raise ValueError()
    except Exception:
        raise StorageError('文件已上传，但公网访问验证未通过；请检查域名绑定、DNS、公开读取与防盗链设置，再重试确认') from None


class StorageSettingsHandler(PrivateHandler):
    async def get(self):self.finish(public_view(load(self.settings['config'])))

    async def post(self):
        data=self.data()
        async with self.settings['storage_lock']:
            value=load(self.settings['config'])
            value['active_profile_id']=active_id(value)
            action=data.get('action','disable' if data.get('disable') else 'clear' if data.get('clear') else 'save')
            if action not in ('save','select','clear','disable'):
                raise tornado.web.HTTPError(400,reason='未知配置操作')
            # Missing ID supports the previous one-profile-per-provider API.
            profile_id=data.get('id',data.get('provider'))
            if profile_id is not None and not isinstance(profile_id,str):raise tornado.web.HTTPError(400,reason='配置 ID 不正确')
            previous=value['profiles'].get(profile_id)
            if action in ('select','clear') and not previous:
                raise tornado.web.HTTPError(404,reason='存储配置不存在')
            if action=='disable':value['active_profile_id']=None
            elif action=='select':value['active_profile_id']=profile_id
            elif action=='clear':
                value['profiles'].pop(profile_id)
                if value['active_profile_id']==profile_id:value['active_profile_id']=None
            else:
                if profile_id and not previous and profile_id not in PROVIDERS:
                    raise tornado.web.HTTPError(404,reason='存储配置不存在')
                if previous and previous['provider']!=data.get('provider'):
                    raise tornado.web.HTTPError(400,reason='更换厂商请添加一套新配置')
                try:
                    profile=normalize(data,previous)
                    name=data.get('name',previous.get('name') if previous else None) or PROVIDERS[profile['provider']]['name']
                    if not isinstance(name,str) or not 1<=len(name.strip())<=80:raise ValueError('配置名称需为 1–80 个字符')
                    profile['name']=name.strip()
                except ValueError as error:raise tornado.web.HTTPError(400,reason=str(error))
                if not previous and len(value['profiles'])>=50:raise tornado.web.HTTPError(400,reason='最多保存 50 套云存储配置')
                profile_id=profile_id or uuid.uuid4().hex
                value['profiles'][profile_id]=profile
                if data.get('activate',True) is True:value['active_profile_id']=profile_id
            selected=value['profiles'].get(value['active_profile_id'])
            value['active_provider']=selected['provider'] if selected else None
            save(self.settings['config'],value)
        self.finish(public_view(value))


class StorageTestHandler(PrivateHandler):
    async def post(self):
        data=self.data();profile_id=data.get('id',data.get('provider'))
        if profile_id is not None and not isinstance(profile_id,str):raise tornado.web.HTTPError(400,reason='配置 ID 不正确')
        previous=load(self.settings['config'])['profiles'].get(profile_id)
        if previous and previous['provider']!=data.get('provider'):previous=None
        try:
            profile=normalize(data,previous)
            await asyncio.to_thread(probe,profile)
        except (ValueError,StorageError) as error:raise tornado.web.HTTPError(400,reason=str(error))
        self.finish({'ok':True,'note':'空间读取验证通过；直传还需配置 CORS，可用小文件验证上传和公网访问。'})


class UploadGrantHandler(PrivateHandler):
    async def post(self):
        data=self.data();value=load(self.settings['config'])
        profile_id=active_id(value);profile=value['profiles'].get(profile_id)
        if not profile:raise tornado.web.HTTPError(400,reason='请先在云存储设置中保存并启用一套配置')
        if self.settings['config'].get('cloud_mode') and not access_domain(profile).startswith('https://'):
            raise tornado.web.HTTPError(400, reason='服务器版云存储访问域名必须使用 HTTPS')
        mime,size,name=data.get('mime'),data.get('size'),data.get('name')
        if mime not in MIMES or not isinstance(size,int) or isinstance(size,bool) or not 1<=size<=(20 if mime.startswith('image/') else 200)*1024*1024 or not isinstance(name,str) or not 1<=len(name)<=255:
            raise tornado.web.HTTPError(400,reason='请选择图片（20 MB 内）、视频或音频（200 MB 内）')
        digest=data.get('md5');project_id=data.get('project_id')
        if not isinstance(digest,str) or not re.fullmatch(r'[0-9a-f]{32}',digest):raise tornado.web.HTTPError(400,reason='缺少有效的文件 MD5')
        if project_id is not None:
            if not isinstance(project_id,str) or not re.fullmatch(r'[0-9a-f]{32}',project_id):raise tornado.web.HTTPError(400,reason='项目编号格式不正确')
            await owned(self.projects,project_id,self.owner,'project')
        key=object_key(profile,self.owner,digest,mime,project_id)
        upload_id=hashlib.sha256(json.dumps([self.owner,project_id,fingerprint(profile),key,mime,size]).encode()).hexdigest()[:32]
        async with self.projects.connection() as conn:
            existing=await (await conn.execute('SELECT body FROM entities WHERE block_id=%s',(upload_id,), block_id=upload_id)).fetchone()
        if existing and existing['body'].get('status')=='completed':
            self.finish({'reused':True,'asset':upload_result(upload_id,existing['body'])});return
        try:grant=await asyncio.to_thread(sign_upload,profile,key,mime,size)
        except Exception:raise tornado.web.HTTPError(502,reason='生成直传凭证失败，请检查存储配置') from None
        url=access_domain(profile)+'/'+quote(key,safe='/')
        body=dict(kind='cloud_upload',owner_id=self.owner,profile_id=profile_id,provider=profile['provider'],profile_fingerprint=fingerprint(profile),
                  key=key,url=url,mime=mime,size=size,name=name,md5=digest,project_id=project_id,status='pending',expires_at=int(time.time())+TTL)
        async with self.projects.connection() as conn:
            await conn.execute('INSERT INTO entities(block_id,body) VALUES (%s,%s) ON CONFLICT (block_id) DO NOTHING',(upload_id,Jsonb(body)), block_id=upload_id)
        # Only short-lived, single-object credentials cross into the renderer.
        self.finish(dict(upload_id=upload_id,provider=profile['provider'],expires_in=TTL,upload=grant))


def upload_result(upload_id,body):
    return {'id':upload_id,'url':body['url'],'name':body['name'],'mime':body['mime'],'size':body['size'],'storage':'cloud','provider':body['provider']}


class UploadConfirmHandler(PrivateHandler):
    async def post(self,upload_id):
        row=await owned(self.projects,upload_id,self.owner,'cloud_upload');body=row['body']
        if body['status']=='completed':
            self.finish(upload_result(upload_id,body));return
        profile=load(self.settings['config'])['profiles'].get(body.get('profile_id',body['provider']))
        if not profile or fingerprint(profile)!=body['profile_fingerprint']:
            raise tornado.web.HTTPError(409,reason='本次上传所用配置已更改或删除，请恢复原配置后重试确认')
        # Confirmation is still allowed after a grant expires: large uploads may finish later.
        try:
            await asyncio.to_thread(verify_object,profile,body['key'],body['size'],body['mime'])
            body['url']=await verify_public(body['url'],body['size']) or body['url']
        except StorageError as error:raise tornado.web.HTTPError(502,reason=str(error))
        async with self.projects.connection() as conn:
            await conn.execute("UPDATE entities SET body=body || %s WHERE block_id=%s",(Jsonb({'status':'completed','url':body['url']}),upload_id), block_id=upload_id)
        self.finish(upload_result(upload_id,body))


async def read_cloud_image(body):
    url=body['url']
    try:
        for _ in range(5):
            parts=urlsplit(url)
            if parts.scheme not in ('http','https') or not parts.hostname or parts.username or parts.password or parts.port not in (None,80,443):raise ValueError()
            addresses=await asyncio.get_running_loop().getaddrinfo(parts.hostname,parts.port or (443 if parts.scheme=='https' else 80),type=socket.SOCK_STREAM)
            if not addresses or any(not ipaddress.ip_address(item[4][0]).is_global for item in addresses):raise ValueError()
            chunks=[];size=0
            def receive(chunk):
                nonlocal size
                size+=len(chunk)
                if size>20*1024*1024:raise ValueError()
                chunks.append(chunk)
            response=await AsyncHTTPClient().fetch(HTTPRequest(url,method='GET',connect_timeout=5,request_timeout=60,follow_redirects=False,streaming_callback=receive),raise_error=False)
            if response.code in (301,302,303,307,308):url=urljoin(url,response.headers['Location']);continue
            if response.code!=200 or size!=body['size']:raise ValueError()
            raw=b''.join(chunks)
            if body.get('md5') and hashlib.md5(raw).hexdigest()!=body['md5']:raise ValueError()
            return raw
        raise ValueError()
    except Exception:
        raise StorageError('无法读取云存储原图，请检查文件是否存在、域名访问权限和网络后重试') from None


class CloudImageHandler(PrivateHandler):
    async def get(self,upload_id):
        row=await owned(self.projects,upload_id,self.owner,'cloud_upload');body=row['body']
        if body.get('status')!='completed' or body.get('mime') not in ('image/png','image/jpeg','image/webp'):
            raise tornado.web.HTTPError(400,reason='只能复制已确认上传的图片')
        try:raw=await read_cloud_image(body)
        except StorageError as error:raise tornado.web.HTTPError(502,reason=str(error))
        self.set_header('Content-Type',body['mime'])
        self.set_header('Content-Length',len(raw))
        self.finish(raw)


async def store_generated(config, pool, job, raw, mime, name, phase):
    """Persist generated media to the job's original profile, on desktop and online."""
    profile_id = job['storage_profile_id']
    profile = load(config)['profiles'].get(profile_id)
    if not profile or fingerprint(profile) != job['storage_profile_fingerprint']:
        raise StorageError('生成结果所用云存储配置已更改或删除，请恢复原配置后重试')
    owner = job.get('credential_owner', job['owner_id'])
    project_id = job['project_id']
    digest = hashlib.md5(raw).hexdigest()
    key = object_key(profile, owner, digest, mime, project_id)
    upload_id = hashlib.sha256(json.dumps([owner, project_id, fingerprint(profile), key, mime, len(raw)]).encode()).hexdigest()[:32]
    url = access_domain(profile) + '/' + quote(key, safe='/')
    body = dict(kind='cloud_upload', owner_id=owner, profile_id=profile_id, provider=profile['provider'],
                profile_fingerprint=fingerprint(profile), key=key, url=url, mime=mime, size=len(raw),
                name=name, md5=digest, project_id=project_id, status='pending', expires_at=int(time.time())+TTL)

    async def transport(path, data):
        if path == '/api/storage/uploads':
            async with pool.connection() as conn:
                existing = await (await conn.execute('SELECT body FROM entities WHERE block_id=%s', (upload_id,), block_id=upload_id)).fetchone()
            if existing and existing['body'].get('status') == 'completed':
                return {'reused': True, 'asset': upload_result(upload_id, existing['body'])}
            grant = await asyncio.to_thread(sign_upload, profile, key, mime, len(raw))
            async with pool.connection() as conn:
                await conn.execute('INSERT INTO entities(block_id,body) VALUES (%s,%s) ON CONFLICT (block_id) DO NOTHING',
                                   (upload_id, Jsonb(body)), block_id=upload_id)
            await phase('uploading_output')
            return {'upload_id': upload_id, 'provider': profile['provider'], 'upload': grant}
        if path != '/api/storage/uploads/' + upload_id + '/confirm':
            raise StorageError('未知转存步骤')
        await phase('verifying_output')
        await asyncio.to_thread(verify_object, profile, key, len(raw), mime)
        body['url'] = await verify_public(url, len(raw)) or url
        async with pool.connection() as conn:
            await conn.execute('UPDATE entities SET body=body || %s WHERE block_id=%s',
                               (Jsonb({'status': 'completed', 'url': body['url']}), upload_id), block_id=upload_id)
        return upload_result(upload_id, body)

    from backend.sync import upload_bytes
    async def progress(sent, total):
        await phase('uploading_output', bytes=sent, total_bytes=total)
    return await upload_bytes({}, raw, mime, name, transport=transport, progress=progress)


async def fetch_generated_video(config, pool, job, url, name, phase):
    """Let Qiniu fetch large videos directly; other providers use streamed transfer."""
    profile_id = job.get('storage_profile_id')
    if not profile_id: return None
    profile = load(config)['profiles'].get(profile_id)
    if not profile or fingerprint(profile) != job['storage_profile_fingerprint']:
        raise StorageError('生成结果所用云存储配置已更改或删除，请恢复原配置后重试')
    if profile['provider'] != 'qiniu': return None
    from backend.inference import public_url
    public_url(url)
    owner = job.get('credential_owner', job['owner_id'])
    key = object_key(profile, owner, name, 'video/mp4', job['project_id'])
    await phase('fetching_output')
    def fetch():
        manager = qiniu_manager(profile)
        existing, info = manager.stat(profile['bucket_name'], key)
        if info.status_code == 200: return existing
        result, info = manager.fetch(url, profile['bucket_name'], key)
        if info.status_code != 200 or not isinstance(result, dict): return None
        return result
    try:
        result = await asyncio.to_thread(fetch)
    except Exception:
        # A timed-out fetch can still finish at the provider. The stable key is
        # checked before another fetch on retry; never resubmit generation.
        return None
    if not result: return None
    size = result.get('fsize')
    if not isinstance(size, int) or not 1 <= size <= 210 * 1024 * 1024:
        raise StorageError('云存储抓取的生成视频大小异常')
    await phase('verifying_output')
    await asyncio.to_thread(verify_object, profile, key, size, 'video/mp4')
    public = access_domain(profile) + '/' + quote(key, safe='/')
    public = await verify_public(public, size) or public
    upload_id = hashlib.sha256(json.dumps([owner, fingerprint(profile), key]).encode()).hexdigest()[:32]
    body = dict(kind='cloud_upload', owner_id=owner, project_id=job['project_id'], profile_id=profile_id,
                provider='qiniu', profile_fingerprint=fingerprint(profile), key=key, url=public,
                name=name, mime='video/mp4', size=size, status='completed', transfer='remote_fetch')
    async with pool.connection() as conn:
        await conn.execute('INSERT INTO entities(block_id,body) VALUES (%s,%s) ON CONFLICT (block_id) DO NOTHING',
                           (upload_id, Jsonb(body)), block_id=upload_id)
    return {'remote_url': public, 'mime':'video/mp4', 'size':size, 'storage':'cloud', 'transfer':'remote_fetch'}
