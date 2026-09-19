/**
 * Состояние игры — единственный источник правды.
 *
 * Модель не помнит ни здоровья, ни инвентаря, ни времени: всё это живёт здесь
 * и подставляется в промпт каждый ход. Ответ модели содержит только
 * предложения изменений, которые проверяет rules.js.
 *
 * Состояние — обычный объект без методов, поэтому сохраняется одним
 * JSON.stringify и восстанавливается так же.
 */

// Версия схемы: по ней распознаются сейвы, записанные другой версией игры.
export const STATE_VERSION = 1;

export const MAX_HEALTH = 100;
export const MAX_FATIGUE = 100;
export const MINUTES_PER_DAY = 24 * 60;

export const TIMES_OF_DAY = ['утро', 'день', 'вечер', 'ночь'];

/** Пустое состояние со всеми полями на умолчаниях. */
export function emptyState() {
  return {
    version: STATE_VERSION,

    // Карточка мира — то, что сгенерировано на старте. По ходу игры не меняется.
    world_title: '',
    genre: '',
    backstory: '',
    world_rules: [],

    character_name: '',
    character_background: '',
    character_traits: [],
    character_goal: '',

    // Изменяемая часть.
    stats: { health: MAX_HEALTH, max_health: MAX_HEALTH, fatigue: 0 },
    location: { name: '', description: '' },
    inventory: [],
    elapsed_minutes: 0,
    time_of_day: 'утро',

    chronicle: [],
    history: [],
    suggested_actions: [],

    npcs: [],
    flags: {},

    game_over: false,
  };
}

/** Сколько ходов сделал игрок. Нулевая запись истории — первая сцена, она не ход. */
export function turnNumber(state) {
  return Math.max(0, state.history.length - 1);
}

export function day(state) {
  return Math.floor(state.elapsed_minutes / MINUTES_PER_DAY) + 1;
}

export function elapsedText(state) {
  const withinDay = state.elapsed_minutes % MINUTES_PER_DAY;
  const hours = Math.floor(withinDay / 60);
  const minutes = withinDay % 60;
  if (state.elapsed_minutes < 60) return `${minutes} мин`;
  if (!minutes) return `${hours} ч`;
  return `${hours} ч ${String(minutes).padStart(2, '0')} мин`;
}

export function inventoryText(state) {
  if (!state.inventory.length) return 'пусто';
  return state.inventory.map((item) => item.name).join(', ');
}

/** Превращает карточку мира со старта в игровое состояние. */
export function fromWorldCard(world) {
  const state = emptyState();
  const character = world.character || {};
  const location = world.location || {};
  const stats = world.stats || {};

  state.world_title = world.world_title || '';
  state.genre = world.genre || '';
  state.backstory = world.backstory || '';
  state.world_rules = [...(world.world_rules || [])];

  state.character_name = character.name || '';
  state.character_background = character.background || '';
  state.character_traits = [...(character.traits || [])];
  state.character_goal = character.goal || '';

  state.stats = {
    health: Number(stats.health ?? MAX_HEALTH),
    max_health: Number(stats.max_health ?? MAX_HEALTH),
    fatigue: Number(stats.fatigue ?? 0),
  };
  state.location = {
    name: location.name || '',
    description: location.description || '',
  };
  state.inventory = (world.inventory || []).map((item) => ({
    name: item.name || '',
    description: item.description || '',
  }));
  state.suggested_actions = [...(world.suggested_actions || [])];

  // Первая сцена — нулевой ход: игрок ещё ничего не делал.
  state.history.push({
    number: 0,
    player: '',
    narrative: world.opening_scene || '',
    local: false,
  });
  state.chronicle.push(
    `Начало: ${state.character_name} в месте «${state.location.name}». ` +
      `Цель: ${state.character_goal}`
  );
  return state;
}

/**
 * Восстановление из сейва.
 *
 * Незнакомые поля отбрасываются, недостающие остаются на умолчаниях: файл,
 * записанный другой версией игры, не должен ронять загрузку.
 */
export function fromSaved(data) {
  const state = emptyState();
  if (!data || typeof data !== 'object') return state;

  for (const key of Object.keys(state)) {
    if (!(key in data)) continue;
    const value = data[key];
    const fallback = state[key];
    if (Array.isArray(fallback)) {
      if (Array.isArray(value)) state[key] = value;
    } else if (fallback !== null && typeof fallback === 'object') {
      if (value && typeof value === 'object') state[key] = { ...fallback, ...value };
    } else if (typeof value === typeof fallback) {
      state[key] = value;
    }
  }

  // Поля, появившиеся позже нулевой версии, могли не сохраниться.
  state.history = state.history.map((turn) => ({
    number: turn.number ?? 0,
    player: turn.player ?? '',
    narrative: turn.narrative ?? '',
    local: Boolean(turn.local),
  }));
  return state;
}
