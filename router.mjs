/**
 * Привратник: одна панель — несколько профилей.
 *
 * У каждого профиля своя папка с данными (реестр аккаунтов, сессии, база,
 * результаты, лиды, прогрев) и свой вход. Привратник занимает публичный порт,
 * держит по процессу панели на профиль и передаёт запросы тому, чьим логином
 * ты вошёл. Чужого профиля для тебя не существует: ни в списке, ни по ссылке.
 *
 * Код у профилей общий — обновление одно на всех. Разделены только данные.
 *
 *     node router.mjs --port 8787 --no-open
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as auth from './auth.mjs';

const CODE = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.TG_PANEL_BASE ? path.resolve(process.env.TG_PANEL_BASE) : CODE;
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? d : process.argv[i + 1]; };
const PORT = +(arg('port', 8787));

const PROFILES = path.join(BASE, 'profiles.json');
const SECRET_FILE = path.join(BASE, 'router.json');
const COOKIE = 'tgprofile';
const DAYS = 14;
const FIRST_PORT = 8801;      // внутренние порты профилей, только 127.0.0.1

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

/**
 * Список профилей. Если его ещё нет — заводим из того, что уже работает:
 * нынешние данные становятся первым профилем и остаются на месте, вместе
 * со своим входом. Ничего переносить не нужно.
 */
function readProfiles() {
  try {
    const list = JSON.parse(fs.readFileSync(PROFILES, 'utf8'));
    if (Array.isArray(list) && list.length) {
      // список мог быть заведён до того, как появился признак основного
      // профиля: без него профили стало бы некому заводить
      if (!list.some((p) => p.admin)) {
        list[0].admin = true;
        fs.writeFileSync(PROFILES, JSON.stringify(list, null, 1) + '\n');
      }
      return list;
    }
  } catch {}
  const list = [{ id: 'main', title: 'Основной', dir: '.', port: FIRST_PORT, admin: true }];
  fs.writeFileSync(PROFILES, JSON.stringify(list, null, 1) + '\n');
  log('завёл profiles.json: нынешние данные стали профилем «Основной»');
  return list;
}

/** Секрет для подписи куки входа. Переживает перезапуск — иначе всех разлогинит. */
function secret() {
  try {
    const s = JSON.parse(fs.readFileSync(SECRET_FILE, 'utf8')).secret;
    if (s) return s;
  } catch {}
  const s = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(SECRET_FILE, JSON.stringify({ secret: s }, null, 1) + '\n', { mode: 0o600 });
  return s;
}

const SECRET = secret();
const sign = (data) => crypto.createHmac('sha256', SECRET).update(data).digest('base64url');

function issue(id) {
  const body = `${id}.${Date.now() + DAYS * 86400e3}`;
  return `${body}.${sign(body)}`;
}

/** Какой профиль в куке. Чужая или протухшая — никакой. */
function sessionOf(cookieHeader) {
  const raw = String(cookieHeader || '').split(';')
    .map((p) => p.trim().split('='))
    .find(([k]) => k === COOKIE);
  if (!raw) return null;
  const parts = String(raw[1] || '').split('.');
  if (parts.length !== 3) return null;
  const [id, exp, mac] = parts;
  const want = sign(`${id}.${exp}`);
  if (mac.length !== want.length ||
      !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(want))) return null;
  if (+exp < Date.now()) return null;
  return id;
}

/* ═══════════ ПРОЦЕССЫ ПРОФИЛЕЙ ═══════════ */

const kids = new Map();   // id -> { port, token, child, dir, title, admin, tries }
const writeProfiles = (list) => fs.writeFileSync(PROFILES, JSON.stringify(list, null, 1) + '\n');
const dirOf = (p) => path.resolve(BASE, p.dir || path.join('profiles', p.id));

/**
 * Профили работают всегда, а не только пока кто-то смотрит в панель: прогрев,
 * рассылка и проверка ответов идут сами. Поэтому процессы поднимаются при
 * старте и перезапускаются, если упали.
 */
