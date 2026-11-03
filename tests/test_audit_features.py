"""Unit and integration tests for features added during technical audit."""

import os
import time
import pytest
from PySide6.QtWidgets import QApplication
from PySide6.QtCore import Qt
from src.database.db import Database
from src.core.profile_manager import ProfileManager
from src.core.template_manager import TemplateManager
from src.core.variable_manager import VariableManager
from src.core.clipboard_manager import ClipboardManager
from src.core.hotkey_manager import HotkeyManager
from src.ui.components.activity_chart import ActivityChartWidget
from src.ui.components.toast import ToastNotification


@pytest.fixture
def test_db(tmp_path):
    db_path = str(tmp_path / "test_audit.db")
    db = Database(db_path=db_path)
    return db


def test_backup_and_restore(test_db):
    """Test SQLite online backup creation, listing, rotation, and restoration."""
    # 1. Create a baseline profile
    initial_profiles = test_db.get_profiles()
    assert len(initial_profiles) >= 1

    # 2. Create backup
    backup_path = test_db.create_backup(tag="audit_test", max_generations=5)
    assert backup_path is not None
    assert os.path.exists(backup_path)
    assert os.path.getsize(backup_path) > 0

    # 3. List backups
    backups = test_db.list_backups()
    assert len(backups) >= 1
    assert backups[0]["path"] == backup_path

    # 4. Modify database state
    new_pid = test_db.create_profile("Temporary Profile To Erase")
    assert test_db.get_profile_by_id(new_pid) is not None

    # 5. Restore from backup
    restore_ok = test_db.restore_backup(backup_path)
    assert restore_ok is True

    # 6. Verify restored database no longer has the temporary profile
    restored_profile = test_db.get_profile_by_id(new_pid)
    assert restored_profile is None


def test_duplicate_profile(test_db):
    """Test profile duplication with unique naming and hotkey copying."""
    pm = ProfileManager(test_db)
    active = pm.get_active_profile()

    # Duplicate once
    dup1 = pm.duplicate_profile(active.id)
    assert dup1 is not None
    assert dup1.name == f"{active.name} (Копия)"
    assert dup1.id != active.id

    # Verify duplicate profile inherited hotkeys
    tm = TemplateManager(test_db)
    orig_hotkeys = tm.get_hotkeys_for_profile(active.id)
    dup_hotkeys = tm.get_hotkeys_for_profile(dup1.id)
    assert len(dup_hotkeys) == len(orig_hotkeys)

    # Duplicate second time -> should append counter
    dup2 = pm.duplicate_profile(active.id)
    assert dup2 is not None
    assert dup2.name == f"{active.name} (Копия 2)"


def test_duplicate_hotkey(test_db):
    """Test hotkey duplication with conflict-safe blank shortcut."""
    tm = TemplateManager(test_db)
    pm = ProfileManager(test_db)
    active = pm.get_active_profile()
    hotkeys = tm.get_hotkeys_for_profile(active.id)
    assert len(hotkeys) > 0

    target = hotkeys[0]
    dup = tm.duplicate_hotkey(target.id)
    assert dup is not None
    assert dup.title == f"{target.title} (Копия)"
    assert dup.shortcut == ""  # Safe blank shortcut to prevent instant conflict
    assert dup.message == target.message
    assert dup.mode == target.mode
    assert dup.profile_id == target.profile_id


def test_update_hotkeys_order(test_db):
    """Test drag-and-drop sort order persistence."""
    tm = TemplateManager(test_db)
    pm = ProfileManager(test_db)
    active = pm.get_active_profile()
    hotkeys = tm.get_hotkeys_for_profile(active.id)
    assert len(hotkeys) >= 3

    # Reverse the order
    reversed_ids = [h.id for h in reversed(hotkeys)]
    ok = tm.update_hotkeys_order(active.id, reversed_ids)
    assert ok is True

    reloaded = tm.get_hotkeys_for_profile(active.id)
    reloaded_ids = [h.id for h in reloaded]
    assert reloaded_ids == reversed_ids


