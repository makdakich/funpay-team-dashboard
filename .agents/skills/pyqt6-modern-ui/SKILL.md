---
name: pyqt6-modern-ui
description: Professional modern dark UI/UX styling for PyQt6 desktop applications using Qt Style Sheets (QSS), custom components, DPI awareness, chart painting, and system tray integration.
---

# Modern PyQt6 Desktop UI Architecture

Use this skill when designing, styling, or refactoring PyQt6 desktop applications.

---

## 1. Aesthetic Foundations for PyQt6

- **Palette**: Dark Slate / Deep Graphite (`#0F172A` window, `#1E293B` card surfaces, `#334155` borders, `#F8FAFC` text, `#10B981` emerald accent, `#3B82F6` primary blue).
- **Typography**: Clean system font (Segoe UI on Windows, -apple-system on macOS) with explicit point sizes.
- **High-DPI Awareness**:
  ```python
  import sys
  from PyQt6.QtCore import Qt
  from PyQt6.QtWidgets import QApplication

  # High-DPI scaling
  QApplication.setHighDpiScaleFactorRoundingPolicy(
      Qt.HighDpiScaleFactorRoundingPolicy.PassThrough
  )
  ```

---

## 2. Modern QSS Stylesheet Architecture

Use unified CSS-like stylesheets for consistency:
```css
/* Main Window & Dialogs */
QMainWindow, QDialog {
    background-color: #0B0F19;
    color: #F8FAFC;
    font-family: "Segoe UI", sans-serif;
    font-size: 13px;
}

/* Card Containers */
QFrame[card="true"] {
    background-color: #111827;
    border: 1px solid #1E293B;
    border-radius: 8px;
    padding: 12px;
}

/* Buttons */
QPushButton {
    background-color: #1E293B;
    color: #F8FAFC;
    border: 1px solid #334155;
    border-radius: 6px;
    padding: 6px 14px;
    font-weight: 500;
}
QPushButton:hover {
    background-color: #2D3D54;
    border-color: #475569;
}
QPushButton:pressed {
    background-color: #0F172A;
}

/* Primary Accent Button */
QPushButton[primary="true"] {
    background-color: #2563EB;
    border: 1px solid #3B82F6;
    color: #FFFFFF;
    font-weight: 600;
}
QPushButton[primary="true"]:hover {
    background-color: #1D4ED8;
}

/* Success / Start Button */
QPushButton[success="true"] {
    background-color: #059669;
    border: 1px solid #10B981;
    color: #FFFFFF;
    font-weight: 600;
}

/* Danger / Stop Button */
QPushButton[danger="true"] {
    background-color: #DC2626;
    border: 1px solid #EF4444;
    color: #FFFFFF;
}

/* Inputs & ComboBoxes */
QLineEdit, QComboBox, QSpinBox {
    background-color: #0D1321;
    border: 1px solid #1E293B;
    border-radius: 6px;
    padding: 6px 10px;
    color: #F8FAFC;
}
QLineEdit:focus, QComboBox:focus {
    border: 1px solid #3B82F6;
}

/* Tables */
QTableWidget {
    background-color: #111827;
    border: 1px solid #1E293B;
    border-radius: 8px;
    gridline-color: #1E293B;
    color: #F8FAFC;
}
QHeaderView::section {
    background-color: #0D1321;
    color: #94A3B8;
    padding: 6px;
    border: none;
    border-bottom: 1px solid #1E293B;
    font-weight: 600;
    font-size: 11px;
}
```

---

## 3. Custom Painting for Activity & Charts

When creating charts or heatmaps, use `QPainter` with antialiasing enabled:
```python
painter = QPainter(self)
painter.setRenderHint(QPainter.RenderHint.Antialiasing)
# Draw rounded bars or sparklines with subtle gradients
```

---

## 4. System Tray Integration

- Always provide instant access from the Windows system tray.
- Show active shift status in the tray tooltip (`QSystemTrayIcon.setToolTip("FunPay Hotkeys - Смена активна: 02:45:12")`).
- Use tray notifications for shift milestones or reminders.
