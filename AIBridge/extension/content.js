// Селекторы сайтов. Если вёрстка сайта изменится — правь здесь.
const SITES = {
  'chat.deepseek.com': {
    input: ['textarea#chat-input', 'textarea'],
    send: [],                       // нет надёжного селектора — жмём Enter
    response: ['.ds-markdown'],
    stop: [],
  },
  'chatgpt.com': {
    input: ['#prompt-textarea'],
    send: ['button[data-testid="send-button"]'],
    response: ['div[data-message-author-role="assistant"] .markdown', 'div[data-message-author-role="assistant"]'],
    stop: ['button[data-testid="stop-button"]'],
  },
};

// ---- Индикатор: расширение внедрено на страницу ----
let badgeDot, badgeText;
function initBadge() {
  if (document.getElementById('ai-bridge-badge')) return;
  const host = document.createElement('div');
  host.id = 'ai-bridge-badge';
  host.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:2147483647;';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `
    <style>
      .b{display:flex;align-items:center;gap:6px;padding:4px 10px;border-radius:999px;
         background:rgba(20,20,20,.85);color:#fff;font:12px/1 system-ui,sans-serif;
         box-shadow:0 2px 8px rgba(0,0,0,.3);cursor:default;user-select:none}
      .d{width:9px;height:9px;border-radius:50%;background:#2ecc71}
      .b.busy .d{background:#f1c40f;animation:p 1s infinite}
      .b.error .d{background:#e74c3c}
      @keyframes p{50%{opacity:.3}}
    </style>
    <div class="b" title="AI Bridge: расширение подключено"><span class="d"></span><span class="t">AI Bridge</span></div>`;
  badgeDot = root.querySelector('.b');
  badgeText = root.querySelector('.t');
  (document.body || document.documentElement).appendChild(host);
}
function setBadge(state, text) {
  initBadge();
  badgeDot.className = 'b ' + state;
  badgeText.textContent = text || 'AI Bridge';
}
initBadge();
setInterval(initBadge, 3000);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const q = (list) => { for (const s of list) { const e = document.querySelector(s); if (e) return e; } return null; };
const qAll = (list) => { for (const s of list) { const e = document.querySelectorAll(s); if (e.length) return [...e]; } return []; };

async function waitFor(fn, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const v = fn(); if (v) return v; await sleep(50); }
  throw new Error('waitFor timeout');
}

function setText(el, text) {
  el.focus();
  if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, text);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  } else { // contenteditable (ChatGPT)
    document.execCommand('selectAll');
    document.execCommand('insertText', false, text);
  }
}

function pressEnter(el) {
  const opts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
  el.dispatchEvent(new KeyboardEvent('keydown', opts));
  el.dispatchEvent(new KeyboardEvent('keyup', opts));
}

function blocksOf(el) {
  return [...el.querySelectorAll('pre')].map((p) => (p.querySelector('code') || p).innerText.trim());
}

function isEmpty(el) {
  const v = (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') ? el.value : el.innerText;
  return !v || v.trim() === '';
}
async function waitCleared(cfg, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const el = q(cfg.input);
    if (!el || isEmpty(el)) return true;
    await sleep(100);
  }
  return false;
}

// ---- состояние текущего запроса ----
let st = null; // { askId, before, t0, cfg, lastUi }

async function doStart(msg) {
  try {
    const cfg = SITES[location.hostname];
    if (!cfg) throw new Error('site not supported: ' + location.hostname);
    const input = await waitFor(() => q(cfg.input), 15000)
      .catch(() => { throw new Error('input field not found (selector changed?)'); });
    const els0 = qAll(cfg.response);
    st = {
      askId: msg.askId, before: els0.length, t0: Date.now(), lastUi: 0, lastSnap: Date.now(), cfg,
      prevText: els0.length ? els0[els0.length - 1].innerText.trim() : '', // чтобы отличить новый ответ, даже если число блоков не растёт
    };
    setBadge('busy', 'AI Bridge: запрос…');
    setText(input, msg.text);
    await sleep(100);
    const btn = cfg.send.length
      ? await waitFor(() => { const b = q(cfg.send); return b && !b.disabled ? b : null; }, 2000).catch(() => null)
      : null;
    if (btn) btn.click(); else pressEnter(input);

    // проверяем, что сообщение реально ушло: поле ввода должно очиститься
    if (!(await waitCleared(cfg, 2000))) {
      const el = q(cfg.input);
      if (el) pressEnter(el); // одна повторная попытка
      if (!(await waitCleared(cfg, 2500))) throw new Error('message not sent: input was not cleared');
    }
    return { ok: true };
  } catch (e) {
    st = null;
    setBadge('error', 'AI Bridge: ' + (e.message || e));
    return { ok: false, error: String(e.message || e) };
  }
}

// снимок состояния страницы — мгновенный; решения принимает background
function snap(withBlocks) {
  if (!st) return { ok: true, active: false };
  const els = qAll(st.cfg.response);
  const last = els.length ? els[els.length - 1] : null;
  const lastText = last ? last.innerText.trim() : '';
  // новый ответ: блоков стало больше ИЛИ текст последнего блока изменился (список мог выгрузить старые сообщения)
  const isNew = els.length > st.before || (lastText !== '' && lastText !== st.prevText);
  const text = isNew ? lastText : '';
  const now = Date.now();
  st.lastSnap = now;
  if (now - st.lastUi > 700) {
    st.lastUi = now;
    const sec = Math.round((now - st.t0) / 1000);
    setBadge('busy', isNew ? `AI Bridge: ответ ${text.length} симв, ${sec}с` : `AI Bridge: жду ответ… ${sec}с`);
  }
  const inp = q(st.cfg.input);
  return {
    ok: true, active: true, isNew, text,
    generating: !!q(st.cfg.stop),
    blocks: withBlocks && last ? blocksOf(last) : undefined,
    debug: { count: els.length, before: st.before, lastLen: lastText.length, prevLen: st.prevText.length, inputLen: inp ? ((inp.value ?? inp.innerText) || '').length : -1 },
  };
}

chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
  switch (msg.type) {
    case 'ping': sendResponse({ ok: true, busy: st && st.askId }); return;
    case 'start': doStart(msg).then(sendResponse); return true; // ответ асинхронный
    case 'snap': sendResponse(snap(msg.blocks)); return;
    case 'end':
      st = null;
      if (msg.ok) { setBadge('ok', 'AI Bridge: готово'); setTimeout(() => { if (!st) setBadge('ok'); }, 4000); }
      else setBadge('error', 'AI Bridge: ' + (msg.error || 'ошибка')); // ошибка остаётся до следующего запроса
      sendResponse({ ok: true });
      return;
  }
});

// диагностика: если фоновый скрипт перестал опрашивать страницу во время запроса
setInterval(() => {
  if (st && Date.now() - st.lastSnap > 8000) setBadge('error', 'AI Bridge: фон не опрашивает страницу (перезагрузи расширение)');
}, 2000);
