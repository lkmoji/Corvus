const BRIDGE = 'http://127.0.0.1:9225';
const SITES = {
  deepseek: { url: 'https://chat.deepseek.com/', match: 'https://chat.deepseek.com/*' },
  chatgpt: { url: 'https://chatgpt.com/', match: 'https://chatgpt.com/*', temp: '?temporary-chat=true' },
};
const DEFAULT_TIMEOUT = 300000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let running = false;
const chains = new Map();       // имя сессии -> цепочка заданий (внутри сессии порядок сообщений важен, между сессиями работаем параллельно)
let activeJobs = 0;             // сколько ask выполняется прямо сейчас (для решения, можно ли переключать фокус вкладки)

function enqueue(job) {
  const key = String(job.session || 'default');
  const next = (chains.get(key) || Promise.resolve()).then(() => handleJob(job)).catch(() => {});
  chains.set(key, next);
  next.then(() => { if (chains.get(key) === next) chains.delete(key); });
}

async function loop() {
  if (running) return;
  running = true;
  while (true) {
    try {
      await chrome.runtime.getPlatformInfo(); // держит service worker живым
      const r = await fetch(BRIDGE + '/poll');
      const job = await r.json();
      if (job) enqueue(job);
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
let sessLock = Promise.resolve();
function updateSessions(fn) {   // read-modify-write хранилища сессий строго по очереди
  const p = sessLock.then(async () => { const s = await getSessions(); fn(s); await saveSessions(s); });
  sessLock = p.catch(() => {});
  return p;
}
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
  activeJobs++;
  try { return await doAskInner(job); } finally { activeJobs--; }
}
async function doAskInner(job) {
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

  if (job.focus !== false && activeJobs <= 1) await chrome.tabs.update(tab.id, { active: true });
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

  await updateSessions((all) => { all[session] = { tabId: tab.id, site, ph }; });

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
      if (s[name]) { try { await chrome.tabs.remove(s[name].tabId); } catch (e) {} await updateSessions((all) => { delete all[name]; }); }
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

// ============================================================================
//  ПАРСЕР ЗАКОНОВ С ФОРУМА (УК / АК / ПДД)
//  forum.js присылает текст страницы -> режем на части -> каждая часть уходит в отдельную вкладку DeepSeek (параллельно)
//  -> JSON глав и статей -> склеиваем -> отправляем мосту (POST /doc) -> скрипт Corvus забирает документ у моста.
// ============================================================================
const FORUM_WORKERS = 3;       // вкладок DeepSeek одновременно
const FORUM_CHUNK = 9000;      // символов текста в одной части
let forumBusy = false;

function forumPrompt(kind) {
  const head = 'Ты — парсер законодательной базы игрового сервера Arizona RP (GTA SAMP). Ниже фрагмент текста с форума. Преврати его в JSON для игрового помощника.\n\n';
  const common = 'ПРАВИЛА:\n' +
    '- Ответ: ТОЛЬКО JSON-массив, без пояснений, без markdown и без текста до или после.\n' +
    '- Верхний уровень — массив глав: [{"name":"...","item":[...]}].\n' +
    '- name — название главы или раздела как в тексте (например "Глава 2. Преступления против личности"). Если фрагмент начинается без заголовка главы (это продолжение предыдущей), поставь name = "" (пустая строка).\n' +
    '- Статьи идут в item в том же порядке, что и в тексте. Не пропускай статьи и не выдумывай того, чего нет в тексте.\n' +
    '- reason — номер и название статьи как в оригинале (например "Статья 2.1. Убийство"). Если у статьи несколько частей с разными наказаниями, каждая часть — отдельный элемент с reason вида "Статья 2.1 ч.2. Убийство".\n' +
    '- text — 1–2 коротких предложения: что считается нарушением и важные условия. Без воды, без повторения названия статьи, без форматирования.\n' +
    '- Если во фрагменте нет ни одной статьи, верни [].\n';
  const fmt = {
    uk: 'ФОРМАТ item: {"lvl":"3","reason":"...","text":"..."}\n- lvl — степень (уровень) розыска от 1 до 6, которую статья даёт нарушителю, строкой-цифрой. Если розыск в статье не указан — "0".\n',
    ak: 'ФОРМАТ item: {"lvl":"...","reason":"...","text":"..."}\n- lvl — наказание кратко одной строкой (например "Штраф 5000$" или "Арест 10 мин"). Если наказание не указано — "".\n',
    pdd: 'ФОРМАТ item: {"amount":50000,"reason":"...","text":"..."}\n- amount — сумма штрафа числом без пробелов и знаков валюты. Если суммы нет — 0.\n',
  }[kind];
  return head + common + fmt + '\nТЕКСТ ДЛЯ РАЗБОРА:\n';
}

function splitChunks(text, max) {      // режем по строкам; по возможности — перед заголовком главы/статьи
  const isHead = (l) => /^\s*(глава|раздел|статья|ст\.)\s*[\d\.]*/i.test(l) || /^\s*\d+\.\d+/.test(l);
  const chunks = [];
  let cur = '';
  const flush = () => { if (cur.trim()) chunks.push(cur.trim()); cur = ''; };
  for (let line of String(text).split('\n')) {
    while (line.length > max) {                         // гигантская строка без переносов — режем жёстко
      if (cur) flush();
      chunks.push(line.slice(0, max));
      line = line.slice(max);
    }
    if (cur.length + line.length + 1 > max) flush();
    else if (cur.length > max * 0.7 && isHead(line)) flush();
    cur += line + '\n';
  }
  flush();
  return chunks;
}

function mergeChapters(parts) {         // части приходят по порядку; пустое имя главы = продолжение предыдущей
  const out = [];
  for (const part of parts) {
    const arr = Array.isArray(part) ? part : (part && Array.isArray(part.chapters) ? part.chapters : []);
    for (const ch of arr) {
      if (!ch || !Array.isArray(ch.item)) continue;
      const name = String(ch.name || '').trim();
      let target = out.length ? out[out.length - 1] : null;
      if (name && (!target || target.name !== name)) { target = { name, item: [] }; out.push(target); }
      else if (!target) { target = { name: 'Общее', item: [] }; out.push(target); }
      for (const it of ch.item) target.item.push(it);
    }
  }
  return out;
}

function normalizeDoc(kind, parts) {    // приводим к формату, который читает Lua (SmartUK / SmartPDD)
  const out = [];
  for (const ch of mergeChapters(parts)) {
    const items = [];
    for (const it of ch.item) {
      if (!it || typeof it !== 'object') continue;
      const reason = String(it.reason || '').trim();
      if (!reason) continue;
      const text = String(it.text || '').replace(/\s+/g, ' ').trim();
      if (kind === 'pdd') {
        const amount = parseInt(String(it.amount == null ? '' : it.amount).replace(/[^\d]/g, ''), 10);
        if (!Number.isFinite(amount)) continue;         // Lua требует числовую сумму
        items.push({ reason, amount, text });
      } else {
        items.push({ lvl: String(it.lvl == null ? '' : it.lvl).trim(), reason, text });
      }
    }
    if (items.length) out.push({ name: ch.name, item: items });
  }
  return out;
}

function forumStatus(tabId, payload) {
  try { chrome.tabs.sendMessage(tabId, { type: 'forum_status', ...payload }).catch(() => {}); } catch (e) {}
}

async function runForumParse(tabId, req) {
  if (forumBusy) return forumStatus(tabId, { phase: 'error', error: 'Парсинг уже идёт, дождитесь окончания' });
  forumBusy = true;
  const keep = setInterval(() => chrome.runtime.getPlatformInfo(), 20000);
  try {
    const kind = String(req.kind || '').toLowerCase();
    if (!['uk', 'ak', 'pdd'].includes(kind)) throw new Error('неизвестный тип документа');
    try { await fetch(BRIDGE + '/docs'); } catch (e) { throw new Error('мост не запущен (запустите bridge.bat) — результат некуда сохранить'); }

    const chunks = splitChunks(req.text, FORUM_CHUNK);
    if (!chunks.length) throw new Error('на странице не нашлось текста');
    const prompt = forumPrompt(kind);
    const results = new Array(chunks.length);
    let next = 0, done = 0, failed = null;
    forumStatus(tabId, { phase: 'ai', done: 0, total: chunks.length });

    const worker = async (w) => {
      while (!failed) {
        const i = next++;
        if (i >= chunks.length) return;
        for (let attempt = 1; ; attempt++) {
          try {
            const r = await doAsk({ id: 'f' + Date.now() + '_' + i, queuedAt: Date.now(), site: 'deepseek', session: 'forum_' + w,
              chat: 'new', prompt, promptMode: 'merge', text: chunks[i], extract: 'json', timeoutMs: 240000 });
            if (!r.ok) throw new Error(r.error || 'нет ответа');
            results[i] = r.data;
            break;
          } catch (e) {
            if (attempt >= 2) { failed = `часть ${i + 1}/${chunks.length}: ${String(e.message || e)}`; return; }
          }
        }
        done++;
        forumStatus(tabId, { phase: 'ai', done, total: chunks.length });
      }
    };
    await Promise.all(Array.from({ length: Math.min(FORUM_WORKERS, chunks.length) }, (_, w) => worker(w + 1)));
    if (failed) throw new Error('ИИ не справился: ' + failed);

    const data = normalizeDoc(kind, results);
    if (!data.length) throw new Error('ИИ не вернул ни одной статьи — проверьте, что открыта страница с текстом закона');
    forumStatus(tabId, { phase: 'save' });
    const r = await fetch(BRIDGE + '/doc', { method: 'POST', body: JSON.stringify({ kind, meta: { title: req.title, url: req.url }, data }) });
    const info = await r.json();
    if (!info.ok) throw new Error('мост не принял документ: ' + info.error);
    forumStatus(tabId, { phase: 'done', kind, chapters: info.chapters, items: info.items });
  } catch (e) {
    forumStatus(tabId, { phase: 'error', error: String(e.message || e) });
  } finally {
    clearInterval(keep);
    forumBusy = false;
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'forum_start' && sender.tab) {
    runForumParse(sender.tab.id, msg);
    sendResponse({ ok: true });
  }
  return false;
});

chrome.alarms.create('keepalive', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(loop);
chrome.runtime.onStartup.addListener(loop);
chrome.runtime.onInstalled.addListener(loop);
loop();
