import asyncio
import hashlib
import secrets
import time
import uuid

from argon2 import PasswordHasher
from argon2.exceptions import VerifyMismatchError, VerificationError, InvalidHashError

HASHER = PasswordHasher()
DUMMY_HASH = HASHER.hash(secrets.token_urlsafe(32))


def normalize_login(login):
    if not isinstance(login, str):
        raise ValueError('账号格式不正确')
    login = login.strip().lower()
    if not login or len(login) > 254:
        raise ValueError('账号长度须为 1–254 个字符')
    return login


def validate_password(password):
    if not isinstance(password, str) or not 12 <= len(password) <= 256:
        raise ValueError('密码长度须为 12–256 个字符')


def verify_password(encoded, password):
    try:
        return HASHER.verify(encoded, password)
    except (VerifyMismatchError, VerificationError, InvalidHashError):
        return False


def token_hash(token):
    return hashlib.sha256(token.encode()).hexdigest()


async def create_user(pool, login, password, first_only=False):
    login = normalize_login(login)
    validate_password(password)
    encoded = await asyncio.to_thread(HASHER.hash, password)
    user_id = uuid.uuid4().hex
    async with pool.connection() as conn:
        if first_only:
            await conn.execute('SELECT pg_advisory_xact_lock(804512320)')
            existing = await conn.execute('SELECT 1 FROM index_login LIMIT 1')
            if await existing.fetchone():
                raise ValueError('初始账号已经创建')
        await conn.execute('INSERT INTO index_login(login,user_id) VALUES (%s,%s)', (login, user_id))
        await conn.execute('INSERT INTO auth_credentials(user_id,password_hash) VALUES (%s,%s)', (user_id, encoded))
    return user_id


async def authenticate(pool, login, password):
    async with pool.connection() as conn:
        result = await conn.execute('SELECT l.user_id,l.login,c.password_hash FROM index_login l JOIN auth_credentials c USING(user_id) WHERE l.login=%s', (login,))
        user = await result.fetchone()
    valid = await asyncio.to_thread(verify_password, user['password_hash'] if user else DUMMY_HASH, password)
    if not valid or not user:
        return None
    token = secrets.token_urlsafe(32)
    now = time.time_ns() // 1_000_000
    async with pool.connection() as conn:
        await conn.execute('DELETE FROM auth_sessions WHERE expires_at<=%s', (now,))
        await conn.execute('INSERT INTO auth_sessions(token_hash,user_id,expires_at) VALUES (%s,%s,%s)',
                           (token_hash(token), user['user_id'], now + 86400000))
    return token
