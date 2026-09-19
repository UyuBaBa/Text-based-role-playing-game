# Образ для хостинга: Railway, Render, Fly, любой другой с поддержкой Docker.
FROM python:3.12-slim

WORKDIR /app

# Зависимости отдельным слоем: правки в коде не заставляют ставить их заново.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY game/ ./game/
COPY web/ ./web/
COPY run.py ./

# GAME_HOSTED переводит игру в серверный режим: без пароля она не поднимется,
# а пункт «Выход» из меню пропадает — гасить там нечего.
# GAME_DATA_DIR уводит сейвы на подключённый диск: файлы самого контейнера
# стираются при каждом обновлении.
ENV GAME_HOSTED=1 \
    GAME_DATA_DIR=/data \
    PYTHONUNBUFFERED=1

# Пригодится, если диск не подключён: игра всё равно запустится.
RUN mkdir -p /data

EXPOSE 8000

# Хостинг сам называет порт в переменной PORT.
CMD ["sh", "-c", "python -m uvicorn game.server:app --host 0.0.0.0 --port ${PORT:-8000} --log-level warning"]
