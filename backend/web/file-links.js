(() => {
  'use strict';
  // 在桌面端（Electron）中，让文档里出现的 file:// 地址点击后直接在 Finder 定位。
  // 仅当存在桌面桥接（window.directorDesktop.revealFile）时才拦截，避免影响纯网页环境。
  const hasBridge = () => !!(window.directorDesktop && typeof window.directorDesktop.revealFile === 'function');
  const isFileHref = href => typeof href === 'string' && href.startsWith('file://');

  document.addEventListener('click', async (event) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const anchor = event.target && event.target.closest ? event.target.closest('a[href^="file://"]') : null;
    if (!anchor) return;
    const href = anchor.getAttribute('href');
    if (!isFileHref(href)) return;
    if (!hasBridge()) return; // 非桌面环境：交给默认行为（会被 will-navigate 拦截，安全无副作用）
    event.preventDefault();
    try { await window.directorDesktop.revealFile(href); } catch (error) { /* 忽略定位失败 */ }
  }, true);
})();
