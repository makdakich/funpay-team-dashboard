"""Windows-specific utilities: Window management, keyboard synthesis, clipboard, and autostart."""

import os
import sys
import time
import winreg
import ctypes
from ctypes import wintypes
from typing import Optional

# Win32 API constants
VK_CONTROL = 0x11
VK_MENU = 0x12  # Alt
VK_SHIFT = 0x10
VK_RETURN = 0x0D
VK_SPACE = 0x20
VK_TAB = 0x09
VK_BACK = 0x08
VK_ESCAPE = 0x1B
VK_DELETE = 0x2E
KEYEVENTF_KEYUP = 0x0002

MOD_ALT = 0x0001
MOD_CONTROL = 0x0002
MOD_SHIFT = 0x0004
MOD_WIN = 0x0008
MOD_NOREPEAT = 0x4000

PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
SW_RESTORE = 9
SW_SHOW = 5

user32 = ctypes.windll.user32
kernel32 = ctypes.windll.kernel32

# Mapping of key names to Virtual-Key codes
VK_MAP = {
    "SPACE": VK_SPACE,
    "ENTER": VK_RETURN,
    "RETURN": VK_RETURN,
    "TAB": VK_TAB,
    "BACKSPACE": VK_BACK,
    "ESC": VK_ESCAPE,
    "ESCAPE": VK_ESCAPE,
    "DELETE": VK_DELETE,
    "DEL": VK_DELETE,
    "INSERT": 0x2D,
    "HOME": 0x24,
    "END": 0x23,
    "PAGEUP": 0x21,
    "PAGEDOWN": 0x22,
    "UP": 0x26,
    "DOWN": 0x28,
    "LEFT": 0x25,
    "RIGHT": 0x27,
    "CAPSLOCK": 0x14,
    "PRINTSCREEN": 0x2C,
    "PAUSE": 0x13,
}

# Add F1..F24
for i in range(1, 25):
    VK_MAP[f"F{i}"] = 0x70 + (i - 1)

# Add 0..9
for i in range(10):
    VK_MAP[str(i)] = 0x30 + i
    VK_MAP[f"NUMPAD{i}"] = 0x60 + i

# Add A..Z
for i in range(26):
    char = chr(ord('A') + i)
    VK_MAP[char] = ord(char)


def get_foreground_window() -> int:
    """Return handle to the current foreground window."""
    try:
        return user32.GetForegroundWindow()
    except Exception:
        return 0


def set_foreground_window(hwnd: int) -> bool:
    """Safely restore foreground focus to the given window handle."""
    if not hwnd:
        return False
    try:
        # Simulate null input to allow foreground window change in Windows
        user32.keybd_event(0, 0, 0, 0)
        user32.ShowWindow(hwnd, SW_SHOW)
        user32.BringWindowToTop(hwnd)
        return bool(user32.SetForegroundWindow(hwnd))
    except Exception:
        return False


def get_window_process_name(hwnd: int) -> str:
    """Get the executable name (e.g., 'chrome.exe') of the given window."""
    if not hwnd:
        return ""
    try:
        pid = wintypes.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        if pid.value == 0:
            return ""

        h_process = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid.value)
        if not h_process:
            return ""

        buf = ctypes.create_unicode_buffer(1024)
        size = wintypes.DWORD(1024)
        success = kernel32.QueryFullProcessImageNameW(h_process, 0, buf, ctypes.byref(size))
        kernel32.CloseHandle(h_process)

        if success:
            full_path = buf.value
            return os.path.basename(full_path).lower()
    except Exception:
        pass
    return ""


def send_paste() -> None:
    """Send Ctrl+V keystroke to active window."""
    user32.keybd_event(VK_CONTROL, 0, 0, 0)
    user32.keybd_event(ord('V'), 0, 0, 0)
    time.sleep(0.015)
    user32.keybd_event(ord('V'), 0, KEYEVENTF_KEYUP, 0)
    user32.keybd_event(VK_CONTROL, 0, KEYEVENTF_KEYUP, 0)


def send_enter() -> None:
    """Send Enter keystroke to active window."""
    user32.keybd_event(VK_RETURN, 0, 0, 0)
    time.sleep(0.015)
    user32.keybd_event(VK_RETURN, 0, KEYEVENTF_KEYUP, 0)


