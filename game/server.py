"""Веб-сервер игры.

Меню, выбор модели, генерация завязки, ходы, бой, журнал и сохранения.

У каждого, кто открыл ссылку, своя партия: свой мир, свой персонаж, свои
сохранения. Гостей различает кука, выданная при первом заходе, — см. session.py.
Запуск с `--coop` сводит всех в одну общую партию.
"""

from __future__ import annotations

import os
import secrets
import threading
from dataclasses import asdict
from typing import Any

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import session as sessions
from .api.errors import GeminiError, MissingApiKeyError
from .api.gemini_client import GeminiClient
from .api.models import build_menu, default_model
from .api.usage_log import UsageLog
from .config import PROJECT_ROOT, Settings, ensure_dirs, hosted, load_settings
from .core import combat as combat_mod
from .core import saves as saves_mod
from .core.npc import journal_npcs
from .core.state import GameState
from .core.turn import play_turn, start_combat
from .core.worldgen import generate_world

WEB_DIR = PROJECT_ROOT / "web"

settings: Settings = load_settings()
# Ключ и счётчик расхода общие: платит за всех тот, чей ключ.
usage = UsageLog()
client = GeminiClient(settings, usage)

# На хостинге игра открыта всему интернету, а запросы идут по ключу владельца.
# Пускать без пароля нельзя, поэтому лучше не подняться совсем, чем подняться
# нараспашку.
if hosted() and not sessions.access_code():
    raise RuntimeError(
        "Игра запущена на сервере без пароля. Задай переменную окружения "
        "GAME_CODE — без неё играть сможет любой, кто найдёт адрес, "
        "и платить за это будешь ты."
    )

app = FastAPI(title="Текстовая RPG на Gemini")


@app.middleware("http")
async def session_cookie(request: Request, call_next):
    """Выдаёт гостю его метку при первом заходе и запоминает, чей это запрос."""
    host = request.client.host if request.client else ""

    # Гость из интернета приходит через cloudflared, то есть с 127.0.0.1.
    # Отличить его можно по заголовкам туннеля: у браузера на этой машине
    # их нет. Без этой проверки любой гость сошёл бы за хозяина.
    forwarded = request.headers.get("cf-connecting-ip") or request.headers.get(
        "x-forwarded-for"
    )
    sid, fresh = sessions.resolve_sid(
        host, request.cookies.get(sessions.COOKIE_NAME), tunneled=bool(forwarded)
    )
    request.state.sid = sid
    request.state.local = sessions.is_local(host) and not forwarded
    if forwarded:
        host = forwarded.split(",")[0].strip() + " (через интернет)"

    # Видно в консоли, что гость действительно дошёл до сервера. Если после
    # открытия ссылки тут пусто — запрос не доехал: сеть или брандмауэр.
    if fresh and not request.state.local:
        print(f"  → подключился новый игрок: {host}", flush=True)

    # Замок на входе: пока гость не ввёл код, к игре его не пускаем.
    # Страницу и две служебные ручки оставляем открытыми, иначе он не увидит,
    # что от него вообще хотят.
    path = request.url.path
    if path.startswith("/api/") and path not in ("/api/access", "/api/state"):
        game = sessions.get(sid, settings.default_model)
        if request.state.local:
            game.authorized = True
        if sessions.access_code() and not game.authorized:
            return JSONResponse(
                {"error": "Нужен код доступа.", "needs_code": True}, status_code=401
            )

    response = await call_next(request)
    if fresh:
        response.set_cookie(
            sessions.COOKIE_NAME,
            sid,
            max_age=sessions.COOKIE_MAX_AGE,
            httponly=True,
            samesite="lax",
            path="/",
        )
    return response


def current(request: Request) -> sessions.Session:
    game = sessions.get(request.state.sid, settings.default_model)
    if request.state.local:
        game.authorized = True  # хозяин код не вводит
    return game


def needs_code(request: Request, game: sessions.Session) -> bool:
    return bool(sessions.access_code()) and not game.authorized and not request.state.local


