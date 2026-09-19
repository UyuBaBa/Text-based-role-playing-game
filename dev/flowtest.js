/**
 * Проверка всего пути игры с подставными ответами модели.
 *
 * Запуск:  node dev/flowtest.js
 *
 * Настоящий Gemini не дёргается: вместо сети подставлен свой fetch, который
 * отдаёт заранее заготовленные ответы. Так проверяется вся цепочка —
 * разбор ответа, применение к состоянию, вход в бой, раунды, возвращение
 * в повествование и сохранения.
 */

import { generateWorld } from '../docs/js/worldgen.js';
import { fromWorldCard, turnNumber } from '../docs/js/state.js';
import { playTurn, requestCombatSheet } from '../docs/js/turn.js';
import { buildCombat, outcomeNote, resolveRound } from '../docs/js/combat.js';
import { usage } from '../docs/js/api.js';
import * as saves from '../docs/js/saves.js';

let failures = 0;
function check(name, condition, details = '') {
  if (!condition) failures += 1;
  console.log(`  [${condition ? 'OK  ' : 'СБОЙ'}] ${name}${details ? ' — ' + details : ''}`);
}

// --------------------------------------------------- подставное хранилище

const store = new Map();
// Ключ теперь вводит игрок, поэтому подставляем его и здесь.
store.set('rpg.apiKey', 'тестовый-ключ');
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

// ------------------------------------------------------- подставной Gemini

const queue = [];
let lastRequest = null;

function reply(object) {
  return {
    ok: true,
    json: async () => ({
      candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(object) }] } }],
      usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 200, totalTokenCount: 300 },
    }),
  };
}

globalThis.fetch = async (url, options) => {
  lastRequest = JSON.parse(options.body);
  if (!queue.length) throw new Error('подставных ответов больше нет: ' + url);
  const next = queue.shift();
  if (next instanceof Error) throw next;
  if (next.httpError) {
    return {
      ok: false,
      status: next.httpError,
      json: async () => ({ error: { message: next.message } }),
    };
  }
  return reply(next);
};

const WORLD = {
  world_title: 'Мёртвый порт',
  genre: 'нуар',
  backstory: 'Порт, где корабли уходят и не возвращаются.\n\nВторой абзац.',
  world_rules: ['Ночью на причал не ходят', 'Чужакам не наливают'],
  character: { name: 'Ким', background: 'Бывший водолаз.', traits: ['упрямый'], goal: 'Найти брата' },
  location: { name: 'Причал', description: 'Гнилые доски' },
  inventory: [{ name: 'Нож', description: 'рыбацкий' }, { name: 'Бинты', description: '' }],
  stats: { health: 90, fatigue: 10 },
  opening_scene: 'Ты стоишь на причале.\n\nВода чёрная.',
  suggested_actions: ['Осмотреться', 'Позвать', 'Уйти'],
};

const turnReply = (extra = {}) => ({
  narrative: 'Что-то произошло.\n\nИ ещё кое-что.',
  state_delta: { health: -5, fatigue: 8, time_advance_min: 30 },
  time_of_day: 'вечер',
  rest: 'нет',
  inventory_changes: { add: [{ name: 'Ключ', description: 'ржавый' }], remove: [] },
  location_change: { changed: false, name: '', description: '' },
  npcs: [{ name: 'Марта', role: 'хозяйка', description: 'шрам', sympathy_delta: -10,
           present: true, important: true }],
  combat_trigger: { starts: false, enemy_name: '', reason: '' },
  memory_update: 'Поговорил с Мартой.',
  suggested_actions: ['а', 'б', 'в'],
  ...extra,
});

const COMBAT_SHEET = {
  enemy: { name: 'Бандит', description: 'кривой нос', hp: 60, attack: 9, defense: 3 },
  player_weapon: { name: 'Нож', attack_bonus: 3 },
  player_armor_bonus: 1,
  usable_items: [{ name: 'Бинты', heal: 15 }],
  opening: 'Он бросается первым.',
  lines: { confident: ['Стой!'], hurt: ['Ах ты!'], dying: ['Хватит...'], winning: ['Всё.'] },
};

const MODEL = 'gemini-3.5-flash-lite';

// ------------------------------------------------------------------ путь

console.log('\n=== 1. Генерация мира ===');
queue.push(WORLD);
const card = await generateWorld(MODEL, 'порт', 'водолаз');
check('мир собран', card.world_title === 'Мёртвый порт');
check('статы зажаты', card.stats.health === 90 && card.stats.max_health === 100);
check('в запрос ушёл промпт о мире',
      lastRequest.systemInstruction.parts[0].text.includes('стартовый набор'));
check('схема потребована', Boolean(lastRequest.generationConfig.responseSchema));

const game = fromWorldCard(card);
check('состояние создано', turnNumber(game) === 0 && game.history.length === 1);

console.log('\n=== 2. Обычный ход ===');
queue.push(turnReply());
let result = await playTurn(MODEL, game, 'Иду к воде');
check('ход записан', turnNumber(game) === 1);
check('здоровье применено', game.stats.health === 85, `стало ${game.stats.health}`);
check('усталость с износом', game.stats.fatigue === 18, `стало ${game.stats.fatigue}`);
check('предмет добавлен', game.inventory.some((i) => i.name === 'Ключ'));
check('знакомая записана', game.npcs[0].name === 'Марта' && game.npcs[0].sympathy === -10);
check('хроника пополнилась', game.chronicle.length === 2);
check('боя нет', result.combat === null);

