'use strict';

const $ = (id) => document.getElementById(id);

const state = {
  models: [],
  model: null,
  world: null,
  game: null,
  busy: false,
  inputs: { world: '', character: '' },
  // Общая партия: имя видно остальным, revision говорит, что пора обновиться.
  playerName: '',
  revision: -1,
  players: [],
  coop: false,
};

const SCREENS = ['code', 'menu', 'models', 'new', 'loading', 'world', 'game', 'combat', 'bye'];

function show(name) {
  SCREENS.forEach((screen) => {
    $(`screen-${screen}`).hidden = screen !== name;
  });
  window.scrollTo(0, 0);
}

function setNotice(id, text) {
  const node = $(id);
  node.textContent = text || '';
  node.hidden = !text;
}

/** Текст от модели приходит абзацами через \n\n. Делим и по одиночному
 *  переводу строки: модель иногда забывает про пустую строку. */
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

async function api(path, options) {
  const response = await fetch(path, options);
  let body = {};
  try {
    body = await response.json();
  } catch (err) {
    throw new Error('Сервер вернул неожиданный ответ.');
  }
  if (!response.ok) {
    throw new Error(body.error || 'Ошибка сервера.');
  }
  return body;
}

// ------------------------------------------------------------------ меню

async function loadState() {
  try {
    const data = await api('/api/state');
    if (data.needs_code) {
      show('code');
      $('code-input').focus();
      return;
    }
    state.models = data.models || [];
    state.model = data.model;
    $('menu-model').textContent = titleOf(data.model);
    setNotice('menu-error', data.error);
    $('menu-models').disabled = !state.models.length;

    const resume = $('menu-continue');
    resume.disabled = !data.has_game;
    resume.title = data.has_game ? 'Вернуться в текущую партию' : 'Нет начатой игры';

    // На сервере гасить нечего: кнопка «Выход» там только собьёт с толку.
    document.querySelector('[data-action="quit"]').hidden = Boolean(data.hosted);

    const load = $('menu-load');
    load.disabled = !data.saves_available;
    load.title = data.saves_available ? 'Выбрать сохранение' : 'Сохранений пока нет';
  } catch (err) {
    setNotice('menu-error', err.message);
  }
}

function titleOf(modelId) {
  const found = state.models.find((model) => model.id === modelId);
  return found ? found.title : modelId || '—';
}

function renderModels() {
  const list = $('model-list');
  list.innerHTML = '';
  state.models.forEach((model) => {
    const button = document.createElement('button');
    button.className = 'model-item' + (model.id === state.model ? ' active' : '');
    button.innerHTML =
      '<span class="dot"></span>' +
      `<span>${model.title}</span>` +
      (model.wanted ? '' : '<span class="swap">замена</span>') +
      `<span class="id">${model.id}</span>`;
    button.addEventListener('click', () => selectModel(model.id));
    list.appendChild(button);
  });
}

async function selectModel(modelId) {
  state.model = modelId;
  renderModels();
  $('menu-model').textContent = titleOf(modelId);
  try {
    await api('/api/model', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: modelId }),
    });
  } catch (err) {
    /* выбор модели не критичен: сервер возьмёт модель из .env */
  }
}

// ------------------------------------------------------------ генерация

const LOADING_LINES = [
  'Мир собирается по кускам…',
  'Расставляем на местах людей и их обиды…',
  'Придумываем, что случилось до твоего прихода…',
  'Раскладываем вещи по карманам…',
];

let loadingTimer = null;

function startLoading() {
  let index = 0;
  $('loading-text').textContent = LOADING_LINES[0];
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

async function generateWorld() {
  // Откуда пришли, туда и вернёмся при ошибке: перегенерация не должна
  // выбрасывать игрока с уже готовой карточки мира.
  const fallbackScreen = state.world ? 'world' : 'new';
  const errorField = state.world ? 'world-error' : 'new-error';
  startLoading();
  try {
    const data = await api('/api/new-game', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        world: state.inputs.world,
        character: state.inputs.character,
        model: state.model || '',
      }),
    });
    state.world = data.world;
    stopLoading();
    renderWorld(data);
    show('world');
  } catch (err) {
    stopLoading();
    setNotice(errorField, err.message);
    show(fallbackScreen);
  }
}

