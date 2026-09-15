// Promise-based dialogs in the browser top layer, including above other modals.
(() => {
  let queue = Promise.resolve();
  function open(kind, message, options = {}) {
    const show = () => new Promise(resolve => {
      const previous = document.activeElement;
      const dialog = document.createElement('dialog');
      dialog.className = 'director-message-dialog';
      dialog.setAttribute('aria-labelledby', 'director-message-title');
      dialog.setAttribute('aria-describedby', 'director-message-body');
      dialog.innerHTML = '<form method="dialog"><h2 id="director-message-title"></h2><p id="director-message-body"></p><input aria-label="输入内容" hidden><div class="director-message-actions"><button type="button" class="quiet" data-cancel>取消</button><button type="submit" data-accept>确定</button></div></form>';
      dialog.querySelector('h2').textContent = options.title || (kind === 'confirm' ? '确认操作' : kind === 'prompt' ? '请输入' : '提示');
      dialog.querySelector('p').textContent = String(message ?? '');
      const input = dialog.querySelector('input');
      input.hidden = kind !== 'prompt';
      input.value = options.value ?? '';
      const cancel = dialog.querySelector('[data-cancel]');
      cancel.hidden = kind === 'alert';
      cancel.textContent = options.cancelLabel || '取消';
      dialog.querySelector('[data-accept]').textContent = options.acceptLabel || '确定';
      let result = kind === 'prompt' ? null : false;
      cancel.onclick = () => dialog.close();
      dialog.querySelector('form').onsubmit = event => {
        event.preventDefault();
        result = kind === 'prompt' ? input.value : true;
        dialog.close();
      };
      dialog.addEventListener('cancel', event => {
        if (options.dismissible === false) event.preventDefault();
      });
      dialog.addEventListener('close', () => {
        dialog.remove();
        if (previous?.isConnected) previous.focus({preventScroll:true});
        resolve(result);
      }, {once:true});
      document.body.append(dialog);
      dialog.showModal();
      (kind === 'prompt' ? input : kind === 'confirm' ? cancel : dialog.querySelector('[data-accept]')).focus();
      if (kind === 'prompt') input.select();
    });
    const pending = queue.then(show);
    queue = pending.catch(() => {});
    return pending;
  }
  window.directorDialogs = Object.freeze({
    alert: (message, options) => open('alert', message, options),
    confirm: (message, options) => open('confirm', message, options),
    prompt: (message, options) => open('prompt', message, options),
  });
})();
