"""Header widget for managing and displaying the active work shift timer."""

from PySide6.QtWidgets import (
    QFrame,
    QHBoxLayout,
    QVBoxLayout,
    QWidget,
    QLabel,
    QPushButton,
    QMessageBox,
)
from PySide6.QtCore import Qt, Signal
from ...core.shift_manager import ShiftManager
from ...ui.icons import get_vector_icon


class ShiftWidget(QFrame):
    open_history_requested = Signal()

    def __init__(self, shift_mgr: ShiftManager, get_active_profile_name, parent=None):
        super().__init__(parent)
        self.shift_mgr = shift_mgr
        self.get_active_profile_name = get_active_profile_name
        self.setObjectName("ShiftWidget")

        self._init_ui()
        self._connect_signals()
        self._update_display_state()

    def _init_ui(self):
        self.setFixedHeight(34)
        layout = QHBoxLayout(self)
        layout.setContentsMargins(4, 2, 4, 2)
        layout.setSpacing(6)

        # Info container (shown only when shift is active)
        self.info_container = QWidget()
        self.info_container.setVisible(False)
        info_h_layout = QHBoxLayout(self.info_container)
        info_h_layout.setContentsMargins(2, 0, 4, 0)
        info_h_layout.setSpacing(6)

        # Pulse indicator circle
        self.indicator = QLabel("●")
        self.indicator.setStyleSheet("font-size: 13px; color: #22c55e;")
        info_h_layout.addWidget(self.indicator)

        # Timer & Stats vertical block
        info_v_layout = QVBoxLayout()
        info_v_layout.setSpacing(0)
        info_v_layout.setAlignment(Qt.AlignVCenter)

        self.timer_label = QLabel("00:00:00")
        self.timer_label.setObjectName("ShiftTimerLabel")
        self.timer_label.setMinimumWidth(72)
        self.timer_label.setAlignment(Qt.AlignLeft | Qt.AlignVCenter)
        info_v_layout.addWidget(self.timer_label)

        self.stats_label = QLabel("💬 0")
        self.stats_label.setMinimumWidth(40)
        self.stats_label.setStyleSheet("font-size: 10px; color: #a1a1aa; font-weight: 600;")
        info_v_layout.addWidget(self.stats_label)

        info_h_layout.addLayout(info_v_layout)
        layout.addWidget(self.info_container)

        # Action Toggle Button
        self.toggle_btn = QPushButton("▶ Начать смену")
        self.toggle_btn.setObjectName("ShiftStartBtn")
        self.toggle_btn.setFixedHeight(28)
        self.toggle_btn.clicked.connect(self._on_toggle_clicked)
        layout.addWidget(self.toggle_btn)

        # History button
        self.history_btn = QPushButton()
        self.history_btn.setObjectName("ToolButton")
        self.history_btn.setIcon(get_vector_icon("chart", "#a1a1aa", 13))
        self.history_btn.setToolTip("История рабочих смен и статистика")
        self.history_btn.clicked.connect(self.open_history_requested.emit)
        layout.addWidget(self.history_btn)

    def _connect_signals(self):
        self.shift_mgr.shift_started.connect(self._on_shift_started)
        self.shift_mgr.shift_ticked.connect(self._on_shift_ticked)
        self.shift_mgr.shift_ended.connect(self._on_shift_ended)
        self.shift_mgr.message_recorded.connect(self._on_message_recorded)

    def _update_display_state(self):
        if self.shift_mgr.is_active:
            self.info_container.setVisible(True)
            self.timer_label.setText(self.shift_mgr.get_formatted_elapsed())
            self.stats_label.setText(f"💬 {self.shift_mgr.messages_count}")
            self.toggle_btn.setText("⏹ Стоп")
            self.toggle_btn.setToolTip("Завершить текущую смену")
            self.toggle_btn.setObjectName("ShiftStopBtn")
        else:
            self.info_container.setVisible(False)
            self.toggle_btn.setText("▶ Начать смену")
            self.toggle_btn.setToolTip("Начать рабочую смену")
            self.toggle_btn.setObjectName("ShiftStartBtn")

        self.toggle_btn.style().unpolish(self.toggle_btn)
        self.toggle_btn.style().polish(self.toggle_btn)
        self.adjustSize()

    def _on_toggle_clicked(self):
        if not self.shift_mgr.is_active:
            prof_name = self.get_active_profile_name()
            self.shift_mgr.start_shift(prof_name)
        else:
            confirm = QMessageBox.question(
                self,
                "Завершение смены",
                f"Завершить текущую смену?\n\nДлительность: {self.shift_mgr.get_formatted_elapsed()}\nОтветов отправлено: {self.shift_mgr.messages_count}",
                QMessageBox.Yes | QMessageBox.No,
                QMessageBox.Yes,
            )
            if confirm == QMessageBox.Yes:
                self.shift_mgr.stop_shift()

    def _on_shift_started(self, start_time_str: str):
        self._update_display_state()

    def _on_shift_ticked(self, seconds: int, formatted: str):
        self.timer_label.setText(formatted)

    def _on_message_recorded(self, count: int):
        self.stats_label.setText(f"💬 {count}")

    def _on_shift_ended(self, shift):
        self._update_display_state()
        if shift:
            h = shift.duration_seconds // 3600
            m = (shift.duration_seconds % 3600) // 60
            s = shift.duration_seconds % 60
            dur_str = f"{h:02d}:{m:02d}:{s:02d}"
            QMessageBox.information(
                self,
                "Смена успешно завершена!",
                f"🎉 Отличная работа!\n\n"
                f"⏱ Время на смене: {dur_str}\n"
                f"💬 Ответов отправлено: {shift.messages_count}\n"
                f"📂 Профиль: {shift.profile_name}\n\n"
                f"Данные сохранены в истории смен.",
            )
