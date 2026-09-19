/**
 * Клиент Gemini прямо из браузера.
 *
 * Сервера в цепочке нет: страница сама ходит в API Google. Это возможно,
 * потому что Gemini отдаёт нужные CORS-заголовки для обращений со страницы.
 *
 * Принципы те же, что были на сервере:
 *   * один ход игрока = один запрос;
 *   * ответ приходит строгим JSON (responseSchema), а не свободным текстом;
 *   * повтор максимум один, и только там, где он имеет смысл;
 *   * блокировка фильтрами — не ошибка, а отдельная ситуация без автоповтора.
 */

import { API_BASE, activeKey } from './config.js';

const SAFETY_CATEGORIES = [
  'HARM_CATEGORY_HARASSMENT',
  'HARM_CATEGORY_HATE_SPEECH',
  'HARM_CATEGORY_SEXUALLY_EXPLICIT',
  'HARM_CATEGORY_DANGEROUS_CONTENT',
  'HARM_CATEGORY_CIVIC_INTEGRITY',
];

// Причины остановки, которые означают срабатывание фильтра.
const BLOCKED_FINISH_REASONS = new Set(['SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII']);

const RETRY_DELAY = 2000;

/** Ошибка с готовым текстом для игрока: трейсбек ему видеть незачем. */
export class GameApiError extends Error {
  constructor(userMessage, detail = '', kind = 'other') {
    super(detail || userMessage);
    this.userMessage = userMessage;
    this.detail = detail;
    this.kind = kind;
  }
}

export const ERRORS = {
  noKey: () =>
    new GameApiError(
      'Не задан ключ Gemini. Введи свой ключ — его можно получить бесплатно ' +
        'на aistudio.google.com.',
      '',
      'no-key'
    ),
  auth: (detail) =>
    new GameApiError('Ключ отклонён Google. Проверь его или введи другой.', detail, 'auth'),
  location: (detail) =>
    new GameApiError(
      'Google не обслуживает Gemini из этой страны. Включи VPN или смени ' +
        'сервер VPN на другую страну — и повтори.',
      detail,
      'location'
    ),
  rate: (detail) =>
    new GameApiError(
      'Превышен лимит запросов. Подожди немного и повтори действие.',
      detail,
      'rate'
    ),
  model: (detail) =>
    new GameApiError('Выбранная модель недоступна. Выбери другую в меню.', detail, 'model'),
  safety: (detail) =>
    new GameApiError(
      'Сцена оборвалась: нейросеть отказалась продолжать. Попробуй описать ' +
        'действие другими словами.',
      detail,
      'safety'
    ),
  network: (detail) =>
    new GameApiError('Нет связи с сервером нейросети. Проверь интернет.', detail, 'network'),
  truncated: (detail) =>
    new GameApiError(
      'Ответ нейросети оборвался на середине. Повтори действие — или опиши его короче.',
      detail,
      'truncated'
    ),
  invalid: (detail) =>
    new GameApiError(
      'Нейросеть вернула ответ, который не удалось разобрать. Повтори действие.',
      detail,
      'invalid'
    ),
  server: (detail) =>
    new GameApiError('Сервер нейросети временно недоступен.', detail, 'server'),
};

/** Учёт расхода: сколько запросов и токенов ушло за сеанс. */
export const usage = {
  calls: 0,
  failed: 0,
  retries: 0,
  promptTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  byPurpose: {},

  record(purpose, ok, meta = {}, attempt = 1) {
    this.calls += 1;
    if (!ok) this.failed += 1;
    if (attempt > 1) this.retries += 1;
    this.promptTokens += meta.promptTokenCount || 0;
    this.outputTokens += meta.candidatesTokenCount || 0;
    this.totalTokens += meta.totalTokenCount || 0;
    this.byPurpose[purpose] = (this.byPurpose[purpose] || 0) + 1;
  },
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Некоторым ключам BLOCK_NONE недоступен. Если API его отверг — переключаемся
// на самый мягкий из разрешённых и больше не пробуем.
let safetyThreshold = 'BLOCK_NONE';

function safetySettings() {
  return SAFETY_CATEGORIES.map((category) => ({ category, threshold: safetyThreshold }));
}

function errorFromResponse(status, message) {
  const lowered = (message || '').toLowerCase();
  if (lowered.includes('location is not supported')) return ERRORS.location(message);
  if (status === 401 || status === 403) return ERRORS.auth(message);
  if (status === 429) return ERRORS.rate(message);
  if (status === 404) return ERRORS.model(message);
  if (status === 400 && lowered.includes('api key')) return ERRORS.auth(message);
  if (status === 400) {
    return new GameApiError('Нейросеть отклонила запрос.', message, 'bad-request');
  }
  if (status >= 500) return ERRORS.server(message);
  return new GameApiError('Что-то пошло не так при обращении к нейросети.', message);
}

function buildPayload({ contents, systemInstruction, schema, temperature, maxOutputTokens }) {
  const generationConfig = { temperature, maxOutputTokens };
  if (schema) {
    generationConfig.responseMimeType = 'application/json';
    generationConfig.responseSchema = schema;
  }
  const payload = { contents, generationConfig, safetySettings: safetySettings() };
  if (systemInstruction) payload.systemInstruction = { parts: [{ text: systemInstruction }] };
  return payload;
}

/** Достаёт текст ответа и превращает отказы фильтров в отдельную ошибку. */
function extractText(data) {
  const blockReason = data.promptFeedback?.blockReason;
  if (blockReason) throw ERRORS.safety(`promptFeedback.blockReason=${blockReason}`);

  const candidate = (data.candidates || [])[0];
  if (!candidate) throw ERRORS.invalid('пустой список candidates');

  const finishReason = candidate.finishReason || '';
  const text = (candidate.content?.parts || [])
    .map((part) => part.text || '')
    .join('')
    .trim();

  if (BLOCKED_FINISH_REASONS.has(finishReason)) {
    throw ERRORS.safety(`finishReason=${finishReason}`);
  }
  if (finishReason === 'MAX_TOKENS' && !text) {
    throw ERRORS.truncated('finishReason=MAX_TOKENS, текста нет');
  }
  if (!text) throw ERRORS.invalid(`пустой текст, finishReason=${finishReason}`);
  return text;
}

/**
 * Разбор JSON. responseSchema почти всегда даёт чистый JSON, но
 * подстраховываемся от markdown-обёрток и мусора по краям.
 */
function parseJson(text) {
  let cleaned = text.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.slice(cleaned.indexOf('\n') + 1);
    if (cleaned.trimEnd().endsWith('```')) {
      cleaned = cleaned.trimEnd().slice(0, -3);
    }
    cleaned = cleaned.trim();
  }
  try {
    const parsed = JSON.parse(cleaned);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    throw ERRORS.invalid('ожидался объект JSON');
  } catch (err) {
    if (err instanceof GameApiError) throw err;
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start === -1 || end <= start) throw ERRORS.invalid(`не JSON: ${cleaned.slice(0, 200)}`);
    try {
      return JSON.parse(cleaned.slice(start, end + 1));
    } catch (inner) {
      throw ERRORS.invalid(`битый JSON: ${inner.message}`);
    }
  }
}

