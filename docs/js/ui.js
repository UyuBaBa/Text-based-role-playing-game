/**
 * Интерфейс игры.
 *
 * Сервера нет: всё, что раньше делал Python, теперь считается здесь же,
 * в браузере. Наружу уходит только один запрос — в Gemini.
 */

import { CONFIG, activeKey, ownKey, setOwnKey } from './config.js';
import { listModels, usage } from './api.js';
import { generateWorld } from './worldgen.js';
import { fromWorldCard, day, elapsedText, turnNumber } from './state.js';
import { playTurn, requestCombatSheet } from './turn.js';
import { buildCombat, combatView, outcomeNote, resolveRound } from './combat.js';
import { journalNpcs, sympathyTier } from './npc.js';
import * as saves from './saves.js';

const $ = (id) => document.getElementById(id);

const state = {
  model: CONFIG.defaultModel,
  world: null, // карточка мира до нажатия «Начать игру»
  game: null, // GameState начатой партии
  combat: null, // текущий бой
  busy: false,
  inputs: { world: '', character: '' },
  savesMode: 'load',
};

const SCREENS = ['key', 'menu', 'models', 'new', 'loading', 'world', 'game', 'combat'];

function show(name) {
  SCREENS.forEach((screen) => {
    $(`screen-${screen}`).hidden = screen !== name;
  });
  window.scrollTo(0, 0);
}

function currentScreen() {
  return SCREENS.find((name) => !$(`screen-${name}`).hidden);
}

function setNotice(id, text) {
  const node = $(id);
  node.textContent = text || '';
  node.hidden = !text;
}

/** Текст от модели приходит абзацами. Делим и по одиночному переводу строки:
 *  модель иногда забывает про пустую строку. */
function renderProse(node, text) {
  node.innerHTML = '';
  String(text || '')
    .split(/\n+/)
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .forEach((chunk) => {
      const p = document.createElement('p');
      p.textContent = chunk;
      node.appendChild(p);
    });
}

function showError(id, err) {
  const text = err?.userMessage || err?.message || String(err);
  setNotice(id, text);
  if (err?.detail) console.warn('Подробности:', err.detail);
}

function updateUsage(nodeId) {
  const node = $(nodeId);
  if (node) node.textContent = `запросов к API: ${usage.calls} · токенов: ${usage.totalTokens}`;
}

// ------------------------------------------------------------------ меню

function refreshMenu() {
  $('menu-model').textContent = titleOf(state.model);
  $('menu-continue').disabled = state.game === null;
  $('menu-continue').title = state.game ? 'Вернуться в текущую партию' : 'Нет начатой игры';
  $('menu-load').disabled = !saves.hasAnySave();
  $('menu-key').textContent = ownKey() ? 'Сменить ключ' : 'Ввести ключ';
  setNotice('menu-error', '');
}

function titleOf(modelId) {
  const found = CONFIG.models.find((model) => model.id === modelId);
  return found ? found.title : modelId;
}

function renderModels() {
  const list = $('model-list');
  list.innerHTML = '';
  CONFIG.models.forEach((model) => {
    const button = document.createElement('button');
    button.className = 'model-item' + (model.id === state.model ? ' active' : '');
    button.innerHTML =
      '<span class="dot"></span>' +
      `<span>${model.title}</span>` +
      `<span class="id">${model.id}</span>`;
    button.addEventListener('click', () => {
      state.model = model.id;
      try {
        localStorage.setItem('rpg.model', model.id);
      } catch (err) {
        /* не беда */
      }
      renderModels();
      $('menu-model').textContent = titleOf(model.id);
    });
    list.appendChild(button);
  });
}

// ------------------------------------------------------------ генерация

const LOADING_LINES = [
  'Мир собирается по кускам…',
  'Расставляем на местах людей и их обиды…',
  'Придумываем, что случилось до твоего прихода…',
  'Раскладываем вещи по карманам…',
];

