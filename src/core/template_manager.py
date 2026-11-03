"""Template manager: CRUD for hotkeys, conflict detection, shortcut validation."""

from typing import List, Optional
from ..database.db import Database
from ..database.models import HotkeyItem, MODE_PASTE
from ..utils.win32_utils import normalize_shortcut

RESERVED_SHORTCUTS = {"Ctrl+Space"}


class TemplateManager:
    def __init__(self, db: Database):
        self.db = db

    def get_hotkeys_for_profile(self, profile_id: int) -> List[HotkeyItem]:
        return self.db.get_hotkeys_by_profile(profile_id)

    def get_hotkey_by_id(self, hotkey_id: int) -> Optional[HotkeyItem]:
        return self.db.get_hotkey_by_id(hotkey_id)

    def is_shortcut_reserved(self, shortcut: str, quick_menu_sc: Optional[str] = None) -> bool:
        """Check if shortcut is reserved for system functions (e.g. Quick Menu)."""
        norm = normalize_shortcut(shortcut)
        reserved = set(RESERVED_SHORTCUTS)
        if quick_menu_sc:
            reserved.add(normalize_shortcut(quick_menu_sc))
        else:
            db_qm = self.db.get_setting("quick_menu_hotkey", "Ctrl+Space")
            reserved.add(normalize_shortcut(db_qm))
        return norm in reserved


    def find_conflict(
        self, profile_id: int, shortcut: str, current_hotkey_id: Optional[int] = None
    ) -> Optional[HotkeyItem]:
        """
        Check if the given shortcut is already used by another item in this profile.
        Returns the conflicting HotkeyItem if found, else None.
        """
        norm = normalize_shortcut(shortcut)
        if not norm:
            return None

        hotkeys = self.get_hotkeys_for_profile(profile_id)
        for h in hotkeys:
            if current_hotkey_id and h.id == current_hotkey_id:
                continue
            if normalize_shortcut(h.shortcut).lower() == norm.lower():
                return h
        return None

    def save_hotkey(self, item: HotkeyItem) -> int:
        """Normalize shortcut and save hotkey item."""
        item.shortcut = normalize_shortcut(item.shortcut)
        return self.db.save_hotkey(item)

    def delete_hotkey(self, hotkey_id: int) -> bool:
        return self.db.delete_hotkey(hotkey_id)

    def create_default_hotkey(self, profile_id: int) -> HotkeyItem:
        """Create a new placeholder hotkey with next available F-key or standard key."""
        hotkeys = self.get_hotkeys_for_profile(profile_id)
        existing_shortcuts = {normalize_shortcut(h.shortcut) for h in hotkeys}

        next_key = "F9"
        # Find first unused F1..F12
        for i in range(1, 13):
            cand = f"F{i}"
            if cand not in existing_shortcuts:
                next_key = cand
                break
        else:
            # Try Ctrl+F1..Ctrl+F12
            for i in range(1, 13):
                cand = f"Ctrl+F{i}"
                if cand not in existing_shortcuts:
                    next_key = cand
                    break

        new_order = len(hotkeys) + 1
        new_item = HotkeyItem(
            profile_id=profile_id,
            shortcut=next_key,
            title="Новое сообщение",
            message="",
            mode=MODE_PASTE,
            enabled=True,
            sort_order=new_order,
        )
        saved_id = self.db.save_hotkey(new_item)
        new_item.id = saved_id
        return new_item

    def duplicate_hotkey(self, hotkey_id: int) -> Optional[HotkeyItem]:
        """Duplicate an existing hotkey without shortcut conflicts."""
        new_id = self.db.duplicate_hotkey(hotkey_id)
        if new_id:
            return self.get_hotkey_by_id(new_id)
        return None

    def update_hotkeys_order(self, profile_id: int, ordered_ids: List[int]) -> bool:
        """Update display sort order for hotkeys in given sequence."""
        return self.db.update_hotkeys_order(profile_id, ordered_ids)
