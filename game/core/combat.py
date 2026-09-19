"""Режим боя.

Главное решение (README, п.1.6): раунды считает код, модель только озвучивает.
Если доверить бой модели целиком, числа поплывут уже к третьему раунду.

Расход запросов на всю драку — три: один на завязку (лист врага, реплики,
оценка оружия игрока), ноль на раунды и один на возвращение в повествование.
Реплики врага генерируются пачкой заранее и дальше выбираются кодом по его
состоянию и уверенности в победе.
"""

from __future__ import annotations

import random
from dataclasses import dataclass, field

from .state import GameState

# Базовые числа игрока. Оружие и броня добавляются поверх — их оценивает
# модель при завязке боя, потому что она видит инвентарь.
BASE_ATTACK = 9
BASE_DEFENSE = 2

ENEMY_HP_LIMITS = (15, 140)
ENEMY_ATTACK_LIMITS = (2, 18)
ENEMY_DEFENSE_LIMITS = (0, 9)
WEAPON_BONUS_LIMITS = (0, 7)
ARMOR_BONUS_LIMITS = (0, 5)
HEAL_LIMITS = (5, 35)

# Раунд выматывает даже победителя.
FATIGUE_PER_ROUND = 3
FATIGUE_PER_DEFEND = 1

DEFEND_BONUS = 5

# Тяжёлый удар врага: редкий, больно бьёт, гасится защитой.
HEAVY_BLOW_CHANCE = 25
HEAVY_BLOW_BONUS = 7

# Усталость и раны бьют по рукам: делители подобраны так, чтобы к пределу
# усталости боец терял примерно четверть удара.
FATIGUE_ATTACK_DIVISOR = 25
FATIGUE_DEFENSE_DIVISOR = 35
WOUNDED_PERCENT = 30

ACTIONS = ("attack", "defend", "item", "flee")


def _clamp(value, limits: tuple[int, int], default: int) -> int:
    low, high = limits
    try:
        number = int(value)
    except (TypeError, ValueError):
        return default
    return max(low, min(high, number))


@dataclass
class Combatant:
    name: str
    hp: int
    max_hp: int
    attack: int
    defense: int
    description: str = ""


@dataclass
class LogEntry:
    round: int
    kind: str  # player | enemy | system
    text: str


@dataclass
class Combat:
    enemy: Combatant
    weapon: str = ""
    weapon_bonus: int = 0
    armor_bonus: int = 0
    lines: dict[str, list[str]] = field(default_factory=dict)
    usable_items: list[dict] = field(default_factory=list)
    reason: str = ""
    opening: str = ""
    round: int = 1
    log: list[LogEntry] = field(default_factory=list)
    enemy_line: str = ""
    finished: bool = False
    outcome: str = ""  # victory | defeat | fled
    npc_name: str = ""  # если дрались со знакомым — его имя в реестре

    def add(self, kind: str, text: str) -> None:
        self.log.append(LogEntry(round=self.round, kind=kind, text=text))


# --------------------------------------------------------- числа игрока


def player_attack(state: GameState, combat: Combat) -> int:
    value = BASE_ATTACK + combat.weapon_bonus
    value -= state.stats.fatigue // FATIGUE_ATTACK_DIVISOR
    if state.stats.health * 100 // max(1, state.stats.max_health) <= WOUNDED_PERCENT:
        value -= 1
    return max(1, value)


def player_defense(state: GameState, combat: Combat) -> int:
    value = BASE_DEFENSE + combat.armor_bonus
    value -= state.stats.fatigue // FATIGUE_DEFENSE_DIVISOR
    return max(0, value)


def damage(attack: int, defense: int) -> int:
    """Единственная формула урона в игре: удар плюс две кости минус защита.

    Кости именно две: с одной бой превращался в предсказуемую гонку, где
    исход был ясен по листу противника ещё до первого удара. Две кости дают
    достаточный разброс, чтобы равный бой решался в самом бою.
    """
    return max(1, attack + random.randint(1, 6) + random.randint(1, 6) - defense)


# ------------------------------------------------------- реплики врага


def enemy_mood(state: GameState, combat: Combat) -> str:
    """Состояние врага, от которого зависит, что он скажет."""
    enemy_percent = combat.enemy.hp * 100 // max(1, combat.enemy.max_hp)
    player_percent = state.stats.health * 100 // max(1, state.stats.max_health)

    if enemy_percent <= 25:
        return "dying"
    if enemy_percent <= 55:
        return "hurt"
    if player_percent <= 35:
        return "winning"
    return "confident"


