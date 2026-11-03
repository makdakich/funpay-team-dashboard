"""Widget representing an individual hotkey card in the left panel list with clean compact styling."""

from PySide6.QtWidgets import QFrame, QHBoxLayout, QVBoxLayout, QLabel
from PySide6.QtCore import Qt
from ...database.models import HotkeyItem, MODE_PASTE_ENTER, MODE_COPY_ONLY


class HotkeyCardWidget(QFrame):
    def __init__(self, item: HotkeyItem, parent=None):
        super().__init__(parent)
        self.item_id = item.id
        self.item = item
        self.is_selected = False
        self._init_ui(item)
        self.update_style()

    def _init_ui(self, item: HotkeyItem):
        self.setFixedHeight(54)
        main_layout = QHBoxLayout(self)
        main_layout.setContentsMargins(10, 6, 10, 6)
        main_layout.setSpacing(10)

        # 1. Left: Key badge (e.g. "F4", "Ctrl+F1")
        self.badge = QLabel(item.shortcut)
        self.badge.setObjectName("ActiveShortcutBadge" if item.enabled else "InactiveShortcutBadge")
        self.badge.setAlignment(Qt.AlignCenter)
        self.badge.setFixedWidth(52)
        main_layout.addWidget(self.badge)

        # 2. Middle: Title + preview
        center_layout = QVBoxLayout()
        center_layout.setSpacing(2)
        center_layout.setContentsMargins(0, 0, 0, 0)

        # Top line: Title + Status + Mode badge
        top_line = QHBoxLayout()
        top_line.setSpacing(6)
        top_line.setContentsMargins(0, 0, 0, 0)

        self.title_label = QLabel(item.title)
        self.title_label.setStyleSheet("font-weight: 600; color: #f4f4f5; font-size: 13px;")
        top_line.addWidget(self.title_label, stretch=1)

        # Mode label (if not default paste)
        self.mode_label = QLabel()
        self.mode_label.setStyleSheet("font-size: 10px; font-weight: bold; border-radius: 3px; padding: 1px 4px;")
        top_line.addWidget(self.mode_label)

        # Status dot (using clean unicode bullet ● / ○)
        self.status_label = QLabel()
        self.status_label.setStyleSheet("font-size: 11px; font-weight: bold;")
        top_line.addWidget(self.status_label)

        center_layout.addLayout(top_line)

        # Bottom line: Message preview
        self.preview_label = QLabel()
        self.preview_label.setStyleSheet("color: #71717a; font-size: 11px;")
        center_layout.addWidget(self.preview_label)

        main_layout.addLayout(center_layout, stretch=1)

        self._refresh_content(item)

    def _refresh_content(self, item: HotkeyItem):
        self.item = item
        self.badge.setText(item.shortcut)
        self.badge.setObjectName("ActiveShortcutBadge" if item.enabled else "InactiveShortcutBadge")
        self.badge.style().unpolish(self.badge)
        self.badge.style().polish(self.badge)

        self.title_label.setText(item.title)

        # Message preview snippet
        preview = item.message.strip().replace("\n", " ")
        if len(preview) > 30:
            preview = preview[:28] + "..."
        if not preview:
            preview = "<текст сообщения пуст>"
        self.preview_label.setText(preview)

        # Mode tag
        if item.mode == MODE_PASTE_ENTER:
            self.mode_label.setText("+Enter")
            self.mode_label.setStyleSheet("background-color: #451a03; color: #fbbf24; border: 1px solid #78350f; font-size: 10px; font-weight: bold; border-radius: 3px; padding: 1px 4px;")
            self.mode_label.setVisible(True)
        elif item.mode == MODE_COPY_ONLY:
            self.mode_label.setText("Копия")
            self.mode_label.setStyleSheet("background-color: #2e1065; color: #c084fc; border: 1px solid #581c87; font-size: 10px; font-weight: bold; border-radius: 3px; padding: 1px 4px;")
            self.mode_label.setVisible(True)
        else:
            self.mode_label.setVisible(False)

        # Status
        if item.enabled:
            self.status_label.setText("●")
            self.status_label.setStyleSheet("color: #22c55e; font-size: 13px;")
            self.status_label.setToolTip("Хоткей активен")
        else:
            self.status_label.setText("○")
            self.status_label.setStyleSheet("color: #71717a; font-size: 13px;")
            self.status_label.setToolTip("Хоткей отключен")

    def update_data(self, item: HotkeyItem):
        self._refresh_content(item)

    def set_selected(self, selected: bool):
        self.is_selected = selected
        self.update_style()

    def update_style(self):
        if self.is_selected:
            self.setStyleSheet(
                """
                HotkeyCardWidget {
                    background-color: #24242c;
                    border: 1px solid #6366f1;
                    border-left: 3px solid #818cf8;
                    border-radius: 6px;
                }
                """
            )
        else:
            self.setStyleSheet(
                """
                HotkeyCardWidget {
                    background-color: #18181b;
                    border: 1px solid #27272a;
                    border-radius: 6px;
                }
                HotkeyCardWidget:hover {
                    background-color: #202024;
                    border-color: #3f3f46;
                }
                """
            )