let loadingTimer = null;

function startLoading(first = LOADING_LINES[0]) {
  let index = 0;
  $('loading-text').textContent = first;
  loadingTimer = setInterval(() => {
    index = (index + 1) % LOADING_LINES.length;
    $('loading-text').textContent = LOADING_LINES[index];
  }, 3500);
  show('loading');
}

function stopLoading() {
  if (loadingTimer) clearInterval(loadingTimer);
  loadingTimer = null;
}

async function makeWorld() {
  // Откуда пришли, туда и вернёмся при ошибке: перегенерация не должна
  // выбрасывать игрока с уже готовой карточки мира.
  const fallbackScreen = state.world ? 'world' : 'new';
  const errorField = state.world ? 'world-error' : 'new-error';
  startLoading();
  try {
    state.world = await generateWorld(state.model, state.inputs.world, state.inputs.character);
    stopLoading();
    renderWorld();
    show('world');
  } catch (err) {
    stopLoading();
    showError(errorField, err);
    show(fallbackScreen);
  }
}

// ------------------------------------------------------------- карточка

function renderWorld() {
  const world = state.world;
  $('world-title').textContent = world.world_title;
  $('world-genre').textContent = world.genre;

  const { health, max_health: maxHealth, fatigue } = world.stats;
  $('stat-health-num').textContent = `${health} / ${maxHealth}`;
  $('stat-health-bar').style.width = `${health}%`;
  $('stat-fatigue-num').textContent = `${fatigue} / 100`;
  $('stat-fatigue-bar').style.width = `${fatigue}%`;

  renderProse($('world-backstory'), world.backstory);
  fillList($('world-rules'), world.world_rules, (rule) => rule);

  $('char-name').textContent = world.character.name;
  renderProse($('char-background'), world.character.background);
  $('char-goal').textContent = world.character.goal;
  $('char-traits').innerHTML = world.character.traits
    .map((trait) => `<span class="tag">${escapeHtml(trait)}</span>`)
    .join('');

  const inventory = $('world-inventory');
  inventory.innerHTML = '';
  world.inventory.forEach((item) => inventory.appendChild(itemLine(item)));

  $('loc-name').textContent = world.location.name;
  renderProse($('loc-description'), world.location.description);
  renderProse($('world-opening'), world.opening_scene);

  const actions = $('world-actions');
  actions.innerHTML = '';
  world.suggested_actions.forEach((action) => {
    const div = document.createElement('div');
    div.className = 'suggestion';
    div.textContent = action;
    actions.appendChild(div);
  });

  setNotice('world-error', '');
  updateUsage('usage-line');
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function fillList(node, items, toText) {
  node.innerHTML = '';
  items.forEach((item) => {
    const li = document.createElement('li');
    li.textContent = toText(item);
    node.appendChild(li);
  });
}

function itemLine(item) {
  const li = document.createElement('li');
  const name = document.createElement('b');
  name.textContent = item.name;
  li.appendChild(name);
  if (item.description) li.append(` — ${item.description}`);
  return li;
}

// ------------------------------------------------------------------ игра

/** Пороги те же, что в rules.js: игрок должен видеть, когда сюжет начнёт
 *  сопротивляться. */
function healthLevel(percent) {
  if (percent <= 20) return 'critical';
  if (percent <= 50) return 'warn';
  return 'ok';
}

function fatigueLevel(value) {
  if (value >= 85) return 'critical';
  if (value >= 65) return 'warn';
  if (value >= 40) return 'notice';
  return 'ok';
}

const HEALTH_HINT = { critical: 'тяжело ранен', warn: 'ранен', ok: '' };
const FATIGUE_HINT = { critical: 'на пределе', warn: 'измотан', notice: 'устал', ok: '' };

function renderHud() {
  const game = state.game;
  $('hud-location').textContent = game.location.name;
  $('hud-time').textContent =
    `День ${day(game)} · ${game.time_of_day} · ход ${turnNumber(game)}`;

  const { health, max_health: maxHealth, fatigue } = game.stats;
  const percent = Math.round((health / maxHealth) * 100);
  const hLevel = healthLevel(percent);
  const fLevel = fatigueLevel(fatigue);

  $('hud-health-num').textContent = `${health} / ${maxHealth}`;
  $('hud-health-bar').style.width = `${percent}%`;
  $('hud-health-bar').className = `bar-fill bar-health level-${hLevel}`;
  $('hud-health-hint').textContent = HEALTH_HINT[hLevel];

  $('hud-fatigue-num').textContent = `${fatigue} / 100`;
  $('hud-fatigue-bar').style.width = `${fatigue}%`;
  $('hud-fatigue-bar').className = `bar-fill bar-fatigue level-${fLevel}`;
  $('hud-fatigue-hint').textContent = FATIGUE_HINT[fLevel];
}

/** Подсказка игроку: кто сейчас рядом и как к нему относится. */
function renderNpcs() {
  const box = $('hud-npcs');
  const present = state.game.npcs.filter((npc) => npc.present);
  box.innerHTML = '';
  box.hidden = !present.length;

  present.forEach((npc) => {
    const tier = sympathyTier(npc.sympathy);
    const chip = document.createElement('div');
    chip.className = `npc npc-${toneOf(tier.label)}`;
    chip.title = npc.role ? `${npc.role}. ${npc.description}` : npc.description;

    // Шкала расходится от середины: влево — неприязнь, вправо — симпатия.
    const width = Math.abs(npc.sympathy) / 2;
    const offset = npc.sympathy < 0 ? 50 - width : 50;
    chip.innerHTML =
      `<span class="npc-name">${escapeHtml(npc.name)}</span>` +
      `<span class="npc-tier">${tier.label}</span>` +
      `<span class="npc-bar"><i style="left:${offset}%;width:${width}%"></i></span>`;
    box.appendChild(chip);
  });
}

const TONES = {
  Предан: 'best',
  Дружелюбен: 'good',
  Нейтрален: 'neutral',
  Неприязнь: 'bad',
  Враждебен: 'worst',
};
const toneOf = (label) => TONES[label] || 'neutral';

const REST_LABEL = { отдых: 'передышка', еда: 'перекус', сон: 'сон' };

/** Строка «что изменилось» под ходом: показываем только ненулевое. */
function renderChanges(changes) {
  if (!changes || !changes.stats) return null;
  const parts = [];
  const { health, fatigue, minutes, rest } = changes.stats;
  if (rest && REST_LABEL[rest]) parts.push(`<span class="up">${REST_LABEL[rest]}</span>`);
  if (health) {
    parts.push(
      `<span class="${health < 0 ? 'down' : 'up'}">здоровье ${health > 0 ? '+' : ''}${health}</span>`
    );
  }
  if (fatigue) {
    parts.push(
      `<span class="${fatigue > 0 ? 'down' : 'up'}">усталость ${fatigue > 0 ? '+' : ''}${fatigue}</span>`
    );
  }
  if (minutes) parts.push(`прошло ${minutes} мин`);
  (changes.inventory?.added || []).forEach((name) =>
    parts.push(`<span class="up">+ ${escapeHtml(name)}</span>`)
  );
  (changes.inventory?.removed || []).forEach((name) =>
    parts.push(`<span class="down">− ${escapeHtml(name)}</span>`)
  );
  (changes.npcs || []).forEach((npc) => {
    if (!npc.delta) return;
    const sign = npc.delta > 0 ? '+' : '';
    parts.push(
      `<span class="${npc.delta > 0 ? 'up' : 'down'}">${escapeHtml(npc.name)} ${sign}${npc.delta}</span>`
    );
  });
  if (!parts.length) return null;

  const meta = document.createElement('div');
  meta.className = 'entry-meta';
  meta.innerHTML = parts.join('');
  return meta;
}

/**
 * Подводит начало хода к верху экрана. Прыжок в самый низ сбивает чтение:
 * новый текст должен начинаться там, где взгляд уже находится.
 */
function anchorTo(element) {
  if (!element) return;
  const hud = document.querySelector('.hud');
  const offset = (hud ? hud.offsetHeight : 0) + 18;
  const top = element.getBoundingClientRect().top + window.scrollY - offset;
  window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
}

function appendEntry(turn, changes, index) {
  const log = $('game-log');
  const mark = (node) => {
    if (index !== undefined && !log.querySelector(`[data-turn="${index}"]`)) {
      node.dataset.turn = index;
    }
    return node;
  };
  if (turn.player) {
    const line = document.createElement('div');
    line.className = 'entry-player';
    line.textContent = turn.player;
    log.appendChild(mark(line));
  }
  const text = document.createElement('div');
  // Локальный отказ по усталости или ранам — не сцена от ведущего, показываем тише.
  text.className = turn.local ? 'entry-text entry-local' : 'entry-text';
  renderProse(text, turn.narrative);
  log.appendChild(mark(text));

  const meta = renderChanges(changes);
  if (meta) log.appendChild(meta);
}

function renderSuggestions() {
  const box = $('game-actions');
  box.innerHTML = '';
  state.game.suggested_actions.forEach((action) => {
    const button = document.createElement('button');
    button.className = 'suggestion-btn';
    button.textContent = action;
    button.addEventListener('click', () => {
      $('game-input').value = action;
      $('game-input').focus();
    });
    box.appendChild(button);
  });
}

/** Полная перерисовка — при старте игры и возврате на экран. */
function renderGame() {
  const game = state.game;
  $('game-log').innerHTML = '';
  game.history.forEach((turn, index) => appendEntry(turn, null, index));

  renderHud();
  renderNpcs();
  renderSuggestions();
  setNotice('game-error', '');
  $('game-over').hidden = !game.game_over;
  $('composer').hidden = game.game_over;
  updateUsage('game-usage');
}

function enterGame() {
  renderGame();
  if (state.combat) {
    renderCombat();
    show('combat');
    return;
  }
  show('game');
  $('game-input').focus();
}

function startGame() {
  state.game = fromWorldCard(state.world);
  state.combat = null;
  saves.autosave(state.game);
  enterGame();
}

async function sendTurn() {
  if (state.busy) return;
  const input = $('game-input');
  const text = input.value.trim();
  if (!text) {
    input.focus();
    return;
  }

  state.busy = true;
  setNotice('game-error', '');
  $('game-thinking').hidden = false;
  $('game-actions').innerHTML = '';
  input.disabled = true;

  // Действие игрока показываем сразу, не дожидаясь ответа.
  const line = document.createElement('div');
  line.className = 'entry-player';
  line.textContent = text;
  $('game-log').appendChild(line);
  anchorTo(line);

  try {
    const { changes, combat } = await playTurn(state.model, state.game, text);
    const last = state.game.history[state.game.history.length - 1];
    appendEntry({ player: '', narrative: last.narrative, local: last.local }, changes);
    renderHud();
    renderNpcs();
    renderSuggestions();
    $('game-over').hidden = !state.game.game_over;
    $('composer').hidden = state.game.game_over;
    updateUsage('game-usage');
    input.value = '';

    // Модель объявила драку — собираем бой вторым запросом.
    if (combat) {
      $('game-thinking').hidden = false;
      try {
        const sheet = await requestCombatSheet(
          state.model, state.game, combat.enemy_name, combat.reason
        );
        state.combat = buildCombat(state.game, sheet, combat.reason, combat.enemy_name);
        saves.autosave(state.game, state.combat);
        renderCombat();
        show('combat');
        return;
      } catch (err) {
        // Драку не собрали — история продолжается как обычно, без боя.
        showError('game-error', err);
      }
    }
    saves.autosave(state.game, state.combat);
  } catch (err) {
    // Ход не состоялся: убираем реплику игрока, состояние не менялось.
    line.remove();
    showError('game-error', err);
  } finally {
    state.busy = false;
    $('game-thinking').hidden = true;
    input.disabled = false;
    input.focus();
  }
}

// ------------------------------------------------------------------- бой

const OUTCOME_TEXT = {
  victory: 'Ты выстоял.',
  defeat: 'Тебя сломили.',
  fled: 'Ты ушёл с поля боя.',
};

function renderCombat() {
  const view = combatView(state.game, state.combat);

  $('combat-round').textContent = view.finished ? 'бой окончен' : `раунд ${view.round}`;
  renderProse($('combat-opening'), view.opening);

  $('combat-enemy-name').textContent = view.enemy.name;
  $('combat-enemy-hp').textContent = `${view.enemy.hp} / ${view.enemy.max_hp}`;
  $('combat-enemy-bar').style.width = `${(view.enemy.hp / view.enemy.max_hp) * 100}%`;
  $('combat-enemy-atk').textContent = view.enemy.attack;
  $('combat-enemy-def').textContent = view.enemy.defense;
  $('combat-enemy-desc').textContent = view.enemy.description;

  const percent = Math.round((view.player.hp / view.player.max_hp) * 100);
  $('combat-player-hp').textContent = `${view.player.hp} / ${view.player.max_hp}`;
  $('combat-player-bar').style.width = `${percent}%`;
  $('combat-player-bar').className = `bar-fill bar-health level-${healthLevel(percent)}`;
  $('combat-player-atk').textContent = view.player.attack;
  $('combat-player-def').textContent = view.player.defense;
  $('combat-player-weapon').textContent = view.player.weapon ? `в руках: ${view.player.weapon}` : '';

  $('combat-line').textContent = view.line;
  $('combat-line').hidden = !view.line;

  const log = $('combat-log');
  log.innerHTML = '';
  view.log.forEach((entry) => {
    const row = document.createElement('div');
    row.className = 'row';
    row.innerHTML =
      `<span class="num">${entry.round}</span>` +
      `<span class="${entry.kind}">${escapeHtml(entry.text)}</span>`;
    log.appendChild(row);
  });
  log.scrollTop = log.scrollHeight;

  // Кнопка предмета знает, что именно пойдёт в ход.
  const itemButton = $('combat-item');
  const item = view.items[0];
  itemButton.disabled = !item;
  itemButton.textContent = item ? `Предмет: ${item.name}` : 'Предмет';

  $('combat-actions').hidden = view.finished;
  $('combat-end').hidden = !view.finished;
  $('combat-outcome').textContent = OUTCOME_TEXT[view.outcome] || '';
  setNotice('combat-error', '');
}

/** Раунд считается мгновенно: запросов к модели он не стоит. */
function combatAction(action) {
  if (state.busy || !state.combat || state.combat.finished) return;
  const item = state.combat.usable_items[0]?.name || '';
  resolveRound(state.game, state.combat, action, item);
  saves.autosave(state.game, state.combat.finished ? null : state.combat);
  renderCombat();
}

async function combatFinish() {
  if (state.busy) return;
  state.busy = true;
  $('combat-end').hidden = true;
  $('game-thinking').hidden = false;
  show('game');
  try {
    const note = outcomeNote(state.game, state.combat);
    const { changes } = await playTurn(state.model, state.game, '', note);
    state.combat = null;
    saves.autosave(state.game);
    renderGame();
    const last = state.game.history[state.game.history.length - 1];
    anchorTo($('game-log').querySelector(`[data-turn="${state.game.history.length - 1}"]`));
    if (changes) updateUsage('game-usage');
    void last;
  } catch (err) {
    showError('combat-error', err);
    $('combat-end').hidden = false;
    show('combat');
  } finally {
    state.busy = false;
    $('game-thinking').hidden = true;
  }
}

// ---------------------------------------------------------------- журнал

function renderJournal() {
  const game = state.game;
  if (!game) return;

  $('journal-title').textContent = game.character_name || 'Журнал';

  const { health, max_health: maxHealth, fatigue } = game.stats;
  const percent = Math.round((health / maxHealth) * 100);
  $('j-health-num').textContent = `${health} / ${maxHealth}`;
  $('j-health-bar').style.width = `${percent}%`;
  $('j-health-bar').className = `bar-fill bar-health level-${healthLevel(percent)}`;
  $('j-fatigue-num').textContent = `${fatigue} / 100`;
  $('j-fatigue-bar').style.width = `${fatigue}%`;
  $('j-fatigue-bar').className = `bar-fill bar-fatigue level-${fatigueLevel(fatigue)}`;

  const facts = [
    ['Мир', game.world_title],
    ['Место', game.location.name],
    ['Время', `День ${day(game)}, ${game.time_of_day} (прошло ${elapsedText(game)})`],
    ['Ходов сделано', String(turnNumber(game))],
  ];
  $('j-facts').innerHTML = facts
    .map(([key, value]) => `<dt>${key}</dt><dd>${escapeHtml(value)}</dd>`)
    .join('');

  renderProse($('j-background'), game.character_background);
  $('j-goal').textContent = game.character_goal;
  $('j-traits').innerHTML = game.character_traits
    .map((trait) => `<span class="tag">${escapeHtml(trait)}</span>`)
    .join('');

  // Хроника длинная — показываем последнее сверху, так полезнее.
  fillList($('j-chronicle'), [...game.chronicle].reverse(), (entry) => entry);

  const inventory = $('j-inventory');
  inventory.innerHTML = '';
  if (!game.inventory.length) inventory.innerHTML = '<li>Карманы пусты.</li>';
  game.inventory.forEach((item) => inventory.appendChild(itemLine(item)));

  const people = $('j-people');
  const list = journalNpcs(game);
  people.innerHTML = '';
  $('j-people-hint').textContent = list.length
    ? 'Только те, кто что-то значит: случайные встречные сюда не попадают.'
    : 'Пока никого, кто стоил бы отдельной записи.';

  list.forEach((npc) => {
    const tier = sympathyTier(npc.sympathy);
    const card = document.createElement('div');
    card.className = `person npc-${toneOf(tier.label)}`;
    const seen =
      npc.scenes > 1
        ? `встреч: ${npc.scenes}, последняя на ходу ${npc.last_seen_turn}`
        : `встречен на ходу ${npc.first_seen_turn}`;
    card.innerHTML =
      '<div class="person-top">' +
      `<span><span class="person-name">${escapeHtml(npc.name)}</span>` +
      (npc.role ? ` <span class="person-role">— ${escapeHtml(npc.role)}</span>` : '') +
      '</span>' +
      `<span class="person-tier">${tier.label} (${npc.sympathy > 0 ? '+' : ''}${npc.sympathy})</span>` +
      '</div>' +
      (npc.description ? `<div class="person-desc">${escapeHtml(npc.description)}</div>` : '') +
      `<div class="person-seen">${seen}</div>`;
    people.appendChild(card);
  });
}

function switchTab(name) {
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.classList.toggle('tab-active', tab.dataset.tab === name);
  });
  ['character', 'inventory', 'people'].forEach((tab) => {
    $(`tab-${tab}`).hidden = tab !== name;
  });
}

