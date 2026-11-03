import os
import sys

# Base directory for UI assets (supports both source dev and PyInstaller frozen exe)
if getattr(sys, "frozen", False) and hasattr(sys, "_MEIPASS"):
    ASSETS_DIR = os.path.join(sys._MEIPASS, "src", "ui", "assets").replace("\\", "/")
else:
    ASSETS_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "assets")).replace("\\", "/")

THEMES = {
    "emerald": {
        "name": "FunPay Emerald",
        "primary": "#10b981",
        "primary_hover": "#059669",
        "primary_pressed": "#047857",
        "primary_border": "#34d399",
        "primary_light": "rgba(16, 185, 129, 0.15)",
        "badge_bg": "#064e3b",
        "badge_fg": "#6ee7b7",
        "badge_border": "#059669",
        "accent_text": "#34d399",
    },
    "violet": {
        "name": "Neon Violet",
        "primary": "#6366f1",
        "primary_hover": "#4f46e5",
        "primary_pressed": "#4338ca",
        "primary_border": "#818cf8",
        "primary_light": "rgba(99, 102, 241, 0.15)",
        "badge_bg": "#1e1b4b",
        "badge_fg": "#a5b4fc",
        "badge_border": "#4338ca",
        "accent_text": "#a5b4fc",
    },
    "cyan": {
        "name": "Nordic Cyan",
        "primary": "#06b6d4",
        "primary_hover": "#0891b2",
        "primary_pressed": "#0e7490",
        "primary_border": "#22d3ee",
        "primary_light": "rgba(6, 182, 212, 0.15)",
        "badge_bg": "#164e63",
        "badge_fg": "#67e8f9",
        "badge_border": "#0891b2",
        "accent_text": "#22d3ee",
    },
    "amber": {
        "name": "Sunset Amber",
        "primary": "#f59e0b",
        "primary_hover": "#d97706",
        "primary_pressed": "#b45309",
        "primary_border": "#fbbf24",
        "primary_light": "rgba(245, 158, 11, 0.15)",
        "badge_bg": "#78350f",
        "badge_fg": "#fde68a",
        "badge_border": "#d97706",
        "accent_text": "#fbbf24",
    },
}


