// Поддельный Asocks для панели в песочнице: API (18997) + шлюз-прокси (18998).
// Сессии sticky-N держат IP 10.0.0.N; jumpy — скачет; blocked — не пускает к Telegram.
//   node tests/sandbox/fake_asocks.mjs
import http from 'node:http';
const sess = ['jumpy-1', 'blocked-2', 'sticky-3', 'sticky-4', 'sticky-5', 'sticky-6', 'sticky-7', 'sticky-8']
  .map((l) => `http://${l}:pw@109.236.84.23:9999`);
http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const j = u.pathname.includes('proxy/search') ? [{ success: true }, ...sess]
    : u.pathname.includes('balance') ? { success: true, balance: 10 }
    : u.pathname.includes('total-spent') ? { success: true, total_spent_traffic: 0 }
    : { success: true, message: { proxies: [] } };
  res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(j));
}).listen(18997, '127.0.0.1');
const user = (req) => Buffer.from(String(req.headers['proxy-authorization'] || '').replace(/^Basic /, ''), 'base64').toString().split(':')[0];
let k = 0;
const px = http.createServer((req, res) => {
  const u = user(req);
  if (u.startsWith('dead')) { res.writeHead(404); return res.end(); }   // сессия пропала из пула
  const ip = u.startsWith('jumpy') ? `10.9.9.${++k}` : `10.0.0.${u.split('-')[1]}`;
  if (String(req.url).includes('ipify')) { res.writeHead(200); return res.end(ip); }   // сторож прокси
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ip, country: 'KZ', org: 'AS29355 Kcell JSC' }));
});
px.on('connect', (req, sock) => sock.end(/^(blocked|dead)/.test(user(req))
  ? 'HTTP/1.1 403 Forbidden\r\n\r\n' : 'HTTP/1.1 200 Connection established\r\n\r\n'));
px.listen(18998, '127.0.0.1');
console.log('fake asocks: api 18997, gateway 18998');
