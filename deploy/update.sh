#!/usr/bin/env bash
# Обновление игры после правок в коде. Запускать из папки с игрой:
#
#     sudo bash deploy/update.sh
#
# Ключ и пароль берутся у работающего контейнера, сохранения не трогаются.
set -euo pipefail

NAME=rpg
NETWORK=rpg-net
DATA_DIR=/var/lib/rpg-data

[[ -f Dockerfile ]] || { echo "Запускай из папки с игрой."; exit 1; }
[[ $EUID -eq 0 ]] || { echo "Нужны права root: sudo bash deploy/update.sh"; exit 1; }
docker inspect "$NAME" >/dev/null 2>&1 || {
    echo "Игра ещё не развёрнута — сначала deploy/setup.sh"; exit 1; }

# Достаём настройки из старого контейнера, чтобы не вводить их заново.
read_env() {
    docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$NAME" \
        | grep "^$1=" | head -1 | cut -d= -f2-
}
KEY=$(read_env GEMINI_API_KEY)
CODE=$(read_env GAME_CODE)
PORTS=$(docker inspect -f '{{range $p, $c := .HostConfig.PortBindings}}{{range $c}}{{.HostPort}}{{end}}{{end}}' "$NAME")

[[ -n "$KEY" && -n "$CODE" ]] || { echo "Не нашёл ключ или пароль в старом контейнере."; exit 1; }

echo "Собираю новый образ…"
docker build -t "$NAME" . | tail -3

echo "Перезапускаю…"
docker rm -f "$NAME" >/dev/null
ARGS=(-d --name "$NAME" --network "$NETWORK" --restart=always
      -e GEMINI_API_KEY="$KEY" -e GAME_CODE="$CODE" -v "$DATA_DIR:/data")
# Если наружу смотрел сам контейнер (без Caddy) — возвращаем ему тот же порт.
[[ -n "$PORTS" ]] && ARGS+=(-p "${PORTS}:8000")
docker run "${ARGS[@]}" "$NAME" >/dev/null

sleep 4
if docker ps --filter "name=^${NAME}$" --filter "status=running" | grep -q "$NAME"; then
    echo "Готово. Сохранения на месте: $DATA_DIR"
else
    echo "Контейнер не поднялся:"
    docker logs --tail 20 "$NAME"
    exit 1
fi
