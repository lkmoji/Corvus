const sel = document.getElementById('site');
chrome.storage.local.get({ site: 'deepseek' }).then((v) => (sel.value = v.site));
sel.addEventListener('change', async () => {
  await chrome.storage.local.set({ site: sel.value });
  document.getElementById('st').textContent = 'сохранено';
  setTimeout(() => (document.getElementById('st').textContent = ''), 1500);
});