class AccessRequest(BaseModel):
    code: str = Field(default="", max_length=64)


@app.post("/api/access")
def api_access(request: Request, body: AccessRequest) -> Any:
    """Вход по коду. Код проверяем побайтово, чтобы не подсказывать длину
    временем ответа."""
    game = current(request)
    expected = sessions.access_code()
    # Сравниваем байты, а не строки: compare_digest не умеет сравнивать строки
    # с не-ASCII символами и падает, если гость ввёл код кириллицей.
    if not expected or secrets.compare_digest(
        body.code.strip().encode("utf-8"), expected.encode("utf-8")
    ):
        game.authorized = True
        return {"ok": True}
    return JSONResponse({"error": "Код не подходит."}, status_code=403)


class NewGameRequest(BaseModel):
    world: str = Field(default="", max_length=4000)
    character: str = Field(default="", max_length=4000)
    model: str = Field(default="")


class TurnRequest(BaseModel):
    text: str = Field(default="", max_length=2000)
    player: str = Field(default="", max_length=40)


class CombatRequest(BaseModel):
    action: str = Field(default="attack")
    item: str = Field(default="", max_length=200)
    player: str = Field(default="", max_length=40)


def _error(exc: GeminiError, status: int = 502) -> JSONResponse:
    return JSONResponse({"error": exc.user_message}, status_code=status)


def _game_payload(game: sessions.Session, changes: dict | None = None) -> dict:
    state: GameState = game.state
    fight = game.combat
    return {
        "state": state.to_dict(),
        "changes": changes or {},
        "model": game.model,
        "usage": usage.totals.as_dict(),
        "journal_npcs": [asdict(npc) for npc in journal_npcs(state)],
        "combat": combat_mod.to_dict(state, fight) if fight else None,
        # Чтобы свой же ход не прилетел обратно как «чужое изменение».
        "revision": game.revision,
    }


@app.get("/")
def index() -> FileResponse:
    return FileResponse(WEB_DIR / "index.html")


# ------------------------------------------------------------------ меню


@app.get("/api/state")
def api_state(request: Request) -> Any:
    """Что показать в главном меню: доступные модели, наличие ключа,
    есть ли начатая игра."""
    game = current(request)
    payload: dict[str, Any] = {
        "has_key": settings.has_key,
        "lang": settings.lang,
        "models": [],
        "model": game.model or settings.default_model,
        "has_world": game.world is not None,
        "has_game": game.state is not None,
        "saves_available": saves_mod.has_any_save(game.saves_dir),
        "coop": sessions.coop_enabled(),
        "guest": game.sid != sessions.MAIN_SID,
        "needs_code": needs_code(request, game),
        # На хостинге гасить сервер некому — прячем пункт «Выход».
        "hosted": hosted(),
    }
    # Пока код не введён, ничего лишнего не рассказываем.
    if payload["needs_code"]:
        return payload

    if not settings.has_key:
        payload["error"] = MissingApiKeyError().user_message
        payload["usage"] = usage.totals.as_dict()
        return payload

    try:
        options = build_menu(client, settings)
    except GeminiError as exc:
        payload["error"] = exc.user_message
        payload["usage"] = usage.totals.as_dict()
        return payload

    payload["models"] = [
        {"id": option.id, "title": option.title, "wanted": option.wanted}
        for option in options
    ]
    chosen = default_model(options, settings)
    if game.model not in [option.id for option in options]:
        game.model = chosen
    payload["model"] = game.model
    payload["usage"] = usage.totals.as_dict()
    return payload


@app.post("/api/model")
def api_model(request: Request, body: NewGameRequest) -> Any:
    game = current(request)
    game.model = body.model or settings.default_model
    return {"model": game.model}


# ------------------------------------------------------------- начало игры


