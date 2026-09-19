/**
 * Сохранения в браузере игрока.
 *
 * Состояние — обычный объект, поэтому сейв это просто его JSON вместе с
 * текущим боем, если он идёт.
 *
 * Хранилище — localStorage, а не куки: в куки влезает 4 КБ, а партия с
 * хроникой и историей ходов весит десятки килобайт. Куки к тому же уходят
 * в каждый запрос, что здесь совсем ни к чему.
 */

import { STATE_VERSION, fromSaved, turnNumber, day } from './state.js';

export const AUTO_SLOT = 'auto';
export const MANUAL_SLOTS = ['1', '2', '3', '4', '5'];
export const ALL_SLOTS = [AUTO_SLOT, ...MANUAL_SLOTS];

const PREFIX = 'rpg.save.';

export class SaveError extends Error {
  constructor(message) {
    super(message);
    this.userMessage = message;
  }
}

function keyFor(slot) {
  if (!ALL_SLOTS.includes(slot)) throw new SaveError('Неизвестный слот сохранения.');
  return PREFIX + slot;
}

function read(slot) {
  try {
    const raw = localStorage.getItem(keyFor(slot));
    return raw ? JSON.parse(raw) : null;
  } catch (err) {
    if (err instanceof SaveError) throw err;
    return { broken: true };
  }
}

// ------------------------------------------------------------- запись

export function saveGame(state, slot, combat = null) {
  const payload = {
    version: STATE_VERSION,
    saved_at: new Date().toISOString().slice(0, 19),
    title: state.world_title,
    character: state.character_name,
    turn: turnNumber(state),
    day: day(state),
    health: state.stats.health,
    game_over: state.game_over,
    in_combat: Boolean(combat && !combat.finished),
    state,
    combat: combat && !combat.finished ? combat : null,
  };
  try {
    localStorage.setItem(keyFor(slot), JSON.stringify(payload));
  } catch (err) {
    if (err instanceof SaveError) throw err;
    // Место в браузере кончилось — обычно из-за десятка длинных партий.
    throw new SaveError(
      'Браузер не дал сохранить: закончилось место. Удали лишние сохранения.'
    );
  }
  return meta(slot, payload);
}

/**
 * Пишется после каждого хода — но НЕ после смертельного.
 *
 * Иначе «продолжить» возвращало бы игрока ровно в момент гибели. Так в слоте
 * остаётся состояние на начало рокового хода, и у партии есть второй шанс.
 */
export function autosave(state, combat = null) {
  if (state.game_over) return;
  try {
    saveGame(state, AUTO_SLOT, combat);
  } catch (err) {
    // Автосейв — удобство, а не причина прерывать игру.
  }
}

// ------------------------------------------------------------- чтение

export function loadGame(slot) {
  const payload = read(slot);
  if (!payload) throw new SaveError('Этого сохранения больше нет.');
  if (payload.broken) throw new SaveError('Сохранение повреждено.');
  const state = fromSaved(payload.state);
  // Бой, который успел закончиться, восстанавливать незачем.
  const combat = payload.combat && !payload.combat.finished ? payload.combat : null;
  return { state, combat };
}

// ------------------------------------------------------------ список

function meta(slot, payload) {
  return {
    slot,
    auto: slot === AUTO_SLOT,
    exists: true,
    version: payload.version,
    saved_at: payload.saved_at || '',
    title: payload.title || '',
    character: payload.character || '',
    turn: payload.turn || 0,
    day: payload.day || 1,
    health: payload.health || 0,
    game_over: Boolean(payload.game_over),
    in_combat: Boolean(payload.in_combat),
    outdated: payload.version !== STATE_VERSION,
  };
}

export function slotMeta(slot) {
  const payload = read(slot);
  if (!payload) return { slot, auto: slot === AUTO_SLOT, exists: false };
  if (payload.broken) {
    return { slot, auto: slot === AUTO_SLOT, exists: true, broken: true, title: 'повреждено' };
  }
  return meta(slot, payload);
}

export function listSaves() {
  return ALL_SLOTS.map(slotMeta);
}

export function hasAnySave() {
  return listSaves().some((entry) => entry.exists);
}

export function deleteSave(slot) {
  try {
    localStorage.removeItem(keyFor(slot));
  } catch (err) {
    if (err instanceof SaveError) throw err;
    throw new SaveError('Не удалось удалить сохранение.');
  }
}

/** Выгрузка партии в файл: браузер можно почистить, а игру хочется сберечь. */
export function exportSave(slot) {
  const payload = read(slot);
  if (!payload || payload.broken) throw new SaveError('Нечего выгружать.');
  return JSON.stringify(payload, null, 1);
}

/** Загрузка партии из файла обратно в слот. */
export function importSave(slot, text) {
  let payload;
  try {
    payload = JSON.parse(text);
  } catch (err) {
    throw new SaveError('Это не файл сохранения.');
  }
  if (!payload || typeof payload !== 'object' || !payload.state) {
    throw new SaveError('В файле нет сохранённой игры.');
  }
  try {
    localStorage.setItem(keyFor(slot), JSON.stringify(payload));
  } catch (err) {
    if (err instanceof SaveError) throw err;
    throw new SaveError('Браузер не дал сохранить: закончилось место.');
  }
  return slotMeta(slot);
}
