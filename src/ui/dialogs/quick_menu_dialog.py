"""Spotlight-style Quick Menu dialog with profile switcher, shift toggle, and full search."""

from typing import List, Optional
from PySide6.QtWidgets import (
    QDialog,
    QVBoxLayout,
    QLineEdit,
    QListWidget,
    QListWidgetItem,
    QLabel,
    QHBoxLayout,
    QWidget,
    QPushButton,
    QComboBox,
)
from PySide6.QtCore import Qt, Signal
from ...database.models import HotkeyItem, Profile
from ...utils.win32_utils import set_foreground_window


class QuickMenuItemWidget(QWidget):
    def __init__(self, item: HotkeyItem, parent=None):
        super().__init__(parent)
        layout = QHBoxLayout(self)
        layout.setContentsMargins(10, 6, 10, 6)
        layout.setSpacing(10)

        # Title & preview column
        text_col = QVBoxLayout()
        text_col.setSpacing(2)

        title_lbl = QLabel(item.title)
        title_lbl.setStyleSheet("font-weight: 600; font-size: 13px; color: #f4f4f5;")
        text_col.addWidget(title_lbl)

        preview_text = item.message.strip().replace("\n", " ")
        if len(preview_text) > 55:
            preview_text = preview_text[:55] + "..."
        preview_lbl = QLabel(preview_text)
        preview_lbl.setStyleSheet("font-size: 11px; color: #71717a;")
        text_col.addWidget(preview_lbl)

        layout.addLayout(text_col, stretch=1)

        # Shortcut badge
        if item.shortcut:
            badge = QLabel(item.shortcut)
            badge.setObjectName("ActiveShortcutBadge")
            badge.setAlignment(Qt.AlignCenter)
            layout.addWidget(badge)


