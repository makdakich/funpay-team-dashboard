"""
Audit Capture Script: Captures pixel-perfect screenshots of all main surfaces of FanPay Assistant v2.0
Serves pages via local HTTP server to satisfy Chrome ES module CORS policies.
"""
import os
import sys
import json
import time
import threading
import subprocess
from pathlib import Path
from http.server import SimpleHTTPRequestHandler, HTTPServer

ROOT_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT_DIR))
OUTPUT_DIR = ROOT_DIR / "screenshots" / "audit_v2.0"
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

CHROME_BIN = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
PORT = 8991

def run_server():
    server = HTTPServer(("127.0.0.1", PORT), SimpleHTTPRequestHandler)
    server.serve_forever()

def generate_extension_screenshots():
    # Start server
    os.chdir(ROOT_DIR)
    t = threading.Thread(target=run_server, daemon=True)
    t.start()
    time.sleep(0.5)

    options_html_raw = (ROOT_DIR / "fanpay-hotkeys-extension" / "dist" / "options" / "options.html").read_text(encoding="utf-8")
    popup_html_raw = (ROOT_DIR / "fanpay-hotkeys-extension" / "dist" / "popup" / "popup.html").read_text(encoding="utf-8")

    now = int(time.time() * 1000)
    mock_state_json = json.dumps({
        "fphk_settings": {
            "sellerSharePercent": 12.0,
            "activeProfileId": "default",
            "hotkeysEnabled": True,
            "soundEnabled": True,
            "notificationsEnabled": True,
            "theme": "dark",
            "operatorsList": ["Алексей (Owner)", "Иван (Ночной)", "Дмитрий (Дневной)"],
            "shiftOverrunAlertHours": 8
        },
        "fphk_profiles": [
            {"id": "default", "name": "Основной (Steam & Игры)", "isDefault": True, "hotkeys": []},
            {"id": "donations", "name": "Донаты & Валюта", "isDefault": False, "hotkeys": []}
        ],
        "fphk_templates": [
            {"id": "t1", "profileId": "default", "name": "Приветствие", "text": "Здравствуйте, {buyer}! Ваш заказ #{order_id} принят в обработку.", "key": "F1"},
            {"id": "t2", "profileId": "default", "name": "Данные аккаунта", "text": "Логин: {login}\nПароль: {password}\nПочта: {email}", "key": "F2"},
            {"id": "t3", "profileId": "default", "name": "Завершение", "text": "Товар передан! Пожалуйста, подтвердите заказ и оставьте отзыв. Спасибо!", "key": "F3"}
        ],
        "fphk_cache": {
            "lastSyncTimestamp": now - 300000,
            "accountInfo": {
                "username": "Alexey_Store",
                "userId": "1284920",
                "totalBalance": 24850.50,
                "currency": "₽",
                "activeOrdersCount": 3
            },
            "orders": [
                {"id": "FP-88910", "buyer": "CyberGamer99", "buyerId": "u9102", "itemTitle": "1000 V-Bucks Fortnite Code", "amount": 1250, "currency": "₽", "status": "closed", "timestamp": now - 1800000},
                {"id": "FP-88909", "buyer": "Alex_Vip", "buyerId": "u8831", "itemTitle": "Telegram Stars x500", "amount": 890, "currency": "₽", "status": "closed", "timestamp": now - 3600000},
                {"id": "FP-88908", "buyer": "DotaGod", "buyerId": "u4412", "itemTitle": "Arcana Manifold Paradox PA", "amount": 2400, "currency": "₽", "status": "closed", "timestamp": now - 7200000},
                {"id": "FP-88907", "buyer": "Nikita_Fast", "buyerId": "u9102", "itemTitle": "Valorant Points 2050 VP", "amount": 18.50, "currency": "$", "status": "closed", "timestamp": now - 14400000},
                {"id": "FP-88906", "buyer": "Samurai77", "buyerId": "u7710", "itemTitle": "Steam Key Rust", "amount": 1100, "currency": "₽", "status": "refunded", "timestamp": now - 28800000},
                {"id": "FP-88905", "buyer": "MegaBrawl", "buyerId": "u5521", "itemTitle": "Brawl Stars Brawl Pass Plus", "amount": 950, "currency": "₽", "status": "closed", "timestamp": now - 86400000},
                {"id": "FP-88904", "buyer": "Alex_Vip", "buyerId": "u8831", "itemTitle": "Telegram Premium 12 месяцев", "amount": 2990, "currency": "₽", "status": "closed", "timestamp": now - 172800000},
                {"id": "FP-88903", "buyer": "CS2_Trader", "buyerId": "u6620", "itemTitle": "AK-47 Redline FT", "amount": 1750, "currency": "₽", "status": "closed", "timestamp": now - 259200000},
                {"id": "FP-88902", "buyer": "Elena_Play", "buyerId": "u3311", "itemTitle": "Robux 1000 via Gamepass", "amount": 820, "currency": "₽", "status": "closed", "timestamp": now - 345600000},
                {"id": "FP-88901", "buyer": "GlobalUser", "buyerId": "u1109", "itemTitle": "Discord Nitro 1 Year", "amount": 35.00, "currency": "$", "status": "closed", "timestamp": now - 432000000}
            ],
            "error": None
        },
        "fphk_shift_state": {
            "isActive": True,
            "startTime": now - (2 * 3600 + 45 * 60 + 12) * 1000,
            "operatorName": "Алексей (Owner)",
            "ratePercent": 12.0
        },
        "fphk_shift_history": [
            {
                "id": "shift-104",
                "operatorName": "Иван (Ночной)",
                "startTime": now - 86400000,
                "endTime": now - 57600000,
                "durationSeconds": 28800,
                "ratePercent": 10.0,
                "closedOrdersCount": 8,
                "totalTurnover": {"₽": 14200, "$": 45.0},
                "totalEarned": {"₽": 1420, "$": 4.5},
                "note": "Успешная ночная смена, много ключей Steam",
                "orderIds": ["FP-88901", "FP-88902"]
            },
            {
                "id": "shift-103",
                "operatorName": "Дмитрий (Дневной)",
                "startTime": now - 172800000,
                "endTime": now - 144000000,
                "durationSeconds": 28800,
                "ratePercent": 12.0,
                "closedOrdersCount": 14,
                "totalTurnover": {"₽": 28400},
                "totalEarned": {"₽": 3408},
                "note": "Пятничный наплыв заказов по Fortnite",
                "orderIds": ["FP-88903", "FP-88904", "FP-88905"]
            },
            {
                "id": "shift-102",
                "operatorName": "Алексей (Owner)",
                "startTime": now - 259200000,
                "endTime": now - 237600000,
                "durationSeconds": 21600,
                "ratePercent": 15.0,
                "closedOrdersCount": 6,
                "totalTurnover": {"₽": 9800, "$": 20.0},
                "totalEarned": {"₽": 1470, "$": 3.0},
                "note": "Дневное дежурство",
                "orderIds": ["FP-88906", "FP-88907"]
            }
        ]
    })

    mock_script = f"""
    <script>
      const MOCK_STORAGE = {mock_state_json};
      window.chrome = {{
        storage: {{
          local: {{
            get: (keys, cb) => {{
              const res = {{}};
              if (Array.isArray(keys)) {{
                keys.forEach(k => {{ res[k] = MOCK_STORAGE[k]; }});
              }} else if (typeof keys === 'string') {{
                res[keys] = MOCK_STORAGE[keys];
              }} else if (typeof keys === 'object') {{
                for (let k in keys) res[k] = MOCK_STORAGE[k] !== undefined ? MOCK_STORAGE[k] : keys[k];
              }}
              setTimeout(() => cb(res), 5);
            }},
            set: (items, cb) => {{
              Object.assign(MOCK_STORAGE, items);
              if (cb) setTimeout(cb, 5);
            }}
          }}
        }},
        runtime: {{
          sendMessage: (msg, cb) => {{
            if (cb) cb({{ success: true }});
          }},
          onMessage: {{
            addListener: () => {{}}
          }}
        }},
        tabs: {{
          query: (q, cb) => cb([{{ id: 1, url: 'https://funpay.com/chat/' }}]),
          create: () => {{}}
        }}
      }};
    </script>
    """

    dist_options_dir = ROOT_DIR / "fanpay-hotkeys-extension" / "dist" / "options"
    dist_popup_dir = ROOT_DIR / "fanpay-hotkeys-extension" / "dist" / "popup"

    tabs = ["dashboard", "shifts", "orders", "clients"]

    for tab in tabs:
        html = options_html_raw.replace("<head>", f"<head>\n{mock_script}")
        switch_script = f"""
        <script>
          window.addEventListener('DOMContentLoaded', () => {{
            setTimeout(() => {{
              const btn = document.querySelector('.nav-item[data-tab="{tab}"]');
              if (btn) btn.click();
            }}, 300);
          }});
        </script>
        """
        html = html.replace("</body>", f"{switch_script}\n</body>")
        tab_file = dist_options_dir / f"test_{tab}.html"
        tab_file.write_text(html, encoding="utf-8")

        out_png = OUTPUT_DIR / f"audit_v2_options_{tab}.png"
        cmd = [
            CHROME_BIN,
            "--headless=new",
            f"--screenshot={out_png.resolve().as_posix()}",
            "--window-size=1440,900",
            "--virtual-time-budget=3500",
            "--hide-scrollbars",
            f"http://127.0.0.1:{PORT}/fanpay-hotkeys-extension/dist/options/test_{tab}.html"
        ]
        subprocess.run(cmd, check=True)
        print(f"Captured: {out_png.name} ({out_png.stat().st_size} bytes)")

    # Popup
    popup_html = popup_html_raw.replace("<head>", f"<head>\n{mock_script}")
    popup_test_file = dist_popup_dir / "test_popup.html"
    popup_test_file.write_text(popup_html, encoding="utf-8")
    out_popup_png = OUTPUT_DIR / "audit_v2_popup.png"
    subprocess.run([
        CHROME_BIN,
        "--headless=new",
        f"--screenshot={out_popup_png.resolve().as_posix()}",
        "--window-size=380,640",
        "--virtual-time-budget=3500",
        "--hide-scrollbars",
        f"http://127.0.0.1:{PORT}/fanpay-hotkeys-extension/dist/popup/test_popup.html"
    ], check=True)
    print(f"Captured: {out_popup_png.name} ({out_popup_png.stat().st_size} bytes)")


