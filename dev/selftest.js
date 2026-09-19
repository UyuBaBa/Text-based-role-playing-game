/**
 * Проверка перенесённой логики. Запуск:  node dev/selftest.js
 *
 * Сверяет то же, что проверялось у версии на Python: клампы, отдых, пороги,
 * симпатию, баланс боя и сохранения. Игре не нужен — только разработке.
 */

import { fromWorldCard, fromSaved, turnNumber, elapsedText } from '../docs/js/state.js';
import * as rules from '../docs/js/rules.js';
import * as npcMod from '../docs/js/npc.js';
import * as combatMod from '../docs/js/combat.js';

let failures = 0;
function check(name, condition, details = '') {
  const mark = condition ? 'OK  ' : 'СБОЙ';
  if (!condition) failures += 1;
  console.log(`  [${mark}] ${name}${details ? ' — ' + details : ''}`);
}

const CARD = {
  world_title: 'Гнилая топь',
  genre: 'тёмное фэнтези',
  backstory: 'Болота, куда уходят и не возвращаются.',
  world_rules: ['Ночью нельзя спать без огня'],
  character: { name: 'Ольга', background: 'Охотница.', traits: ['упрямая'], goal: 'Дойти' },
  location: { name: 'Тропа', description: 'Гати' },
  inventory: [{ name: 'Фонарь', description: 'сухой' }, { name: 'Бинты', description: '' }],
  stats: { health: 100, max_health: 100, fatigue: 0 },
  opening_scene: 'Ты идёшь по гати.',
  suggested_actions: ['идти дальше'],
};

const fresh = () => fromWorldCard(CARD);

const turnResponse = (extra = {}) => ({
  narrative: 'Текст хода.',
  state_delta: { health: 0, fatigue: 5, time_advance_min: 30 },
  time_of_day: 'день',
  rest: 'нет',
  inventory_changes: { add: [], remove: [] },
  location_change: { changed: false, name: '', description: '' },
  npcs: [],
  memory_update: 'Что-то случилось.',
  suggested_actions: ['а', 'б', 'в'],
  ...extra,
});

console.log('\n=== 1. Состояние из карточки мира ===');
{
  const s = fresh();
  check('мир перенесён', s.world_title === 'Гнилая топь');
  check('нулевой ход — первая сцена', s.history.length === 1 && turnNumber(s) === 0);
  check('хроника начата', s.chronicle.length === 1);
  check('инвентарь на месте', s.inventory.length === 2);
}

console.log('\n=== 2. Клампы дельт ===');
{
  const s = fresh();
  rules.applyStateDelta(s, { health: -100, fatigue: 500, time_advance_min: 99999 });
  check('здоровье не ниже предела', s.stats.health === 65, `стало ${s.stats.health}`);
  check('усталость зажата', s.stats.fatigue === 46, `стало ${s.stats.fatigue}`);
  const before = { ...s.stats };
  const ch = rules.applyStateDelta(s, { health: 'много', fatigue: null, time_advance_min: 'полчаса' });
  check('мусор вместо чисел = ноль', ch.health === 0 && ch.fatigue === 0 && ch.minutes === 0);
  check('состояние не тронуто', s.stats.health === before.health);
}

console.log('\n=== 3. Износ от времени ===');
{
  const s = fresh();
  rules.applyStateDelta(s, { health: 0, fatigue: 5, time_advance_min: 180 });
  check('усилие + износ', s.stats.fatigue === 9, `5 + 180/45 = ${s.stats.fatigue}`);
  check('время идёт', elapsedText(s) === '3 ч', elapsedText(s));
}

