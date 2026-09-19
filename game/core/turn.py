"""Ход игрока: сборка контекста, один запрос, применение изменений.

Окно контекста (см. README, п.1.3):
    правила ведущего  +  карточка мира  +  хроника  +  текущее состояние
    +  последние N ходов дословно  +  действие игрока
Вся история целиком не отправляется никогда.
"""

from __future__ import annotations

from functools import lru_cache

from ..api.errors import GeminiError
from ..api.gemini_client import GeminiClient
from ..config import PROMPTS_DIR
from .npc import npc_block
from .rules import apply_blocked_turn, apply_turn, block_action, state_directives
from .state import GameState

# Сколько последних ходов уходит в промпт дословно.
HISTORY_WINDOW = 6

# Порог, после которого хронику сжимаем одним отдельным запросом.
CHRONICLE_CHAR_LIMIT = 6000
CHRONICLE_KEEP_RECENT = 8

TURN_SCHEMA: dict = {
    "type": "object",
    "properties": {
        "narrative": {"type": "string"},
        "state_delta": {
            "type": "object",
            "properties": {
                "health": {"type": "integer"},
                "fatigue": {"type": "integer"},
                "time_advance_min": {"type": "integer"},
            },
            "required": ["health", "fatigue", "time_advance_min"],
        },
        "time_of_day": {"type": "string", "enum": ["утро", "день", "вечер", "ночь"]},
        "rest": {
            "type": "string",
            "enum": ["нет", "отдых", "еда", "сон"],
            "description": "Отдыхал ли персонаж в этом ходе. Сколько сил вернулось — считает игра.",
        },
        "inventory_changes": {
            "type": "object",
            "properties": {
                "add": {
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
                "remove": {"type": "array", "items": {"type": "string"}},
            },
            "required": ["add", "remove"],
        },
        "location_change": {
            "type": "object",
            "properties": {
                "changed": {"type": "boolean"},
                "name": {"type": "string"},
                "description": {"type": "string"},
            },
            "required": ["changed", "name", "description"],
        },
        "npcs": {
            "type": "array",
            "description": "Персонажи, которые участвовали в этом ходе или чьё отношение изменилось.",
            "items": {
                "type": "object",
                "properties": {
                    "name": {"type": "string"},
                    "role": {"type": "string"},
                    "description": {"type": "string"},
                    "sympathy_delta": {"type": "integer"},
                    "present": {"type": "boolean"},
                    "important": {"type": "boolean"},
                },
                "required": ["name", "role", "description", "sympathy_delta", "present", "important"],
            },
        },
        "combat_trigger": {
            "type": "object",
            "description": "Началась ли прямая драка. Сам бой считает игра, не ты.",
            "properties": {
                "starts": {"type": "boolean"},
                "enemy_name": {"type": "string"},
                "reason": {"type": "string"},
            },
            "required": ["starts", "enemy_name", "reason"],
        },
        "memory_update": {"type": "string"},
        "suggested_actions": {"type": "array", "items": {"type": "string"}},
    },
    "required": [
        "narrative",
        "state_delta",
        "time_of_day",
        "rest",
        "inventory_changes",
        "location_change",
        "npcs",
        "combat_trigger",
        "memory_update",
        "suggested_actions",
    ],
}

COMBAT_SCHEMA: dict = {
    "type": "object",
    "properties": {
        "enemy": {
            "type": "object",
            "properties": {
                "name": {"type": "string"},
                "description": {"type": "string", "description": "одна строка примет"},
                "hp": {
                    "type": "integer",
                    "description": (
                        "15-140. У игрока 100. Задира или подросток 30-50, "
                        "обычный вооружённый человек 60-85, опытный боец 90-110, "
                        "зверь или чудовище 110-140"
                    ),
                },
                "attack": {
                    "type": "integer",
                    "description": (
                        "2-18. Кулаки 4-5, нож или дубина 7-9, меч или револьвер 10-12, "
                        "опытный убийца 13-15, чудовище 16-18"
                    ),
                },
                "defense": {
                    "type": "integer",
                    "description": "0-9. Без брони 1-2, кожа или толстая одежда 3-4, доспех 5-7, шкура зверя 6-9",
                },
            },
            "required": ["name", "description", "hp", "attack", "defense"],
        },
        "player_weapon": {
            "type": "object",
            "description": "Лучшее, чем игрок может драться прямо сейчас — из его инвентаря.",
            "properties": {
                "name": {"type": "string", "description": "название предмета или «кулаки»"},
                "attack_bonus": {"type": "integer", "description": "0-7"},
            },
            "required": ["name", "attack_bonus"],
        },
        "player_armor_bonus": {"type": "integer", "description": "0-5, по одежде и снаряжению игрока"},
        "usable_items": {
            "type": "array",
            "description": "Предметы ИЗ ИНВЕНТАРЯ игрока, которые лечат в бою. Обычно пусто.",
            "items": {
                "type": "object",
                "properties": {
                    "name": {"type": "string"},
                    "heal": {"type": "integer", "description": "5-35"},
                },
                "required": ["name", "heal"],
            },
        },
        "opening": {"type": "string", "description": "1-2 абзаца: как началась драка"},
        "lines": {
            "type": "object",
            "description": "Реплики врага на разные случаи, по 2-3 в каждом списке.",
            "properties": {
                "confident": {"type": "array", "items": {"type": "string"}},
                "hurt": {"type": "array", "items": {"type": "string"}},
                "dying": {"type": "array", "items": {"type": "string"}},
                "winning": {"type": "array", "items": {"type": "string"}},
            },
            "required": ["confident", "hurt", "dying", "winning"],
        },
    },
    "required": [
        "enemy",
        "player_weapon",
        "player_armor_bonus",
        "usable_items",
        "opening",
        "lines",
    ],
}

COMPACT_SCHEMA: dict = {
    "type": "object",
    "properties": {"chronicle": {"type": "array", "items": {"type": "string"}}},
    "required": ["chronicle"],
}


@lru_cache(maxsize=1)
def system_prompt() -> str:
    return (PROMPTS_DIR / "gm.md").read_text(encoding="utf-8")


# ------------------------------------------------------------------ контекст


def world_block(state: GameState) -> str:
    rules = "\n".join(f"- {rule}" for rule in state.world_rules)
    traits = ", ".join(state.character_traits) or "—"
    return (
        f"МИР: {state.world_title} ({state.genre})\n"
        f"{state.backstory}\n\n"
        f"ЗАКОНЫ МИРА:\n{rules}\n\n"
        f"ПЕРСОНАЖ ИГРОКА: {state.character_name}\n"
        f"{state.character_background}\n"
        f"Черты: {traits}\n"
        f"Цель: {state.character_goal}"
    )


def state_block(state: GameState) -> str:
    inventory = (
        "\n".join(
            f"- {item.name}" + (f" ({item.description})" if item.description else "")
            for item in state.inventory
        )
        or "- пусто"
    )
    return (
        f"ТЕКУЩЕЕ СОСТОЯНИЕ (это правда, не пересчитывай её сам):\n"
        f"Здоровье: {state.stats.health} из {state.stats.max_health}\n"
        f"Усталость: {state.stats.fatigue} из 100\n"
        f"Место: {state.location.name} — {state.location.description}\n"
        f"День {state.day}, {state.time_of_day}. С начала истории прошло {state.elapsed_text()}.\n"
        f"Ход номер: {state.turn_number + 1}\n"
        f"ИНВЕНТАРЬ:\n{inventory}"
    )


def chronicle_block(state: GameState) -> str:
    if not state.chronicle:
        return ""
    entries = "\n".join(f"- {entry}" for entry in state.chronicle)
    return f"ХРОНИКА СОБЫТИЙ (что уже случилось):\n{entries}"


def history_block(state: GameState) -> str:
    recent = state.history[-HISTORY_WINDOW:]
    if not recent:
        return ""
    parts = ["ПОСЛЕДНИЕ ХОДЫ (дословно):"]
    for turn in recent:
        if turn.player:
            parts.append(f"Игрок: {turn.player}")
        parts.append(f"Ты: {turn.narrative}")
    return "\n\n".join(parts)


def directives_block(state: GameState) -> str:
    """Состояние персонажа, переведённое в прямые указания ведущему."""
    directives = state_directives(state)
    if not directives:
        return ""
    lines = "\n".join(f"- {directive}" for directive in directives)
    return (
        "ОБЯЗАТЕЛЬНЫЕ ОГРАНИЧЕНИЯ ЭТОЙ СЦЕНЫ (важнее желаний игрока):\n" + lines
    )


def build_user_text(state: GameState, player_text: str, event_note: str = "") -> str:
    """event_note — событие, которое уже случилось помимо действия игрока
    (например, итог боя). Тогда ведущий описывает последствия, а не попытку."""
    action_block = (
        f"ДЕЙСТВИЕ ИГРОКА:\n{player_text.strip()}" if player_text.strip() else ""
    )
    blocks = [
        world_block(state),
        chronicle_block(state),
        state_block(state),
        npc_block(state),
        directives_block(state),
        history_block(state),
        event_note,
        action_block,
        "Опиши, что из этого вышло, и верни JSON по схеме.",
    ]
    return "\n\n---\n\n".join(block for block in blocks if block)


# ---------------------------------------------------------------------- ход


def play_turn(
    client: GeminiClient,
    model: str,
    state: GameState,
    player_text: str,
    event_note: str = "",
    player_name: str = "",
) -> dict:
    """Один запрос к модели — один ход. Состояние меняется только здесь.

    Заведомо невозможное действие отсекается до запроса: это и честнее,
    и не тратит обращение к API."""
    refusal = block_action(state, player_text)
    if refusal:
        return apply_blocked_turn(state, player_text, refusal, player_name)

    response = client.generate_json(
        model=model,
        schema=TURN_SCHEMA,
        user_text=build_user_text(state, player_text, event_note),
        system_instruction=system_prompt(),
        purpose="turn",
        temperature=0.95,
        max_output_tokens=3000,
    )
    changes = apply_turn(state, player_text, response, player_name)
    changes["combat_trigger"] = combat_request(state, response)
    maybe_compact_chronicle(client, model, state)
    return changes


def combat_request(state: GameState, response: dict) -> dict | None:
    """Разбирает заявку модели на драку. Сам бой начинается отдельным вызовом:
    в обычном ходе незачем таскать целый лист врага."""
    trigger = response.get("combat_trigger") or {}
    if not trigger.get("starts") or state.game_over:
        return None
    return {
        "enemy_name": str(trigger.get("enemy_name", "")).strip(),
        "reason": str(trigger.get("reason", "")).strip(),
    }


def start_combat(
    client: GeminiClient,
    model: str,
    state: GameState,
    enemy_name: str,
    reason: str,
):
    """Один запрос на всю завязку: лист врага, оценка оружия игрока и запас
    реплик на весь бой. Дальше раунды считаются локально."""
    from .combat import build_combat  # локальный импорт: combat.py тянет state

    inventory = "\n".join(
        f"- {item.name}" + (f" ({item.description})" if item.description else "")
        for item in state.inventory
    ) or "- пусто"

    user_text = "\n\n---\n\n".join(
        block
        for block in (
            world_block(state),
            state_block(state),
            npc_block(state),
            history_block(state),
            (
                f"НАЧАЛАСЬ ДРАКА.\nПротивник: {enemy_name or 'неизвестный'}\n"
                f"Причина: {reason or 'прямое столкновение'}\n\n"
                f"ИНВЕНТАРЬ ИГРОКА (оружие и лечебное выбирай только отсюда):\n{inventory}\n\n"
                "Составь лист противника и запас его реплик. Реплики пиши от его лица, "
                "прямой речью, коротко — по 2-3 на каждое состояние:\n"
                "confident — он уверен в победе; hurt — заметно ранен; "
                "dying — при смерти; winning — игрок почти повержен.\n"
                "Силу противника подбирай по сюжету, а не по жалости к игроку."
            ),
        )
        if block
    )

    data = client.generate_json(
        model=model,
        schema=COMBAT_SCHEMA,
        user_text=user_text,
        system_instruction=system_prompt(),
        purpose="combat-start",
        temperature=0.9,
        max_output_tokens=2500,
    )
    return build_combat(state, data, reason=reason, npc_name=enemy_name)


def maybe_compact_chronicle(client: GeminiClient, model: str, state: GameState) -> bool:
    """Хроника растёт вместе с игрой. Когда она становится дороже, чем стоит,
    один отдельный запрос ужимает старую часть. Случается редко — примерно раз
    в несколько десятков ходов."""
    total = sum(len(entry) for entry in state.chronicle)
    if total < CHRONICLE_CHAR_LIMIT or len(state.chronicle) <= CHRONICLE_KEEP_RECENT:
        return False

    old = state.chronicle[:-CHRONICLE_KEEP_RECENT]
    recent = state.chronicle[-CHRONICLE_KEEP_RECENT:]
    entries = "\n".join(f"- {entry}" for entry in old)

    try:
        response = client.generate_json(
            model=model,
            schema=COMPACT_SCHEMA,
            user_text=(
                "Ниже хроника текстовой игры. Сожми её в 10-15 пунктов, сохранив всё, "
                "что может понадобиться дальше: имена, места, обещания, долги, угрозы, "
                "найденные предметы, изменения в мире. Убери повторы и мелочи. "
                "Пиши по-русски, каждый пункт — одно предложение.\n\n" + entries
            ),
            system_instruction="Ты ведёшь краткие записи по сюжету. Только факты.",
            purpose="chronicle-compact",
            temperature=0.3,
            max_output_tokens=2000,
        )
    except GeminiError:
        # Сжатие — удобство, а не необходимость: если не вышло, играем дальше.
        return False

    compacted = [str(item).strip() for item in response.get("chronicle", []) if str(item).strip()]
    if not compacted:
        return False

    state.chronicle = compacted + recent
    return True
