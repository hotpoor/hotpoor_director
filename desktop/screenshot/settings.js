const api = window.screenCapture;
const enabled = document.querySelector('#enabled');
const accelerator = document.querySelector('#accelerator');
const status = document.querySelector('#status');
const priority = document.querySelector('#priority');
const owner = document.querySelector('#owner');
let dirty = false;
document.querySelector('#settings').addEventListener('input', () => { dirty = true; });
const renderOwner = state => { owner.textContent = !state.enabled ? '全局截图快捷键已停用' : `当前负责监听：${state.owner || '正在协调…'}${state.active ? '（本应用）' : ''}`; };
const showError = error => { status.textContent = error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, ''); };
api.state().then(state => {
  enabled.checked = state.enabled; accelerator.value = state.accelerator; priority.value = state.priority;
  renderOwner(state);
  status.textContent = state.error || (state.registered ? '快捷键监听已开启。' : state.enabled ? '本应用待命，负责监听的应用退出后自动接管。' : '快捷键监听已停用。');
}).catch(showError);
accelerator.addEventListener('keydown', event => {
  if (event.key === 'Tab') return;
  if (!event.metaKey && !event.ctrlKey && !event.altKey) return;
  // Keep copy/paste and select-all available for manually entered accelerators.
  if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && ['a','c','v','x'].includes(event.key.toLowerCase())) return;
  event.preventDefault();
  let key = /^Key[A-Z]$/.test(event.code) ? event.code.slice(3) : /^Digit[0-9]$/.test(event.code) ? event.code.slice(5) : event.code === 'Space' ? 'Space' : event.key;
  if (!/^(?:[A-Z0-9]|F(?:[1-9]|1[0-9]|2[0-4])|Space|PrintScreen)$/.test(key)) return;
  accelerator.value = [event.metaKey && 'Command', event.ctrlKey && 'Control', event.altKey && 'Alt', event.shiftKey && 'Shift', key].filter(Boolean).join('+');
});
document.querySelector('#settings').addEventListener('submit', async event => {
  event.preventDefault();
  const save = document.querySelector('#save'); save.disabled = true;
  status.textContent = '正在与负责监听的应用同步…';
  try { const state = await api.save({enabled: enabled.checked, accelerator: accelerator.value, priority: Number(priority.value)}); dirty = false; accelerator.value = state.accelerator; renderOwner(state); status.textContent = state.error || '已保存，产品线其他应用将在两秒内同步。'; }
  catch (error) { showError(error); }
  finally { save.disabled = false; }
});
document.querySelector('#capture').addEventListener('click', async event => {
  event.target.disabled = true; status.textContent = '正在截图…';
  try { const image = await api.capture(); status.textContent = `已复制到剪贴板（${image.width} × ${image.height}）。`; }
  catch (error) { showError(error); }
  finally { event.target.disabled = false; }
});
api.onStatus(message => { status.textContent = message; });
const poll = setInterval(() => api.state().then(state => {
  renderOwner(state);
  if (!dirty) { enabled.checked = state.enabled; accelerator.value = state.accelerator; priority.value = state.priority; }
  if (state.error) status.textContent = state.error;
}).catch(() => {}), 2000);
window.addEventListener('unload', () => clearInterval(poll));
