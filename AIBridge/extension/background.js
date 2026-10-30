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

async function createTab(site, temporary, ownWindow) {
  let tab;
  if (ownWindow) { // отдельное окно: вкладка в нём считается видимой, и страница не «замирает» в фоне
    const w = await chrome.windows.create({ url: siteUrl(site, temporary), focused: false, type: 'normal', width: 900, height: 760 });
    tab = w.tabs[0];
  } else tab = await chrome.tabs.create({ url: siteUrl(site, temporary), active: true });
  await waitComplete(tab.id);
  await waitContent(tab.id);
  return tab;
}

// ---------- запрос во вкладку: страница отвечает на снимки, ждёт и решает background (его таймеры не тормозятся) ----------
const STABLE = { deepseek: 2500, chatgpt: 1000 }; // пауза в тексте, после которой ответ считается готовым

async function endBadge(tabId, ok, error) {
  try { await chrome.tabs.sendMessage(tabId, { type: 'end', ok, error }); } catch (e) {}
}

async function askInTab(site, tabId, text, timeoutMs, stableOverride, askId, firstTimeout, needJson, waitSend) {
  firstTimeout = firstTimeout || 120000; // сколько ждать появления ЛЮБОГО нового ответа
  const stableMs = stableOverride || STABLE[site] || 1500;

  // 1) отправить вопрос на странице (повторяем только пока вкладка не готова)
  let started = false, lastErr;
  for (let i = 0; i < 30; i++) {
    try {
      const r = await chrome.tabs.sendMessage(tabId, { type: 'start', askId, text, waitSend: !!waitSend });
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
        return { ok: false, error: `no new response appeared in ${Math.round((now - t0) / 1000)}s (${JSON.stringify(lastSnap)})`, debug: lastSnap };
      }
      continue;
    }
    if (firstMs === null) firstMs = now - t0;
    if (s.text !== last) { last = s.text; lastChange = now; }
    if (last && !s.generating && now - lastChange > stableMs) {
      let blocks = [];
      try { const f = await chrome.tabs.sendMessage(tabId, { type: 'snap', blocks: true }); blocks = f.blocks || []; } catch (e) {}
      // ИИ мог просто замолчать посреди длинного JSON: пока ответ не разбирается как JSON, продолжаем ждать
      if (needJson && !blocks.concat([last]).some((c) => tryParse(c)) && now - lastChange < 60000) continue;
      await endBadge(tabId, true);
      return { ok: true, text: last, codeBlocks: blocks, timing: { firstMs, lastChangeMs: lastChange - t0, totalMs: now - t0 } };
    }
  }
  await endBadge(tabId, false, 'timeout');
  return { ok: false, error: `timeout (ответ ${last.length} симв., ${JSON.stringify(lastSnap)})`, text: last, debug: lastSnap };
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

