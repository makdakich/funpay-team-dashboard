"""Profile management: CRUD, active profile tracking, import/export."""

import json
from typing import List, Optional, Tuple
from ..database.db import Database
from ..database.models import Profile, HotkeyItem, MODE_PASTE


class ProfileManager:
    def __init__(self, db: Database):
        self.db = db

    def get_profiles(self) -> List[Profile]:
        return self.db.get_profiles()

    def get_active_profile(self) -> Profile:
        """Get current active profile. Falls back to first available profile."""
        profiles = self.get_profiles()
        if not profiles:
            # Create a default profile if none exists
            new_id = self.db.create_profile("🎮 Основной")
            self.set_active_profile_id(new_id)
            return self.db.get_profile_by_id(new_id)

        active_id_str = self.db.get_setting("active_profile_id", "")
        if active_id_str.isdigit():
            active_id = int(active_id_str)
            for p in profiles:
                if p.id == active_id:
                    return p

        # Fallback to first
        first = profiles[0]
        self.set_active_profile_id(first.id)
        return first

    def set_active_profile_id(self, profile_id: int) -> None:
        self.db.set_setting("active_profile_id", str(profile_id))

    def get_profile_by_id(self, profile_id: int) -> Optional[Profile]:
        return self.db.get_profile_by_id(profile_id)

    def create_profile(self, name: str) -> Optional[Profile]:
        clean_name = name.strip()
        if not clean_name:
            return None
        new_id = self.db.create_profile(clean_name)
        return self.db.get_profile_by_id(new_id)

    def rename_profile(self, profile_id: int, new_name: str) -> bool:
        clean_name = new_name.strip()
        if not clean_name:
            return False
        return self.db.update_profile(profile_id, clean_name)

    def delete_profile(self, profile_id: int) -> bool:
        success = self.db.delete_profile(profile_id)
        if success:
            # If deleted active profile, reset active profile to first available
            active = self.get_active_profile()
            self.set_active_profile_id(active.id)
        return success

    def duplicate_profile(self, profile_id: int) -> Optional[Profile]:
        """Duplicate a profile with all its hotkeys."""
        new_id = self.db.duplicate_profile(profile_id)
        if new_id:
            return self.db.get_profile_by_id(new_id)
        return None

    def update_profile_switch_shortcut(self, profile_id: int, shortcut: str) -> bool:
        return self.db.update_profile_switch_shortcut(profile_id, shortcut)

    def export_profile(self, profile_id: int, file_path: str) -> bool:
        """Export profile and its hotkeys to a .fhkprofile JSON file."""
        profile = self.db.get_profile_by_id(profile_id)
        if not profile:
            return False

        hotkeys = self.db.get_hotkeys_by_profile(profile_id)
        data = {
            "app": "FunPayHotkeys",
            "version": "1.0",
            "profile_name": profile.name,
            "hotkeys": [
                {
                    "shortcut": h.shortcut,
                    "title": h.title,
                    "message": h.message,
                    "mode": h.mode,
                    "enabled": h.enabled,
                    "sort_order": h.sort_order,
                }
                for h in hotkeys
            ],
        }

        try:
            with open(file_path, "w", encoding="utf-8") as f:
                json.dump(data, f, ensure_ascii=False, indent=2)
            return True
        except Exception:
            return False

    def import_profile(self, file_path: str) -> Tuple[bool, Optional[Profile], str]:
        """
        Import profile from a .fhkprofile file.
        Returns (success, new_profile, error_message).
        """
        try:
            with open(file_path, "r", encoding="utf-8") as f:
                data = json.load(f)
        except Exception as e:
            return False, None, f"Не удалось прочитать файл: {str(e)}"

        if not isinstance(data, dict) or data.get("app") not in ("FanPayHotkeys", "FunPayHotkeys"):
            return False, None, "Неверный формат файла .fhkprofile"

        base_name = data.get("profile_name", "Импортированный профиль").strip()
        existing_profiles = self.get_profiles()
        existing_names = {p.name.lower() for p in existing_profiles}

        target_name = base_name
        counter = 1
        while target_name.lower() in existing_names:
            target_name = f"{base_name} ({counter})"
            counter += 1

        new_profile_id = self.db.create_profile(target_name)
        new_profile = self.db.get_profile_by_id(new_profile_id)

        raw_hotkeys = data.get("hotkeys", [])
        for idx, item_data in enumerate(raw_hotkeys):
            shortcut = item_data.get("shortcut", "").strip()
            title = item_data.get("title", f"Шаблон {idx + 1}").strip()
            message = item_data.get("message", "")
            mode = item_data.get("mode", MODE_PASTE)
            enabled = bool(item_data.get("enabled", True))
            sort_order = item_data.get("sort_order", idx + 1)

            if shortcut and title:
                item = HotkeyItem(
                    profile_id=new_profile_id,
                    shortcut=shortcut,
                    title=title,
                    message=message,
                    mode=mode,
                    enabled=enabled,
                    sort_order=sort_order,
                )
                self.db.save_hotkey(item)

        return True, new_profile, ""
