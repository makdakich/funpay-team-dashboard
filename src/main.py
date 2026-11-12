"""Entry point for FunPay Hotkeys application."""

import sys
import os
import ctypes
from PySide6.QtWidgets import QApplication
from PySide6.QtCore import Qt, QObject

from .database.db import Database
from .core.profile_manager import ProfileManager
from .core.template_manager import TemplateManager
from .core.variable_manager import VariableManager
from .core.settings_manager import SettingsManager
from .core.clipboard_manager import ClipboardManager
from .core.hotkey_manager import HotkeyManager
from .core.shift_manager import ShiftManager
from .ui.styles import DARK_THEME_QSS, get_dark_theme_qss
from .ui.main_window import MainWindow
from .ui.tray_manager import TrayManager
from .ui.dialogs.quick_menu_dialog import QuickMenuDialog
from .ui.dialogs.variable_dialog import VariableInputDialog
from .ui.components.toast import ToastNotification
from .utils.win32_utils import (
    get_foreground_window,
    set_foreground_window,
    get_window_process_name,
    normalize_shortcut,
)


class AppController(QObject):
    def __init__(self, app: QApplication):
        super().__init__()
        self.app = app

        # Initialize Database and core managers
        self.db = Database()
        self.db.auto_backup_on_startup()  # Safe auto backup up to 7 generations

        self.profile_mgr = ProfileManager(self.db)
        self.template_mgr = TemplateManager(self.db)
        self.variable_mgr = VariableManager(self.db)
        self.settings_mgr = SettingsManager(self.db)
        self.shift_mgr = ShiftManager(self.db)
        self.clipboard_mgr = ClipboardManager()
        self.hotkey_mgr = HotkeyManager()

        # Apply saved theme accent
        saved_theme = self.settings_mgr.get_theme_accent()
        self.app.setStyleSheet(get_dark_theme_qss(saved_theme))

        # Initialize UI components
        self.main_window = MainWindow(
            self.profile_mgr,
            self.template_mgr,
            self.variable_mgr,
            self.settings_mgr,
            self.shift_mgr,
        )
        self.tray_mgr = TrayManager(self.profile_mgr, self.settings_mgr, self.main_window)
        self.quick_menu = QuickMenuDialog()

        # Connect signals
        self._wire_signals()

        # Initial registration of hotkeys
        self.sync_hotkeys()

    def _wire_signals(self):
        # Hotkey listener signals
        self.hotkey_mgr.hotkey_triggered.connect(self._handle_hotkey_triggered)
        self.hotkey_mgr.quick_menu_triggered.connect(self._handle_quick_menu_triggered)
        self.hotkey_mgr.profile_switch_triggered.connect(self._handle_profile_switch)

        # Main window changes
        self.main_window.hotkeys_configuration_changed.connect(self.sync_hotkeys)

        # Tray signals
        self.tray_mgr.show_main_window_requested.connect(self._show_main_window)
        self.tray_mgr.toggle_hotkeys_requested.connect(self._toggle_hotkeys_from_tray)
        self.tray_mgr.profile_selected.connect(self._handle_profile_switch)
        self.tray_mgr.open_settings_requested.connect(self.main_window._open_settings_dialog)
        self.tray_mgr.quit_requested.connect(self._quit_app)

        # Quick Menu selection & actions
        self.quick_menu.template_selected.connect(self._handle_quick_menu_selection)
        self.quick_menu.profile_switch_requested.connect(self._handle_profile_switch)
        self.quick_menu.toggle_shift_requested.connect(self._handle_quick_menu_shift_toggle)

    def sync_hotkeys(self):
        """Re-sync global hotkeys with active profile and global enabled status."""
        enabled = self.settings_mgr.is_hotkeys_enabled()
        self.tray_mgr.update_icon(enabled)

        if not enabled:
            self.hotkey_mgr.update_hotkeys([], quick_menu_shortcut="", profile_shortcuts={})
            return

        active_p = self.profile_mgr.get_active_profile()
        hotkeys = self.template_mgr.get_hotkeys_for_profile(active_p.id)

        shortcuts = [
            h.shortcut for h in hotkeys if h.enabled and h.shortcut.strip()
        ]
        quick_menu_sc = self.settings_mgr.get_quick_menu_hotkey()

        # Gather profile switch shortcuts
        profiles = self.profile_mgr.get_profiles()
        profile_shortcuts = {
            p.id: p.switch_shortcut for p in profiles if p.switch_shortcut and p.switch_shortcut.strip()
        }

        failed = self.hotkey_mgr.update_hotkeys(
            shortcuts,
            quick_menu_shortcut=quick_menu_sc,
            profile_shortcuts=profile_shortcuts,
        )
        if failed:
            failed_str = ", ".join([f"{sc} ({reason})" for sc, reason in failed])
            self.main_window.statusBar.showMessage(
                f"Внимание: не удалось зарегистрировать некоторые хоткеи: {failed_str}",
                5000,
            )

    def _handle_hotkey_triggered(self, shortcut_str: str):
        """
        Data-driven hotkey execution: lookup current template by shortcut in active profile.
        """
        if not self.settings_mgr.is_hotkeys_enabled():
            return

        target_hwnd = get_foreground_window()
        proc_name = get_window_process_name(target_hwnd)

        # Check app filter whitelist if enabled
        if not self.settings_mgr.is_app_allowed(proc_name):
            return

        active_p = self.profile_mgr.get_active_profile()
        hotkeys = self.template_mgr.get_hotkeys_for_profile(active_p.id)

        norm_sc = normalize_shortcut(shortcut_str)
        matched_item = None
        for h in hotkeys:
            if h.enabled and normalize_shortcut(h.shortcut) == norm_sc:
                matched_item = h
                break

        if not matched_item:
            return

        # Execute template
        self._execute_template(matched_item, target_hwnd)

    def _handle_profile_switch(self, profile_id: int):
        """Switch active profile, reload UI, re-sync hotkeys, and show toast notification."""
        self.profile_mgr.set_active_profile_id(profile_id)
        self.main_window.reload_profiles_list()
        self.main_window.reload_hotkeys_list()
        self.sync_hotkeys()

        active_p = self.profile_mgr.get_active_profile()
        if self.settings_mgr.is_notifications_enabled():
            ToastNotification.notify(f"Профиль: {active_p.name}", "#10b981")

    def _handle_quick_menu_shift_toggle(self):
        """Toggle work shift from quick menu."""
        if self.shift_mgr.is_active:
            self.shift_mgr.stop_shift()
            if self.settings_mgr.is_notifications_enabled():
                ToastNotification.notify("Смена завершена", "#f43f5e")
        else:
            active_p = self.profile_mgr.get_active_profile()
            self.shift_mgr.start_shift(active_p.name)
            if self.settings_mgr.is_notifications_enabled():
                ToastNotification.notify(f"Смена начата ({active_p.name})", "#10b981")
        self.main_window.shift_widget._update_display_state()

    def _handle_quick_menu_triggered(self):
        """Open Quick Menu popup over active window with active profile, shift status, and items."""
        if not self.settings_mgr.is_hotkeys_enabled():
            return

        target_hwnd = get_foreground_window()
        proc_name = get_window_process_name(target_hwnd)

        if not self.settings_mgr.is_app_allowed(proc_name):
            return

        active_p = self.profile_mgr.get_active_profile()
        items = self.template_mgr.get_hotkeys_for_profile(active_p.id)
        enabled_items = [h for h in items if h.enabled]

        self.quick_menu.show_menu(
            enabled_items,
            target_hwnd,
            profiles=self.profile_mgr.get_profiles(),
            active_profile_id=active_p.id,
            shift_active=self.shift_mgr.is_active,
            shift_text=self.shift_mgr.get_formatted_elapsed(),
        )

    def _handle_quick_menu_selection(self, hotkey_id: int, target_hwnd: int):
        item = self.template_mgr.get_hotkey_by_id(hotkey_id)
        if item:
            self._execute_template(item, target_hwnd)

    def _execute_template(self, item, target_hwnd: int):
        """Execute template insertion, evaluating variables if needed, logging usage."""
        raw_msg = item.message
        vars_list = self.variable_mgr.extract_variables(raw_msg)

        if vars_list:
            # Show input dialog for variables
            var_dlg = VariableInputDialog(vars_list, self.variable_mgr)
            if var_dlg.exec():
                final_text = self.variable_mgr.substitute(raw_msg, var_dlg.values)
            else:
                return  # Cancelled by user
        else:
            final_text = raw_msg

        # Restore focus to target window before pasting
        if target_hwnd:
            set_foreground_window(target_hwnd)

        self.clipboard_mgr.execute_hotkey_action(final_text, item.mode)
        self.shift_mgr.record_message()

        # Log hotkey usage history if enabled
        if self.settings_mgr.is_usage_history_enabled():
            active_p = self.profile_mgr.get_active_profile()
            self.db.log_hotkey_usage(
                shortcut=item.shortcut,
                profile_name=active_p.name if active_p else "",
                title=item.title,
                preview=final_text,
            )

        # Notify via toast if enabled
        if self.settings_mgr.is_notifications_enabled():
            ToastNotification.notify(f"Вставлено: {item.shortcut} — {item.title}", "#10b981", duration_ms=1200)

    def _show_main_window(self):
        self.main_window.show()
        self.main_window.setWindowState(
            self.main_window.windowState() & ~Qt.WindowMinimized | Qt.WindowActive
        )
        self.main_window.raise_()
        self.main_window.activateWindow()

    def _toggle_hotkeys_from_tray(self):
        currently_enabled = self.settings_mgr.is_hotkeys_enabled()
        new_enabled = not currently_enabled
        self.settings_mgr.set_hotkeys_enabled(new_enabled)
        self.main_window._update_global_toggle_ui()
        self.sync_hotkeys()
        if self.settings_mgr.is_notifications_enabled():
            msg = "Хоткеи активны" if new_enabled else "Хоткеи отключены"
            color = "#10b981" if new_enabled else "#71717a"
            ToastNotification.notify(msg, color)

    def _quit_app(self):
        if hasattr(self, "clipboard_mgr"):
            self.clipboard_mgr.wait_for_idle(timeout=1.0)
        if hasattr(self, "shift_mgr") and self.shift_mgr.is_active:
            self.shift_mgr.stop_shift()
        self.hotkey_mgr.stop()
        if hasattr(self.tray_mgr, "tray_icon"):
            self.tray_mgr.tray_icon.hide()
        self.app.quit()