@app.post("/api/new-game")
def api_new_game(request: Request, body: NewGameRequest) -> Any:
    """Один запрос к модели — вся завязка. Повторный вызов с теми же
    описаниями работает как «перегенерировать»."""
    game = current(request)
    model = body.model or game.model or settings.default_model
    try:
        world = generate_world(client, model, body.world, body.character)
    except GeminiError as exc:
        return _error(exc)

    game.model = model
    game.world = world
    game.inputs = {"world": body.world, "character": body.character}
    return {"world": world, "model": model, "usage": usage.totals.as_dict()}


@app.get("/api/world")
def api_world(request: Request) -> Any:
    game = current(request)
    if game.world is None:
        return JSONResponse({"error": "Игра ещё не начата."}, status_code=404)
    return {"world": game.world, "model": game.model}


@app.post("/api/start")
def api_start(request: Request) -> Any:
    """«Начать игру»: карточка мира превращается в игровое состояние.
    Запросов к модели не делает — всё уже сгенерировано."""
    game = current(request)
    if game.world is None:
        return JSONResponse({"error": "Сначала создай мир."}, status_code=400)
    game.state = GameState.from_world_card(game.world)
    game.combat = None
    saves_mod.autosave(game.state, None, game.saves_dir)
    game.bump()
    return _game_payload(game)


@app.get("/api/game")
def api_game(request: Request) -> Any:
    game = current(request)
    if game.state is None:
        return JSONResponse({"error": "Игра ещё не начата."}, status_code=404)
    return _game_payload(game)


@app.get("/api/sync")
def api_sync(request: Request, player: str = "") -> Any:
    """Дешёвая проверка «не изменилось ли что-нибудь».

    Нужна и в одиночной игре (две вкладки одного браузера), и в совместной,
    где ход делает кто-то другой.
    """
    game = current(request)
    game.seen(player)
    fight = game.combat
    return {
        "revision": game.revision,
        "has_game": game.state is not None,
        "in_combat": fight is not None and not fight.finished,
        "game_over": bool(game.state and game.state.game_over),
        "busy_by": game.busy_by,
        "players": game.online() if sessions.coop_enabled() else [],
        "coop": sessions.coop_enabled(),
    }


# ------------------------------------------------------------------- ход


@app.post("/api/turn")
def api_turn(request: Request, body: TurnRequest) -> Any:
    """Ход игрока: ровно один запрос к модели."""
    game = current(request)
    state: GameState | None = game.state
    if state is None:
        return JSONResponse({"error": "Игра ещё не начата."}, status_code=400)
    if state.game_over:
        return JSONResponse({"error": "История окончена."}, status_code=400)

    text = body.text.strip()
    if not text:
        return JSONResponse({"error": "Напиши, что делает персонаж."}, status_code=400)

    game.seen(body.player)
    # Замок на партию: в совместной игре двое не пишут поверх друг друга,
    # в одиночной он же спасает от двойного нажатия и второй вкладки.
    if not game.lock.acquire(blocking=False):
        who = game.busy_by or "другой игрок"
        return JSONResponse(
            {"error": f"Сейчас ходит {who}. Подожди пару секунд."}, status_code=409
        )

    game.busy_by = body.player.strip() or "кто-то"
    game.bump()
    try:
        try:
            changes = play_turn(
                client, game.model, state, text, player_name=body.player
            )
        except GeminiError as exc:
            # Состояние не тронуто: ход просто не состоялся.
            return _error(exc)

        # Модель объявила драку — сразу собираем бой вторым запросом.
        trigger = changes.pop("combat_trigger", None)
        if trigger:
            try:
                game.combat = start_combat(
                    client, game.model, state, trigger["enemy_name"], trigger["reason"]
                )
            except GeminiError as exc:
                # Драку не собрали — история продолжается как обычно, без боя.
                saves_mod.autosave(state, None, game.saves_dir)
                payload = _game_payload(game, changes)
                payload["warning"] = exc.user_message
                return payload

        saves_mod.autosave(state, game.combat, game.saves_dir)
        return _game_payload(game, changes)
    finally:
        game.busy_by = ""
        game.bump()
        game.lock.release()


# ------------------------------------------------------------------- бой


