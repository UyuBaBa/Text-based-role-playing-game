"""Запуск игры:  python run.py

Поднимает локальный сервер и открывает браузер. Ключ API остаётся на стороне
сервера и в браузер не попадает.

С ключом --share сервер слушает всю локальную сеть: по напечатанной ссылке
заходят другие люди с этого же Wi-Fi, и у каждого своя игра.
Добавьте --coop, если нужна одна общая партия на всех.
"""

from __future__ import annotations

import argparse
import atexit
import os
import secrets
import socket
import sys
import threading
import webbrowser

import uvicorn

from game.console import setup as setup_console

# UTF-8 и нормальный шрифт: иначе русский текст либо роняет запуск,
# либо расползается в разрядку (см. game/console.py).
setup_console()

LOCAL_HOST = "127.0.0.1"
SHARE_HOST = "0.0.0.0"
PORT = 8000


def lan_address() -> str:
    """Адрес этой машины в локальной сети — тот, что видят соседи по Wi-Fi.

    Соединение не устанавливается, пакеты не уходят: сокет нужен только чтобы
    спросить у системы, через какой интерфейс она пошла бы наружу.
    """
    probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        probe.connect(("8.8.8.8", 80))
        return probe.getsockname()[0]
    except OSError:
        try:
            return socket.gethostbyname(socket.gethostname())
        except OSError:
            return LOCAL_HOST
    finally:
        probe.close()


def all_addresses() -> list[str]:
    """Все адреса машины в сетях. Их часто несколько: Wi-Fi, кабель, VPN,
    виртуальные адаптеры. Если основной не подошёл, пробовать стоит остальные.
    """
    found = []
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            address = info[4][0]
            if address not in found and not address.startswith("127."):
                found.append(address)
    except OSError:
        pass
    return found


