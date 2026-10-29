const BRIDGE = 'http://127.0.0.1:9225';
const SITES = {
  deepseek: { url: 'https://chat.deepseek.com/', match: 'https://chat.deepseek.com/*' },
  chatgpt: { url: 'https://chatgpt.com/', match: 'https://chatgpt.com/*', temp: '?temporary-chat=true' },
};
const DEFAULT_TIMEOUT = 300000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let running = false;
let chain = Promise.resolve();

async function loop() {
  if (running) return;
  running = true;
  while (true) {
    try {
      await chrome.runtime.getPlatformInfo(); // держит service worker живым
      const r = await fetch(BRIDGE + '/poll');
      const job = await r.json();
      if (job) chain = chain.then(() => handleJob(job)).catch(() => {});
    } catch (e) {
      await sleep(2000);
    }
  }
}

async function postResult(res) {
  try { await fetch(BRIDGE + '/result', { method: 'POST', body: JSON.stringify(res) }); } catch (e) {}
}

// ---------- сессии: имя -> { tabId, site, ph } ----------
async function getSessions() { return (await chrome.storage.local.get({ sessions: {} })).sessions; }
async function saveSessions(s) { await chrome.storage.local.set({ sessions: s }); }
function hash(str) { let h = 0; for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0; return String(h); }
async function tabAlive(id) { if (id == null) return null; try { return await chrome.tabs.get(id); } catch (e) { return null; } }
function siteUrl(site, temporary) { const c = SITES[site]; return c.url + (temporary && c.temp ? c.temp : ''); }

async function waitComplete(tabId) {
  for (let i = 0; i < 60; i++) {
    const t = await chrome.tabs.get(tabId);
    if (t.status === 'complete') return;
    await sleep(500);
  }
}

function navigate(tabId, url) {
  return new Promise((resolve) => {
    const done = () => { chrome.tabs.onUpdated.removeListener(l); resolve(); };
    const l = (id, info) => { if (id === tabId && info.status === 'complete') done(); };
    chrome.tabs.onUpdated.addListener(l);
    chrome.tabs.update(tabId, { url });
    setTimeout(done, 30000);
  });
}

async function waitContent(tabId) {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await chrome.tabs.sendMessage(tabId, { type: 'ping' });
      if (r && r.ok) return;
    } catch (e) {}
    await sleep(500);
  }
  throw new Error('content script not responding (reload the tab with F5 / reload the extension)');
}

async function createTab(site, temporary) {
  const tab = await chrome.tabs.create({ url: siteUrl(site, temporary), active: true });
  await waitComplete(tab.id);
  await waitContent(tab.id);
  return tab;
}

// ---------- запрос во вкладку: страница отвечает на снимки, ждёт и решает background (его таймеры не тормозятся) ----------
const STABLE = { deepseek: 1500, chatgpt: 1000 }; // пауза в тексте, после которой ответ считается готовым

async function endBadge(tabId, ok, error) {
  try { await chrome.tabs.sendMessage(tabId, { type: 'end', ok, error }); } catch (e) {}
}

async function askInTab(site, tabId, text, timeoutMs, stableOverride, askId, firstTimeout) {
  firstTimeout = firstTimeout || 120000; // сколько ждать появления ЛЮБОГО нового ответа
  const stableMs = stableOverride || STABLE[site] || 1500;

  // 1) отправить вопрос на странице (повторяем только пока вкладка не готова)
  let started = false, lastErr;
  for (let i = 0; i < 30; i++) {
    try {
      const r = await chrome.tabs.sendMessage(tabId, { type: 'start', askId, text });
      if (r && r.ok) { started = true; break; }
      if (r && r.ok === false) return { ok: false, error: r.error };
    } catch (e) {
      lastErr = e;
      if (!/Receiving end does not exist|Could not establish connection/i.test(String(e.message || e))) break;
    }
    await sleep(1000);
  }
  if (!started) return { ok: false, error: 'not delivered to page (reload the tab with F5): ' + ((lastErr && lastErr.message) || 'no response') };

  // 2) опрашивать страницу, пока ответ не появится и не перестанет меняться
  const t0 = Date.now();
  let last = '', lastChange = t0, firstMs = null, fails = 0, lastSnap = null;
  while (Date.now() - t0 < timeoutMs) {
    await sleep(200);
    let s;
    try { s = await chrome.tabs.sendMessage(tabId, { type: 'snap' }); fails = 0; }
    catch (e) {
      if (++fails >= 5) return { ok: false, error: 'page not responding (tab closed or reloaded)' };
      continue;
    }
    if (!s || !s.active) return { ok: false, error: 'page reloaded during request' };
    lastSnap = s.debug;
    const now = Date.now();
    if (!s.isNew) { // нового ответа ещё нет
      if (now - t0 > firstTimeout) {
        await endBadge(tabId, false, 'нет ответа');
        return { ok: false, error: `no new response appeared in ${Math.round((now - t0) / 1000)}s`, debug: lastSnap };
      }
      continue;
    }
    if (firstMs === null) firstMs = now - t0;
    if (s.text !== last) { last = s.text; lastChange = now; }
    if (last && !s.generating && now - lastChange > stableMs) {
      let blocks = [];
      try { const f = await chrome.tabs.sendMessage(tabId, { type: 'snap', blocks: true }); blocks = f.blocks || []; } catch (e) {}
      await endBadge(tabId, true);
      return { ok: true, text: last, codeBlocks: blocks, timing: { firstMs, lastChangeMs: lastChange - t0, totalMs: now - t0 } };
    }
  }
  await endBadge(tabId, false, 'timeout');
  return { ok: false, error: 'timeout', text: last, debug: lastSnap };
}

