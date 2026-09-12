const form = document.querySelector('#login-form');
const message = document.querySelector('#message');
let setup = false;
async function api(path, body) {
  const headers = {};
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    headers['X-XSRFToken'] = decodeURIComponent(document.cookie.split('; ').find(x => x.startsWith('_xsrf='))?.slice(6) || '');
  }
  const response = await fetch(path, {method: body === undefined ? 'GET' : 'POST', headers, body: body === undefined ? undefined : JSON.stringify(body)});
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '请求失败');
  return data;
}
async function refresh() {
  try {
    const user = await api('/api/me');
    document.querySelector('#identity').textContent = `当前账号：${user.login}`;
    document.querySelector('#login-panel').hidden = true;
    document.querySelector('#workspace').hidden = false;
    await window.directorStudio.enter(user);
  } catch {
    window.directorStudio.leave();
    document.querySelector('#login-panel').hidden = false;
    document.querySelector('#workspace').hidden = true;
  }
}
form.addEventListener('submit', async event => {
  event.preventDefault();
  const button = form.querySelector('button');
  button.disabled = true;
  message.textContent = '';
  try {
    const values = Object.fromEntries(new FormData(form));
    if (setup) {
      await api('/api/setup', values); setup = false;
      document.querySelector('#login-panel h2').textContent = '登录工作空间';
      document.querySelector('#login-panel .form-intro').textContent = '回到创作现场，让故事继续。';
      form.querySelector('button').textContent = '登录';
      form.password.removeAttribute('minlength'); form.password.autocomplete = 'current-password';
    }
    await api('/api/login', values); form.password.value = ''; await refresh();
  }
  catch (error) { message.textContent = error.message; }
  finally { button.disabled = false; }
});
document.querySelector('#logout').addEventListener('click', async () => {
  try { await api('/api/logout', {}); await refresh(); }
  catch (error) { document.querySelector('#identity').textContent = error.message; }
});
async function initialize() {
  try {
    const state = await api('/api/setup');
    setup = state.can_setup;
    if (setup) {
      document.querySelector('#login-panel h2').textContent = '创建第一个账号';
      document.querySelector('#login-panel .form-intro').textContent = '建立你的工作空间，开始下一部作品。';
      form.querySelector('button').textContent = '创建并登录';
      form.password.minLength = 12;
      form.password.autocomplete = 'new-password';
      message.textContent = '设置你自己的账号和密码（至少 12 个字符）。';
    } else if (state.needs_setup) {message.textContent = '请在桌面应用中创建首个账号，或运行 npm run user:create。';}
    await refresh();
  } catch {message.textContent = '无法连接本地服务，请重新启动应用。';}
}
initialize();
