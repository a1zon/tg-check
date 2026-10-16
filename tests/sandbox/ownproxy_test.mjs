// Песочница для «свой IP каждому»: поддельный Asocks + локальный прокси, который
// по логину сессии изображает разные случаи. Сеть наружу не нужна.
//   node tests/sandbox/ownproxy_test.mjs
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeOwnProxy } from '../../server/ownproxy.mjs';

const user = (req) => {
  const h = req.headers['proxy-authorization'] || '';
  return Buffer.from(h.replace(/^Basic /, ''), 'base64').toString().split(':')[0];
};
let jumpy = 0;
const srv = http.createServer((req, res) => {
  const u = user(req);
  if (u.startsWith('dead')) { res.writeHead(502); return res.end(); }
  const n = u.split('-')[1] || '0';
  const ip = u.startsWith('jumpy') ? `10.9.9.${++jumpy}` : u.startsWith('dupe') ? '10.0.0.1' : `10.0.0.${n}`;
  const country = u.startsWith('foreign') ? 'BR' : 'KZ';
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ip, country, org: 'AS1 Test Mobile' }));
});
srv.on('connect', (req, sock) => {
  const ok = !user(req).startsWith('blocked');
  sock.end(ok ? 'HTTP/1.1 200 Connection established\r\n\r\n' : 'HTTP/1.1 403 Forbidden\r\n\r\n');
});
await new Promise((r) => srv.listen(18998, '127.0.0.1', r));

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ownproxy-'));
const sess = ['dead-1', 'jumpy-2', 'foreign-3', 'blocked-4', 'sticky-1', 'dupe-9', 'sticky-5', 'sticky-6', 'taken-7']
  .map((l) => `http://${l}:pw@109.236.84.23:9999`);
let accs = ['a1', 'a2', 'a3'].map((id) => ({ id, proxy: 'http://shared:pw@190.2.137.56:9999' }));
const set = [];
const own = makeOwnProxy({
  dir, gateway: '127.0.0.1:18998',
  asocks: { search: async () => sess },
  listAccounts: () => accs,
  otherProxies: () => ['http://taken-7:pw@190.2.137.56:9999'],   // занята в соседнем профиле
  setProxy: (id, raw, prev) => { set.push({ id, raw, prev }); accs = accs.map((a) => a.id === id ? { ...a, proxy: raw } : a); },
});
console.log('нормализация:', own.normalize(sess[4]));
for (const s of ['dead-1', 'jumpy-2', 'foreign-3', 'blocked-4', 'sticky-1']) {
  console.log(s.padEnd(10), JSON.stringify(await own.check(own.normalize(`http://${s}:pw@x:1`), 'KZ')));
}
const res = await own.assign({ ids: ['a1', 'a2', 'a3'], maxTries: 9 });
console.log('раздача:', JSON.stringify(res));
console.log('выдано:', set.map((x) => `${x.id} → ${own.sessionId(x.raw)} (было ${own.sessionId(x.prev)})`).join('; '));
console.log('занятую в соседнем профиле не взяли:', !set.some((x) => x.raw.includes('taken-7')));
console.log('повторная раздача a1 (свою же сессию не дублирует):', JSON.stringify(await own.assign({ ids: ['a1'] })));
srv.close();