// ---------- извлечение: code / json ----------
function tryParse(s) {
  s = s.trim();
  try { return { v: JSON.parse(s) }; } catch (e) {}
  const a = s.search(/[\[{]/);
  const b = Math.max(s.lastIndexOf('}'), s.lastIndexOf(']'));
  if (a >= 0 && b > a) { try { return { v: JSON.parse(s.slice(a, b + 1)) }; } catch (e) {} }
  return null;
}

function applyExtract(res, mode) {
  if (!res.ok || !mode || mode === 'full') return res;
  const blocks = res.codeBlocks || [];
  if (mode === 'code') {
    if (!blocks.length) return { ...res, ok: false, error: 'no code block in reply', full: res.text };
    return { ...res, full: res.text, text: blocks[blocks.length - 1] };
  }
  if (mode === 'json') {
    for (const c of [...blocks].reverse().concat([res.text])) {
      const p = tryParse(c);
      if (p) return { ...res, full: res.text, text: JSON.stringify(p.v), data: p.v };
    }
    return { ...res, ok: false, error: 'json parse failed', full: res.text };
  }
  return res;
}

// ---------- ask / new_chat ----------
async function doAsk(job) {
  const tStart = Date.now();
  const { site: defSite } = await chrome.storage.local.get({ site: 'deepseek' });
  const site = job.site || defSite;
  if (!SITES[site]) throw new Error('unknown site: ' + site);
  const session = job.session || 'default';
  const prompt = job.prompt || '';
  const ph = prompt ? hash(prompt) : '';
  const timeoutMs = job.timeoutMs || DEFAULT_TIMEOUT;

  const sessions = await getSessions();
  const sess = sessions[session];

  let tab = sess && sess.site === site ? await tabAlive(sess.tabId) : null;
  let fresh = false;
  if (!tab) {
    if (session === 'default') {
      const tabs = await chrome.tabs.query({ url: SITES[site].match });
      if (tabs.length) tab = tabs[0];
    }
    if (!tab) { tab = await createTab(site, job.temporary); fresh = true; }
  }
  const known = !!(sess && sess.tabId === tab.id && sess.site === site);
  const needNew = job.chat === 'new' || (!!prompt && (!known || sess.ph !== ph));

  if (job.focus !== false) await chrome.tabs.update(tab.id, { active: true });
  if (needNew && !fresh) {
    await navigate(tab.id, siteUrl(site, job.temporary));
    await waitContent(tab.id);
  }

  let text = job.text || '';
  let promptReply;
  if (needNew && prompt) {
    if (job.promptMode === 'merge' && !job.onlyInit) {
      text = prompt + '\n\n' + text;
    } else {
      const pr = await askInTab(site, tab.id, prompt, timeoutMs, job.stableMs, job.id + 'p', job.firstTimeoutMs);
      if (!pr.ok) throw new Error('prompt failed: ' + pr.error);
      promptReply = pr.text;
    }
  }

  sessions[session] = { tabId: tab.id, site, ph };
  await saveSessions(sessions);

  if (job.onlyInit) return { ok: true, session, newChat: needNew, promptReply };
  if (!text) throw new Error('empty text');

  const prepMs = Date.now() - tStart;
  let res = await askInTab(site, tab.id, text, timeoutMs, job.stableMs, job.id + 'm', job.firstTimeoutMs);
  res = applyExtract(res, job.extract);
  delete res.codeBlocks;
  res.timing = { pickupMs: job.queuedAt ? tStart - job.queuedAt : null, prepMs, ...res.timing };
  return { ...res, session, newChat: needNew, promptReply };
}

async function handleJob(job) {
  const keep = setInterval(() => chrome.runtime.getPlatformInfo(), 20000);
  try {
    let out;
    if (job.cmd === 'ask') out = await doAsk(job);
    else if (job.cmd === 'new_chat') out = await doAsk({ ...job, chat: 'new', onlyInit: true });
    else if (job.cmd === 'close') {
      const s = await getSessions();
      const name = job.session || 'default';
      if (s[name]) { try { await chrome.tabs.remove(s[name].tabId); } catch (e) {} delete s[name]; await saveSessions(s); }
      out = { ok: true };
    } else if (job.cmd === 'sessions') out = { ok: true, sessions: await getSessions() };
    else throw new Error('unknown cmd: ' + job.cmd);
    await postResult({ id: job.id, ...out });
  } catch (e) {
    await postResult({ id: job.id, ok: false, error: String(e.message || e) });
  } finally {
    clearInterval(keep);
  }
}

chrome.alarms.create('keepalive', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(loop);
chrome.runtime.onStartup.addListener(loop);
chrome.runtime.onInstalled.addListener(loop);
loop();
