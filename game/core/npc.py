"""Персонажи вокруг игрока и их отношение к нему.

Симпатия — число от -100 до +100, которое живёт в состоянии игры. Модель не
держит его в голове: она получает готовое число вместе с инструкцией, как себя
вести при таком отношении, и предлагает только изменение за ход.

Смысл в том, чтобы отношение было последствием, а не декорацией: тот, кого игрок
обманул, будет мешать ему и через двадцать ходов.
"""

from __future__ import annotations

from .state import GameState, NPC

SYMPATHY_MIN = -100
SYMPATHY_MAX = 100

# Предел изменения за один ход: доверие не зарабатывается одной репликой.
SYMPATHY_DELTA_LIMIT = 25

# Сколько ходов персонаж остаётся в «активной памяти» после последней встречи.
# Дальше он выпадает из промпта, но остаётся в журнале.
ACTIVE_MEMORY_TURNS = 12

# Сколько персонажей максимум уходит в промпт: иначе контекст раздувается.
MAX_ACTIVE_IN_PROMPT = 6

# Порог, за которым персонаж готов навредить сам. На этапе 6 станет одним
# из условий входа в бой.
HOSTILE_THRESHOLD = -60

# Шкала из README, п.1.5: число -> ярлык для игрока и приказ для модели.
SYMPATHY_TIERS = (
    (60, "Предан", "помогает без просьб, делится последним, готов рискнуть ради игрока"),
    (20, "Дружелюбен", "охотно разговаривает, идёт навстречу, оказывает мелкие услуги"),
    (-19, "Нейтрален", "держит дистанцию, говорит по делу, торгуется, своей выгоды не упустит"),
    (-59, "Неприязнь", "грубит или холоден, обманывает, набивает цену, помогать не станет"),
    (
        SYMPATHY_MIN,
        "Враждебен",
        "активно вредит: лжёт, подставляет, зовёт чужих, может напасть первым",
    ),
)


def sympathy_tier(value: int) -> tuple[str, str]:
    for threshold, label, behavior in SYMPATHY_TIERS:
        if value >= threshold:
            return label, behavior
    return SYMPATHY_TIERS[-1][1], SYMPATHY_TIERS[-1][2]


def sympathy_label(value: int) -> str:
    return sympathy_tier(value)[0]


def _clamp_delta(value, limit: int = SYMPATHY_DELTA_LIMIT) -> int:
    try:
        number = int(value)
    except (TypeError, ValueError):
        return 0
    return max(-limit, min(limit, number))


def find_npc(state: GameState, name: str) -> NPC | None:
    target = name.strip().lower()
    for npc in state.npcs:
        if npc.name.strip().lower() == target:
            return npc
    return None


def apply_npc_updates(state: GameState, payload, turn_number: int) -> list[dict]:
    """Сливает список персонажей из ответа модели в состояние.

    Возвращает список изменений симпатии для показа в интерфейсе.
    """
    # Пометки «в сцене» живут один ход.
    for npc in state.npcs:
        npc.present = False

    if not isinstance(payload, list):
        return []

    changes: list[dict] = []
    for raw in payload[:8]:
        if not isinstance(raw, dict):
            continue
        name = str(raw.get("name", "")).strip()
        # Безымянные («стражник», «прохожий») в реестр не попадают:
        # иначе он забьётся статистами.
        if not name or len(name) < 2:
            continue

        present = bool(raw.get("present", True))
        npc = find_npc(state, name)

        # У новичка это не изменение, а стартовое отношение: персонаж может
        # появиться уже врагом. Предел ±25 сдерживает только дальнейшие сдвиги.
        limit = SYMPATHY_MAX if npc is None else SYMPATHY_DELTA_LIMIT
        delta = _clamp_delta(raw.get("sympathy_delta"), limit)

        if npc is None:
            npc = NPC(
                name=name,
                role=str(raw.get("role", "")).strip(),
                description=str(raw.get("description", "")).strip(),
                sympathy=delta,
                first_seen_turn=turn_number,
                last_seen_turn=turn_number,
                scenes=1,
                important=bool(raw.get("important", False)),
                present=present,
            )
            state.npcs.append(npc)
            changes.append({"name": npc.name, "delta": delta, "sympathy": npc.sympathy, "new": True})
            continue

        before = npc.sympathy
        npc.sympathy = max(SYMPATHY_MIN, min(SYMPATHY_MAX, before + delta))
        npc.present = present
        if present and npc.last_seen_turn != turn_number:
            npc.scenes += 1
        if present:
            npc.last_seen_turn = turn_number
        # Роль и описание уточняем, но не затираем пустотой.
        if not npc.role:
            npc.role = str(raw.get("role", "")).strip()
        if not npc.description:
            npc.description = str(raw.get("description", "")).strip()
        if raw.get("important"):
            npc.important = True
        if npc.sympathy != before:
            changes.append(
                {
                    "name": npc.name,
                    "delta": npc.sympathy - before,
                    "sympathy": npc.sympathy,
                    "new": False,
                }
            )

    return changes


def present_npcs(state: GameState) -> list[NPC]:
    return [npc for npc in state.npcs if npc.present]


def active_npcs(state: GameState) -> list[NPC]:
    """Кто уходит в промпт: те, кто в сцене, и те, кого встречали недавно.

    Давние знакомые молча выпадают из контекста — это и есть затухание.
    Из журнала они при этом никуда не деваются.
    """
    current = state.turn_number
    recent = [
        npc
        for npc in state.npcs
        if npc.present or current - npc.last_seen_turn <= ACTIVE_MEMORY_TURNS
    ]
    recent.sort(key=lambda npc: (not npc.present, -npc.last_seen_turn))
    return recent[:MAX_ACTIVE_IN_PROMPT]


def journal_npcs(state: GameState) -> list[NPC]:
    """Только значимые: с именем и либо встреченные не в одной сцене, либо
    помеченные моделью как важные. Случайный прохожий в журнал не попадёт."""
    significant = [npc for npc in state.npcs if npc.scenes >= 2 or npc.important]
    significant.sort(key=lambda npc: -npc.last_seen_turn)
    return significant


def npc_block(state: GameState) -> str:
    """Блок для промпта: кто рядом, как относится и что из этого следует."""
    active = active_npcs(state)
    if not active:
        return ""

    lines = []
    for npc in active:
        label, behavior = sympathy_tier(npc.sympathy)
        where = "СЕЙЧАС В СЦЕНЕ" if npc.present else f"последний раз: ход {npc.last_seen_turn}"
        role = f", {npc.role}" if npc.role else ""
        lines.append(
            f"- {npc.name}{role} ({where}). Симпатия {npc.sympathy:+d} — {label}: {behavior}."
        )

    return (
        "ПЕРСОНАЖИ И ИХ ОТНОШЕНИЕ К ИГРОКУ (симпатия от -100 до +100):\n"
        + "\n".join(lines)
        + "\n\nВеди их ровно так, как предписывает их отношение, даже если игроку это "
        "невыгодно. Симпатия меняется от поступков игрока, а не от вежливых слов."
    )