// Спасение битого JSON: ИИ часто ломает кавычки внутри строк или обрывает ответ. Вытаскиваем всё, что разбирается по отдельности.
function salvage(text) {
  const out = [];
  let cur = null, nameRe = /"name"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
  const names = [];
  let m;
  while ((m = nameRe.exec(text))) names.push({ pos: m.index, name: m[1] });
  const nameAt = (pos) => { let n = ''; for (const x of names) { if (x.pos <= pos) n = x.name; else break; } return n; };
  const objAt = (i) => {            // сбалансированный {...} с учётом строк
    let d = 0, inStr = false;
    for (let j = i; j < text.length; j++) {
      const c = text[j];
      if (inStr) { if (c === '\\') j++; else if (c === '"') inStr = false; continue; }
      if (c === '"') inStr = true;
      else if (c === '{') d++;
      else if (c === '}' && --d === 0) return j;
    }
    return -1;
  };
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '{') continue;
    const e = objAt(i);
    if (e < 0) continue;
    let o = null;
    try { o = JSON.parse(text.slice(i, e + 1)); } catch (err) {}
    if (o && Array.isArray(o.item)) { out.push({ name: String(o.name || ''), item: o.item }); cur = null; i = e; }
    else if (o && o.reason) {
      const nm = nameAt(i);
      if (!cur || cur.name !== nm) { cur = { name: nm, item: [] }; out.push(cur); }
      cur.item.push(o); i = e;
    }
  }
  return out.length ? out : null;
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
    const sv = salvage(res.text);
    if (sv) return { ...res, full: res.text, text: JSON.stringify(sv), data: sv, salvaged: true };
    const t = String(res.text || '');
    return { ...res, ok: false, full: res.text, error: `ответ ИИ не JSON (${t.length} симв.). Начало: «${t.slice(0, 160).replace(/\s+/g, ' ')}» … конец: «${t.slice(-100).replace(/\s+/g, ' ')}»` };
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
    if (!tab) { tab = await createTab(site, job.temporary, job.ownWindow); fresh = true; }
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
      const pr = await askInTab(site, tab.id, prompt, timeoutMs, job.stableMs, job.id + 'p', job.firstTimeoutMs, false);
      if (!pr.ok) throw new Error('prompt failed: ' + pr.error);
      promptReply = pr.text;
    }
  }

  await updateSessions((all) => { all[session] = { tabId: tab.id, site, ph }; });

  if (job.onlyInit) return { ok: true, session, newChat: needNew, promptReply };
  if (!text) throw new Error('empty text');

  const prepMs = Date.now() - tStart;
  if (job.attach) {                                    // прикрепляем файл с текстом (один раз за чат)
    let ok = false, err = '';
    for (let i = 0; i < 20 && !ok; i++) {
      try {
        const a = await chrome.tabs.sendMessage(tab.id, { type: 'attach', name: job.attach.name, text: job.attach.text });
        if (a && a.ok) ok = true; else if (a && a.ok === false) { err = a.error; break; }
      } catch (e) { err = String(e.message || e); }
      if (!ok) await sleep(1000);
    }
    if (!ok) throw new Error('attach failed: ' + err);
    await sleep(4000 + Math.min(20000, Math.round(job.attach.text.length / 25)));   // дать странице принять файл
  }
  let res = await askInTab(site, tab.id, text, timeoutMs, job.stableMs, job.id + 'm', job.firstTimeoutMs, job.extract === 'json', !!job.attach);
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
const FORUM_CHUNK = 9000;      // символов текста в одной части
const KIND_FULL = { uk: 'Уголовный кодекс (УК)', ak: 'Административный кодекс (АК)', pdd: 'Правила дорожного движения (ПДД)' };
let forumBusy = false;

const CHUNKS_PER_CHAT = 40;    // один чат на весь закон; новый — только если чат сломался или частей больше 40