def test_typed_variables_and_validation(test_db):
    """Test typed variables parsing, validation, and substitution."""
    vm = VariableManager(test_db)

    template = "Привет, твой заказ на {robux:number} R$ стоит {price:price} руб. Ник: {buyer:text}."

    # 1. Parsing typed variables
    defs = vm.extract_variable_definitions(template)
    assert len(defs) == 3
    assert defs[0].name == "robux" and defs[0].var_type == "number"
    assert defs[1].name == "price" and defs[1].var_type == "price"
    assert defs[2].name == "buyer" and defs[2].var_type == "text"

    # Backward compatible extract_variables
    names = vm.extract_variables(template)
    assert names == ["robux", "price", "buyer"]

    # 2. Validation
    # number
    valid, _ = vm.validate_value("number", "1000")
    assert valid is True
    valid, err = vm.validate_value("number", "abc")
    assert valid is False
    assert "цифры" in err

    # price
    valid, _ = vm.validate_value("price", "199.99")
    assert valid is True
    valid, err = vm.validate_value("price", "not-a-price")
    assert valid is False
    assert "число" in err

    # text
    valid, _ = vm.validate_value("text", "Любой текст 123!")
    assert valid is True

    # 3. Substitution
    result = vm.substitute(template, {"robux": "5000", "price": "1499", "buyer": "Alex"})
    assert result == "Привет, твой заказ на 5000 R$ стоит 1499 руб. Ник: Alex."


def test_quick_chip_presets(test_db):
    """Test quick preset values for typed variables."""
    vm = VariableManager(test_db)
    presets = vm.get_quick_values("robux")
    assert "100" in presets
    assert "1000" in presets
    assert "5000" in presets


def test_usage_history_logging(test_db):
    """Test logging and querying of executed hotkey actions."""
    test_db.log_hotkey_usage("F1", "Robux", "Приветствие", "Здравствуйте! Чем могу помочь?")
    test_db.log_hotkey_usage("F4", "Robux", "Game Pass", "Создайте Game Pass...")

    history = test_db.get_usage_history(limit=10)
    assert len(history) == 2
    assert history[0].shortcut == "F4"
    assert history[1].shortcut == "F1"

    # Clear history
    test_db.clear_usage_history()
    assert len(test_db.get_usage_history()) == 0


def test_profile_switch_shortcut(test_db):
    """Test setting and getting profile switch hotkey."""
    pm = ProfileManager(test_db)
    p = pm.get_active_profile()

    ok = pm.update_profile_switch_shortcut(p.id, "Ctrl+Alt+1")
    assert ok is True

    reloaded = pm.get_profile_by_id(p.id)
    assert reloaded.switch_shortcut == "Ctrl+Alt+1"


def test_clipboard_manager_serial_queue():
    """Test sequential processing and wait_for_idle in ClipboardManager."""
    cm = ClipboardManager()
    cm.execute_hotkey_action("Text 1", mode="copy_only")
    cm.wait_for_idle(timeout=0.5)
    assert cm._action_queue.empty()


def test_activity_chart_widget_renders(qapp):
    """Verify ActivityChartWidget paints cleanly without exceptions."""
    data = [
        {"date": "2026-03-25", "messages": 10},
        {"date": "2026-03-26", "messages": 25},
        {"date": "2026-03-27", "messages": 50},
    ]
    chart = ActivityChartWidget()
    chart.resize(350, 120)
    chart.set_data(data)
    chart.repaint()
    assert chart.width() >= 320


def test_toast_notification(qapp):
    """Verify ToastNotification spawns safely."""
    toast = ToastNotification()
    toast.show_message("Тестовое уведомление", duration_ms=200)
    assert toast.text_label.text() == "Тестовое уведомление"
    assert toast.windowFlags() & Qt.ToolTip
    toast.close()
