#!/usr/bin/env python3
"""
Мост между Telegram Desktop и прокси аккаунта.

Telegram Desktop не отправляет логин и пароль HTTP-прокси: прокси отвечает 407,
и клиент просто не подключается. Поэтому Desktop ходит в этот мост — SOCKS5 без
пароля, слушает только 127.0.0.1, — а мост уже добавляет авторизацию и держит
соединение с прокси аккаунта. Весь трафик Telegram идёт через прокси, своего IP
аккаунт не показывает.

    python3 bridge.py           поднять мост (порт берётся из kit.json)
    python3 bridge.py --check   только проверить прокси и показать его IP
"""
import asyncio
import base64
import json
import socket
import struct
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
CFG = json.loads((HERE / "kit.json").read_text("utf-8"))
PROXY = CFG["proxy"]
PORT = int(CFG.get("listen", 18080))
SOCKS = str(PROXY.get("scheme", "http")).startswith("socks")


def auth_header():
    if not PROXY.get("user"):
        return ""
    raw = f"{PROXY['user']}:{PROXY.get('pass', '')}".encode()
    return "Proxy-Authorization: Basic " + base64.b64encode(raw).decode() + "\r\n"


async def socks_connect(r, w, host, port):
    """Рукопожатие SOCKS5 с прокси аккаунта, когда он сам socks."""
    user = PROXY.get("user") or ""
    w.write(b"\x05\x02\x00\x02" if user else b"\x05\x01\x00")
    await w.drain()
    _, method = await r.readexactly(2)
    if method == 0x02:
        pw = (PROXY.get("pass") or "").encode()
        w.write(bytes([1, len(user)]) + user.encode() + bytes([len(pw)]) + pw)
        await w.drain()
        if (await r.readexactly(2))[1] != 0:
            raise OSError("прокси не принял логин и пароль")
    elif method != 0x00:
        raise OSError("прокси не поддерживает вход по логину и паролю")
    host_b = host.encode()
    w.write(b"\x05\x01\x00\x03" + bytes([len(host_b)]) + host_b + struct.pack("!H", port))
    await w.drain()
    head = await r.readexactly(4)
    if head[1] != 0:
        raise OSError(f"прокси отказал: код {head[1]}")
    skip = {1: 4, 4: 16}.get(head[3])
    if skip is None:
        skip = (await r.readexactly(1))[0]
    await r.readexactly(skip + 2)


async def dial(host, port):
    """Соединение до host:port через прокси аккаунта."""
    r, w = await asyncio.open_connection(PROXY["host"], int(PROXY["port"]))
    try:
        if SOCKS:
            await socks_connect(r, w, host, port)
        else:
            w.write((f"CONNECT {host}:{port} HTTP/1.1\r\n"
                     f"Host: {host}:{port}\r\n" + auth_header() +
                     "Proxy-Connection: Keep-Alive\r\n\r\n").encode())
            await w.drain()
            status = (await r.readline()).decode("latin1").strip()
            parts = status.split(" ")
            if len(parts) < 2 or parts[1] != "200":
                raise OSError(f"прокси ответил «{status or 'пусто'}»")
            while True:                       # дочитываем заголовки до пустой строки
                line = await r.readline()
                if line in (b"\r\n", b"\n", b""):
                    break
    except Exception:
        w.close()
        raise
    return r, w


async def pipe(src, dst):
    try:
        while True:
            chunk = await src.read(65536)
            if not chunk:
                break
            dst.write(chunk)
            await dst.drain()
    except Exception:
        pass
    finally:
        try:
            dst.close()
        except Exception:
            pass


async def serve(cli_r, cli_w):
    up_w = None
    try:
        _, n = await cli_r.readexactly(2)          # привет SOCKS5
        await cli_r.readexactly(n)
        cli_w.write(b"\x05\x00")                   # без пароля — мы на 127.0.0.1
        await cli_w.drain()

        head = await cli_r.readexactly(4)          # версия, команда, резерв, тип адреса
        if head[1] != 1:
            raise OSError("мост умеет только обычное соединение")
        kind = head[3]
        if kind == 1:
            host = socket.inet_ntoa(await cli_r.readexactly(4))
        elif kind == 3:
            ln = (await cli_r.readexactly(1))[0]
            host = (await cli_r.readexactly(ln)).decode()
        elif kind == 4:
            host = socket.inet_ntop(socket.AF_INET6, await cli_r.readexactly(16))
        else:
            raise OSError("непонятный адрес")
        port = struct.unpack("!H", await cli_r.readexactly(2))[0]

        up_r, up_w = await dial(host, port)
        cli_w.write(b"\x05\x00\x00\x01\x00\x00\x00\x00\x00\x00")
        await cli_w.drain()
    except Exception as e:
        try:
            cli_w.write(b"\x05\x01\x00\x01\x00\x00\x00\x00\x00\x00")
            await cli_w.drain()
        except Exception:
            pass
        cli_w.close()
        if up_w is not None:
            up_w.close()
        # кто-то просто постучался и ушёл, не поздоровавшись: так проверяют,
        # поднялся ли мост. Это не ошибка, и пугать ею в окне незачем
        quiet = isinstance(e, asyncio.IncompleteReadError) and not e.partial
        if not quiet:
            print(f"  мост: не вышло соединиться — {e}", flush=True)
        return
    await asyncio.gather(pipe(cli_r, up_w), pipe(up_r, cli_w))


async def check():
    """Что видно снаружи: ходим за своим IP через тот же прокси."""
    host, port = "api.ipify.org", 80
    if SOCKS:
        r, w = await dial(host, port)
        w.write(f"GET / HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\r\n".encode())
    else:
        r, w = await asyncio.open_connection(PROXY["host"], int(PROXY["port"]))
        w.write((f"GET http://{host}/ HTTP/1.1\r\nHost: {host}\r\n" + auth_header() +
                 "Connection: close\r\n\r\n").encode())
    await w.drain()
    body = (await r.read()).decode("latin1")
    w.close()
    return body.rsplit("\r\n\r\n", 1)[-1].strip()


async def main():
    if "--check" in sys.argv:
        print(await check())
        return
    try:
        ip = await asyncio.wait_for(check(), 25)
        print(f"  прокси в порядке, наружу видно IP {ip}", flush=True)
    except Exception as e:
        print(f"  прокси не ответил: {e}", flush=True)
        print("  Telegram без прокси не запускаю — иначе аккаунт выйдет с твоего IP.", flush=True)
        sys.exit(2)
    server = await asyncio.start_server(serve, "127.0.0.1", PORT)
    print(f"  мост слушает 127.0.0.1:{PORT}", flush=True)
    async with server:
        await server.serve_forever()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
