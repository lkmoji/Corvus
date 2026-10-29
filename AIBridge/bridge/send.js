// node send.js [опции] текст
//   -p профиль   -s сессия   -w сайт(deepseek|chatgpt)   -n новый чат
//   -x full|code|json   -t таймаут_мс   -c команда(ask|new_chat|close|sessions|profiles|ping)
// либо готовый JSON:  node send.js {"cmd":"ping"}
const net = require('net');
const args = process.argv.slice(2);
if (!args.length) { console.log('usage: node send.js [-p profile] [-s session] [-w site] [-n] [-x extract] [-t ms] [-c cmd] text'); process.exit(1); }

let payload;
if (args[0].trim().startsWith('{')) {
  payload = args.join(' ');
} else {
  const msg = { cmd: 'ask' }; const words = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-p') msg.profile = args[++i];
    else if (a === '-s') msg.session = args[++i];
    else if (a === '-w') msg.site = args[++i];
    else if (a === '-c') msg.cmd = args[++i];
    else if (a === '-x') msg.extract = args[++i];
    else if (a === '-t') msg.timeoutMs = +args[++i];
    else if (a === '-n') msg.chat = 'new';
    else words.push(a);
  }
  if (words.length) msg.text = words.join(' ');
  payload = JSON.stringify(msg);
}

const s = net.connect(9224, '127.0.0.1', () => s.write(payload + '\n'));
s.setEncoding('utf8');
let out = '';
s.on('data', (d) => (out += d));
s.on('end', () => {
  try {
    const r = JSON.parse(out);
    if (r.ok === false) console.log('ERROR: ' + r.error);
    else if (typeof r.text === 'string') console.log(r.text);
    else console.log(JSON.stringify(r, null, 2));
  } catch (e) { console.log(out); }
});
s.on('error', (e) => console.log('connect error:', e.message));