// ----------------------------------------------------------- сохранения

const SLOT_TITLE = { auto: 'Автосохранение' };
const slotTitle = (slot) => SLOT_TITLE[slot.slot] || `Слот ${slot.slot}`;

function renderSaves(mode) {
  state.savesMode = mode;
  $('saves-title').textContent = mode === 'save' ? 'Сохранить игру' : 'Загрузить игру';
  $('saves-hint').textContent =
    mode === 'save'
      ? 'Автосохранение пишется само после каждого хода — в него записать нельзя.'
      : 'Выбери, с какого места продолжить.';

  const box = $('saves-list');
  box.innerHTML = '';

  saves.listSaves().forEach((slot) => {
    const row = document.createElement('div');
    row.className = slot.exists ? 'slot' : 'slot slot-empty';

    const main = document.createElement('div');
    main.className = 'slot-main';
    if (slot.exists && !slot.broken) {
      const tags = [];
      if (slot.game_over) tags.push('<span class="slot-tag">герой погиб</span>');
      if (slot.in_combat) tags.push('<span class="slot-tag">посреди боя</span>');
      if (slot.outdated) tags.push('<span class="slot-tag">старая версия</span>');
      main.innerHTML =
        `<div class="slot-name">${escapeHtml(slot.title || 'Без названия')}` +
        (slot.auto ? ' <span class="slot-auto">авто</span>' : '') +
        '</div>' +
        `<div class="slot-info">${escapeHtml(slot.character)}, ход ${slot.turn}, ` +
        `день ${slot.day}, здоровье ${slot.health} · ` +
        `${slot.saved_at.replace('T', ' ')} ${tags.join(' ')}</div>`;
    } else {
      main.innerHTML =
        `<div class="slot-name">${slotTitle(slot)}</div>` +
        `<div class="slot-info">${slot.broken ? 'файл повреждён' : 'пусто'}</div>`;
    }
    row.appendChild(main);

    const buttons = document.createElement('div');
    buttons.className = 'slot-buttons';

    if (mode === 'save' && !slot.auto) {
      const save = document.createElement('button');
      save.className = 'btn btn-main';
      save.textContent = slot.exists ? 'Перезаписать' : 'Сохранить';
      save.addEventListener('click', () => {
        try {
          saves.saveGame(state.game, slot.slot, state.combat);
          renderSaves('save');
        } catch (err) {
          showError('saves-error', err);
        }
      });
      buttons.appendChild(save);
    }
    if (slot.exists && !slot.broken) {
      const load = document.createElement('button');
      load.className = mode === 'save' ? 'btn' : 'btn btn-main';
      load.textContent = 'Загрузить';
      load.addEventListener('click', () => {
        try {
          const loaded = saves.loadGame(slot.slot);
          state.game = loaded.state;
          state.combat = loaded.combat;
          $('saves').hidden = true;
          enterGame();
        } catch (err) {
          showError('saves-error', err);
        }
      });
      buttons.appendChild(load);

      const download = document.createElement('button');
      download.className = 'btn btn-quiet';
      download.textContent = 'В файл';
      download.title = 'Скачать, чтобы не потерять при чистке браузера';
      download.addEventListener('click', () => downloadSave(slot.slot));
      buttons.appendChild(download);
    }
    if (slot.exists) {
      const remove = document.createElement('button');
      remove.className = 'btn btn-quiet';
      remove.textContent = 'Удалить';
      remove.addEventListener('click', () => {
        try {
          saves.deleteSave(slot.slot);
          renderSaves(state.savesMode);
        } catch (err) {
          showError('saves-error', err);
        }
      });
      buttons.appendChild(remove);
    }

    row.appendChild(buttons);
    box.appendChild(row);
  });

  setNotice('saves-error', '');
  $('saves').hidden = false;
}

