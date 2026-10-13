// Only registers a single accelerator; never observes or stores other keystrokes.
function validate(value) {
  if (!value || typeof value.enabled !== 'boolean' || typeof value.accelerator !== 'string') throw Error('快捷键设置不正确');
  const accelerator = value.accelerator.trim();
  const parts = accelerator.split('+');
  const modifiers = new Set(['Command', 'Control', 'Alt', 'Shift', 'CommandOrControl']);
  if (accelerator.length > 100 || parts.length < 2 || parts.slice(0, -1).some(p => !modifiers.has(p)) ||
      new Set(parts.slice(0, -1)).size !== parts.length - 1 || !parts.slice(0, -1).some(p => p !== 'Shift') ||
      !/^(?:[A-Z0-9]|F(?:[1-9]|1[0-9]|2[0-4])|Space|PrintScreen)$/.test(parts.at(-1))) {
    throw Error('请设置包含 Command / Control / Alt 的组合键，例如 Command+Shift+D');
  }
  const normalized = new Set(parts.slice(0, -1).map(part => part === 'CommandOrControl' ? (process.platform === 'darwin' ? 'Command' : 'Control') : part));
  return {enabled: value.enabled, accelerator: [...['Command', 'Control', 'Alt', 'Shift'].filter(part => normalized.has(part)), parts.at(-1)].join('+')};
}
function createShortcut({globalShortcut, initial, onCapture, persist, active: initiallyActive = true}) {
  let config = validate(initial), registered = '', error = '', active = initiallyActive;
  const bind = key => { try { return globalShortcut.register(key, onCapture); } catch { return false; } };
  if (config.enabled && active) {
    if (bind(config.accelerator)) registered = config.accelerator;
    else error = '快捷键已被占用或系统不允许注册，请在截图设置中更换。';
  }
  const state = () => ({...config, registered: !!registered, error, active});
  return {
    state,
    save(value, write = true) {
      const next = validate(value), old = registered;
      const target = next.enabled && active ? next.accelerator : '';
      if (target && target !== old && !bind(target)) throw Error('快捷键已被占用或系统不允许注册，原设置已保留。');
      try { if (write) persist(next); } catch (e) { if (target && target !== old) globalShortcut.unregister(target); throw e; }
      if (old && old !== target) globalShortcut.unregister(old);
      config = next; registered = target; error = '';
      return state();
    },
    setActive(value) {
      active = value;
      if (!active) { if (registered) globalShortcut.unregister(registered); registered = ''; error = ''; }
      else if (config.enabled && !registered) {
        if (bind(config.accelerator)) { registered = config.accelerator; error = ''; }
        else error = '快捷键已被占用，正在等待释放；也可设置其他组合键。';
      }
      return state();
    },
    dispose() { if (registered) globalShortcut.unregister(registered); registered = ''; }
  };
}
module.exports = {validate, createShortcut};
