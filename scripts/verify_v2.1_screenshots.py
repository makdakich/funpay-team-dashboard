"""
Verification Capture Script: Captures pixel-perfect screenshots of all main surfaces of FanPay Assistant v2.1.0 (Obsidian Command)
Includes tests for 30d, 365d, custom date range, shifts, orders, clients, popup, and desktop app.
"""
import os
import sys
import json
import time
import shutil
import threading
import subprocess
from pathlib import Path
from http.server import SimpleHTTPRequestHandler, HTTPServer

ROOT_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT_DIR))

OUTPUT_DIR = ROOT_DIR / "screenshots" / "v2.1_release"
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

ARTIFACT_DIR = Path(r"C:\Users\Alexey\.gemini\antigravity\brain\654177f4-b921-4950-994c-474e54af1cce\v2.1_release")
ARTIFACT_DIR.mkdir(parents=True, exist_ok=True)

CHROME_BIN = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
PORT = 8993

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
    day_ms = 86400000

    # Create realistic orders spanning 365 days
    orders = []
    # Recent orders (past 7 days)
    recent_samples = [
        {"id": "FP-90124", "buyerUsername": "CyberGamer99", "buyerId": 9102, "description": "1000 V-Bucks Fortnite Code", "price": 1250, "currency": "₽", "status": "closed", "offset": 1800000},
        {"id": "FP-90123", "buyerUsername": "Alex_Vip", "buyerId": 8831, "description": "Telegram Stars x500", "price": 890, "currency": "₽", "status": "closed", "offset": 3600000},
        {"id": "FP-90122", "buyerUsername": "DotaGod", "buyerId": 4412, "description": "Arcana Manifold Paradox PA", "price": 2400, "currency": "₽", "status": "closed", "offset": 7200000},
        {"id": "FP-90121", "buyerUsername": "Nikita_Fast", "buyerId": 9102, "description": "Valorant Points 2050 VP", "price": 1850, "currency": "₽", "status": "closed", "offset": 14400000},
        {"id": "FP-90120", "buyerUsername": "Samurai77", "buyerId": 7710, "description": "Steam Key Rust", "price": 1100, "currency": "₽", "status": "refunded", "offset": 28800000},
        {"id": "FP-90119", "buyerUsername": "MegaBrawl", "buyerId": 5521, "description": "Brawl Pass Plus", "price": 950, "currency": "₽", "status": "closed", "offset": 1 * day_ms},
        {"id": "FP-90118", "buyerUsername": "Alex_Vip", "buyerId": 8831, "description": "Telegram Premium 12 месяцев", "price": 2990, "currency": "₽", "status": "closed", "offset": 2 * day_ms},
        {"id": "FP-90117", "buyerUsername": "CS2_Trader", "buyerId": 6620, "description": "AK-47 Redline FT", "price": 1750, "currency": "₽", "status": "closed", "offset": 3 * day_ms},
        {"id": "FP-90116", "buyerUsername": "Elena_Play", "buyerId": 3311, "description": "Robux 1000 via Gamepass", "price": 820, "currency": "₽", "status": "closed", "offset": 5 * day_ms},
        {"id": "FP-90115", "buyerUsername": "GlobalUser", "buyerId": 1109, "description": "Discord Nitro 1 Year", "price": 3100, "currency": "₽", "status": "closed", "offset": 6 * day_ms},
    ]
    for s in recent_samples:
        ts = now - s["offset"]
        dt = time.strftime("%d.%m.%Y", time.localtime(ts / 1000))
        orders.append({
            "id": s["id"],
            "description": s["description"],
            "buyerUsername": s["buyerUsername"],
            "buyerId": s["buyerId"],
            "chatId": f"users-{s['buyerId']}-1284920",
            "price": s["price"],
            "currency": s["currency"],
            "status": s["status"],
            "dateStr": dt,
            "timestamp": ts
        })

    # Historical orders spanning 10 days to 350 days ago
    for day in range(10, 360, 4):
        ts = now - (day * day_ms)
        dt = time.strftime("%d.%m.%Y", time.localtime(ts / 1000))
        b_id = 1000 + (day % 18)
        orders.append({
            "id": f"FP-HIST-{day}",
            "description": f"Цифровой товар / Ключ #{day}",
            "buyerUsername": f"Gamer_{b_id}",
            "buyerId": b_id,
            "chatId": f"users-{b_id}-1284920",
            "price": 850 + (day * 17) % 2400,
            "currency": "₽",
            "status": "closed" if (day % 13 != 0) else "refunded",
            "dateStr": dt,
            "timestamp": ts
        })

    mock_state_json = json.dumps({
        "fphk_settings": {
            "sellerSharePercent": 15.0,
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
            {"id": "t1", "profileId": "default", "name": "Приветствие", "text": "Здравствуйте, {buyer}! Заказ #{order_id} принят в обработку.", "key": "F1"},
            {"id": "t2", "profileId": "default", "name": "Данные аккаунта", "text": "Логин: {login}\nПароль: {password}\nПочта: {email}", "key": "F2"},
            {"id": "t3", "profileId": "default", "name": "Завершение", "text": "Товар передан! Пожалуйста, подтвердите заказ на FunPay.", "key": "F3"},
            {"id": "t4", "profileId": "default", "name": "Ожидание оплаты", "text": "Ожидаем подтверждения оплаты от платежной системы...", "key": "F4"},
            {"id": "t5", "profileId": "default", "name": "Инструкция Steam", "text": "Перейдите по ссылке обмена и подтвердите трейд в Steam Guard.", "key": "F5"}
        ],
        "fphk_cache": {
            "lastSyncTimestamp": now - 120000,
            "accountInfo": {
                "username": "Alexey_Store",
                "userId": "1284920",
                "totalBalance": 48250.00,
                "currency": "₽",
                "activeOrdersCount": 4
            },
            "orders": orders,
            "error": None
        },
        "fphk_shift_state": {
            "shiftActive": True,
            "shiftStartTime": now - (3 * 3600 + 18 * 60 + 44) * 1000,
            "currentOperator": "Алексей (Owner)",
            "note": "Дневная смена"
        },
        "fphk_shift_history": [
            {
                "id": "shift-204",
                "operatorName": "Иван (Ночной)",
                "startTime": now - 86400000,
                "endTime": now - 57600000,
                "duration": 28800000,
                "sellerSharePercent": 12.0,
                "earnings": {
                    "turnoverByCurrency": {"₽": 18450},
                    "sellerShareByCurrency": {"₽": 2214},
                    "ordersCount": 11,
                    "refundedCount": 0,
                    "refundedSumByCurrency": {}
                },
                "note": "Успешная ночная смена, много ключей Steam",
                "orderIds": ["FP-90119", "FP-90118"]
            },
            {
                "id": "shift-203",
                "operatorName": "Дмитрий (Дневной)",
                "startTime": now - 172800000,
                "endTime": now - 144000000,
                "duration": 28800000,
                "sellerSharePercent": 12.0,
                "earnings": {
                    "turnoverByCurrency": {"₽": 34200},
                    "sellerShareByCurrency": {"₽": 4104},
                    "ordersCount": 16,
                    "refundedCount": 0,
                    "refundedSumByCurrency": {}
                },
                "note": "Пятничный наплыв заказов по Fortnite и Stars",
                "orderIds": ["FP-90117", "FP-90116"]
            },
            {
                "id": "shift-202",
                "operatorName": "Алексей (Owner)",
                "startTime": now - 259200000,
                "endTime": now - 237600000,
                "duration": 21600000,
                "sellerSharePercent": 15.0,
                "earnings": {
                    "turnoverByCurrency": {"₽": 15800},
                    "sellerShareByCurrency": {"₽": 2370},
                    "ordersCount": 9,
                    "refundedCount": 0,
                    "refundedSumByCurrency": {}
                },
                "note": "Дневное дежурство, выдача кодов",
                "orderIds": ["FP-90115"]
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
          }},
          onChanged: {{
            addListener: () => {{}}
          }}
        }},
        runtime: {{
          sendMessage: (msg, cb) => {{
            let res = {{ success: true }};
            if (msg.type === 'GET_STATE') {{
              res = {{
                success: true,
                state: {{
                  settings: MOCK_STORAGE.fphk_settings,
                  profiles: MOCK_STORAGE.fphk_profiles,
                  templates: MOCK_STORAGE.fphk_templates,
                  cache: MOCK_STORAGE.fphk_cache
                }}
              }};
            }} else if (msg.type === 'GET_SHIFT_STATE') {{
              res = {{
                success: true,
                shiftState: MOCK_STORAGE.fphk_shift_state
              }};
            }} else if (msg.type === 'GET_SHIFT_HISTORY') {{
              res = {{
                success: true,
                history: MOCK_STORAGE.fphk_shift_history
              }};
            }} else if (msg.type === 'UPDATE_SETTINGS') {{
              Object.assign(MOCK_STORAGE.fphk_settings, msg.payload || {{}});
              res = {{ success: true, settings: MOCK_STORAGE.fphk_settings }};
            }}
            if (cb) setTimeout(() => cb(res), 5);
            return Promise.resolve(res);
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

    views = [
        ("dashboard", "v2.1_options_dashboard.png", ""),
        ("dashboard", "v2.1_options_dashboard_365d.png", """
            setTimeout(() => {
                const btn365 = document.querySelector('button.period-pill[data-days="365"]');
                if (btn365) btn365.click();
            }, 500);
        """),
        ("dashboard", "v2.1_options_dashboard_custom.png", """
            setTimeout(() => {
                const btnCustom = document.querySelector('button.period-pill[data-days="custom"]');
                if (btnCustom) {
                    btnCustom.click();
                    const startInput = document.getElementById('chart-date-start');
                    const endInput = document.getElementById('chart-date-end');
                    const applyBtn = document.getElementById('btn-chart-apply-range');
                    if (startInput) startInput.value = '2026-04-01';
                    if (endInput) endInput.value = '2026-10-20';
                    if (applyBtn) applyBtn.click();
                }
            }, 500);
        """),
        ("shifts", "v2.1_options_shifts.png", ""),
        ("orders", "v2.1_options_orders.png", ""),
        ("clients", "v2.1_options_clients.png", "")
    ]

    for tab, filename, extra_js in views:
        html = options_html_raw.replace("<head>", f"<head>\n{mock_script}")
        switch_script = f"""
        <script>
          window.addEventListener('DOMContentLoaded', () => {{
            setTimeout(() => {{
              const btn = document.querySelector('.nav-item[data-tab="{tab}"]');
              if (btn) btn.click();
              {extra_js}
            }}, 300);
          }});
        </script>
        """
        html = html.replace("</body>", f"{switch_script}\n</body>")
        test_file = dist_options_dir / f"test_view_{filename}.html"
        test_file.write_text(html, encoding="utf-8")

        out_png = OUTPUT_DIR / filename
        cmd = [
            CHROME_BIN,
            "--headless=new",
            f"--screenshot={out_png.resolve().as_posix()}",
            "--window-size=1440,900",
            "--virtual-time-budget=4000",
            "--hide-scrollbars",
            f"http://127.0.0.1:{PORT}/fanpay-hotkeys-extension/dist/options/test_view_{filename}.html"
        ]
        subprocess.run(cmd, check=True)
        shutil.copy(out_png, ARTIFACT_DIR / filename)
        print(f"Captured: {filename} ({out_png.stat().st_size} bytes)")

    # Popup
    popup_html = popup_html_raw.replace("<head>", f"<head>\n{mock_script}")
    popup_test_file = dist_popup_dir / "test_v2.1_popup.html"
    popup_test_file.write_text(popup_html, encoding="utf-8")
    out_popup_png = OUTPUT_DIR / "v2.1_popup.png"
    subprocess.run([
        CHROME_BIN,
        "--headless=new",
        f"--screenshot={out_popup_png.resolve().as_posix()}",
        "--window-size=380,640",
        "--virtual-time-budget=3500",
        "--hide-scrollbars",
        f"http://127.0.0.1:{PORT}/fanpay-hotkeys-extension/dist/popup/test_v2.1_popup.html"
    ], check=True)
    shutil.copy(out_popup_png, ARTIFACT_DIR / "v2.1_popup.png")
    print(f"Captured: v2.1_popup.png ({out_popup_png.stat().st_size} bytes)")


def generate_desktop_screenshots():
    from PySide6.QtWidgets import QApplication
    from PySide6.QtGui import QFont
    from src.database.db import Database
    from src.database.models import HotkeyItem, MODE_PASTE_ENTER, MODE_PASTE, MODE_COPY_ONLY
    from src.core.profile_manager import ProfileManager
    from src.core.template_manager import TemplateManager
    from src.core.variable_manager import VariableManager
    from src.core.settings_manager import SettingsManager
    from src.core.shift_manager import ShiftManager
    from src.ui.main_window import MainWindow
    from src.ui.dialogs.shift_history_dialog import ShiftHistoryDialog
    from src.ui.styles import get_dark_theme_qss

    app = QApplication.instance() or QApplication(sys.argv)
    app.setFont(QFont("Segoe UI", 9))
    app.setStyleSheet(get_dark_theme_qss("emerald"))

    temp_db_path = ROOT_DIR / "temp_audit" / "test_desktop.db"
    if temp_db_path.exists():
        temp_db_path.unlink()
    db = Database(str(temp_db_path))
    prof_mgr = ProfileManager(db)
    tpl_mgr = TemplateManager(db)
    var_mgr = VariableManager(db)
    set_mgr = SettingsManager(db)
    shift_mgr = ShiftManager(db)

    # Seed realistic hotkeys
    default_prof = prof_mgr.get_active_profile()
    if default_prof:
        db.save_hotkey(HotkeyItem(profile_id=default_prof.id, shortcut="F1", title="Приветствие покупателю", message="Здравствуйте, {buyer}! Ваш заказ #{order_id} принят в обработку.", mode=MODE_PASTE_ENTER))
        db.save_hotkey(HotkeyItem(profile_id=default_prof.id, shortcut="F2", title="Выдача данных", message="Логин: {login}\nПароль: {password}\nПочта: {email}", mode=MODE_PASTE))
        db.save_hotkey(HotkeyItem(profile_id=default_prof.id, shortcut="F3", title="Завершение сделки", message="Товар успешно передан! Пожалуйста, подтвердите заказ и оставьте отзыв. Спасибо!", mode=MODE_PASTE_ENTER))
        db.save_hotkey(HotkeyItem(profile_id=default_prof.id, shortcut="F4", title="Инструкция Steam", message="Перейдите по ссылке обмена и подтвердите трейд в мобильном приложении.", mode=MODE_PASTE))

    # Seed shift data
    shift_mgr.start_shift("Алексей (Owner)")
    shift_mgr.record_message()
    shift_mgr.record_message()
    shift_mgr.record_message()

    main_win = MainWindow(prof_mgr, tpl_mgr, var_mgr, set_mgr, shift_mgr)
    main_win.resize(1024, 680)
    main_win.show()
    app.processEvents()
    time.sleep(0.3)
    app.processEvents()

    out_main = OUTPUT_DIR / "v2.1_desktop_main.png"
    main_win.grab().save(str(out_main))
    shutil.copy(out_main, ARTIFACT_DIR / "v2.1_desktop_main.png")
    print(f"Captured: {out_main.name} ({out_main.stat().st_size} bytes)")

    # Shift history dialog
    hist_dlg = ShiftHistoryDialog(shift_mgr, parent=main_win)
    hist_dlg.resize(800, 520)
    hist_dlg.show()
    app.processEvents()
    time.sleep(0.3)
    app.processEvents()
    out_hist = OUTPUT_DIR / "v2.1_desktop_shifts.png"
    hist_dlg.grab().save(str(out_hist))
    shutil.copy(out_hist, ARTIFACT_DIR / "v2.1_desktop_shifts.png")
    print(f"Captured: {out_hist.name} ({out_hist.stat().st_size} bytes)")
    hist_dlg.close()
    main_win.close()


if __name__ == "__main__":
    print("=== Generating v2.1 Verification Screenshots ===")
    generate_extension_screenshots()
    generate_desktop_screenshots()
    print("All screenshots generated and copied to artifact directory!")
