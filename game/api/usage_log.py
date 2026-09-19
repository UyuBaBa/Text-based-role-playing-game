"""Учёт запросов к API.

Нужен, чтобы держать бюджет из п.8 ТЗ: 1 запрос на ход, 2 на старт игры,
~2 на бой. Пишет JSONL в logs/api_usage.jsonl и считает сессию в памяти.
"""

from __future__ import annotations

import json
import threading
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

from ..config import LOGS_DIR


@dataclass
class UsageTotals:
    calls: int = 0
    failed: int = 0
    retries: int = 0
    prompt_tokens: int = 0
    output_tokens: int = 0
    total_tokens: int = 0
    seconds: float = 0.0
    by_purpose: dict[str, int] = field(default_factory=dict)

    def as_dict(self) -> dict:
        return {
            "calls": self.calls,
            "failed": self.failed,
            "retries": self.retries,
            "prompt_tokens": self.prompt_tokens,
            "output_tokens": self.output_tokens,
            "total_tokens": self.total_tokens,
            "seconds": round(self.seconds, 2),
            "by_purpose": dict(self.by_purpose),
        }


class UsageLog:
    def __init__(self, log_file: Path | None = None) -> None:
        self.log_file = log_file or (LOGS_DIR / "api_usage.jsonl")
        self.totals = UsageTotals()
        self._lock = threading.Lock()

    def record(
        self,
        *,
        purpose: str,
        model: str,
        ok: bool,
        seconds: float,
        usage: dict | None = None,
        attempt: int = 1,
        error: str | None = None,
    ) -> None:
        usage = usage or {}
        prompt_tokens = int(usage.get("promptTokenCount", 0) or 0)
        output_tokens = int(usage.get("candidatesTokenCount", 0) or 0)
        total_tokens = int(usage.get("totalTokenCount", 0) or 0)

        with self._lock:
            self.totals.calls += 1
            if not ok:
                self.totals.failed += 1
            if attempt > 1:
                self.totals.retries += 1
            self.totals.prompt_tokens += prompt_tokens
            self.totals.output_tokens += output_tokens
            self.totals.total_tokens += total_tokens
            self.totals.seconds += seconds
            self.totals.by_purpose[purpose] = self.totals.by_purpose.get(purpose, 0) + 1

            entry = {
                "ts": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                "purpose": purpose,
                "model": model,
                "ok": ok,
                "attempt": attempt,
                "seconds": round(seconds, 2),
                "prompt_tokens": prompt_tokens,
                "output_tokens": output_tokens,
                "total_tokens": total_tokens,
            }
            if error:
                entry["error"] = error

            try:
                self.log_file.parent.mkdir(parents=True, exist_ok=True)
                with self.log_file.open("a", encoding="utf-8") as fh:
                    fh.write(json.dumps(entry, ensure_ascii=False) + "\n")
            except OSError:
                # Лог не должен ронять игру.
                pass

    def summary_line(self) -> str:
        t = self.totals
        return (
            f"запросов: {t.calls} (ошибок: {t.failed}, повторов: {t.retries}), "
            f"токенов: {t.total_tokens} "
            f"(вход {t.prompt_tokens} / выход {t.output_tokens}), "
            f"время: {t.seconds:.1f} c"
        )
