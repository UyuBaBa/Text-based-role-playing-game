/**
 * Генерация стартовой карточки мира.
 *
 * Один запрос к модели на всю завязку: предыстория, персонаж, локация,
 * инвентарь, стартовые показатели и первая сцена.
 */

import { generateJson } from './api.js';
import { WORLDGEN_PROMPT } from './prompts.js';

const HEALTH_RANGE = [40, 100];
const FATIGUE_RANGE = [0, 60];

export const WORLD_SCHEMA = {
  type: 'object',
  properties: {
    world_title: { type: 'string' },
    genre: { type: 'string' },
    backstory: { type: 'string' },
    world_rules: {
      type: 'array',
      items: { type: 'string' },
      description: '3-5 законов мира: чем он опасен, что в нём возможно',
    },
    character: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        background: { type: 'string' },
        traits: { type: 'array', items: { type: 'string' } },
        goal: { type: 'string' },
      },
      required: ['name', 'background', 'traits', 'goal'],
    },
    location: {
      type: 'object',
      properties: { name: { type: 'string' }, description: { type: 'string' } },
      required: ['name', 'description'],
    },
    inventory: {
      type: 'array',
      items: {
        type: 'object',
        properties: { name: { type: 'string' }, description: { type: 'string' } },
        required: ['name', 'description'],
      },
    },
    stats: {
      type: 'object',
      properties: { health: { type: 'integer' }, fatigue: { type: 'integer' } },
      required: ['health', 'fatigue'],
    },
    opening_scene: { type: 'string' },
    suggested_actions: { type: 'array', items: { type: 'string' } },
  },
  required: [
    'world_title', 'genre', 'backstory', 'world_rules', 'character',
    'location', 'inventory', 'stats', 'opening_scene', 'suggested_actions',
  ],
};

function clamp(value, [low, high], fallback) {
  const number = Number.parseInt(value, 10);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(low, Math.min(high, number));
}

function cleanList(raw, limit) {
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => String(item).trim()).filter(Boolean).slice(0, limit);
}

export function buildUserText(worldDesc, characterDesc) {
  const world =
    worldDesc.trim() || 'Игрок не описал мир — придумай его сам, что-нибудь необычное.';
  const character =
    characterDesc.trim() || 'Игрок не описал персонажа — придумай его сам, под этот мир.';
  return (
    `ОПИСАНИЕ МИРА ОТ ИГРОКА:\n${world}\n\n` +
    `ОПИСАНИЕ ПЕРСОНАЖА ОТ ИГРОКА:\n${character}\n\n` +
    'Создай стартовый набор по правилам выше.'
  );
}

/**
 * Приводим ответ модели к предсказуемому виду: числа в границы, списки —
 * к нужной длине. Доверять модели на слово нельзя даже при строгой схеме.
 */
export function sanitize(data) {
  const character = data.character || {};
  const location = data.location || {};
  const stats = data.stats || {};

  const inventory = [];
  for (const item of (data.inventory || []).slice(0, 8)) {
    if (!item || typeof item !== 'object') continue;
    const name = String(item.name || '').trim();
    if (name) inventory.push({ name, description: String(item.description || '').trim() });
  }

  return {
    world_title: String(data.world_title || '').trim() || 'Безымянный мир',
    genre: String(data.genre || '').trim(),
    backstory: String(data.backstory || '').trim(),
    world_rules: cleanList(data.world_rules, 6),
    character: {
      name: String(character.name || '').trim() || 'Безымянный',
      background: String(character.background || '').trim(),
      traits: cleanList(character.traits, 5),
      goal: String(character.goal || '').trim(),
    },
    location: {
      name: String(location.name || '').trim() || 'Неизвестное место',
      description: String(location.description || '').trim(),
    },
    inventory,
    stats: {
      health: clamp(stats.health, HEALTH_RANGE, 100),
      max_health: 100,
      fatigue: clamp(stats.fatigue, FATIGUE_RANGE, 10),
    },
    opening_scene: String(data.opening_scene || '').trim(),
    suggested_actions: cleanList(data.suggested_actions, 3),
  };
}

/** Один запрос — вся завязка игры. */
export async function generateWorld(model, worldDesc, characterDesc) {
  const data = await generateJson({
    model,
    schema: WORLD_SCHEMA,
    userText: buildUserText(worldDesc, characterDesc),
    systemInstruction: WORLDGEN_PROMPT,
    purpose: 'worldgen',
    temperature: 1.0,
    maxOutputTokens: 6000,
  });
  return sanitize(data);
}