console.log('\n=== 4. Отдых считает код ===');
{
  const s = fresh();
  s.stats.fatigue = 80;
  rules.applyStateDelta(s, { health: 0, fatigue: -40, time_advance_min: 0 }, 'нет');
  check('без отдыха «лечение» зажато', s.stats.fatigue === 70, `стало ${s.stats.fatigue}`);

  for (const [kind, minutes, expected] of [['отдых', 60, 65], ['еда', 10, 72], ['сон', 480, 0]]) {
    const t = fresh();
    t.stats.fatigue = 80;
    t.stats.health = 70;
    rules.applyStateDelta(t, { health: 0, fatigue: 20, time_advance_min: minutes }, kind);
    check(`${kind}: усталость 80 -> ${t.stats.fatigue}`, t.stats.fatigue === expected);
  }
  const sleeper = fresh();
  sleeper.stats.health = 70;
  rules.applyStateDelta(sleeper, { health: 0, fatigue: 0, time_advance_min: 480 }, 'сон');
  check('сон лечит раны', sleeper.stats.health === 78, `здоровье ${sleeper.stats.health}`);
}

console.log('\n=== 5. Пороговые директивы ===');
{
  const cases = [[100, 30, 0], [100, 50, 1], [100, 70, 1], [100, 90, 1], [40, 10, 1], [15, 10, 1]];
  for (const [health, fatigue, count] of cases) {
    const s = fresh();
    s.stats.health = health;
    s.stats.fatigue = fatigue;
    const d = rules.stateDirectives(s);
    check(`здоровье ${health}, усталость ${fatigue} -> ${d.length} указаний`, d.length === count);
  }
}

console.log('\n=== 6. Локальный отказ без запроса ===');
{
  const cases = [
    [95, 100, 'бегу через весь лес', true],
    [95, 100, 'сажусь отдохнуть у костра', false],
    [95, 100, 'тихо спрашиваю, кто здесь', false],
    [50, 100, 'бегу через весь лес', false],
    [10, 8, 'бью его ножом', true],
  ];
  for (const [fatigue, health, text, expected] of cases) {
    const s = fresh();
    s.stats.fatigue = fatigue;
    s.stats.health = health;
    const blocked = rules.blockAction(s, text) !== null;
    check(`«${text}» -> ${blocked ? 'отказ' : 'пропуск'}`, blocked === expected);
  }
  const s = fresh();
  s.stats.fatigue = 95;
  rules.applyBlockedTurn(s, 'бегу прочь', rules.blockAction(s, 'бегу прочь'));
  check('отказ оформлен ходом', turnNumber(s) === 1 && s.history[1].local === true);
  check('подсказки про отдых', s.suggested_actions.length === 3);
}

console.log('\n=== 7. Инвентарь ===');
{
  const s = fresh();
  const res = rules.applyInventoryChanges(s, {
    add: [{ name: 'Фонарь', description: 'дубль' }, { name: 'Верёвка' }, { name: '  ' }],
    remove: ['фонарь'],
  });
  const names = s.inventory.map((i) => i.name);
  check('дубль не добавлен, удаление победило', !names.includes('Фонарь'), names.join(', '));
  check('новое добавлено', names.includes('Верёвка'));
  check('отчёт верен', res.removed.includes('Фонарь') && res.added.includes('Верёвка'));
}