function forumPrompt(kind, ctx) {
  const pdd = kind === 'pdd';
  const what = {
    pdd: 'штрафы ПДД: для каждой статьи/пункта нужна сумма штрафа в долларах',
    uk: 'Уголовный кодекс: для каждой статьи нужна степень розыска (1–6)',
    ak: 'Административный кодекс: для каждой статьи нужно наказание',
  }[kind];
  const itemFmt = pdd
    ? '{"amount":5000,"reason":"Пункт 1.1. Название","text":"Кратко, что нарушено"}   (amount — число, штраф в $ без пробелов; если диапазон — меньшее значение)'
    : kind === 'uk'
    ? '{"lvl":"3","reason":"Статья 2.1. Название","text":"Кратко, что нарушено"}   (lvl — степень розыска цифрой строкой; если диапазон — большая)'
    : '{"lvl":"Штраф 5000$","reason":"Статья 1.1. Название","text":"Кратко, что нарушено"}';
  return 'Привет! Помоги собрать базу для игрового помощника сервера Arizona RP.\n' +
    'Сейчас разбираем: ' + KIND_FULL[kind] + (ctx.title ? ' (тема форума «' + ctx.title + '»)' : '') + '. Нам нужны ' + what + '.\n' +
    (ctx.file
      ? 'ПОЛНЫЙ текст закона — во вложенном файле, читай именно его. Отвечай порциями: в каждом ответе не больше 25 статей, строго по порядку текста, начиная с начала файла. Когда я напишу «Продолжай», выдай следующие статьи после последней выданной. Когда статьи закончатся — верни []. Каждый ответ — ТОЛЬКО JSON-массив, без пояснений и без текста вокруг:\n'
      : 'Текст закона я буду присылать частями (всего частей: ' + ctx.total + '). На каждую часть отвечай ТОЛЬКО JSON-массивом, без пояснений и без текста вокруг:\n') +
    '[{"name":"название главы/раздела как в тексте","item":[ ' + itemFmt + ', ... ]}]\n\n' +
    'Как заполнять:\n' +
    '- В item — только статьи, где есть ' + (pdd ? 'конкретный денежный штраф' : kind === 'uk' ? 'степень розыска' : 'наказание') + '. Общие положения, определения и пояснения пропускай. Если в части таких статей нет — ответь [].\n' +
    '- reason — номер и название статьи как в тексте. Если у статьи несколько частей с разным наказанием — отдельный объект на каждую.\n' +
    (pdd ? '- Если у статьи несколько вариантов наказания по порядку применения (на месте / по ордеру / в суде / при эвакуации), бери только тот, который сотрудник выписывает сразу на месте (чаще всего «в административном порядке»). Если денежного штрафа на месте нет — статью пропусти. Отдельный объект делай только если штраф зависит от способа фиксации (например, по скоростному радару) — пометь это в скобках в reason.\n' : '') +
    '- text — коротко (одно-два предложения), суть нарушения своими словами, не копируй весь текст.\n' +
    '- Если часть начинается посреди главы, name оставь пустой строкой "".\n' +
    '- Внутри текстовых полей не используй двойные кавычки " — вместо них «ёлочки».\n' +
    (ctx.file ? '- Не добавляй условий, которых нет в тексте файла.\n\nНачинай с первой порции.' : '- Следующие части я пришлю в этом же чате, формат тот же.\n\nЧасть ' + ctx.part + ' из ' + ctx.total + ':\n');
}
// Режим «файл»: весь закон одним вложением, ИИ отвечает порциями. Возвращает массив порций или null, если файл не удалось отправить.
async function parsePaged(tabId, kind, req, cleaned) {
  if (cleaned.length < 200) return null;
  const parts = [], seen = new Set();
  let last = '';
  const what = KIND_FULL[kind];
  for (let round = 1; round <= 60; round++) {
    let data = null, lastErr = '';
    for (let attempt = 1; attempt <= 2 && !data; attempt++) {
      let job;
      if (round === 1 && attempt === 1) job = { chat: 'new', prompt: forumPrompt(kind, { title: req.title, file: true }), promptMode: 'merge', text: 'Файл с текстом закона прикреплён.', attach: { name: 'zakon.txt', text: cleaned } };
      else if (attempt === 2) job = { text: 'Последний ответ не разобрался как JSON (' + lastErr.slice(0, 80) + '). Пришли ту же порцию заново: ТОЛЬКО JSON-массив.' };
      else job = { text: 'Продолжай: следующие статьи после «' + last + '». Тот же формат, только JSON-массив. Если статей больше нет — [].' };
      try {
        const r = await doAsk({ id: 'p' + Date.now() + '_' + round, queuedAt: Date.now(), site: 'deepseek', session: 'forum_file', extract: 'json',
          timeoutMs: 420000, firstTimeoutMs: 240000, focus: true, ...job });
        if (!r.ok) throw new Error(r.error || 'нет ответа');
        data = Array.isArray(r.data) ? r.data : [];
      } catch (e) {
        lastErr = String(e.message || e);
        if (round === 1 && /attach|file input|file upload/i.test(lastErr)) return null;
        forumStatus(tabId, { phase: 'ai', paged: true, done: round, items: seen.size, what, note: `порция ${round}: попытка ${attempt} не удалась — ${lastErr.slice(0, 200)}` });
      }
    }
    if (!data) { if (round === 1) return null; throw new Error(`порция ${round}: ${lastErr}`); }
    let fresh = 0;
    const keep = [];
    for (const ch of data) {
      if (!ch || !Array.isArray(ch.item)) continue;
      const items = ch.item.filter((it) => {
        if (!it || !it.reason) return false;
        const k = String(it.reason).toLowerCase().replace(/\s+/g, ' ') + '|' + (it.amount != null ? it.amount : it.lvl);
        if (seen.has(k)) return false;
        seen.add(k); fresh++; return true;
      });
      if (items.length) keep.push({ name: ch.name, item: items });
    }
    if (!fresh) { if (round === 1) return null; break; }     // [] или одни повторы — статьи закончились
    parts.push(keep);
    last = String(keep[keep.length - 1].item.slice(-1)[0].reason);
    forumStatus(tabId, { phase: 'ai', paged: true, done: round, items: seen.size, what });
  }
  return parts;
}

