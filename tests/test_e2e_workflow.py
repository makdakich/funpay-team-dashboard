"""End-to-end integration test verifying the exact Section 25 MVP criteria."""

import os
import pytest
from PySide6.QtWidgets import QApplication
from src.database.db import Database
from src.core.profile_manager import ProfileManager
from src.core.template_manager import TemplateManager
from src.core.variable_manager import VariableManager
from src.core.settings_manager import SettingsManager
from src.ui.main_window import MainWindow
from src.database.models import MODE_PASTE


@pytest.fixture(scope="session")
def qapp():
    os.environ["QT_QPA_PLATFORM"] = "offscreen"
    app = QApplication.instance()
    if app is None:
        app = QApplication([])
    return app


def test_mvp_lifecycle_and_persistence(qapp, tmp_path):
    db_path = str(tmp_path / "mvp_test.db")

    # Step 1-6: First Run - Start app, select/verify profile and F4, edit text, save
    db1 = Database(db_path)
    pm1 = ProfileManager(db1)
    tm1 = TemplateManager(db1)
    vm1 = VariableManager(db1)
    sm1 = SettingsManager(db1)

    window1 = MainWindow(pm1, tm1, vm1, sm1)

    # Check active profile
    assert "Robux" in window1.current_profile.name

    # Select F4 item in list
    f4_row = -1
    for i in range(window1.hotkeys_list_widget.count()):
        item = window1.hotkeys_list_widget.item(i)
        card = window1.hotkeys_list_widget.itemWidget(item)
        if card.badge.text() == "F4":
            f4_row = i
            break

    assert f4_row >= 0
    window1.hotkeys_list_widget.setCurrentRow(f4_row)

    # Update Title and Text as in MVP test scenario
    window1.title_input.setText("🎮 Game Pass")
    new_text = "Пожалуйста, создайте Game Pass на указанную сумму и отправьте мне ссылку."
    window1.message_edit.setPlainText(new_text)
    window1.mode_paste_rb.setChecked(True)
    saved = window1.save_current_hotkey()
    assert saved is True
    assert window1.current_hotkey.mode == MODE_PASTE

    # Step 12-13: Simulate restart - Re-open same database in a fresh session
    db2 = Database(db_path)
    pm2 = ProfileManager(db2)
    tm2 = TemplateManager(db2)
    vm2 = VariableManager(db2)
    sm2 = SettingsManager(db2)

    window2 = MainWindow(pm2, tm2, vm2, sm2)

    # Verify profile and F4 persisted in database
    assert "Robux" in window2.current_profile.name

    # Find F4 item in restarted window
    f4_item_restarted = None
    for i in range(window2.hotkeys_list_widget.count()):
        item = window2.hotkeys_list_widget.item(i)
        card = window2.hotkeys_list_widget.itemWidget(item)
        if card.badge.text() == "F4":
            window2.hotkeys_list_widget.setCurrentRow(i)
            f4_item_restarted = window2.current_hotkey
            break

    assert f4_item_restarted is not None
    assert f4_item_restarted.title == "🎮 Game Pass"
    assert f4_item_restarted.message == new_text
    assert f4_item_restarted.mode == MODE_PASTE

    # Step 14-15: Modify text in UI, save, verify updated
    modified_text = "Новый измененный текст для Game Pass."
    window2.message_edit.setPlainText(modified_text)
    window2.save_current_hotkey()

    # Verify updated in DB directly
    db_item = tm2.get_hotkey_by_id(f4_item_restarted.id)
    assert db_item.message == modified_text
