"""Non-intrusive floating Toast notifications that never steal window focus."""

from PySide6.QtWidgets import QWidget, QLabel, QHBoxLayout, QGraphicsOpacityEffect
from PySide6.QtCore import Qt, QTimer, QPropertyAnimation, QEasingCurve, QPoint
from PySide6.QtGui import QGuiApplication


class ToastNotification(QWidget):
    """
    Floating overlay notification widget.
    Uses Qt.ToolTip and Qt.WA_ShowWithoutActivating to prevent focus theft.
    """
    _instance = None

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setWindowFlags(
            Qt.ToolTip
            | Qt.FramelessWindowHint
            | Qt.WindowStaysOnTopHint
            | Qt.WindowDoesNotAcceptFocus
        )
        self.setAttribute(Qt.WA_ShowWithoutActivating, True)
        self.setAttribute(Qt.WA_TranslucentBackground, True)

        self._opacity_effect = QGraphicsOpacityEffect(self)
        self.setGraphicsEffect(self._opacity_effect)

        self._fade_anim = QPropertyAnimation(self._opacity_effect, b"opacity")
        self._fade_anim.setDuration(220)
        self._fade_anim.setEasingCurve(QEasingCurve.InOutQuad)

        self._dismiss_timer = QTimer(self)
        self._dismiss_timer.setSingleShot(True)
        self._dismiss_timer.timeout.connect(self._fade_out)

        self._init_ui()

    def _init_ui(self):
        layout = QHBoxLayout(self)
        layout.setContentsMargins(14, 8, 14, 8)
        layout.setSpacing(8)

        self.icon_label = QLabel()
        self.icon_label.setStyleSheet("font-size: 14px;")
        layout.addWidget(self.icon_label)

        self.text_label = QLabel()
        self.text_label.setStyleSheet("color: #f4f4f5; font-size: 12px; font-weight: 600;")
        layout.addWidget(self.text_label)

        self.setStyleSheet(
            """
            QWidget {
                background-color: #18181b;
                border: 1px solid #3f3f46;
                border-radius: 8px;
            }
            """
        )

    def show_message(self, message: str, icon: str = "ℹ️", duration_ms: int = 1800, border_color: str = "#6366f1"):
        self.text_label.setText(message)
        self.icon_label.setText(icon)
        self.setStyleSheet(
            f"""
            QWidget {{
                background-color: #18181b;
                border: 1px solid {border_color};
                border-radius: 8px;
            }}
            """
        )
        self.adjustSize()

        # Position at top center of primary screen
        screen = QGuiApplication.primaryScreen()
        if screen:
            geom = screen.availableGeometry()
            x = geom.x() + (geom.width() - self.width()) // 2
            y = geom.y() + 45
            self.move(QPoint(x, y))

        self.show()
        self._fade_anim.stop()
        self._fade_anim.setStartValue(self._opacity_effect.opacity())
        self._fade_anim.setEndValue(1.0)
        self._fade_anim.start()

        self._dismiss_timer.start(duration_ms)

    def _fade_out(self):
        self._fade_anim.stop()
        self._fade_anim.setStartValue(self._opacity_effect.opacity())
        self._fade_anim.setEndValue(0.0)
        self._fade_anim.finished.connect(self.hide)
        self._fade_anim.start()

    @classmethod
    def notify(cls, message: str, icon: str = "ℹ️", duration_ms: int = 1800, border_color: str = "#6366f1"):
        """Convenience singleton show method."""
        if cls._instance is None:
            cls._instance = ToastNotification()
        cls._instance.show_message(message, icon=icon, duration_ms=duration_ms, border_color=border_color)
