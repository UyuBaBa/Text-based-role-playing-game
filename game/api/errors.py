"""Ошибки слоя API.

Правило: наружу (в интерфейс) уходит только `user_message` — короткий текст
на русском. Трейсбек игрок видеть не должен.
"""

from __future__ import annotations


class GeminiError(Exception):
    """Базовая ошибка обращения к Gemini."""

    user_message = "Что-то пошло не так при обращении к нейросети."

    def __init__(self, detail: str = "", user_message: str | None = None) -> None:
        super().__init__(detail or self.user_message)
        self.detail = detail
        if user_message:
            self.user_message = user_message


class MissingApiKeyError(GeminiError):
    user_message = (
        "Не найден ключ API. Впиши GEMINI_API_KEY в файл .env в корне проекта "
        "и перезапусти игру."
    )


class AuthError(GeminiError):
    user_message = "Ключ API отклонён. Проверь GEMINI_API_KEY в файле .env."


class LocationBlockedError(GeminiError):
    """Google отказывает по географии обращающегося.

    Ловится отдельно, потому что выглядит как обычная ошибка запроса, а лечится
    совсем иначе: не ключом и не повтором, а сменой страны выхода в интернет.
    """

    user_message = (
        "Google не обслуживает Gemini из этой страны. "
        "Включи VPN или смени сервер VPN на другую страну — и повтори."
    )


class RateLimitError(GeminiError):
    user_message = (
        "Превышен лимит запросов к нейросети. Подожди немного и повтори действие."
    )


class ModelUnavailableError(GeminiError):
    user_message = (
        "Выбранная модель недоступна по этому ключу. Выбери другую модель в меню."
    )


class SafetyBlockedError(GeminiError):
    """finishReason: SAFETY — ответ заблокирован фильтрами на стороне Google.

    Автоповтор не делаем: это стоило бы лишний запрос и почти наверняка
    упёрлось бы в тот же фильтр. Просим игрока переформулировать.
    """

    user_message = (
        "Сцена оборвалась: нейросеть отказалась продолжать. "
        "Попробуй описать действие другими словами."
    )


class NetworkError(GeminiError):
    user_message = "Нет связи с сервером нейросети. Проверь интернет и повтори действие."


class InvalidResponseError(GeminiError):
    user_message = (
        "Нейросеть вернула ответ, который не удалось разобрать. Повтори действие."
    )


class TruncatedResponseError(InvalidResponseError):
    user_message = (
        "Ответ нейросети оборвался на середине. Повтори действие — "
        "или опиши его короче."
    )
