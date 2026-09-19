"""Применение изменений состояния.

Модель предлагает дельты — код решает, что из этого станет правдой. Без этого
слоя числа поплывут: модель то «вылечит» персонажа на ровном месте, то снимет
90 здоровья за царапину.

Отдых и сон модель не считает вовсе: она только сообщает, что персонаж делал
(поле rest), а насколько он восстановился — решает формула ниже.
"""

from __future__ import annotations

from .npc import apply_npc_updates
from .state import MAX_FATIGUE, GameState, Item, Turn

# Предел изменения за один ход. Больше — только через прямые механики
# (отдых и сон ниже, бой на этапе 6).
HEALTH_DELTA_LIMITS = (-35, 25)
FATIGUE_DELTA_LIMITS = (-10, 30)
TIME_ADVANCE_LIMITS = (0, 12 * 60)

MAX_INVENTORY = 20

# Усталость копится сама по себе: час на ногах выматывает, даже если ничего
# не случилось.
FATIGUE_DRIFT_MINUTES = 45

REST_NONE = "нет"
REST_SHORT = "отдых"
REST_MEAL = "еда"
REST_SLEEP = "сон"
REST_KINDS = (REST_NONE, REST_SHORT, REST_MEAL, REST_SLEEP)

# Сколько минут отдыха снимает единицу усталости.
REST_RATE = {REST_SHORT: 4, REST_SLEEP: 5}
MEAL_RECOVERY = 8

# Пороги, на которых меняется поведение сюжета.
FATIGUE_SPENT = 85      # на пределе: активные попытки проваливаются
FATIGUE_TIRED = 65      # сильно устал: всё даётся тяжело
FATIGUE_NOTICEABLE = 40
HEALTH_CRITICAL = 20
HEALTH_HURT = 50

# Порог, на котором код сам отказывает игроку, не тратя запрос к модели.
FATIGUE_BLOCK = 90
HEALTH_BLOCK = 12


def _clamp(value, low: int, high: int, default: int = 0) -> int:
    try:
        number = int(value)
    except (TypeError, ValueError):
        return default
    return max(low, min(high, number))


