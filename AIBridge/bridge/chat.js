// Интерактивный чат с мостом. Запуск: chat.bat
const net = require('net');
const readline = require('readline');

function request(obj) {
  return new Promise((resolve) => {
    const s = net.connect(9224, '127.0.0.1', () => s.write(JSON.stringify(obj) + '\n'));
    s.setEncoding('utf8');
    let out = '';
    s.on('data', (d) => (out += d));
    s.on('end', () => { try { resolve(JSON.parse(out)); } catch (e) { resolve({ ok: false, error: out || 'bad reply' }); } });
    s.on('error', (e) => resolve({ ok: false, error: 'нет связи с мостом (' + e.message + '). Запусти bridge.bat' }));
  });
}

let profile = null, site = null, extract = null, newOnce = false;
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const promptStr = () => `[${profile || 'default'}${site ? '@' + site : ''}] > `;

const HELP = `Команды:
  /p имя      выбрать профиль (/p без имени = default)
  /profiles   список профилей
  /n          следующее сообщение отправить в НОВОМ чате
  /new        сразу открыть новый чат (и отправить промт профиля)
  /site имя   deepseek | chatgpt  (/site без имени = из настроек)
  /x режим    full | code | json  (/x без режима = full)
  /sessions   открытые сессии
  /close      закрыть вкладку текущей сессии
  /ping       проверить мост и расширение
  /exit       выход
Всё остальное отправляется как вопрос.`;

function show(r) {
  if (r.ok === false) {
    console.log('ОШИБКА: ' + r.error + (r.text ? '\n(частичный текст)\n' + r.text : ''));
    if (r.debug) console.log('debug: ' + JSON.stringify(r.debug));
  }
  else if (typeof r.text === 'string') console.log(r.text);
  else console.log(JSON.stringify(r, null, 2));
}

async function handle(line) {
  if (!line) return;
  if (line.startsWith('/')) {
    const [cmd, ...rest] = line.slice(1).split(/\s+/);
    const arg = rest.join(' ');
    switch (cmd) {
      case 'exit': case 'q': rl.close(); process.exit(0);
      case 'help': case '?': console.log(HELP); return;
      case 'p': profile = arg || null; console.log('профиль: ' + (profile || 'default')); return;
      case 'site': site = arg || null; console.log('сайт: ' + (site || 'из настроек')); return;
      case 'x': extract = arg && arg !== 'full' ? arg : null; console.log('извлечение: ' + (extract || 'full')); return;
      case 'n': newOnce = true; console.log('следующее сообщение пойдёт в новый чат'); return;
      case 'profiles': { const r = await request({ cmd: 'profiles' }); console.log(r.ok ? Object.keys(r.profiles).join(', ') : 'ОШИБКА: ' + r.error); return; }
      case 'sessions': show(await request({ cmd: 'sessions' })); return;
      case 'ping': show(await request({ cmd: 'ping' })); return;
      case 'close': show(await request({ cmd: 'close', ...(profile && { profile }) })); return;
      case 'new': { console.log('открываю новый чат…'); show(await request({ cmd: 'new_chat', ...(profile && { profile }), ...(site && { site }) })); return; }
      default: console.log('неизвестная команда, /help'); return;
    }
  }
  const msg = { cmd: 'ask', text: line };
  if (profile) msg.profile = profile;
  if (site) msg.site = site;
  if (extract) msg.extract = extract;
  if (newOnce) { msg.chat = 'new'; newOnce = false; }
  const t0 = Date.now();
  console.log('… жду ответ');
  const r = await request(msg);
  show(r);
  if (r.ok !== false) {
    const f = (ms) => (ms == null ? '-' : (ms / 1000).toFixed(1) + 'с');
    const T = r.timing;
    console.log(`(${((Date.now() - t0) / 1000).toFixed(1)} с всего` + (T
      ? ` | очередь ${f(T.pickupMs)}, подготовка ${f(T.prepMs)}, начало ответа ${f(T.firstMs)}, конец текста ${f(T.lastChangeMs)}, итого в браузере ${f(T.totalMs)}`
      : '') + ')');
  }
}

console.log('AI Bridge чат. /help — команды, /exit — выход.');
const iter = rl[Symbol.asyncIterator](); // создаём сразу, чтобы не терять строки, пришедшие во время ping
(async () => {
  const p = await request({ cmd: 'ping' });
  if (p.ok && !p.extension) console.log('! Мост работает, но расширение не подключено (проверь chrome://extensions).');
  if (!p.ok) console.log('! ' + p.error);
  rl.setPrompt(promptStr()); rl.prompt();
  while (true) {
    const { value, done } = await iter.next();
    if (done) break;
    await handle(value.trim());
    rl.setPrompt(promptStr()); rl.prompt();
  }
  process.exit(0);
})();
