"""Настройки приложения: читаются из .env один раз при старте."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

from dotenv import load_dotenv

PROJECT_ROOT = Path(__file__).resolve().parent.parent

# На хостинге файлы контейнера стираются при каждом обновлении, поэтому сейвы
# кладутся на подключённый диск: его путь приходит в GAME_DATA_DIR.
DATA_DIR = Path(os.getenv("GAME_DATA_DIR") or PROJECT_ROOT)
SAVES_DIR = DATA_DIR / "saves"
LOGS_DIR = DATA_DIR / "logs"
PROMPTS_DIR = PROJECT_ROOT / "game" / "prompts"


def hosted() -> bool:
    """Игра крутится на сервере, а не на домашнем компьютере.

    Меняет две вещи: хозяина за браузером нет (гасить сервер некому),
    и пускать внутрь без пароля нельзя — за ключ платит владелец.
    """
    return os.getenv("GAME_HOSTED", "").strip() == "1"

API_BASE = "https://generativelanguage.googleapis.com/v1beta"

# Модели из ТЗ, в порядке предпочтения. Реально доступные определяются
# запросом models.list при старте — см. game/api/models.py.
WANTED_MODELS: tuple[tuple[str, str], ...] = (
    ("gemini-3.5-flash-lite", "Gemini 3.5 Flash-Lite"),
    ("gemini-3.1-flash-lite", "Gemini 3.1 Flash-Lite"),
    ("gemini-2.5-flash-lite", "Gemini 2.5 Flash-Lite"),
)


@dataclass(frozen=True)
class Settings:
    api_key: str
    default_model: str = "gemini-3.5-flash-lite"
    lang: str = "ru"
    safety_mode: str = "permissive"
    api_base: str = API_BASE
    request_timeout: float = 90.0
    # Один повтор на запрос — больше не делаем, чтобы не жечь лимиты (п.8 ТЗ).
    max_retries: int = 1
    retry_delay: float = 2.0
    wanted_models: tuple[tuple[str, str], ...] = field(default=WANTED_MODELS)

    @property
    def has_key(self) -> bool:
        return bool(self.api_key.strip())


def load_settings(env_file: Path | None = None) -> Settings:
    """Читает .env и переменные окружения. Отсутствие ключа тут не падает —
    ошибку показывает уже интерфейс, понятным текстом."""
    load_dotenv(env_file or PROJECT_ROOT / ".env", override=False)

    def _float(name: str, default: float) -> float:
        raw = os.getenv(name)
        try:
            return float(raw) if raw else default
        except ValueError:
            return default

    return Settings(
        api_key=os.getenv("GEMINI_API_KEY", "").strip(),
        default_model=os.getenv("GEMINI_DEFAULT_MODEL", "gemini-3.5-flash-lite").strip(),
        lang=os.getenv("GAME_LANG", "ru").strip() or "ru",
        safety_mode=os.getenv("SAFETY_MODE", "permissive").strip() or "permissive",
        api_base=os.getenv("GEMINI_API_BASE", API_BASE).strip() or API_BASE,
        request_timeout=_float("GEMINI_TIMEOUT", 90.0),
    )


def ensure_dirs() -> None:
    for path in (SAVES_DIR, LOGS_DIR):
        path.mkdir(parents=True, exist_ok=True)