def get_dark_theme_qss(accent_name: str = "emerald") -> str:
    """Generate dark theme QSS with dynamic accent palette and absolute asset paths."""
    theme = THEMES.get(accent_name.lower(), THEMES["emerald"])

    radio_unchecked = f"{ASSETS_DIR}/radio_unchecked.png"
    radio_checked = f"{ASSETS_DIR}/radio_checked.png"
    checkbox_unchecked = f"{ASSETS_DIR}/checkbox_unchecked.png"
    checkbox_checked = f"{ASSETS_DIR}/checkbox_checked.png"
    arrow_down = f"{ASSETS_DIR}/arrow_down.png"

    return f"""
/* Global Window & Font */
QWidget {{
    background-color: #121214;
    color: #e4e4e7;
    font-family: 'Segoe UI', Arial, sans-serif;
    font-size: 13px;
    selection-background-color: {theme['primary']};
    selection-color: #ffffff;
}}

QMainWindow {{
    background-color: #121214;
}}

QFrame#HeaderFrame {{
    background-color: #18181b;
    border-bottom: 1px solid #27272a;
    min-height: 52px;
    max-height: 54px;
}}

QFrame#LeftPanel {{
    background-color: #18181b;
    border-right: 1px solid #27272a;
}}

QFrame#RightPanel {{
    background-color: #121214;
}}

/* Buttons */
QPushButton {{
    background-color: #27272a;
    color: #f4f4f5;
    border: 1px solid #3f3f46;
    border-radius: 6px;
    padding: 6px 12px;
    font-weight: 500;
}}

QPushButton:hover {{
    background-color: #3f3f46;
    border-color: #52525b;
}}

QPushButton:pressed {{
    background-color: #202024;
    border-color: {theme['primary']};
}}

QPushButton:disabled {{
    background-color: #18181b;
    color: #52525b;
    border-color: #27272a;
}}

/* Primary Action Buttons */
QPushButton#PrimaryButton {{
    background-color: {theme['primary']};
    color: #ffffff;
    border: 1px solid {theme['primary_border']};
    font-weight: 600;
}}

QPushButton#PrimaryButton:hover {{
    background-color: {theme['primary_hover']};
    border-color: {theme['primary_border']};
}}

QPushButton#PrimaryButton:pressed {{
    background-color: {theme['primary_pressed']};
}}

/* Success / Toggle Button */
QPushButton#SuccessButton {{
    background-color: #14532d;
    color: #4ade80;
    border: 1px solid #16a34a;
    font-weight: 600;
}}

QPushButton#SuccessButton:hover {{
    background-color: #166534;
    border-color: #22c55e;
}}

/* Danger Button */
QPushButton#DangerButton {{
    background-color: #450a0a;
    color: #f87171;
    border: 1px solid #7f1d1d;
}}

QPushButton#DangerButton:hover {{
    background-color: #7f1d1d;
    border-color: #dc2626;
    color: #ffffff;
}}

/* Tool Buttons in Header */
QPushButton#ToolButton {{
    background-color: #27272a;
    color: #e4e4e7;
    border: 1px solid #3f3f46;
    border-radius: 6px;
    padding: 5px;
    min-width: 30px;
    max-width: 30px;
    min-height: 28px;
    max-height: 28px;
}}

QPushButton#ToolButton:hover {{
    background-color: #3f3f46;
    border-color: {theme['primary']};
}}

/* Shift Widget */
QFrame#ShiftWidget {{
    background-color: #18181b;
    border: 1px solid #27272a;
    border-radius: 8px;
    padding: 2px 6px;
}}

QPushButton#ShiftStartBtn {{
    background-color: {theme['primary']};
    color: #ffffff;
    border: 1px solid {theme['primary_border']};
    border-radius: 6px;
    font-weight: 600;
    padding: 4px 8px;
    min-height: 24px;
}}

QPushButton#ShiftStartBtn:hover {{
    background-color: {theme['primary_hover']};
}}

QPushButton#ShiftStopBtn {{
    background-color: #881337;
    color: #fecdd3;
    border: 1px solid #e11d48;
    border-radius: 6px;
    font-weight: 600;
    padding: 4px 8px;
    min-height: 24px;
}}

QPushButton#ShiftStopBtn:hover {{
    background-color: #9f1239;
    color: #ffffff;
}}

QLabel#ShiftTimerLabel {{
    font-family: 'Consolas', 'Cascadia Code', monospace;
    font-weight: bold;
    font-size: 13px;
    color: #ffffff;
}}

QLabel#ShiftCountLabel {{
    font-size: 11px;
    color: {theme['accent_text']};
    font-weight: 600;
}}

/* Inputs & Edits */
QLineEdit, QTextEdit, QPlainTextEdit {{
    background-color: #18181b;
    color: #f4f4f5;
    border: 1px solid #27272a;
    border-radius: 6px;
    padding: 8px 10px;
}}

QLineEdit:focus, QTextEdit:focus, QPlainTextEdit:focus {{
    border: 1px solid {theme['primary']};
    background-color: #18181b;
}}

/* ComboBox */
QComboBox {{
    background-color: #27272a;
    color: #f4f4f5;
    border: 1px solid #3f3f46;
    border-radius: 6px;
    padding: 4px 24px 4px 10px;
    min-width: 100px;
    max-width: 145px;
    min-height: 24px;
}}

QComboBox:hover {{
    border-color: {theme['primary']};
}}

QComboBox::drop-down {{
    subcontrol-origin: padding;
    subcontrol-position: top right;
    width: 24px;
    border-left: none;
}}

QComboBox::down-arrow {{
    image: url('{arrow_down}');
    width: 10px;
    height: 10px;
}}

QComboBox QAbstractItemView {{
    background-color: #18181b;
    border: 1px solid #3f3f46;
    border-radius: 6px;
    selection-background-color: {theme['primary']};
    selection-color: #ffffff;
    padding: 4px;
}}

/* ListWidget */
QListWidget {{
    background-color: transparent;
    border: none;
    outline: none;
}}

QListWidget::item {{
    background-color: transparent;
    border: none;
    padding: 0px;
    margin: 2px 0px;
}}

/* Radio Buttons with Pixel-Perfect Asset */
QRadioButton {{
    color: #e4e4e7;
    spacing: 8px;
    font-size: 12px;
}}

QRadioButton::indicator {{
    width: 16px;
    height: 16px;
}}

QRadioButton::indicator:unchecked {{
    image: url('{radio_unchecked}');
}}

QRadioButton::indicator:checked {{
    image: url('{radio_checked}');
}}

/* Checkbox with Pixel-Perfect Asset */
QCheckBox {{
    color: #e4e4e7;
    spacing: 8px;
    font-size: 13px;
}}

QCheckBox::indicator {{
    width: 16px;
    height: 16px;
}}

QCheckBox::indicator:unchecked {{
    image: url('{checkbox_unchecked}');
}}

QCheckBox::indicator:checked {{
    image: url('{checkbox_checked}');
}}

/* Scrollbars */
QScrollBar:vertical {{
    background: #18181b;
    width: 6px;
    margin: 0px;
    border-radius: 3px;
}}

QScrollBar:horizontal {{
    height: 0px;
}}

QScrollBar::handle:vertical {{
    background: #3f3f46;
    border-radius: 3px;
    min-height: 20px;
}}

QScrollBar::handle:vertical:hover {{
    background: #52525b;
}}

QScrollBar::add-line:vertical, QScrollBar::sub-line:vertical {{
    height: 0px;
}}

/* Badges */
QLabel#ActiveShortcutBadge {{
    background-color: {theme['badge_bg']};
    color: {theme['badge_fg']};
    border: 1px solid {theme['badge_border']};
    border-radius: 5px;
    padding: 3px 6px;
    font-size: 11px;
    font-weight: bold;
    font-family: 'Consolas', 'Cascadia Code', monospace;
}}

QLabel#InactiveShortcutBadge {{
    background-color: #27272a;
    color: #71717a;
    border: 1px solid #3f3f46;
    border-radius: 5px;
    padding: 3px 6px;
    font-size: 11px;
    font-weight: bold;
    font-family: 'Consolas', 'Cascadia Code', monospace;
}}

/* Status Bar */
QStatusBar {{
    background-color: #18181b;
    color: #71717a;
    border-top: 1px solid #27272a;
    padding: 4px 10px;
    font-size: 12px;
}}
"""


# For backward compatibility
DARK_THEME_QSS = get_dark_theme_qss()