def pick_line(state: GameState, combat: Combat) -> str:
    """Выбор реплики — локальный: запросов к модели он не стоит."""
    mood = enemy_mood(state, combat)
    variants = combat.lines.get(mood) or combat.lines.get("confident") or []
    if not variants:
        return ""
    # Не повторяем ту же фразу подряд, если есть из чего выбрать.
    choices = [line for line in variants if line != combat.enemy_line] or variants
    return random.choice(choices)


# ------------------------------------------------------------- завязка


def build_combat(state: GameState, data: dict, reason: str, npc_name: str = "") -> Combat:
    """Собирает бой из ответа модели, зажимая все числа в разумные границы."""
    enemy_raw = data.get("enemy") or {}
    hp = _clamp(enemy_raw.get("hp"), ENEMY_HP_LIMITS, 45)
    weapon_raw = data.get("player_weapon") or {}

    items = []
    for raw in (data.get("usable_items") or [])[:4]:
        if not isinstance(raw, dict):
            continue
        name = str(raw.get("name", "")).strip()
        if name and any(item.name.strip().lower() == name.lower() for item in state.inventory):
            items.append({"name": name, "heal": _clamp(raw.get("heal"), HEAL_LIMITS, 10)})

    lines_raw = data.get("lines") or {}
    lines = {
        mood: [str(line).strip() for line in (lines_raw.get(mood) or []) if str(line).strip()][:3]
        for mood in ("confident", "hurt", "dying", "winning")
    }

    combat = Combat(
        enemy=Combatant(
            name=str(enemy_raw.get("name", "")).strip() or "Противник",
            hp=hp,
            max_hp=hp,
            attack=_clamp(enemy_raw.get("attack"), ENEMY_ATTACK_LIMITS, 7),
            defense=_clamp(enemy_raw.get("defense"), ENEMY_DEFENSE_LIMITS, 2),
            description=str(enemy_raw.get("description", "")).strip(),
        ),
        weapon=str(weapon_raw.get("name", "")).strip(),
        weapon_bonus=_clamp(weapon_raw.get("attack_bonus"), WEAPON_BONUS_LIMITS, 0),
        armor_bonus=_clamp(data.get("player_armor_bonus"), ARMOR_BONUS_LIMITS, 0),
        lines=lines,
        usable_items=items,
        reason=reason,
        opening=str(data.get("opening", "")).strip(),
        npc_name=npc_name,
    )
    combat.enemy_line = pick_line(state, combat)
    return combat


# --------------------------------------------------------------- раунд


