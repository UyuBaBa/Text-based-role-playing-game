"""Клиент Gemini REST API.

Всё общение с нейросетью идёт только через этот модуль. Наружу отдаются либо
разобранные данные, либо исключение из errors.py с понятным текстом.

Принципы (см. README):
  * один ход игрока = один запрос;
  * ответ приходит строгим JSON (responseSchema), а не свободным текстом;
  * повтор максимум один, и только там, где он имеет смысл;
  * блокировка фильтрами — не ошибка, а отдельная ситуация без автоповтора.
"""

from __future__ import annotations

import json
import time
from typing import Any

import requests

from ..config import Settings
from .errors import (
    AuthError,
    GeminiError,
    InvalidResponseError,
    LocationBlockedError,
    MissingApiKeyError,
    ModelUnavailableError,
    NetworkError,
    RateLimitError,
    SafetyBlockedError,
    TruncatedResponseError,
)
from .usage_log import UsageLog

SAFETY_CATEGORIES = (
    "HARM_CATEGORY_HARASSMENT",
    "HARM_CATEGORY_HATE_SPEECH",
    "HARM_CATEGORY_SEXUALLY_EXPLICIT",
    "HARM_CATEGORY_DANGEROUS_CONTENT",
    "HARM_CATEGORY_CIVIC_INTEGRITY",
)

# Причины остановки, которые означают срабатывание фильтра.
BLOCKED_FINISH_REASONS = {"SAFETY", "PROHIBITED_CONTENT", "BLOCKLIST", "SPII"}


def normalize_model_id(model: str) -> str:
    """'models/gemini-2.5-flash-lite' -> 'gemini-2.5-flash-lite'."""
    return model.split("/", 1)[1] if model.startswith("models/") else model