async function postGenerate(model, payload, purpose, attempt) {
  const key = activeKey();
  if (!key) throw ERRORS.noKey();

  let response;
  try {
    response = await fetch(`${API_BASE}/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    usage.record(purpose, false, {}, attempt);
    throw ERRORS.network(String(err));
  }

  if (!response.ok) {
    let message = '';
    try {
      message = (await response.json())?.error?.message || '';
    } catch (err) {
      message = `HTTP ${response.status}`;
    }
    usage.record(purpose, false, {}, attempt);
    throw errorFromResponse(response.status, message);
  }

  const data = await response.json();
  usage.record(purpose, true, data.usageMetadata || {}, attempt);
  return data;
}

async function generate({
  model,
  contents,
  systemInstruction,
  schema,
  purpose,
  temperature = 0.95,
  maxOutputTokens = 3000,
}) {
  const payload = buildPayload({
    contents,
    systemInstruction,
    schema,
    temperature,
    maxOutputTokens,
  });

  let attempt = 1;
  for (;;) {
    try {
      return extractText(await postGenerate(model, payload, purpose, attempt));
    } catch (err) {
      const detail = (err.detail || '').toLowerCase();
      // Ключ без доступа к BLOCK_NONE: один раз смягчаем порог и пробуем снова.
      if (
        safetyThreshold === 'BLOCK_NONE' &&
        detail.includes('safety') &&
        detail.includes('block_none')
      ) {
        safetyThreshold = 'BLOCK_ONLY_HIGH';
        payload.safetySettings = safetySettings();
        continue;
      }
      // Повторяем только то, что может пройти со второго раза.
      const retryable = ['network', 'rate', 'server'].includes(err.kind);
      if (retryable && attempt === 1) {
        attempt += 1;
        await sleep(RETRY_DELAY);
        continue;
      }
      throw err;
    }
  }
}

/**
 * Основной способ обращения к модели: один запрос — один JSON-ответ.
 *
 * Если разобрать ответ не удалось, делаем ровно один повтор с уточнением.
 * При второй неудаче ошибка уходит наружу, и вызывающий код не применяет
 * никаких изменений состояния.
 */
export async function generateJson({
  model,
  schema,
  userText,
  systemInstruction = '',
  purpose = 'turn',
  temperature = 0.95,
  maxOutputTokens = 3000,
}) {
  const contents = [{ role: 'user', parts: [{ text: userText }] }];
  const text = await generate({
    model,
    contents,
    systemInstruction,
    schema,
    purpose,
    temperature,
    maxOutputTokens,
  });

  try {
    return parseJson(text);
  } catch (err) {
    if (err.kind !== 'invalid') throw err;
    contents.push({ role: 'model', parts: [{ text }] });
    contents.push({
      role: 'user',
      parts: [
        {
          text:
            'Ответ не является корректным JSON. Повтори тот же ответ строго по ' +
            'схеме: только объект JSON, без пояснений, без markdown-обёртки.',
        },
      ],
    });
    const retried = await generate({
      model,
      contents,
      systemInstruction,
      schema,
      purpose: `${purpose}:json-fix`,
      temperature: 0.2,
      maxOutputTokens,
    });
    return parseJson(retried);
  }
}

/** Проверка ключа: заодно показывает, какие модели ему доступны. */
export async function listModels() {
  const key = activeKey();
  if (!key) throw ERRORS.noKey();
  let response;
  try {
    response = await fetch(`${API_BASE}/models?pageSize=200`, {
      headers: { 'x-goog-api-key': key },
    });
  } catch (err) {
    throw ERRORS.network(String(err));
  }
  if (!response.ok) {
    let message = '';
    try {
      message = (await response.json())?.error?.message || '';
    } catch (err) {
      message = `HTTP ${response.status}`;
    }
    throw errorFromResponse(response.status, message);
  }
  const data = await response.json();
  return (data.models || [])
    .filter((item) => (item.supportedGenerationMethods || []).includes('generateContent'))
    .map((item) => String(item.name || '').replace(/^models\//, ''));
}
