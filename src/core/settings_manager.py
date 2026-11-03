"""Settings manager for application preferences and persistence."""

from typing import List
from ..database.db import Database
from ..utils.win32_utils import is_autostart_enabled, set_autostart_enabled

DEFAULT_WHITELIST = [
    "chrome.exe",
    "msedge.exe",
    "firefox.exe",
    "opera.exe",
    "brave.exe",
    "yandex.exe",
]


class SettingsManager:
    def __init__(self, db: Database):
        self.db = db

    def is_hotkeys_enabled(self) -> bool:
        val = self.db.get_setting("hotkeys_enabled", "1")
        return val == "1"

    def set_hotkeys_enabled(self, enabled: bool) -> None:
        self.db.set_setting("hotkeys_enabled", "1" if enabled else "0")

    def is_minimize_to_tray(self) -> bool:
        val = self.db.get_setting("minimize_to_tray", "1")
        return val == "1"

    def set_minimize_to_tray(self, enabled: bool) -> None:
        self.db.set_setting("minimize_to_tray", "1" if enabled else "0")

    def is_autostart(self) -> bool:
        # Check actual registry state or fall back to db
        return is_autostart_enabled()

    def set_autostart(self, enabled: bool) -> bool:
        success = set_autostart_enabled(enabled)
        if success:
            self.db.set_setting("autostart", "1" if enabled else "0")
        return success

    def get_app_filter_mode(self) -> str:
        return self.db.get_setting("app_filter_mode", "global")

    def set_app_filter_mode(self, mode: str) -> None:
        if mode in ("global", "whitelist"):
            self.db.set_setting("app_filter_mode", mode)

    def get_app_whitelist(self) -> List[str]:
        raw = self.db.get_setting("app_whitelist", ",".join(DEFAULT_WHITELIST))
        items = [x.strip().lower() for x in raw.split(",") if x.strip()]
        return items if items else DEFAULT_WHITELIST

    def set_app_whitelist(self, apps: List[str]) -> None:
        clean = [a.strip().lower() for a in apps if a.strip()]
        self.db.set_setting("app_whitelist", ",".join(clean))

    def is_app_allowed(self, process_name: str) -> bool:
        """Check if hotkey is allowed in the currently active process."""
        mode = self.get_app_filter_mode()
        if mode == "global" or not process_name:
            return True

        whitelist = self.get_app_whitelist()
        return process_name.lower() in whitelist

    def get_quick_menu_hotkey(self) -> str:
        return self.db.get_setting("quick_menu_hotkey", "Ctrl+Space")

    def set_quick_menu_hotkey(self, shortcut: str) -> None:
        self.db.set_setting("quick_menu_hotkey", shortcut.strip())

    def get_theme_accent(self) -> str:
        return self.db.get_setting("theme_accent", "emerald")

    def set_theme_accent(self, theme_name: str) -> None:
        self.db.set_setting("theme_accent", theme_name.strip().lower())

    def is_notifications_enabled(self) -> bool:
        return self.db.get_setting("notifications_enabled", "1") == "1"

    def set_notifications_enabled(self, enabled: bool) -> None:
        self.db.set_setting("notifications_enabled", "1" if enabled else "0")

    def is_usage_history_enabled(self) -> bool:
        return self.db.get_setting("usage_history_enabled", "1") == "1"

    def set_usage_history_enabled(self, enabled: bool) -> None:
        self.db.set_setting("usage_history_enabled", "1" if enabled else "0")

    def get_clipboard_restore_delay_ms(self) -> int:
        try:
            return int(self.db.get_setting("clipboard_restore_delay_ms", "120"))
        except ValueError:
            return 120

    def set_clipboard_restore_delay_ms(self, ms: int) -> None:
        self.db.set_setting("clipboard_restore_delay_ms", str(max(20, min(1000, ms))))

