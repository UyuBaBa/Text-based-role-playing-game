/**
 * Применение изменений состояния.
 *
 * Модель предлагает дельты — код решает, что из этого станет правдой. Без
 * этого слоя числа поплывут: модель то «вылечит» персонажа на ровном месте,
 * то снимет 90 здоровья за царапину.
 *
 * Отдых и сон модель не считает вовсе: она только сообщает, что персонаж
 * делал (поле rest), а насколько он восстановился — решает формула ниже.
 */

import { MAX_FATIGUE, turnNumber } from './state.js';
import { applyNpcUpdates } from './npc.js';

// Предел изменения за один ход. Больше — только через прямые механики
// (отдых и сон ниже, бой в combat.js).
export const HEALTH_DELTA_LIMITS = [-35, 25];
export const FATIGUE_DELTA_LIMITS = [-10, 30];
export const TIME_ADVANCE_LIMITS = [0, 12 * 60];

export const MAX_INVENTORY = 20;

// Усталость копится сама по себе: час на ногах выматывает, даже если ничего
// не случилось.
export const FATIGUE_DRIFT_MINUTES = 45;

export const REST_NONE = 'нет';
export const REST_SHORT = 'отдых';
export const REST_MEAL = 'еда';
export const REST_SLEEP = 'сон';
export const REST_KINDS = [REST_NONE, REST_SHORT, REST_MEAL, REST_SLEEP];

// Сколько минут отдыха снимает единицу усталости.
const REST_RATE = { [REST_SHORT]: 4, [REST_SLEEP]: 5 };
const MEAL_RECOVERY = 8;

// Пороги, на которых меняется поведение сюжета.
export const FATIGUE_SPENT = 85; // на пределе: активные попытки проваливаются
export const FATIGUE_TIRED = 65; // сильно устал: всё даётся тяжело
export const FATIGUE_NOTICEABLE = 40;
export const HEALTH_CRITICAL = 20;
export const HEALTH_HURT = 50;

// Порог, на котором код сам отказывает игроку, не тратя запрос к модели.
export const FATIGUE_BLOCK = 90;
export const HEALTH_BLOCK = 12;

function clamp(value, [low, high], fallback = 0) {
  const number = Number.parseInt(value, 10);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(low, Math.min(high, number));
}

/**
 * Сколько усталости снимает отдых. Считает код, а не модель: иначе
 * «прикорнул на пять минут» будет лечить как полноценный сон.
 */
export function fatigueFromRest(kind, minutes) {
  if (kind === REST_MEAL) return -MEAL_RECOVERY;
  const rate = REST_RATE[kind];
  if (!rate) return 0;
  return -Math.floor(minutes / rate);
}

/**
 * Применяет дельты к состоянию и возвращает то, что реально произошло —
 * для подсветки изменений в интерфейсе.
 */
export function applyStateDelta(state, delta, rest = REST_NONE) {
  delta = delta || {};
  rest = REST_KINDS.includes(rest) ? rest : REST_NONE;

  let healthDelta = clamp(delta.health, HEALTH_DELTA_LIMITS);
  const minutes = clamp(delta.time_advance_min, TIME_ADVANCE_LIMITS);

  let fatigueDelta;
  if (rest === REST_NONE) {
    // Усилие от самого действия плюс естественный износ от времени.
    fatigueDelta = clamp(delta.fatigue, FATIGUE_DELTA_LIMITS);
    fatigueDelta += Math.floor(minutes / FATIGUE_DRIFT_MINUTES);
  } else {
    // Персонаж отдыхал: предложение модели игнорируем целиком.
    fatigueDelta = fatigueFromRest(rest, minutes);
  }

  // Сон затягивает раны сам по себе, но только если это был настоящий сон.
  if (rest === REST_SLEEP && minutes >= 240 && healthDelta >= 0) {
    healthDelta += Math.min(10, Math.floor(minutes / 60));
  }

  const beforeHealth = state.stats.health;
  const beforeFatigue = state.stats.fatigue;

  state.stats.health = Math.max(0, Math.min(state.stats.max_health, beforeHealth + healthDelta));
  state.stats.fatigue = Math.max(0, Math.min(MAX_FATIGUE, beforeFatigue + fatigueDelta));
  state.elapsed_minutes += minutes;

  if (state.stats.health <= 0) state.game_over = true;

  return {
    health: state.stats.health - beforeHealth,
    fatigue: state.stats.fatigue - beforeFatigue,
    minutes,
    rest,
  };
}

