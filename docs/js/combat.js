/**
 * Режим боя.
 *
 * Главное решение: раунды считает код, модель только озвучивает. Если
 * доверить бой модели целиком, числа поплывут уже к третьему раунду.
 *
 * Расход запросов на всю драку — два: один на завязку (лист врага, реплики,
 * оценка оружия игрока) и один на возвращение в повествование. Раунды
 * бесплатны. Реплики врага генерируются пачкой заранее и дальше выбираются
 * кодом по его состоянию и уверенности в победе.
 */

// Базовые числа игрока. Оружие и броня добавляются поверх — их оценивает
// модель при завязке боя, потому что она видит инвентарь.
export const BASE_ATTACK = 9;
export const BASE_DEFENSE = 2;

const ENEMY_HP_LIMITS = [15, 140];
const ENEMY_ATTACK_LIMITS = [2, 18];
const ENEMY_DEFENSE_LIMITS = [0, 9];
const WEAPON_BONUS_LIMITS = [0, 7];
const ARMOR_BONUS_LIMITS = [0, 5];
const HEAL_LIMITS = [5, 35];

// Раунд выматывает даже победителя.
export const FATIGUE_PER_ROUND = 3;
export const FATIGUE_PER_DEFEND = 1;

export const DEFEND_BONUS = 5;

// Тяжёлый удар врага: редкий, больно бьёт, гасится защитой.
export const HEAVY_BLOW_CHANCE = 25;
export const HEAVY_BLOW_BONUS = 7;

// Усталость и раны бьют по рукам.
const FATIGUE_ATTACK_DIVISOR = 25;
const FATIGUE_DEFENSE_DIVISOR = 35;
const WOUNDED_PERCENT = 30;

export const ACTIONS = ['attack', 'defend', 'item', 'flee'];

function clamp(value, [low, high], fallback) {
  const number = Number.parseInt(value, 10);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(low, Math.min(high, number));
}

function d6() {
  return 1 + Math.floor(Math.random() * 6);
}

function roll100() {
  return 1 + Math.floor(Math.random() * 100);
}

/**
 * Единственная формула урона в игре: удар плюс две кости минус защита.
 *
 * Кости именно две: с одной бой превращался в предсказуемую гонку, где исход
 * был ясен по листу противника ещё до первого удара. Две кости дают
 * достаточный разброс, чтобы равный бой решался в самом бою.
 */
export function damage(attack, defense) {
  return Math.max(1, attack + d6() + d6() - defense);
}

// --------------------------------------------------------- числа игрока

export function playerAttack(state, combat) {
  let value = BASE_ATTACK + combat.weapon_bonus;
  value -= Math.floor(state.stats.fatigue / FATIGUE_ATTACK_DIVISOR);
  const percent = Math.floor((state.stats.health * 100) / Math.max(1, state.stats.max_health));
  if (percent <= WOUNDED_PERCENT) value -= 1;
  return Math.max(1, value);
}

export function playerDefense(state, combat) {
  let value = BASE_DEFENSE + combat.armor_bonus;
  value -= Math.floor(state.stats.fatigue / FATIGUE_DEFENSE_DIVISOR);
  return Math.max(0, value);
}

/**
 * Раненый враг бьёт слабее — то же правило, что и для игрока. Без этой
 * симметрии бой превращается в гонку, исход которой ясен заранее.
 */
export function enemyAttack(combat) {
  let value = combat.enemy.attack;
  const percent = Math.floor((combat.enemy.hp * 100) / Math.max(1, combat.enemy.max_hp));
  if (percent <= WOUNDED_PERCENT) value -= Math.max(1, Math.floor(value / 4));
  return Math.max(1, value);
}

// ------------------------------------------------------- реплики врага

/** Состояние врага, от которого зависит, что он скажет. */
export function enemyMood(state, combat) {
  const enemyPercent = Math.floor((combat.enemy.hp * 100) / Math.max(1, combat.enemy.max_hp));
  const playerPercent = Math.floor(
    (state.stats.health * 100) / Math.max(1, state.stats.max_health)
  );
  if (enemyPercent <= 25) return 'dying';
  if (enemyPercent <= 55) return 'hurt';
  if (playerPercent <= 35) return 'winning';
  return 'confident';
}

