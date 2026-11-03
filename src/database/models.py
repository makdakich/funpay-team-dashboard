"""Data models for profiles, hotkeys, and application settings."""

from dataclasses import dataclass, field, asdict
from typing import Optional

MODE_PASTE = "paste"
MODE_PASTE_ENTER = "paste_enter"
MODE_COPY_ONLY = "copy_only"

MODES = [MODE_PASTE, MODE_PASTE_ENTER, MODE_COPY_ONLY]


@dataclass
class Profile:
    id: Optional[int] = None
    name: str = ""
    is_default: bool = False
    switch_shortcut: str = ""
    created_at: str = ""

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict) -> "Profile":
        return cls(
            id=data.get("id"),
            name=data.get("name", ""),
            is_default=bool(data.get("is_default", False)),
            switch_shortcut=data.get("switch_shortcut", ""),
            created_at=data.get("created_at", ""),
        )


@dataclass
class HotkeyItem:
    profile_id: int
    shortcut: str
    title: str
    message: str
    id: Optional[int] = None
    mode: str = MODE_PASTE
    enabled: bool = True
    sort_order: int = 0

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict) -> "HotkeyItem":
        return cls(
            id=data.get("id"),
            profile_id=data.get("profile_id", 0),
            shortcut=data.get("shortcut", ""),
            title=data.get("title", ""),
            message=data.get("message", ""),
            mode=data.get("mode", MODE_PASTE),
            enabled=bool(data.get("enabled", True)),
            sort_order=data.get("sort_order", 0),
        )


@dataclass
class Setting:
    key: str
    value: str


@dataclass
class VariablePreset:
    var_name: str
    value: str
    last_used: str = ""


@dataclass
class Shift:
    start_time: str
    id: Optional[int] = None
    end_time: Optional[str] = None
    duration_seconds: int = 0
    messages_count: int = 0
    profile_name: str = ""
    created_at: str = ""

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict) -> "Shift":
        return cls(
            id=data.get("id"),
            start_time=data.get("start_time", ""),
            end_time=data.get("end_time"),
            duration_seconds=data.get("duration_seconds", 0),
            messages_count=data.get("messages_count", 0),
            profile_name=data.get("profile_name", ""),
            created_at=data.get("created_at", ""),
        )


@dataclass
class UsageLogEntry:
    id: Optional[int] = None
    timestamp: str = ""
    shortcut: str = ""
    profile_name: str = ""
    title: str = ""
    preview: str = ""

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict) -> "UsageLogEntry":
        return cls(
            id=data.get("id"),
            timestamp=data.get("timestamp", ""),
            shortcut=data.get("shortcut", ""),
            profile_name=data.get("profile_name", ""),
            title=data.get("title", ""),
            preview=data.get("preview", ""),
        )

