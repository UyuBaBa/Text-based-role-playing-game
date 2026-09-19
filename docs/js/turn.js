/**
 * Ход игрока: сборка контекста, один запрос, применение изменений.
 *
 * Окно контекста:
 *     правила ведущего + карточка мира + хроника + текущее состояние
 *     + персонажи рядом + ограничения по состоянию
 *     + последние N ходов дословно + действие игрока
 * Вся история целиком не отправляется никогда.
 */

import { generateJson } from './api.js';
import { GM_PROMPT } from './prompts.js';
import { npcBlock } from './npc.js';
import { applyBlockedTurn, applyTurn, blockAction, stateDirectives } from './rules.js';
import { day, elapsedText, turnNumber } from './state.js';

// Сколько последних ходов уходит в промпт дословно.
const HISTORY_WINDOW = 6;

// Порог, после которого хронику сжимаем одним отдельным запросом.
const CHRONICLE_CHAR_LIMIT = 6000;
const CHRONICLE_KEEP_RECENT = 8;

export const TURN_SCHEMA = {
  type: 'object',
  properties: {
    narrative: { type: 'string' },
    state_delta: {
      type: 'object',
      properties: {
        health: { type: 'integer' },
        fatigue: { type: 'integer' },
        time_advance_min: { type: 'integer' },
      },
      required: ['health', 'fatigue', 'time_advance_min'],
    },
    time_of_day: { type: 'string', enum: ['утро', 'день', 'вечер', 'ночь'] },
    rest: {
      type: 'string',
      enum: ['нет', 'отдых', 'еда', 'сон'],
      description: 'Отдыхал ли персонаж в этом ходе. Сколько сил вернулось — считает игра.',
    },
    inventory_changes: {
      type: 'object',
      properties: {
        add: {
          type: 'array',
          items: {
            type: 'object',
            properties: { name: { type: 'string' }, description: { type: 'string' } },
            required: ['name', 'description'],
          },
        },
        remove: { type: 'array', items: { type: 'string' } },
      },
      required: ['add', 'remove'],
    },
    location_change: {
      type: 'object',
      properties: {
        changed: { type: 'boolean' },
        name: { type: 'string' },
        description: { type: 'string' },
      },
      required: ['changed', 'name', 'description'],
    },
    npcs: {
      type: 'array',
      description: 'Персонажи, которые участвовали в ходе или чьё отношение изменилось.',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          role: { type: 'string' },
          description: { type: 'string' },
          sympathy_delta: { type: 'integer' },
          present: { type: 'boolean' },
          important: { type: 'boolean' },
        },
        required: ['name', 'role', 'description', 'sympathy_delta', 'present', 'important'],
      },
    },
    combat_trigger: {
      type: 'object',
      description: 'Началась ли прямая драка. Сам бой считает игра, не ты.',
      properties: {
        starts: { type: 'boolean' },
        enemy_name: { type: 'string' },
        reason: { type: 'string' },
      },
      required: ['starts', 'enemy_name', 'reason'],
    },
    memory_update: { type: 'string' },
    suggested_actions: { type: 'array', items: { type: 'string' } },
  },
  required: [
    'narrative', 'state_delta', 'time_of_day', 'rest', 'inventory_changes',
    'location_change', 'npcs', 'combat_trigger', 'memory_update', 'suggested_actions',
  ],
};

export const COMBAT_SCHEMA = {
  type: 'object',
  properties: {
    enemy: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        description: { type: 'string', description: 'одна строка примет' },
        hp: {
          type: 'integer',
          description:
            '15-140. У игрока 100. Задира или подросток 30-50, обычный вооружённый ' +
            'человек 60-85, опытный боец 90-110, зверь или чудовище 110-140',
        },
        attack: {
          type: 'integer',
          description:
            '2-18. Кулаки 4-5, нож или дубина 7-9, меч или револьвер 10-12, ' +
            'опытный убийца 13-15, чудовище 16-18',
        },
        defense: {
          type: 'integer',
          description: '0-9. Без брони 1-2, кожа или толстая одежда 3-4, доспех 5-7, шкура зверя 6-9',
        },
      },
      required: ['name', 'description', 'hp', 'attack', 'defense'],
    },
    player_weapon: {
      type: 'object',
      description: 'Лучшее, чем игрок может драться прямо сейчас — из его инвентаря.',
      properties: {
        name: { type: 'string', description: 'название предмета или «кулаки»' },
        attack_bonus: { type: 'integer', description: '0-7' },
      },
      required: ['name', 'attack_bonus'],
    },
    player_armor_bonus: {
      type: 'integer',
      description: '0-5, по одежде и снаряжению игрока',
    },
    usable_items: {
      type: 'array',
      description: 'Предметы ИЗ ИНВЕНТАРЯ игрока, которые лечат в бою. Обычно пусто.',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          heal: { type: 'integer', description: '5-35' },
        },
        required: ['name', 'heal'],
      },
    },
    opening: { type: 'string', description: '1-2 абзаца: как началась драка' },
    lines: {
      type: 'object',
      description: 'Реплики врага на разные случаи, по 2-3 в каждом списке.',
      properties: {
        confident: { type: 'array', items: { type: 'string' } },
        hurt: { type: 'array', items: { type: 'string' } },
        dying: { type: 'array', items: { type: 'string' } },
        winning: { type: 'array', items: { type: 'string' } },
      },
      required: ['confident', 'hurt', 'dying', 'winning'],
    },
  },
  required: ['enemy', 'player_weapon', 'player_armor_bonus', 'usable_items', 'opening', 'lines'],
};

