"""Work Shift Manager: Tracking shift duration, active timer, and sent message counts."""

import datetime
from typing import Optional, List
from PySide6.QtCore import QObject, Signal, QTimer
from ..database.db import Database
from ..database.models import Shift


class ShiftManager(QObject):
    shift_started = Signal(str)            # Emits start time formatted string
    shift_ticked = Signal(int, str)        # Emits (elapsed_seconds, "HH:MM:SS")
    shift_ended = Signal(object)           # Emits completed Shift object
    message_recorded = Signal(int)         # Emits current message count during shift

    def __init__(self, db: Database, parent: Optional[QObject] = None):
        super().__init__(parent)
        self.db = db
        self.is_active: bool = False
        self.start_time: Optional[datetime.datetime] = None
        self.messages_count: int = 0
        self.current_profile_name: str = ""

        self._timer = QTimer(self)
        self._timer.setInterval(1000)
        self._timer.timeout.connect(self._on_tick)

    def start_shift(self, profile_name: str = "") -> None:
        """Start a new work shift."""
        if self.is_active:
            return

        self.is_active = True
        self.start_time = datetime.datetime.now()
        self.messages_count = 0
        self.current_profile_name = profile_name or "Общий"

        self._timer.start()
        start_str = self.start_time.strftime("%H:%M:%S")
        self.shift_started.emit(start_str)
        self.shift_ticked.emit(0, "00:00:00")
        self.message_recorded.emit(0)

    def stop_shift(self) -> Optional[Shift]:
        """Stop current work shift, persist it to SQLite, and emit summary."""
        if not self.is_active or not self.start_time:
            return None

        self._timer.stop()
        now = datetime.datetime.now()
        duration_sec = max(0, int((now - self.start_time).total_seconds()))

        shift = Shift(
            start_time=self.start_time.isoformat(),
            end_time=now.isoformat(),
            duration_seconds=duration_sec,
            messages_count=self.messages_count,
            profile_name=self.current_profile_name,
        )

        try:
            shift_id = self.db.add_shift(shift)
            shift.id = shift_id
        except Exception:
            pass

        self.is_active = False
        self.start_time = None
        self.shift_ended.emit(shift)
        return shift

    def record_message(self) -> None:
        """Increment count of messages/hotkeys sent during the active shift."""
        if self.is_active:
            self.messages_count += 1
            self.message_recorded.emit(self.messages_count)

    def get_elapsed_seconds(self) -> int:
        if not self.is_active or not self.start_time:
            return 0
        return max(0, int((datetime.datetime.now() - self.start_time).total_seconds()))

    def get_formatted_elapsed(self) -> str:
        secs = self.get_elapsed_seconds()
        h = secs // 3600
        m = (secs % 3600) // 60
        s = secs % 60
        return f"{h:02d}:{m:02d}:{s:02d}"

    def _on_tick(self) -> None:
        if self.is_active and self.start_time:
            secs = self.get_elapsed_seconds()
            formatted = self.get_formatted_elapsed()
            self.shift_ticked.emit(secs, formatted)

    def get_today_stats(self) -> dict:
        return self.db.get_today_shift_stats()

    def get_shift_history(self, limit: int = 50) -> List[Shift]:
        return self.db.get_shifts(limit)
