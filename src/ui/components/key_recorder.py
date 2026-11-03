"""Dialog for recording a key combination from keyboard press."""

from PySide6.QtWidgets import QDialog, QVBoxLayout, QLabel, QHBoxLayout, QPushButton, QMessageBox
from PySide6.QtCore import Qt
from PySide6.QtGui import QKeyEvent, QKeySequence
from ...utils.win32_utils import normalize_shortcut
from ...core.template_manager import RESERVED_SHORTCUTS


class KeyRecorderDialog(QDialog):
    def __init__(self, current_shortcut: str = "", parent=None):
        super().__init__(parent)
        self.setWindowTitle("Назначение комбинации клавиш")
        self.setFixedSize(380, 220)
        self.setModal(True)

        self.recorded_shortcut = current_shortcut
        self._init_ui()

    def _init_ui(self):
        layout = QVBoxLayout(self)
        layout.setContentsMargins(20, 20, 20, 20)
        layout.setSpacing(15)

        title = QLabel("Нажмите нужную комбинацию клавиш...")
        title.setStyleSheet("font-size: 14px; font-weight: bold; color: #f4f4f5;")
        title.setAlignment(Qt.AlignCenter)
        layout.addWidget(title)

        hint = QLabel("Поддерживаются F1–F12, Ctrl+F1–F12, Alt+1, Shift+F2 и др.")
        hint.setStyleSheet("color: #71717a; font-size: 11px;")
        hint.setAlignment(Qt.AlignCenter)
        layout.addWidget(hint)

        # Big Badge showing currently detected shortcut
        self.display_badge = QLabel(self.recorded_shortcut or "Ожидание нажатия...")
        self.display_badge.setStyleSheet(
            """
            background-color: #18181b;
            color: #6366f1;
            border: 2px dashed #4f46e5;
            border-radius: 8px;
            font-size: 18px;
            font-weight: bold;
            padding: 15px;
            """
        )
        self.display_badge.setAlignment(Qt.AlignCenter)
        layout.addWidget(self.display_badge)

        # Buttons
        btn_layout = QHBoxLayout()
        btn_layout.setSpacing(10)

        self.cancel_btn = QPushButton("Отмена")
        self.cancel_btn.clicked.connect(self.reject)
        btn_layout.addWidget(self.cancel_btn)

        self.apply_btn = QPushButton("Применить")
        self.apply_btn.setObjectName("PrimaryButton")
        self.apply_btn.clicked.connect(self._validate_and_accept)
        btn_layout.addWidget(self.apply_btn)

        layout.addLayout(btn_layout)

    def keyPressEvent(self, event: QKeyEvent):
        key = event.key()

        # Ignore standalone modifier presses
        if key in (Qt.Key_Control, Qt.Key_Shift, Qt.Key_Alt, Qt.Key_Meta):
            super().keyPressEvent(event)
            return

        modifiers = event.modifiers()
        parts = []

        if modifiers & Qt.ControlModifier:
            parts.append("Ctrl")
        if modifiers & Qt.AltModifier:
            parts.append("Alt")
        if modifiers & Qt.ShiftModifier:
            parts.append("Shift")
        if modifiers & Qt.MetaModifier:
            parts.append("Win")

        # Key conversion
        key_str = ""
        if Qt.Key_F1 <= key <= Qt.Key_F24:
            f_num = key - Qt.Key_F1 + 1
            key_str = f"F{f_num}"
        elif Qt.Key_0 <= key <= Qt.Key_9:
            key_str = chr(key)
        elif Qt.Key_A <= key <= Qt.Key_Z:
            key_str = chr(key)
        elif key == Qt.Key_Space:
            key_str = "Space"
        elif key == Qt.Key_Return or key == Qt.Key_Enter:
            key_str = "Enter"
        elif key == Qt.Key_Tab:
            key_str = "Tab"
        elif key == Qt.Key_Escape:
            # If Esc pressed without modifiers, cancel dialog
            if not parts:
                self.reject()
                return
            key_str = "Esc"
        else:
            # Try QKeySequence
            seq_text = QKeySequence(key).toString()
            if seq_text:
                key_str = seq_text

        if key_str:
            parts.append(key_str)
            combo = "+".join(parts)
            self.recorded_shortcut = normalize_shortcut(combo)
            self.display_badge.setText(self.recorded_shortcut)
            self.display_badge.setStyleSheet(
                """
                background-color: #1e1b4b;
                color: #a5b4fc;
                border: 2px solid #6366f1;
                border-radius: 8px;
                font-size: 18px;
                font-weight: bold;
                padding: 15px;
                """
            )

        event.accept()

    def _validate_and_accept(self):
        if not self.recorded_shortcut:
            QMessageBox.warning(self, "Ошибка", "Пожалуйста, нажмите комбинацию клавиш.")
            return

        if self.recorded_shortcut in RESERVED_SHORTCUTS:
            QMessageBox.warning(
                self,
                "Комбинация зарезервирована",
                f"Комбинация '{self.recorded_shortcut}' зарезервирована для Быстрого меню (Quick Menu).",
            )
            return

        self.accept()
