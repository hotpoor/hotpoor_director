from PyInstaller.utils.hooks import collect_all

datas = [('backend/schema', 'backend/schema'), ('backend/web', 'backend/web')]
binaries = []
hiddenimports = []
for package in ('psycopg', 'psycopg_binary', 'psycopg_pool', 'argon2', '_argon2_cffi_bindings'):
    data, binary, hidden = collect_all(package)
    datas += data
    binaries += binary
    hiddenimports += hidden
a = Analysis(['backend/entrypoint.py'], pathex=['.'], binaries=binaries, datas=datas, hiddenimports=hiddenimports)
pyz = PYZ(a.pure)
exe = EXE(pyz, a.scripts, [], exclude_binaries=True, name='director-backend', console=True)
coll = COLLECT(exe, a.binaries, a.datas, name='director-backend')
