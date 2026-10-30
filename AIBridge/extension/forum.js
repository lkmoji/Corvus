// Corvus · парсер законов (УК / АК / ПДД) на forum.arizona-rp.com
// Рисует кнопку поверх страницы форума. По нажатию собирает текст темы (в том числе скрытый под спойлерами и на других
// страницах темы) и отправляет его в background.js: там текст разбирает DeepSeek, а результат уходит мосту и скрипту Corvus.
(function () {
  'use strict';

  const KIND_NAMES = { uk: 'УК', ak: 'АК', pdd: 'ПДД' };
  const KIND_FULL = { uk: 'Уголовный кодекс', ak: 'Административный кодекс', pdd: 'ПДД' };
  const MAX_CHARS = 400000;
  const BLOCK = new Set(['DIV', 'P', 'LI', 'UL', 'OL', 'TR', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'TABLE',
    'SECTION', 'ARTICLE', 'PRE', 'HR', 'DL', 'DT', 'DD']);

  // ---------- текст узла: переносы строк по блокам, содержимое спойлеров тоже (оно скрыто стилями, innerText его бы потерял) ----------
  function nodeText(root) {
    let out = '';
    (function walk(n) {
      if (n.nodeType === 3) { out += String(n.nodeValue).replace(/\s+/g, ' '); return; }
      if (n.nodeType !== 1) return;
      const tag = n.tagName;
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') return;
      if (tag === 'BR') { out += '\n'; return; }
      const block = BLOCK.has(tag);
      if (block) out += '\n';
      for (const c of Array.from(n.childNodes)) walk(c);
      if (tag === 'TD' || tag === 'TH') out += ' | ';
      if (block) out += '\n';
    })(root);
    return out.replace(/[ \t]+\n/g, '\n').replace(/\n[ \t]+/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  // ---------- тип документа по заголовку ----------
  function guessKind(title) {
    const s = ' ' + String(title || '').toLowerCase().replace(/ё/g, 'е') + ' ';
    if (/уголовн|[^а-я]ук[^а-я]/.test(s)) return 'uk';
    if (/административн|[^а-я]ак[^а-я]|коап/.test(s)) return 'ak';
    if (/пдд|дорожн/.test(s)) return 'pdd';
    return '';
  }

  // ---------- посты страницы (XenForo): берём посты автора первого поста — это сам закон, без обсуждения ----------
  function extractPosts(doc, onlyAuthor) {
    const out = [];
    let author = onlyAuthor || '';
    for (const a of Array.from(doc.querySelectorAll('article.message'))) {
      const who = a.getAttribute('data-author') || '';
      if (!author && who) author = who;
      if (author && who && who !== author) continue;
      const bb = a.querySelector('.bbWrapper');
      if (bb) out.push(nodeText(bb));
    }
    if (!out.length) {                                    // не XenForo или нестандартная вёрстка
      const bb = Array.from(doc.querySelectorAll('.bbWrapper'));
      if (bb.length) bb.forEach((b) => out.push(nodeText(b)));
      else {
        const main = doc.querySelector('.p-body-content, main, #content, article') || doc.body;
        if (main) out.push(nodeText(main));
      }
    }
    return { author, posts: out.filter(Boolean) };
  }

  // ---------- список страниц темы: от первой до последней по ссылкам пагинации ----------
  function pageUrls(doc, baseHref) {
    const nums = [];
    let tpl = null;
    for (const a of Array.from(doc.querySelectorAll('.pageNav-page a[href], .pageNav a[href]'))) {
      const n = parseInt((a.textContent || '').trim(), 10);
      if (!Number.isFinite(n)) continue;
      nums.push(n);
      if (!tpl) {
        try { tpl = new URL(a.getAttribute('href'), baseHref).href; } catch (e) { /* ignore */ }
      }
    }
    if (!tpl || !nums.length) return [];
    const max = Math.min(Math.max.apply(null, nums), 60);
    const q = (tpl.match(/\?[^#]*/) || [''])[0];
    const base = tpl.replace(/[?#].*$/, '').replace(/\/page-\d+\/?$/, '').replace(/\/+$/, '');
    const out = [];
    for (let n = 1; n <= max; n++) out.push({ n, url: n === 1 ? base + q : base + '/page-' + n + q });
    return out;
  }
  function currentPage(doc) {
    const c = doc.querySelector('.pageNav-page--current');
    const n = c ? parseInt((c.textContent || '').trim(), 10) : 1;
    return Number.isFinite(n) ? n : 1;
  }

  async function collect(allPages, progress) {
    const title = (document.querySelector('h1.p-title-value') || {}).textContent || document.title || '';
    const cur = currentPage(document);
    let list = allPages ? pageUrls(document, location.href) : [];
    if (!list.length) list = [{ n: cur, url: null }];
    const parts = [];
    let author = '';
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      progress(`Читаю страницу ${i + 1}/${list.length}…`);
      let doc = document;
      if (p.url && p.n !== cur) {
        const r = await fetch(p.url, { credentials: 'same-origin' });
        if (!r.ok) throw new Error(`страница ${p.n}: HTTP ${r.status}`);
        doc = new DOMParser().parseFromString(await r.text(), 'text/html');
      }
      const got = extractPosts(doc, author);
      if (!author) author = got.author;
      parts.push(...got.posts);
    }
    let text = parts.join('\n\n');
    let cut = false;
    if (text.length > MAX_CHARS) { text = text.slice(0, MAX_CHARS); cut = true; }
    return { title: title.trim(), text, cut, pages: list.length };
  }

  // ---------- интерфейс ----------
  function init() {
    if (document.getElementById('corvus-forum-parser')) return;
    const host = document.createElement('div');
    host.id = 'corvus-forum-parser';
    host.style.cssText = 'all:initial;position:fixed;right:18px;bottom:18px;z-index:2147483647;';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>
        * { box-sizing: border-box; font-family: 'Segoe UI', Arial, sans-serif; }
        .fab { background:#1d2430; color:#e8edf5; border:1px solid #3a4658; border-radius:8px; padding:10px 14px; font-size:13px; cursor:pointer; box-shadow:0 4px 16px rgba(0,0,0,.45); }
        .fab:hover { border-color:#7997b8; }
        .panel { display:none; width:320px; margin-bottom:10px; background:#161b24; color:#e8edf5; border:1px solid #3a4658; border-radius:10px; padding:14px; box-shadow:0 8px 28px rgba(0,0,0,.55); }
        .panel.open { display:block; }
        .row { display:flex; align-items:center; justify-content:space-between; margin-bottom:10px; font-size:13px; gap:8px; }
        .title { font-weight:600; font-size:14px; }
        .x { background:none; border:none; color:#8b97a8; font-size:18px; cursor:pointer; line-height:1; }
        select { background:#0f131a; color:#e8edf5; border:1px solid #3a4658; border-radius:6px; padding:5px 8px; font-size:13px; }
        label { font-size:13px; color:#c7d0dd; display:flex; align-items:center; gap:6px; cursor:pointer; }
        .btns { display:flex; gap:8px; }
        .run { flex:1; background:#7997b8; color:#0b1017; border:none; border-radius:7px; padding:10px; font-size:13px; font-weight:600; cursor:pointer; }
        .run:disabled { opacity:.5; cursor:default; }
        .st { margin-top:10px; font-size:12px; color:#9fb0c6; min-height:16px; white-space:pre-wrap; word-break:break-word; }
        .st.err { color:#ff8a8a; } .st.ok { color:#7fe3a1; }
        .bar { height:4px; background:#0f131a; border-radius:3px; margin-top:8px; overflow:hidden; display:none; }
        .bar i { display:block; height:100%; width:0; background:#7997b8; transition:width .3s; }
        .hint { font-size:11px; color:#6f7d90; margin-top:8px; line-height:1.35; }
      </style>
      <div class="panel" id="panel">
        <div class="row"><span class="title">Corvus · парсер законов</span><button class="x" id="x" title="Закрыть">×</button></div>
        <div class="row"><label><input type="checkbox" id="pages" checked> Все страницы темы</label></div>
        <div class="btns">
          <button class="run" id="run-uk" data-kind="uk">Спарсить УК</button>
          <button class="run" id="run-pdd" data-kind="pdd">Спарсить ПДД</button>
        </div>
        <div class="bar" id="bar"><i id="fill"></i></div>
        <div class="st" id="st"></div>
        <div class="hint">Откройте тему с нужным законом и нажмите соответствующую кнопку — ИИ получит указание, что именно разбирает. Текст разберёт DeepSeek (нужна открытая вкладка DeepSeek с входом в аккаунт и запущенный bridge.bat).</div>
      </div>
      <button class="fab" id="fab">Corvus · спарсить</button>`;
    document.documentElement.appendChild(host);

    const $ = (id) => root.getElementById(id);
    const st = (t, cls) => { $('st').textContent = t; $('st').className = 'st' + (cls ? ' ' + cls : ''); };
    const bar = (frac) => { $('bar').style.display = frac == null ? 'none' : 'block'; if (frac != null) $('fill').style.width = Math.round(frac * 100) + '%'; };
    let busy = false;

    $('fab').onclick = () => { $('panel').classList.toggle('open'); };
    $('x').onclick = () => { $('panel').classList.remove('open'); };

    const buttons = Array.from(root.querySelectorAll('.run'));
    const setBusy = (v) => { busy = v; buttons.forEach((b) => { b.disabled = v; }); };

    async function start(kind) {
      if (busy) return;
      setBusy(true); bar(0.02);
      try {
        const got = await collect($('pages').checked, (t) => st(t));
        const guess = guessKind(got.title);
        if (guess && guess !== kind && !confirm('Заголовок темы «' + got.title + '» похож на ' + KIND_NAMES[guess] + ', а вы нажали «' + KIND_NAMES[kind] + '». Всё равно парсить как ' + KIND_NAMES[kind] + '?')) throw new Error('Отменено.');
        if (got.text.length < 200) throw new Error('На странице слишком мало текста (' + got.text.length + ' симв.). Откройте тему с самим законом.');
        st(`${KIND_NAMES[kind]}: ${got.text.length} симв., страниц: ${got.pages}${got.cut ? ' (обрезано до лимита)' : ''}. Отправляю в ИИ…`);
        chrome.runtime.sendMessage({ type: 'forum_start', kind, title: got.title, url: location.href, text: got.text }, (resp) => {
          if (chrome.runtime.lastError || !resp || !resp.ok) {
            setBusy(false); bar(null);
            st('Не удалось связаться с расширением: ' + ((chrome.runtime.lastError && chrome.runtime.lastError.message) || 'нет ответа') + '. Обновите страницу (F5).', 'err');
          }
        });
      } catch (e) {
        setBusy(false); bar(null);
        st(String(e.message || e), 'err');
      }
    }
    buttons.forEach((b) => { b.onclick = () => start(b.dataset.kind); });

    chrome.runtime.onMessage.addListener((m) => {
      if (!m || m.type !== 'forum_status') return;
      if (m.phase === 'ai') {
        if (m.paged) { bar(Math.min(0.9, 0.08 + m.done * 0.06)); st(`Парсится: ${m.what || ''}\nПорция ${m.done}, найдено статей: ${m.items}${m.note ? '\n⚠ ' + m.note : ''}`); return; }
        if (!m.total) { bar(0.04); st(`Парсится: ${m.what || ''}. Готовлю запросы…`); return; }
        bar(0.05 + 0.9 * (m.done / m.total));
        st(`Парсится: ${m.what || ''}\nИИ разбирает текст: готово частей ${m.done} из ${m.total}…${m.note ? '\n⚠ ' + m.note : ''}`);
      }
      else if (m.phase === 'save') { bar(0.97); st('Сохраняю в мост…'); }
      else if (m.phase === 'done') {
        setBusy(false); bar(1);
        const c = m.check || {};
        const warn = [];
        if (c.missingTotal) warn.push(`В тексте есть наказание, но в базе нет статей (${c.missingTotal}): ${c.missing.join('; ')}${c.missingTotal > c.missing.length ? '…' : ''}`);
        if (c.suspicious && c.suspicious.length) warn.push(`Сумму не нашли в тексте закона, проверьте: ${c.suspicious.join('; ')}`);
        st(`Готово: ${KIND_NAMES[m.kind] || m.kind}, глав ${m.chapters}, статей ${m.items}${m.dropped ? ` (отброшено без штрафа/розыска: ${m.dropped})` : ''}.\n` +
          (c.found != null ? `Проверка по тексту: статей с наказанием найдено ${c.found}, ${warn.length ? 'есть расхождения:' : 'расхождений нет.'}\n` : '') + warn.join('\n') +
          `\nCorvus подхватит данные сам (в течение ~30 с), либо нажмите «Загрузить с форума» в игре.`, warn.length ? 'err' : 'ok');
      } else if (m.phase === 'error') {
        setBusy(false); bar(null);
        st(String(m.error || 'ошибка'), 'err');
      }
    });
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = { nodeText, guessKind, extractPosts, pageUrls, currentPage };
  else if (typeof document !== 'undefined' && typeof chrome !== 'undefined' && chrome.runtime) init();
})();