function start(p) {
  const dir = path.resolve(BASE, p.dir || path.join('profiles', p.id));
  fs.mkdirSync(dir, { recursive: true });
  const token = crypto.randomBytes(24).toString('hex');
  const child = spawn(process.execPath, [path.join(CODE, 'admin.mjs'), '--port', String(p.port), '--no-open'], {
    cwd: CODE,
    env: { ...process.env, TG_PANEL_DIR: dir, TG_PANEL_TOKEN: token,
           TG_PROFILE: p.title || p.id, TG_PROFILE_ADMIN: p.admin ? '1' : '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const kid = { port: p.port, token, child, dir, title: p.title || p.id, admin: !!p.admin, tries: 0 };
  kids.set(p.id, kid);

  const pipe = (stream) => stream.on('data', (b) => {
    for (const line of String(b).split('\n')) if (line.trim()) log(`[${p.id}]`, line);
  });
  pipe(child.stdout); pipe(child.stderr);

  child.on('exit', (code) => {
    log(`[${p.id}] панель профиля завершилась (${code})`);
    kid.child = null;
    // пять попыток подряд — дальше ждём человека: обычно это не задан вход
    // или занят порт, и перезапуск по кругу только забьёт журнал
    if (++kid.tries <= 5) setTimeout(() => start(p), 5000);
    else log(`[${p.id}] больше не перезапускаю — смотри строки выше`);
  });
  child.on('spawn', () => { setTimeout(() => { kid.tries = 0; }, 60_000); });
  log(`[${p.id}] поднимаю профиль «${kid.title}» на 127.0.0.1:${p.port}, данные: ${dir}`);
}

/** Жив ли порт профиля: пока панель не слушает, передавать ей нечего. */
function alive(port) {
  return new Promise((ok) => {
    const s = net.connect({ host: '127.0.0.1', port }, () => { s.destroy(); ok(true); });
    s.on('error', () => ok(false));
    s.setTimeout(1500, () => { s.destroy(); ok(false); });
  });
}

/* ═══════════ ВХОД ═══════════ */

const fails = new Map();   // ip -> { n, until }

function blocked(ip) {
  const f = fails.get(ip);
  if (!f || !f.until) return 0;
  const left = Math.ceil((f.until - Date.now()) / 1000);
  return left > 0 ? left : 0;
}
function noteFail(ip) {
  const f = fails.get(ip) || { n: 0, until: 0 };
  f.n++;
  if (f.n >= 5) { f.until = Date.now() + 60_000; f.n = 0; }
  fails.set(ip, f);
}
const noteOk = (ip) => fails.delete(ip);

/** Чей это логин с паролем. Проверяем по auth.json каждого профиля. */
function whose(user, pass) {
  for (const [id, kid] of kids) {
    if (auth.checkIn(kid.dir, user, pass)) return id;
  }
  return null;
}


/* ═══════════ ПРОФИЛИ: СПИСОК И УПРАВЛЕНИЕ ═══════════ */

/** Сколько аккаунтов в профиле — чтобы на странице было видно, пустой он или нет. */
function accountsIn(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'accounts.json'), 'utf8')).length; }
  catch { return 0; }
}

/** Кто входит в профиль. Пароль, разумеется, не отдаём — только логин. */
function userIn(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'auth.json'), 'utf8')).user || ''; }
  catch { return ''; }
}

function profilesFull() {
  return [...kids].map(([id, k]) => ({
    id, title: k.title, admin: k.admin, user: userIn(k.dir),
    accounts: accountsIn(k.dir), running: !!k.child,
  }));
}

/** Завести профиль на ходу: папка, вход, запись в список, свой процесс. */
function addProfile({ title, user, pass }) {
  const name = String(title || '').trim();
  if (!name) throw new Error('не задано название профиля');
  const list = readProfiles();
  // имя папки делаем сами: человеку в него не тыкать, а в пути ему латиница
  const id = 'p' + crypto.randomBytes(3).toString('hex');
  const port = Math.max(FIRST_PORT - 1, ...list.map((p) => +p.port || 0)) + 1;
  const p = { id, title: name, dir: path.join('profiles', id), port };
  auth.setPasswordIn(dirOf(p), user, pass);     // сам проверит логин и длину пароля
  fs.chmodSync(dirOf(p), 0o700);
  writeProfiles([...list, p]);
  start(p);
  return p;
}

function removeProfile(id) {
  const list = readProfiles();
  const p = list.find((x) => x.id === id);
  if (!p) throw new Error('нет такого профиля');
  if (p.admin || (p.dir || '.') === '.') throw new Error('основной профиль убрать нельзя');
  const kid = kids.get(id);
  if (kid) { kid.tries = 99; kid.child?.kill('SIGTERM'); kids.delete(id); }
  writeProfiles(list.filter((x) => x.id !== id));
  return dirOf(p);
}

/* ═══════════ ПЕРЕДАЧА ЗАПРОСОВ ═══════════ */

function proxy(req, res, kid) {
  const headers = { ...req.headers };
  // кука браузера принадлежит привратнику; панели профиля вместо неё — ключ
  delete headers.cookie;
  delete headers.host;
  // Источник запроса проверен выше, у привратника. Дальше его пересылать
  // нельзя: панель профиля слушает свой внутренний порт и, сверяя Origin со
  // своим адресом, отбивала бы каждый POST как «чужой источник».
  delete headers.origin;
  delete headers.referer;
  headers['x-panel-token'] = kid.token;
  const up = http.request({ host: '127.0.0.1', port: kid.port, path: req.url,
                            method: req.method, headers }, (r) => {
    res.writeHead(r.statusCode, r.headers);
    r.pipe(res);
  });
  up.on('error', (e) => {
    if (res.headersSent) return res.end();
    res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: `профиль не отвечает: ${e.message}` }));
  });
  req.pipe(up);
}