// ------------------------------------------------------------- карточка

function renderWorld(data) {
  const world = data.world;

  $('world-title').textContent = world.world_title;
  $('world-genre').textContent = world.genre;

  const health = world.stats.health;
  const fatigue = world.stats.fatigue;
  $('stat-health-num').textContent = `${health} / ${world.stats.max_health}`;
  $('stat-health-bar').style.width = `${health}%`;
  $('stat-fatigue-num').textContent = `${fatigue} / 100`;
  $('stat-fatigue-bar').style.width = `${fatigue}%`;

  renderProse($('world-backstory'), world.backstory);

  const rules = $('world-rules');
  rules.innerHTML = '';
  world.world_rules.forEach((rule) => {
    const li = document.createElement('li');
    li.textContent = rule;
    rules.appendChild(li);
  });

  $('char-name').textContent = world.character.name;
  renderProse($('char-background'), world.character.background);
  $('char-goal').textContent = world.character.goal;

  const traits = $('char-traits');
  traits.innerHTML = '';
  world.character.traits.forEach((trait) => {
    const span = document.createElement('span');
    span.className = 'tag';
    span.textContent = trait;
    traits.appendChild(span);
  });

  const inventory = $('world-inventory');
  inventory.innerHTML = '';
  world.inventory.forEach((item) => {
    const li = document.createElement('li');
    const name = document.createElement('b');
    name.textContent = item.name;
    li.appendChild(name);
    if (item.description) li.append(` — ${item.description}`);
    inventory.appendChild(li);
  });

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
  if (data.usage) {
    $('usage-line').textContent =
      `запросов к API за сеанс: ${data.usage.calls}, токенов: ${data.usage.total_tokens}`;
  }
}

// ------------------------------------------------------------------ игра

/** Пороги те же, что в game/core/rules.py: игрок должен видеть, когда сюжет
 *  начнёт сопротивляться. */
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