console.log('\n=== 3. Контекст следующего запроса ===');
queue.push(turnReply());
await playTurn(MODEL, game, 'Спрашиваю про брата');
const sent = lastRequest.contents[0].parts[0].text;
check('в промпте карточка мира', sent.includes('Мёртвый порт'));
check('в промпте хроника', sent.includes('Поговорил с Мартой'));
check('в промпте состояние', sent.includes('Здоровье:'));
check('в промпте знакомая с ярлыком', sent.includes('Марта') && sent.includes('Нейтрален'));
check('в промпте прошлые ходы', sent.includes('ПОСЛЕДНИЕ ХОДЫ'));

// Окно — шесть последних ходов. Пока их меньше, уходит всё; добираем и проверяем.
for (let i = 0; i < 6; i += 1) {
  queue.push(turnReply({ narrative: `Проходной ход номер ${i}.` }));
  await playTurn(MODEL, game, `действие ${i}`);
}
const later = lastRequest.contents[0].parts[0].text;
check('старое выпало из окна', !later.includes('Ты стоишь на причале'));
check('свежее осталось', later.includes('Проходной ход номер 4'));
check('но хроника помнит всё', later.includes('Поговорил с Мартой'));

console.log('\n=== 4. Отказ без запроса к API ===');
game.stats.fatigue = 95;
const callsBefore = usage.calls;
await playTurn(MODEL, game, 'бегу со всех ног к складу');
check('запрос не потрачен', usage.calls === callsBefore, `запросов ${usage.calls - callsBefore}`);
check('ответ сочинён кодом', game.history[game.history.length - 1].local === true);
game.stats.fatigue = 20;

console.log('\n=== 5. Драка ===');
queue.push(turnReply({ combat_trigger: { starts: true, enemy_name: 'Бандит', reason: 'полез первым' } }));
result = await playTurn(MODEL, game, 'Толкаю его');
check('модель объявила бой', result.combat?.enemy_name === 'Бандит');

queue.push(COMBAT_SHEET);
const sheet = await requestCombatSheet(MODEL, game, 'Бандит', 'полез первым');
const combat = buildCombat(game, sheet, 'полез первым', 'Бандит');
check('лист врага собран', combat.enemy.hp === 60 && combat.enemy.max_hp === 60);
check('лечебное сверено с инвентарём', combat.usable_items.length === 1);

const beforeRounds = usage.calls;
let rounds = 0;
while (!combat.finished && rounds < 60) {
  resolveRound(game, combat, game.stats.health < 30 ? 'flee' : 'attack', 'Бинты');
  rounds += 1;
}
check('раунды бесплатны', usage.calls === beforeRounds, `${rounds} раундов, 0 запросов`);
check('бой закончился', ['victory', 'defeat', 'fled'].includes(combat.outcome), combat.outcome);

console.log('\n=== 6. Возвращение в повествование ===');
if (!game.game_over) {
  queue.push(turnReply({ narrative: 'Ты переводишь дух.' }));
  await playTurn(MODEL, game, '', outcomeNote(game, combat));
  const last = game.history[game.history.length - 1];
  check('сцена после боя записана', last.narrative.includes('переводишь дух'));
  check('итог боя ушёл в промпт', lastRequest.contents[0].parts[0].text.includes('ИТОГ БОЯ'));
} else {
  check('герой пал — продолжения нет', true, 'бой проигран');
}

console.log('\n=== 7. Сохранения ===');
saves.saveGame(game, '1', null);
const meta = saves.slotMeta('1');
check('слот занят', meta.exists && meta.title === 'Мёртвый порт');
const loaded = saves.loadGame('1');
check('состояние совпало', JSON.stringify(loaded.state) === JSON.stringify(game));
const wasOver = game.game_over;
game.game_over = false;
saves.autosave(game);
check('автосейв записан', saves.slotMeta('auto').exists);
store.delete('rpg.save.auto');
saves.autosave({ ...game, game_over: true });
check('после смерти автосейв не пишется', !saves.slotMeta('auto').exists);
game.game_over = wasOver;
const text = saves.exportSave('1');
saves.deleteSave('1');
check('слот удалён', !saves.slotMeta('1').exists);
saves.importSave('1', text);
check('партия вернулась из файла', saves.slotMeta('1').title === 'Мёртвый порт');

console.log('\n=== 8. Ошибки сети ===');
queue.push({ httpError: 400, message: 'User location is not supported for the API use.' });
try {
  await playTurn(MODEL, game, 'иду вперёд');
  check('гео-блокировка распознана', false, 'ошибки не было');
} catch (err) {
  check('гео-блокировка распознана', err.kind === 'location', err.userMessage.slice(0, 40));
}
const turnsBefore = turnNumber(game);
queue.push({ httpError: 400, message: 'bad key' });
try { await playTurn(MODEL, game, 'иду'); } catch (err) { /* ожидаемо */ }
check('состояние не тронуто неудачным ходом', turnNumber(game) === turnsBefore);

console.log(`\nзапросов к «модели» за весь путь: ${usage.calls}`);
console.log(failures === 0 ? 'ВЕСЬ ПУТЬ ПРОЙДЕН\n' : `ПРОВАЛЕНО: ${failures}\n`);
process.exit(failures === 0 ? 0 : 1);
