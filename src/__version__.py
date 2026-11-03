"""Unified Version specification for FanPay Hotkeys & Assistant."""

import os
import json

__version__ = "2.1.0"
__app_name__ = "FanPay Hotkeys & Assistant"

# Try loading from root version.json if available
try:
    _root_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
    _version_path = os.path.join(_root_dir, "version.json")
    if os.path.exists(_version_path):
        with open(_version_path, "r", encoding="utf-8") as _f:
            _data = json.load(_f)
            __version__ = _data.get("version", __version__)
            __app_name__ = _data.get("name", __app_name__)
except Exception:
    pass