function renderHud(game) {
  $('hud-location').textContent = game.location.name;
  $('hud-time').textContent =
    `День ${game.day} · ${game.time_of_day} · ход ${game.turn_number}`;

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

const REST_LABEL = { отдых: 'передышка', еда: 'перекус', сон: 'сон' };

/** Шкала симпатии из game/core/npc.py: те же границы, те же слова. */
function sympathyTier(value) {
  if (value >= 60) return { label: 'Предан', tone: 'best' };
  if (value >= 20) return { label: 'Дружелюбен', tone: 'good' };
  if (value >= -19) return { label: 'Нейтрален', tone: 'neutral' };
  if (value >= -59) return { label: 'Неприязнь', tone: 'bad' };
  return { label: 'Враждебен', tone: 'worst' };
}

/** Подсказка игроку: кто сейчас рядом и как к нему относится. */
function renderNpcs(npcs) {
  const box = $('hud-npcs');
  const present = (npcs || []).filter((npc) => npc.present);
  box.innerHTML = '';
  box.hidden = !present.length;

  present.forEach((npc) => {
    const tier = sympathyTier(npc.sympathy);
    const chip = document.createElement('div');
    chip.className = `npc npc-${tier.tone}`;
    chip.title = npc.role ? `${npc.role}. ${npc.description}` : npc.description;

    // Шкала расходится от середины: влево — неприязнь, вправо — симпатия.
    const width = Math.abs(npc.sympathy) / 2;
    const offset = npc.sympathy < 0 ? 50 - width : 50;

    chip.innerHTML =
      `<span class="npc-name">${npc.name}</span>` +
      `<span class="npc-tier">${tier.label}</span>` +
      `<span class="npc-bar"><i style="left:${offset}%;width:${width}%"></i></span>`;
    box.appendChild(chip);
  });
}

/** Строка «что изменилось» под ходом: показываем только ненулевое. */
function renderChanges(changes) {
  if (!changes || !changes.stats) return null;
  const parts = [];
  const { health, fatigue, minutes, rest } = changes.stats;
  if (rest && REST_LABEL[rest]) parts.push(`<span class="up">${REST_LABEL[rest]}</span>`);
  if (health) parts.push(`<span class="${health < 0 ? 'down' : 'up'}">здоровье ${health > 0 ? '+' : ''}${health}</span>`);
  if (fatigue) parts.push(`<span class="${fatigue > 0 ? 'down' : 'up'}">усталость ${fatigue > 0 ? '+' : ''}${fatigue}</span>`);
  if (minutes) parts.push(`прошло ${minutes} мин`);
  (changes.inventory?.added || []).forEach((name) => parts.push(`<span class="up">+ ${name}</span>`));
  (changes.inventory?.removed || []).forEach((name) => parts.push(`<span class="down">− ${name}</span>`));
  (changes.npcs || []).forEach((npc) => {
    if (!npc.delta) return;
    const sign = npc.delta > 0 ? '+' : '';
    parts.push(`<span class="${npc.delta > 0 ? 'up' : 'down'}">${npc.name} ${sign}${npc.delta}</span>`);
  });
  if (!parts.length) return null;

  const meta = document.createElement('div');
  meta.className = 'entry-meta';
  meta.innerHTML = parts.join('');
  return meta;
}

/** Подводит начало хода к верху экрана.
 *  Прыжок в самый низ сбивает чтение: новый текст должен начинаться там,
 *  где взгляд уже находится, а не убегать за нижний край. */
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
    if (turn.player_name) {
      const who = document.createElement('span');
      who.className = 'entry-who';
      who.textContent = turn.player_name;
      line.appendChild(who);
    }
    line.append(turn.player);
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

function renderSuggestions(actions) {
  const box = $('game-actions');
  box.innerHTML = '';
  (actions || []).forEach((action) => {
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
function renderGame(data) {
  state.game = data.state;
  state.journalNpcs = data.journal_npcs || [];
  if (data.revision !== undefined) state.revision = data.revision;
  const game = data.state;

  $('game-log').innerHTML = '';
  game.history.forEach((turn, index) => appendEntry(turn, null, index));

  renderHud(game);
  renderNpcs(game.npcs);
  renderSuggestions(game.suggested_actions);
  setNotice('game-error', '');
  $('game-over').hidden = !game.game_over;
  $('composer').hidden = game.game_over;
  if (data.usage) {
    $('game-usage').textContent =
      `запросов к API: ${data.usage.calls} · токенов: ${data.usage.total_tokens}`;
  }
}

/** Бой перехватывает управление: пока он идёт, обычный экран не показываем. */
function showGameOrCombat(data) {
  renderGame(data);
  if (data.combat) {
    renderCombat(data.combat);
    show('combat');
    return;
  }
  show('game');
  $('game-input').focus();
}

async function startGame() {
  try {
    showGameOrCombat(await api('/api/start', { method: 'POST' }));
  } catch (err) {
    setNotice('world-error', err.message);
  }
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
  if (state.playerName) {
    const who = document.createElement('span');
    who.className = 'entry-who';
    who.textContent = state.playerName;
    line.appendChild(who);
  }
  line.append(text);
  $('game-log').appendChild(line);
  // Ставим реплику игрока под шапку: ответ ведущего появится прямо под ней,
  // и читать можно будет с того же места, без прыжка вниз.
  anchorTo(line);

  try {
    const data = await api('/api/turn', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, player: state.playerName }),
    });
    state.game = data.state;
    const last = data.state.history[data.state.history.length - 1];

    appendEntry({ player: '', narrative: last.narrative, local: last.local }, data.changes);
    renderHud(data.state);
    renderNpcs(data.state.npcs);
    renderSuggestions(data.state.suggested_actions);
    $('game-over').hidden = !data.state.game_over;
    $('composer').hidden = data.state.game_over;
    if (data.usage) {
      $('game-usage').textContent =
        `запросов к API: ${data.usage.calls} · токенов: ${data.usage.total_tokens}`;
    }
    input.value = '';
    if (data.warning) setNotice('game-error', data.warning);
    if (data.revision !== undefined) state.revision = data.revision;

    // Модель объявила драку — управление переходит на боевой экран.
    if (data.combat) {
      renderCombat(data.combat);
      show('combat');
    }
  } catch (err) {
    // Ход не состоялся: убираем реплику игрока, состояние на сервере не менялось.
    line.remove();
    setNotice('game-error', err.message);
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

function renderCombat(combat) {
  state.combat = combat;

  $('combat-round').textContent = combat.finished ? 'бой окончен' : `раунд ${combat.round}`;
  renderProse($('combat-opening'), combat.opening);

  const enemy = combat.enemy;
  $('combat-enemy-name').textContent = enemy.name;
  $('combat-enemy-hp').textContent = `${enemy.hp} / ${enemy.max_hp}`;
  $('combat-enemy-bar').style.width = `${(enemy.hp / enemy.max_hp) * 100}%`;
  $('combat-enemy-atk').textContent = enemy.attack;
  $('combat-enemy-def').textContent = enemy.defense;
  $('combat-enemy-desc').textContent = enemy.description;

  const player = combat.player;
  $('combat-player-hp').textContent = `${player.hp} / ${player.max_hp}`;
  $('combat-player-bar').style.width = `${(player.hp / player.max_hp) * 100}%`;
  $('combat-player-bar').className =
    `bar-fill bar-health level-${healthLevel(Math.round((player.hp / player.max_hp) * 100))}`;
  $('combat-player-atk').textContent = player.attack;
  $('combat-player-def').textContent = player.defense;
  $('combat-player-weapon').textContent = player.weapon ? `в руках: ${player.weapon}` : '';

  $('combat-line').textContent = combat.line;
  $('combat-line').hidden = !combat.line;

  const log = $('combat-log');
  log.innerHTML = '';
  combat.log.forEach((entry) => {
    const row = document.createElement('div');
    row.className = 'row';
    row.innerHTML =
      `<span class="num">${entry.round}</span><span class="${entry.kind}">${entry.text}</span>`;
    log.appendChild(row);
  });
  log.scrollTop = log.scrollHeight;

  // Кнопка предмета знает, что именно пойдёт в ход.
  const itemButton = $('combat-item');
  const item = combat.items && combat.items[0];
  itemButton.disabled = !item;
  itemButton.textContent = item ? `Предмет: ${item.name}` : 'Предмет';

  $('combat-actions').hidden = combat.finished;
  $('combat-end').hidden = !combat.finished;
  $('combat-outcome').textContent = OUTCOME_TEXT[combat.outcome] || '';
  setNotice('combat-error', '');
}

async function combatAction(action) {
  if (state.busy) return;
  state.busy = true;
  document.querySelectorAll('#combat-actions .btn').forEach((b) => (b.disabled = true));
  try {
    const item = (state.combat.items && state.combat.items[0] || {}).name || '';
    const data = await api('/api/combat/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, item, player: state.playerName }),
    });
    renderCombat(data.combat);
  } catch (err) {
    setNotice('combat-error', err.message);
  } finally {
    state.busy = false;
    if (state.combat && !state.combat.finished) {
      document.querySelectorAll('#combat-actions .btn').forEach((b) => (b.disabled = false));
      $('combat-item').disabled = !(state.combat.items && state.combat.items.length);
    }
  }
}

async function combatFinish() {
  if (state.busy) return;
  state.busy = true;
  $('combat-end').hidden = true;
  $('game-thinking').hidden = false;
  show('game');
  try {
    const data = await api('/api/combat/finish', { method: 'POST' });
    state.combat = null;
    renderGame(data);
  } catch (err) {
    setNotice('combat-error', err.message);
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
    ['Время', `День ${game.day}, ${game.time_of_day} (прошло ${game.elapsed_text})`],
    ['Ходов сделано', game.turn_number],
  ];
  $('j-facts').innerHTML = facts
    .map(([key, value]) => `<dt>${key}</dt><dd>${value}</dd>`)
    .join('');

  renderProse($('j-background'), game.character_background);
  $('j-goal').textContent = game.character_goal;
  $('j-traits').innerHTML = (game.character_traits || [])
    .map((trait) => `<span class="tag">${trait}</span>`)
    .join('');

  const chronicle = $('j-chronicle');
  chronicle.innerHTML = '';
  // Хроника длинная — показываем последнее сверху, так полезнее.
  [...(game.chronicle || [])].reverse().forEach((entry) => {
    const li = document.createElement('li');
    li.textContent = entry;
    chronicle.appendChild(li);
  });

  const inventory = $('j-inventory');
  inventory.innerHTML = '';
  if (!game.inventory.length) {
    inventory.innerHTML = '<li>Карманы пусты.</li>';
  }
  game.inventory.forEach((item) => {
    const li = document.createElement('li');
    const name = document.createElement('b');
    name.textContent = item.name;
    li.appendChild(name);
    if (item.description) li.append(` — ${item.description}`);
    inventory.appendChild(li);
  });

  const people = $('j-people');
  const list = state.journalNpcs || [];
  people.innerHTML = '';
  $('j-people-hint').textContent = list.length
    ? 'Только те, кто что-то значит: случайные встречные сюда не попадают.'
    : 'Пока никого, кто стоил бы отдельной записи.';

  list.forEach((npc) => {
    const tier = sympathyTier(npc.sympathy);
    const card = document.createElement('div');
    card.className = `person npc-${tier.tone}`;
    const seen =
      npc.scenes > 1 ? `встреч: ${npc.scenes}, последняя на ходу ${npc.last_seen_turn}`
                     : `встречен на ходу ${npc.first_seen_turn}`;
    card.innerHTML =
      '<div class="person-top">' +
      `<span><span class="person-name">${npc.name}</span>` +
      (npc.role ? ` <span class="person-role">— ${npc.role}</span>` : '') +
      '</span>' +
      `<span class="person-tier">${tier.label} (${npc.sympathy > 0 ? '+' : ''}${npc.sympathy})</span>` +
      '</div>' +
      (npc.description ? `<div class="person-desc">${npc.description}</div>` : '') +
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

function slotTitle(slot) {
  return SLOT_TITLE[slot.slot] || `Слот ${slot.slot}`;
}

function renderSaves(list, mode) {
  state.savesMode = mode;
  $('saves-title').textContent = mode === 'save' ? 'Сохранить игру' : 'Загрузить игру';
  $('saves-hint').textContent =
    mode === 'save'
      ? 'Автосохранение пишется само после каждого хода — в него записать нельзя.'
      : 'Выбери, с какого места продолжить.';

  const box = $('saves-list');
  box.innerHTML = '';

  list.forEach((slot) => {
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
        `<div class="slot-name">${slot.title || 'Без названия'}` +
        (slot.auto ? ' <span class="slot-auto">авто</span>' : '') +
        '</div>' +
        `<div class="slot-info">${slot.character}, ход ${slot.turn}, день ${slot.day}, ` +
        `здоровье ${slot.health} · ${slot.saved_at.replace('T', ' ')} ${tags.join(' ')}</div>`;
    } else if (slot.broken) {
      main.innerHTML = `<div class="slot-name">${slotTitle(slot)}</div>` +
        '<div class="slot-info">файл повреждён</div>';
    } else {
      main.innerHTML = `<div class="slot-name">${slotTitle(slot)}</div>` +
        '<div class="slot-info">пусто</div>';
    }
    row.appendChild(main);

    const buttons = document.createElement('div');
    buttons.className = 'slot-buttons';

    if (mode === 'save' && !slot.auto) {
      const save = document.createElement('button');
      save.className = 'btn btn-main';
      save.textContent = slot.exists ? 'Перезаписать' : 'Сохранить';
      save.addEventListener('click', () => saveToSlot(slot.slot));
      buttons.appendChild(save);
    }
    if (slot.exists && !slot.broken) {
      const load = document.createElement('button');
      load.className = mode === 'save' ? 'btn' : 'btn btn-main';
      load.textContent = 'Загрузить';
      load.addEventListener('click', () => loadSlot(slot.slot));
      buttons.appendChild(load);
    }
    if (slot.exists) {
      const remove = document.createElement('button');
      remove.className = 'btn btn-quiet';
      remove.textContent = 'Удалить';
      remove.addEventListener('click', () => deleteSlot(slot.slot));
      buttons.appendChild(remove);
    }

    row.appendChild(buttons);
    box.appendChild(row);
  });

  setNotice('saves-error', '');
  $('saves').hidden = false;
}

async function openSaves(mode) {
  try {
    const data = await api('/api/saves');
    renderSaves(data.saves, mode);
  } catch (err) {
    setNotice('menu-error', err.message);
  }
}

async function saveToSlot(slot) {
  try {
    const data = await api(`/api/saves/${slot}`, { method: 'POST' });
    renderSaves(data.saves, 'save');
  } catch (err) {
    setNotice('saves-error', err.message);
  }
}

async function deleteSlot(slot) {
  try {
    const data = await api(`/api/saves/${slot}`, { method: 'DELETE' });
    renderSaves(data.saves, state.savesMode);
    loadState();
  } catch (err) {
    setNotice('saves-error', err.message);
  }
}

async function loadSlot(slot) {
  try {
    const data = await api(`/api/saves/${slot}/load`, { method: 'POST' });
    $('saves').hidden = true;
    showGameOrCombat(data);
  } catch (err) {
    setNotice('saves-error', err.message);
  }
}

// ----------------------------------------------------- код доступа

async function sendCode() {
  const input = $('code-input');
  const code = input.value.trim();
  if (!code) {
    input.focus();
    return;
  }
  try {
    await api('/api/access', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    setNotice('code-error', '');
    input.value = '';
    show('menu');
    await loadState();
  } catch (err) {
    setNotice('code-error', err.message);
    input.select();
  }
}

// ------------------------------------------------- совместная игра

const SYNC_INTERVAL = 2500;

function currentScreen() {
  return SCREENS.find((name) => !$(`screen-${name}`).hidden);
}

function renderPlayers(sync) {
  const row = $('hud-players');
  if (!sync.coop) {
    // Обычный режим: игра у каждого своя, показывать некого.
    row.hidden = true;
    return;
  }
  const others = (sync.players || []).filter((name) => name !== state.playerName);
  // Строка нужна, только когда за партией кто-то ещё.
  if (!others.length && !sync.busy_by) {
    row.hidden = true;
    return;
  }
  row.hidden = false;
  const chips = (sync.players || []).map((name) => {
    const acting = sync.busy_by && sync.busy_by === name;
    return `<span class="player-chip${acting ? ' acting' : ''}">${name}${acting ? ' — ходит…' : ''}</span>`;
  });
  row.innerHTML = `<span>За столом:</span>${chips.join('')}`;
}

/** Подтягивает чужой ход, не сбивая чтение: экран остаётся на месте,
 *  а новый текст подводится к верху, как и собственный ход. */
async function pullUpdate() {
  const wasScreen = currentScreen();
  const seenTurns = state.game ? state.game.history.length : 0;
  const scrollBefore = window.scrollY;

  const data = await api('/api/game');
  const nowCombat = Boolean(data.combat);
  const staying = (wasScreen === 'game' && !nowCombat) || (wasScreen === 'combat' && nowCombat);

  if (!staying) {
    showGameOrCombat(data);
    return;
  }

  if (nowCombat) {
    renderGame(data);
    renderCombat(data.combat);
    return;
  }

  renderGame(data);
  const fresh = data.state.history.length - seenTurns;
  if (fresh > 0) {
    anchorTo($('game-log').querySelector(`[data-turn="${seenTurns}"]`));
  } else {
    window.scrollTo(0, scrollBefore);
  }
}

async function syncTick() {
  try {
    const query = state.playerName ? `?player=${encodeURIComponent(state.playerName)}` : '';
    if (!$('screen-code').hidden) return; // ждём кода, сервер всё равно откажет
    const sync = await api(`/api/sync${query}`);
    state.players = sync.players || [];
    state.coop = Boolean(sync.coop);
    $('player-name').hidden = !state.coop;
    renderPlayers(sync);

    const screen = currentScreen();
    const watching = screen === 'game' || screen === 'combat';
    // Пока идёт собственный ход, чужие обновления подождут: иначе ответ
    // придёт в уже перерисованный экран.
    if (watching && !state.busy && sync.revision !== state.revision) {
      state.revision = sync.revision;
      await pullUpdate();
    } else if (!watching) {
      state.revision = sync.revision;
    }
  } catch (err) {
    /* сервер мог уснуть или остановиться — молча ждём следующего круга */
  }
}

function setPlayerName(name) {
  state.playerName = name.trim().slice(0, 40);
  try {
    localStorage.setItem('playerName', state.playerName);
  } catch (err) {
    /* приватный режим браузера — имя проживёт до перезагрузки */
  }
}

function restorePlayerName() {
  let saved = '';
  try {
    saved = localStorage.getItem('playerName') || '';
  } catch (err) {
    saved = '';
  }
  state.playerName = saved;
  $('player-name').value = saved;
  $('player-name').addEventListener('change', (event) => setPlayerName(event.target.value));
}

// -------------------------------------------------------------- действия

const ACTIONS = {
  'new-game': () => {
    setNotice('new-error', '');
    show('new');
  },
  models: () => {
    renderModels();
    show('models');
  },
  'back-menu': () => {
    show('menu');
    loadState(); // обновляем доступность «Продолжить»
  },
  generate: () => {
    state.inputs.world = $('input-world').value;
    state.inputs.character = $('input-character').value;
    generateWorld();
  },
  regenerate: () => generateWorld(),
  play: () => startGame(),
  act: () => sendTurn(),
  'send-code': () => sendCode(),
  journal: () => {
    renderJournal();
    switchTab('character');
    $('journal').hidden = false;
  },
  'journal-close': () => {
    $('journal').hidden = true;
  },
  saves: () => openSaves('save'),
  load: () => openSaves('load'),
  'saves-close': () => {
    $('saves').hidden = true;
  },
  hit: () => combatAction('attack'),
  guard: () => combatAction('defend'),
  'use-item': () => combatAction('item'),
  run: () => combatAction('flee'),
  'combat-finish': () => combatFinish(),
  continue: async () => {
    try {
      showGameOrCombat(await api('/api/game'));
    } catch (err) {
      setNotice('menu-error', err.message);
    }
  },
  quit: async () => {
    show('bye');
    try {
      await fetch('/api/shutdown', { method: 'POST' });
    } catch (err) {
      /* сервер уже погас — так и должно быть */
    }
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
  if (event.key === 'Enter' && !$('screen-code').hidden) {
    sendCode();
    return;
  }
  if (event.key !== 'Escape') return;
  $('journal').hidden = true;
  $('saves').hidden = true;
});

// Ctrl+Enter отправляет ход: писать длинные действия удобнее с переносами.
document.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
    if (!$('screen-game').hidden) sendTurn();
  }
});

// Возврат в меню из игры не теряет партию — «Продолжить» вернёт обратно.
restorePlayerName();
loadState();
syncTick();
setInterval(syncTick, SYNC_INTERVAL);
