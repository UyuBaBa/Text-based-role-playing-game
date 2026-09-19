/**
 * Настройки игры.
 *
 * ПРО КЛЮЧ. Каждый игрок вводит свой ключ Gemini при первом заходе. Ключ
 * лежит в его браузере и никуда больше не отправляется — ни на какой сервер,
 * ни в этот репозиторий.
 *
 * Так сделано не из лени, а потому что иначе не выходит: страница статическая,
 * спрятать в ней общий ключ негде. Новые ключи Gemini (те, что начинаются
 * на «AQ.») нельзя ограничить по адресу сайта, а Google вдобавок сам ищет
 * утёкшие ключи и быстро их отключает. Зашитый в страницу ключ прожил бы
 * недолго и утянул бы за собой всю игру.
 *
 * Поле apiKey ниже оставлено на случай, если игра крутится где-то закрыто
 * (например, на своей машине) и делиться ссылкой не надо. Для публичного
 * сайта оно должно оставаться пустым.
 */

export const CONFIG = {
  // Общий ключ. Для публичного сайта — всегда пусто.
  apiKey: '',

  // Модель по умолчанию и то, что можно выбрать в меню.
  defaultModel: 'gemini-3.5-flash-lite',
  models: [
    { id: 'gemini-3.5-flash-lite', title: 'Gemini 3.5 Flash-Lite' },
    { id: 'gemini-3.1-flash-lite', title: 'Gemini 3.1 Flash-Lite' },
    { id: 'gemini-2.5-flash-lite', title: 'Gemini 2.5 Flash-Lite' },
  ],
};

export const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

const KEY_STORAGE = 'rpg.apiKey';

/** Ключ игрока из его браузера. */
export function ownKey() {
  try {
    return localStorage.getItem(KEY_STORAGE) || '';
  } catch (err) {
    // Приватный режим или запрет на хранилище: ключ проживёт до перезагрузки.
    return memoryKey;
  }
}

let memoryKey = '';

export function setOwnKey(key) {
  memoryKey = (key || '').trim();
  try {
    if (memoryKey) localStorage.setItem(KEY_STORAGE, memoryKey);
    else localStorage.removeItem(KEY_STORAGE);
  } catch (err) {
    /* останется только в памяти вкладки */
  }
}

export function activeKey() {
  return ownKey() || CONFIG.apiKey;
}

export function hasKey() {
  return Boolean(activeKey());
}
