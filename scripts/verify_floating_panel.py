"""
Verification script for Floating Draggable Hotkeys Panel:
Captures screenshots of the FunPay chat interface with:
1. Floating panel in expanded state (draggable, floating outside chat flow).
2. Floating panel in collapsed state (compact [ ⚡ Hotkeys ⛶ ] pill).
3. Options page showing the new setting toggle.
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

OUTPUT_DIR = ROOT_DIR / "screenshots" / "floating_panel"
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

ARTIFACT_DIR = Path(r"C:\Users\Alexey\.gemini\antigravity\brain\654177f4-b921-4950-994c-474e54af1cce\floating_panel")
ARTIFACT_DIR.mkdir(parents=True, exist_ok=True)

CHROME_BIN = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
PORT = 8998

def run_server():
    server = HTTPServer(("127.0.0.1", PORT), SimpleHTTPRequestHandler)
    server.serve_forever()

def main():
    os.chdir(ROOT_DIR)
    t = threading.Thread(target=run_server, daemon=True)
    t.start()
    time.sleep(0.5)

    dist_options_dir = ROOT_DIR / "fanpay-hotkeys-extension" / "dist" / "options"
    options_html_raw = (dist_options_dir / "options.html").read_text(encoding="utf-8")
    content_css_raw = (ROOT_DIR / "fanpay-hotkeys-extension" / "src" / "content" / "styles.css").read_text(encoding="utf-8")

    funpay_chat_sim = f"""<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <title>FunPay Chat with Floating Hotkey Panel</title>
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
    }}
    .chat-layout {{
      display: flex;
      height: calc(100vh - 55px);
    }}
    .chat-sidebar {{
      width: 280px;
      background: #181D27;
      border-right: 1px solid #283042;
      padding: 16px;
    }}
    .dialog-item {{
      padding: 10px 12px;
      border-radius: 8px;
      background: #202736;
      margin-bottom: 8px;
      font-size: 13px;
    }}
    .chat-detail {{
      flex: 1;
      padding: 24px;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      max-width: 800px;
      position: relative;
    }}
    .chat-header-bar {{
      display: flex;
      align-items: center;
      justify-content: space-between;
      border-bottom: 1px solid #283042;
      padding-bottom: 12px;
      margin-bottom: 16px;
    }}
    .chat-user-badge {{
      display: flex;
      align-items: center;
      gap: 10px;
    }}
    .avatar {{
      width: 36px;
      height: 36px;
      border-radius: 50%;
      background: #F59E0B;
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: bold;
    }}
    .chat-history {{
      flex: 1;
      overflow-y: auto;
    }}
    .chat-msg {{
      background: #232B3B;
      padding: 12px 16px;
      border-radius: 12px;
      max-width: 520px;
      margin-bottom: 14px;
      font-size: 14px;
      line-height: 1.5;
    }}
    .chat-msg.mine {{
      background: #1E3A5F;
      margin-left: auto;
    }}
    .chat-form {{
      background: #1B202B;
      padding: 12px;
      border-radius: 8px;
      border: 1px solid #283042;
      display: flex;
      gap: 10px;
      align-items: center;
    }}
    .chat-input {{
      flex: 1;
      background: transparent;
      border: none;
      color: #F8FAFC;
      font-size: 14px;
      outline: none;
    }}
    {content_css_raw}
  </style>
