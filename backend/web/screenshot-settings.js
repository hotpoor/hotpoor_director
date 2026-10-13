(() => {
  const button = document.querySelector('#open-screenshot-settings');
  if (!button || !window.directorDesktop?.screenshotSettings) return;
  button.hidden = false;
  button.addEventListener('click', async () => {
    try { await window.directorDesktop.screenshotSettings(); }
    catch (error) { button.title = error.message; }
  });
})();