/** Выбор реплики — локальный: запросов к модели он не стоит. */
export function pickLine(state, combat) {
  const mood = enemyMood(state, combat);
  const variants = combat.lines[mood]?.length ? combat.lines[mood] : combat.lines.confident || [];
  if (!variants.length) return '';
  // Не повторяем ту же фразу подряд, если есть из чего выбрать.
  const choices = variants.filter((line) => line !== combat.enemy_line);
  const pool = choices.length ? choices : variants;
  return pool[Math.floor(Math.random() * pool.length)];
}

// ------------------------------------------------------------- завязка

/** Собирает бой из ответа модели, зажимая все числа в разумные границы. */
export function buildCombat(state, data, reason, npcName = '') {
  const enemyRaw = data.enemy || {};
  const hp = clamp(enemyRaw.hp, ENEMY_HP_LIMITS, 45);
  const weaponRaw = data.player_weapon || {};

  const items = [];
  for (const raw of (data.usable_items || []).slice(0, 4)) {
    if (!raw || typeof raw !== 'object') continue;
    const name = String(raw.name || '').trim();
    const known = state.inventory.some(
      (item) => item.name.trim().toLowerCase() === name.toLowerCase()
    );
    if (name && known) items.push({ name, heal: clamp(raw.heal, HEAL_LIMITS, 10) });
  }

  const linesRaw = data.lines || {};
  const lines = {};
  for (const mood of ['confident', 'hurt', 'dying', 'winning']) {
    lines[mood] = (linesRaw[mood] || [])
      .map((line) => String(line).trim())
      .filter(Boolean)
      .slice(0, 3);
  }

  const combat = {
    enemy: {
      name: String(enemyRaw.name || '').trim() || 'Противник',
      hp,
      max_hp: hp,
      attack: clamp(enemyRaw.attack, ENEMY_ATTACK_LIMITS, 7),
      defense: clamp(enemyRaw.defense, ENEMY_DEFENSE_LIMITS, 2),
      description: String(enemyRaw.description || '').trim(),
    },
    weapon: String(weaponRaw.name || '').trim(),
    weapon_bonus: clamp(weaponRaw.attack_bonus, WEAPON_BONUS_LIMITS, 0),
    armor_bonus: clamp(data.player_armor_bonus, ARMOR_BONUS_LIMITS, 0),
    lines,
    usable_items: items,
    reason,
    opening: String(data.opening || '').trim(),
    round: 1,
    log: [],
    enemy_line: '',
    finished: false,
    outcome: '',
    npc_name: npcName,
  };
  combat.enemy_line = pickLine(state, combat);
  return combat;
}

function addLog(combat, kind, text) {
  combat.log.push({ round: combat.round, kind, text });
}

// --------------------------------------------------------------- раунд

function enemyStrikes(state, combat, defending, bonus = 0) {
  const defense = playerDefense(state, combat) + (defending ? DEFEND_BONUS : 0);

  // Иногда враг вкладывается в удар. Именно ради таких моментов и нужна
  // защита: без них она была бы кнопкой «проиграй медленнее».
  const heavy = roll100() <= HEAVY_BLOW_CHANCE;
  const hit = damage(enemyAttack(combat) + bonus + (heavy ? HEAVY_BLOW_BONUS : 0), defense);
  state.stats.health = Math.max(0, state.stats.health - hit);

  addLog(
    combat,
    'enemy',
    heavy
      ? `${combat.enemy.name} вкладывается в удар: −${hit} здоровья.`
      : `${combat.enemy.name} бьёт в ответ: −${hit} здоровья.`
  );

  if (state.stats.health <= 0) {
    combat.finished = true;
    combat.outcome = 'defeat';
    state.game_over = true;
    return;
  }

  // Защита без ответа была бы кнопкой «проиграй медленнее»: пропуская удар
  // мимо себя, боец отвечает вполсилы.
  if (defending) {
    const counter = damage(
      Math.max(1, Math.floor(playerAttack(state, combat) / 2)),
      combat.enemy.defense
    );
    combat.enemy.hp = Math.max(0, combat.enemy.hp - counter);
    addLog(combat, 'player', `Ты отбиваешь удар и достаёшь в ответ: −${counter} противнику.`);
    if (combat.enemy.hp <= 0) {
      combat.finished = true;
      combat.outcome = 'victory';
      addLog(combat, 'system', `${combat.enemy.name} падает.`);
    }
  }
}

