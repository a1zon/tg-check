#!/usr/bin/env python3
"""
Проверка прокси аккаунта для работы через Telethon.

Отвечает на два вопроса сразу:
  1. виден ли аккаунт из интернета с адреса прокси (а не с вашего);
  2. пропускает ли этот прокси сам Telegram — MTProto к дата-центру.
Второе важнее: полно прокси, через которые открывается любой сайт, а
дата-центры Telegram закрыты. Для панели такой прокси бесполезен.

    python proxy-check.py --account a2
"""
import json
import socket
import ssl
import sys
import urllib.request

import tglib
from tglib import say

IPURL = "https://api.ipify.org?format=json"
TIMEOUT = 15


def my_ip():
    try:
        with urllib.request.urlopen(IPURL, timeout=TIMEOUT) as r:
            return json.loads(r.read())["ip"]
    except Exception as e:
        return f"не узнать ({type(e).__name__})"


def through_proxy(proxy, host, port, path):
    """HTTP-запрос через прокси тем же способом, каким пойдёт Telethon."""
    from python_socks.sync import Proxy
    kind, phost, pport = proxy[0], proxy[1], proxy[2]
    url = f"{kind}://{phost}:{pport}"
    if len(proxy) > 4 and proxy[4]:
        url = f"{kind}://{proxy[4]}:{proxy[5]}@{phost}:{pport}"
    sock = Proxy.from_url(url).connect(dest_host=host, dest_port=port, timeout=TIMEOUT)
    ctx = ssl.create_default_context()
    with ctx.wrap_socket(sock, server_hostname=host) as s:
        s.settimeout(TIMEOUT)
        s.sendall(f"GET {path} HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\r\n"
                  .encode())
        data = b""
        while chunk := s.recv(4096):
            data += chunk
    return json.loads(data.split(b"\r\n\r\n", 1)[1])["ip"]


def dc_reachable(proxy, dc=2):
    """Доходит ли до дата-центра Telegram — то, что реально нужно MTProto."""
    ip = tglib.DC_IP[dc]
    try:
        if proxy:
            from python_socks.sync import Proxy
            kind, phost, pport = proxy[0], proxy[1], proxy[2]
            url = f"{kind}://{phost}:{pport}"
            if len(proxy) > 4 and proxy[4]:
                url = f"{kind}://{proxy[4]}:{proxy[5]}@{phost}:{pport}"
            Proxy.from_url(url).connect(dest_host=ip, dest_port=443, timeout=TIMEOUT).close()
        else:
            socket.create_connection((ip, 443), timeout=TIMEOUT).close()
        return True, ""
    except Exception as e:
        return False, f"{type(e).__name__}: {str(e).splitlines()[0][:80]}"


def explain(err: str, proxy):
    low = err.lower()
    if "auth" in low or "407" in low:
        return "прокси требует логин с паролем — впиши их: host:port:логин:пароль"
    if "resolve" in low or "getaddrinfo" in low or "name" in low and "not known" in low:
        return "не находится такой хост — опечатка в адресе прокси"
    if "timed out" in low or "timeout" in low:
        return ("прокси не ответил: либо он мёртв, либо не подошли логин с паролем"
                if proxy and len(proxy) > 4 else "прокси не ответил вовремя — скорее всего мёртвый")
    if "refused" in low:
        return "прокси не принимает соединения — проверь адрес и порт"
    return err


def main():
    acc = tglib.resolve(tglib.arg("account", ""))
    say(f"аккаунт: {acc['title']}")
    say(f"прокси:  {tglib.proxy_label(acc.get('proxy'))}")
    proxy = tglib.parse_proxy(acc.get("proxy"))

    mine = my_ip()
    say(f"\nсвой адрес:      {mine}")

    if not proxy:
        say("\nпрокси не задан — аккаунт ходит с вашего адреса.")
        ok, err = dc_reachable(None)
        say("дата-центр Telegram: " + ("доступен ✓" if ok else f"НЕ доступен — {err}"))
        if not ok:
            say("\n✕ без прокси или VPN Telethon работать не сможет: MTProto закрыт.")
            sys.exit(1)
        return

    try:
        through = through_proxy(proxy, "api.ipify.org", 443, "/?format=json")
        say(f"через прокси:    {through}")
        same = through == mine
    except Exception as e:
        say(f"через прокси:    не получилось\n\n✕ {explain(str(e), proxy)}")
        sys.exit(1)

    ok, err = dc_reachable(proxy)
    say("дата-центр Telegram: " + ("доступен ✓" if ok else f"НЕ доступен — {err}"))

    if same:
        say("\n✕ адрес не изменился — трафик идёт мимо прокси.")
        sys.exit(1)
    if not ok:
        say("\n✕ прокси работает, но Telegram через него не пускает — для панели он не годится.")
        sys.exit(1)
    say("\n✓ прокси годится: аккаунт будет виден Telegram с этого адреса.")


main()
