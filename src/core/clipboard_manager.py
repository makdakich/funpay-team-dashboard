"""Clipboard manager: safe serialized paste emulation with user clipboard preservation and retry support."""

import time
import queue
import threading
import pyperclip
from typing import Optional
from ..database.models import MODE_PASTE, MODE_PASTE_ENTER, MODE_COPY_ONLY
from ..utils.win32_utils import send_paste, send_enter


class ClipboardManager:
    def __init__(self):
        self._action_queue = queue.Queue()
        self._stop_event = threading.Event()
        self._lock = threading.Lock()
        self._worker_thread = threading.Thread(target=self._process_queue, daemon=True)
        self._worker_thread.start()

    @staticmethod
    def get_clipboard(retries: int = 3, delay: float = 0.025) -> Optional[str]:
        """Safely get text from clipboard with retry for Windows clipboard locks."""
        for attempt in range(retries):
            try:
                return pyperclip.paste()
            except Exception:
                if attempt < retries - 1:
                    time.sleep(delay)
        return None

    @staticmethod
    def set_clipboard(text: str, retries: int = 3, delay: float = 0.025) -> bool:
        """Safely copy text to clipboard with retry for Windows clipboard locks."""
        for attempt in range(retries):
            try:
                pyperclip.copy(text)
                return True
            except Exception:
                if attempt < retries - 1:
                    time.sleep(delay)
        return False

    def execute_hotkey_action(self, text: str, mode: str = MODE_PASTE) -> None:
        """
        Execute hotkey action safely.
        MODE_COPY_ONLY is applied immediately.
        MODE_PASTE and MODE_PASTE_ENTER are queued and executed sequentially
        to strictly prevent race conditions and clipboard corruption.
        """
        if mode == MODE_COPY_ONLY:
            self.set_clipboard(text)
            return

        self._action_queue.put((text, mode))

    def _process_queue(self) -> None:
        """Serial worker processing paste actions one at a time."""
        while not self._stop_event.is_set():
            try:
                item = self._action_queue.get(timeout=0.2)
            except queue.Empty:
                continue

            text, mode = item
            try:
                with self._lock:
                    original_clipboard = self.get_clipboard()
                    self.set_clipboard(text)
                    time.sleep(0.025)  # Give target window clipboard time to register

                    send_paste()

                    if mode == MODE_PASTE_ENTER:
                        time.sleep(0.04)
                        send_enter()

                    # Wait for target application to finish reading clipboard before restoration
                    time.sleep(0.12)
                    if original_clipboard is not None:
                        self.set_clipboard(original_clipboard)
            except Exception:
                pass
            finally:
                self._action_queue.task_done()

    def wait_for_idle(self, timeout: float = 1.0) -> None:
        """Wait until all queued paste operations are finished."""
        deadline = time.time() + timeout
        while not self._action_queue.empty() and time.time() < deadline:
            time.sleep(0.05)
