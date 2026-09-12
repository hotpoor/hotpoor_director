import ctypes
import json
import os
from pathlib import Path
import secrets
import subprocess

ROOT = Path(__file__).resolve().parent.parent
DATABASES = ('hotpoor_director', 'hotpoor_director1', 'hotpoor_director2')


def load_config():
    default_directory = ROOT / '.local'
    previous_directory = Path(os.environ.get('APPDATA', '')) / 'hotpoor-director'
    if os.name == 'nt' and not (default_directory / 'config.json').exists() and (previous_directory / 'config.json').exists():
        default_directory = previous_directory
    directory = Path(os.environ.get('DIRECTOR_DATA_DIR', default_directory)).resolve()
    directory.mkdir(parents=True, exist_ok=True)
    if os.name == 'nt':
        account = os.environ['USERDOMAIN'] + '\\' + os.environ['USERNAME']
        subprocess.run(['icacls', str(directory), '/grant:r', account + ':(OI)(CI)F', '/inheritance:r'],
                       check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
                       creationflags=subprocess.CREATE_NO_WINDOW)
    path = directory / 'config.json'
    if not path.exists():
        value = {
            'postgres': {'mode': 'embedded', 'host': '127.0.0.1', 'port': 55432,
                         'admin_user': 'director_owner', 'admin_password': secrets.token_urlsafe(32),
                         'user': 'director_app', 'password': secrets.token_urlsafe(32)},
            'cookie_secret': secrets.token_urlsafe(48),
        }
        with path.open('x', encoding='utf-8') as stream:
            json.dump(value, stream, indent=2)
        path.chmod(0o600)
    if os.name == 'nt':
        for target in (directory, path):
            attributes = ctypes.windll.kernel32.GetFileAttributesW(str(target))
            if not ctypes.windll.kernel32.SetFileAttributesW(str(target), attributes | 2):
                raise ctypes.WinError()
    value = json.loads(path.read_text(encoding='utf-8'))
    if not value.get('cookie_secret') or not value['postgres'].get('password'):
        raise ValueError('Configure cookie_secret and PostgreSQL password in config.json')
    value['data_dir'] = directory
    value['pg_bin'] = Path(os.environ.get('DIRECTOR_PG_BIN', ROOT / 'runtime' / 'pgsql' / 'bin'))
    return value


def connection_kwargs(config, database, admin=False):
    pg = config['postgres']
    return dict(host=pg['host'], port=pg['port'], dbname=database,
                user=pg['admin_user'] if admin else pg['user'],
                password=pg['admin_password'] if admin else pg['password'],
                connect_timeout=10)
