"""Vector 7-day activity bar chart widget rendered cleanly with QPainter."""

from typing import List, Dict
from PySide6.QtWidgets import QWidget
from PySide6.QtCore import Qt, QRectF
from PySide6.QtGui import QPainter, QColor, QFont, QPen, QBrush


class ActivityChartWidget(QWidget):
    def __init__(self, parent=None):
        super().__init__(parent)
        self.setFixedHeight(120)
        self.setMinimumWidth(320)
        self._data: List[Dict] = []  # [{'date': '2026-09-25', 'messages': 12, 'duration': 3600}]
        self._accent_color = QColor("#10b981")

    def set_data(self, data: List[Dict], accent_hex: str = "#10b981"):
        self._data = data
        self._accent_color = QColor(accent_hex)
        self.update()

    def paintEvent(self, event):
        painter = QPainter(self)
        painter.setRenderHint(QPainter.Antialiasing)

        w = self.width()
        h = self.height()

        # Background card
        painter.setPen(QPen(QColor("#1B2436"), 1))
        painter.setBrush(QBrush(QColor("#0E131F")))
        painter.drawRoundedRect(0, 0, w, h, 8, 8)

        if not self._data:
            painter.setPen(QColor("#64748B"))
            painter.drawText(self.rect(), Qt.AlignCenter, "Нет данных об активности за последние 7 дней")
            return

        # Title
        painter.setPen(QColor("#94A3B8"))
        font = QFont("Segoe UI", 9)
        font.setBold(True)
        painter.setFont(font)
        painter.drawText(12, 18, "📊 Активность за 7 дней (сообщений)")

        # Dimensions for bars
        chart_top = 28
        chart_bottom = h - 22
        chart_height = chart_bottom - chart_top
        count = len(self._data)
        slot_w = (w - 24) / count
        bar_w = min(28, slot_w - 10)

        max_val = max([d.get("messages", 0) for d in self._data] + [1])

        label_font = QFont("Segoe UI", 8)
        val_font = QFont("Consolas", 8)
        val_font.setBold(True)

        for i, d in enumerate(self._data):
            msgs = d.get("messages", 0)
            date_str = d.get("date", "")
            # Short date label: DD.MM
            short_date = date_str[-5:].replace("-", ".") if len(date_str) >= 5 else date_str

            cx = 12 + i * slot_w + (slot_w / 2)
            bx = cx - (bar_w / 2)

            bar_ratio = msgs / max_val if max_val > 0 else 0
            bh = max(4, bar_ratio * (chart_height - 16))
            by = chart_bottom - bh

            # Draw bar
            is_today = (i == count - 1)
            bar_color = self._accent_color if is_today else QColor("#3f3f46")
            if not is_today and msgs > 0:
                bar_color = QColor(self._accent_color.red(), self._accent_color.green(), self._accent_color.blue(), 140)

            painter.setPen(Qt.NoPen)
            painter.setBrush(QBrush(bar_color))
            painter.drawRoundedRect(QRectF(bx, by, bar_w, bh), 4, 4)

            # Value text on top of bar
            painter.setFont(val_font)
            painter.setPen(QColor("#ffffff") if is_today else QColor("#a1a1aa"))
            val_rect = QRectF(cx - 20, by - 14, 40, 12)
            painter.drawText(val_rect, Qt.AlignCenter, str(msgs))

            # Date text under bar
            painter.setFont(label_font)
            painter.setPen(QColor("#71717a"))
            lbl_rect = QRectF(cx - 20, chart_bottom + 4, 40, 14)
            painter.drawText(lbl_rect, Qt.AlignCenter, short_date)
