"""SQLite Database operations and repository methods."""

import os
import glob
import shutil
import datetime
import sqlite3
from typing import Optional, List
from .models import Profile, HotkeyItem, Setting, Shift, UsageLogEntry, MODE_PASTE


def get_default_db_path() -> str:
    """Get the standard database file path in %APPDATA% with seamless backward compatibility."""
    appdata = os.environ.get("APPDATA")
    if appdata:
        modern_dir = os.path.join(appdata, "FunPayHotkeys")
        modern_db = os.path.join(modern_dir, "funpay_hotkeys.db")
        if os.path.exists(modern_db):
            return modern_db

        legacy_dir = os.path.join(appdata, "FanPayHotkeys")
        legacy_db = os.path.join(legacy_dir, "fanpay_hotkeys.db")
        if os.path.exists(legacy_db):
            return legacy_db

        target_dir = modern_dir
        db_filename = "funpay_hotkeys.db"
    else:
        target_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "data"))
        db_filename = "funpay_hotkeys.db"

    try:
        os.makedirs(target_dir, exist_ok=True)
        return os.path.join(target_dir, db_filename)
    except Exception:
        fallback_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "data"))
        os.makedirs(fallback_dir, exist_ok=True)
        return os.path.join(fallback_dir, db_filename)


class Database:
    def __init__(self, db_path: Optional[str] = None):
        self.db_path = db_path or get_default_db_path()
        self.init_db()

    def get_connection(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path, timeout=10.0)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        conn.execute("PRAGMA journal_mode = WAL")
        conn.execute("PRAGMA synchronous = NORMAL")
        return conn

    def init_db(self) -> None:
        """Create tables if they do not exist and seed initial data."""
        with self.get_connection() as conn:
            cursor = conn.cursor()

            # Profiles table
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS profiles (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT NOT NULL UNIQUE,
                    is_default BOOLEAN DEFAULT 0,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            """)

            # Hotkeys table
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS hotkeys (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
                    shortcut TEXT NOT NULL,
                    title TEXT NOT NULL,
                    message TEXT NOT NULL,
                    mode TEXT NOT NULL DEFAULT 'paste',
                    enabled BOOLEAN DEFAULT 1,
                    sort_order INTEGER DEFAULT 0
                )
            """)

            # Settings table
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS settings (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                )
            """)

            # Variable history / quick values table
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS variable_history (
                    var_name TEXT NOT NULL,
                    value TEXT NOT NULL,
                    last_used TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    PRIMARY KEY (var_name, value)
                )
            """)

            # Work Shifts table
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS shifts (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    start_time TEXT NOT NULL,
                    end_time TEXT,
                    duration_seconds INTEGER DEFAULT 0,
                    messages_count INTEGER DEFAULT 0,
                    profile_name TEXT,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            """)

            # Usage History table (Audit log)
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS usage_history (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    timestamp TEXT NOT NULL,
                    shortcut TEXT NOT NULL,
                    profile_name TEXT NOT NULL,
                    title TEXT NOT NULL,
                    preview TEXT NOT NULL
                )
            """)

            # Migration: Ensure switch_shortcut exists in profiles
            cursor.execute("PRAGMA table_info(profiles)")
            columns = [row["name"] for row in cursor.fetchall()]
            if "switch_shortcut" not in columns:
                cursor.execute("ALTER TABLE profiles ADD COLUMN switch_shortcut TEXT DEFAULT ''")

            conn.commit()

            # Seed if profiles table is empty
            cursor.execute("SELECT COUNT(*) FROM profiles")
            if cursor.fetchone()[0] == 0:
                self._seed_default_data(conn)

        # Trigger safe auto-backup on app initialization
        self.auto_backup_on_startup()

    def _seed_default_data(self, conn: sqlite3.Connection) -> None:
        """Seed initial profiles, hotkeys (F1-F8 in Robux), settings, and quick values."""
        cursor = conn.cursor()

        # Seed profiles
        profiles_to_seed = [
            ("🎮 Robux", 1),
            ("⛏ Minecraft", 0),
            ("🎮 Steam", 0),
            ("🧪 Тест", 0),
        ]
        created_profile_ids = []
        for name, is_def in profiles_to_seed:
            cursor.execute(
                "INSERT INTO profiles (name, is_default) VALUES (?, ?)",
                (name, is_def),
            )
            created_profile_ids.append(cursor.lastrowid)

        robux_profile_id = created_profile_ids[0]

        # Initial F1-F8 templates for Robux profile (as requested in spec and instruction #7)
        # Note: These are simply initial database records, user can freely edit/delete them via UI.
        initial_hotkeys = [
            ("F1", "👋 Приветствие", "Здравствуйте! Рад приветствовать вас. Чем могу помочь по заказу?", MODE_PASTE, 1),
            ("F2", "📋 Правила", "Пожалуйста, ознакомьтесь с правилами сделки и не подтверждайте заказ до фактического получения.", MODE_PASTE, 2),
            ("F3", "📦 Заказ принят", "Заказ принят в обработку! Начинаю выполнение, пожалуйста подождите пару минут.", MODE_PASTE, 3),
            ("F4", "🎮 Game Pass", "Пожалуйста, создайте Game Pass на указанную сумму и отправьте мне ссылку.", MODE_PASTE, 4),
            ("F5", "⏳ Ожидание", "Пожалуйста, ожидайте, процесс занимает несколько минут из-за нагрузки.", MODE_PASTE, 5),
            ("F6", "💰 Оплата", "Оплата успешно поступила. Приступаю к отправке.", MODE_PASTE, 6),
            ("F7", "✅ Выдача", "Товар успешно передан! Пожалуйста, проверьте получение и подтвердите заказ на сайте.", MODE_PASTE, 7),
            ("F8", "⚠️ Проблема", "Возникла небольшая задержка со стороны сервера. Не переживайте, ваш заказ в приоритете.", MODE_PASTE, 8),
        ]

        for shortcut, title, msg, mode, order in initial_hotkeys:
            cursor.execute(
                """
                INSERT INTO hotkeys (profile_id, shortcut, title, message, mode, enabled, sort_order)
                VALUES (?, ?, ?, ?, ?, 1, ?)
                """,
                (robux_profile_id, shortcut, title, msg, mode, order),
            )

        # Default settings
        default_settings = [
            ("active_profile_id", str(robux_profile_id)),
            ("hotkeys_enabled", "1"),
            ("minimize_to_tray", "1"),
            ("autostart", "0"),
            ("app_filter_mode", "global"),
            ("app_whitelist", "chrome.exe,msedge.exe,firefox.exe,opera.exe,brave.exe,yandex.exe"),
            ("quick_menu_hotkey", "Ctrl+Space"),
            ("theme_accent", "emerald"),
        ]

        for key, val in default_settings:
            cursor.execute("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", (key, val))

        # Initial variable quick values for robux
        initial_robux_values = ["1000", "2500", "5000", "10000", "25000"]
        for val in initial_robux_values:
            cursor.execute(
                "INSERT OR IGNORE INTO variable_history (var_name, value) VALUES ('robux', ?)",
                (val,),
            )

        conn.commit()

    # --- Profile operations ---

    def get_profiles(self) -> List[Profile]:
        with self.get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT id, name, is_default, switch_shortcut, created_at FROM profiles ORDER BY id ASC")
            return [
                Profile(
                    id=row["id"],
                    name=row["name"],
                    is_default=bool(row["is_default"]),
                    switch_shortcut=row["switch_shortcut"] if "switch_shortcut" in row.keys() and row["switch_shortcut"] else "",
                    created_at=row["created_at"],
                )
                for row in cursor.fetchall()
            ]

    def get_profile_by_id(self, profile_id: int) -> Optional[Profile]:
        with self.get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT id, name, is_default, switch_shortcut, created_at FROM profiles WHERE id = ?", (profile_id,))
            row = cursor.fetchone()
            if row:
                return Profile(
                    id=row["id"],
                    name=row["name"],
                    is_default=bool(row["is_default"]),
                    switch_shortcut=row["switch_shortcut"] if "switch_shortcut" in row.keys() and row["switch_shortcut"] else "",
                    created_at=row["created_at"],
                )
            return None

    def update_profile_switch_shortcut(self, profile_id: int, shortcut: str) -> bool:
        with self.get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("UPDATE profiles SET switch_shortcut = ? WHERE id = ?", (shortcut.strip(), profile_id))
            conn.commit()
            return cursor.rowcount > 0

    def duplicate_profile(self, profile_id: int) -> Optional[int]:
        """Duplicate a profile with all its hotkeys, ensuring unique name."""
        source = self.get_profile_by_id(profile_id)
        if not source:
            return None

        base_name = source.name
        copy_name = f"{base_name} (Копия)"
        counter = 2
        with self.get_connection() as conn:
            cursor = conn.cursor()
            while True:
                cursor.execute("SELECT id FROM profiles WHERE name = ?", (copy_name,))
                if not cursor.fetchone():
                    break
                copy_name = f"{base_name} (Копия {counter})"
                counter += 1

            cursor.execute(
                "INSERT INTO profiles (name, is_default, switch_shortcut) VALUES (?, 0, '')",
                (copy_name,),
            )
            new_profile_id = cursor.lastrowid

            cursor.execute(
                """
                SELECT shortcut, title, message, mode, enabled, sort_order
                FROM hotkeys WHERE profile_id = ?
                ORDER BY sort_order ASC, id ASC
                """,
                (profile_id,),
            )
            for row in cursor.fetchall():
                cursor.execute(
                    """
                    INSERT INTO hotkeys (profile_id, shortcut, title, message, mode, enabled, sort_order)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        new_profile_id,
                        row["shortcut"],
                        row["title"],
                        row["message"],
                        row["mode"],
                        row["enabled"],
                        row["sort_order"],
                    ),
                )
            conn.commit()
            return new_profile_id

    def create_profile(self, name: str) -> int:
        with self.get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("INSERT INTO profiles (name, is_default) VALUES (?, 0)", (name,))
            conn.commit()
            return cursor.lastrowid

    def update_profile(self, profile_id: int, name: str) -> bool:
        with self.get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("UPDATE profiles SET name = ? WHERE id = ?", (name, profile_id))
            conn.commit()
            return cursor.rowcount > 0

    def delete_profile(self, profile_id: int) -> bool:
        with self.get_connection() as conn:
            cursor = conn.cursor()
            # Prevent deleting if it's the last profile
            cursor.execute("SELECT COUNT(*) FROM profiles")
            if cursor.fetchone()[0] <= 1:
                return False

            cursor.execute("DELETE FROM profiles WHERE id = ?", (profile_id,))
            conn.commit()
            return cursor.rowcount > 0

    # --- Hotkey operations ---

    def get_hotkeys_by_profile(self, profile_id: int) -> List[HotkeyItem]:
        with self.get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                """
                SELECT id, profile_id, shortcut, title, message, mode, enabled, sort_order
                FROM hotkeys
                WHERE profile_id = ?
                ORDER BY sort_order ASC, id ASC
                """,
                (profile_id,),
            )
            return [
                HotkeyItem(
                    id=row["id"],
                    profile_id=row["profile_id"],
                    shortcut=row["shortcut"],
                    title=row["title"],
                    message=row["message"],
                    mode=row["mode"],
                    enabled=bool(row["enabled"]),
                    sort_order=row["sort_order"],
                )
                for row in cursor.fetchall()
            ]

    def get_hotkey_by_id(self, hotkey_id: int) -> Optional[HotkeyItem]:
        with self.get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                """
                SELECT id, profile_id, shortcut, title, message, mode, enabled, sort_order
                FROM hotkeys
                WHERE id = ?
                """,
                (hotkey_id,),
            )
            row = cursor.fetchone()
            if row:
                return HotkeyItem(
                    id=row["id"],
                    profile_id=row["profile_id"],
                    shortcut=row["shortcut"],
                    title=row["title"],
                    message=row["message"],
                    mode=row["mode"],
                    enabled=bool(row["enabled"]),
                    sort_order=row["sort_order"],
                )
            return None

    def save_hotkey(self, item: HotkeyItem) -> int:
        with self.get_connection() as conn:
            cursor = conn.cursor()
            if item.id:
                cursor.execute(
                    """
                    UPDATE hotkeys
                    SET profile_id = ?, shortcut = ?, title = ?, message = ?, mode = ?, enabled = ?, sort_order = ?
                    WHERE id = ?
                    """,
                    (
                        item.profile_id,
                        item.shortcut,
                        item.title,
                        item.message,
                        item.mode,
                        1 if item.enabled else 0,
                        item.sort_order,
                        item.id,
                    ),
                )
                conn.commit()
                return item.id
            else:
                cursor.execute(
                    """
                    INSERT INTO hotkeys (profile_id, shortcut, title, message, mode, enabled, sort_order)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        item.profile_id,
                        item.shortcut,
                        item.title,
                        item.message,
                        item.mode,
                        1 if item.enabled else 0,
                        item.sort_order,
                    ),
                )
                conn.commit()
                return cursor.lastrowid

    def delete_hotkey(self, hotkey_id: int) -> bool:
        with self.get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("DELETE FROM hotkeys WHERE id = ?", (hotkey_id,))
            conn.commit()
            return cursor.rowcount > 0

    def duplicate_hotkey(self, hotkey_id: int) -> Optional[int]:
        """Duplicate a hotkey within the same profile with cleared shortcut to prevent conflicts."""
        source = self.get_hotkey_by_id(hotkey_id)
        if not source:
            return None

        with self.get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT MAX(sort_order) FROM hotkeys WHERE profile_id = ?", (source.profile_id,))
            row = cursor.fetchone()
            max_order = row[0] if (row and row[0] is not None) else 0

            copy_title = f"{source.title} (Копия)"
            cursor.execute(
                """
                INSERT INTO hotkeys (profile_id, shortcut, title, message, mode, enabled, sort_order)
                VALUES (?, '', ?, ?, ?, ?, ?)
                """,
                (
                    source.profile_id,
                    copy_title,
                    source.message,
                    source.mode,
                    1 if source.enabled else 0,
                    max_order + 1,
                ),
            )
            conn.commit()
            return cursor.lastrowid

    def update_hotkeys_order(self, profile_id: int, ordered_ids: List[int]) -> bool:
        """Update sort_order for hotkeys in given order."""
        with self.get_connection() as conn:
            cursor = conn.cursor()
            for idx, hid in enumerate(ordered_ids, start=1):
                cursor.execute(
                    "UPDATE hotkeys SET sort_order = ? WHERE id = ? AND profile_id = ?",
                    (idx, hid, profile_id),
                )
            conn.commit()
            return True

    # --- Settings operations ---

    def get_setting(self, key: str, default: str = "") -> str:
        with self.get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT value FROM settings WHERE key = ?", (key,))
            row = cursor.fetchone()
            return row["value"] if row else default

    def set_setting(self, key: str, value: str) -> None:
        with self.get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", (key, str(value)))
            conn.commit()

    # --- Variable History & Presets ---

    def add_variable_value(self, var_name: str, value: str) -> None:
        import datetime
        now_str = datetime.datetime.now().isoformat()
        with self.get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                """
                INSERT INTO variable_history (var_name, value, last_used)
                VALUES (?, ?, ?)
                ON CONFLICT(var_name, value) DO UPDATE SET last_used = ?
                """,
                (var_name.lower().strip(), value.strip(), now_str, now_str),
            )
            conn.commit()

    def get_variable_recent_values(self, var_name: str, limit: int = 5) -> List[str]:
        with self.get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                """
                SELECT value FROM variable_history
                WHERE var_name = ?
                ORDER BY last_used DESC
                LIMIT ?
                """,
                (var_name.lower().strip(), limit),
            )
            return [row["value"] for row in cursor.fetchall()]

    # --- Work Shift Operations ---

    def add_shift(self, shift: Shift) -> int:
        with self.get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                """
                INSERT INTO shifts (start_time, end_time, duration_seconds, messages_count, profile_name)
                VALUES (?, ?, ?, ?, ?)
                """,
                (
                    shift.start_time,
                    shift.end_time,
                    shift.duration_seconds,
                    shift.messages_count,
                    shift.profile_name,
                ),
            )
            conn.commit()
            return cursor.lastrowid

    def get_shifts(self, limit: int = 50) -> List[Shift]:
        with self.get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                """
                SELECT id, start_time, end_time, duration_seconds, messages_count, profile_name, created_at
                FROM shifts
                ORDER BY id DESC
                LIMIT ?
                """,
                (limit,),
            )
            rows = cursor.fetchall()
            return [Shift.from_dict(dict(r)) for r in rows]

    def get_today_shift_stats(self) -> dict:
        import datetime
        today_date = datetime.date.today().isoformat()
        with self.get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                """
                SELECT
                    COUNT(*) as shift_count,
                    COALESCE(SUM(duration_seconds), 0) as total_duration,
                    COALESCE(SUM(messages_count), 0) as total_messages
                FROM shifts
                WHERE start_time LIKE ?
                """,
                (f"{today_date}%",),
            )
            row = cursor.fetchone()
            return {
                "shift_count": row["shift_count"] if row else 0,
                "total_duration": row["total_duration"] if row else 0,
                "total_messages": row["total_messages"] if row else 0,
            }

    def get_period_shift_stats(self, days: int = 7) -> dict:
        """Get aggregated shift stats for the last N days."""
        import datetime
        start_date = (datetime.date.today() - datetime.timedelta(days=days - 1)).isoformat()
        with self.get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                """
                SELECT
                    COUNT(*) as shift_count,
                    COALESCE(SUM(duration_seconds), 0) as total_duration,
                    COALESCE(SUM(messages_count), 0) as total_messages
                FROM shifts
                WHERE start_time >= ?
                """,
                (f"{start_date} 00:00:00",),
            )
            row = cursor.fetchone()
            dur = row["total_duration"] if row else 0
            msgs = row["total_messages"] if row else 0
            cnt = row["shift_count"] if row else 0
            mph = round((msgs / (dur / 3600.0)), 1) if dur >= 60 else 0.0
            return {
                "shift_count": cnt,
                "total_duration": dur,
                "total_messages": msgs,
                "messages_per_hour": mph,
            }

    def get_daily_activity_last_7_days(self) -> List[dict]:
        """Returns list of last 7 days with date, messages_count, and duration_seconds."""
        import datetime
        today = datetime.date.today()
        days_map = {}
        for i in range(6, -1, -1):
            d = (today - datetime.timedelta(days=i)).isoformat()
            days_map[d] = {"date": d, "messages": 0, "duration": 0}

        with self.get_connection() as conn:
            cursor = conn.cursor()
            start_str = (today - datetime.timedelta(days=6)).isoformat()
            cursor.execute(
                """
                SELECT SUBSTR(start_time, 1, 10) as day,
                       SUM(messages_count) as msgs,
                       SUM(duration_seconds) as dur
                FROM shifts
                WHERE start_time >= ?
                GROUP BY day
                """,
                (f"{start_str} 00:00:00",),
            )
            for r in cursor.fetchall():
                day = r["day"]
                if day in days_map:
                    days_map[day]["messages"] = r["msgs"] or 0
                    days_map[day]["duration"] = r["dur"] or 0

        return list(days_map.values())

    # --- Backup & Restore ---

    def get_backup_dir(self) -> str:
        db_dir = os.path.dirname(self.db_path)
        b_dir = os.path.join(db_dir, "backups")
        os.makedirs(b_dir, exist_ok=True)
        return b_dir

    def create_backup(self, tag: str = "auto", max_generations: int = 7) -> str:
        """
        Create a consistent online backup using SQLite's backup API.
        Enforces generation rotation (keeps up to max_generations).
        """
        import datetime
        b_dir = self.get_backup_dir()
        ts = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
        backup_filename = f"backup_{ts}_{tag}.db"
        backup_filepath = os.path.join(b_dir, backup_filename)

        with self.get_connection() as src_conn:
            dest_conn = sqlite3.connect(backup_filepath)
            with dest_conn:
                src_conn.backup(dest_conn)
            dest_conn.close()

        self._rotate_backups(max_generations)
        return backup_filepath

    def _rotate_backups(self, max_generations: int = 7) -> None:
        b_dir = self.get_backup_dir()
        files = glob.glob(os.path.join(b_dir, "backup_*.db"))
        files.sort(key=os.path.getmtime, reverse=True)
        for old_file in files[max_generations:]:
            try:
                os.remove(old_file)
            except Exception:
                pass

    def list_backups(self) -> List[dict]:
        import datetime
        b_dir = self.get_backup_dir()
        files = glob.glob(os.path.join(b_dir, "backup_*.db"))
        files.sort(key=os.path.getmtime, reverse=True)
        results = []
        for f in files:
            stat = os.stat(f)
            created_dt = datetime.datetime.fromtimestamp(stat.st_mtime).strftime("%Y-%m-%d %H:%M:%S")
            results.append({
                "path": f,
                "filename": os.path.basename(f),
                "created_at": created_dt,
                "size_kb": round(stat.st_size / 1024, 1),
            })
        return results

    def restore_backup(self, backup_filepath: str) -> bool:
        """Restore database from backup file safely using SQLite backup API."""
        if not os.path.exists(backup_filepath):
            return False

        try:
            self.create_backup(tag="pre_restore")
        except Exception:
            pass

        with sqlite3.connect(backup_filepath) as src_conn:
            with self.get_connection() as dest_conn:
                src_conn.backup(dest_conn)
        return True

    def auto_backup_on_startup(self) -> None:
        """Create auto-backup on app start if none exists for today."""
        import datetime
        try:
            today_prefix = datetime.datetime.now().strftime("%Y%m%d")
            b_dir = self.get_backup_dir()
            pattern = os.path.join(b_dir, f"backup_{today_prefix}_*.db")
            if not glob.glob(pattern):
                self.create_backup(tag="auto")
        except Exception:
            pass

    # --- Usage History / Audit Log ---

    def log_hotkey_usage(self, shortcut: str, profile_name: str, title: str, preview: str) -> None:
        if self.get_setting("log_usage_history", "1") != "1":
            return
        import datetime
        now_str = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        with self.get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                """
                INSERT INTO usage_history (timestamp, shortcut, profile_name, title, preview)
                VALUES (?, ?, ?, ?, ?)
                """,
                (now_str, shortcut, profile_name, title, preview[:120]),
            )
            conn.commit()

    def get_usage_history(self, limit: int = 100) -> List[UsageLogEntry]:
        with self.get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                """
                SELECT id, timestamp, shortcut, profile_name, title, preview
                FROM usage_history
                ORDER BY id DESC
                LIMIT ?
                """,
                (limit,),
            )
            return [
                UsageLogEntry(
                    id=row["id"],
                    timestamp=row["timestamp"],
                    shortcut=row["shortcut"],
                    profile_name=row["profile_name"],
                    title=row["title"],
                    preview=row["preview"],
                )
                for row in cursor.fetchall()
            ]

    def clear_usage_history(self) -> None:
        with self.get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("DELETE FROM usage_history")
            conn.commit()
            conn.commit()