console.log('\n=== 8. Симпатия ===');
{
  for (const [value, label] of [[100, 'Предан'], [59, 'Дружелюбен'], [0, 'Нейтрален'],
                                [-20, 'Неприязнь'], [-60, 'Враждебен']]) {
    check(`${value} -> ${label}`, npcMod.sympathyLabel(value) === label);
  }

  const s = fresh();
  const npc = (name, d, extra = {}) => ({ name, role: '', description: '', sympathy_delta: d,
                                          present: true, important: false, ...extra });
  rules.applyTurn(s, 'х', turnResponse({ npcs: [npc('Ирма', 5, { important: true }), npc('', 3)] }));
  check('безымянный отсеян', s.npcs.length === 1);
  rules.applyTurn(s, 'х', turnResponse({ npcs: [npc('ирма', 20)] }));
  const irma = npcMod.findNpc(s, 'Ирма');
  check('регистр имени не важен', irma.sympathy === 25 && irma.scenes === 2);
  rules.applyTurn(s, 'х', turnResponse({ npcs: [npc('Ирма', 90)] }));
  check('шаг зажат до ±25', irma.sympathy === 50, `стало ${irma.sympathy}`);

  const enemy = fresh();
  rules.applyTurn(enemy, 'х', turnResponse({ npcs: [npc('Старый враг', -80)] }));
  check('новичок может быть сразу врагом',
        npcMod.findNpc(enemy, 'Старый враг').sympathy === -80);
  check('блок для промпта содержит ярлык', npcMod.npcBlock(enemy).includes('Враждебен'));

  rules.applyTurn(s, 'х', turnResponse({ npcs: [npc('Прохожий', 1)] }));
  const journal = npcMod.journalNpcs(s).map((n) => n.name);
  check('в журнал только значимые', journal.includes('Ирма') && !journal.includes('Прохожий'),
        journal.join(', '));

  irma.last_seen_turn = 0;
  for (let i = 0; i < 15; i += 1) s.history.push({ number: i, player: 'x', narrative: 'y', local: false });
  const active = npcMod.activeNpcs(s).map((n) => n.name);
  check('давний знакомый выпал из промпта', !active.includes('Ирма'), active.join(', '));
  check('но остался в журнале', npcMod.journalNpcs(s).some((n) => n.name === 'Ирма'));
}

console.log('\n=== 9. Смерть и сериализация ===');
{
  const s = fresh();
  s.stats.health = 20;
  rules.applyStateDelta(s, { health: -35, fatigue: 0, time_advance_min: 0 });
  check('ноль здоровья = конец', s.stats.health === 0 && s.game_over === true);

  const t = fresh();
  rules.applyTurn(t, 'иду', turnResponse({
    inventory_changes: { add: [{ name: 'Ключ', description: 'ржавый' }], remove: [] },
    location_change: { changed: true, name: 'Подвал', description: 'сыро' },
    npcs: [{ name: 'Ирма', role: 'торговка', description: '', sympathy_delta: 5,
             present: true, important: true }],
    suggested_actions: ['1', '2', '3', '4', '5'],
  }));
  check('локация сменилась', t.location.name === 'Подвал');
  check('подсказок ровно три', t.suggested_actions.length === 3);
  const copy = fromSaved(JSON.parse(JSON.stringify(t)));
  check('сейв туда-обратно', JSON.stringify(copy) === JSON.stringify(t));
  const dirty = JSON.parse(JSON.stringify(t));
  dirty.неизвестное_поле = 'из будущей версии';
  delete dirty.flags;
  const restored = fromSaved(dirty);
  check('чужие поля отброшены, свои восстановлены',
        restored.location.name === 'Подвал' && !('неизвестное_поле' in restored));
}