def fatigue_from_rest(kind: str, minutes: int) -> int:
    """Сколько усталости снимает отдых. Считает код, а не модель: иначе
    «прикорнул на пять минут» будет лечить как полноценный сон."""
    if kind == REST_MEAL:
        return -MEAL_RECOVERY
    rate = REST_RATE.get(kind)
    if not rate:
        return 0
    return -(minutes // rate)


def apply_state_delta(state: GameState, delta: dict, rest: str = REST_NONE) -> dict:
    """Применяет дельты к состоянию и возвращает то, что реально произошло —
    для подсветки изменений в интерфейсе."""
    delta = delta or {}
    rest = rest if rest in REST_KINDS else REST_NONE

    health_delta = _clamp(delta.get("health"), *HEALTH_DELTA_LIMITS)
    minutes = _clamp(delta.get("time_advance_min"), *TIME_ADVANCE_LIMITS)

    if rest == REST_NONE:
        # Усилие от самого действия плюс естественный износ от времени.
        fatigue_delta = _clamp(delta.get("fatigue"), *FATIGUE_DELTA_LIMITS)
        fatigue_delta += minutes // FATIGUE_DRIFT_MINUTES
    else:
        # Персонаж отдыхал: предложение модели игнорируем целиком.
        fatigue_delta = fatigue_from_rest(rest, minutes)

    # Сон затягивает раны сам по себе, но только если это был настоящий сон.
    if rest == REST_SLEEP and minutes >= 240 and health_delta >= 0:
        health_delta += min(10, minutes // 60)

    before_health = state.stats.health
    before_fatigue = state.stats.fatigue

    state.stats.health = max(0, min(state.stats.max_health, before_health + health_delta))
    state.stats.fatigue = max(0, min(MAX_FATIGUE, before_fatigue + fatigue_delta))
    state.elapsed_minutes += minutes

    if state.stats.health <= 0:
        state.game_over = True

    return {
        "health": state.stats.health - before_health,
        "fatigue": state.stats.fatigue - before_fatigue,
        "minutes": minutes,
        "rest": rest,
    }


def apply_inventory_changes(state: GameState, changes: dict) -> dict:
    """Добавляет и убирает предметы. Сравнение по имени без учёта регистра —
    модель редко повторяет название дословно."""
    changes = changes or {}
    added: list[str] = []
    removed: list[str] = []

    # Имена, которые уходят в этом ходе. Если модель противоречит сама себе
    # (одновременно add и remove одного предмета) — побеждает удаление,
    # иначе предмет молча вернулся бы обратно.
    dropping = {
        str(raw).strip().lower() for raw in (changes.get("remove") or []) if str(raw).strip()
    }

    for name in dropping:
        for item in list(state.inventory):
            if item.name.strip().lower() == name:
                state.inventory.remove(item)
                removed.append(item.name)
                break

    existing = {item.name.strip().lower() for item in state.inventory}
    for raw in changes.get("add") or []:
        if not isinstance(raw, dict):
            continue
        name = str(raw.get("name", "")).strip()
        if not name or name.lower() in existing or name.lower() in dropping:
            continue
        if len(state.inventory) >= MAX_INVENTORY:
            continue
        state.inventory.append(
            Item(name=name, description=str(raw.get("description", "")).strip())
        )
        existing.add(name.lower())
        added.append(name)

    return {"added": added, "removed": removed}


def apply_location(state: GameState, location_change: dict) -> bool:
    change = location_change or {}
    if not change.get("changed"):
        return False
    name = str(change.get("name", "")).strip()
    if not name:
        return False
    state.location.name = name
    state.location.description = str(change.get("description", "")).strip()
    return True


def apply_turn(
    state: GameState, player_text: str, response: dict, player_name: str = ""
) -> dict:
    """Единая точка применения ответа модели к состоянию."""
    narrative = str(response.get("narrative", "")).strip()
    rest = str(response.get("rest", REST_NONE)).strip().lower()

    changes = {
        "stats": apply_state_delta(state, response.get("state_delta"), rest),
        "inventory": apply_inventory_changes(state, response.get("inventory_changes")),
        "location_changed": apply_location(state, response.get("location_change")),
        "npcs": apply_npc_updates(state, response.get("npcs"), state.turn_number + 1),
    }

    time_of_day = str(response.get("time_of_day", "")).strip().lower()
    if time_of_day in ("утро", "день", "вечер", "ночь"):
        state.time_of_day = time_of_day

    memory = str(response.get("memory_update", "")).strip()
    if memory:
        state.chronicle.append(f"[ход {state.turn_number + 1}] {memory}")

    actions = [
        str(action).strip()
        for action in (response.get("suggested_actions") or [])
        if str(action).strip()
    ]
    state.suggested_actions = actions[:3]

    state.history.append(
        Turn(
            number=state.turn_number + 1,
            player=player_text.strip(),
            narrative=narrative,
            player_name=player_name.strip(),
        )
    )
    return changes


# ------------------------------------------------- состояние -> поведение


def state_directives(state: GameState) -> list[str]:
    """Жёсткие указания ведущему, вытекающие из состояния персонажа.

    Просить модель «учитывать усталость» бесполезно — она вежливо согласится
    и забудет. Работает только прямой приказ, вписанный в промпт этого хода.
    """
    directives: list[str] = []
    fatigue = state.stats.fatigue
    health = state.stats.health
    health_percent = health * 100 // max(1, state.stats.max_health)

    if fatigue >= FATIGUE_SPENT:
        directives.append(
            f"Усталость {fatigue} из 100. Персонаж на пределе: руки трясутся, "
            "мысли путаются. Любая активная попытка (бежать, драться, долго идти, "
            "лезть вверх, работать) ОБЯЗАНА провалиться или обойтись дорого — "
            "он падает, роняет, не успевает. Веди сцену к тому, чтобы он наконец лёг."
        )
    elif fatigue >= FATIGUE_TIRED:
        directives.append(
            f"Усталость {fatigue} из 100. Персонаж сильно измотан. Всё физическое "
            "даётся тяжело и выходит хуже задуманного, на точные действия нет "
            "твёрдости в руках. Подчёркивай это в описании."
        )
    elif fatigue >= FATIGUE_NOTICEABLE:
        directives.append(
            f"Усталость {fatigue} из 100. Персонаж заметно утомлён: тяжелее дышит, "
            "хочется сесть. Упомяни это хотя бы вскользь."
        )

    if health_percent <= HEALTH_CRITICAL:
        directives.append(
            f"Здоровье {health} из {state.stats.max_health}. Персонаж тяжело ранен: "
            "перед глазами плывёт, каждое движение отзывается болью. Физические "
            "действия почти невозможны. Ещё одна серьёзная рана его убьёт."
        )
    elif health_percent <= HEALTH_HURT:
        directives.append(
            f"Здоровье {health} из {state.stats.max_health}. Персонаж ранен и "
            "чувствует это: раны мешают, кровь идёт, резкие движения отдают болью."
        )

    return directives


# ------------------------------------------------- отказ без запроса к API

# Слова, по которым видно попытку активного действия.
_ACTIVE_WORDS = (
    "беж", "бег", "бро", "прыг", "лез", "лаз", "кара", "дер", "драк", "бить", "бью",
    "удар", "атак", "напад", "ломать", "выбива", "тащ", "нес", "копа", "руб", "плы",
    "идти", "иду", "пойд", "шага", "марш", "поход", "гна", "догн", "убега", "спеш",
    "торопл", "сража", "борь", "толка", "тян",
)

# Слова, по которым видно, что игрок как раз собрался отдохнуть.
_REST_WORDS = (
    "отдых", "отдох", "сесть", "сяд", "сажус", "ложус", "лечь", "ляг", "спать", "сплю",
    "уснут", "засып", "привал", "переве", "дыша", "отдышат", "пить", "пью", "ест", "ем ",
    "поест", "перекус", "лежат", "лежу", "стоя", "жду", "ждать", "смотр", "гляж",
)


def _looks_active(text: str) -> bool:
    lowered = text.lower()
    if any(word in lowered for word in _REST_WORDS):
        return False
    return any(word in lowered for word in _ACTIVE_WORDS)


def block_action(state: GameState, text: str) -> str | None:
    """Если действие заведомо невозможно — возвращает короткий ответ и экономит
    запрос к модели. Во всех сомнительных случаях возвращает None: лучше
    потратить запрос, чем отнять у игрока ход."""
    if state.game_over or not _looks_active(text):
        return None

    if state.stats.fatigue >= FATIGUE_BLOCK:
        return (
            "Ты пытаешься — и тело просто не слушается. Ноги ватные, в глазах темнеет, "
            "рука хватает пустоту. Так больше нельзя: сначала надо лечь и закрыть глаза, "
            "хотя бы ненадолго."
        )

    if state.stats.health <= HEALTH_BLOCK:
        return (
            "Стоит тебе рвануться, как боль складывает тебя пополам. Что-то внутри "
            "отзывается так, что темнеет в глазах. В таком состоянии ты не сделаешь "
            "ничего — сначала надо остановить кровь и отлежаться."
        )

    return None


LOCAL_REST_ACTIONS = (
    "Сесть и отдышаться",
    "Найти укрытие и поспать",
    "Достать что-нибудь поесть",
)


def apply_blocked_turn(
    state: GameState, player_text: str, narrative: str, player_name: str = ""
) -> dict:
    """Отказ — тоже ход: время идёт, усталость капает, но запрос не тратится."""
    changes = {
        "stats": apply_state_delta(
            state, {"health": 0, "fatigue": 1, "time_advance_min": 2}
        ),
        "inventory": {"added": [], "removed": []},
        "location_changed": False,
        "local": True,
    }
    state.suggested_actions = list(LOCAL_REST_ACTIONS)
    state.history.append(
        Turn(
            number=state.turn_number + 1,
            player=player_text.strip(),
            narrative=narrative,
            local=True,
            player_name=player_name.strip(),
        )
    )
    return changes
