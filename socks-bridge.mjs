/**
 * Локальный мост для SOCKS5-прокси с логином и паролем.
 *
 * Chromium не умеет авторизацию в SOCKS5 (ошибка «Browser does not support
 * socks5 proxy authentication»), а именно так продают большинство прокси.
 * Мост поднимает у себя обычный HTTP-прокси без пароля, куда Chromium ходит
 * спокойно, а сам дальше идёт в SOCKS5 с нужными логином и паролем.
 *
 * Живёт внутри того же процесса, что и браузерный скрипт: поднялся перед
 * запуском Chromium, закрылся после. Наружу порт не торчит — только 127.0.0.1.
 *
 *   const b = await startBridge({ server:'socks5://h:p', username, password });
 *   launch({ proxy: { server: b.url } });  ... b.close();
 */
import net from 'node:net';
import http from 'node:http';

/** Один шаг обмена с SOCKS5: пишем и ждём ответ нужной длины. */
function sockConnect(up, host, port, user, pass) {
  return new Promise((resolve, reject) => {
    const s = net.connect(up.port, up.host);
    let stage = 'greet';
    const fail = (m) => { s.destroy(); reject(new Error(m)); };
    s.setTimeout(15_000, () => fail('SOCKS5: таймаут'));
    s.on('error', (e) => fail(`SOCKS5: ${e.message}`));

    s.on('connect', () => s.write(Buffer.from([0x05, 0x01, 0x02]))); // версия 5, метод 2 (user/pass)

    s.on('data', (d) => {
      if (stage === 'greet') {
        if (d[0] !== 0x05 || d[1] !== 0x02) return fail('SOCKS5: сервер не принял вход по паролю');
        const u = Buffer.from(user), p = Buffer.from(pass);
        s.write(Buffer.concat([Buffer.from([0x01, u.length]), u, Buffer.from([p.length]), p]));
        stage = 'auth';
      } else if (stage === 'auth') {
        if (d[1] !== 0x00) return fail('SOCKS5: логин или пароль не подошли');
        const h = Buffer.from(host);
        const req = Buffer.concat([
          Buffer.from([0x05, 0x01, 0x00, 0x03, h.length]), h,
          Buffer.from([(port >> 8) & 0xff, port & 0xff]),
        ]);
        s.write(req);
        stage = 'req';
      } else if (stage === 'req') {
        if (d[1] !== 0x00) return fail(`SOCKS5: цель недоступна (код ${d[1]})`);
        s.removeAllListeners('data');
        s.setTimeout(0);
        resolve(s);
      }
    });
  });
}

export async function startBridge(proxy) {
  const m = String(proxy.server).match(/^socks5?:\/\/([^:]+):(\d+)$/i);
  if (!m) throw new Error(`не разобрал SOCKS5-адрес: ${proxy.server}`);
  const up = { host: m[1], port: +m[2] };
  const { username = '', password = '' } = proxy;

  const server = http.createServer((req, res) => {
    res.writeHead(405).end('bridge: only CONNECT');
  });

  // весь трафик Chromium к HTTPS идёт через CONNECT — его и проксируем
  server.on('connect', async (req, client, head) => {
    const [host, port] = req.url.split(':');
    try {
      const upstream = await sockConnect(up, host, +port || 443, username, password);
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
      const drop = () => { upstream.destroy(); client.destroy(); };
      client.on('error', drop); upstream.on('error', drop);
    } catch (e) {
      client.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      client.end();
    }
  });

  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { url, close: () => new Promise((ok) => server.close(ok)) };
}