const COMPACT_SCHEMA = {
  type: 'object',
  properties: { chronicle: { type: 'array', items: { type: 'string' } } },
  required: ['chronicle'],
};

// ------------------------------------------------------------------ контекст

export function worldBlock(state) {
  const rules = state.world_rules.map((rule) => `- ${rule}`).join('\n');
  const traits = state.character_traits.join(', ') || '—';
  return (
    `МИР: ${state.world_title} (${state.genre})\n${state.backstory}\n\n` +
    `ЗАКОНЫ МИРА:\n${rules}\n\n` +
    `ПЕРСОНАЖ ИГРОКА: ${state.character_name}\n${state.character_background}\n` +
    `Черты: ${traits}\nЦель: ${state.character_goal}`
  );
}

export function stateBlock(state) {
  const inventory =
    state.inventory
      .map((item) => `- ${item.name}${item.description ? ` (${item.description})` : ''}`)
      .join('\n') || '- пусто';
  return (
    'ТЕКУЩЕЕ СОСТОЯНИЕ (это правда, не пересчитывай её сам):\n' +
    `Здоровье: ${state.stats.health} из ${state.stats.max_health}\n` +
    `Усталость: ${state.stats.fatigue} из 100\n` +
    `Место: ${state.location.name} — ${state.location.description}\n` +
    `День ${day(state)}, ${state.time_of_day}. С начала истории прошло ${elapsedText(state)}.\n` +
    `Ход номер: ${turnNumber(state) + 1}\n` +
    `ИНВЕНТАРЬ:\n${inventory}`
  );
}

export function chronicleBlock(state) {
  if (!state.chronicle.length) return '';
  const entries = state.chronicle.map((entry) => `- ${entry}`).join('\n');
  return `ХРОНИКА СОБЫТИЙ (что уже случилось):\n${entries}`;
}

export function historyBlock(state) {
  const recent = state.history.slice(-HISTORY_WINDOW);
  if (!recent.length) return '';
  const parts = ['ПОСЛЕДНИЕ ХОДЫ (дословно):'];
  for (const turn of recent) {
    if (turn.player) parts.push(`Игрок: ${turn.player}`);
    parts.push(`Ты: ${turn.narrative}`);
  }
  return parts.join('\n\n');
}

/** Состояние персонажа, переведённое в прямые указания ведущему. */
export function directivesBlock(state) {
  const directives = stateDirectives(state);
  if (!directives.length) return '';
  return (
    'ОБЯЗАТЕЛЬНЫЕ ОГРАНИЧЕНИЯ ЭТОЙ СЦЕНЫ (важнее желаний игрока):\n' +
    directives.map((directive) => `- ${directive}`).join('\n')
  );
}

/**
 * eventNote — событие, которое уже случилось помимо действия игрока
 * (например, итог боя). Тогда ведущий описывает последствия, а не попытку.
 */
export function buildUserText(state, playerText, eventNote = '') {
  const action = playerText.trim() ? `ДЕЙСТВИЕ ИГРОКА:\n${playerText.trim()}` : '';
  return [
    worldBlock(state),
    chronicleBlock(state),
    stateBlock(state),
    npcBlock(state),
    directivesBlock(state),
    historyBlock(state),
    eventNote,
    action,
    'Опиши, что из этого вышло, и верни JSON по схеме.',
  ]
    .filter(Boolean)
    .join('\n\n---\n\n');
}

// ---------------------------------------------------------------------- ход