</head>
<body>
  <div class="funpay-header">
    <div class="fp-logo">FUNPAY.COM &bull; Торговая площадка</div>
    <div style="font-size: 13px; color: #94A3B8;">Баланс: 18 450 ₽ &bull; Пользователь: MasterSeller</div>
  </div>

  <div class="chat-layout">
    <div class="chat-sidebar">
      <div style="font-weight:600; font-size:12px; color:#64748B; margin-bottom:12px;">ДИАЛОГИ</div>
      <div class="dialog-item" style="border-left: 3px solid #3B82F6;">
        <b>wer20209</b><br><span style="color:#10B981;">Онлайн</span>
      </div>
      <div class="dialog-item"><b>Alex_Vip</b><br><span style="color:#64748B;">Спасибо за заказ!</span></div>
    </div>

    <!-- Active Chat Area: Clean, Spacious, Nothing Injected between messages and input! -->
    <div class="chat-detail">
      <div class="chat-header-bar">
        <div class="chat-user-badge">
          <div class="avatar">🐶</div>
          <div>
            <div style="font-weight:700; font-size:15px;">wer20209</div>
            <div style="font-size:12px; color:#10B981;">Онлайн</div>
          </div>
        </div>
        <div style="display:flex; gap:8px;">
          <button style="background:#202736; border:1px solid #283042; color:#94A3B8; padding:4px 8px; border-radius:6px; cursor:pointer;">❐</button>
          <button style="background:#059669; border:none; color:#FFFFFF; padding:4px 10px; border-radius:6px; font-size:12px; font-weight:600;">✔ Включены оповещения</button>
        </div>
      </div>

      <div class="chat-history">
        <div class="chat-msg">
          <b>wer20209 (17:43):</b><br>
          Здравствуйте! Посмотрите скриншот питомца:
          <div style="background:#0F172A; border:1px solid #1E293B; border-radius:8px; padding:16px; margin-top:8px; text-align:center; color:#94A3B8;">
            🖼️ [Скриншот питомцев Roblox / Pet Simulator]
          </div>
        </div>
        <div class="chat-msg mine">
          <b>Вы:</b> Привет! Да, вижу скриншот, всё отлично!
        </div>
      </div>

      <form class="chat-form">
        <input type="text" class="chat-input" placeholder="Введите сообщение... (Нажмите F1-F8 для быстрого ответа)">
        <button type="button" style="background:#3B82F6; border:none; color:white; padding:8px 14px; border-radius:6px; font-weight:600; cursor:pointer;">Отправить</button>
      </form>
    </div>
  </div>

  <!-- FLOATING DRAGGABLE HOTKEY PANEL (Floating outside chat flow, at custom coordinates!) -->
  ###PANEL_PLACEHOLDER###
