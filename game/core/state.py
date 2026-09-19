"""Состояние игры — единственный источник правды.

Модель не помнит ни здоровья, ни инвентаря, ни времени: всё это живёт здесь и
подставляется в промпт каждый ход. Ответ модели содержит только предложения
изменений, которые проверяет game/core/rules.py.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field, fields
from typing import Any

# Версия схемы: понадобится на этапе 7, чтобы не ронять старые сейвы.
STATE_VERSION = 1

MAX_HEALTH = 100
MAX_FATIGUE = 100
MINUTES_PER_DAY = 24 * 60

TIMES_OF_DAY = ("утро", "день", "вечер", "ночь")


def _known_fields(cls, data: dict) -> dict:
    """Оставляет только те ключи, которые датакласс действительно знает."""
    names = {field.name for field in fields(cls)}
    return {key: value for key, value in (data or {}).items() if key in names}


def _build(cls, data):
    return cls(**_known_fields(cls, data or {}))


@dataclass
class Stats:
    health: int = 100
    max_health: int = MAX_HEALTH
    fatigue: int = 0


@dataclass
class Location:
    name: str = ""
    description: str = ""


@dataclass
class Item:
    name: str
    description: str = ""


@dataclass
class Turn:
    number: int
    player: str
    narrative: str
    # True — ответ сочинил код, а не модель (отказ по усталости или ранам).
    local: bool = False
    # Кто сделал ход: заполняется, когда за одной партией сидят несколько человек.
    player_name: str = ""


@dataclass
class NPC:
    """Персонаж, с которым игрок взаимодействовал.

    sympathy: -100 (готов навредить) .. +100 (предан). Число живёт здесь,
    модель получает его в промпте и предлагает только изменение.
    """

    name: str
    role: str = ""
    description: str = ""
    sympathy: int = 0
    first_seen_turn: int = 0
    last_seen_turn: int = 0
    scenes: int = 1
    important: bool = False
    # Находится ли в сцене прямо сейчас — от этого зависит показ в интерфейсе.
    present: bool = False


@dataclass
class GameState:
    version: int = STATE_VERSION

    # Карточка мира — то, что сгенерировал этап 2. Не меняется по ходу игры.
    world_title: str = ""
    genre: str = ""
    backstory: str = ""
    world_rules: list[str] = field(default_factory=list)

    character_name: str = ""
    character_background: str = ""
    character_traits: list[str] = field(default_factory=list)
    character_goal: str = ""

    # Изменяемая часть.
    stats: Stats = field(default_factory=Stats)
    location: Location = field(default_factory=Location)
    inventory: list[Item] = field(default_factory=list)
    elapsed_minutes: int = 0
    time_of_day: str = "утро"

    chronicle: list[str] = field(default_factory=list)
    history: list[Turn] = field(default_factory=list)
    suggested_actions: list[str] = field(default_factory=list)

    npcs: list[NPC] = field(default_factory=list)
    # Заполнятся на этапе 6 (бой).
    flags: dict[str, Any] = field(default_factory=dict)

    game_over: bool = False

    # ------------------------------------------------------------ свойства

    @property
    def turn_number(self) -> int:
        """Сколько ходов сделал игрок. Нулевая запись истории — первая сцена,
        она не ход."""
        return max(0, len(self.history) - 1)

    @property
    def day(self) -> int:
        return self.elapsed_minutes // MINUTES_PER_DAY + 1

    def elapsed_text(self) -> str:
        hours, minutes = divmod(self.elapsed_minutes % MINUTES_PER_DAY, 60)
        if self.elapsed_minutes < 60:
            return f"{minutes} мин"
        return f"{hours} ч {minutes:02d} мин" if minutes else f"{hours} ч"

    def inventory_text(self) -> str:
        if not self.inventory:
            return "пусто"
        return ", ".join(item.name for item in self.inventory)

    # ------------------------------------------------------- сериализация

    def to_dict(self) -> dict:
        data = asdict(self)
        data["turn_number"] = self.turn_number
        data["day"] = self.day
        data["elapsed_text"] = self.elapsed_text()
        return data

    @classmethod
    def from_dict(cls, data: dict) -> GameState:
        """Восстановление из сейва.

        Незнакомые поля отбрасываются, недостающие остаются на умолчаниях:
        сейв, записанный другой версией игры, не должен ронять загрузку.
        """
        data = dict(data)
        nested = ("stats", "location", "inventory", "history", "npcs")
        state = cls(
            **_known_fields(cls, {k: v for k, v in data.items() if k not in nested})
        )
        state.stats = _build(Stats, data.get("stats"))
        state.location = _build(Location, data.get("location"))
        state.inventory = [_build(Item, item) for item in data.get("inventory") or []]
        state.history = [_build(Turn, turn) for turn in data.get("history") or []]
        state.npcs = [_build(NPC, npc) for npc in data.get("npcs") or []]
        return state

    @classmethod
    def from_world_card(cls, world: dict) -> GameState:
        """Превращает карточку мира с этапа 2 в игровое состояние."""
        character = world.get("character", {})
        location = world.get("location", {})
        stats = world.get("stats", {})

        state = cls(
            world_title=world.get("world_title", ""),
            genre=world.get("genre", ""),
            backstory=world.get("backstory", ""),
            world_rules=list(world.get("world_rules", [])),
            character_name=character.get("name", ""),
            character_background=character.get("background", ""),
            character_traits=list(character.get("traits", [])),
            character_goal=character.get("goal", ""),
            stats=Stats(
                health=int(stats.get("health", MAX_HEALTH)),
                max_health=int(stats.get("max_health", MAX_HEALTH)),
                fatigue=int(stats.get("fatigue", 0)),
            ),
            location=Location(
                name=location.get("name", ""),
                description=location.get("description", ""),
            ),
            inventory=[
                Item(name=item.get("name", ""), description=item.get("description", ""))
                for item in world.get("inventory", [])
            ],
            suggested_actions=list(world.get("suggested_actions", [])),
        )
        # Первая сцена — нулевой ход: игрок ещё ничего не делал.
        state.history.append(
            Turn(number=0, player="", narrative=world.get("opening_scene", ""))
        )
        state.chronicle.append(
            f"Начало: {state.character_name} в месте «{state.location.name}». "
            f"Цель: {state.character_goal}"
        )
        return state
