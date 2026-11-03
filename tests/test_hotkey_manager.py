"""Tests for hotkey parsing, normalization, and conflict checking."""

import pytest
from src.utils.win32_utils import normalize_shortcut, parse_hotkey_string, MOD_CONTROL, MOD_ALT, MOD_NOREPEAT
from src.core.template_manager import TemplateManager
from src.database.db import Database
from src.database.models import HotkeyItem, MODE_PASTE


def test_normalize_shortcut():
    assert normalize_shortcut("f4") == "F4"
    assert normalize_shortcut("ctrl+f4") == "Ctrl+F4"
    assert normalize_shortcut("ctrl + alt + 1") == "Ctrl+Alt+1"
    assert normalize_shortcut("shift+ctrl+f2") == "Ctrl+Shift+F2"
    assert normalize_shortcut("ctrl+space") == "Ctrl+SPACE" or normalize_shortcut("ctrl+space") == "Ctrl+Space"


def test_parse_hotkey_string():
    mods, vk = parse_hotkey_string("F4")
    assert mods == MOD_NOREPEAT
    assert vk == 0x73  # VK_F4

    mods, vk = parse_hotkey_string("Ctrl+F4")
    assert mods == (MOD_NOREPEAT | MOD_CONTROL)
    assert vk == 0x73

    mods, vk = parse_hotkey_string("Ctrl+Alt+A")
    assert mods == (MOD_NOREPEAT | MOD_CONTROL | MOD_ALT)
    assert vk == ord("A")


def test_invalid_hotkey_string():
    with pytest.raises(ValueError):
        parse_hotkey_string("")

    with pytest.raises(ValueError):
        parse_hotkey_string("Ctrl+UnknownKey123")


def test_conflict_detection_and_reserved_key(tmp_path):
    db = Database(str(tmp_path / "conflict.db"))
    mgr = TemplateManager(db)
    
    # Create clean test profile
    p_id = db.create_profile("Empty Profile")

    # Add hotkey F4 to this empty profile
    item = HotkeyItem(
        profile_id=p_id,
        shortcut="F4",
        title="Game Pass",
        message="Test msg",
        mode=MODE_PASTE,
        enabled=True,
    )
    saved_id = db.save_hotkey(item)

    # Check conflict with exact and case-insensitive
    conflict = mgr.find_conflict(p_id, "f4")
    assert conflict is not None
    assert conflict.id == saved_id

    # Self-exclusion should not report conflict
    conflict_self = mgr.find_conflict(p_id, "F4", current_hotkey_id=saved_id)
    assert conflict_self is None

    # Unrelated shortcut should have no conflict
    assert mgr.find_conflict(p_id, "F12") is None

    # Reserved key check: Ctrl+Space is reserved for Quick Menu
    assert mgr.is_shortcut_reserved("Ctrl+Space") is True
    assert mgr.is_shortcut_reserved("ctrl+space") is True
    assert mgr.is_shortcut_reserved("F4") is False
