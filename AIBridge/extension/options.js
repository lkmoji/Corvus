const sel = document.getElementById('site');
chrome.storage.local.get({ site: 'deepseek' }).then((v) => (sel.value = v.site));
sel.addEventListener('change', async () => {
  await chrome.storage.local.set({ site: sel.value });
  document.getElementById('st').textContent = 'сохранено';
  setTimeout(() => (document.getElementById('st').textContent = ''), 1500);
});

const wsel = document.getElementById('workers');
chrome.storage.local.get({ forumWorkers: 1 }).then((v) => (wsel.value = String(v.forumWorkers)));
wsel.addEventListener('change', async () => {
  await chrome.storage.local.set({ forumWorkers: parseInt(wsel.value, 10) });
  document.getElementById('st').textContent = 'сохранено';
  setTimeout(() => (document.getElementById('st').textContent = ''), 1500);
});

const msel = document.getElementById('mode');
chrome.storage.local.get({ forumMode: 'file' }).then((v) => (msel.value = v.forumMode));
msel.addEventListener('change', () => chrome.storage.local.set({ forumMode: msel.value }));
