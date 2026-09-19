"""Туннель наружу: игра становится доступна из интернета.

Локальная ссылка работает только в своей сети. Чтобы отдать её человеку на
другом конце города, нужен посредник с публичным адресом. Здесь это
`cloudflared` в режиме быстрого туннеля: бесплатно, без регистрации, сразу
по HTTPS. Адрес выдаётся новый при каждом запуске и живёт, пока игра не закрыта.

Роутер трогать не нужно: cloudflared сам открывает исходящее соединение
к Cloudflare, и трафик идёт по нему обратно.
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path
from queue import Empty, Queue

from .config import PROJECT_ROOT

TOOLS_DIR = PROJECT_ROOT / "tools"
BINARY_NAME = "cloudflared.exe" if sys.platform == "win32" else "cloudflared"
LOCAL_BINARY = TOOLS_DIR / BINARY_NAME

DOWNLOAD_URLS = {
    "win32": "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe",
    "linux": "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64",
    "darwin": "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-amd64.tgz",
}

URL_PATTERN = re.compile(r"https://[a-z0-9][a-z0-9-]*\.trycloudflare\.com")

# Адрес cloudflared печатает сразу, но до этой строки он ещё ни с чем не
# соединён. Открывать ссылку в этот момент — получить «Error 1033».
REGISTERED_MARKER = "Registered tunnel connection"

# Туннель поднимается не мгновенно: адрес выдаётся за несколько секунд,
# подключение занимает ещё пару.
START_TIMEOUT = 60.0


def find_binary() -> Path | None:
    """Ищем cloudflared: сначала рядом с игрой, потом в системе."""
    if LOCAL_BINARY.exists():
        return LOCAL_BINARY
    found = shutil.which("cloudflared")
    return Path(found) if found else None


def download_url() -> str | None:
    return DOWNLOAD_URLS.get(sys.platform)


def download(progress=print) -> Path | None:
    """Скачивает cloudflared в папку tools рядом с игрой."""
    url = download_url()
    if not url:
        return None
    if sys.platform == "darwin":
        # На macOS архив — проще поставить через brew, чем распаковывать тут.
        return None

    TOOLS_DIR.mkdir(parents=True, exist_ok=True)
    temp = LOCAL_BINARY.with_suffix(".part")
    try:
        with urllib.request.urlopen(url, timeout=60) as response:
            total = int(response.headers.get("Content-Length") or 0)
            done = 0
            with temp.open("wb") as handle:
                while True:
                    chunk = response.read(256 * 1024)
                    if not chunk:
                        break
                    handle.write(chunk)
                    done += len(chunk)
                    if total:
                        progress(f"\r  скачано {done * 100 // total}%", end="")
        progress("")
    except (OSError, urllib.error.URLError) as exc:
        progress(f"\n  не удалось скачать: {exc}")
        temp.unlink(missing_ok=True)
        return None

    # Переименование свежескачанного .exe Windows иногда отклоняет: антивирус
    # успел взять файл на проверку. Несколько попыток обычно решают дело.
    for attempt in range(5):
        try:
            os.replace(temp, LOCAL_BINARY)
            if sys.platform != "win32":
                os.chmod(LOCAL_BINARY, 0o755)
            return LOCAL_BINARY
        except OSError as exc:
            last = exc
            time.sleep(1.0)

    progress(f"\n  файл скачан, но переименовать его не дали: {last}")
    progress(f"  переименуй вручную: {temp}  ->  {LOCAL_BINARY.name}")
    return None


class Tunnel:
    """Запущенный cloudflared и его публичный адрес."""

    def __init__(self, binary: Path, port: int) -> None:
        self.binary = binary
        self.port = port
        self.process: subprocess.Popen | None = None
        self.url: str | None = None
        self.connected = False
        self.error: str = ""
        self._lines: Queue[str] = Queue()

    def _pump(self) -> None:
        """cloudflared пишет всё в stderr, включая выданный адрес."""
        assert self.process and self.process.stderr
        for line in self.process.stderr:
            self._lines.put(line.rstrip())

    def start(self, timeout: float = START_TIMEOUT) -> str | None:
        """Поднимает туннель и возвращает адрес, когда он **уже работает**.

        Ждём не только выданный адрес, но и подтверждение соединения: между
        ними несколько секунд, и ссылка, открытая в этом промежутке, отвечает
        «Error 1033 — Cloudflare unable to resolve».
        """
        self.process = subprocess.Popen(
            [
                str(self.binary),
                "tunnel",
                "--no-autoupdate",
                # Только HTTP/2. По умолчанию cloudflared лезет через QUIC на
                # UDP-порт 7844, который во многих сетях закрыт; сам он это
                # видит, обещает перейти на http2 — и всё равно бесконечно
                # долбится в QUIC, так и не подключившись.
                "--protocol",
                "http2",
                "--url",
                f"http://127.0.0.1:{self.port}",
            ],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0,
        )
        threading.Thread(target=self._pump, daemon=True).start()

        deadline = threading.Event()
        timer = threading.Timer(timeout, deadline.set)
        timer.start()
        try:
            while not deadline.is_set():
                if self.process.poll() is not None:
                    self.error = "cloudflared завершился, не подключившись"
                    return None
                try:
                    line = self._lines.get(timeout=0.5)
                except Empty:
                    continue

                match = URL_PATTERN.search(line)
                if match:
                    self.url = match.group(0)
                if REGISTERED_MARKER in line:
                    self.connected = True
                if self.url and self.connected:
                    return self.url
        finally:
            timer.cancel()

        if self.url and not self.connected:
            self.error = (
                "адрес выдан, но соединение с Cloudflare не установилось.\n"
                "  Обычно мешает брандмауэр или сеть, режущая исходящие соединения."
            )
        else:
            self.error = "cloudflared не выдал адрес"
        return None

    def stop(self) -> None:
        if self.process and self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.process.kill()


def install_hint() -> str:
    if sys.platform == "win32":
        return (
            "  Поставить cloudflared можно так:\n"
            "      winget install --id Cloudflare.cloudflared\n"
            "  или скачать файл вручную и положить его в папку tools рядом с игрой:\n"
            f"      {DOWNLOAD_URLS['win32']}"
        )
    if sys.platform == "darwin":
        return "  Поставить cloudflared:  brew install cloudflared"
    return (
        "  Поставить cloudflared можно из пакетов дистрибутива или скачать:\n"
        f"      {DOWNLOAD_URLS['linux']}"
    )
