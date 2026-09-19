"""Выбор модели для главного меню.

ТЗ просит три модели: Gemini 3.5 / 3.1 / 2.5 Flash-Lite. Существование первых
двух не гарантировано, поэтому список меню строится по фактическому ответу
models.list, а недостающие пункты просто не показываются.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from ..config import Settings
from .gemini_client import GeminiClient

# Служебные варианты, которые не нужны в меню игрока.
_NOISE = ("-preview", "-exp", "-thinking", "-tuning", "-latest", "-8b", "-live")


@dataclass(frozen=True)
class ModelOption:
    id: str
    title: str
    wanted: bool  # True — модель прямо из ТЗ, False — подобранная замена


def _version_key(model_id: str) -> tuple[float, str]:
    match = re.search(r"gemini-(\d+(?:\.\d+)?)", model_id)
    version = float(match.group(1)) if match else 0.0
    return (version, model_id)


def _pretty_title(model_id: str) -> str:
    match = re.search(r"gemini-(\d+(?:\.\d+)?)", model_id)
    version = match.group(1) if match else "?"
    return f"Gemini {version} Flash-Lite"


def build_menu(client: GeminiClient, settings: Settings) -> list[ModelOption]:
    """Возвращает список моделей для меню: сначала те, что названы в ТЗ,
    затем — запасные Flash-Lite, если из ТЗ не нашлось ни одной."""
    available = {model["id"] for model in client.list_models()}

    options = [
        ModelOption(id=model_id, title=title, wanted=True)
        for model_id, title in settings.wanted_models
        if model_id in available
    ]
    if options:
        return options

    # Ни одной модели из ТЗ нет — подставляем доступные Flash-Lite, новые первыми.
    fallbacks = sorted(
        (
            model_id
            for model_id in available
            if "flash-lite" in model_id and not any(noise in model_id for noise in _NOISE)
        ),
        key=_version_key,
        reverse=True,
    )
    return [ModelOption(id=mid, title=_pretty_title(mid), wanted=False) for mid in fallbacks[:3]]


def default_model(options: list[ModelOption], settings: Settings) -> str:
    """Модель по умолчанию: из .env, если она есть в меню, иначе первая в списке."""
    if not options:
        return settings.default_model
    ids = [option.id for option in options]
    return settings.default_model if settings.default_model in ids else ids[0]