class GeminiClient:
    def __init__(self, settings: Settings, usage_log: UsageLog | None = None) -> None:
        self.settings = settings
        self.usage = usage_log or UsageLog()
        self._session = requests.Session()
        self._models_cache: list[dict] | None = None
        # Некоторым ключам BLOCK_NONE недоступен. Если API его отверг —
        # переключаемся на самый мягкий из разрешённых и больше не пробуем.
        self._safety_threshold = (
            "BLOCK_NONE" if settings.safety_mode == "permissive" else "BLOCK_ONLY_HIGH"
        )

    # ------------------------------------------------------------------ сеть

    def _headers(self) -> dict[str, str]:
        if not self.settings.has_key:
            raise MissingApiKeyError()
        return {
            "x-goog-api-key": self.settings.api_key,
            "Content-Type": "application/json",
        }

    def _raise_for_status(self, response: requests.Response) -> None:
        if response.ok:
            return
        try:
            message = response.json().get("error", {}).get("message", "")
        except ValueError:
            message = response.text[:300]

        code = response.status_code
        if "location is not supported" in message.lower():
            raise LocationBlockedError(message)
        if code in (401, 403):
            raise AuthError(message)
        if code == 429:
            raise RateLimitError(message)
        if code == 404:
            raise ModelUnavailableError(message)
        if code == 400 and "api key" in message.lower():
            raise AuthError(message)
        if code == 400:
            raise GeminiError(
                message,
                user_message="Нейросеть отклонила запрос. Подробности в logs/api_usage.jsonl.",
            )
        if code >= 500:
            raise GeminiError(message, user_message="Сервер нейросети временно недоступен.")
        raise GeminiError(message)

    def _get(self, path: str, params: dict | None = None, *, purpose: str = "get") -> dict:
        url = f"{self.settings.api_base}/{path.lstrip('/')}"
        started = time.monotonic()
        try:
            response = self._session.get(
                url,
                headers=self._headers(),
                params=params,
                timeout=(10, self.settings.request_timeout),
            )
        except requests.RequestException as exc:
            self.usage.record(
                purpose=purpose,
                model="-",
                ok=False,
                seconds=time.monotonic() - started,
                error=f"network: {exc}",
            )
            raise NetworkError(str(exc)) from exc

        seconds = time.monotonic() - started
        try:
            self._raise_for_status(response)
        except GeminiError as exc:
            self.usage.record(
                purpose=purpose,
                model="-",
                ok=False,
                seconds=seconds,
                error=f"{response.status_code}: {exc.detail[:200]}",
            )
            raise

        self.usage.record(purpose=purpose, model="-", ok=True, seconds=seconds)
        return response.json()

    # ---------------------------------------------------------------- модели

    def list_models(self, *, refresh: bool = False) -> list[dict]:
        """Один запрос при старте: какие модели реально доступны по ключу.

        Возвращает список словарей с ключами id, display_name, input_limit,
        output_limit — только для моделей, умеющих generateContent.
        """
        if self._models_cache is not None and not refresh:
            return self._models_cache

        models: list[dict] = []
        page_token: str | None = None
        while True:
            params: dict[str, Any] = {"pageSize": 200}
            if page_token:
                params["pageToken"] = page_token
            data = self._get("models", params, purpose="models.list")
            for item in data.get("models", []):
                if "generateContent" not in item.get("supportedGenerationMethods", []):
                    continue
                models.append(
                    {
                        "id": normalize_model_id(item.get("name", "")),
                        "display_name": item.get("displayName", ""),
                        "input_limit": item.get("inputTokenLimit"),
                        "output_limit": item.get("outputTokenLimit"),
                    }
                )
            page_token = data.get("nextPageToken")
            if not page_token:
                break

        self._models_cache = models
        return models

    # -------------------------------------------------------------- генерация

    def _safety_settings(self) -> list[dict]:
        return [
            {"category": category, "threshold": self._safety_threshold}
            for category in SAFETY_CATEGORIES
        ]

    def _build_payload(
        self,
        *,
        contents: list[dict],
        system_instruction: str | None,
        schema: dict | None,
        temperature: float,
        max_output_tokens: int,
    ) -> dict:
        generation_config: dict[str, Any] = {
            "temperature": temperature,
            "maxOutputTokens": max_output_tokens,
        }
        if schema is not None:
            generation_config["responseMimeType"] = "application/json"
            generation_config["responseSchema"] = schema

        payload: dict[str, Any] = {
            "contents": contents,
            "generationConfig": generation_config,
            "safetySettings": self._safety_settings(),
        }
        if system_instruction:
            payload["systemInstruction"] = {"parts": [{"text": system_instruction}]}
        return payload

    def _post_generate(self, model: str, payload: dict, purpose: str, attempt: int) -> dict:
        url = f"{self.settings.api_base}/models/{model}:generateContent"
        started = time.monotonic()
        try:
            response = self._session.post(
                url,
                headers=self._headers(),
                json=payload,
                timeout=(10, self.settings.request_timeout),
            )
        except requests.RequestException as exc:
            self.usage.record(
                purpose=purpose,
                model=model,
                ok=False,
                seconds=time.monotonic() - started,
                attempt=attempt,
                error=f"network: {exc}",
            )
            raise NetworkError(str(exc)) from exc

        seconds = time.monotonic() - started
        if not response.ok:
            try:
                self._raise_for_status(response)
            except GeminiError as exc:
                self.usage.record(
                    purpose=purpose,
                    model=model,
                    ok=False,
                    seconds=seconds,
                    attempt=attempt,
                    error=f"{response.status_code}: {exc.detail[:200]}",
                )
                raise

        data = response.json()
        self.usage.record(
            purpose=purpose,
            model=model,
            ok=True,
            seconds=seconds,
            usage=data.get("usageMetadata"),
            attempt=attempt,
        )
        return data

    @staticmethod
    def _extract_text(data: dict) -> str:
        """Достаёт текст ответа и превращает отказы фильтров в SafetyBlockedError."""
        block_reason = (data.get("promptFeedback") or {}).get("blockReason")
        if block_reason:
            raise SafetyBlockedError(f"promptFeedback.blockReason={block_reason}")

        candidates = data.get("candidates") or []
        if not candidates:
            raise InvalidResponseError("пустой список candidates")

        candidate = candidates[0]
        finish_reason = candidate.get("finishReason", "")
        parts = (candidate.get("content") or {}).get("parts") or []
        text = "".join(part.get("text", "") for part in parts).strip()

        if finish_reason in BLOCKED_FINISH_REASONS:
            raise SafetyBlockedError(f"finishReason={finish_reason}")
        if finish_reason == "MAX_TOKENS" and not text:
            raise TruncatedResponseError("finishReason=MAX_TOKENS, текста нет")
        if not text:
            raise InvalidResponseError(f"пустой текст, finishReason={finish_reason!r}")
        return text

    @staticmethod
    def _parse_json(text: str) -> dict:
        """Разбор JSON. responseSchema почти всегда даёт чистый JSON, но
        подстраховываемся от ```json-обёрток и мусора по краям."""
        cleaned = text.strip()
        if cleaned.startswith("```"):
            cleaned = cleaned.split("\n", 1)[-1]
            if cleaned.rstrip().endswith("```"):
                cleaned = cleaned.rstrip()[:-3]
        cleaned = cleaned.strip()
        try:
            parsed = json.loads(cleaned)
        except json.JSONDecodeError:
            start, end = cleaned.find("{"), cleaned.rfind("}")
            if start == -1 or end <= start:
                raise InvalidResponseError(f"не JSON: {cleaned[:200]}")
            try:
                parsed = json.loads(cleaned[start : end + 1])
            except json.JSONDecodeError as exc:
                raise InvalidResponseError(f"битый JSON: {exc}") from exc
        if not isinstance(parsed, dict):
            raise InvalidResponseError("ожидался объект JSON")
        return parsed

    def _generate(
        self,
        *,
        model: str,
        contents: list[dict],
        system_instruction: str | None,
        schema: dict | None,
        purpose: str,
        temperature: float,
        max_output_tokens: int,
    ) -> str:
        model = normalize_model_id(model)
        payload = self._build_payload(
            contents=contents,
            system_instruction=system_instruction,
            schema=schema,
            temperature=temperature,
            max_output_tokens=max_output_tokens,
        )

        attempt = 1
        while True:
            try:
                data = self._post_generate(model, payload, purpose, attempt)
                return self._extract_text(data)
            except GeminiError as exc:
                # Ключ без доступа к BLOCK_NONE: один раз смягчаем порог и пробуем снова.
                if (
                    self._safety_threshold == "BLOCK_NONE"
                    and "safety" in exc.detail.lower()
                    and "block_none" in exc.detail.lower()
                ):
                    self._safety_threshold = "BLOCK_ONLY_HIGH"
                    payload["safetySettings"] = self._safety_settings()
                    continue
                # Повторяем только то, что может пройти со второго раза.
                retryable = isinstance(exc, (NetworkError, RateLimitError)) or (
                    "временно недоступен" in exc.user_message
                )
                if retryable and attempt <= self.settings.max_retries:
                    attempt += 1
                    time.sleep(self.settings.retry_delay)
                    continue
                raise

    def generate_json(
        self,
        *,
        model: str,
        schema: dict,
        user_text: str,
        system_instruction: str | None = None,
        purpose: str = "turn",
        temperature: float = 0.9,
        max_output_tokens: int = 4096,
    ) -> dict:
        """Основной способ обращения к модели: один запрос — один JSON-ответ.

        Если разобрать ответ не удалось, делаем ровно один повтор с уточнением.
        Второй неудачи быть не должно; если она случилась — наружу уходит
        InvalidResponseError, и вызывающий код не применяет никаких изменений
        состояния.
        """
        contents = [{"role": "user", "parts": [{"text": user_text}]}]
        text = self._generate(
            model=model,
            contents=contents,
            system_instruction=system_instruction,
            schema=schema,
            purpose=purpose,
            temperature=temperature,
            max_output_tokens=max_output_tokens,
        )
        try:
            return self._parse_json(text)
        except InvalidResponseError:
            contents.append({"role": "model", "parts": [{"text": text}]})
            contents.append(
                {
                    "role": "user",
                    "parts": [
                        {
                            "text": "Ответ не является корректным JSON. "
                            "Повтори тот же ответ строго по схеме: только объект JSON, "
                            "без пояснений, без markdown-обёртки."
                        }
                    ],
                }
            )
            retry_text = self._generate(
                model=model,
                contents=contents,
                system_instruction=system_instruction,
                schema=schema,
                purpose=f"{purpose}:json-fix",
                temperature=0.2,
                max_output_tokens=max_output_tokens,
            )
            return self._parse_json(retry_text)

    def generate_text(
        self,
        *,
        model: str,
        user_text: str,
        system_instruction: str | None = None,
        purpose: str = "text",
        temperature: float = 0.9,
        max_output_tokens: int = 2048,
    ) -> str:
        contents = [{"role": "user", "parts": [{"text": user_text}]}]
        return self._generate(
            model=model,
            contents=contents,
            system_instruction=system_instruction,
            schema=None,
            purpose=purpose,
            temperature=temperature,
            max_output_tokens=max_output_tokens,
        )
