"""Dialog for testing and previewing template message output."""

from PySide6.QtWidgets import (
    QDialog,
    QVBoxLayout,
    QHBoxLayout,
    QLabel,
    QTextEdit,
    QPushButton,
)
from PySide6.QtCore import Qt
from ...database.models import MODE_PASTE, MODE_PASTE_ENTER, MODE_COPY_ONLY


class TestPreviewDialog(QDialog):
    __test__ = False

    def __init__(self, title: str, evaluated_text: str, mode: str, parent=None):
        super().__init__(parent)
        self.setWindowTitle(f"Тест: {title}")
        self.setFixedSize(480, 360)
        self.setModal(True)

        self.evaluated_text = evaluated_text
        self.mode = mode
        self._init_ui(title)

    def _init_ui(self, title: str):
        layout = QVBoxLayout(self)
        layout.setContentsMargins(18, 18, 18, 18)
        layout.setSpacing(14)

        header = QLabel(f"Предпросмотр сообщения для «{title}»:")
        header.setStyleSheet("font-size: 14px; font-weight: bold; color: #f4f4f5;")
        layout.addWidget(header)

        # Mode info banner
        mode_desc = "Режим: Вставить в активное поле (без Enter)"
        if self.mode == MODE_PASTE_ENTER:
            mode_desc = "Режим: Вставить + автоматический Enter"
        elif self.mode == MODE_COPY_ONLY:
            mode_desc = "Режим: Только скопировать в буфер обмена"

        mode_lbl = QLabel(mode_desc)
        mode_lbl.setStyleSheet("color: #a5b4fc; font-size: 12px; font-weight: 500;")
        layout.addWidget(mode_lbl)

        # Text display
        self.text_preview = QTextEdit()
        self.text_preview.setReadOnly(True)
        self.text_preview.setPlainText(self.evaluated_text)
        self.text_preview.setStyleSheet(
            """
            QTextEdit {
                background-color: #18181b;
                color: #e4e4e7;
                border: 1px solid #3f3f46;
                border-radius: 8px;
                padding: 10px;
                font-size: 13px;
                line-height: 1.4;
            }
            """
        )
        layout.addWidget(self.text_preview)

        # Disclaimer
        hint = QLabel("ℹ️ Тест НЕ отправляет сообщение в активное окно и не нажимает Enter.")
        hint.setStyleSheet("color: #71717a; font-size: 11px;")
        layout.addWidget(hint)

        # Buttons
        btn_layout = QHBoxLayout()
        btn_layout.setSpacing(10)

        close_btn = QPushButton("Закрыть")
        close_btn.clicked.connect(self.accept)
        btn_layout.addWidget(close_btn)

        layout.addLayout(btn_layout)
