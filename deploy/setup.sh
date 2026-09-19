#!/usr/bin/env bash
# Разворачивание игры на виртуальной машине (Oracle Cloud Always Free и любая
# другая Ubuntu/Debian). Запускать из папки с игрой:
#
#     sudo bash deploy/setup.sh
#
# Скрипт можно запускать повторно: он обновит контейнер, не трогая сохранения.
set -euo pipefail

NAME=rpg
NETWORK=rpg-net
DATA_DIR=/var/lib/rpg-data
PORT_HTTP=80

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
warn() { printf '  \033[33m%s\033[0m\n' "$*"; }

[[ -f Dockerfile ]] || { echo "Запускай из папки с игрой (рядом должен быть Dockerfile)."; exit 1; }
[[ $EUID -eq 0 ]] || { echo "Нужны права root: sudo bash deploy/setup.sh"; exit 1; }

# ------------------------------------------------------------ что спросить

if [[ -z "${GEMINI_API_KEY:-}" ]]; then
    read -rp "Ключ Gemini API: " GEMINI_API_KEY
fi
if [[ -z "${GAME_CODE:-}" ]]; then
    read -rp "Пароль для игроков: " GAME_CODE
fi
[[ -n "$GEMINI_API_KEY" && -n "$GAME_CODE" ]] || { echo "Ключ и пароль обязательны."; exit 1; }

# Домен нужен только для HTTPS. Без него игра работает по обычному http://IP.
DOMAIN="${GAME_DOMAIN:-}"

say "1. Docker"
if ! command -v docker >/dev/null 2>&1; then
    apt-get update -qq
    apt-get install -y -qq docker.io
    systemctl enable --now docker
    echo "  поставлен"
else
    echo "  уже есть: $(docker --version)"
fi

say "2. Порты"
# На образах Oracle в INPUT стоит запрещающее правило — разрешение вставляем перед ним.
open_port() {
    local port=$1
    if ! iptables -C INPUT -p tcp --dport "$port" -j ACCEPT 2>/dev/null; then
        iptables -I INPUT 1 -p tcp --dport "$port" -j ACCEPT
        echo "  открыт $port"
    else
        echo "  $port уже открыт"
    fi
}
open_port "$PORT_HTTP"
[[ -n "$DOMAIN" ]] && open_port 443
if command -v netfilter-persistent >/dev/null 2>&1; then
    netfilter-persistent save >/dev/null 2>&1 && echo "  правила сохранены"
else
    apt-get install -y -qq iptables-persistent >/dev/null 2>&1 || true
    netfilter-persistent save >/dev/null 2>&1 || warn "правила не сохранены: после перезагрузки повтори"
fi
warn "Это брандмауэр самой машины. В консоли Oracle отдельно разреши тот же порт:"
warn "Networking -> Virtual Cloud Network -> Security List -> Ingress Rules."

say "3. Сборка образа"
mkdir -p "$DATA_DIR"
docker build -t "$NAME" . | tail -3

say "4. Запуск"
docker network inspect "$NETWORK" >/dev/null 2>&1 || docker network create "$NETWORK" >/dev/null
docker rm -f "$NAME" >/dev/null 2>&1 || true

# --restart=always поднимает игру после перезагрузки машины сам.
COMMON=(-d --name "$NAME" --network "$NETWORK" --restart=always
        -e GEMINI_API_KEY="$GEMINI_API_KEY"
        -e GAME_CODE="$GAME_CODE"
        -v "$DATA_DIR:/data")

if [[ -n "$DOMAIN" ]]; then
    # Наружу смотрит Caddy: он сам получает сертификат и говорит по HTTPS.
    docker run "${COMMON[@]}" "$NAME" >/dev/null
    docker rm -f caddy >/dev/null 2>&1 || true
    docker run -d --name caddy --network "$NETWORK" --restart=always \
        -p 80:80 -p 443:443 \
        -v caddy_data:/data -v caddy_config:/config \
        caddy:latest caddy reverse-proxy --from "$DOMAIN" --to "$NAME:8000" >/dev/null
    ADDRESS="https://$DOMAIN"
else
    docker run "${COMMON[@]}" -p "$PORT_HTTP:8000" "$NAME" >/dev/null
    IP=$(curl -s --max-time 5 ifconfig.me || hostname -I | awk '{print $1}')
    ADDRESS="http://$IP"
fi

say "5. Проверка"
sleep 4
if docker ps --filter "name=^${NAME}$" --filter "status=running" | grep -q "$NAME"; then
    echo "  контейнер работает"
else
    echo "  контейнер упал, вот почему:"
    docker logs --tail 20 "$NAME"
    exit 1
fi

printf '\n%s\n' "=========================================================="
printf '  ССЫЛКА ДЛЯ ИГРОКОВ:\n\n      %s\n\n' "$ADDRESS"
printf '  Пароль: %s\n' "$GAME_CODE"
printf '%s\n\n' "=========================================================="
echo "  Сохранения:   $DATA_DIR"
echo "  Логи:         docker logs -f $NAME"
echo "  Перезапуск:   docker restart $NAME"
echo "  Обновление:   sudo bash deploy/update.sh"
[[ -z "$DOMAIN" ]] && warn "Без домена связь идёт по http: пароль летит открытым текстом.
  Если есть домен (хоть бесплатный с duckdns.org), перезапусти так:
      sudo GAME_DOMAIN=имя.duckdns.org bash deploy/setup.sh"
echo