def start_tunnel(port: int):
    """Поднимает cloudflared и возвращает туннель с публичным адресом.

    Если программы нет — предлагает скачать её (около 35 МБ) и явно спрашивает
    разрешения: качать чужой исполняемый файл молча неправильно.
    """
    from game import tunnel as tunnel_mod

    binary = tunnel_mod.find_binary()
    if binary is None:
        print("Для выхода в интернет нужна программа cloudflared — её здесь нет.\n")
        print(tunnel_mod.install_hint())
        print()
        # isatty() тут не годится: в Git Bash ввод идёт через трубу, и проверка
        # сказала бы «не интерактивно», хотя человек сидит за клавиатурой.
        # Просто спрашиваем: если отвечать некому, EOFError и так случится.
        try:
            answer = input("  Скачать её сейчас в папку tools? [y/N]: ").strip().lower()
        except (EOFError, KeyboardInterrupt):
            answer = ""
        if answer not in ("y", "yes", "д", "да"):
            print("  Хорошо, не качаю.\n")
            return None
        print("  Скачиваю с github.com/cloudflare/cloudflared …")
        binary = tunnel_mod.download()
        if binary is None:
            print("  Не вышло. Поставь cloudflared вручную и запусти снова.\n")
            return None
        print(f"  Готово: {binary}\n")

    print("Поднимаю туннель… (ждём не только адрес, но и подключение)")
    tunnel = tunnel_mod.Tunnel(binary, port)
    if tunnel.start() is None:
        print(f"  Не вышло: {tunnel.error}")
        if tunnel.url:
            print(f"  Выданный адрес {tunnel.url} работать не будет.")
        print("  Проверь интернет и попробуй ещё раз.\n")
        tunnel.stop()
        return None

    atexit.register(tunnel.stop)
    return tunnel


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=PORT)
    parser.add_argument("--no-browser", action="store_true")
    parser.add_argument("--reload", action="store_true", help="для разработки")
    parser.add_argument(
        "--share",
        action="store_true",
        help="открыть доступ по локальной сети: играть смогут все, кто откроет ссылку",
    )
    parser.add_argument(
        "--coop",
        action="store_true",
        help="одна общая партия на всех вместо отдельной игры у каждого",
    )
    parser.add_argument(
        "--internet",
        action="store_true",
        help="ссылка, работающая из любой сети (через туннель cloudflared)",
    )
    parser.add_argument(
        "--code",
        default=None,
        help="код на вход для гостей; при --internet придумывается сам",
    )
    parser.add_argument(
        "--no-code",
        action="store_true",
        help="пустить гостей без кода (для --internet не рекомендуется)",
    )
    args = parser.parse_args()

    # uvicorn импортирует приложение по имени, аргументы ему не передать —
    # режим уезжает через окружение.
    os.environ["GAME_COOP"] = "1" if args.coop else ""

    # Код на вход. Для интернета он по умолчанию есть: адрес туннеля может
    # разойтись дальше, чем задумано, а запросы идут по твоему ключу.
    code = "" if args.no_code else (args.code or ("".join(
        secrets.choice("23456789ABCDEFGHJKLMNPQRSTUVWXYZ") for _ in range(6)
    ) if args.internet else ""))
    os.environ["GAME_CODE"] = code

    # Для интернета открывать порт наружу не нужно: cloudflared работает
    # на этой же машине и стучится на 127.0.0.1.
    host = SHARE_HOST if args.share else LOCAL_HOST
    own_url = f"http://{LOCAL_HOST}:{args.port}"

    tunnel = start_tunnel(args.port) if args.internet else None
    if args.internet and tunnel is None:
        print("  Игра всё равно запущена — но только для этого компьютера.\n")

    if tunnel is not None:
        print("=" * 58)
        print("  ССЫЛКА ДЛЯ КОГО УГОДНО В ИНТЕРНЕТЕ:")
        print()
        print(f"      {tunnel.url}")
        print()
        if code:
            print(f"  Код на вход:   {code}")
            print("  Без него внутрь не пустят. Скажи его тем, кого зовёшь.")
        else:
            print("  Код отключён: играть сможет любой, кто получит ссылку.")
        print("=" * 58)
        print()
        print("  Ссылка живёт, пока запущена игра. В следующий раз будет другая.")
        print("  Сеть значения не имеет: работает и с мобильного интернета.")
        print(f"  На этом компьютере по-прежнему: {own_url}")
        print()
        if not args.coop:
            print("  У каждого, кто откроет ссылку, своя игра.")
        print("  Все запросы к Gemini идут по твоему ключу — зови только знакомых.")
        print("\nОстановить: Ctrl+C или пункт «Выход» в меню\n")
    elif not args.share:
        print(f"Игра запущена: {own_url}")
        if args.coop:
            print("  (--coop без --share ничего не меняет: снаружи никто не подключится)")
        print("\nОстановить: Ctrl+C или пункт «Выход» в меню\n")
    else:
        primary = lan_address()
        others = [a for a in all_addresses() if a != primary]

        print("=" * 58)
        print("  ДЛЯ ДРУГИХ УСТРОЙСТВ — дай эту ссылку:")
        print()
        if primary == LOCAL_HOST:
            print("      сетевой адрес не определён: компьютер не в сети?")
        else:
            print(f"      http://{primary}:{args.port}")
        print()
        print("  На этом компьютере:  " + own_url)
        print("=" * 58)
        print()
        print("  ВАЖНО: 127.0.0.1 и localhost работают ТОЛЬКО на этом компьютере.")
        print("  На телефоне или ноутбуке такая ссылка ведёт в них самих, поэтому")
        print("  и пишет «не удаётся установить соединение». Нужен адрес выше.")
        print()
        if others:
            print("  Если он не открылся, у машины есть и другие адреса — попробуй их:")
            for address in others:
                print(f"      http://{address}:{args.port}")
            print()
        print("  Что ещё проверить, если не открывается:")
        print("    1. Устройства в одной сети Wi-Fi (не одно по кабелю, другое по мобильному).")
        print("    2. Брандмауэр Windows спросил про Python — нажми «Разрешить доступ».")
        print("       Если окна не было, выполни в PowerShell от администратора:")
        print(f'       netsh advfirewall firewall add rule name="Game RPG" '
              f"dir=in action=allow protocol=TCP localport={args.port}")
        print("    3. В гостевом Wi-Fi устройства часто изолированы друг от друга —")
        print("       тогда ссылка не заработает, нужна обычная домашняя сеть.")
        print()
        if args.coop:
            print("  Режим --coop: партия общая, все видят одну историю и ходят по очереди.")
        else:
            print("  У каждого, кто откроет ссылку, своя игра: свой мир и свои сохранения.")
            print("  Твоя партия остаётся твоей — гости в неё не попадают.")
        print("  Запросы к Gemini идут по твоему ключу — давай ссылку только знакомым.")
        print("\nОстановить: Ctrl+C или пункт «Выход» в меню\n")

    if not args.no_browser:
        threading.Timer(1.0, lambda: webbrowser.open(own_url)).start()

    uvicorn.run(
        "game.server:app",
        host=host,
        port=args.port,
        reload=args.reload,
        log_level="warning",
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
