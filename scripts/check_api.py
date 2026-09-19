"""Проверка слоя API (этап 1).

Запуск:  python scripts/check_api.py [--no-generate]

Делает максимум два запроса: список моделей и один короткий структурированный
ответ, чтобы убедиться, что responseSchema, фильтры и учёт токенов работают.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from game.console import setup as setup_console  # noqa: E402

setup_console()

from game.api.errors import GeminiError, MissingApiKeyError  # noqa: E402
from game.api.gemini_client import GeminiClient  # noqa: E402
from game.api.models import build_menu, default_model  # noqa: E402
from game.api.usage_log import UsageLog  # noqa: E402
from game.config import ensure_dirs, load_settings  # noqa: E402

PROBE_SCHEMA = {
    "type": "object",
    "properties": {
        "narrative": {"type": "string"},
        "state_delta": {
            "type": "object",
            "properties": {
                "health": {"type": "integer"},
                "fatigue": {"type": "integer"},
            },
            "required": ["health", "fatigue"],
        },
        "suggested_actions": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["narrative", "state_delta", "suggested_actions"],
}

PROBE_SYSTEM = (
    "Ты — ведущий текстовой ролевой игры. Отвечай только на русском языке. "
    "Возвращай строго JSON по заданной схеме, без пояснений."
)

PROBE_USER = (
    "Проверка связи. Мир: заброшенная станция на болотах. "
    "Персонаж: уставший охотник, здоровье 80, усталость 65. "
    "Действие игрока: осмотреться. "
    "Дай короткую сцену на 2-3 предложения, дельты состояния и 2 варианта действий."
)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--no-generate", action="store_true", help="только список моделей")
    args = parser.parse_args()

    ensure_dirs()
    settings = load_settings()
    usage = UsageLog()
    client = GeminiClient(settings, usage)

    print("== Настройки ==")
    print(f"ключ: {'найден' if settings.has_key else 'НЕ НАЙДЕН'}")
    print(f"модель по умолчанию из .env: {settings.default_model}")
    print(f"язык: {settings.lang}   режим фильтров: {settings.safety_mode}")

    try:
        print("\n== Запрос models.list ==")
        all_models = client.list_models()
        print(f"доступно моделей с generateContent: {len(all_models)}")

        options = build_menu(client, settings)
        chosen = default_model(options, settings)
        print("\n== Меню выбора модели ==")
        if not options:
            print("  (ни одной подходящей модели не найдено)")
        for option in options:
            mark = ">" if option.id == chosen else " "
            tag = "" if option.wanted else "  [замена, в ТЗ не было]"
            print(f"  {mark} {option.title}  ({option.id}){tag}")

        missing = [
            model_id
            for model_id, _ in settings.wanted_models
            if model_id not in {m["id"] for m in all_models}
        ]
        if missing:
            print("\n  недоступны по этому ключу: " + ", ".join(missing))

        if not args.no_generate:
            print("\n== Пробный структурированный запрос ==")
            data = client.generate_json(
                model=chosen,
                schema=PROBE_SCHEMA,
                user_text=PROBE_USER,
                system_instruction=PROBE_SYSTEM,
                purpose="probe",
                max_output_tokens=800,
            )
            print(f"narrative: {data['narrative']}")
            print(f"state_delta: {data['state_delta']}")
            print(f"suggested_actions: {data['suggested_actions']}")

    except MissingApiKeyError as exc:
        print(f"\nОШИБКА: {exc.user_message}")
        return 1
    except GeminiError as exc:
        print(f"\nОШИБКА: {exc.user_message}")
        print(f"детали: {exc.detail[:500]}")
        print(f"\nучёт: {usage.summary_line()}")
        return 1

    print(f"\n== Учёт API ==\n{usage.summary_line()}")
    print("лог: logs/api_usage.jsonl")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
