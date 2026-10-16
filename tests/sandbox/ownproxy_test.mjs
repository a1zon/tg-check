// Песочница для «свой IP каждому» (строки «регион + своя сессия»): нужен запущенный
// tests/sandbox/fake_asocks.mjs (порты 18997/18998).   node tests/sandbox/ownproxy_test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeOwnProxy } from '../../server/ownproxy.mjs';
const api = async (ep) => (await fetch('http://127.0.0.1:18997/' + ep)).json();
const asocks = { sessionBase: async () => {
  const t = (await api('v2/proxy/ports')).message.proxies[0].template;
  const m = /^\w+:\/\/([^:]+?)-pool[^:]*:([^@]+)@[^:]+:(\d+)/.exec(t);
  return { user: m[1], password: m[2], port: m[3], country: 'KZ', states: (await api('v2/dir/states')).states };
} };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ownproxy-'));
let accs = ['a1', 'a2', 'a3'].map((id) => ({ id, proxy: 'http://shared:pw@190.2.137.56:9999' }));
const own = makeOwnProxy({ dir, asocks, gateway: '127.0.0.1:18998',
  listAccounts: () => accs,
  setProxy: (id, raw) => { accs = accs.map((a) => a.id === id ? { ...a, proxy: raw } : a); } });
const r1 = await own.assign({ ids: ['a1', 'a2', 'a3'] });
console.log('раздача:', JSON.stringify(r1.map((x) => [x.id, x.ok, x.region, x.ip])));
console.log('строки разные:', new Set(accs.map((a) => a.proxy)).size === 3, '| пример:', accs[0].proxy.replace(/:[^:@]+@/, ':***@'));
const r2 = await own.assign({ ids: ['a2'] });
console.log('замена a2 — регион тот же, IP новый:', r2[0].region === r1[1].region, r2[0].ip !== r1[1].ip);
const ownB = makeOwnProxy({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'ownproxy-')), asocks, gateway: '127.0.0.1:18998',
  listAccounts: () => accs, setProxy: () => {}, regions: ['Blocked'] });
console.log('регион без доступа к Telegram:', JSON.stringify(await ownB.assign({ ids: ['a1'], maxTries: 2 })));
