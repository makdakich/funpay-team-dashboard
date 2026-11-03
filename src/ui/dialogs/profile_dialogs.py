"""Dialogs for profile creation, renaming, and deletion."""

from PySide6.QtWidgets import QDialog, QVBoxLayout, QHBoxLayout, QLabel, QLineEdit, QPushButton, QMessageBox


class NewProfileDialog(QDialog):
    def __init__(self, parent=None):
        super().__init__(parent)
        self.setWindowTitle("Новый профиль")
        self.setFixedSize(340, 160)
        self.profile_name = ""
        self._init_ui()

    def _init_ui(self):
        layout = QVBoxLayout(self)
        layout.setSpacing(12)

        label = QLabel("Введите название нового профиля:")
        label.setStyleSheet("color: #f4f4f5; font-weight: 500;")
        layout.addWidget(label)

        self.input_field = QLineEdit()
        self.input_field.setPlaceholderText("Например: 🎮 Genshin Impact")
        self.input_field.returnPressed.connect(self._submit)
        layout.addWidget(self.input_field)

        btn_layout = QHBoxLayout()
        self.cancel_btn = QPushButton("Отмена")
        self.cancel_btn.clicked.connect(self.reject)
        btn_layout.addWidget(self.cancel_btn)

        self.ok_btn = QPushButton("Создать")
        self.ok_btn.setObjectName("PrimaryButton")
        self.ok_btn.clicked.connect(self._submit)
        btn_layout.addWidget(self.ok_btn)

        layout.addLayout(btn_layout)

    def _submit(self):
        name = self.input_field.text().strip()
        if not name:
            QMessageBox.warning(self, "Ошибка", "Название профиля не может быть пустым.")
            return
        self.profile_name = name
        self.accept()


class RenameProfileDialog(QDialog):
    def __init__(self, current_name: str, parent=None):
        super().__init__(parent)
        self.setWindowTitle("Переименовать профиль")
        self.setFixedSize(340, 160)
        self.new_name = current_name
        self._init_ui(current_name)

    def _init_ui(self, current_name: str):
        layout = QVBoxLayout(self)
        layout.setSpacing(12)

        label = QLabel("Новое название профиля:")
        label.setStyleSheet("color: #f4f4f5; font-weight: 500;")
        layout.addWidget(label)

        self.input_field = QLineEdit(current_name)
        self.input_field.selectAll()
        self.input_field.returnPressed.connect(self._submit)
        layout.addWidget(self.input_field)

        btn_layout = QHBoxLayout()
        self.cancel_btn = QPushButton("Отмена")
        self.cancel_btn.clicked.connect(self.reject)
        btn_layout.addWidget(self.cancel_btn)

        self.ok_btn = QPushButton("Сохранить")
        self.ok_btn.setObjectName("PrimaryButton")
        self.ok_btn.clicked.connect(self._submit)
        btn_layout.addWidget(self.ok_btn)

        layout.addLayout(btn_layout)

    def _submit(self):
        name = self.input_field.text().strip()
        if not name:
            QMessageBox.warning(self, "Ошибка", "Название профиля не может быть пустым.")
            return
        self.new_name = name
        self.accept()