def enemy_attack(combat: Combat) -> int:
    """Раненый враг бьёт слабее — то же правило, что и для игрока.
    Без этой симметрии бой превращается в гонку, исход которой ясен заранее."""
    value = combat.enemy.attack
    if combat.enemy.hp * 100 // max(1, combat.enemy.max_hp) <= WOUNDED_PERCENT:
        value -= max(1, value // 4)
    return max(1, value)


def _enemy_strikes(state: GameState, combat: Combat, defending: bool, bonus: int = 0) -> None:
    defense = player_defense(state, combat) + (DEFEND_BONUS if defending else 0)

    # Иногда враг вкладывается в удар. Именно ради таких моментов и нужна
    # защита: без них она была бы кнопкой «проиграй медленнее».
    heavy = random.randint(1, 100) <= HEAVY_BLOW_CHANCE
    hit = damage(enemy_attack(combat) + bonus + (HEAVY_BLOW_BONUS if heavy else 0), defense)
    state.stats.health = max(0, state.stats.health - hit)

    if heavy:
        combat.add("enemy", f"{combat.enemy.name} вкладывается в удар: −{hit} здоровья.")
    else:
        combat.add("enemy", f"{combat.enemy.name} бьёт в ответ: −{hit} здоровья.")

    if state.stats.health <= 0:
        combat.finished = True
        combat.outcome = "defeat"
        state.game_over = True
        return

    # Защита без ответа была бы кнопкой «проиграй медленнее»: пропуская удар
    # мимо себя, боец отвечает вполсилы.
    if defending:
        counter = damage(max(1, player_attack(state, combat) // 2), combat.enemy.defense)
        combat.enemy.hp = max(0, combat.enemy.hp - counter)
        combat.add("player", f"Ты отбиваешь удар и достаёшь в ответ: −{counter} противнику.")
        if combat.enemy.hp <= 0:
            combat.finished = True
            combat.outcome = "victory"
            combat.add("system", f"{combat.enemy.name} падает.")


def resolve_round(state: GameState, combat: Combat, action: str, item_name: str = "") -> dict:
    """Один раунд боя целиком в коде. Запросов к модели не делает."""
    if combat.finished:
        return {"finished": True, "outcome": combat.outcome}

    action = action if action in ACTIONS else "attack"
    defending = action == "defend"

    if action == "attack":
        hit = damage(player_attack(state, combat), combat.enemy.defense)
        combat.enemy.hp = max(0, combat.enemy.hp - hit)
        combat.add("player", f"Ты атакуешь: −{hit} здоровья противнику.")

    elif action == "defend":
        combat.add("player", "Ты уходишь в защиту и ждёшь промаха.")

    elif action == "item":
        used = None
        for item in combat.usable_items:
            if not item_name or item["name"].lower() == item_name.lower():
                used = item
                break
        if used is None:
            combat.add("system", "Под рукой нет ничего подходящего — ход потерян.")
        else:
            before = state.stats.health
            state.stats.health = min(state.stats.max_health, before + used["heal"])
            gained = state.stats.health - before
            combat.usable_items.remove(used)
            for item in list(state.inventory):
                if item.name.lower() == used["name"].lower():
                    state.inventory.remove(item)
                    break
            combat.add("player", f"Ты пускаешь в ход «{used['name']}»: +{gained} здоровья.")

    elif action == "flee":
        chance = max(15, 60 - state.stats.fatigue // 2)
        if random.randint(1, 100) <= chance:
            combat.add("player", "Ты разрываешь дистанцию и уходишь.")
            combat.finished = True
            combat.outcome = "fled"
            state.stats.fatigue = min(100, state.stats.fatigue + FATIGUE_PER_ROUND * 2)
            return {"finished": True, "outcome": "fled"}
        combat.add("player", "Ты пытаешься уйти — и открываешься для удара.")
        _enemy_strikes(state, combat, defending=False, bonus=2)
        state.stats.fatigue = min(100, state.stats.fatigue + FATIGUE_PER_ROUND)
        combat.round += 1
        combat.enemy_line = pick_line(state, combat)
        return {"finished": combat.finished, "outcome": combat.outcome}

    # Враг отвечает, если ещё жив.
    if combat.enemy.hp <= 0:
        combat.finished = True
        combat.outcome = "victory"
        combat.add("system", f"{combat.enemy.name} падает.")
    else:
        _enemy_strikes(state, combat, defending=defending)

    state.stats.fatigue = min(
        100,
        state.stats.fatigue + (FATIGUE_PER_DEFEND if defending else FATIGUE_PER_ROUND),
    )
    combat.round += 1
    combat.enemy_line = pick_line(state, combat)
    return {"finished": combat.finished, "outcome": combat.outcome}


# ---------------------------------------------------------------- итог


OUTCOME_TEXT = {
    "victory": "Игрок победил в бою",
    "defeat": "Игрок проиграл бой и потерял сознание или погиб",
    "fled": "Игрок сбежал с поля боя",
}


def outcome_note(state: GameState, combat: Combat) -> str:
    """Сводка для модели, чтобы она вернула историю в повествование."""
    result = OUTCOME_TEXT.get(combat.outcome, "Бой закончился")
    return (
        f"ИТОГ БОЯ (это уже случилось, опиши последствия):\n"
        f"Противник: {combat.enemy.name} ({combat.enemy.description}).\n"
        f"Причина стычки: {combat.reason}\n"
        f"Раундов: {combat.round - 1}. {result}.\n"
        f"Здоровье противника осталось: {combat.enemy.hp} из {combat.enemy.max_hp}.\n"
        f"Здоровье игрока: {state.stats.health} из {state.stats.max_health}, "
        f"усталость {state.stats.fatigue}.\n"
        "Не переигрывай бой заново и не меняй его итог — опиши, что было сразу после."
    )


def to_dict(state: GameState, combat: Combat) -> dict:
    """То, что видит игрок на боевом экране."""
    return {
        "enemy": {
            "name": combat.enemy.name,
            "description": combat.enemy.description,
            "hp": combat.enemy.hp,
            "max_hp": combat.enemy.max_hp,
            "attack": combat.enemy.attack,
            "defense": combat.enemy.defense,
        },
        "player": {
            "hp": state.stats.health,
            "max_hp": state.stats.max_health,
            "attack": player_attack(state, combat),
            "defense": player_defense(state, combat),
            "weapon": combat.weapon,
        },
        "round": combat.round,
        "line": combat.enemy_line,
        "opening": combat.opening,
        "reason": combat.reason,
        "items": combat.usable_items,
        "log": [{"round": e.round, "kind": e.kind, "text": e.text} for e in combat.log],
        "finished": combat.finished,
        "outcome": combat.outcome,
    }
