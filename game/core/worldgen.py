"""Генерация стартовой карточки мира (этап 2).

Один запрос к модели на всю завязку: предыстория, персонаж, локация, инвентарь,
стартовые показатели и первая сцена. Полноценный GameState появится на этапе 3 —
здесь только исходные данные для него.
"""

from __future__ import annotations

from functools import lru_cache

from ..api.gemini_client import GeminiClient
from ..config import PROMPTS_DIR

HEALTH_RANGE = (40, 100)
FATIGUE_RANGE = (0, 60)

WORLD_SCHEMA: dict = {
    "type": "object",
    "properties": {
        "world_title": {"type": "string"},
        "genre": {"type": "string"},
        "backstory": {"type": "string"},
        "world_rules": {
            "type": "array",
            "items": {"type": "string"},
            "description": "3-5 законов мира: чем он опасен, что в нём возможно",
        },
        "character": {
            "type": "object",
            "properties": {
                "name": {"type": "string"},
                "background": {"type": "string"},
                "traits": {"type": "array", "items": {"type": "string"}},
                "goal": {"type": "string"},
            },
            "required": ["name", "background", "traits", "goal"],
        },
        "location": {
            "type": "object",
            "properties": {
                "name": {"type": "string"},
                "description": {"type": "string"},
            },
            "required": ["name", "description"],
        },
        "inventory": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "name": {"type": "string"},
                    "description": {"type": "string"},
                },
                "required": ["name", "description"],
            },
        },
        "stats": {
            "type": "object",
            "properties": {
                "health": {"type": "integer"},
                "fatigue": {"type": "integer"},
            },
            "required": ["health", "fatigue"],
        },
        "opening_scene": {"type": "string"},
        "suggested_actions": {"type": "array", "items": {"type": "string"}},
    },
    "required": [
        "world_title",
        "genre",
        "backstory",
        "world_rules",
        "character",
        "location",
        "inventory",
        "stats",
        "opening_scene",
        "suggested_actions",
    ],
}


@lru_cache(maxsize=1)
def system_prompt() -> str:
    return (PROMPTS_DIR / "worldgen.md").read_text(encoding="utf-8")


def build_user_text(world_desc: str, character_desc: str) -> str:
    world_desc = world_desc.strip() or "Игрок не описал мир — придумай его сам, что-нибудь необычное."
    character_desc = (
        character_desc.strip()
        or "Игрок не описал персонажа — придумай его сам, под этот мир."
    )
    return (
        "ОПИСАНИЕ МИРА ОТ ИГРОКА:\n"
        f"{world_desc}\n\n"
        "ОПИСАНИЕ ПЕРСОНАЖА ОТ ИГРОКА:\n"
        f"{character_desc}\n\n"
        "Создай стартовый набор по правилам выше."
    )


def _clamp(value, low: int, high: int, default: int) -> int:
    try:
        number = int(value)
    except (TypeError, ValueError):
        return default
    return max(low, min(high, number))


def _clean_list(raw, limit: int) -> list[str]:
    if not isinstance(raw, list):
        return []
    items = [str(item).strip() for item in raw if str(item).strip()]
    return items[:limit]


def sanitize(data: dict) -> dict:
    """Приводим ответ модели к предсказуемому виду: числа в границы, списки —
    к нужной длине. Доверять модели на слово нельзя даже при строгой схеме."""
    character = data.get("character") or {}
    location = data.get("location") or {}
    stats = data.get("stats") or {}

    inventory = []
    for item in (data.get("inventory") or [])[:8]:
        if not isinstance(item, dict):
            continue
        name = str(item.get("name", "")).strip()
        if name:
            inventory.append(
                {"name": name, "description": str(item.get("description", "")).strip()}
            )

    return {
        "world_title": str(data.get("world_title", "")).strip() or "Безымянный мир",
        "genre": str(data.get("genre", "")).strip(),
        "backstory": str(data.get("backstory", "")).strip(),
        "world_rules": _clean_list(data.get("world_rules"), 6),
        "character": {
            "name": str(character.get("name", "")).strip() or "Безымянный",
            "background": str(character.get("background", "")).strip(),
            "traits": _clean_list(character.get("traits"), 5),
            "goal": str(character.get("goal", "")).strip(),
        },
        "location": {
            "name": str(location.get("name", "")).strip() or "Неизвестное место",
            "description": str(location.get("description", "")).strip(),
        },
        "inventory": inventory,
        "stats": {
            "health": _clamp(stats.get("health"), *HEALTH_RANGE, default=100),
            "max_health": 100,
            "fatigue": _clamp(stats.get("fatigue"), *FATIGUE_RANGE, default=10),
        },
        "opening_scene": str(data.get("opening_scene", "")).strip(),
        "suggested_actions": _clean_list(data.get("suggested_actions"), 3),
    }


def generate_world(
    client: GeminiClient,
    model: str,
    world_desc: str,
    character_desc: str,
) -> dict:
    """Один запрос — вся завязка игры."""
    data = client.generate_json(
        model=model,
        schema=WORLD_SCHEMA,
        user_text=build_user_text(world_desc, character_desc),
        system_instruction=system_prompt(),
        purpose="worldgen",
        temperature=1.0,
        max_output_tokens=6000,
    )
    return sanitize(data)
