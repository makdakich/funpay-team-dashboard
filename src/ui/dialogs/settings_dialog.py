"""Settings dialog: Structured tabbed preferences dialog."""

import os
from datetime import datetime
from PySide6.QtWidgets import (
    QDialog,
    QVBoxLayout,
    QHBoxLayout,
    QLabel,
    QCheckBox,
    QRadioButton,
    QButtonGroup,
    QPlainTextEdit,
    QPushButton,
    QFileDialog,
    QMessageBox,
    QFrame,
    QWidget,
    QGridLayout,
    QTabWidget,
    QSpinBox,
    QTableWidget,
    QTableWidgetItem,
    QHeaderView,
)
from PySide6.QtCore import Signal, Qt
from ...__version__ import __version__, __app_name__
from ...core.settings_manager import SettingsManager
from ...core.profile_manager import ProfileManager
from ..components.key_recorder import KeyRecorderDialog


class SettingsDialog(QDialog):
    profile_imported = Signal()
    theme_changed = Signal(str)
    quick_menu_hotkey_changed = Signal(str)
    hotkeys_configuration_changed = Signal()

    def __init__(self, settings_mgr: SettingsManager, profile_mgr: ProfileManager, parent=None):
        super().__init__(parent)
        self.setWindowTitle(f"Настройки — {__app_name__} v{__version__}")
        self.setFixedSize(580, 530)
        self.setModal(True)

        self.settings_mgr = settings_mgr
        self.profile_mgr = profile_mgr
        self._current_qm_hotkey = "Ctrl+Space"
        self._profile_shortcuts_map = {}  # profile_id -> shortcut_str

        self._init_ui()
        self._load_values()

    def _init_ui(self):
        root_layout = QVBoxLayout(self)
        root_layout.setContentsMargins(14, 14, 14, 12)
        root_layout.setSpacing(12)

        self.tabs = QTabWidget()
        self.tabs.setStyleSheet("""
            QTabWidget::pane {
                border: 1px solid #27272a;
                border-radius: 8px;
                background-color: #18181b;
                padding: 10px;
            }
            QTabBar::tab {
                background-color: #202024;
                color: #a1a1aa;
                padding: 8px 14px;
                margin-right: 4px;
                border-top-left-radius: 6px;
                border-top-right-radius: 6px;
                font-weight: 500;
            }
            QTabBar::tab:selected {
                background-color: #18181b;
                color: #ffffff;
                font-weight: 600;
                border-top: 2px solid #10b981;
            }
        """)

        # 1. General Tab
        self.tabs.addTab(self._create_general_tab(), "⚙️ Общие")
        # 2. Hotkeys & Profiles Tab
        self.tabs.addTab(self._create_hotkeys_tab(), "⌨️ Хоткеи")
        # 3. Appearance Tab
        self.tabs.addTab(self._create_appearance_tab(), "🎨 Оформление")
        # 4. Clipboard Tab
        self.tabs.addTab(self._create_clipboard_tab(), "📋 Буфер")
        # 5. History & Shift Tab
        self.tabs.addTab(self._create_history_tab(), "⏱ История")
        # 6. Notifications Tab
        self.tabs.addTab(self._create_notifications_tab(), "🔔 Оповещения")
        # 7. Backup & Data Tab
        self.tabs.addTab(self._create_backup_tab(), "💾 Резервные копии")

        root_layout.addWidget(self.tabs)

        # Bottom Buttons
        btn_bar = QHBoxLayout()
        btn_bar.setContentsMargins(0, 0, 0, 0)
        btn_bar.setSpacing(10)

        cancel_btn = QPushButton("Отмена")
        cancel_btn.clicked.connect(self.reject)
        btn_bar.addWidget(cancel_btn)

        btn_bar.addStretch()

        save_btn = QPushButton("Сохранить настройки")
        save_btn.setObjectName("PrimaryButton")
        save_btn.clicked.connect(self._save_settings)
        btn_bar.addWidget(save_btn)

        root_layout.addLayout(btn_bar)

    def _create_general_tab(self) -> QWidget:
        tab = QWidget()
        layout = QVBoxLayout(tab)
        layout.setContentsMargins(10, 10, 10, 10)
        layout.setSpacing(14)

        self.tray_cb = QCheckBox("Сворачивать в трей при закрытии главного окна")
        layout.addWidget(self.tray_cb)

        self.autostart_cb = QCheckBox("Запускать FunPay Hotkeys вместе с Windows")
        layout.addWidget(self.autostart_cb)

        # App filtering
        sec_title = QLabel("Ограничение приложений")
        sec_title.setStyleSheet("font-weight: bold; font-size: 13px; color: #a1a1aa; margin-top: 8px;")
        layout.addWidget(sec_title)

        self.filter_group = QButtonGroup(self)
        self.filter_global_rb = QRadioButton("Работать во всех приложениях (рекомендуется)")
        self.filter_whitelist_rb = QRadioButton("Работать только в выбранных приложениях:")
        self.filter_group.addButton(self.filter_global_rb)
        self.filter_group.addButton(self.filter_whitelist_rb)

        layout.addWidget(self.filter_global_rb)
        layout.addWidget(self.filter_whitelist_rb)

        self.whitelist_edit = QPlainTextEdit()
        self.whitelist_edit.setPlaceholderText("chrome.exe, msedge.exe, firefox.exe, opera.exe, brave.exe")
        self.whitelist_edit.setFixedHeight(60)
        layout.addWidget(self.whitelist_edit)

        self.filter_global_rb.toggled.connect(
            lambda checked: self.whitelist_edit.setEnabled(not checked)
        )

        layout.addStretch()
        return tab

    def _create_hotkeys_tab(self) -> QWidget:
        tab = QWidget()
        layout = QVBoxLayout(tab)
        layout.setContentsMargins(10, 10, 10, 10)
        layout.setSpacing(12)

        # Quick Menu Hotkey row
        qm_title = QLabel("Быстрое меню (Quick Menu):")
        qm_title.setStyleSheet("font-weight: bold; font-size: 13px; color: #a1a1aa;")
        layout.addWidget(qm_title)

        qm_row = QHBoxLayout()
        qm_row.setSpacing(10)
        qm_lbl = QLabel("Хоткей вызова меню:")
        qm_lbl.setStyleSheet("color: #e4e4e7;")
        qm_row.addWidget(qm_lbl)

        self.qm_badge = QLabel("Ctrl+Space")
        self.qm_badge.setObjectName("ActiveShortcutBadge")
        self.qm_badge.setMinimumWidth(85)
        self.qm_badge.setAlignment(Qt.AlignCenter)
        qm_row.addWidget(self.qm_badge)

        self.change_qm_btn = QPushButton("Изменить комбинацию...")
        self.change_qm_btn.clicked.connect(self._record_quick_menu_shortcut)
        qm_row.addWidget(self.change_qm_btn)
        qm_row.addStretch()
        layout.addLayout(qm_row)

        # Profile Switch Shortcuts
        prof_title = QLabel("Быстрое переключение профилей (Горячие клавиши):")
        prof_title.setStyleSheet("font-weight: bold; font-size: 13px; color: #a1a1aa; margin-top: 10px;")
        layout.addWidget(prof_title)

        self.profiles_table = QTableWidget()
        self.profiles_table.setColumnCount(3)
        self.profiles_table.setHorizontalHeaderLabels(["Профиль", "Хоткей переключения", "Действие"])
        self.profiles_table.horizontalHeader().setSectionResizeMode(0, QHeaderView.Stretch)
        self.profiles_table.horizontalHeader().setSectionResizeMode(1, QHeaderView.ResizeToContents)
        self.profiles_table.horizontalHeader().setSectionResizeMode(2, QHeaderView.ResizeToContents)
        self.profiles_table.verticalHeader().setVisible(False)
        self.profiles_table.setSelectionMode(QTableWidget.NoSelection)
        self.profiles_table.setStyleSheet("""
            QTableWidget {
                background-color: #202024;
                border: 1px solid #27272a;
                border-radius: 6px;
            }
        """)
        layout.addWidget(self.profiles_table)

        layout.addStretch()
        return tab

    def _create_appearance_tab(self) -> QWidget:
        tab = QWidget()
        layout = QVBoxLayout(tab)
        layout.setContentsMargins(10, 10, 10, 10)
        layout.setSpacing(14)

        sec_title = QLabel("Цветовой акцент интерфейса:")
        sec_title.setStyleSheet("font-weight: bold; font-size: 13px; color: #a1a1aa;")
        layout.addWidget(sec_title)

        theme_grid = QGridLayout()
        theme_grid.setSpacing(12)
        self.theme_group = QButtonGroup(self)

        themes_data = [
            ("emerald", "💚 Emerald (FunPay)", "#10b981", 0, 0),
            ("violet", "💜 Neon Violet", "#6366f1", 0, 1),
            ("cyan", "💙 Nordic Cyan", "#06b6d4", 1, 0),
            ("amber", "🧡 Sunset Amber", "#f59e0b", 1, 1),
        ]

        self.theme_radios = {}
        for th_id, th_name, color, row, col in themes_data:
            rb = QRadioButton(th_name)
            rb.setStyleSheet(f"QRadioButton {{ color: {color}; font-weight: 600; font-size: 13px; }}")
            self.theme_group.addButton(rb)
            self.theme_radios[th_id] = rb
            theme_grid.addWidget(rb, row, col)

        layout.addLayout(theme_grid)
        layout.addStretch()
        return tab

    def _create_clipboard_tab(self) -> QWidget:
        tab = QWidget()
        layout = QVBoxLayout(tab)
        layout.setContentsMargins(10, 10, 10, 10)
        layout.setSpacing(14)

        sec_title = QLabel("Параметры буфера обмена и вставки:")
        sec_title.setStyleSheet("font-weight: bold; font-size: 13px; color: #a1a1aa;")
        layout.addWidget(sec_title)

        row = QHBoxLayout()
        row.setSpacing(10)
        delay_lbl = QLabel("Задержка восстановления исходного буфера (мс):")
        delay_lbl.setStyleSheet("color: #e4e4e7;")
        row.addWidget(delay_lbl)

        self.delay_spin = QSpinBox()
        self.delay_spin.setRange(20, 1000)
        self.delay_spin.setSingleStep(10)
        self.delay_spin.setValue(120)
        self.delay_spin.setFixedWidth(80)
        row.addWidget(self.delay_spin)
        row.addStretch()
        layout.addLayout(row)

        info_box = QLabel(
            "ℹ️ Приложение сохраняет текущее содержимое буфера пользователя перед вставкой "
            "шаблона и безопасно восстанавливает его обратно через очередь.\n\n"
            "Если целевое приложение (браузер, чат) работает медленно, увеличьте задержку до 150-200 мс."
        )
        info_box.setWordWrap(True)
        info_box.setStyleSheet("color: #71717a; font-size: 12px; line-height: 1.4; background-color: #202024; padding: 10px; border-radius: 6px;")
        layout.addWidget(info_box)

        layout.addStretch()
        return tab

    def _create_history_tab(self) -> QWidget:
        tab = QWidget()
        layout = QVBoxLayout(tab)
        layout.setContentsMargins(10, 10, 10, 10)
        layout.setSpacing(14)

        sec_title = QLabel("История отправленных шаблонов:")
        sec_title.setStyleSheet("font-weight: bold; font-size: 13px; color: #a1a1aa;")
        layout.addWidget(sec_title)

        self.history_cb = QCheckBox("Вести локальный журнал вызовов хоткеев")
        self.history_cb.setStyleSheet("font-weight: 500;")
        layout.addWidget(self.history_cb)

        hint = QLabel(
            "Журнал сохраняет дату, время, комбинацию и текст отправленного шаблона. "
            "Данные хранятся исключительно локально на вашем ПК."
        )
        hint.setWordWrap(True)
        hint.setStyleSheet("color: #71717a; font-size: 12px;")
        layout.addWidget(hint)

        clear_row = QHBoxLayout()
        self.clear_history_btn = QPushButton("Очистить историю вызовов")
        self.clear_history_btn.setObjectName("DangerButton")
        self.clear_history_btn.clicked.connect(self._clear_usage_history)
        clear_row.addWidget(self.clear_history_btn)
        clear_row.addStretch()
        layout.addLayout(clear_row)

        layout.addStretch()
        return tab

    def _create_notifications_tab(self) -> QWidget:
        tab = QWidget()
        layout = QVBoxLayout(tab)
        layout.setContentsMargins(10, 10, 10, 10)
        layout.setSpacing(14)

        sec_title = QLabel("Всплывающие уведомления (Toast):")
        sec_title.setStyleSheet("font-weight: bold; font-size: 13px; color: #a1a1aa;")
        layout.addWidget(sec_title)

        self.notify_cb = QCheckBox("Показывать всплывающие уведомления (Toast)")
        self.notify_cb.setStyleSheet("font-weight: 500;")
        layout.addWidget(self.notify_cb)

        info = QLabel(
            "Уведомления появляются в правом нижнем углу экрана при:\n"
            "• Быстром переключении активного профиля\n"
            "• Включении / выключении глобальных хоткеев\n"
            "• Начале и завершении рабочей смены\n"
            "• Успешной вставке шаблона\n\n"
            "Уведомления полностью прозрачны для ввода и не перехватывают фокус у браузера."
        )
        info.setWordWrap(True)
        info.setStyleSheet("color: #71717a; font-size: 12px; line-height: 1.4; background-color: #202024; padding: 10px; border-radius: 6px;")
        layout.addWidget(info)

        layout.addStretch()
        return tab

    def _create_backup_tab(self) -> QWidget:
        tab = QWidget()
        layout = QVBoxLayout(tab)
        layout.setContentsMargins(10, 10, 10, 10)
        layout.setSpacing(12)

        sec_title = QLabel("Резервное копирование базы данных:")
        sec_title.setStyleSheet("font-weight: bold; font-size: 13px; color: #a1a1aa;")
        layout.addWidget(sec_title)

        backup_btns = QHBoxLayout()
        self.create_backup_btn = QPushButton("💾 Создать бэкап сейчас")
        self.create_backup_btn.clicked.connect(self._create_backup_now)
        backup_btns.addWidget(self.create_backup_btn)

        self.restore_backup_btn = QPushButton("Восстановить из выбранного")
        self.restore_backup_btn.clicked.connect(self._restore_selected_backup)
        backup_btns.addWidget(self.restore_backup_btn)
        backup_btns.addStretch()
        layout.addLayout(backup_btns)

        # Backups list table
        self.backup_table = QTableWidget()
        self.backup_table.setColumnCount(3)
        self.backup_table.setHorizontalHeaderLabels(["Имя файла", "Дата создания", "Размер"])
        self.backup_table.horizontalHeader().setSectionResizeMode(0, QHeaderView.Stretch)
        self.backup_table.horizontalHeader().setSectionResizeMode(1, QHeaderView.ResizeToContents)
        self.backup_table.horizontalHeader().setSectionResizeMode(2, QHeaderView.ResizeToContents)
        self.backup_table.verticalHeader().setVisible(False)
        self.backup_table.setSelectionBehavior(QTableWidget.SelectRows)
        self.backup_table.setSelectionMode(QTableWidget.SingleSelection)
        self.backup_table.setStyleSheet("""
            QTableWidget {
                background-color: #202024;
                border: 1px solid #27272a;
                border-radius: 6px;
            }
        """)
        layout.addWidget(self.backup_table)

        # Export/Import profile section
        prof_sec = QLabel("Экспорт и импорт профилей (.fhkprofile):")
        prof_sec.setStyleSheet("font-weight: bold; font-size: 13px; color: #a1a1aa; margin-top: 6px;")
        layout.addWidget(prof_sec)

        export_import_layout = QHBoxLayout()
        self.export_btn = QPushButton("Экспорт активного профиля")
        self.export_btn.clicked.connect(self._export_profile)
        export_import_layout.addWidget(self.export_btn)

        self.import_btn = QPushButton("Импорт профиля (.fhkprofile)")
        self.import_btn.clicked.connect(self._import_profile)
        export_import_layout.addWidget(self.import_btn)
        export_import_layout.addStretch()
        layout.addLayout(export_import_layout)

        return tab

    def _load_values(self):
        self.tray_cb.setChecked(self.settings_mgr.is_minimize_to_tray())
        self.autostart_cb.setChecked(self.settings_mgr.is_autostart())

        # Quick menu hotkey
        self._current_qm_hotkey = self.settings_mgr.get_quick_menu_hotkey()
        self.qm_badge.setText(self._current_qm_hotkey)

        # Theme accent
        saved_theme = self.settings_mgr.get_theme_accent()
        if saved_theme in self.theme_radios:
            self.theme_radios[saved_theme].setChecked(True)
        else:
            self.theme_radios["emerald"].setChecked(True)

        mode = self.settings_mgr.get_app_filter_mode()
        if mode == "whitelist":
            self.filter_whitelist_rb.setChecked(True)
            self.whitelist_edit.setEnabled(True)
        else:
            self.filter_global_rb.setChecked(True)
            self.whitelist_edit.setEnabled(False)

        whitelist = self.settings_mgr.get_app_whitelist()
        self.whitelist_edit.setPlainText(", ".join(whitelist))

        # Clipboard delay
        self.delay_spin.setValue(self.settings_mgr.get_clipboard_restore_delay_ms())

        # History and notifications
        self.history_cb.setChecked(self.settings_mgr.is_usage_history_enabled())
        self.notify_cb.setChecked(self.settings_mgr.is_notifications_enabled())

        # Load profile shortcuts
        self._load_profile_shortcuts()

        # Load backups list
        self._refresh_backups_list()

    def _load_profile_shortcuts(self):
        profiles = self.profile_mgr.get_profiles()
        self.profiles_table.setRowCount(len(profiles))
        self._profile_shortcuts_map = {}

        for row, p in enumerate(profiles):
            self._profile_shortcuts_map[p.id] = p.switch_shortcut or ""

            name_item = QTableWidgetItem(p.name)
            name_item.setFlags(Qt.ItemIsEnabled)
            self.profiles_table.setItem(row, 0, name_item)

            badge = QLabel(p.switch_shortcut if p.switch_shortcut else "—")
            badge.setAlignment(Qt.AlignCenter)
            badge.setStyleSheet("color: #a5b4fc; font-weight: 600;")
            self.profiles_table.setCellWidget(row, 1, badge)

            btn_frame = QWidget()
            btn_layout = QHBoxLayout(btn_frame)
            btn_layout.setContentsMargins(4, 2, 4, 2)
            btn_layout.setSpacing(4)

            change_btn = QPushButton("Назначить...")
            change_btn.clicked.connect(lambda checked, pid=p.id, r=row: self._record_profile_shortcut(pid, r))
            btn_layout.addWidget(change_btn)

            clear_btn = QPushButton("✕")
            clear_btn.setFixedWidth(26)
            clear_btn.setToolTip("Убрать хоткей")
            clear_btn.clicked.connect(lambda checked, pid=p.id, r=row: self._clear_profile_shortcut(pid, r))
            btn_layout.addWidget(clear_btn)

            self.profiles_table.setCellWidget(row, 2, btn_frame)

    def _record_profile_shortcut(self, profile_id: int, row: int):
        curr_sc = self._profile_shortcuts_map.get(profile_id, "")
        recorder = KeyRecorderDialog(self, current_shortcut=curr_sc)
        if recorder.exec():
            new_sc = recorder.captured_shortcut
            if new_sc:
                self._profile_shortcuts_map[profile_id] = new_sc
                badge = QLabel(new_sc)
                badge.setAlignment(Qt.AlignCenter)
                badge.setStyleSheet("color: #10b981; font-weight: bold;")
                self.profiles_table.setCellWidget(row, 1, badge)

    def _clear_profile_shortcut(self, profile_id: int, row: int):
        self._profile_shortcuts_map[profile_id] = ""
        badge = QLabel("—")
        badge.setAlignment(Qt.AlignCenter)
        badge.setStyleSheet("color: #71717a;")
        self.profiles_table.setCellWidget(row, 1, badge)

    def _refresh_backups_list(self):
        backups = self.profile_mgr.db.list_backups()
        self.backup_table.setRowCount(len(backups))
        for row, b in enumerate(backups):
            filename_item = QTableWidgetItem(b["filename"])
            filename_item.setData(Qt.UserRole, b["path"])
            filename_item.setFlags(Qt.ItemIsEnabled | Qt.ItemIsSelectable)
            self.backup_table.setItem(row, 0, filename_item)

            date_str = str(b.get("created_at", ""))
            date_item = QTableWidgetItem(date_str)
            date_item.setFlags(Qt.ItemIsEnabled | Qt.ItemIsSelectable)
            self.backup_table.setItem(row, 1, date_item)

            size_str = f"{b.get('size_kb', 0)} КБ"
            size_item = QTableWidgetItem(size_str)
            size_item.setFlags(Qt.ItemIsEnabled | Qt.ItemIsSelectable)
            self.backup_table.setItem(row, 2, size_item)

    def _create_backup_now(self):
        path = self.profile_mgr.db.create_backup(tag="manual")
        if path:
            QMessageBox.information(self, "Бэкап создан", f"Резервная копия успешно создана:\n{os.path.basename(path)}")
            self._refresh_backups_list()
        else:
            QMessageBox.warning(self, "Ошибка", "Не удалось создать резервную копию.")

    def _restore_selected_backup(self):
        row = self.backup_table.currentRow()
        if row < 0:
            QMessageBox.information(self, "Выбор копии", "Пожалуйста, выберите резервную копию из списка.")
            return

        item = self.backup_table.item(row, 0)
        backup_path = item.data(Qt.UserRole)
        filename = item.text()

        reply = QMessageBox.question(
            self,
            "Восстановление данных",
            f"Восстановить базу данных из копии «{filename}»?\n"
            "Текущие данные будут заменены состоянием из бэкапа.",
            QMessageBox.Yes | QMessageBox.No,
            QMessageBox.No,
        )
        if reply == QMessageBox.Yes:
            success = self.profile_mgr.db.restore_backup(backup_path)
            if success:
                QMessageBox.information(self, "Успех", "База данных успешно восстановлена!")
                self.profile_imported.emit()
                self.accept()
            else:
                QMessageBox.critical(self, "Ошибка", "Не удалось восстановить базу данных.")

    def _clear_usage_history(self):
        reply = QMessageBox.question(
            self,
            "Очистка истории",
            "Вы действительно хотите очистить всю историю вызовов хоткеев?",
            QMessageBox.Yes | QMessageBox.No,
            QMessageBox.No,
        )
        if reply == QMessageBox.Yes:
            self.profile_mgr.db.clear_usage_history()
            QMessageBox.information(self, "Успех", "История вызовов успешно очищена.")

    def _record_quick_menu_shortcut(self):
        recorder = KeyRecorderDialog(self, current_shortcut=self._current_qm_hotkey)
        if recorder.exec():
            new_sc = recorder.captured_shortcut
            if new_sc:
                self._current_qm_hotkey = new_sc
                self.qm_badge.setText(new_sc)

    def _save_settings(self):
        self.settings_mgr.set_minimize_to_tray(self.tray_cb.isChecked())
        self.settings_mgr.set_autostart(self.autostart_cb.isChecked())

        # Save quick menu hotkey
        old_qm = self.settings_mgr.get_quick_menu_hotkey()
        if self._current_qm_hotkey != old_qm:
            self.settings_mgr.set_quick_menu_hotkey(self._current_qm_hotkey)
            self.quick_menu_hotkey_changed.emit(self._current_qm_hotkey)

        # Save profile switch shortcuts
        for pid, sc in self._profile_shortcuts_map.items():
            self.profile_mgr.update_profile_switch_shortcut(pid, sc)
        self.hotkeys_configuration_changed.emit()

        # Save theme accent
        for th_id, rb in self.theme_radios.items():
            if rb.isChecked():
                old_th = self.settings_mgr.get_theme_accent()
                if th_id != old_th:
                    self.settings_mgr.set_theme_accent(th_id)
                    self.theme_changed.emit(th_id)
                break

        mode = "whitelist" if self.filter_whitelist_rb.isChecked() else "global"
        self.settings_mgr.set_app_filter_mode(mode)

        raw_whitelist = self.whitelist_edit.toPlainText()
        apps = [a.strip() for a in raw_whitelist.replace("\n", ",").split(",") if a.strip()]
        self.settings_mgr.set_app_whitelist(apps)

        # Save clipboard delay & other settings
        self.settings_mgr.set_clipboard_restore_delay_ms(self.delay_spin.value())
        self.settings_mgr.set_usage_history_enabled(self.history_cb.isChecked())
        self.settings_mgr.set_notifications_enabled(self.notify_cb.isChecked())

        self.accept()

    def _export_profile(self):
        active = self.profile_mgr.get_active_profile()
        file_path, _ = QFileDialog.getSaveFileName(
            self,
            "Экспорт профиля",
            f"{active.name.replace(' ', '_')}.fhkprofile",
            "FunPay Profile (*.fhkprofile);;All Files (*.*)",
        )
        if file_path:
            success = self.profile_mgr.export_profile(active.id, file_path)
            if success:
                QMessageBox.information(self, "Успех", f"Профиль «{active.name}» успешно экспортирован!")
            else:
                QMessageBox.critical(self, "Ошибка", "Не удалось экспортировать профиль.")

    def _import_profile(self):
        file_path, _ = QFileDialog.getOpenFileName(
            self,
            "Импорт профиля",
            "",
            "FunPay Profile (*.fhkprofile);;All Files (*.*)",
        )
        if file_path:
            success, profile, err = self.profile_mgr.import_profile(file_path)
            if success and profile:
                QMessageBox.information(self, "Успех", f"Профиль «{profile.name}» успешно импортирован!")
                self.profile_imported.emit()
            else:
                QMessageBox.critical(self, "Ошибка импорта", err or "Неизвестная ошибка.")
