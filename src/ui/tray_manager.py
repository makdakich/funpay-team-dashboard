"""System tray integration and tray context menu management."""

from PySide6.QtWidgets import QSystemTrayIcon, QMenu
from PySide6.QtGui import QIcon, QPixmap, QPainter, QColor, QFont
from PySide6.QtCore import Qt, Signal, QObject
from ..__version__ import __version__, __app_name__
from ..core.profile_manager import ProfileManager
from ..core.settings_manager import SettingsManager


def create_app_icon(is_active: bool = True) -> QIcon:
    """Dynamically generate a crisp modern tray/window icon."""
    pixmap = QPixmap(64, 64)
    pixmap.fill(Qt.transparent)

    painter = QPainter(pixmap)
    painter.setRenderHint(QPainter.Antialiasing)

    # Background rounded rect
    bg_color = QColor("#4f46e5") if is_active else QColor("#3f3f46")
    painter.setBrush(bg_color)
    painter.setPen(Qt.NoPen)
    painter.drawRoundedRect(4, 4, 56, 56, 16, 16)

    # Draw 'F' letter or symbol
    painter.setPen(QColor("#ffffff"))
    font = QFont("Segoe UI", 30, QFont.Bold)
    painter.setFont(font)
    painter.drawText(pixmap.rect(), Qt.AlignCenter, "F")

    # Status indicator badge on bottom right
    status_color = QColor("#22c55e") if is_active else QColor("#a1a1aa")
    painter.setBrush(status_color)
    painter.setPen(QColor("#18181b"))
    painter.drawEllipse(42, 42, 18, 18)

    painter.end()
    return QIcon(pixmap)


class TrayManager(QObject):
    show_main_window_requested = Signal()
    toggle_hotkeys_requested = Signal()
    profile_selected = Signal(int)  # profile_id
    open_settings_requested = Signal()
    quit_requested = Signal()

    def __init__(
        self,
        profile_mgr: ProfileManager,
        settings_mgr: SettingsManager,
        parent=None,
    ):
        super().__init__(parent)
        self.profile_mgr = profile_mgr
        self.settings_mgr = settings_mgr

        self.tray_icon = QSystemTrayIcon(parent)
        self.tray_icon.setIcon(create_app_icon(True))
        self.tray_icon.setToolTip(f"{__app_name__} v{__version__}")

        self.menu = QMenu()
        self.menu.setStyleSheet(
            """
            QMenu {
                background-color: #18181b;
                color: #f4f4f5;
                border: 1px solid #3f3f46;
                border-radius: 6px;
                padding: 4px;
            }
            QMenu::item {
                padding: 6px 24px;
                border-radius: 4px;
            }
            QMenu::item:selected {
                background-color: #4f46e5;
                color: #ffffff;
            }
            QMenu::separator {
                height: 1px;
                background: #27272a;
                margin: 4px 8px;
            }
            """
        )

        self.tray_icon.activated.connect(self._on_tray_activated)
        self.update_menu()
        self.tray_icon.show()

    def update_icon(self, is_active: bool):
        self.tray_icon.setIcon(create_app_icon(is_active))
        status_str = "Включены" if is_active else "Выключены"
        self.tray_icon.setToolTip(f"FunPay Hotkeys (Хоткеи: {status_str})")
        self.update_menu()

    def update_menu(self):
        self.menu.clear()

        # 1. Open
        open_action = self.menu.addAction("⚡ Открыть FunPay Hotkeys")
        open_action.triggered.connect(self.show_main_window_requested.emit)

        # 2. Toggle hotkeys
        enabled = self.settings_mgr.is_hotkeys_enabled()
        toggle_text = "🟢 Хоткеи: Включены" if enabled else "⚪ Хоткеи: Выключены"
        toggle_action = self.menu.addAction(toggle_text)
        toggle_action.triggered.connect(self.toggle_hotkeys_requested.emit)

        self.menu.addSeparator()

        # 3. Profiles submenu
        profile_menu = self.menu.addMenu("📁 Профиль")
        profile_menu.setStyleSheet(self.menu.styleSheet())
        active_p = self.profile_mgr.get_active_profile()
        profiles = self.profile_mgr.get_profiles()

        for p in profiles:
            is_cur = p.id == active_p.id
            title = f"✓ {p.name}" if is_cur else f"   {p.name}"
            act = profile_menu.addAction(title)
            act.triggered.connect(lambda chk=False, pid=p.id: self.profile_selected.emit(pid))

        self.menu.addSeparator()

        # 4. Settings
        settings_act = self.menu.addAction("⚙ Настройки")
        settings_act.triggered.connect(self.open_settings_requested.emit)

        self.menu.addSeparator()

        # 5. Quit
        quit_act = self.menu.addAction("❌ Выход")
        quit_act.triggered.connect(self.quit_requested.emit)

        self.tray_icon.setContextMenu(self.menu)

    def _on_tray_activated(self, reason):
        if reason in (QSystemTrayIcon.DoubleClick, QSystemTrayIcon.Trigger):
            self.show_main_window_requested.emit()
