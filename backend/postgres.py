import os
from pathlib import Path
import subprocess
import tempfile


class Postgres:
    def __init__(self, config):
        self.config = config
        self.started = False
        self.data = config['data_dir'] / 'postgres'

    def run(self, name, *arguments, check=True):
        executable = self.config['pg_bin'] / (name + ('.exe' if os.name == 'nt' else ''))
        # pg_ctl's detached server inherits handles on Windows: pipes never reach EOF.
        with tempfile.TemporaryFile() as output, tempfile.TemporaryFile() as error:
            result = subprocess.run([str(executable), *map(str, arguments)], check=False,
                                    stdout=output, stderr=error,
                                    creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
            output.seek(0)
            error.seek(0)
            result.stdout = output.read().decode('utf-8', errors='replace')
            result.stderr = error.read().decode('utf-8', errors='replace')
        if check and result.returncode:
            raise RuntimeError(f'{name} failed: {result.stderr.strip()} {result.stdout.strip()}')
        return result

    def start(self):
        pg = self.config['postgres']
        if pg['mode'] != 'embedded':
            return
        if pg['host'] != '127.0.0.1':
            raise ValueError('Embedded PostgreSQL must listen on 127.0.0.1')
        if not (self.data / 'PG_VERSION').exists():
            password_file = self.config['data_dir'] / '.pg-init-password'
            with password_file.open('x', encoding='utf-8') as stream:
                stream.write(pg['admin_password'])
            password_file.chmod(0o600)
            try:
                self.run('initdb', '-D', self.data, '-U', pg['admin_user'], '--encoding=UTF8',
                         '--locale=C', '--auth=scram-sha-256', '--pwfile', password_file)
            finally:
                password_file.unlink(missing_ok=True)
        if self.run('pg_ctl', '-D', self.data, 'status', check=False).returncode == 0:
            return
        self.run('pg_ctl', '-D', self.data, '-l', self.config['data_dir'] / 'postgres.log',
                 '-o', f"-h 127.0.0.1 -p {int(pg['port'])} -c max_prepared_transactions=32", '-w', 'start')
        self.started = True

    def stop(self):
        if self.started:
            self.run('pg_ctl', '-D', self.data, '-m', 'fast', '-t', '120', '-w', 'stop')
            self.started = False
