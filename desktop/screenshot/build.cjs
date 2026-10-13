const fs = require('node:fs');
const path = require('node:path');
const {execFileSync} = require('node:child_process');

function build() {
  const source = path.join(__dirname, 'native/capture.m');
  const output = path.join(__dirname, 'bin/capture-macos');
  fs.mkdirSync(path.dirname(output), {recursive: true});
  if (process.platform !== 'darwin') return null;
  if (fs.existsSync(output) && fs.statSync(output).mtimeMs >= fs.statSync(source).mtimeMs) return output;
  const temporary = `${output}.${process.pid}.tmp`;
  try {
    execFileSync('/usr/bin/clang', ['-O2', '-fobjc-arc', '-fblocks', '-arch', 'arm64', '-arch', 'x86_64',
      '-mmacosx-version-min=11.0', source, '-framework', 'Cocoa', '-framework', 'CoreGraphics',
      '-framework', 'CoreImage', '-framework', 'IOSurface', '-o', temporary], {stdio: 'pipe', timeout: 120000});
    execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', temporary], {stdio: 'pipe', timeout: 30000});
    fs.renameSync(temporary, output);
    return output;
  } finally { fs.rmSync(temporary, {force: true}); }
}
module.exports = {build};
if (require.main === module) { try { console.log(build() || 'macOS helper not needed on this platform'); } catch (error) { console.error('截图组件构建失败，请安装 Xcode Command Line Tools。', error.message); process.exitCode = 1; } }