def generate_desktop_screenshots():
    os.environ["QT_QPA_PLATFORM"] = "offscreen"
    from PySide6.QtWidgets import QApplication
    from src.database.db import Database
    from src.core.profile_manager import ProfileManager
    from src.core.template_manager import TemplateManager
    from src.core.variable_manager import VariableManager
    from src.core.settings_manager import SettingsManager
    from src.core.shift_manager import ShiftManager
    from src.ui.main_window import MainWindow
    from src.ui.dialogs.shift_history_dialog import ShiftHistoryDialog
    from src.ui.styles import get_dark_theme_qss

    app = QApplication.instance() or QApplication(sys.argv)
    app.setStyleSheet(get_dark_theme_qss("emerald"))

    # Use temporary file SQLite DB
    temp_db_path = ROOT_DIR / "temp_audit" / "test_desktop.db"
    if temp_db_path.exists():
        temp_db_path.unlink()
    db = Database(str(temp_db_path))
    prof_mgr = ProfileManager(db)
    tpl_mgr = TemplateManager(db)
    var_mgr = VariableManager(db)
    set_mgr = SettingsManager(db)
    shift_mgr = ShiftManager(db)

    # Seed shift data
    shift_mgr.start_shift("Алексей (Owner)")

    main_win = MainWindow(prof_mgr, tpl_mgr, var_mgr, set_mgr, shift_mgr)
    main_win.resize(1024, 680)
    main_win.show()
    app.processEvents()

    out_main = OUTPUT_DIR / "audit_v2_desktop_main.png"
    main_win.grab().save(str(out_main))
    print(f"Captured: {out_main.name} ({out_main.stat().st_size} bytes)")

    # Shift history dialog
    hist_dlg = ShiftHistoryDialog(shift_mgr, parent=main_win)
    hist_dlg.resize(800, 500)
    hist_dlg.show()
    app.processEvents()
    out_hist = OUTPUT_DIR / "audit_v2_desktop_shifts.png"
    hist_dlg.grab().save(str(out_hist))
    print(f"Captured: {out_hist.name} ({out_hist.stat().st_size} bytes)")


if __name__ == "__main__":
    print("=== Generating Extension Screenshots ===")
    generate_extension_screenshots()
    print("=== Generating Desktop Screenshots ===")
    generate_desktop_screenshots()
    print("ALL SCREENSHOTS CAPTURED TO:", OUTPUT_DIR)
