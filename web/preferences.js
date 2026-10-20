(() => {
  let mode = 'system', locale = null;
  try { mode = localStorage.getItem('hakei.theme') || mode; locale = localStorage.getItem('hakei.locale'); } catch {}
  if (!['light', 'dark', 'system'].includes(mode)) mode = 'system';
  if (!['zh-CN', 'en'].includes(locale)) {
    const language = navigator.languages.find(value => /^(zh|en)(-|$)/i.test(value));
    locale = language && /^zh(-|$)/i.test(language) ? 'zh-CN' : 'en';
  }
  const root = document.documentElement;
  root.dataset.themeMode = mode;
  root.dataset.theme = mode === 'system' ? matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light' : mode;
  root.lang = locale;
})();