/**
 * Добавляет и убирает предметы. Сравнение по имени без учёта регистра —
 * модель редко повторяет название дословно.
 */
export function applyInventoryChanges(state, changes) {
  changes = changes || {};
  const added = [];
  const removed = [];

  // Имена, которые уходят в этом ходе. Если модель противоречит сама себе
  // (одновременно add и remove одного предмета) — побеждает удаление,
  // иначе предмет молча вернулся бы обратно.
  const dropping = new Set(
    (changes.remove || [])
      .map((raw) => String(raw).trim().toLowerCase())
      .filter(Boolean)
  );

  for (const name of dropping) {
    const index = state.inventory.findIndex(
      (item) => item.name.trim().toLowerCase() === name
    );
    if (index >= 0) {
      removed.push(state.inventory[index].name);
      state.inventory.splice(index, 1);
    }
  }

  const existing = new Set(state.inventory.map((item) => item.name.trim().toLowerCase()));
  for (const raw of changes.add || []) {
    if (!raw || typeof raw !== 'object') continue;
    const name = String(raw.name || '').trim();
    const key = name.toLowerCase();
    if (!name || existing.has(key) || dropping.has(key)) continue;
    if (state.inventory.length >= MAX_INVENTORY) continue;
    state.inventory.push({ name, description: String(raw.description || '').trim() });
    existing.add(key);
    added.push(name);
  }

  return { added, removed };
}

export function applyLocation(state, change) {
  change = change || {};
  if (!change.changed) return false;
  const name = String(change.name || '').trim();
  if (!name) return false;
  state.location.name = name;
  state.location.description = String(change.description || '').trim();
  return true;
}

/** Единая точка применения ответа модели к состоянию. */
export function applyTurn(state, playerText, response) {
  const narrative = String(response.narrative || '').trim();
  const rest = String(response.rest || REST_NONE).trim().toLowerCase();

  const changes = {
    stats: applyStateDelta(state, response.state_delta, rest),
    inventory: applyInventoryChanges(state, response.inventory_changes),
    location_changed: applyLocation(state, response.location_change),
    npcs: applyNpcUpdates(state, response.npcs, turnNumber(state) + 1),
  };

  const timeOfDay = String(response.time_of_day || '').trim().toLowerCase();
  if (['утро', 'день', 'вечер', 'ночь'].includes(timeOfDay)) {
    state.time_of_day = timeOfDay;
  }

  const memory = String(response.memory_update || '').trim();
  if (memory) state.chronicle.push(`[ход ${turnNumber(state) + 1}] ${memory}`);

  state.suggested_actions = (response.suggested_actions || [])
    .map((action) => String(action).trim())
    .filter(Boolean)
    .slice(0, 3);

  state.history.push({
    number: turnNumber(state) + 1,
    player: playerText.trim(),
    narrative,
    local: false,
  });
  return changes;
}

// ------------------------------------------------- состояние -> поведение

/**
 * Жёсткие указания ведущему, вытекающие из состояния персонажа.
 *
 * Просить модель «учитывать усталость» бесполезно — она вежливо согласится
 * и забудет. Работает только прямой приказ, вписанный в промпт этого хода.
 */
