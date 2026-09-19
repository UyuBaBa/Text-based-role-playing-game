"""Приведение консоли Windows в читаемый вид.

Две беды старой консоли:

1. Кодировка. По умолчанию она не UTF-8, и русские строки роняют запуск
   с UnicodeEncodeError.
2. Шрифт. Если выбран растровый «Terminal», кириллицы в нём нет: Windows
   подставляет её из другого шрифта посимвольно, и текст  р а с ползается
   в разрядку. Лечится переключением на любой TrueType-шрифт с кириллицей.

Обе правки касаются только текущего окна и живут, пока идёт игра: ничего
в системе и реестре не меняется.
"""

from __future__ import annotations

import ctypes
import sys

# Порядок предпочтения: оба есть в любой Windows начиная с Vista.
PREFERRED_FONTS = ("Consolas", "Lucida Console")

STD_OUTPUT_HANDLE = -11
INVALID_HANDLE = 2 ** (8 * ctypes.sizeof(ctypes.c_void_p)) - 1
FF_MODERN_TRUETYPE = 54  # FF_MODERN | TMPF_VECTOR | TMPF_TRUETYPE
FONT_WEIGHT_NORMAL = 400
DEFAULT_HEIGHT = 16


class _COORD(ctypes.Structure):
    _fields_ = [("X", ctypes.c_short), ("Y", ctypes.c_short)]


class _CONSOLE_FONT_INFOEX(ctypes.Structure):
    _fields_ = [
        ("cbSize", ctypes.c_ulong),
        ("nFont", ctypes.c_ulong),
        ("dwFontSize", _COORD),
        ("FontFamily", ctypes.c_uint),
        ("FontWeight", ctypes.c_uint),
        ("FaceName", ctypes.c_wchar * 32),
    ]


def utf8_streams() -> None:
    """Вывод в UTF-8 и сразу на экран.

    line_buffering важен для Git Bash и других оболочек, где вывод уходит не
    в окно консоли, а в трубу: без него Python копит текст в буфере, и ссылка
    с паролем появляются с опозданием или вовсе под конец работы.
    """
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            try:
                stream.reconfigure(
                    encoding="utf-8", errors="replace", line_buffering=True
                )
            except (ValueError, OSError):
                pass


def readable_font(height: int = DEFAULT_HEIGHT) -> str | None:
    """Ставит окну консоли моноширинный шрифт с кириллицей.

    Возвращает имя выбранного шрифта или None, если менять нечего:
    не Windows, вывод перенаправлен в файл, или это Windows Terminal,
    который управляет шрифтом сам и в такой правке не нуждается.
    """
    if sys.platform != "win32":
        return None

    try:
        kernel32 = ctypes.windll.kernel32

        # Типы объявляем явно: дескриптор на 64-битной Windows не помещается
        # в int, которым ctypes пользуется по умолчанию.
        font_ptr = ctypes.POINTER(_CONSOLE_FONT_INFOEX)
        kernel32.GetStdHandle.argtypes = [ctypes.c_uint]
        kernel32.GetStdHandle.restype = ctypes.c_void_p
        for func in (kernel32.GetCurrentConsoleFontEx, kernel32.SetCurrentConsoleFontEx):
            func.argtypes = [ctypes.c_void_p, ctypes.c_bool, font_ptr]
            func.restype = ctypes.c_bool

        handle = kernel32.GetStdHandle(ctypes.c_uint(STD_OUTPUT_HANDLE & 0xFFFFFFFF))
        if not handle or handle == INVALID_HANDLE:
            return None

        current = _CONSOLE_FONT_INFOEX()
        current.cbSize = ctypes.sizeof(_CONSOLE_FONT_INFOEX)
        # Заодно проверяем, что перед нами настоящее окно консоли.
        if not kernel32.GetCurrentConsoleFontEx(handle, False, ctypes.byref(current)):
            return None
        if current.FaceName in PREFERRED_FONTS:
            return current.FaceName  # уже нормальный шрифт, не трогаем

        for name in PREFERRED_FONTS:
            font = _CONSOLE_FONT_INFOEX()
            font.cbSize = ctypes.sizeof(_CONSOLE_FONT_INFOEX)
            font.nFont = 0
            # Ширину оставляем нулевой: её подберёт сама система.
            font.dwFontSize = _COORD(0, height)
            font.FontFamily = FF_MODERN_TRUETYPE
            font.FontWeight = FONT_WEIGHT_NORMAL
            font.FaceName = name
            if kernel32.SetCurrentConsoleFontEx(handle, False, ctypes.byref(font)):
                return name
    except (AttributeError, OSError, ValueError):
        # Старая Windows без этих функций или необычное окружение — не беда.
        return None
    return None


def setup(height: int = DEFAULT_HEIGHT) -> str | None:
    utf8_streams()
    return readable_font(height)
