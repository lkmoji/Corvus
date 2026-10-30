// Мост: TCP 9224 (скрипт/cmd/Lua)  <->  HTTP 9225 (расширение, long-poll)
const net = require('net');
const http = require('http');
const fs = require('fs');
const path = require('path');

const TCP_PORT = 9224;
const HTTP_PORT = 9225;
const JOB_TIMEOUT_MS = 10 * 60 * 1000;
const PROFILES_FILE = path.join(__dirname, 'profiles.json');
const FORWARD = new Set(['ask', 'new_chat', 'close', 'sessions']); // команды, которые выполняет расширение
const DOCS_DIR = path.join(__dirname, 'docs');                     // разобранные законы с форума: uk.json / ak.json / pdd.json + index.json
const DOC_KINDS = new Set(['uk', 'ak', 'pdd']);

let nextId = 1;
const queue = [];          // команды, ждущие расширение
const pending = new Map(); // id -> { sock, raw }
let waiter = null;         // текущий висящий /poll
let lastPoll = 0;

function fatal(e) {
  console.log('Ошибка: ' + e.message);
  if (e.code === 'EADDRINUSE') console.log('Порт занят - скорее всего, мост уже запущен в другом окне.');
  process.exit(1);
}

// ---------- профили ----------
function loadProfiles() {
  if (!fs.existsSync(PROFILES_FILE)) return {};
  const t = fs.readFileSync(PROFILES_FILE, 'utf8').replace(/^\uFEFF/, '');
  try { return JSON.parse(t); } catch (e) { throw new Error('profiles.json: ' + e.message); }
}
function saveProfiles(p) { fs.writeFileSync(PROFILES_FILE, JSON.stringify(p, null, 2), 'utf8'); }

// default <- profile <- поля самой команды (приоритет растёт)
function resolveJob(msg) {
  const P = loadProfiles();
  const base = P.default || {};
  let prof = {};
  if (msg.profile) {
    if (!P[msg.profile]) throw new Error('unknown profile: ' + msg.profile);
    prof = P[msg.profile];
  }
  const job = { ...base, ...prof, ...msg };
  job.session = msg.session ?? prof.session ?? msg.profile ?? base.session ?? 'default';
  return job;
}

// ---------- документы (УК / АК / ПДД), которые расширение распарсило с форума ----------
function docsIndex() {
  try { return JSON.parse(fs.readFileSync(path.join(DOCS_DIR, 'index.json'), 'utf8').replace(/^\uFEFF/, '')); } catch (e) { return {}; }
}
function countDoc(data) {
  let items = 0;
  for (const ch of data) items += ch.item.length;
  return { chapters: data.length, items };
}
function saveDoc(kind, meta, data) {
  if (!DOC_KINDS.has(kind)) throw new Error('unknown doc kind: ' + kind);
  if (!Array.isArray(data) || !data.length || !data.every((c) => c && Array.isArray(c.item))) throw new Error('bad doc: expected non-empty array of {name, item[]}');
  fs.mkdirSync(DOCS_DIR, { recursive: true });
  fs.writeFileSync(path.join(DOCS_DIR, kind + '.json'), JSON.stringify(data), 'utf8');
  const idx = docsIndex();
  idx[kind] = { title: String((meta && meta.title) || ''), url: String((meta && meta.url) || ''), ...countDoc(data), savedAt: Date.now() };
  fs.writeFileSync(path.join(DOCS_DIR, 'index.json'), JSON.stringify(idx, null, 2), 'utf8');
  console.log(`[doc] ${kind}: ${idx[kind].chapters} глав, ${idx[kind].items} статей (${idx[kind].title || 'без названия'})`);
  return idx[kind];
}

// ---------- ответы ----------
function reply(sock, obj, raw) {
  try {
    if (raw) sock.end(obj.ok ? 'OK\n' + (obj.text ?? '') : 'ERR\n' + (obj.error || 'unknown'));
    else sock.end(JSON.stringify(obj) + '\n');
  } catch (e) {}
}

function deliver() {
  if (waiter && queue.length) {
    const w = waiter; waiter = null;
    clearTimeout(w.timer);
    w.res.end(JSON.stringify(queue.shift()));
  }
}