function countItems(d) { return (Array.isArray(d) ? d : []).reduce((n, ch) => n + (ch && Array.isArray(ch.item) ? ch.item.length : 0), 0); }
function forumContinue(ctx) { return 'Часть ' + ctx.part + ' из ' + ctx.total + ' (' + KIND_FULL[ctx.kind] + '). Тот же формат: только JSON-массив.\n'; }

// Чистка текста форума: кнопки-спойлеры, нулевая ширина, пустые разделители
function cleanForumText(t) {
  return String(t || '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .split('\n')
    .map((l) => l.replace(/\s*\|\s*$/, '').replace(/\s+$/, ''))
    .filter((l) => !/^\s*(нажмите для раскрытия\.*|\|)\s*$/i.test(l))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
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

function normalizeDoc(kind, parts) {    // приводим к одному виду и чистим мусор перед тем, как отдать Lua (SmartUK / SmartPDD)
  const out = [];
  const clean = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
  const stripAdm = (r) => r.replace(/\s*\((?:в\s+)?административн\w*\s+порядк\w*\)\s*$/i, '');   // административный порядок — по умолчанию, пометка лишняя
  const fixReason = (r) => stripAdm(clean(r)).replace(/^(?:статья|ст\.|ст(?=\s*\d))\s*/i, 'Статья ').replace(/^(?:пункт|п\.|п(?=\s*\d))\s*/i, 'Пункт ').replace(/\s+/g, ' ').trim();
  let dropped = 0;
  for (const ch of mergeChapters(parts)) {
    const items = [], seen = new Set();
    for (const it of ch.item) {
      if (!it || typeof it !== 'object') continue;
      const reason = fixReason(it.reason);
      if (!reason) continue;
      const text = clean(it.text);
      let row;
      if (kind === 'pdd') {
        const amount = parseInt(String(it.amount == null ? '' : it.amount).replace(/[^\d]/g, ''), 10);
        if (!Number.isFinite(amount) || amount <= 0) { dropped++; continue; }    // нет штрафа — в /tsm такая статья бесполезна
        row = { amount, reason, text };
      } else if (kind === 'uk') {
        const m = String(it.lvl == null ? '' : it.lvl).match(/[1-6]/g);
        if (!m) { dropped++; continue; }                                         // без степени розыска
        row = { lvl: String(Math.max(...m.map(Number))), reason, text };
      } else {
        const lvl = clean(it.lvl);
        if (!lvl) { dropped++; continue; }
        row = { lvl, reason, text };
      }
      const key = reason.toLowerCase() + '|' + (row.amount || row.lvl);
      if (seen.has(key)) continue;                                               // дубль на стыке частей
      seen.add(key); items.push(row);
    }
    if (items.length) out.push({ name: clean(ch.name), item: items });
  }
  out.dropped = dropped;
  return out;
}

// ---- Проверка результата по исходному тексту (одинаково для любого сервера, без ручных правок) ----
const PENALTY_RE = {
  pdd: /\d[\d.\s]{2,}\s*\$|\$\s*\d/,
  uk: /розыск|степен/i,
  ak: /штраф|арест|\$/i,
};
function scanHeads(text) {              // заголовки статей/пунктов и их тела
  const lines = String(text).split('\n');
  const re = /^\s*(?:(?:Статья|Ст\.|Пункт)\s*(\d{1,3}(?:\.\d{1,3}){0,2})|(\d{1,3}\.\d{1,3}(?:\.\d{1,3})?))\.?\s*(?=[A-Za-zА-Яа-яЁё«"(])(.*)$/;
  const heads = [];
  lines.forEach((l, i) => { const m = l.match(re); if (m) heads.push({ line: i, num: m[1] || m[2], title: (m[3] || '').trim().slice(0, 70) }); });
  heads.forEach((h, k) => { h.body = lines.slice(h.line, k + 1 < heads.length ? heads[k + 1].line : lines.length).join('\n'); });
  return heads;
}
function numbersIn(text) {
  const set = new Set();
  for (const m of String(text).matchAll(/\d[\d.,\s]*\d|\d/g)) {
    const raw = m[0];
    const n = parseInt(raw.replace(/[.,\s]/g, ''), 10);
    if (Number.isFinite(n)) set.add(n);
    for (const part of raw.split(/\s+/)) { const k = parseInt(part.replace(/[.,]/g, ''), 10); if (Number.isFinite(k)) set.add(k); }
  }
  return set;
}
function verifyDoc(kind, data, sourceText) {
  const have = new Set();
  for (const ch of data) for (const it of ch.item) { const m = String(it.reason).match(/\d+(?:\.\d+)*/); if (m) have.add(m[0]); }
  const re = PENALTY_RE[kind] || PENALTY_RE.ak;
  const heads = scanHeads(sourceText).filter((h) => re.test(h.body));
  const missing = heads.filter((h) => !have.has(h.num)).map((h) => h.num + (h.title ? ' ' + h.title : ''));
  const nums = numbersIn(sourceText);
  const suspicious = kind === 'pdd'
    ? data.flatMap((ch) => ch.item).filter((it) => !nums.has(it.amount)).map((it) => it.reason + ' — ' + it.amount)
    : [];
  return { found: heads.length, missing: missing.slice(0, 12), missingTotal: missing.length, suspicious: suspicious.slice(0, 8) };
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
    forumStatus(tabId, { phase: 'ai', done: 0, total: 0, what: KIND_FULL[kind] });
    try { await fetch(BRIDGE + '/docs'); } catch (e) { throw new Error('мост не запущен (запустите bridge.bat) — результат некуда сохранить'); }

    const cleaned = cleanForumText(req.text);
    const chunked = async () => {
    const chunks = splitChunks(cleaned, FORUM_CHUNK);
    if (!chunks.length) throw new Error('на странице не нашлось текста');
    const { forumWorkers } = await chrome.storage.local.get({ forumWorkers: 1 });
    const workers = Math.max(1, Math.min(4, parseInt(forumWorkers, 10) || 1));
    const results = new Array(chunks.length);
    let next = 0, done = 0, failed = null;
    forumStatus(tabId, { phase: 'ai', done: 0, total: chunks.length, what: KIND_FULL[kind] });

    const worker = async (w) => {
      let inChat = 0;                                   // сколько частей уже ушло в текущий чат (0 = чата ещё нет)
      while (!failed) {
        const i = next++;
        if (i >= chunks.length) return;
        const ctx = { kind, title: req.title, part: i + 1, total: chunks.length };
        let lastErr = '';
        for (let attempt = 1; attempt <= 3; attempt++) {
          // 1: продолжаем текущий чат (или открываем новый, если пора); 2: просим исправить в том же чате; 3: последний шанс в новом чате
          const fresh = attempt === 3 || (attempt === 1 && (inChat === 0 || inChat >= CHUNKS_PER_CHAT));
          let job;
          if (fresh) job = { chat: 'new', prompt: forumPrompt(kind, ctx), promptMode: 'merge', text: chunks[i] };
          else if (attempt === 1) job = { text: forumContinue(ctx) + '\n' + chunks[i] };
          else if (/^пустой ответ/.test(lastErr)) job = { text: 'В последней части есть штрафы в долларах, а ты ответил пустым массивом. Перечитай её и ответь заново тем же JSON-форматом: нужны статьи со штрафом в административном порядке.' };
          else job = { text: 'Твой последний ответ не получилось разобрать как JSON (' + lastErr.slice(0, 80) + '). Пришли заново для той же части ТОЛЬКО JSON-массив, без пояснений.' };
          try {
            const r = await doAsk({ id: 'f' + Date.now() + '_' + i, queuedAt: Date.now(), site: 'deepseek', session: 'forum_' + w,
              extract: 'json', timeoutMs: 360000, firstTimeoutMs: 180000, ownWindow: workers > 1, focus: workers === 1, ...job });
            if (!r.ok) throw new Error(r.error || 'нет ответа');
            if (kind === 'pdd' && countItems(r.data) === 0 && /\d[\d. ]{2,}\s*\$|\$\s*\d/.test(chunks[i])) throw new Error('пустой ответ, хотя в тексте есть суммы штрафов');
            results[i] = r.data;
            inChat = fresh ? 1 : inChat + 1;
            lastErr = '';
            break;
          } catch (e) {
            lastErr = String(e.message || e);
            if (fresh) inChat = 0;
            forumStatus(tabId, { phase: 'ai', done, total: chunks.length, what: KIND_FULL[kind], note: `часть ${i + 1}: попытка ${attempt} не удалась — ${lastErr.slice(0, 300)}` });
          }
        }
        if (lastErr) { inChat = 0; failed = `часть ${i + 1}/${chunks.length}: ${lastErr}`; return; }
        done++;
        forumStatus(tabId, { phase: 'ai', done, total: chunks.length, what: KIND_FULL[kind] });
      }
    };
    await Promise.all(Array.from({ length: Math.min(workers, chunks.length) }, (_, w) => worker(w + 1)));
    if (failed) throw new Error('ИИ не справился: ' + failed);
    return results;

    };

    let results = null;
    const { forumMode } = await chrome.storage.local.get({ forumMode: 'file' });
    if (forumMode !== 'chunks') results = await parsePaged(tabId, kind, req, cleaned);
    if (!results) {
      if (forumMode !== 'chunks') forumStatus(tabId, { phase: 'ai', done: 0, total: 0, what: KIND_FULL[kind], note: 'файл прикрепить не удалось — перехожу на отправку частями' });
      results = await chunked();
    }

    const data = normalizeDoc(kind, results);
    if (!data.length) throw new Error('ИИ не вернул ни одной статьи — проверьте, что открыта страница с текстом закона');
    forumStatus(tabId, { phase: 'save' });
    const r = await fetch(BRIDGE + '/doc', { method: 'POST', body: JSON.stringify({ kind, meta: { title: req.title, url: req.url }, data }) });
    const info = await r.json();
    if (!info.ok) throw new Error('мост не принял документ: ' + info.error);
    forumStatus(tabId, { phase: 'done', kind, chapters: info.chapters, items: info.items, dropped: data.dropped || 0, check: verifyDoc(kind, data, cleaned) });
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