export function stateDirectives(state) {
  const directives = [];
  const fatigue = state.stats.fatigue;
  const health = state.stats.health;
  const healthPercent = Math.floor((health * 100) / Math.max(1, state.stats.max_health));

  if (fatigue >= FATIGUE_SPENT) {
    directives.push(
      `Усталость ${fatigue} из 100. Персонаж на пределе: руки трясутся, ` +
        'мысли путаются. Любая активная попытка (бежать, драться, долго идти, ' +
        'лезть вверх, работать) ОБЯЗАНА провалиться или обойтись дорого — ' +
        'он падает, роняет, не успевает. Веди сцену к тому, чтобы он наконец лёг.'
    );
  } else if (fatigue >= FATIGUE_TIRED) {
    directives.push(
      `Усталость ${fatigue} из 100. Персонаж сильно измотан. Всё физическое ` +
        'даётся тяжело и выходит хуже задуманного, на точные действия нет ' +
        'твёрдости в руках. Подчёркивай это в описании.'
    );
  } else if (fatigue >= FATIGUE_NOTICEABLE) {
    directives.push(
      `Усталость ${fatigue} из 100. Персонаж заметно утомлён: тяжелее дышит, ` +
        'хочется сесть. Упомяни это хотя бы вскользь.'
    );
  }

  if (healthPercent <= HEALTH_CRITICAL) {
    directives.push(
      `Здоровье ${health} из ${state.stats.max_health}. Персонаж тяжело ранен: ` +
        'перед глазами плывёт, каждое движение отзывается болью. Физические ' +
        'действия почти невозможны. Ещё одна серьёзная рана его убьёт.'
    );
  } else if (healthPercent <= HEALTH_HURT) {
    directives.push(
      `Здоровье ${health} из ${state.stats.max_health}. Персонаж ранен и ` +
        'чувствует это: раны мешают, кровь идёт, резкие движения отдают болью.'
    );
  }

  return directives;
}

// ------------------------------------------------- отказ без запроса к API

// Слова, по которым видно попытку активного действия.
const ACTIVE_WORDS = [
  'беж', 'бег', 'бро', 'прыг', 'лез', 'лаз', 'кара', 'дер', 'драк', 'бить', 'бью',
  'удар', 'атак', 'напад', 'ломать', 'выбива', 'тащ', 'нес', 'копа', 'руб', 'плы',
  'идти', 'иду', 'пойд', 'шага', 'марш', 'поход', 'гна', 'догн', 'убега', 'спеш',
  'торопл', 'сража', 'борь', 'толка', 'тян',
];

// Слова, по которым видно, что игрок как раз собрался отдохнуть.
const REST_WORDS = [
  'отдых', 'отдох', 'сесть', 'сяд', 'сажус', 'ложус', 'лечь', 'ляг', 'спать', 'сплю',
  'уснут', 'засып', 'привал', 'переве', 'дыша', 'отдышат', 'пить', 'пью', 'ест', 'ем ',
  'поест', 'перекус', 'лежат', 'лежу', 'стоя', 'жду', 'ждать', 'смотр', 'гляж',
];

function looksActive(text) {
  const lowered = text.toLowerCase();
  if (REST_WORDS.some((word) => lowered.includes(word))) return false;
  return ACTIVE_WORDS.some((word) => lowered.includes(word));
}

/**
 * Если действие заведомо невозможно — возвращает короткий ответ и экономит
 * запрос к модели. Во всех сомнительных случаях возвращает null: лучше
 * потратить запрос, чем отнять у игрока ход.
 */
export function blockAction(state, text) {
  if (state.game_over || !looksActive(text)) return null;

  if (state.stats.fatigue >= FATIGUE_BLOCK) {
    return (
      'Ты пытаешься — и тело просто не слушается. Ноги ватные, в глазах темнеет, ' +
      'рука хватает пустоту. Так больше нельзя: сначала надо лечь и закрыть глаза, ' +
      'хотя бы ненадолго.'
    );
  }

  if (state.stats.health <= HEALTH_BLOCK) {
    return (
      'Стоит тебе рвануться, как боль складывает тебя пополам. Что-то внутри ' +
      'отзывается так, что темнеет в глазах. В таком состоянии ты не сделаешь ' +
      'ничего — сначала надо остановить кровь и отлежаться.'
    );
  }

  return null;
}

export const LOCAL_REST_ACTIONS = [
  'Сесть и отдышаться',
  'Найти укрытие и поспать',
  'Достать что-нибудь поесть',
];

/** Отказ — тоже ход: время идёт, усталость капает, но запрос не тратится. */
export function applyBlockedTurn(state, playerText, narrative) {
  const changes = {
    stats: applyStateDelta(state, { health: 0, fatigue: 1, time_advance_min: 2 }),
    inventory: { added: [], removed: [] },
    location_changed: false,
    npcs: [],
    local: true,
  };
  state.suggested_actions = [...LOCAL_REST_ACTIONS];
  state.history.push({
    number: turnNumber(state) + 1,
    player: playerText.trim(),
    narrative,
    local: true,
  });
  return changes;
}