function handleLine(sock, line) {
  let msg;
  if (line.startsWith('{')) {
    try { msg = JSON.parse(line); } catch (e) { return reply(sock, { ok: false, error: 'bad json' }); }
  } else {
    msg = { cmd: 'ask', text: line, raw: true }; // простой текст = вопрос с профилем default
  }
  try {
    const cmd = msg.cmd || 'ask';

    if (cmd === 'ping') {
      return reply(sock, { ok: true, pong: true, extension: Date.now() - lastPoll < 30000, inflight: pending.size });
    }
    if (cmd === 'profiles') return reply(sock, { ok: true, profiles: loadProfiles() });
    if (cmd === 'doc_list') {                                  // что уже распарсено: { uk: {title, chapters, items, savedAt}, ... }
      const idx = docsIndex();
      return reply(sock, { ok: true, text: JSON.stringify(idx), docs: idx }, !!msg.raw);
    }
    if (cmd === 'doc_get') {                                   // содержимое документа (JSON-массив глав) для скрипта
      const kind = String(msg.kind || msg.text || '').toLowerCase();
      if (!DOC_KINDS.has(kind)) throw new Error('unknown doc kind: ' + kind);
      const f = path.join(DOCS_DIR, kind + '.json');
      if (!fs.existsSync(f)) throw new Error('no doc yet: ' + kind);
      return reply(sock, { ok: true, text: fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, '') }, !!msg.raw);
    }
    if (cmd === 'set_profile') {
      if (!msg.name || typeof msg.profile !== 'object') throw new Error('need name and profile{}');
      const P = loadProfiles(); P[msg.name] = msg.profile; saveProfiles(P);
      return reply(sock, { ok: true });
    }
    if (cmd === 'del_profile') {
      const P = loadProfiles(); delete P[msg.name]; saveProfiles(P);
      return reply(sock, { ok: true });
    }
    if (!FORWARD.has(cmd)) throw new Error('unknown cmd: ' + cmd);

    const job = resolveJob({ ...msg, cmd });
    const id = nextId++;
    pending.set(id, { sock, raw: !!job.raw });
    queue.push({ id, queuedAt: Date.now(), ...job });
    console.log(`[tcp] #${id} ${cmd} session=${job.session} site=${job.site || '-'} chat=${job.chat || 'continue'} text=${JSON.stringify((job.text || '').slice(0, 60))}`);
    deliver();
    setTimeout(() => {
      if (pending.has(id)) { const p = pending.get(id); pending.delete(id); reply(p.sock, { ok: false, error: 'bridge timeout' }, p.raw); }
    }, JOB_TIMEOUT_MS);
  } catch (e) {
    reply(sock, { ok: false, error: e.message }, msg && msg.raw);
  }
}

net.createServer({ allowHalfOpen: true }, (sock) => {
  let buf = '';
  sock.setEncoding('utf8');
  sock.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) handleLine(sock, line);
    }
  });
  sock.on('end', () => { if (buf.trim()) handleLine(sock, buf.trim()); buf = ''; });
  sock.on('error', () => {});
}).on('error', fatal).listen(TCP_PORT, '127.0.0.1', () => console.log(`TCP  listening on 127.0.0.1:${TCP_PORT}`));

http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'GET' && req.url === '/poll') {
    lastPoll = Date.now();
    if (waiter) { clearTimeout(waiter.timer); waiter.res.end('null'); waiter = null; }
    waiter = { res, timer: setTimeout(() => { waiter = null; res.end('null'); }, 20000) };
    req.on('close', () => { if (waiter && waiter.res === res) { clearTimeout(waiter.timer); waiter = null; } });
    return deliver();
  }
  if (req.method === 'GET' && req.url === '/docs') {            // расширение проверяет, что мост жив, и видит список
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify(docsIndex()));
  }
  if (req.method === 'POST' && req.url === '/doc') {           // расширение присылает готовый документ
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      try {
        const r = JSON.parse(body);
        const info = saveDoc(String(r.kind || '').toLowerCase(), r.meta, r.data);
        res.end(JSON.stringify({ ok: true, ...info }));
      } catch (e) {
        res.statusCode = 400;
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }
  if (req.method === 'POST' && req.url === '/result') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      try {
        const r = JSON.parse(body);
        const p = pending.get(r.id);
        if (p) {
          pending.delete(r.id);
          reply(p.sock, r, p.raw);
          console.log(`[tcp] result #${r.id} ok=${r.ok}` + (r.ok ? '' : ` error=${r.error}`));
        }
      } catch (e) {}
      res.end('ok');
    });
    return;
  }
  res.statusCode = 404; res.end();
}).on('error', fatal).listen(HTTP_PORT, '127.0.0.1', () => console.log(`HTTP listening on 127.0.0.1:${HTTP_PORT}`));