def parse_hotkey_string(hotkey_str: str) -> tuple[int, int]:
    """
    Parse hotkey string like 'Ctrl+F4', 'Alt+1', 'Shift+F2' into (modifiers, vk_code).
    Raises ValueError if invalid.
    """
    if not hotkey_str or not hotkey_str.strip():
        raise ValueError("Empty hotkey string")

    parts = [p.strip().upper() for p in hotkey_str.split("+") if p.strip()]
    if not parts:
        raise ValueError("Invalid hotkey string format")

    modifiers = MOD_NOREPEAT
    vk_code = None

    for part in parts:
        if part in ("CTRL", "CONTROL"):
            modifiers |= MOD_CONTROL
        elif part == "ALT":
            modifiers |= MOD_ALT
        elif part == "SHIFT":
            modifiers |= MOD_SHIFT
        elif part in ("WIN", "WINDOWS", "SUPER"):
            modifiers |= MOD_WIN
        else:
            # Key part
            if part in VK_MAP:
                vk_code = VK_MAP[part]
            elif len(part) == 1 and part.isalnum():
                vk_code = ord(part.upper())
            else:
                raise ValueError(f"Unknown key in hotkey: '{part}'")

    if vk_code is None:
        raise ValueError("No main key found in hotkey string")

    return modifiers, vk_code


def normalize_shortcut(hotkey_str: str) -> str:
    """
    Standardize hotkey display string with canonical order:
    Ctrl + Alt + Shift + Win + Key, e.g. 'ctrl+shift+f2' -> 'Ctrl+Shift+F2'.
    """
    if not hotkey_str:
        return ""
    parts = [p.strip() for p in hotkey_str.split("+") if p.strip()]
    found_mods = set()
    main_key = ""

    for p in parts:
        up = p.upper()
        if up in ("CTRL", "CONTROL"):
            found_mods.add("Ctrl")
        elif up == "ALT":
            found_mods.add("Alt")
        elif up == "SHIFT":
            found_mods.add("Shift")
        elif up in ("WIN", "WINDOWS", "SUPER"):
            found_mods.add("Win")
        else:
            if up in ("SPACE", "RETURN", "ENTER", "TAB", "ESC", "ESCAPE"):
                main_key = up.capitalize()
            elif up in VK_MAP:
                main_key = up
            elif len(p) == 1:
                main_key = p.upper()
            else:
                main_key = p.capitalize()

    # Canonical modifier order
    ordered_mods = []
    for mod in ("Ctrl", "Alt", "Shift", "Win"):
        if mod in found_mods:
            ordered_mods.append(mod)

    if not main_key and not ordered_mods:
        return ""

    all_parts = ordered_mods + ([main_key] if main_key else [])
    return "+".join(all_parts)


# Windows registry autostart support
REG_RUN_PATH = r"Software\Microsoft\Windows\CurrentVersion\Run"
APP_REG_NAME = "FunPayHotkeys"
LEGACY_APP_REG_NAME = "FanPayHotkeys"


def is_autostart_enabled() -> bool:
    """Check if app is registered in HKCU Run registry (supports legacy and modern names)."""
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, REG_RUN_PATH, 0, winreg.KEY_READ) as key:
            try:
                winreg.QueryValueEx(key, APP_REG_NAME)
                return True
            except (FileNotFoundError, OSError):
                winreg.QueryValueEx(key, LEGACY_APP_REG_NAME)
                return True
    except (FileNotFoundError, OSError):
        return False


def set_autostart_enabled(enabled: bool) -> bool:
    """Enable or disable autostart with Windows."""
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, REG_RUN_PATH, 0, winreg.KEY_SET_VALUE) as key:
            if enabled:
                # If running as script or frozen exe
                if getattr(sys, "frozen", False):
                    exe_path = sys.executable
                else:
                    # In dev mode, run python with main.py
                    exe_path = f'"{sys.executable}" "{os.path.abspath(sys.argv[0])}"'
                winreg.SetValueEx(key, APP_REG_NAME, 0, winreg.REG_SZ, exe_path)
                try:
                    winreg.DeleteValue(key, LEGACY_APP_REG_NAME)
                except FileNotFoundError:
                    pass
            else:
                for name in (APP_REG_NAME, LEGACY_APP_REG_NAME):
                    try:
                        winreg.DeleteValue(key, name)
                    except FileNotFoundError:
                        pass
        return True
    except Exception:
        return False
