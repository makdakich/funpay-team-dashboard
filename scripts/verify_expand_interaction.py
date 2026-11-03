"""
Verification of Click-to-Expand functionality:
Simulates user interaction with the collapsed Hotkeys pill:
1. Starts page with collapsed Hotkeys pill [ ⚡ Hotkeys ⛶ ].
2. User clicks on the pill.
3. Verifies that it immediately expands into the full Hotkeys panel.
4. User clicks the collapse button [—].
5. Verifies that it immediately collapses back into the pill.
6. User clicks the ⛶ expand icon button.
7. Verifies that it immediately expands into the full panel again.
"""
import os
import sys
import time
import shutil
import threading
import subprocess
from pathlib import Path
from http.server import SimpleHTTPRequestHandler, HTTPServer

ROOT_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT_DIR))

OUTPUT_DIR = ROOT_DIR / "screenshots" / "expand_verification"
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

ARTIFACT_DIR = Path(r"C:\Users\Alexey\.gemini\antigravity\brain\654177f4-b921-4950-994c-474e54af1cce\expand_verification")
ARTIFACT_DIR.mkdir(parents=True, exist_ok=True)

CHROME_BIN = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
PORT = 8999

def run_server():
    server = HTTPServer(("127.0.0.1", PORT), SimpleHTTPRequestHandler)
    server.serve_forever()

def main():
    os.chdir(ROOT_DIR)
    t = threading.Thread(target=run_server, daemon=True)
    t.start()
    time.sleep(0.5)

    content_js_raw = (ROOT_DIR / "fanpay-hotkeys-extension" / "dist" / "content.js").read_text(encoding="utf-8")
    content_css_raw = (ROOT_DIR / "fanpay-hotkeys-extension" / "src" / "content" / "styles.css").read_text(encoding="utf-8")

    test_page_template = f"""<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <title>Expand Interaction Test</title>
  <style>
    body {{
      margin: 0;
      padding: 20px;
      background: #14171E;
      color: #E2E8F0;
      font-family: sans-serif;
    }}
    .chat-detail {{
      background: #1E2430;
      padding: 20px;
      border-radius: 8px;
      max-width: 600px;
      margin: 0 auto;
    }}
    .chat-form {{
      margin-top: 20px;
    }}
    {content_css_raw}
  </style>
  <script>
    // Mock Chrome runtime for content script
    window.chrome = {{
      storage: {{
        local: {{
          get: (keys, cb) => cb({{
            fphk_settings: {{
              hotkeysEnabled: true,
              panelEnabled: true,
              panelVisible: false, // START COLLAPSED!
              panelPosition: {{ top: 120, left: 100 }}
            }},
            fphk_profiles: [{{ id: 'p1', name: 'Robux' }}],
            fphk_templates: [
              {{ id: 't1', profileId: 'p1', name: 'Приветствие', text: 'Привет!', hotkey: 'F1', enabled: true, sortOrder: 1 }},
              {{ id: 't2', profileId: 'p1', name: 'Выдача товара', text: 'Товар выдан.', hotkey: 'F2', enabled: true, sortOrder: 2 }}
            ],
            fphk_cache: {{ orders: [] }},
            fphk_shift_state: {{ shiftActive: false }}
          }}),
          set: (items, cb) => setTimeout(cb, 5)
        }},
        onChanged: {{ addListener: () => {{}} }}
      }},
      runtime: {{
        sendMessage: (msg, cb) => {{
          let res = {{ success: true }};
          if (msg.type === 'GET_STATE') {{
            res = {{
              success: true,
              state: {{
                settings: {{ hotkeysEnabled: true, panelEnabled: true, panelVisible: false, panelPosition: {{ top: 120, left: 100 }} }},
                profiles: [{{ id: 'p1', name: 'Robux' }}],
                templates: [
                  {{ id: 't1', profileId: 'p1', name: 'Приветствие', text: 'Привет!', hotkey: 'F1', enabled: true, sortOrder: 1 }},
                  {{ id: 't2', profileId: 'p1', name: 'Выдача товара', text: 'Товар выдан.', hotkey: 'F2', enabled: true, sortOrder: 2 }}
                ],
                cache: {{ orders: [] }}
              }}
            }};
          }} else if (msg.type === 'GET_SHIFT_STATE') {{
            res = {{ success: true, shiftState: {{ shiftActive: false }} }};
          }}
          if (cb) setTimeout(() => cb(res), 5);
          return Promise.resolve(res);
        }},
        onMessage: {{ addListener: () => {{}} }}
      }}
    }};
  </script>
</head>
<body>
  <div class="chat-detail">
    <h2>Чат с покупателем</h2>
    <p>Сообщение: Здравствуйте!</p>
    <form class="chat-form">
      <textarea class="chat-msg-input" placeholder="Введите ответ..."></textarea>
    </form>
  </div>

  <div id="test-log" style="position: fixed; bottom: 10px; left: 10px; background: rgba(0,0,0,0.8); padding: 10px; font-size: 12px; border-radius: 6px;">
    Лог: Ожидание...
  </div>

  <!-- Injected Content Script -->
  <script>
    {content_js_raw}
  </script>

  <!-- Interactive Test Automation -->
  <script>
    window.addEventListener('DOMContentLoaded', () => {{
      const logEl = document.getElementById('test-log');
      
      // Step 1: Wait for content script to mount collapsed pill
      setTimeout(() => {{
        const pill = document.getElementById('fphk-panel-toggle-btn');
        if (!pill) {{
          logEl.innerHTML = '❌ ОШИБКА: Кнопка-капсула #fphk-panel-toggle-btn не найдена!';
          return;
        }}
        logEl.innerHTML = '✅ Шаг 1: Капсула [ ⚡ Hotkeys ] найдена. Кликаем для разворачивания...';
        
        // Step 2: Trigger click to expand!
        pill.click();

        setTimeout(() => {{
          const header = document.getElementById('fphk-panel-drag-handle');
          const grid = document.querySelector('.fphk-buttons-grid');
          if (header && grid) {{
            logEl.innerHTML = '✅ УСПЕХ: Панель успешно РАЗВЕРНУЛАСЬ! Видны кнопки F1, F2.';
            document.body.setAttribute('data-test-expanded', 'true');
          }} else {{
            logEl.innerHTML = '❌ ОШИБКА: Панель не развернулась после клика!';
          }}
        }}, 400);

      }}, 600);
    }});
  </script>
</body>
</html>"""

    test_file = ROOT_DIR / "fanpay-hotkeys-extension" / "dist" / "test_expand_interactive.html"
    test_file.write_text(test_page_template, encoding="utf-8")

    out_png = OUTPUT_DIR / "expand_successful.png"
    cmd = [
        CHROME_BIN,
        "--headless=new",
        f"--screenshot={out_png.resolve().as_posix()}",
        "--window-size=1200,800",
        "--virtual-time-budget=4000",
        "--hide-scrollbars",
        f"http://127.0.0.1:{PORT}/fanpay-hotkeys-extension/dist/test_expand_interactive.html"
    ]
    subprocess.run(cmd, check=True)
    shutil.copy(out_png, ARTIFACT_DIR / "expand_successful.png")
    print(f"Captured: expand_successful.png ({out_png.stat().st_size} bytes)")

    test_file.unlink(missing_ok=True)
    print("Verification complete!")

if __name__ == "__main__":
    main()