/** Сейвы живут в браузере: чистка истории их сотрёт, поэтому даём забрать файл. */
function downloadSave(slot) {
  try {
    const text = saves.exportSave(slot);
    const blob = new Blob([text], { type: 'application/json' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `rpg-save-${slot}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  } catch (err) {
    showError('saves-error', err);
  }
}

function importFromFile(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      saves.importSave('1', String(reader.result));
      renderSaves(state.savesMode);
    } catch (err) {
      showError('saves-error', err);
    }
  };
  reader.readAsText(file);
}

// ---------------------------------------------------------------- ключ

function showKeyScreen() {
  $('key-input').value = ownKey();
  setNotice('key-error', '');
  // «Назад» нужна, только когда игре уже есть с чем работать.
  $('key-back').hidden = !activeKey();
  show('key');
  $('key-input').focus();
}

async function submitKey() {
  if (state.busy) return;
  const value = $('key-input').value.trim();
  if (!value) {
    setNotice('key-error', 'Вставь ключ — без него игра не заработает.');
    return;
  }

  const previous = ownKey();
  state.busy = true;
  setNotice('key-error', 'Проверяю ключ…');
  setOwnKey(value);
  try {
    // Заодно убеждаемся, что ключ живой: список моделей ничего не стоит.
    await listModels();
    setNotice('key-error', '');
    refreshMenu();
    show('menu');
  } catch (err) {
    // Неудачный ключ не должен вытеснять прежний рабочий.
    setOwnKey(previous);
    showError('key-error', err);
  } finally {
    state.busy = false;
  }
}

// -------------------------------------------------------------- действия

const ACTIONS = {
  'new-game': () => {
    setNotice('new-error', '');
    $('input-world').value = state.inputs.world;
    $('input-character').value = state.inputs.character;
    show('new');
  },
  models: () => {
    renderModels();
    show('models');
  },
  'back-menu': () => {
    refreshMenu();
    show('menu');
  },
  generate: () => {
    state.inputs.world = $('input-world').value;
    state.inputs.character = $('input-character').value;
    makeWorld();
  },
  regenerate: () => makeWorld(),
  play: () => startGame(),
  continue: () => enterGame(),
  act: () => sendTurn(),
  hit: () => combatAction('attack'),
  guard: () => combatAction('defend'),
  'use-item': () => combatAction('item'),
  run: () => combatAction('flee'),
  'combat-finish': () => combatFinish(),
  journal: () => {
    renderJournal();
    switchTab('character');
    $('journal').hidden = false;
  },
  'journal-close': () => {
    $('journal').hidden = true;
  },
  saves: () => renderSaves('save'),
  load: () => renderSaves('load'),
  'saves-close': () => {
    $('saves').hidden = true;
  },
  'saves-import': () => $('saves-file').click(),
  'key-screen': () => showKeyScreen(),
  'key-submit': () => submitKey(),
  'key-back': () => {
    refreshMenu();
    show('menu');
  },
};

document.addEventListener('click', (event) => {
  const tab = event.target.closest('[data-tab]');
  if (tab) {
    switchTab(tab.dataset.tab);
    return;
  }
  // Клик по тёмному фону закрывает окно.
  if (event.target.classList.contains('overlay')) {
    event.target.hidden = true;
    return;
  }
  const button = event.target.closest('[data-action]');
  if (!button || button.disabled) return;
  const handler = ACTIONS[button.dataset.action];
  if (handler) handler();
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
    if (!$('screen-game').hidden) sendTurn();
    return;
  }
  if (event.key === 'Enter' && !$('screen-key').hidden) {
    submitKey();
    return;
  }
  if (event.key !== 'Escape') return;
  $('journal').hidden = true;
  $('saves').hidden = true;
});

$('saves-file').addEventListener('change', (event) => {
  const file = event.target.files[0];
  if (file) importFromFile(file);
  event.target.value = '';
});

// ------------------------------------------------------------- запуск

try {
  const savedModel = localStorage.getItem('rpg.model');
  if (savedModel && CONFIG.models.some((m) => m.id === savedModel)) state.model = savedModel;
} catch (err) {
  /* не беда */
}

if (!activeKey()) {
  showKeyScreen();
} else {
  refreshMenu();
  show('menu');
}
