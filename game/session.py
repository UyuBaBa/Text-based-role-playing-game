"""Сессии игроков.

По умолчанию у каждого, кто открыл ссылку, своя игра: свой мир, свой персонаж,
свои сохранения. Гостей различает кука, выданная при первом заходе.

Хозяин (тот, кто открыл игру на этой же машине) всегда попадает в свою
основную сессию со старыми сохранениями в `saves/` — что бы ни творилось
в гостевых.

Режим `--coop` меняет правило на противоположное: все подключившиеся играют
одну партию на всех.
"""

from __future__ import annotations

import os
import secrets
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .config import SAVES_DIR

COOKIE_NAME = "rpg_sid"
COOKIE_MAX_AGE = 60 * 60 * 24 * 30  # месяц

MAIN_SID = "main"
GUESTS_DIR = SAVES_DIR / "guests"

# Гостевая сессия, которую не трогали столько времени, выгружается из памяти.
# Сохранения при этом остаются на диске.
SESSION_TTL = 6 * 60 * 60

LOCAL_HOSTS = ("127.0.0.1", "::1", "localhost")


def coop_enabled() -> bool:
    """Режим задаётся при запуске (`run.py --coop`) через переменную окружения:
    uvicorn импортирует приложение по имени, передать аргумент иначе некуда."""
    return os.getenv("GAME_COOP", "").strip() == "1"


def access_code() -> str:
    """Код на вход для гостей. Пустая строка — вход свободный.

    Нужен, когда игра открыта в интернет: адрес туннеля может утечь, а платит
    за все запросы хозяин ключа.
    """
    return os.getenv("GAME_CODE", "").strip()


@dataclass
class Session:
    """Одна партия со всем, что к ней относится."""

    sid: str
    saves_dir: Path
    world: Any = None
    state: Any = None
    combat: Any = None
    model: str = ""
    inputs: Any = None
    # Номер состояния: по нему вкладки понимают, что пора обновиться.
    revision: int = 0
    busy_by: str = ""
    # Ввёл ли гость код доступа. Для хозяина всегда True.
    authorized: bool = False
    last_seen: float = field(default_factory=time.time)
    lock: threading.Lock = field(default_factory=threading.Lock)
    players: dict[str, float] = field(default_factory=dict)

    def bump(self) -> int:
        self.revision += 1
        return self.revision

    def touch(self) -> None:
        self.last_seen = time.time()

    def seen(self, name: str) -> None:
        if name.strip():
            self.players[name.strip()[:40]] = time.time()

    def online(self, timeout: float = 90.0) -> list[str]:
        now = time.time()
        for name, last in list(self.players.items()):
            if now - last > timeout:
                self.players.pop(name, None)
        return sorted(self.players)


_SESSIONS: dict[str, Session] = {}
_REGISTRY_LOCK = threading.Lock()


def is_local(host: str) -> bool:
    return host in LOCAL_HOSTS


def _saves_dir_for(sid: str) -> Path:
    if sid == MAIN_SID:
        return SAVES_DIR
    return GUESTS_DIR / sid


def new_sid() -> str:
    return secrets.token_urlsafe(12)


def _purge(now: float) -> None:
    for sid, session in list(_SESSIONS.items()):
        if sid != MAIN_SID and now - session.last_seen > SESSION_TTL:
            _SESSIONS.pop(sid, None)


def resolve_sid(host: str, cookie: str | None, tunneled: bool = False) -> tuple[str, bool]:
    """Кому принадлежит запрос. Возвращает (sid, нужно ли выдать куку).

    `tunneled` — запрос пришёл из интернета через cloudflared. Адрес у него
    всё равно будет 127.0.0.1, но хозяином такой гость считаться не должен.
    """
    if coop_enabled():
        return MAIN_SID, False
    if is_local(host) and not tunneled:
        # Хозяин играет свою игру, а не чью-то гостевую.
        return MAIN_SID, False
    if cookie and cookie.isascii() and 8 <= len(cookie) <= 64 and cookie != MAIN_SID:
        return cookie, False
    return new_sid(), True


def get(sid: str, default_model: str = "") -> Session:
    now = time.time()
    with _REGISTRY_LOCK:
        _purge(now)
        session = _SESSIONS.get(sid)
        if session is None:
            session = Session(sid=sid, saves_dir=_saves_dir_for(sid), model=default_model)
            _SESSIONS[sid] = session
        session.last_seen = now
        return session


def count() -> int:
    return len(_SESSIONS)


def active(timeout: float = 15 * 60) -> int:
    """Сколько партий живы прямо сейчас — для строки в консоли."""
    now = time.time()
    return sum(1 for s in _SESSIONS.values() if now - s.last_seen <= timeout)
