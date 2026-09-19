"""Сохранение и загрузка партии.

Состояние — обычный JSON (см. state.py), поэтому сейв это просто его дамп
вместе с текущим боем, если он идёт. Отдельно хранится версия схемы: на ней
держится совместимость со старыми файлами.
"""

from __future__ import annotations

import json
import re
from dataclasses import asdict, fields
from datetime import datetime
from pathlib import Path
from typing import Any

from ..config import SAVES_DIR
from .combat import Combat, Combatant, LogEntry
from .state import STATE_VERSION, GameState

AUTO_SLOT = "auto"
MANUAL_SLOTS = ("1", "2", "3", "4", "5")
ALL_SLOTS = (AUTO_SLOT,) + MANUAL_SLOTS

_SLOT_RE = re.compile(r"^(auto|[1-5])$")


class SaveError(Exception):
    """Сейвы не должны ронять игру — наружу уходит понятный текст."""

    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.user_message = message


def _slot_path(slot: str, directory: Path | None = None):
    if not _SLOT_RE.match(slot):
        raise SaveError("Неизвестный слот сохранения.")
    return (directory or SAVES_DIR) / f"{slot}.json"


# ------------------------------------------------------------- запись


def _combat_to_dict(combat: Combat | None) -> dict | None:
    if combat is None:
        return None
    data = asdict(combat)
    data["log"] = [asdict(entry) for entry in combat.log]
    return data


def save_game(
    state: GameState,
    slot: str,
    combat: Combat | None = None,
    directory: Path | None = None,
) -> dict:
    path = _slot_path(slot, directory)
    payload = {
        "version": STATE_VERSION,
        "saved_at": datetime.now().isoformat(timespec="seconds"),
        "title": state.world_title,
        "character": state.character_name,
        "turn": state.turn_number,
        "day": state.day,
        "health": state.stats.health,
        "game_over": state.game_over,
        "in_combat": combat is not None and not combat.finished,
        "state": state.to_dict(),
        "combat": _combat_to_dict(combat),
    }
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        # Пишем через временный файл: прерванная запись не должна съесть
        # старый сейв.
        temp = path.with_suffix(".tmp")
        temp.write_text(
            json.dumps(payload, ensure_ascii=False, indent=1), encoding="utf-8"
        )
        temp.replace(path)
    except OSError as exc:
        raise SaveError(f"Не удалось записать сохранение: {exc}") from exc

    return meta_from_payload(slot, payload)


# ------------------------------------------------------------- чтение


def _migrate(data: dict) -> dict:
    """Приводит сейв к текущей схеме.

    Правило простое: незнакомые поля выбрасываем, недостающие оставляем
    на умолчаниях датаклассов. Так файл, записанный другой версией игры,
    не роняет загрузку.
    """
    known = {field.name for field in fields(GameState)}
    state = {key: value for key, value in (data.get("state") or {}).items() if key in known}

    # Поля, появившиеся после первой версии, но обязательные для логики.
    state.setdefault("npcs", [])
    state.setdefault("flags", {})
    state.setdefault("chronicle", [])
    state.setdefault("history", [])

    for turn in state.get("history", []):
        turn.setdefault("local", False)

    data["state"] = state
    return data


def _combat_from_dict(raw: dict | None) -> Combat | None:
    if not raw:
        return None
    known = {field.name for field in fields(Combat)}
    data = {key: value for key, value in raw.items() if key in known}
    data["enemy"] = Combatant(**data.get("enemy", {}))
    data["log"] = [LogEntry(**entry) for entry in data.get("log", [])]
    return Combat(**data)


def load_game(slot: str, directory: Path | None = None) -> tuple[GameState, Combat | None]:
    path = _slot_path(slot, directory)
    if not path.exists():
        raise SaveError("Этого сохранения больше нет.")
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise SaveError(f"Файл сохранения повреждён: {exc}") from exc

    try:
        data = _migrate(data)
        state = GameState.from_dict(data["state"])
        combat = _combat_from_dict(data.get("combat"))
    except (TypeError, KeyError, ValueError) as exc:
        raise SaveError(f"Сохранение несовместимо с этой версией игры: {exc}") from exc

    # Бой, который успел закончиться, восстанавливать незачем.
    if combat is not None and combat.finished:
        combat = None
    return state, combat


# ------------------------------------------------------------ список


def meta_from_payload(slot: str, payload: dict) -> dict:
    return {
        "slot": slot,
        "auto": slot == AUTO_SLOT,
        "exists": True,
        "version": payload.get("version"),
        "saved_at": payload.get("saved_at", ""),
        "title": payload.get("title", ""),
        "character": payload.get("character", ""),
        "turn": payload.get("turn", 0),
        "day": payload.get("day", 1),
        "health": payload.get("health", 0),
        "game_over": payload.get("game_over", False),
        "in_combat": payload.get("in_combat", False),
        "outdated": payload.get("version") != STATE_VERSION,
    }


def slot_meta(slot: str, directory: Path | None = None) -> dict:
    path = _slot_path(slot, directory)
    if not path.exists():
        return {"slot": slot, "auto": slot == AUTO_SLOT, "exists": False}
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {
            "slot": slot,
            "auto": slot == AUTO_SLOT,
            "exists": True,
            "broken": True,
            "title": "файл повреждён",
        }
    return meta_from_payload(slot, payload)


def list_saves(directory: Path | None = None) -> list[dict]:
    return [slot_meta(slot, directory) for slot in ALL_SLOTS]


def has_any_save(directory: Path | None = None) -> bool:
    return any(meta.get("exists") for meta in list_saves(directory))


def delete_save(slot: str, directory: Path | None = None) -> None:
    path = _slot_path(slot, directory)
    try:
        path.unlink(missing_ok=True)
    except OSError as exc:
        raise SaveError(f"Не удалось удалить сохранение: {exc}") from exc


# ------------------------------------------------------------ автосейв


def autosave(
    state: GameState, combat: Combat | None = None, directory: Path | None = None
) -> None:
    """Пишется после каждого хода — но НЕ после смертельного.

    Иначе «продолжить» возвращало бы игрока ровно в момент гибели. Так в слоте
    остаётся состояние на начало рокового хода, и у партии есть второй шанс.
    """
    if state.game_over:
        return
    try:
        save_game(state, AUTO_SLOT, combat, directory)
    except SaveError:
        # Автосейв — удобство, а не причина прерывать игру.
        pass
