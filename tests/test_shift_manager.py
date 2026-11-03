"""Tests for ShiftManager and SQLite shift persistence."""

import os
import pytest
from src.database.db import Database
from src.database.models import Shift
from src.core.shift_manager import ShiftManager


@pytest.fixture
def shift_env(tmp_path):
    db_path = str(tmp_path / "shift_test.db")
    db = Database(db_path)
    sm = ShiftManager(db)
    return db, sm


def test_shift_initial_state(shift_env):
    db, sm = shift_env
    assert not sm.is_active
    assert sm.get_elapsed_seconds() == 0
    assert sm.get_formatted_elapsed() == "00:00:00"
    assert sm.messages_count == 0


def test_shift_start_and_message_recording(shift_env):
    db, sm = shift_env
    sm.start_shift("🎮 Robux")
    assert sm.is_active
    assert sm.current_profile_name == "🎮 Robux"

    sm.record_message()
    sm.record_message()
    sm.record_message()
    assert sm.messages_count == 3


def test_shift_stop_and_persistence(shift_env):
    db, sm = shift_env
    sm.start_shift("⛏ Minecraft")
    sm.record_message()
    sm.record_message()

    completed_shift = sm.stop_shift()
    assert completed_shift is not None
    assert not sm.is_active
    assert completed_shift.id is not None
    assert completed_shift.messages_count == 2
    assert completed_shift.profile_name == "⛏ Minecraft"

    # Verify loaded from DB
    history = sm.get_shift_history()
    assert len(history) == 1
    assert history[0].messages_count == 2
    assert history[0].profile_name == "⛏ Minecraft"

    # Verify today stats
    today_stats = sm.get_today_stats()
    assert today_stats["shift_count"] == 1
    assert today_stats["total_messages"] == 2