/** Один раунд боя целиком в коде. Запросов к модели не делает. */
export function resolveRound(state, combat, action, itemName = '') {
  if (combat.finished) return { finished: true, outcome: combat.outcome };

  action = ACTIONS.includes(action) ? action : 'attack';
  const defending = action === 'defend';

  if (action === 'attack') {
    const hit = damage(playerAttack(state, combat), combat.enemy.defense);
    combat.enemy.hp = Math.max(0, combat.enemy.hp - hit);
    addLog(combat, 'player', `Ты атакуешь: −${hit} здоровья противнику.`);
  } else if (action === 'defend') {
    addLog(combat, 'player', 'Ты уходишь в защиту и ждёшь промаха.');
  } else if (action === 'item') {
    const index = combat.usable_items.findIndex(
      (item) => !itemName || item.name.toLowerCase() === itemName.toLowerCase()
    );
    if (index < 0) {
      addLog(combat, 'system', 'Под рукой нет ничего подходящего — ход потерян.');
    } else {
      const used = combat.usable_items[index];
      const before = state.stats.health;
      state.stats.health = Math.min(state.stats.max_health, before + used.heal);
      const gained = state.stats.health - before;
      combat.usable_items.splice(index, 1);
      const inInventory = state.inventory.findIndex(
        (item) => item.name.toLowerCase() === used.name.toLowerCase()
      );
      if (inInventory >= 0) state.inventory.splice(inInventory, 1);
      addLog(combat, 'player', `Ты пускаешь в ход «${used.name}»: +${gained} здоровья.`);
    }
  } else if (action === 'flee') {
    const chance = Math.max(15, 60 - Math.floor(state.stats.fatigue / 2));
    if (roll100() <= chance) {
      addLog(combat, 'player', 'Ты разрываешь дистанцию и уходишь.');
      combat.finished = true;
      combat.outcome = 'fled';
      state.stats.fatigue = Math.min(100, state.stats.fatigue + FATIGUE_PER_ROUND * 2);
      return { finished: true, outcome: 'fled' };
    }
    addLog(combat, 'player', 'Ты пытаешься уйти — и открываешься для удара.');
    enemyStrikes(state, combat, false, 2);
    state.stats.fatigue = Math.min(100, state.stats.fatigue + FATIGUE_PER_ROUND);
    combat.round += 1;
    combat.enemy_line = pickLine(state, combat);
    return { finished: combat.finished, outcome: combat.outcome };
  }

  // Враг отвечает, если ещё жив.
  if (combat.enemy.hp <= 0) {
    combat.finished = true;
    combat.outcome = 'victory';
    addLog(combat, 'system', `${combat.enemy.name} падает.`);
  } else {
    enemyStrikes(state, combat, defending);
  }

  state.stats.fatigue = Math.min(
    100,
    state.stats.fatigue + (defending ? FATIGUE_PER_DEFEND : FATIGUE_PER_ROUND)
  );
  combat.round += 1;
  combat.enemy_line = pickLine(state, combat);
  return { finished: combat.finished, outcome: combat.outcome };
}

// ---------------------------------------------------------------- итог

const OUTCOME_TEXT = {
  victory: 'Игрок победил в бою',
  defeat: 'Игрок проиграл бой и потерял сознание или погиб',
  fled: 'Игрок сбежал с поля боя',
};

/** Сводка для модели, чтобы она вернула историю в повествование. */
export function outcomeNote(state, combat) {
  const result = OUTCOME_TEXT[combat.outcome] || 'Бой закончился';
  return (
    'ИТОГ БОЯ (это уже случилось, опиши последствия):\n' +
    `Противник: ${combat.enemy.name} (${combat.enemy.description}).\n` +
    `Причина стычки: ${combat.reason}\n` +
    `Раундов: ${combat.round - 1}. ${result}.\n` +
    `Здоровье противника осталось: ${combat.enemy.hp} из ${combat.enemy.max_hp}.\n` +
    `Здоровье игрока: ${state.stats.health} из ${state.stats.max_health}, ` +
    `усталость ${state.stats.fatigue}.\n` +
    'Не переигрывай бой заново и не меняй его итог — опиши, что было сразу после.'
  );
}

/** То, что видит игрок на боевом экране. */
export function combatView(state, combat) {
  return {
    enemy: { ...combat.enemy },
    player: {
      hp: state.stats.health,
      max_hp: state.stats.max_health,
      attack: playerAttack(state, combat),
      defense: playerDefense(state, combat),
      weapon: combat.weapon,
    },
    round: combat.round,
    line: combat.enemy_line,
    opening: combat.opening,
    reason: combat.reason,
    items: combat.usable_items,
    log: combat.log,
    finished: combat.finished,
    outcome: combat.outcome,
  };
}