/**
 * Один запрос к модели — один ход. Состояние меняется только здесь.
 *
 * Заведомо невозможное действие отсекается до запроса: это и честнее,
 * и не тратит обращение к API.
 */
export async function playTurn(model, state, playerText, eventNote = '') {
  const refusal = blockAction(state, playerText);
  if (refusal) return { changes: applyBlockedTurn(state, playerText, refusal), combat: null };

  const response = await generateJson({
    model,
    schema: TURN_SCHEMA,
    userText: buildUserText(state, playerText, eventNote),
    systemInstruction: GM_PROMPT,
    purpose: 'turn',
    temperature: 0.95,
    maxOutputTokens: 3000,
  });

  const changes = applyTurn(state, playerText, response);
  const trigger = combatRequest(state, response);
  await maybeCompactChronicle(model, state);
  return { changes, combat: trigger };
}

/**
 * Разбирает заявку модели на драку. Сам бой начинается отдельным вызовом:
 * в обычном ходе незачем таскать целый лист врага.
 */
export function combatRequest(state, response) {
  const trigger = response.combat_trigger || {};
  if (!trigger.starts || state.game_over) return null;
  return {
    enemy_name: String(trigger.enemy_name || '').trim(),
    reason: String(trigger.reason || '').trim(),
  };
}

/**
 * Один запрос на всю завязку боя: лист врага, оценка оружия игрока и запас
 * реплик. Дальше раунды считаются локально.
 */
export async function requestCombatSheet(model, state, enemyName, reason) {
  const inventory =
    state.inventory
      .map((item) => `- ${item.name}${item.description ? ` (${item.description})` : ''}`)
      .join('\n') || '- пусто';

  const userText = [
    worldBlock(state),
    stateBlock(state),
    npcBlock(state),
    historyBlock(state),
    `НАЧАЛАСЬ ДРАКА.\nПротивник: ${enemyName || 'неизвестный'}\n` +
      `Причина: ${reason || 'прямое столкновение'}\n\n` +
      `ИНВЕНТАРЬ ИГРОКА (оружие и лечебное выбирай только отсюда):\n${inventory}\n\n` +
      'Составь лист противника и запас его реплик. Реплики пиши от его лица, ' +
      'прямой речью, коротко — по 2-3 на каждое состояние:\n' +
      'confident — он уверен в победе; hurt — заметно ранен; ' +
      'dying — при смерти; winning — игрок почти повержен.\n' +
      'Силу противника подбирай по сюжету, а не по жалости к игроку.',
  ]
    .filter(Boolean)
    .join('\n\n---\n\n');

  return generateJson({
    model,
    schema: COMBAT_SCHEMA,
    userText,
    systemInstruction: GM_PROMPT,
    purpose: 'combat-start',
    temperature: 0.9,
    maxOutputTokens: 2500,
  });
}

/**
 * Хроника растёт вместе с игрой. Когда она становится дороже, чем стоит,
 * один отдельный запрос ужимает старую часть. Случается редко — примерно
 * раз в несколько десятков ходов.
 */
export async function maybeCompactChronicle(model, state) {
  const total = state.chronicle.reduce((sum, entry) => sum + entry.length, 0);
  if (total < CHRONICLE_CHAR_LIMIT || state.chronicle.length <= CHRONICLE_KEEP_RECENT) {
    return false;
  }

  const old = state.chronicle.slice(0, -CHRONICLE_KEEP_RECENT);
  const recent = state.chronicle.slice(-CHRONICLE_KEEP_RECENT);
  const entries = old.map((entry) => `- ${entry}`).join('\n');

  let response;
  try {
    response = await generateJson({
      model,
      schema: COMPACT_SCHEMA,
      userText:
        'Ниже хроника текстовой игры. Сожми её в 10-15 пунктов, сохранив всё, ' +
        'что может понадобиться дальше: имена, места, обещания, долги, угрозы, ' +
        'найденные предметы, изменения в мире. Убери повторы и мелочи. ' +
        'Пиши по-русски, каждый пункт — одно предложение.\n\n' + entries,
      systemInstruction: 'Ты ведёшь краткие записи по сюжету. Только факты.',
      purpose: 'chronicle-compact',
      temperature: 0.3,
      maxOutputTokens: 2000,
    });
  } catch (err) {
    // Сжатие — удобство, а не необходимость: если не вышло, играем дальше.
    return false;
  }

  const compacted = (response.chronicle || [])
    .map((item) => String(item).trim())
    .filter(Boolean);
  if (!compacted.length) return false;

  state.chronicle = compacted.concat(recent);
  return true;
}
