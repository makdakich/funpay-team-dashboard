"""Tests for SQLite database operations and models."""

import pytest
from src.database.db import Database
from src.database.models import HotkeyItem, MODE_PASTE, MODE_PASTE_ENTER, MODE_COPY_ONLY


@pytest.fixture
def temp_db(tmp_path):
    db_file = str(tmp_path / "test.db")
    return Database(db_file)


def test_db_seeding(temp_db):
    profiles = temp_db.get_profiles()
    assert len(profiles) >= 4
    names = [p.name for p in profiles]
    assert "🎮 Robux" in names
    assert "⛏ Minecraft" in names
    assert "🎮 Steam" in names
    assert "🧪 Тест" in names

    robux_profile = next(p for p in profiles if "Robux" in p.name)
    hotkeys = temp_db.get_hotkeys_by_profile(robux_profile.id)
    assert len(hotkeys) == 8
    assert hotkeys[0].shortcut == "F1"
    assert "Приветствие" in hotkeys[0].title
    assert hotkeys[3].shortcut == "F4"
    assert "Game Pass" in hotkeys[3].title


def test_profile_crud(temp_db):
    # Create
    new_id = temp_db.create_profile("⭐ Custom")
    assert new_id > 0
    p = temp_db.get_profile_by_id(new_id)
    assert p.name == "⭐ Custom"

    # Update
    temp_db.update_profile(new_id, "⭐ Custom Updated")
    p_up = temp_db.get_profile_by_id(new_id)
    assert p_up.name == "⭐ Custom Updated"

    # Delete
    deleted = temp_db.delete_profile(new_id)
    assert deleted is True
    assert temp_db.get_profile_by_id(new_id) is None


def test_hotkey_crud(temp_db):
    profiles = temp_db.get_profiles()
    p_id = profiles[0].id

    # Create new hotkey
    item = HotkeyItem(
        profile_id=p_id,
        shortcut="Ctrl+F10",
        title="Test Title",
        message="Hello {buyer}!",
        mode=MODE_PASTE_ENTER,
        enabled=True,
        sort_order=20,
    )
    saved_id = temp_db.save_hotkey(item)
    assert saved_id > 0

    fetched = temp_db.get_hotkey_by_id(saved_id)
    assert fetched.shortcut == "Ctrl+F10"
    assert fetched.mode == MODE_PASTE_ENTER

    # Update
    fetched.title = "Updated Title"
    fetched.mode = MODE_COPY_ONLY
    temp_db.save_hotkey(fetched)

    updated = temp_db.get_hotkey_by_id(saved_id)
    assert updated.title == "Updated Title"
    assert updated.mode == MODE_COPY_ONLY

    # Delete
    temp_db.delete_hotkey(saved_id)
    assert temp_db.get_hotkey_by_id(saved_id) is None


def test_variable_history(temp_db):
    temp_db.add_variable_value("robux", "5000")
    temp_db.add_variable_value("robux", "7500")

    vals = temp_db.get_variable_recent_values("robux", limit=5)
    assert "7500" in vals
    assert "5000" in vals
