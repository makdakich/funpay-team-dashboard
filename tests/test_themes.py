"""Tests for Theme Accents palette and QSS generation."""

import pytest
from src.ui.styles import THEMES, get_dark_theme_qss


def test_theme_palettes_completeness():
    required_keys = ["emerald", "violet", "cyan", "amber"]
    for k in required_keys:
        assert k in THEMES
        theme = THEMES[k]
        assert "primary" in theme
        assert "primary_hover" in theme
        assert "badge_bg" in theme
        assert "badge_fg" in theme


def test_get_dark_theme_qss_accents():
    for name, theme in THEMES.items():
        qss = get_dark_theme_qss(name)
        assert theme["primary"] in qss
        assert "QPushButton#PrimaryButton" in qss
        assert "QFrame#ShiftWidget" in qss
        assert "QLabel#ShiftTimerLabel" in qss


def test_fallback_to_emerald():
    qss = get_dark_theme_qss("non_existent_theme")
    assert THEMES["emerald"]["primary"] in qss