class QuickMenuDialog(QDialog):
    template_selected = Signal(int, int)        # (hotkey_id, target_hwnd)
    profile_switch_requested = Signal(int)     # (profile_id)
    toggle_shift_requested = Signal()          # toggle shift from quick menu

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setWindowTitle("FunPay Quick Menu")
        self.setFixedWidth(480)
        self.setFixedHeight(380)

        # Frameless, stays on top, tool window
        self.setWindowFlags(Qt.FramelessWindowHint | Qt.WindowStaysOnTopHint | Qt.Tool)
        self.setAttribute(Qt.WA_TranslucentBackground, False)

        self.target_hwnd: int = 0
        self.all_items: List[HotkeyItem] = []
        self.profiles: List[Profile] = []
        self._is_loading = False

        self._init_ui()

    def _init_ui(self):
        main_layout = QVBoxLayout(self)
        main_layout.setContentsMargins(14, 12, 14, 12)
        main_layout.setSpacing(8)

        # Header bar: Profile selector & Shift status
        header_bar = QHBoxLayout()
        header_bar.setSpacing(8)

        self.profile_combo = QComboBox()
        self.profile_combo.setFixedHeight(28)
        self.profile_combo.currentIndexChanged.connect(self._on_profile_changed)
        header_bar.addWidget(self.profile_combo, stretch=1)

        self.shift_btn = QPushButton("▶ Смена")
        self.shift_btn.setFixedHeight(28)
        self.shift_btn.setStyleSheet(
            """
            QPushButton {
                background-color: #27272a;
                color: #e4e4e7;
                border: 1px solid #3f3f46;
                border-radius: 6px;
                padding: 2px 10px;
                font-size: 11px;
                font-weight: 600;
            }
            QPushButton:hover {
                background-color: #3f3f46;
                border-color: #10b981;
            }
            """
        )
        self.shift_btn.clicked.connect(self._on_shift_clicked)
        header_bar.addWidget(self.shift_btn)

        main_layout.addLayout(header_bar)

        # Search bar
        self.search_input = QLineEdit()
        self.search_input.setPlaceholderText("🔍 Поиск шаблона по названию, тексту или {переменным}...")
        self.search_input.setStyleSheet(
            """
            QLineEdit {
                background-color: #27272a;
                color: #ffffff;
                border: 1px solid #4f46e5;
                border-radius: 8px;
                padding: 8px 12px;
                font-size: 13px;
            }
            """
        )
        self.search_input.textChanged.connect(self._filter_items)
        main_layout.addWidget(self.search_input)

        # List of results
        self.list_widget = QListWidget()
        self.list_widget.setStyleSheet(
            """
            QListWidget {
                background-color: #18181b;
                border: 1px solid #27272a;
                border-radius: 8px;
            }
            QListWidget::item:selected {
                background-color: #312e81;
                border-radius: 6px;
            }
            """
        )
        self.list_widget.itemActivated.connect(self._on_item_activated)
        main_layout.addWidget(self.list_widget)

        # Bottom hint
        hint = QLabel("Enter — вставить • ↑↓ — навигация • Esc — закрыть")
        hint.setStyleSheet("color: #71717a; font-size: 11px;")
        hint.setAlignment(Qt.AlignCenter)
        main_layout.addWidget(hint)

    def show_menu(
        self,
        items: List[HotkeyItem],
        target_hwnd: int,
        profiles: Optional[List[Profile]] = None,
        active_profile_id: Optional[int] = None,
        shift_active: bool = False,
        shift_text: str = "",
    ):
        """Populate items and show centered on active screen."""
        self.target_hwnd = target_hwnd
        self.all_items = items
        self.profiles = profiles or []

        self._is_loading = True
        self.profile_combo.clear()
        for p in self.profiles:
            self.profile_combo.addItem(p.name, p.id)
            if active_profile_id and p.id == active_profile_id:
                self.profile_combo.setCurrentIndex(self.profile_combo.count() - 1)
        self._is_loading = False

        if shift_active:
            self.shift_btn.setText(f"⏹ {shift_text or 'Стоп'}")
            self.shift_btn.setStyleSheet(
                "QPushButton { background-color: #881337; color: #fecdd3; border: 1px solid #e11d48; border-radius: 6px; padding: 2px 10px; font-size: 11px; font-weight: 600; }"
            )
        else:
            self.shift_btn.setText("▶ Начать смену")
            self.shift_btn.setStyleSheet(
                "QPushButton { background-color: #27272a; color: #e4e4e7; border: 1px solid #3f3f46; border-radius: 6px; padding: 2px 10px; font-size: 11px; font-weight: 600; }"
            )

        self.search_input.clear()
        self._populate_list(self.all_items)

        # Center on screen
        screen_geom = self.screen().geometry()
        x = (screen_geom.width() - self.width()) // 2
        y = (screen_geom.height() - self.height()) // 3
        self.move(x, y)

        self.show()
        self.raise_()
        self.activateWindow()
        self.search_input.setFocus()

    def _populate_list(self, items: List[HotkeyItem]):
        self.list_widget.clear()
        for item in items:
            list_item = QListWidgetItem(self.list_widget)
            list_item.setData(Qt.UserRole, item.id)

            card = QuickMenuItemWidget(item)
            list_item.setSizeHint(card.sizeHint())
            self.list_widget.setItemWidget(list_item, card)

        if self.list_widget.count() > 0:
            self.list_widget.setCurrentRow(0)

    def _filter_items(self, text: str):
        query = text.strip().lower()
        if not query:
            filtered = self.all_items
        else:
            filtered = [
                h
                for h in self.all_items
                if query in h.title.lower()
                or query in h.shortcut.lower()
                or query in h.message.lower()
            ]
        self._populate_list(filtered)

    def _on_profile_changed(self, index: int):
        if self._is_loading or index < 0:
            return
        p_id = self.profile_combo.itemData(index)
        if p_id:
            self.profile_switch_requested.emit(p_id)

    def _on_shift_clicked(self):
        self.toggle_shift_requested.emit()
        self.hide()
        if self.target_hwnd:
            set_foreground_window(self.target_hwnd)

    def keyPressEvent(self, event):
        key = event.key()
        if key == Qt.Key_Escape:
            self.hide()
            if self.target_hwnd:
                set_foreground_window(self.target_hwnd)
            event.accept()
            return
        elif key == Qt.Key_Down:
            curr = self.list_widget.currentRow()
            if curr < self.list_widget.count() - 1:
                self.list_widget.setCurrentRow(curr + 1)
            event.accept()
            return
        elif key == Qt.Key_Up:
            curr = self.list_widget.currentRow()
            if curr > 0:
                self.list_widget.setCurrentRow(curr - 1)
            event.accept()
            return
        elif key in (Qt.Key_Return, Qt.Key_Enter):
            curr_item = self.list_widget.currentItem()
            if curr_item:
                self._on_item_activated(curr_item)
            event.accept()
            return
        super().keyPressEvent(event)

    def _on_item_activated(self, item: QListWidgetItem):
        hotkey_id = item.data(Qt.UserRole)
        self.hide()
        if self.target_hwnd:
            set_foreground_window(self.target_hwnd)
        self.template_selected.emit(hotkey_id, self.target_hwnd)
