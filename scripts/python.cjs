const {spawnSync} = require('node:child_process');
const path = require('node:path');
const python = path.resolve(__dirname, '..', '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const result = spawnSync(python, process.argv.slice(2), {stdio:'inherit', windowsHide:true});
if (result.error) {console.error('先创建 .venv 并安装 requirements-dev.txt。'); console.error(result.error.message);}
process.exit(result.status ?? 1);
