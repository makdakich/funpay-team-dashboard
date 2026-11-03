"""Tests for customizable Quick Menu shortcut and dynamic reservation."""

import pytest
from src.database.db import Database
from src.core.settings_manager import SettingsManager
from src.core.template_manager import TemplateManager


@pytest.fixture
def qm_env(tmp_path):
    db_path = str(tmp_path / "qm_test.db")
    db = Database(db_path)
    sm = SettingsManager(db)
    tm = TemplateManager(db)
    return db, sm, tm


def test_default_quick_menu_hotkey(qm_env):
    db, sm, tm = qm_env
    assert sm.get_quick_menu_hotkey() == "Ctrl+Space"
    assert tm.is_shortcut_reserved("Ctrl+Space")


def test_custom_quick_menu_hotkey_setting(qm_env):
    db, sm, tm = qm_env
    sm.set_quick_menu_hotkey("Alt+Q")
    assert sm.get_quick_menu_hotkey() == "Alt+Q"

    # Verify template manager sees Alt+Q as reserved
    assert tm.is_shortcut_reserved("Alt+Q")
    # Base Ctrl+Space is also reserved
    assert tm.is_shortcut_reserved("Ctrl+Space")
    # Regular key is not reserved
    assert not tm.is_shortcut_reserved("F1")
