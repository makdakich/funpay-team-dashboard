"""Tests for ProfileManager import/export functionality."""

import os
from src.core.profile_manager import ProfileManager
from src.database.db import Database
from src.database.models import HotkeyItem, MODE_PASTE_ENTER


def test_export_and_import_profile(tmp_path):
    db1_path = str(tmp_path / "db1.db")
    db2_path = str(tmp_path / "db2.db")
    export_file = str(tmp_path / "test_profile.fhkprofile")

    db1 = Database(db1_path)
    mgr1 = ProfileManager(db1)

    # Create a profile in db1 with hotkeys
    p = mgr1.create_profile("⭐ Custom Trade")
    item = HotkeyItem(
        profile_id=p.id,
        shortcut="Ctrl+F9",
        title="Custom Title",
        message="Message with {buyer} and {price}",
        mode=MODE_PASTE_ENTER,
        enabled=True,
        sort_order=1,
    )
    db1.save_hotkey(item)

    # Export
    exported = mgr1.export_profile(p.id, export_file)
    assert exported is True
    assert os.path.exists(export_file)

    # Import into db2
    db2 = Database(db2_path)
    mgr2 = ProfileManager(db2)

    success, imported_p, err = mgr2.import_profile(export_file)
    assert success is True
    assert imported_p is not None
    assert imported_p.name == "⭐ Custom Trade"

    # Verify hotkeys imported
    imported_hotkeys = db2.get_hotkeys_by_profile(imported_p.id)
    assert len(imported_hotkeys) == 1
    assert imported_hotkeys[0].shortcut == "Ctrl+F9"
    assert imported_hotkeys[0].title == "Custom Title"
    assert imported_hotkeys[0].mode == MODE_PASTE_ENTER

    # Re-import to verify unique name generation
    success2, imported_p2, _ = mgr2.import_profile(export_file)
    assert success2 is True
    assert imported_p2.name == "⭐ Custom Trade (1)"
