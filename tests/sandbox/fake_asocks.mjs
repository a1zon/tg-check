// Поддельный Asocks для панели в песочнице: API (18997) + шлюз-прокси (18998).
// Строка «…-state-<id>-session-<метка>»: своя метка — свой постоянный IP; регион 9 — «Blocked»
// (не пускает к Telegram); метка, начинающаяся с «co», выходит из Колумбии; логин dead* — 404.
//   node tests/sandbox/fake_asocks.mjs
import http from 'node:http';
import crypto from 'node:crypto';
const states = [{ id: 1, name: 'Almaty' }, { id: 2, name: 'Astana' }, { id: 9, name: 'Blocked' }];
http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const j = u.pathname.includes('proxy/ports')
    ? { success: true, message: { proxies: [{ id: 1, name: 'p', template: 'http://usr1-pool-mobile-country-KZ-state-2-mode-query:pw@109.236.84.23:9999' }] } }
    : u.pathname.includes('dir/countries') ? { success: true, countries: [{ id: 77, code: 'KZ', name: 'Kazakhstan' }] }
    : u.pathname.includes('dir/states') ? { success: true, states }
    : u.pathname.includes('balance') ? { success: true, balance: 10 }
    : u.pathname.includes('total-spent') ? { success: true, total_spent_traffic: 0 }
    : { success: true };
  res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(j));
}).listen(18997, '127.0.0.1');
const user = (req) => Buffer.from(String(req.headers['proxy-authorization'] || '').replace(/^Basic /, ''), 'base64').toString().split(':')[0];
const px = http.createServer((req, res) => {
  const u = user(req);
  if (u.startsWith('dead')) { res.writeHead(404); return res.end(); }
  const tok = (u.match(/-session-(\w+)/) || [, u])[1];
  const h = crypto.createHash('md5').update(tok).digest();
  const ip = `10.${h[0]}.${h[1]}.${h[2]}`;
  const st = (u.match(/-state-(\d+)/) || [, '1'])[1];
  const city = (states.find((s) => String(s.id) === st) || states[0]).name;
  const country = tok.startsWith('co') ? 'CO' : 'KZ';
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ip, country, city, org: 'AS29355 Kcell JSC' }));
});
px.on('connect', (req, sock) => sock.end(/-state-9-|^(blocked|dead)/.test(user(req))
  ? 'HTTP/1.1 403 Forbidden\r\n\r\n' : 'HTTP/1.1 200 Connection established\r\n\r\n'));
px.listen(18998, '127.0.0.1');
console.log('fake asocks: api 18997, gateway 18998');
