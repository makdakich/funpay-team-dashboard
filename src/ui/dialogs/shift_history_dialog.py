"""Dialog displaying work shift history, duration analytics, and sent message statistics."""

from PySide6.QtWidgets import (
    QDialog,
    QVBoxLayout,
    QHBoxLayout,
    QLabel,
    QPushButton,
    QTableWidget,
    QTableWidgetItem,
    QHeaderView,
    QFrame,
    QTabWidget,
    QWidget,
)
from PySide6.QtCore import Qt
from ...core.shift_manager import ShiftManager
from ..components.activity_chart import ActivityChartWidget


class ShiftHistoryDialog(QDialog):
    def __init__(self, shift_mgr: ShiftManager, parent=None):
        super().__init__(parent)
        self.shift_mgr = shift_mgr

        self.setWindowTitle("История рабочих смен и статистика")
        self.setFixedSize(680, 560)
        self.setModal(True)

        self._init_ui()
        self._load_data()

    def _init_ui(self):
        layout = QVBoxLayout(self)
        layout.setContentsMargins(18, 16, 18, 16)
        layout.setSpacing(12)

        # Header Title
        title = QLabel("Статистика работы продавца")
        title.setStyleSheet("font-size: 16px; font-weight: bold; color: #ffffff;")
        layout.addWidget(title)

        # Summary Cards (4 cards)
        summary_row = QHBoxLayout()
        summary_row.setSpacing(10)

        self.card_time = self._create_stat_card("Время сегодня", "0ч 0м", "#10b981")
        self.card_messages = self._create_stat_card("Ответов сегодня", "0", "#6366f1")
        self.card_speed = self._create_stat_card("Скорость", "0/час", "#f59e0b")
        self.card_shifts = self._create_stat_card("Смен сегодня", "0", "#06b6d4")

        summary_row.addWidget(self.card_time)
        summary_row.addWidget(self.card_messages)
        summary_row.addWidget(self.card_speed)
        summary_row.addWidget(self.card_shifts)
        layout.addLayout(summary_row)

        # Activity Chart (Last 7 days)
        chart_lbl = QLabel("Активность за последние 7 дней (сообщений):")
        chart_lbl.setStyleSheet("font-weight: 600; color: #a1a1aa; font-size: 12px; margin-top: 4px;")
        layout.addWidget(chart_lbl)

        self.chart = ActivityChartWidget(parent=self)
        self.chart.setFixedHeight(120)
        layout.addWidget(self.chart)

        # Table of past shifts
        table_lbl = QLabel("История смен:")
        table_lbl.setStyleSheet("font-weight: 600; color: #a1a1aa; font-size: 12px; margin-top: 4px;")
        layout.addWidget(table_lbl)

        self.table = QTableWidget()
        self.table.setColumnCount(5)
        self.table.setHorizontalHeaderLabels(["Дата и время", "Длительность", "Ответов", "Темп/час", "Профиль"])
        self.table.horizontalHeader().setSectionResizeMode(0, QHeaderView.Stretch)
        self.table.horizontalHeader().setSectionResizeMode(1, QHeaderView.ResizeToContents)
        self.table.horizontalHeader().setSectionResizeMode(2, QHeaderView.ResizeToContents)
        self.table.horizontalHeader().setSectionResizeMode(3, QHeaderView.ResizeToContents)
        self.table.horizontalHeader().setSectionResizeMode(4, QHeaderView.ResizeToContents)
        self.table.verticalHeader().setVisible(False)
        self.table.setSelectionBehavior(QTableWidget.SelectRows)
        self.table.setEditTriggers(QTableWidget.NoEditTriggers)
        self.table.setStyleSheet("""
            QTableWidget {
                background-color: #0E131F;
                border: 1px solid #1B2436;
                border-radius: 6px;
                gridline-color: #1B2436;
                color: #F8FAFC;
            }
            QHeaderView::section {
                background-color: #131B2E;
                color: #94A3B8;
                padding: 6px;
                border: none;
                border-bottom: 1px solid #1B2436;
                font-weight: 600;
            }
        """)
        layout.addWidget(self.table)

        # Bottom close button
        btn_row = QHBoxLayout()
        btn_row.addStretch()

        close_btn = QPushButton("Закрыть")
        close_btn.setFixedWidth(100)
        close_btn.clicked.connect(self.accept)
        btn_row.addWidget(close_btn)

        layout.addLayout(btn_row)

    def _create_stat_card(self, label_text: str, val_text: str, accent_color: str) -> QFrame:
        card = QFrame()
        card.setStyleSheet("""
            QFrame {
                background-color: #0E131F;
                border: 1px solid #1B2436;
                border-radius: 8px;
                padding: 8px;
            }
        """)
        card_layout = QVBoxLayout(card)
        card_layout.setContentsMargins(4, 4, 4, 4)
        card_layout.setSpacing(2)

        lbl = QLabel(label_text)
        lbl.setStyleSheet("font-size: 11px; color: #a1a1aa; font-weight: 500;")
        card_layout.addWidget(lbl)

        val = QLabel(val_text)
        val.setObjectName("CardValue")
        val.setStyleSheet(f"font-size: 17px; font-weight: bold; color: {accent_color};")
        card_layout.addWidget(val)

        return card

    def _load_data(self):
        stats = self.shift_mgr.get_today_stats()
        tot_sec = stats.get("total_duration", 0)
        h = tot_sec // 3600
        m = (tot_sec % 3600) // 60
        total_msgs = stats.get("total_messages", 0)

        self.card_time.findChild(QLabel, "CardValue").setText(f"{h}ч {m}м")
        self.card_messages.findChild(QLabel, "CardValue").setText(str(total_msgs))
        self.card_shifts.findChild(QLabel, "CardValue").setText(str(stats.get("shift_count", 0)))

        # Messages per hour
        if tot_sec >= 60:
            speed = round(total_msgs / (tot_sec / 3600.0), 1)
            self.card_speed.findChild(QLabel, "CardValue").setText(f"{speed}/ч")
        else:
            self.card_speed.findChild(QLabel, "CardValue").setText("—")

        # Load 7-day chart
        daily_activity = self.shift_mgr.db.get_daily_activity_last_7_days()
        self.chart.set_data(daily_activity)

        # Load shift history table
        shifts = self.shift_mgr.get_shift_history(limit=50)
        self.table.setRowCount(len(shifts))

        for row, s in enumerate(shifts):
            # Parse start time
            start_display = s.start_time.replace("T", " ")[:19]

            # Duration
            dh = s.duration_seconds // 3600
            dm = (s.duration_seconds % 3600) // 60
            ds = s.duration_seconds % 60
            dur_display = f"{dh:02d}:{dm:02d}:{ds:02d}"

            item_start = QTableWidgetItem(start_display)
            item_dur = QTableWidgetItem(dur_display)
            item_dur.setTextAlignment(Qt.AlignCenter)
            item_msg = QTableWidgetItem(str(s.messages_count))
            item_msg.setTextAlignment(Qt.AlignCenter)

            if s.duration_seconds >= 60:
                shift_speed = f"{round(s.messages_count / (s.duration_seconds / 3600.0), 1)}/ч"
            else:
                shift_speed = f"{s.messages_count}/ч"
            item_speed = QTableWidgetItem(shift_speed)
            item_speed.setTextAlignment(Qt.AlignCenter)

            item_prof = QTableWidgetItem(s.profile_name or "-")

            self.table.setItem(row, 0, item_start)
            self.table.setItem(row, 1, item_dur)
            self.table.setItem(row, 2, item_msg)
            self.table.setItem(row, 3, item_speed)
            self.table.setItem(row, 4, item_prof)