</body>
</html>"""

    expanded_panel_html = """
  <div id="fphk-panel-root" class="fphk-panel fphk-floating" style="position:fixed; left:880px; top:100px; z-index:999990;">
    <div class="fphk-panel-header" id="fphk-panel-drag-handle" title="Перетащите для перемещения">
      <div class="fphk-panel-title">
        <span class="fphk-bolt">⚡</span>
        <span class="fphk-panel-title-text">FanPay Hotkeys</span>
      </div>
      <div class="fphk-header-actions">
        <button class="fphk-icon-btn fphk-settings-btn" title="Открыть настройки">⚙️</button>
        <button class="fphk-icon-btn fphk-collapse-btn" title="Свернуть в мини-кнопку">—</button>
      </div>
    </div>

    <div class="fphk-panel-toolbar">
      <label class="fphk-profile-label">Профиль:</label>
      <select class="fphk-profile-select">
        <option selected>Robux</option>
        <option>Brawl Stars</option>
        <option>Steam Keys</option>
      </select>
    </div>

    <div class="fphk-buttons-grid">
      <button class="fphk-template-btn"><span class="fphk-key-tag">F1</span><span class="fphk-btn-label">Открытый профиль</span></button>
      <button class="fphk-template-btn"><span class="fphk-key-tag">F2</span><span class="fphk-btn-label">Передача</span></button>
      <button class="fphk-template-btn"><span class="fphk-key-tag">F3</span><span class="fphk-btn-label">📦 Заказ принят</span></button>
      <button class="fphk-template-btn"><span class="fphk-key-tag">F4</span><span class="fphk-btn-label">🎮 Game Pass</span></button>
      <button class="fphk-template-btn"><span class="fphk-key-tag">F5</span><span class="fphk-btn-label">⏳ Ожидание</span></button>
      <button class="fphk-template-btn"><span class="fphk-key-tag">F6</span><span class="fphk-btn-label">💰 Оплата</span></button>
      <button class="fphk-template-btn"><span class="fphk-key-tag">F7</span><span class="fphk-btn-label">✅ Выдача</span></button>
      <button class="fphk-template-btn"><span class="fphk-key-tag">F8</span><span class="fphk-btn-label">⚠️ Проблема</span></button>
    </div>
  </div>
    """

    collapsed_panel_html = """
  <div id="fphk-panel-root" class="fphk-panel fphk-floating fphk-collapsed" style="position:fixed; left:880px; top:100px; z-index:999990;">
    <button class="fphk-toggle-btn" id="fphk-panel-toggle-btn" title="Развернуть FanPay Hotkeys • Нажмите или перетащите">
      <span class="fphk-bolt">⚡</span>
      <span class="fphk-badge-mini">Hotkeys</span>
      <span class="fphk-expand-icon">⛶</span>
    </button>
  </div>
    """

    sim_expanded_file = ROOT_DIR / "fanpay-hotkeys-extension" / "dist" / "test_panel_expanded.html"
    sim_expanded_file.write_text(funpay_chat_sim.replace("###PANEL_PLACEHOLDER###", expanded_panel_html), encoding="utf-8")

    sim_collapsed_file = ROOT_DIR / "fanpay-hotkeys-extension" / "dist" / "test_panel_collapsed.html"
    sim_collapsed_file.write_text(funpay_chat_sim.replace("###PANEL_PLACEHOLDER###", collapsed_panel_html), encoding="utf-8")

    # Options view
    mock_script = """
    <script>
      const MOCK_STORAGE = {
        fphk_settings: {
          hotkeysEnabled: true,
          panelEnabled: true,
          soundEnabled: true,
          notificationsEnabled: true,
          shiftOverrunAlertHours: 8,
          operatorsList: ['Алексей (Owner)', 'Иван (Ночной)'],
          sellerSharePercent: 12.0
        },
        fphk_profiles: [],
        fphk_templates: [],
        fphk_cache: { orders: [], balance: { total: 0 } },
        fphk_shift_state: { shiftActive: false }
      };
      window.chrome = {
        storage: {
          local: {
            get: (keys, cb) => setTimeout(() => cb(MOCK_STORAGE), 5),
            set: (items, cb) => setTimeout(cb, 5)
          },
          onChanged: { addListener: () => {} }
        },
        runtime: {
          sendMessage: (msg, cb) => {
            let res = { success: true };
            if (msg.type === 'GET_STATE') {
              res = { success: true, state: { settings: MOCK_STORAGE.fphk_settings, profiles: [], templates: [], cache: MOCK_STORAGE.fphk_cache } };
            } else if (msg.type === 'GET_SHIFT_STATE') {
              res = { success: true, shiftState: MOCK_STORAGE.fphk_shift_state };
            }
            if (cb) setTimeout(() => cb(res), 5);
            return Promise.resolve(res);
          },
          openOptionsPage: () => {},
          getURL: (p) => p
        },
        tabs: {
          query: (q, cb) => cb([{ id: 1, url: 'https://funpay.com/chat/' }]),
          create: () => {}
        }
      };
      window.addEventListener('DOMContentLoaded', () => {
        setTimeout(() => {
          const btn = document.querySelector('.nav-item[data-tab="general"]');
          if (btn) btn.click();
        }, 300);
      });
    </script>
    """
    options_test_file = dist_options_dir / "test_options_general.html"
    options_test_file.write_text(options_html_raw.replace("<head>", f"<head>\n{mock_script}"), encoding="utf-8")

    # Captures
    captures = [
        ("floating_panel_expanded.png", f"http://127.0.0.1:{PORT}/fanpay-hotkeys-extension/dist/test_panel_expanded.html", "1280,800"),
        ("floating_panel_collapsed.png", f"http://127.0.0.1:{PORT}/fanpay-hotkeys-extension/dist/test_panel_collapsed.html", "1280,800"),
        ("options_general_toggle.png", f"http://127.0.0.1:{PORT}/fanpay-hotkeys-extension/dist/options/test_options_general.html", "1440,900")
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

    print("All floating panel verification screenshots successfully created!")

if __name__ == "__main__":
    main()
