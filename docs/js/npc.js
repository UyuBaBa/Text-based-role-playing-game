/**
 * Персонажи вокруг игрока и их отношение к нему.
 *
 * Симпатия — число от -100 до +100, которое живёт в состоянии игры. Модель не
 * держит его в голове: она получает готовое число вместе с инструкцией, как
 * себя вести при таком отношении, и предлагает только изменение за ход.
 *
 * Смысл в том, чтобы отношение было последствием, а не декорацией: тот, кого
 * игрок обманул, будет мешать ему и через двадцать ходов.
 */

import { turnNumber } from './state.js';

export const SYMPATHY_MIN = -100;
export const SYMPATHY_MAX = 100;

// Предел изменения за один ход: доверие не зарабатывается одной репликой.
export const SYMPATHY_DELTA_LIMIT = 25;

// Сколько ходов персонаж остаётся в «активной памяти» после последней встречи.
// Дальше он выпадает из промпта, но остаётся в журнале.
export const ACTIVE_MEMORY_TURNS = 12;

// Сколько персонажей максимум уходит в промпт: иначе контекст раздувается.
export const MAX_ACTIVE_IN_PROMPT = 6;

// Порог, за которым персонаж готов навредить сам. Одно из условий входа в бой.
export const HOSTILE_THRESHOLD = -60;

// Шкала: число -> ярлык для игрока и приказ для модели.
export const SYMPATHY_TIERS = [
  [60, 'Предан', 'помогает без просьб, делится последним, готов рискнуть ради игрока'],
  [20, 'Дружелюбен', 'охотно разговаривает, идёт навстречу, оказывает мелкие услуги'],
  [-19, 'Нейтрален', 'держит дистанцию, говорит по делу, торгуется, своей выгоды не упустит'],
  [-59, 'Неприязнь', 'грубит или холоден, обманывает, набивает цену, помогать не станет'],
  [SYMPATHY_MIN, 'Враждебен', 'активно вредит: лжёт, подставляет, зовёт чужих, может напасть первым'],
];

export function sympathyTier(value) {
  for (const [threshold, label, behavior] of SYMPATHY_TIERS) {
    if (value >= threshold) return { label, behavior };
  }
  const [, label, behavior] = SYMPATHY_TIERS[SYMPATHY_TIERS.length - 1];
  return { label, behavior };
}

export function sympathyLabel(value) {
  return sympathyTier(value).label;
}

function clampDelta(value, limit = SYMPATHY_DELTA_LIMIT) {
  const number = Number.parseInt(value, 10);
  if (!Number.isFinite(number)) return 0;
  return Math.max(-limit, Math.min(limit, number));
}

export function findNpc(state, name) {
  const target = String(name).trim().toLowerCase();
  return state.npcs.find((npc) => npc.name.trim().toLowerCase() === target) || null;
}

/**
 * Сливает список персонажей из ответа модели в состояние.
 * Возвращает изменения симпатии для показа в интерфейсе.
 */
export function applyNpcUpdates(state, payload, turn) {
  // Пометки «в сцене» живут один ход.
  for (const npc of state.npcs) npc.present = false;
  if (!Array.isArray(payload)) return [];

  const changes = [];
  for (const raw of payload.slice(0, 8)) {
    if (!raw || typeof raw !== 'object') continue;
    const name = String(raw.name || '').trim();
    // Безымянные («стражник», «прохожий») в реестр не попадают:
    // иначе он забьётся статистами.
    if (name.length < 2) continue;

    const present = raw.present !== false;
    let npc = findNpc(state, name);

    // У новичка это не изменение, а стартовое отношение: персонаж может
    // появиться уже врагом. Предел ±25 сдерживает только дальнейшие сдвиги.
    const limit = npc === null ? SYMPATHY_MAX : SYMPATHY_DELTA_LIMIT;
    const delta = clampDelta(raw.sympathy_delta, limit);

    if (npc === null) {
      npc = {
        name,
        role: String(raw.role || '').trim(),
        description: String(raw.description || '').trim(),
        sympathy: delta,
        first_seen_turn: turn,
        last_seen_turn: turn,
        scenes: 1,
        important: Boolean(raw.important),
        present,
      };
      state.npcs.push(npc);
      changes.push({ name: npc.name, delta, sympathy: npc.sympathy, fresh: true });
      continue;
    }

    const before = npc.sympathy;
    npc.sympathy = Math.max(SYMPATHY_MIN, Math.min(SYMPATHY_MAX, before + delta));
    npc.present = present;
    if (present && npc.last_seen_turn !== turn) npc.scenes += 1;
    if (present) npc.last_seen_turn = turn;
    // Роль и описание уточняем, но не затираем пустотой.
    if (!npc.role) npc.role = String(raw.role || '').trim();
    if (!npc.description) npc.description = String(raw.description || '').trim();
    if (raw.important) npc.important = true;
    if (npc.sympathy !== before) {
      changes.push({
        name: npc.name,
        delta: npc.sympathy - before,
        sympathy: npc.sympathy,
        fresh: false,
      });
    }
  }
  return changes;
}

export function presentNpcs(state) {
  return state.npcs.filter((npc) => npc.present);
}

/**
 * Кто уходит в промпт: те, кто в сцене, и те, кого встречали недавно.
 * Давние знакомые молча выпадают из контекста — это и есть затухание.
 * Из журнала они при этом никуда не деваются.
 */
export function activeNpcs(state) {
  const current = turnNumber(state);
  const recent = state.npcs.filter(
    (npc) => npc.present || current - npc.last_seen_turn <= ACTIVE_MEMORY_TURNS
  );
  recent.sort((a, b) => {
    if (a.present !== b.present) return a.present ? -1 : 1;
    return b.last_seen_turn - a.last_seen_turn;
  });
  return recent.slice(0, MAX_ACTIVE_IN_PROMPT);
}

/**
 * Только значимые: встреченные не в одной сцене либо помеченные моделью
 * как важные. Случайный прохожий в журнал не попадёт.
 */
export function journalNpcs(state) {
  return state.npcs
    .filter((npc) => npc.scenes >= 2 || npc.important)
    .sort((a, b) => b.last_seen_turn - a.last_seen_turn);
}

/** Блок для промпта: кто рядом, как относится и что из этого следует. */
export function npcBlock(state) {
  const active = activeNpcs(state);
  if (!active.length) return '';

  const lines = active.map((npc) => {
    const { label, behavior } = sympathyTier(npc.sympathy);
    const where = npc.present ? 'СЕЙЧАС В СЦЕНЕ' : `последний раз: ход ${npc.last_seen_turn}`;
    const role = npc.role ? `, ${npc.role}` : '';
    const sign = npc.sympathy > 0 ? '+' : '';
    return `- ${npc.name}${role} (${where}). Симпатия ${sign}${npc.sympathy} — ${label}: ${behavior}.`;
  });

  return (
    'ПЕРСОНАЖИ И ИХ ОТНОШЕНИЕ К ИГРОКУ (симпатия от -100 до +100):\n' +
    lines.join('\n') +
    '\n\nВеди их ровно так, как предписывает их отношение, даже если игроку это ' +
    'невыгодно. Симпатия меняется от поступков игрока, а не от вежливых слов.'
  );
}