function page(res, name) {
  const file = path.join(CODE, 'web', name);
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  fs.createReadStream(file).pipe(res);
}

const json = (res, code, data) => {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(data));
};

async function body(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { return {}; }
}

const server = http.createServer(async (req, res) => {
  const ip = req.socket.remoteAddress || '';
  const url = new URL(req.url, 'http://x');

  if (req.method === 'POST') {
    const origin = req.headers.origin;
    if (origin) {
      let bad = true;
      try { bad = new URL(origin).host !== req.headers.host; } catch {}
      if (bad) return json(res, 403, { error: 'чужой источник запроса' });
    }
    if (req.headers['x-panel'] !== '1') return json(res, 403, { error: 'запрос не из панели' });
  }

  // Какие профили есть — видно и до входа: иначе непонятно, чьим логином
  // заходить. Отдаём только названия, ничего больше.
  if (url.pathname === '/api/profiles' && req.method === 'GET') {
    return json(res, 200, [...kids].map(([id, k]) => ({ id, title: k.title })));
  }

  if (url.pathname === '/api/login' && req.method === 'POST') {
    const wait = blocked(ip);
    if (wait) return json(res, 429, { ok: false, reason: `слишком много попыток, подожди ${wait} с` });
    const { user, pass } = await body(req);
    const id = whose(user, pass);
    if (!id) { noteFail(ip); return json(res, 401, { ok: false, reason: 'логин или пароль не подходят' }); }
    noteOk(ip);
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'set-cookie': `${COOKIE}=${issue(id)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${DAYS * 86400}`,
    });
    return res.end(JSON.stringify({ ok: true }));
  }

  if (url.pathname === '/api/logout' && req.method === 'POST') {
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'set-cookie': `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`,
    });
    return res.end(JSON.stringify({ ok: true }));
  }

  const id = sessionOf(req.headers.cookie);
  const kid = id && kids.get(id);
  if (!kid) {
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/login')) {
      return page(res, 'login.html');
    }
    return json(res, 401, { error: 'нужен вход' });
  }


  // Управление профилями — только из основного: он один заводит остальные.
  if (url.pathname.startsWith('/api/profiles/') || url.pathname === '/profiles') {
    if (!kid.admin) return json(res, 403, { error: 'профили заводит только основной профиль' });

    if (url.pathname === '/profiles') return page(res, 'profiles.html');
    if (url.pathname === '/api/profiles/list') return json(res, 200, profilesFull());

    if (url.pathname === '/api/profiles/add' && req.method === 'POST') {
      try {
        const p = addProfile(await body(req));
        log(`завели профиль «${p.title}»`);
        return json(res, 200, { ok: true, id: p.id });
      } catch (e) { return json(res, 200, { ok: false, reason: e.message }); }
    }

    if (url.pathname === '/api/profiles/password' && req.method === 'POST') {
      const { id, user, pass } = await body(req);
      const k = kids.get(id);
      if (!k) return json(res, 200, { ok: false, reason: 'нет такого профиля' });
      try { auth.setPasswordIn(k.dir, user, pass); }
      catch (e) { return json(res, 200, { ok: false, reason: e.message }); }
      return json(res, 200, { ok: true });
    }

    if (url.pathname === '/api/profiles/remove' && req.method === 'POST') {
      const { id } = await body(req);
      try {
        const dir = removeProfile(id);
        log(`убрали профиль ${id}, данные остались в ${dir}`);
        return json(res, 200, { ok: true, dir });
      } catch (e) { return json(res, 200, { ok: false, reason: e.message }); }
    }
    return json(res, 404, { error: 'нет такой страницы' });
  }

  if (!kid.child && !(await alive(kid.port))) {
    return json(res, 503, { error: `профиль «${kid.title}» сейчас не работает — смотри журнал службы` });
  }
  proxy(req, res, kid);
});

for (const p of readProfiles()) start(p);

server.listen(PORT, '127.0.0.1', () => {
  log(`привратник на http://127.0.0.1:${PORT} — профилей ${kids.size}`);
});

// Уходим — забираем профили с собой: осиротевшие панели держали бы порты
// и продолжали работать с аккаунтами, пока никто не смотрит.
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    for (const kid of kids.values()) kid.child?.kill('SIGTERM');
    process.exit(0);
  });
}