def main():
    # Set high DPI scaling
    QApplication.setHighDpiScaleFactorRoundingPolicy(
        Qt.HighDpiScaleFactorRoundingPolicy.PassThrough
    )

    app = QApplication(sys.argv)
    app.setQuitOnLastWindowClosed(False)  # Keep running in system tray
    app.setStyleSheet(DARK_THEME_QSS)

    server_name = "FunPayHotkeys_SingleInstance_Pipe"

    # Check if another instance is already running
    from PySide6.QtNetwork import QLocalSocket, QLocalServer
    socket = QLocalSocket()
    socket.connectToServer(server_name)
    if socket.waitForConnected(400):
        # Another instance is already running: wake it up and exit
        socket.write(b"ACTIVATE\n")
        socket.waitForBytesWritten(500)
        socket.disconnectFromServer()
        sys.exit(0)

    # We are the primary instance: create local server
    QLocalServer.removeServer(server_name)
    local_server = QLocalServer()
    local_server.listen(server_name)

    controller = AppController(app)
    controller._show_main_window()

    def on_new_instance_launched():
        client = local_server.nextPendingConnection()
        if client:
            client.waitForReadyRead(300)
            controller._show_main_window()
            client.disconnectFromServer()

    local_server.newConnection.connect(on_new_instance_launched)

    exit_code = app.exec()
    local_server.close()
    sys.exit(exit_code)


if __name__ == "__main__":
    main()
