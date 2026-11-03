"""Dialog for entering variable values with type validation and clickable preset chips."""

from typing import List, Dict, Union
from PySide6.QtWidgets import (
    QDialog,
    QVBoxLayout,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QPushButton,
    QScrollArea,
    QWidget,
)
from PySide6.QtCore import Qt
from ...core.variable_manager import VariableManager, VariableDefinition


class VariableInputDialog(QDialog):
    def __init__(
        self,
        variables: List[Union[VariableDefinition, str]],
        var_manager: VariableManager,
        parent=None,
    ):
        super().__init__(parent)
        self.setWindowTitle("Данные сообщения")
        self.setMinimumWidth(400)
        self.setWindowFlags(self.windowFlags() | Qt.WindowStaysOnTopHint)

        # Normalize variables to VariableDefinition
        self.definitions: List[VariableDefinition] = []
        for v in variables:
            if isinstance(v, VariableDefinition):
                self.definitions.append(v)
            else:
                self.definitions.append(VariableDefinition(name=str(v), var_type="text", raw_tag=f"{{{v}}}"))

        self.var_manager = var_manager
        self.inputs: Dict[str, QLineEdit] = {}
        self.error_labels: Dict[str, QLabel] = {}
        self.values: Dict[str, str] = {}

        self._init_ui()

    def _init_ui(self):
        main_layout = QVBoxLayout(self)
        main_layout.setContentsMargins(18, 16, 18, 16)
        main_layout.setSpacing(14)

        header_label = QLabel("Заполните переменные для шаблона:")
        header_label.setStyleSheet("font-size: 14px; font-weight: bold; color: #f4f4f5;")
        main_layout.addWidget(header_label)

        # Scroll area for variables
        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        scroll.setStyleSheet("QScrollArea { border: none; background: transparent; }")

        container = QWidget()
        container_layout = QVBoxLayout(container)
        container_layout.setContentsMargins(0, 0, 0, 0)
        container_layout.setSpacing(12)

        first_input = None
        for v_def in self.definitions:
            var_name = v_def.name
            var_type = v_def.var_type

            var_box = QVBoxLayout()
            var_box.setSpacing(4)

            # Label row with type tag
            lbl_row = QHBoxLayout()
            lbl = QLabel(f"{var_name.capitalize()}:")
            lbl.setStyleSheet("font-weight: 600; color: #f4f4f5; font-size: 13px;")
            lbl_row.addWidget(lbl)

            if var_type != "text":
                type_tag = QLabel(var_type)
                type_tag.setStyleSheet(
                    "color: #a5b4fc; background-color: #312e81; font-size: 10px; "
                    "font-weight: bold; border-radius: 3px; padding: 1px 5px;"
                )
                lbl_row.addWidget(type_tag)
            lbl_row.addStretch()
            var_box.addLayout(lbl_row)

            # Text input
            line_edit = QLineEdit()
            if var_type == "number":
                line_edit.setPlaceholderText(f"Только цифры для {{{var_name}}}")
            elif var_type == "price":
                line_edit.setPlaceholderText(f"Сумма, например 100 или 150.50")
            else:
                line_edit.setPlaceholderText(f"Значение для {{{var_name}}}")

            self.inputs[var_name] = line_edit
            line_edit.textChanged.connect(self._validate_inputs)
            var_box.addWidget(line_edit)

            # Error hint label
            err_lbl = QLabel()
            err_lbl.setStyleSheet("color: #f87171; font-size: 11px;")
            err_lbl.setVisible(False)
            self.error_labels[var_name] = err_lbl
            var_box.addWidget(err_lbl)

            if first_input is None:
                first_input = line_edit

            # Quick values clickable chip buttons
            quick_vals = self.var_manager.get_quick_values(var_name, limit=6)
            if quick_vals:
                chips_layout = QHBoxLayout()
                chips_layout.setSpacing(6)
                chips_layout.setAlignment(Qt.AlignLeft)

                for qv in quick_vals:
                    chip_btn = QPushButton(qv)
                    chip_btn.setCursor(Qt.PointingHandCursor)
                    chip_btn.setStyleSheet(
                        """
                        QPushButton {
                            background-color: #27272a;
                            color: #d4d4d8;
                            border: 1px solid #3f3f46;
                            border-radius: 4px;
                            padding: 2px 8px;
                            font-size: 11px;
                            font-weight: 500;
                        }
                        QPushButton:hover {
                            background-color: #3f3f46;
                            color: #ffffff;
                            border-color: #6366f1;
                        }
                        """
                    )
                    chip_btn.clicked.connect(lambda checked=False, le=line_edit, val=qv: le.setText(val))
                    chips_layout.addWidget(chip_btn)

                var_box.addLayout(chips_layout)

            container_layout.addLayout(var_box)

        scroll.setWidget(container)
        main_layout.addWidget(scroll)

        # Action buttons
        btn_layout = QHBoxLayout()
        btn_layout.setSpacing(10)

        cancel_btn = QPushButton("Отмена")
        cancel_btn.clicked.connect(self.reject)
        btn_layout.addWidget(cancel_btn)

        self.submit_btn = QPushButton("Вставить")
        self.submit_btn.setObjectName("PrimaryButton")
        self.submit_btn.setDefault(True)
        self.submit_btn.clicked.connect(self._submit)
        btn_layout.addWidget(self.submit_btn)

        main_layout.addLayout(btn_layout)

        if first_input:
            first_input.setFocus()

        self._validate_inputs()

    def _validate_inputs(self):
        all_valid = True
        for v_def in self.definitions:
            var_name = v_def.name
            var_type = v_def.var_type
            le = self.inputs.get(var_name)
            err_lbl = self.error_labels.get(var_name)
            if not le or not err_lbl:
                continue

            text_val = le.text().strip()
            is_valid, msg = self.var_manager.validate_value(var_type, text_val)

            if not is_valid and text_val:
                err_lbl.setText(msg)
                err_lbl.setVisible(True)
                le.setStyleSheet("border-color: #ef4444;")
                all_valid = False
            else:
                err_lbl.setVisible(False)
                le.setStyleSheet("")

        self.submit_btn.setEnabled(all_valid)

    def _submit(self):
        for v_def in self.definitions:
            var_name = v_def.name
            le = self.inputs.get(var_name)
            self.values[var_name] = le.text().strip() if le else ""

        self.var_manager.record_used_values(self.values)
        self.accept()