@app.post("/api/combat/action")
def api_combat_action(request: Request, body: CombatRequest) -> Any:
    """Раунд боя. Запросов к модели не делает вообще."""
    game = current(request)
    state: GameState | None = game.state
    fight = game.combat
    if state is None or fight is None:
        return JSONResponse({"error": "Сейчас никакого боя нет."}, status_code=400)
    if fight.finished:
        return JSONResponse({"error": "Бой уже закончен."}, status_code=400)

    game.seen(body.player)
    if not game.lock.acquire(blocking=False):
        return JSONResponse({"error": "Удар уже наносит другой игрок."}, status_code=409)
    try:
        combat_mod.resolve_round(state, fight, body.action, body.item)
        saves_mod.autosave(state, None if fight.finished else fight, game.saves_dir)
        game.bump()
    finally:
        game.lock.release()

    return {
        "combat": combat_mod.to_dict(state, fight),
        "state": state.to_dict(),
        "usage": usage.totals.as_dict(),
        "revision": game.revision,
    }


@app.post("/api/combat/finish")
def api_combat_finish(request: Request) -> Any:
    """Возвращение в повествование после боя — один запрос к модели."""
    game = current(request)
    state: GameState | None = game.state
    fight = game.combat
    if state is None or fight is None:
        return JSONResponse({"error": "Сейчас никакого боя нет."}, status_code=400)
    if not fight.finished:
        return JSONResponse({"error": "Бой ещё идёт."}, status_code=400)

    note = combat_mod.outcome_note(state, fight)
    try:
        changes = play_turn(client, game.model, state, "", event_note=note)
    except GeminiError as exc:
        return _error(exc)

    changes.pop("combat_trigger", None)
    game.combat = None
    saves_mod.autosave(state, None, game.saves_dir)
    game.bump()
    return _game_payload(game, changes)


# ------------------------------------------------------------- сохранения


@app.get("/api/saves")
def api_saves(request: Request) -> Any:
    game = current(request)
    return {
        "saves": saves_mod.list_saves(game.saves_dir),
        "has_game": game.state is not None,
    }


@app.post("/api/saves/{slot}")
def api_save(request: Request, slot: str) -> Any:
    game = current(request)
    if game.state is None:
        return JSONResponse({"error": "Сохранять пока нечего."}, status_code=400)
    try:
        meta = saves_mod.save_game(game.state, slot, game.combat, game.saves_dir)
    except saves_mod.SaveError as exc:
        return JSONResponse({"error": exc.user_message}, status_code=400)
    return {"saved": meta, "saves": saves_mod.list_saves(game.saves_dir)}


@app.post("/api/saves/{slot}/load")
def api_load(request: Request, slot: str) -> Any:
    game = current(request)
    try:
        state, fight = saves_mod.load_game(slot, game.saves_dir)
    except saves_mod.SaveError as exc:
        return JSONResponse({"error": exc.user_message}, status_code=400)
    game.state = state
    game.combat = fight
    game.bump()
    return _game_payload(game)


@app.delete("/api/saves/{slot}")
def api_delete_save(request: Request, slot: str) -> Any:
    game = current(request)
    try:
        saves_mod.delete_save(slot, game.saves_dir)
    except saves_mod.SaveError as exc:
        return JSONResponse({"error": exc.user_message}, status_code=400)
    return {"saves": saves_mod.list_saves(game.saves_dir)}


# --------------------------------------------------------------- служебное


@app.post("/api/shutdown")
def api_shutdown(request: Request) -> Any:
    """Пункт меню «Выход» гасит сервер — но только для хозяина.

    Когда к игре подключены гости, случайный «Выход» с чужого браузера
    выбросил бы всех разом.
    """
    if not request.state.local:
        return JSONResponse(
            {"error": "Остановить игру может только тот, у кого она запущена."},
            status_code=403,
        )
    threading.Timer(0.4, lambda: os._exit(0)).start()
    return {"ok": True}


ensure_dirs()
app.mount("/static", StaticFiles(directory=WEB_DIR), name="static")
