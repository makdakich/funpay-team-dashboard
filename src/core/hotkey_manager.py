"""Global hotkey listener using Windows RegisterHotKey with pynput fallback."""

import time
import ctypes
import threading
from ctypes import wintypes
from typing import Dict, List, Optional, Tuple
from PySide6.QtCore import QObject, Signal

from ..utils.win32_utils import parse_hotkey_string, normalize_shortcut, user32, kernel32, MOD_NOREPEAT

WM_HOTKEY = 0x0312
WM_QUIT = 0x0012
QUICK_MENU_ID = 999999
COOLDOWN_SECONDS = 0.35  # Debounce to prevent double trigger or key hold paste


class HotkeyManager(QObject):
    # Signals emitted to Qt main thread
    hotkey_triggered = Signal(str)      # shortcut string (e.g. "F4", "Ctrl+F1")
    quick_menu_triggered = Signal()    # Quick Menu (Ctrl+Space)
    profile_switch_triggered = Signal(int)  # profile_id

    def __init__(self, parent: Optional[QObject] = None):
        super().__init__(parent)
        self._thread: Optional[threading.Thread] = None
        self._thread_id: Optional[int] = None
        self._stop_requested = False
        self._ready_event = threading.Event()

        # Shortcuts to register: list of shortcut strings
        self._shortcuts_to_register: List[str] = []
        self._quick_menu_shortcut: str = "Ctrl+Space"
        self._profile_shortcuts: Dict[int, str] = {}  # profile_id -> shortcut

        # Mapping id -> shortcut string
        self._id_to_shortcut: Dict[int, str] = {}
        self._id_to_profile: Dict[int, int] = {}
        # Failed registrations: list of (shortcut, error_reason)
        self._failed_hotkeys: List[Tuple[str, str]] = []

        # Cooldown tracker
        self._last_trigger_times: Dict[str, float] = {}

    def update_hotkeys(
        self,
        shortcuts: List[str],
        quick_menu_shortcut: str = "Ctrl+Space",
        profile_shortcuts: Optional[Dict[int, str]] = None,
    ) -> List[Tuple[str, str]]:
        """
        Stop previous listener thread, register new shortcuts, and start listener thread.
        Returns list of failed shortcuts: [(shortcut, reason)].
        """
        self.stop()

        self._shortcuts_to_register = list(dict.fromkeys([normalize_shortcut(s) for s in shortcuts if s.strip()]))
        self._quick_menu_shortcut = normalize_shortcut(quick_menu_shortcut) if quick_menu_shortcut else ""
        self._profile_shortcuts = {
            pid: normalize_shortcut(sc) for pid, sc in (profile_shortcuts or {}).items() if sc.strip()
        }

        self.start()
        return self._failed_hotkeys

    def start(self) -> None:
        """Start the hotkey listener thread."""
        if self._thread and self._thread.is_alive():
            return

        self._stop_requested = False
        self._ready_event.clear()
        self._thread = threading.Thread(target=self._worker_loop, daemon=True)
        self._thread.start()
        self._ready_event.wait(timeout=2.0)

    def stop(self) -> None:
        """Gracefully stop the hotkey listener thread."""
        self._stop_requested = True
        if self._thread_id and user32:
            try:
                user32.PostThreadMessageW(self._thread_id, WM_QUIT, 0, 0)
            except Exception:
                pass

        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=1.0)
        self._thread = None
        self._thread_id = None

    def _worker_loop(self) -> None:
        """Background thread message loop for RegisterHotKey."""
        self._thread_id = kernel32.GetCurrentThreadId()

        # Ensure message queue is created
        msg = wintypes.MSG()
        user32.PeekMessageW(ctypes.byref(msg), 0, 0, 0, 0)

        self._id_to_shortcut.clear()
        self._id_to_profile.clear()
        self._failed_hotkeys.clear()

        registered_ids = []

        # 1. Register regular hotkeys
        current_id = 1
        for sc in self._shortcuts_to_register:
            try:
                mods, vk = parse_hotkey_string(sc)
                success = user32.RegisterHotKey(0, current_id, mods, vk)
                if success:
                    self._id_to_shortcut[current_id] = sc
                    registered_ids.append(current_id)
                    current_id += 1
                else:
                    self._failed_hotkeys.append((sc, "Занят другой программой или системой"))
            except Exception as e:
                self._failed_hotkeys.append((sc, str(e)))

        # 2. Register Quick Menu hotkey (Ctrl+Space by default)
        if self._quick_menu_shortcut:
            try:
                mods, vk = parse_hotkey_string(self._quick_menu_shortcut)
                success = user32.RegisterHotKey(0, QUICK_MENU_ID, mods, vk)
                if success:
                    registered_ids.append(QUICK_MENU_ID)
                else:
                    self._failed_hotkeys.append((self._quick_menu_shortcut, "Quick Menu hotkey занят"))
            except Exception as e:
                self._failed_hotkeys.append((self._quick_menu_shortcut, str(e)))

        # 3. Register Profile switch hotkeys
        for pid, sc in self._profile_shortcuts.items():
            try:
                mods, vk = parse_hotkey_string(sc)
                prof_hk_id = 800000 + pid
                success = user32.RegisterHotKey(0, prof_hk_id, mods, vk)
                if success:
                    self._id_to_profile[prof_hk_id] = pid
                    registered_ids.append(prof_hk_id)
                else:
                    self._failed_hotkeys.append((sc, f"Хоткей профиля {sc} занят"))
            except Exception as e:
                self._failed_hotkeys.append((sc, str(e)))

        self._ready_event.set()

        # Windows Message Loop
        while not self._stop_requested:
            res = user32.GetMessageW(ctypes.byref(msg), 0, 0, 0)
            if res <= 0:  # WM_QUIT or error
                break

            if msg.message == WM_HOTKEY:
                hk_id = msg.wParam
                now = time.time()

                if hk_id == QUICK_MENU_ID:
                    last = self._last_trigger_times.get("__quick_menu__", 0.0)
                    if now - last >= COOLDOWN_SECONDS:
                        self._last_trigger_times["__quick_menu__"] = now
                        self.quick_menu_triggered.emit()
                elif hk_id in self._id_to_profile:
                    pid = self._id_to_profile[hk_id]
                    last = self._last_trigger_times.get(f"__prof_{pid}__", 0.0)
                    if now - last >= COOLDOWN_SECONDS:
                        self._last_trigger_times[f"__prof_{pid}__"] = now
                        self.profile_switch_triggered.emit(pid)
                elif hk_id in self._id_to_shortcut:
                    sc = self._id_to_shortcut[hk_id]
                    last = self._last_trigger_times.get(sc, 0.0)
                    if now - last >= COOLDOWN_SECONDS:
                        self._last_trigger_times[sc] = now
                        self.hotkey_triggered.emit(sc)

        # Cleanup registrations upon thread exit
        for hid in registered_ids:
            try:
                user32.UnregisterHotKey(0, hid)
            except Exception:
                pass
