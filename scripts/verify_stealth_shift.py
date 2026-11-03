"""
Verification script for Stealth Shift Minimization:
Captures screenshots of both the floating on-page widget and the extension popup
in both minimized (stealth: no name, money, time) and expanded states.
"""
import os
import sys
import time
import json
import shutil
import threading
import subprocess
from pathlib import Path
from http.server import SimpleHTTPRequestHandler, HTTPServer

ROOT_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT_DIR))

OUTPUT_DIR = ROOT_DIR / "screenshots" / "stealth_shift"
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

ARTIFACT_DIR = Path(r"C:\Users\Alexey\.gemini\antigravity\brain\654177f4-b921-4950-994c-474e54af1cce\stealth_shift")
ARTIFACT_DIR.mkdir(parents=True, exist_ok=True)

CHROME_BIN = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
PORT = 8996

def run_server():
    server = HTTPServer(("127.0.0.1", PORT), SimpleHTTPRequestHandler)
    server.serve_forever()

def main():
    os.chdir(ROOT_DIR)
    t = threading.Thread(target=run_server, daemon=True)
    t.start()
    time.sleep(0.5)

    dist_popup_dir = ROOT_DIR / "fanpay-hotkeys-extension" / "dist" / "popup"
    popup_html_raw = (dist_popup_dir / "popup.html").read_text(encoding="utf-8")
    content_css_raw = (ROOT_DIR / "fanpay-hotkeys-extension" / "src" / "content" / "styles.css").read_text(encoding="utf-8")

    now = int(time.time() * 1000)
    start_time = now - 3600000 * 2 - 15 * 60000 # 2 hours 15 mins ago

    mock_extension_state = {
        "settings": {
            "sellerSharePercent": 15.0,
            "shiftWidgetVisible": True,
            "shiftWidgetPosition": {"top": 80, "left": 100, "minimized": True}
        },
        "profiles": [
            {"id": "p1", "name": "Brawl Stars / Supercell", "hotkeys": []}
        ],
        "templates": [
            {"id": "t1", "profileId": "p1", "title": "Приветствие", "text": "Привет! Спасибо за покупку.", "hotkey": "Ctrl+1"},
            {"id": "t2", "profileId": "p1", "title": "Код отправлен", "text": "Код активации отправлен в чат.", "hotkey": "Ctrl+2"}
        ],
        "cache": {
            "account": {"username": "MasterSeller", "userId": 1284920},
            "balance": {"total": 18450, "currency": "₽"},
            "orders": [
                {"id": "FP-9901", "price": 1250, "currency": "₽", "status": "closed", "timestamp": now - 3000000},
                {"id": "FP-9902", "price": 890, "currency": "₽", "status": "closed", "timestamp": now - 1800000},
                {"id": "FP-9903", "price": 2400, "currency": "₽", "status": "closed", "timestamp": now - 600000}
            ]
        }
    }

    mock_shift_state = {
        "shiftActive": True,
        "shiftStartTime": start_time,
        "currentOperator": "Алексей (Смена #1)"
    }

    # 1. On-Page Floating Widget Simulation (FunPay background)
    funpay_page_template = f"""<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <title>FunPay Simulated Chat & Shift Widget</title>
  <style>
    body {{
      margin: 0;
      padding: 0;
      background: #14171E;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      color: #E2E8F0;
      height: 100vh;
      overflow: hidden;
    }}
    /* FunPay mock chat layout */
    .funpay-header {{
      background: #1B202B;
      border-bottom: 1px solid #283042;
      padding: 12px 24px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }}
    .fp-logo {{
      font-size: 18px;
      font-weight: 800;
      color: #3B82F6;
      letter-spacing: 1px;
    }}
    .fp-user {{
      font-size: 13px;
      color: #94A3B8;
    }}
    .funpay-content {{
      display: flex;
      height: calc(100vh - 55px);
    }}
    .chat-sidebar {{
      width: 280px;
      background: #181D27;
      border-right: 1px solid #283042;
      padding: 16px;
    }}
    .chat-dialog-item {{
      padding: 10px 12px;
      border-radius: 8px;
      background: #202736;
      margin-bottom: 8px;
      font-size: 13px;
    }}
    .chat-main {{
      flex: 1;
      padding: 24px;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
    }}
    .chat-bubble {{
      background: #232B3B;
      padding: 12px 16px;
      border-radius: 12px;
      max-width: 480px;
      margin-bottom: 12px;
      font-size: 14px;
      line-height: 1.5;
    }}
    {content_css_raw}
  </style>
</head>
<body>
  <div class="funpay-header">
    <div class="fp-logo">FUNPAY.COM &bull; Торговая площадка</div>
    <div class="fp-user">Баланс: 18 450 ₽ &bull; Пользователь: MasterSeller</div>
  </div>
  <div class="funpay-content">
    <div class="chat-sidebar">
      <div style="font-weight:600; font-size:12px; color:#64748B; margin-bottom:12px;">ДИАЛОГИ ЗАКАЗОВ</div>
      <div class="chat-dialog-item"><b>CyberGamer99</b><br><span style="color:#10B981;">Заказ FP-9903 оплачен</span></div>
      <div class="chat-dialog-item"><b>Alex_Vip</b><br><span style="color:#64748B;">Спасибо за товар!</span></div>
      <div class="chat-dialog-item"><b>Elena_Play</b><br><span style="color:#64748B;">Код получен</span></div>
    </div>
    <div class="chat-main">
      <div>
        <div class="chat-bubble"><b>Покупатель (CyberGamer99):</b> Здравствуйте, оплатил 1000 V-Bucks, жду код!</div>
        <div class="chat-bubble" style="background:#1E3A5F; margin-left: auto;"><b>Вы:</b> Приветствую! Сейчас отправлю код в чат, минуту.</div>
      </div>
      <div style="background:#1B202B; padding:12px; border-radius:8px; border:1px solid #283042; color:#64748B; font-size:13px;">
        Поле ввода сообщения FunPay...
      </div>
    </div>
  </div>

  <!-- Injected HUD Widget (Stealth Minimized Pill) -->
  <div id="fphk-shift-widget" class="fphk-shift-widget fphk-minimized" style="position:fixed; left:320px; top:80px; z-index:99999;">
    <div class="fphk-widget-pill fphk-stealth-pill" id="fphk-minimized-pill" title="Смена активна • Нажмите, чтобы развернуть">
      <span class="fphk-dot-pulse"></span>
      <span class="fphk-pill-label">Смена</span>
      <button class="fphk-pill-btn-toggle" id="fphk-btn-widget-toggle" title="Развернуть смену">⛶</button>
    </div>
  </div>
</body>
</html>"""

    widget_min_file = ROOT_DIR / "fanpay-hotkeys-extension" / "dist" / "test_widget_minimized.html"
    widget_min_file.write_text(funpay_page_template, encoding="utf-8")

    # Expanded widget version
    funpay_expanded_template = funpay_page_template.replace(
        '<div id="fphk-shift-widget" class="fphk-shift-widget fphk-minimized" style="position:fixed; left:320px; top:80px; z-index:99999;">\n    <div class="fphk-widget-pill fphk-stealth-pill" id="fphk-minimized-pill" title="Смена активна • Нажмите, чтобы развернуть">\n      <span class="fphk-dot-pulse"></span>\n      <span class="fphk-pill-label">Смена</span>\n      <button class="fphk-pill-btn-toggle" id="fphk-btn-widget-toggle" title="Развернуть смену">⛶</button>\n    </div>\n  </div>',
        """<div id="fphk-shift-widget" class="fphk-shift-widget" style="position:fixed; left:320px; top:80px; z-index:99999;">
    <div class="fphk-widget-card">
      <div class="fphk-widget-header" id="fphk-widget-drag-handle">
        <div class="fphk-header-left">
          <span class="fphk-dot-pulse"></span>
          <span class="fphk-widget-title">Смена активна</span>
        </div>
        <div class="fphk-header-actions">
          <button class="fphk-btn-icon" id="fphk-btn-widget-toggle" title="Свернуть (скрыть имя, время и выручку)">—</button>
        </div>
      </div>
      <div class="fphk-widget-body">
        <div class="fphk-row-op">
          <span class="fphk-icon-op">👤</span>
          <span class="fphk-op-name" title="Алексей (Смена #1)">Алексей (Смена #1)</span>
          <span class="fphk-start-time">с 14:15:00</span>
        </div>
        <div class="fphk-timer-block">
          <span class="fphk-timer-val" id="fphk-timer-val">02:15:42</span>
          <span class="fphk-timer-badge">В ПРОЦЕССЕ</span>
        </div>
        <div class="fphk-earnings-box">
          <div class="fphk-earn-row">
            <span class="fphk-earn-label">Заказов за смену:</span>
            <span class="fphk-earn-val">3</span>
          </div>
          <div class="fphk-earn-row">
            <span class="fphk-earn-label">Оборот:</span>
            <span class="fphk-earn-val">4 540 ₽</span>
          </div>
          <div class="fphk-earn-row fphk-share-row">
            <span class="fphk-earn-label">Моя доля (15%):</span>
            <span class="fphk-earn-val fphk-share-val">681 ₽</span>
          </div>
        </div>
        <div class="fphk-widget-footer">
          <button class="fphk-btn-stop" id="fphk-btn-request-stop">
            <span>⏹</span> Завершить смену
          </button>
        </div>
      </div>
    </div>
  </div>"""
    )
    widget_exp_file = ROOT_DIR / "fanpay-hotkeys-extension" / "dist" / "test_widget_expanded.html"
    widget_exp_file.write_text(funpay_expanded_template, encoding="utf-8")

    # 2. Popup mock script with collapsed state (localStorage = true)
    def make_popup_html(collapsed: bool):
        mock_script = f"""
        <script>
          localStorage.setItem('fphk_popup_shift_collapsed', '{str(collapsed).lower()}');
          const MOCK_STORAGE = {json.dumps({
              "fphk_settings": mock_extension_state["settings"],
              "fphk_profiles": mock_extension_state["profiles"],
              "fphk_templates": mock_extension_state["templates"],
              "fphk_cache": mock_extension_state["cache"],
              "fphk_shift_state": mock_shift_state
          })};
          window.chrome = {{
            storage: {{
              local: {{
                get: (keys, cb) => setTimeout(() => cb(MOCK_STORAGE), 5),
                set: (items, cb) => setTimeout(cb, 5)
              }},
              onChanged: {{ addListener: () => {{}} }}
            }},
            runtime: {{
              sendMessage: (msg, cb) => {{
                let res = {{ success: true }};
                if (msg.type === 'GET_STATE') {{
                  res = {{ success: true, state: {{
                    settings: MOCK_STORAGE.fphk_settings,
                    profiles: MOCK_STORAGE.fphk_profiles,
                    templates: MOCK_STORAGE.fphk_templates,
                    cache: MOCK_STORAGE.fphk_cache
                  }}}};
                }} else if (msg.type === 'GET_SHIFT_STATE') {{
                  res = {{ success: true, shiftState: MOCK_STORAGE.fphk_shift_state }};
                }}
                if (cb) setTimeout(() => cb(res), 5);
                return Promise.resolve(res);
              }},
              openOptionsPage: () => {{}},
              getURL: (p) => p
            }},
            tabs: {{
              query: (q, cb) => cb([{{ id: 1, url: 'https://funpay.com/chat/' }}]),
              create: () => {{}}
            }}
          }};
        </script>
        """
        return popup_html_raw.replace("<head>", f"<head>\n{mock_script}")

    popup_collapsed_file = dist_popup_dir / "test_popup_collapsed.html"
    popup_collapsed_file.write_text(make_popup_html(True), encoding="utf-8")

    popup_expanded_file = dist_popup_dir / "test_popup_expanded.html"
    popup_expanded_file.write_text(make_popup_html(False), encoding="utf-8")

    # Capture screenshots
    captures = [
        ("stealth_widget_minimized.png", f"http://127.0.0.1:{PORT}/fanpay-hotkeys-extension/dist/test_widget_minimized.html", "1280,800"),
        ("stealth_widget_expanded.png", f"http://127.0.0.1:{PORT}/fanpay-hotkeys-extension/dist/test_widget_expanded.html", "1280,800"),
        ("stealth_popup_collapsed.png", f"http://127.0.0.1:{PORT}/fanpay-hotkeys-extension/dist/popup/test_popup_collapsed.html", "380,640"),
        ("stealth_popup_expanded.png", f"http://127.0.0.1:{PORT}/fanpay-hotkeys-extension/dist/popup/test_popup_expanded.html", "380,640")
    ]

    for fname, url, size in captures:
        out_png = OUTPUT_DIR / fname
        cmd = [
            CHROME_BIN,
            "--headless=new",
            f"--screenshot={out_png.resolve().as_posix()}",
            f"--window-size={size}",
            "--virtual-time-budget=3000",
            "--hide-scrollbars",
            url
        ]
        subprocess.run(cmd, check=True)
        shutil.copy(out_png, ARTIFACT_DIR / fname)
        print(f"Captured: {fname} ({out_png.stat().st_size} bytes)")

    print("All stealth shift verification screenshots successfully created!")

if __name__ == "__main__":
    main()