console.log('\n=== 10. Бой ===');
{
  const sheet = {
    enemy: { name: 'Головорез', description: 'шрам', hp: 50, attack: 8, defense: 3 },
    player_weapon: { name: 'Нож', attack_bonus: 3 },
    player_armor_bonus: 1,
    usable_items: [{ name: 'Бинты', heal: 15 }, { name: 'Выдуманное', heal: 30 }],
    opening: 'Он бросается.',
    lines: { confident: ['Стой!'], hurt: ['Ах ты!'], dying: ['Хватит...'], winning: ['Всё.'] },
  };

  let s = fresh();
  let c = combatMod.buildCombat(s, { ...sheet, enemy: { ...sheet.enemy, hp: 9999, attack: 99, defense: 99 } }, 'ссора');
  check('числа врага зажаты', c.enemy.hp === 140 && c.enemy.attack === 18 && c.enemy.defense === 9);
  check('выдуманный предмет отсеян', c.usable_items.length === 1);

  s = fresh();
  c = combatMod.buildCombat(s, sheet, 'р');
  check('атака здорового', combatMod.playerAttack(s, c) === 12, String(combatMod.playerAttack(s, c)));
  s.stats.fatigue = 100;
  check('усталость снижает атаку', combatMod.playerAttack(s, c) === 8, String(combatMod.playerAttack(s, c)));

  s = fresh();
  c = combatMod.buildCombat(s, sheet, 'р');
  for (const [ehp, php, mood] of [[50, 100, 'confident'], [25, 100, 'hurt'],
                                  [10, 100, 'dying'], [50, 20, 'winning']]) {
    c.enemy.hp = ehp;
    s.stats.health = php;
    check(`реплика при ${ehp}/${php} -> ${mood}`, combatMod.enemyMood(s, c) === mood);
  }

  const run = (enemy, tactic, n = 600) => {
    let wins = 0, fled = 0, hp = 0;
    for (let i = 0; i < n; i += 1) {
      const st = fresh();
      const cb = combatMod.buildCombat(st, { ...sheet, enemy }, 'р');
      let rounds = 0;
      while (!cb.finished && rounds < 60) {
        let action = 'attack';
        if (tactic === 'coward' && st.stats.health < 35) action = 'flee';
        combatMod.resolveRound(st, cb, action, 'Бинты');
        rounds += 1;
      }
      if (cb.outcome === 'victory') wins += 1;
      if (cb.outcome === 'fled') fled += 1;
      hp += st.stats.health;
    }
    return { win: Math.round((wins * 100) / n), fled: Math.round((fled * 100) / n),
             hp: Math.round(hp / n) };
  };

  const weak = run({ name: 'з', description: '', hp: 40, attack: 5, defense: 1 }, 'attack');
  const mid = run({ name: 'в', description: '', hp: 75, attack: 9, defense: 3 }, 'attack');
  const even = run({ name: 'б', description: '', hp: 95, attack: 12, defense: 4 }, 'attack');
  const boss = run({ name: 'ч', description: '', hp: 130, attack: 16, defense: 7 }, 'attack');
  console.log(`      задира: ${weak.win}% побед, здоровья ${weak.hp}`);
  console.log(`      вооружённый: ${mid.win}% побед, здоровья ${mid.hp}`);
  console.log(`      равный: ${even.win}% побед`);
  console.log(`      чудовище: ${boss.win}% побед`);
  check('слабого бьём почти всегда', weak.win >= 95);
  check('равный бой — не предрешён', even.win > 25 && even.win < 75, `${even.win}%`);
  check('чудовище сильнее', boss.win < 15, `${boss.win}%`);

  const coward = run({ name: 'ч', description: '', hp: 130, attack: 16, defense: 7 }, 'coward');
  check('от чудовища можно сбежать', coward.fled > 50, `${coward.fled}% побегов`);

  s = fresh();
  c = combatMod.buildCombat(s, sheet, 'р');
  s.stats.health = 60;
  combatMod.resolveRound(s, c, 'item', 'Бинты');
  check('предмет лечит и тратится', !s.inventory.some((i) => i.name === 'Бинты'));
  combatMod.resolveRound(s, c, 'item', 'Бинты');
  check('повторно сказать нечего',
        c.log.some((e) => e.text.includes('нет ничего подходящего')));

  s = fresh();
  s.stats.health = 3;
  c = combatMod.buildCombat(s, sheet, 'р');
  while (!c.finished) combatMod.resolveRound(s, c, 'attack');
  check('поражение = конец партии', c.outcome === 'defeat' && s.game_over === true);
  check('сводка для модели готова', combatMod.outcomeNote(s, c).includes('ИТОГ БОЯ'));
}

console.log(
  failures === 0
    ? '\nВСЕ ПРОВЕРКИ ПРОЙДЕНЫ\n'
    : `\nПРОВАЛЕНО ПРОВЕРОК: ${failures}\n`
);
process.exit(failures === 0 ? 0 : 1);
