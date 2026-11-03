"""Tests for UI components initialization and interactions."""

import pytest
import os
from PySide6.QtWidgets import QApplication
from src.database.db import Database
from src.core.profile_manager import ProfileManager
from src.core.template_manager import TemplateManager
from src.core.variable_manager import VariableManager
from src.core.settings_manager import SettingsManager
from src.__version__ import __version__, __app_name__
from src.ui.main_window import MainWindow
from src.ui.dialogs.quick_menu_dialog import QuickMenuDialog
from src.ui.dialogs.variable_dialog import VariableInputDialog
from src.ui.dialogs.settings_dialog import SettingsDialog
from src.ui.dialogs.test_preview_dialog import TestPreviewDialog
from src.ui.components.key_recorder import KeyRecorderDialog


@pytest.fixture(scope="session")
def qapp():
    os.environ["QT_QPA_PLATFORM"] = "offscreen"
    app = QApplication.instance()
    if app is None:
        app = QApplication([])
    return app


@pytest.fixture
def temp_env(tmp_path):
    db_file = str(tmp_path / "ui_test.db")
    db = Database(db_file)
    pm = ProfileManager(db)
    tm = TemplateManager(db)
    vm = VariableManager(db)
    sm = SettingsManager(db)
    return pm, tm, vm, sm


def test_main_window_init(qapp, temp_env):
    pm, tm, vm, sm = temp_env
    window = MainWindow(pm, tm, vm, sm)
    assert window.windowTitle() == f"{__app_name__} v{__version__}"
    assert window.hotkeys_list_widget.count() == 8
    assert window.title_input.text() != ""
    assert window.shortcut_badge.text() != ""


def test_main_window_add_and_save_hotkey(qapp, temp_env):
    pm, tm, vm, sm = temp_env
    window = MainWindow(pm, tm, vm, sm)

    initial_count = window.hotkeys_list_widget.count()
    window._add_new_hotkey()
    assert window.hotkeys_list_widget.count() == initial_count + 1

    window.title_input.setText("Custom Unit Test")
    window.shortcut_badge.setText("Ctrl+F11")
    window.message_edit.setPlainText("Hello {buyer}")
    saved = window.save_current_hotkey()
    assert saved is True

    # Verify item persisted in DB
    item = tm.get_hotkey_by_id(window.current_hotkey.id)
    assert item.title == "Custom Unit Test"
    assert item.shortcut == "Ctrl+F11"
    assert item.message == "Hello {buyer}"


def test_dialogs_init(qapp, temp_env):
    pm, tm, vm, sm = temp_env

    # Quick Menu
    qm = QuickMenuDialog()
    items = tm.get_hotkeys_for_profile(pm.get_active_profile().id)
    qm.show_menu(items, target_hwnd=0)
    assert qm.list_widget.count() == 8
    qm.hide()

    # Variable Dialog
    vd = VariableInputDialog(["robux", "price"], vm)
    assert "robux" in vd.inputs
    assert "price" in vd.inputs

    # Settings Dialog
    sd = SettingsDialog(sm, pm)
    assert sd.tray_cb.isChecked() is True

    # Test Preview Dialog
    pd = TestPreviewDialog("Test Title", "Sample evaluated message", "paste")
    assert pd.text_preview.toPlainText() == "Sample evaluated message"

    # Key Recorder Dialog
    kr = KeyRecorderDialog("F4")
    assert kr.recorded_shortcut == "F4"
