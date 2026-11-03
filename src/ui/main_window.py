"""Main application window: Two-panel modern dark interface with hotkey editor."""

from typing import Optional, List
from PySide6.QtWidgets import (
    QMainWindow,
    QWidget,
    QHBoxLayout,
    QVBoxLayout,
    QFrame,
    QLabel,
    QLineEdit,
    QTextEdit,
    QPushButton,
    QRadioButton,
    QButtonGroup,
    QCheckBox,
    QComboBox,
    QListWidget,
    QListWidgetItem,
    QMessageBox,
    QStatusBar,
    QSplitter,
)
from PySide6.QtCore import Qt, Signal
from PySide6.QtGui import QKeySequence, QShortcut

from ..database.models import HotkeyItem, Profile, MODE_PASTE, MODE_PASTE_ENTER, MODE_COPY_ONLY
from ..__version__ import __version__, __app_name__
from ..core.profile_manager import ProfileManager
from ..core.template_manager import TemplateManager
from ..core.variable_manager import VariableManager
from ..core.settings_manager import SettingsManager
from ..core.shift_manager import ShiftManager
from ..ui.components.hotkey_card import HotkeyCardWidget
from ..ui.components.shift_widget import ShiftWidget
from ..ui.components.key_recorder import KeyRecorderDialog
from ..ui.dialogs.profile_dialogs import NewProfileDialog, RenameProfileDialog
from ..ui.dialogs.variable_dialog import VariableInputDialog
from ..ui.dialogs.test_preview_dialog import TestPreviewDialog
from ..ui.dialogs.shift_history_dialog import ShiftHistoryDialog
from ..ui.dialogs.settings_dialog import SettingsDialog
from ..ui.tray_manager import create_app_icon
from ..ui.icons import get_vector_icon
from ..ui.styles import get_dark_theme_qss
from ..utils.win32_utils import normalize_shortcut


class ReorderableListWidget(QListWidget):
    item_reordered = Signal(int, int)  # (source_row, dest_row)

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setDragDropMode(QListWidget.InternalMove)
        self.setDefaultDropAction(Qt.MoveAction)
        self.setSelectionMode(QListWidget.SingleSelection)
        self.setDragEnabled(True)
        self.setAcceptDrops(True)
        self.setDropIndicatorShown(True)

    def dropEvent(self, event):
        src_item = self.currentItem()
        if not src_item:
            event.ignore()
            return
        src_row = self.row(src_item)
        target_pos = event.position().toPoint() if hasattr(event, "position") else event.pos()
        dest_item = self.itemAt(target_pos)
        if dest_item:
            dest_row = self.row(dest_item)
        else:
            dest_row = self.count() - 1

        if src_row != dest_row and 0 <= dest_row < self.count():
            event.accept()
            self.item_reordered.emit(src_row, dest_row)
        else:
            event.ignore()


class MainWindow(QMainWindow):
    hotkeys_configuration_changed = Signal()  # Emitted when hotkeys or profile changes to reload listener

    def __init__(
        self,
        profile_mgr: ProfileManager,
        template_mgr: TemplateManager,
        variable_mgr: VariableManager,
        settings_mgr: SettingsManager,
        shift_mgr: Optional[ShiftManager] = None,
        parent=None,
    ):
        super().__init__(parent)
        self.profile_mgr = profile_mgr
        self.template_mgr = template_mgr
        self.variable_mgr = variable_mgr
        self.settings_mgr = settings_mgr
        self.shift_mgr = shift_mgr or ShiftManager(self.profile_mgr.db)

        self.setWindowTitle(f"{__app_name__} v{__version__}")
        self.setWindowIcon(create_app_icon(True))
        self.resize(980, 620)
        self.setMinimumSize(880, 560)

        self.current_profile: Profile = self.profile_mgr.get_active_profile()
        self.current_hotkey: Optional[HotkeyItem] = None
        self._is_loading_ui = False
        self._has_unsaved_changes = False

        self._init_ui()
        self._setup_shortcuts()
        self.reload_profiles_list()
        self.reload_hotkeys_list()

    def _init_ui(self):
        central_widget = QWidget()
        self.setCentralWidget(central_widget)
        root_layout = QVBoxLayout(central_widget)
        root_layout.setContentsMargins(0, 0, 0, 0)
        root_layout.setSpacing(0)

        # 1. Header Frame (fixed height to prevent vertical stretching)
        header_frame = QFrame()
        header_frame.setObjectName("HeaderFrame")
        header_frame.setFixedHeight(54)
        header_layout = QHBoxLayout(header_frame)
        header_layout.setContentsMargins(12, 8, 12, 8)
        header_layout.setSpacing(6)

        # Brand / Title
        brand_label = QLabel("FanPay Hotkeys")
        brand_label.setStyleSheet("font-size: 15px; font-weight: bold; color: #ffffff;")
        header_layout.addWidget(brand_label)

        header_layout.addSpacing(6)

        # Profile Switcher (compact without redundant text label)
        self.profile_combo = QComboBox()
        self.profile_combo.setToolTip("Текущий профиль шаблонов")
        self.profile_combo.currentIndexChanged.connect(self._on_profile_combo_changed)
        header_layout.addWidget(self.profile_combo)

        # Profile CRUD buttons tightly grouped with 3px spacing
        profile_btn_layout = QHBoxLayout()
        profile_btn_layout.setContentsMargins(0, 0, 0, 0)
        profile_btn_layout.setSpacing(3)

        self.add_profile_btn = QPushButton()
        self.add_profile_btn.setObjectName("ToolButton")
        self.add_profile_btn.setIcon(get_vector_icon("plus", "#e4e4e7", 14))
        self.add_profile_btn.setToolTip("Создать новый профиль")
        self.add_profile_btn.clicked.connect(self._create_new_profile)
        profile_btn_layout.addWidget(self.add_profile_btn)

        self.duplicate_profile_btn = QPushButton()
        self.duplicate_profile_btn.setObjectName("ToolButton")
        self.duplicate_profile_btn.setIcon(get_vector_icon("copy", "#e4e4e7", 14))
        self.duplicate_profile_btn.setToolTip("Дублировать текущий профиль")
        self.duplicate_profile_btn.clicked.connect(self._duplicate_current_profile)
        profile_btn_layout.addWidget(self.duplicate_profile_btn)

        self.rename_profile_btn = QPushButton()
        self.rename_profile_btn.setObjectName("ToolButton")
        self.rename_profile_btn.setIcon(get_vector_icon("edit", "#e4e4e7", 14))
        self.rename_profile_btn.setToolTip("Переименовать текущий профиль")
        self.rename_profile_btn.clicked.connect(self._rename_current_profile)
        profile_btn_layout.addWidget(self.rename_profile_btn)

        self.delete_profile_btn = QPushButton()
        self.delete_profile_btn.setObjectName("ToolButton")
        self.delete_profile_btn.setIcon(get_vector_icon("trash", "#f87171", 14))
        self.delete_profile_btn.setToolTip("Удалить текущий профиль")
        self.delete_profile_btn.clicked.connect(self._delete_current_profile)
        profile_btn_layout.addWidget(self.delete_profile_btn)

        header_layout.addLayout(profile_btn_layout)

        header_layout.addStretch(1)

        # Work Shift Widget
        self.shift_widget = ShiftWidget(
            self.shift_mgr,
            get_active_profile_name=lambda: self.current_profile.name if self.current_profile else "Общий",
            parent=self,
        )
        self.shift_widget.open_history_requested.connect(self._open_shift_history)
        header_layout.addWidget(self.shift_widget)

        header_layout.addSpacing(6)

        # Global Enable/Disable Toggle
        self.toggle_hotkeys_btn = QPushButton()
        self.toggle_hotkeys_btn.setFixedHeight(34)
        self.toggle_hotkeys_btn.setFixedWidth(115)
        self.toggle_hotkeys_btn.clicked.connect(self._toggle_global_hotkeys)
        header_layout.addWidget(self.toggle_hotkeys_btn)
        self._update_global_toggle_ui()

        # Settings button
        self.settings_btn = QPushButton("Настройки")
        self.settings_btn.setIcon(get_vector_icon("gear", "#e4e4e7", 14))
        self.settings_btn.setFixedHeight(34)
        self.settings_btn.setFixedWidth(105)
        self.settings_btn.clicked.connect(self._open_settings_dialog)
        header_layout.addWidget(self.settings_btn)

        root_layout.addWidget(header_frame, 0)

        # 2. Main Two-Panel Content
        splitter = QSplitter(Qt.Horizontal)
        splitter.setStyleSheet("QSplitter::handle { background-color: #27272a; width: 1px; }")

        # --- Left Panel: Hotkeys List ---
        left_panel = QFrame()
        left_panel.setObjectName("LeftPanel")
        left_layout = QVBoxLayout(left_panel)
        left_layout.setContentsMargins(12, 12, 12, 12)
        left_layout.setSpacing(10)

        # Search bar
        self.search_input = QLineEdit()
        self.search_input.setPlaceholderText("Поиск шаблона...")
        self.search_input.textChanged.connect(self._filter_hotkeys_list)
        left_layout.addWidget(self.search_input)

        # List Widget (strictly NO horizontal scrollbar, supports drag-and-drop reordering)
        self.hotkeys_list_widget = ReorderableListWidget()
        self.hotkeys_list_widget.setHorizontalScrollBarPolicy(Qt.ScrollBarAlwaysOff)
        self.hotkeys_list_widget.setVerticalScrollMode(QListWidget.ScrollPerPixel)
        self.hotkeys_list_widget.setSpacing(3)
        self.hotkeys_list_widget.currentItemChanged.connect(self._on_hotkey_selected)
        self.hotkeys_list_widget.item_reordered.connect(self._on_hotkeys_reordered)
        left_layout.addWidget(self.hotkeys_list_widget)

        # Add Hotkey button
        self.add_hotkey_btn = QPushButton("Добавить хоткей")
        self.add_hotkey_btn.setIcon(get_vector_icon("plus", "#ffffff", 14))
        self.add_hotkey_btn.setObjectName("PrimaryButton")
        self.add_hotkey_btn.setFixedHeight(36)
        self.add_hotkey_btn.clicked.connect(self._add_new_hotkey)
        left_layout.addWidget(self.add_hotkey_btn)

        splitter.addWidget(left_panel)

        # --- Right Panel: Editor ---
        right_panel = QFrame()
        right_panel.setObjectName("RightPanel")
        right_layout = QVBoxLayout(right_panel)
        right_layout.setContentsMargins(20, 16, 20, 16)
        right_layout.setSpacing(14)

        editor_header = QLabel("Редактор хоткея")
        editor_header.setStyleSheet("font-size: 15px; font-weight: bold; color: #f4f4f5;")
        right_layout.addWidget(editor_header)

        # 1. Title
        title_box = QVBoxLayout()
        title_box.setSpacing(4)
        title_lbl = QLabel("Название:")
        title_lbl.setStyleSheet("color: #a1a1aa; font-weight: 500;")
        title_box.addWidget(title_lbl)

        self.title_input = QLineEdit()
        self.title_input.setPlaceholderText("Например: 🎮 Game Pass")
        self.title_input.textChanged.connect(self._mark_unsaved_changes)
        title_box.addWidget(self.title_input)
        right_layout.addLayout(title_box)

        # 2. Hotkey Shortcut
        shortcut_box = QVBoxLayout()
        shortcut_box.setSpacing(4)
        sc_lbl = QLabel("Хоткей:")
        sc_lbl.setStyleSheet("color: #a1a1aa; font-weight: 500;")
        shortcut_box.addWidget(sc_lbl)

        sc_row = QHBoxLayout()
        sc_row.setSpacing(10)
        self.shortcut_badge = QLabel("F4")
        self.shortcut_badge.setObjectName("ActiveShortcutBadge")
        self.shortcut_badge.setMinimumWidth(70)
        self.shortcut_badge.setAlignment(Qt.AlignCenter)
        sc_row.addWidget(self.shortcut_badge)

        self.change_shortcut_btn = QPushButton("Изменить комбинацию...")
        self.change_shortcut_btn.setIcon(get_vector_icon("edit", "#a5b4fc", 14))
        self.change_shortcut_btn.clicked.connect(self._record_new_shortcut)
        sc_row.addWidget(self.change_shortcut_btn)
        sc_row.addStretch()

        shortcut_box.addLayout(sc_row)
        right_layout.addLayout(shortcut_box)

        # 3. Message Text
        msg_box = QVBoxLayout()
        msg_box.setSpacing(4)
        msg_lbl = QLabel("Сообщение:")
        msg_lbl.setStyleSheet("color: #a1a1aa; font-weight: 500;")
        msg_box.addWidget(msg_lbl)

        self.message_edit = QTextEdit()
        self.message_edit.setPlaceholderText(
            "Введите текст сообщения... Поддерживаются переменные, например {robux}, {price}, {buyer}, {order}."
        )
        self.message_edit.setMinimumHeight(110)
        self.message_edit.setMaximumHeight(190)
        self.message_edit.textChanged.connect(self._on_message_text_changed)
        self.message_edit.setUndoRedoEnabled(True)

        # Windows-standard Undo/Redo shortcuts
        undo_sc = QShortcut(QKeySequence("Ctrl+Z"), self.message_edit)
        undo_sc.activated.connect(self.message_edit.undo)
        redo_sc = QShortcut(QKeySequence("Ctrl+Y"), self.message_edit)
        redo_sc.activated.connect(self.message_edit.redo)
        redo_sc2 = QShortcut(QKeySequence("Ctrl+Shift+Z"), self.message_edit)
        redo_sc2.activated.connect(self.message_edit.redo)
        msg_box.addWidget(self.message_edit)

        # Variable tags hint
        self.vars_hint_label = QLabel()
        self.vars_hint_label.setStyleSheet("color: #a5b4fc; font-size: 11px;")
        self.vars_hint_label.setVisible(False)
        msg_box.addWidget(self.vars_hint_label)

        right_layout.addLayout(msg_box)

        # 4. Mode
        mode_box = QVBoxLayout()
        mode_box.setSpacing(6)
        mode_lbl = QLabel("Режим срабатывания:")
        mode_lbl.setStyleSheet("color: #a1a1aa; font-weight: 500;")
        mode_box.addWidget(mode_lbl)

        self.mode_group = QButtonGroup(self)
        self.mode_paste_rb = QRadioButton("Вставить в активное поле (по умолчанию)")
        self.mode_paste_enter_rb = QRadioButton("Вставить + Enter (автоматическая отправка)")
        self.mode_copy_only_rb = QRadioButton("Только скопировать в буфер обмена")

        self.mode_group.addButton(self.mode_paste_rb)
        self.mode_group.addButton(self.mode_paste_enter_rb)
        self.mode_group.addButton(self.mode_copy_only_rb)

        self.mode_paste_rb.toggled.connect(self._mark_unsaved_changes)
        self.mode_paste_enter_rb.toggled.connect(self._on_paste_enter_toggled)
        self.mode_copy_only_rb.toggled.connect(self._mark_unsaved_changes)

        mode_box.addWidget(self.mode_paste_rb)
        mode_box.addWidget(self.mode_paste_enter_rb)
        mode_box.addWidget(self.mode_copy_only_rb)
        right_layout.addLayout(mode_box)

        # 5. Enabled Checkbox
        self.enabled_cb = QCheckBox("Хоткей активен")
        self.enabled_cb.setStyleSheet("font-weight: 500;")
        self.enabled_cb.toggled.connect(self._mark_unsaved_changes)
        right_layout.addWidget(self.enabled_cb)

        # 6. Action buttons (tightly grouped together on the left)
        actions_layout = QHBoxLayout()
        actions_layout.setSpacing(10)

        self.save_btn = QPushButton("Сохранить (Ctrl+S)")
        self.save_btn.setIcon(get_vector_icon("save", "#ffffff", 14))
        self.save_btn.setObjectName("PrimaryButton")
        self.save_btn.setFixedHeight(36)
        self.save_btn.clicked.connect(self.save_current_hotkey)
        actions_layout.addWidget(self.save_btn)

        self.duplicate_hotkey_btn = QPushButton("Дублировать")
        self.duplicate_hotkey_btn.setIcon(get_vector_icon("copy", "#e4e4e7", 13))
        self.duplicate_hotkey_btn.setFixedHeight(36)
        self.duplicate_hotkey_btn.setToolTip("Создать копию текущего хоткея")
        self.duplicate_hotkey_btn.clicked.connect(self._duplicate_current_hotkey)
        actions_layout.addWidget(self.duplicate_hotkey_btn)

        self.test_btn = QPushButton("Тест")
        self.test_btn.setIcon(get_vector_icon("play", "#e4e4e7", 13))
        self.test_btn.setFixedHeight(36)
        self.test_btn.clicked.connect(self._test_current_hotkey)
        actions_layout.addWidget(self.test_btn)

        self.delete_hotkey_btn = QPushButton("Удалить")
        self.delete_hotkey_btn.setIcon(get_vector_icon("trash", "#f87171", 14))
        self.delete_hotkey_btn.setObjectName("DangerButton")
        self.delete_hotkey_btn.setFixedHeight(36)
        self.delete_hotkey_btn.clicked.connect(self._delete_current_hotkey)
        actions_layout.addWidget(self.delete_hotkey_btn)

        actions_layout.addStretch(1)

        right_layout.addLayout(actions_layout)
        right_layout.addStretch(1)

        splitter.addWidget(right_panel)
        splitter.setSizes([310, 650])
        splitter.setStretchFactor(0, 0)
        splitter.setStretchFactor(1, 1)

        root_layout.addWidget(splitter, 1)

        # Status Bar
        self.statusBar = QStatusBar()
        self.setStatusBar(self.statusBar)
        self.statusBar.showMessage("Готово к работе")

    def _setup_shortcuts(self):
        # Ctrl+S shortcut to save immediately
        save_shortcut = QShortcut(QKeySequence("Ctrl+S"), self)
        save_shortcut.activated.connect(self.save_current_hotkey)

    # --- Profile Handling ---

    def reload_profiles_list(self):
        self._is_loading_ui = True
        self.profile_combo.clear()
        profiles = self.profile_mgr.get_profiles()
        active_p = self.profile_mgr.get_active_profile()

        target_idx = 0
        for i, p in enumerate(profiles):
            self.profile_combo.addItem(p.name, p.id)
            if p.id == active_p.id:
                target_idx = i

        self.current_profile = active_p
        self.profile_combo.setCurrentIndex(target_idx)
        self._is_loading_ui = False

    def _on_profile_combo_changed(self, index: int):
        if self._is_loading_ui or index < 0:
            return

        if self._has_unsaved_changes:
            if not self._prompt_unsaved_changes():
                # Revert combo back without changing
                self._is_loading_ui = True
                profiles = self.profile_mgr.get_profiles()
                for i, p in enumerate(profiles):
                    if p.id == self.current_profile.id:
                        self.profile_combo.setCurrentIndex(i)
                        break
                self._is_loading_ui = False
                return

        profile_id = self.profile_combo.itemData(index)
        self.profile_mgr.set_active_profile_id(profile_id)
        self.current_profile = self.profile_mgr.get_active_profile()
        self.reload_hotkeys_list()
        self.hotkeys_configuration_changed.emit()

    def _create_new_profile(self):
        if self._has_unsaved_changes and not self._prompt_unsaved_changes():
            return
        dlg = NewProfileDialog(self)
        if dlg.exec():
            new_p = self.profile_mgr.create_profile(dlg.profile_name)
            if new_p:
                self.profile_mgr.set_active_profile_id(new_p.id)
                self.reload_profiles_list()
                self.reload_hotkeys_list()
                self.hotkeys_configuration_changed.emit()

    def _rename_current_profile(self):
        dlg = RenameProfileDialog(self.current_profile.name, self)
        if dlg.exec():
            success = self.profile_mgr.rename_profile(self.current_profile.id, dlg.new_name)
            if success:
                self.reload_profiles_list()

    def _delete_current_profile(self):
        profiles = self.profile_mgr.get_profiles()
        if len(profiles) <= 1:
            QMessageBox.warning(self, "Предупреждение", "Нельзя удалить единственный оставшийся профиль.")
            return

        reply = QMessageBox.question(
            self,
            "Удаление профиля",
            f"Вы уверены, что хотите удалить профиль «{self.current_profile.name}» и все его хоткеи?",
            QMessageBox.Yes | QMessageBox.No,
            QMessageBox.No,
        )
        if reply == QMessageBox.Yes:
            self.profile_mgr.delete_profile(self.current_profile.id)
            self.reload_profiles_list()
            self.reload_hotkeys_list()
            self.hotkeys_configuration_changed.emit()

    def _duplicate_current_profile(self):
        if not self.current_profile:
            return
        new_p = self.profile_mgr.duplicate_profile(self.current_profile.id)
        if new_p:
            self.reload_profiles_list()
            for i in range(self.profile_combo.count()):
                if self.profile_combo.itemData(i) == new_p.id:
                    self.profile_combo.setCurrentIndex(i)
                    break
            self.hotkeys_configuration_changed.emit()
            self.statusBar.showMessage(f"Профиль продублирован как «{new_p.name}»", 3000)

    # --- Hotkeys List Handling ---

    def reload_hotkeys_list(self, select_id: Optional[int] = None):
        self._is_loading_ui = True
        self.hotkeys_list_widget.clear()

        hotkeys = self.template_mgr.get_hotkeys_for_profile(self.current_profile.id)
        target_row = 0
        for idx, item in enumerate(hotkeys):
            list_item = QListWidgetItem(self.hotkeys_list_widget)
            list_item.setData(Qt.UserRole, item.id)
            list_item.setData(Qt.UserRole + 1, item)

            card = HotkeyCardWidget(item)
            list_item.setSizeHint(card.sizeHint())
            self.hotkeys_list_widget.setItemWidget(list_item, card)

            if select_id and item.id == select_id:
                target_row = idx

        self._is_loading_ui = False

        if self.hotkeys_list_widget.count() > 0:
            self.hotkeys_list_widget.setCurrentRow(target_row)
            sel_item = self.hotkeys_list_widget.item(target_row)
            sel_card = self.hotkeys_list_widget.itemWidget(sel_item)
            if isinstance(sel_card, HotkeyCardWidget):
                sel_card.set_selected(True)
        else:
            self._clear_editor()

        # Re-apply search filter if user had typed a query
        if self.search_input.text().strip():
            self._filter_hotkeys_list(self.search_input.text())

    def _on_hotkeys_reordered(self, src_row: int, dest_row: int):
        ids = [self.hotkeys_list_widget.item(i).data(Qt.UserRole) for i in range(self.hotkeys_list_widget.count())]
        if 0 <= src_row < len(ids) and 0 <= dest_row < len(ids):
            moved_id = ids.pop(src_row)
            ids.insert(dest_row, moved_id)
            self.template_mgr.update_hotkeys_order(self.current_profile.id, ids)
            self.reload_hotkeys_list(select_id=moved_id)
            self.hotkeys_configuration_changed.emit()
            self.statusBar.showMessage("Порядок хоткеев сохранён", 2000)

    def _filter_hotkeys_list(self, text: str):
        query = text.strip().lower()
        prof_name = self.current_profile.name.lower() if self.current_profile else ""
        for i in range(self.hotkeys_list_widget.count()):
            item = self.hotkeys_list_widget.item(i)
            h = item.data(Qt.UserRole + 1)
            if h:
                match = (
                    (query in h.title.lower())
                    or (query in h.shortcut.lower())
                    or (query in h.message.lower())
                    or (query in prof_name)
                )
                item.setHidden(not match)
            else:
                widget = self.hotkeys_list_widget.itemWidget(item)
                if isinstance(widget, HotkeyCardWidget):
                    title = widget.title_label.text().lower()
                    badge = widget.badge.text().lower()
                    match = (query in title) or (query in badge)
                    item.setHidden(not match)

    def _on_hotkey_selected(self, current: QListWidgetItem, previous: Optional[QListWidgetItem]):
        if self._is_loading_ui:
            return

        if self._has_unsaved_changes and previous:
            # Prevent recursive signals
            self._is_loading_ui = True
            save_ok = self._prompt_unsaved_changes()
            self._is_loading_ui = False
            if not save_ok:
                self.hotkeys_list_widget.blockSignals(True)
                self.hotkeys_list_widget.setCurrentItem(previous)
                self.hotkeys_list_widget.blockSignals(False)
                return

        # Update visual selection on card widgets
        if previous:
            prev_widget = self.hotkeys_list_widget.itemWidget(previous)
            if isinstance(prev_widget, HotkeyCardWidget):
                prev_widget.set_selected(False)

        if current:
            curr_widget = self.hotkeys_list_widget.itemWidget(current)
            if isinstance(curr_widget, HotkeyCardWidget):
                curr_widget.set_selected(True)
        else:
            self._clear_editor()
            return

        hotkey_id = current.data(Qt.UserRole)
        hotkey = self.template_mgr.get_hotkey_by_id(hotkey_id)
        if hotkey:
            self.current_hotkey = hotkey
            self._load_hotkey_to_editor(hotkey)

    def _load_hotkey_to_editor(self, item: HotkeyItem):
        self._is_loading_ui = True
        self.title_input.setText(item.title)
        self.shortcut_badge.setText(item.shortcut)
        self.message_edit.setPlainText(item.message)
        self.message_edit.document().clearUndoRedoStacks()

        if item.mode == MODE_PASTE_ENTER:
            self.mode_paste_enter_rb.setChecked(True)
        elif item.mode == MODE_COPY_ONLY:
            self.mode_copy_only_rb.setChecked(True)
        else:
            self.mode_paste_rb.setChecked(True)

        self.enabled_cb.setChecked(item.enabled)
        self._update_vars_hint(item.message)

        self._has_unsaved_changes = False
        self._is_loading_ui = False
        self.statusBar.showMessage(f"Выбран хоткей: {item.shortcut} — {item.title}")

    def _clear_editor(self):
        self._is_loading_ui = True
        self.current_hotkey = None
        self.title_input.clear()
        self.shortcut_badge.setText("—")
        self.message_edit.clear()
        self.message_edit.document().clearUndoRedoStacks()
        self.mode_paste_rb.setChecked(True)
        self.enabled_cb.setChecked(False)
        self.vars_hint_label.setVisible(False)
        self._has_unsaved_changes = False
        self._is_loading_ui = False

    def _add_new_hotkey(self):
        if self._has_unsaved_changes and not self._prompt_unsaved_changes():
            return

        new_item = self.template_mgr.create_default_hotkey(self.current_profile.id)
        self.reload_hotkeys_list(select_id=new_item.id)

        self.title_input.setFocus()
        self.title_input.selectAll()
        self.hotkeys_configuration_changed.emit()

    def _duplicate_current_hotkey(self):
        if not self.current_hotkey:
            return
        if self._has_unsaved_changes and not self._prompt_unsaved_changes():
            return

        new_item = self.template_mgr.duplicate_hotkey(self.current_hotkey.id)
        if new_item:
            self.reload_hotkeys_list(select_id=new_item.id)
            self.hotkeys_configuration_changed.emit()
            self.statusBar.showMessage(f"Хоткей продублирован: {new_item.shortcut} — {new_item.title}", 3000)

    def _delete_current_hotkey(self):
        if not self.current_hotkey:
            return

        reply = QMessageBox.question(
            self,
            "Удаление хоткея",
            f"Удалить хоткей «{self.current_hotkey.shortcut} — {self.current_hotkey.title}»?",
            QMessageBox.Yes | QMessageBox.No,
            QMessageBox.No,
        )
        if reply == QMessageBox.Yes:
            self.template_mgr.delete_hotkey(self.current_hotkey.id)
            self._has_unsaved_changes = False
            self.reload_hotkeys_list()
            self.hotkeys_configuration_changed.emit()
            self.statusBar.showMessage("Хоткей удален")

    def _record_new_shortcut(self):
        curr_sc = self.shortcut_badge.text()
        dlg = KeyRecorderDialog(curr_sc, self)
        if dlg.exec():
            new_sc = dlg.recorded_shortcut
            # Check conflict in profile
            conflict = self.template_mgr.find_conflict(
                self.current_profile.id, new_sc, current_hotkey_id=self.current_hotkey.id if self.current_hotkey else None
            )
            if conflict:
                rep = QMessageBox.question(
                    self,
                    "Конфликт комбинаций",
                    f"Комбинация '{new_sc}' уже используется хоткеем «{conflict.title}».\n\nЗаменить существующий хоткей?",
                    QMessageBox.Yes | QMessageBox.No,
                    QMessageBox.No,
                )
                if rep == QMessageBox.Yes:
                    # Clear shortcut from conflicting item
                    conflict.shortcut = ""
                    conflict.enabled = False
                    self.template_mgr.save_hotkey(conflict)
                else:
                    return

            self.shortcut_badge.setText(new_sc)
            self._mark_unsaved_changes()

    def _on_paste_enter_toggled(self, checked: bool):
        if checked and not self._is_loading_ui:
            QMessageBox.warning(
                self,
                "Внимание: Автоматическая отправка",
                "Автоматическая отправка (Вставить + Enter) может привести к отправке сообщения не тому пользователю. Используйте осторожно.",
            )
        self._mark_unsaved_changes()

    def _on_message_text_changed(self):
        text = self.message_edit.toPlainText()
        self._update_vars_hint(text)
        self._mark_unsaved_changes()

    def _update_vars_hint(self, text: str):
        vars_list = self.variable_mgr.extract_variables(text)
        if vars_list:
            vars_str = ", ".join([f"{{{v}}}" for v in vars_list])
            self.vars_hint_label.setText(f"💡 Обнаружены переменные: {vars_str}")
            self.vars_hint_label.setVisible(True)
        else:
            self.vars_hint_label.setVisible(False)

    def _mark_unsaved_changes(self):
        if not self._is_loading_ui:
            self._has_unsaved_changes = True

    def _prompt_unsaved_changes(self) -> bool:
        """
        Ask user if they want to save changes before navigating away.
        Returns True if navigation should proceed, False if cancelled.
        """
        if not self.current_hotkey or not self._has_unsaved_changes:
            return True

        title = self.current_hotkey.title or "Шаблон"
        reply = QMessageBox.question(
            self,
            "Несохранённые изменения",
            f"У вас есть несохранённые изменения в «{title}».\nСохранить перед переходом?",
            QMessageBox.Save | QMessageBox.Discard | QMessageBox.Cancel,
            QMessageBox.Save,
        )

        if reply == QMessageBox.Save:
            return self.save_current_hotkey()
        elif reply == QMessageBox.Discard:
            self._has_unsaved_changes = False
            return True
        else:
            return False

    def save_current_hotkey(self) -> bool:
        if not self.current_hotkey:
            return False

        title = self.title_input.text().strip()
        if not title:
            QMessageBox.warning(self, "Ошибка", "Название шаблона не может быть пустым.")
            return False

        shortcut = normalize_shortcut(self.shortcut_badge.text())
        if not shortcut:
            QMessageBox.warning(self, "Ошибка", "Необходимо назначить комбинацию клавиш.")
            return False

        # Mode determination
        if self.mode_paste_enter_rb.isChecked():
            mode = MODE_PASTE_ENTER
        elif self.mode_copy_only_rb.isChecked():
            mode = MODE_COPY_ONLY
        else:
            mode = MODE_PASTE

        # Update item
        self.current_hotkey.title = title
        self.current_hotkey.shortcut = shortcut
        self.current_hotkey.message = self.message_edit.toPlainText()
        self.current_hotkey.mode = mode
        self.current_hotkey.enabled = self.enabled_cb.isChecked()

        self.template_mgr.save_hotkey(self.current_hotkey)
        self._has_unsaved_changes = False

        # Update card in list
        curr_row = self.hotkeys_list_widget.currentRow()
        if curr_row >= 0:
            item = self.hotkeys_list_widget.item(curr_row)
            widget = self.hotkeys_list_widget.itemWidget(item)
            if isinstance(widget, HotkeyCardWidget):
                widget.update_data(self.current_hotkey)

        self.statusBar.showMessage(f"Хоткей «{shortcut} — {title}» сохранён!", 3000)
        self.hotkeys_configuration_changed.emit()
        return True

    def _test_current_hotkey(self):
        title = self.title_input.text().strip() or "Тест"
        raw_msg = self.message_edit.toPlainText()
        vars_list = self.variable_mgr.extract_variables(raw_msg)

        mode = MODE_PASTE
        if self.mode_paste_enter_rb.isChecked():
            mode = MODE_PASTE_ENTER
        elif self.mode_copy_only_rb.isChecked():
            mode = MODE_COPY_ONLY

        evaluated_text = raw_msg
        if vars_list:
            var_dlg = VariableInputDialog(vars_list, self.variable_mgr, self)
            if var_dlg.exec():
                evaluated_text = self.variable_mgr.substitute(raw_msg, var_dlg.values)
            else:
                return

        preview_dlg = TestPreviewDialog(title, evaluated_text, mode, self)
        preview_dlg.exec()

    # --- Global Hotkeys & Settings ---

    def _toggle_global_hotkeys(self):
        currently_enabled = self.settings_mgr.is_hotkeys_enabled()
        new_state = not currently_enabled
        self.settings_mgr.set_hotkeys_enabled(new_state)
        self._update_global_toggle_ui()
        self.hotkeys_configuration_changed.emit()

    def _update_global_toggle_ui(self):
        enabled = self.settings_mgr.is_hotkeys_enabled()
        if enabled:
            self.toggle_hotkeys_btn.setText("● Хоткеи вкл")
            self.toggle_hotkeys_btn.setObjectName("SuccessButton")
            self.toggle_hotkeys_btn.setToolTip("Глобальные хоткеи активны")
        else:
            self.toggle_hotkeys_btn.setText("○ Хоткеи выкл")
            self.toggle_hotkeys_btn.setObjectName("DisabledToggle")
            self.toggle_hotkeys_btn.setToolTip("Глобальные хоткеи отключены")

        self.toggle_hotkeys_btn.setFixedWidth(115)
        # Re-apply styles
        self.toggle_hotkeys_btn.style().unpolish(self.toggle_hotkeys_btn)
        self.toggle_hotkeys_btn.style().polish(self.toggle_hotkeys_btn)

    def _open_shift_history(self):
        dlg = ShiftHistoryDialog(self.shift_mgr, self)
        dlg.exec()

    def _open_settings_dialog(self):
        dlg = SettingsDialog(self.settings_mgr, self.profile_mgr, self)
        dlg.profile_imported.connect(self._on_profile_imported)
        dlg.theme_changed.connect(self._on_theme_changed)
        dlg.quick_menu_hotkey_changed.connect(lambda sc: self.hotkeys_configuration_changed.emit())
        dlg.hotkeys_configuration_changed.connect(lambda: self.hotkeys_configuration_changed.emit())
        dlg.exec()

    def _on_theme_changed(self, theme_name: str):
        from PySide6.QtWidgets import QApplication
        app = QApplication.instance()
        if app:
            app.setStyleSheet(get_dark_theme_qss(theme_name))
        # Re-polish self and children
        self.style().unpolish(self)
        self.style().polish(self)

    def _on_profile_imported(self):
        self.reload_profiles_list()
        self.reload_hotkeys_list()
        self.hotkeys_configuration_changed.emit()

    def closeEvent(self, event):
        """Handle window close: minimize to tray if preference is enabled."""
        if self._has_unsaved_changes and not self._prompt_unsaved_changes():
            event.ignore()
            return

        if self.settings_mgr.is_minimize_to_tray():
            event.ignore()
            self.hide()
            self.statusBar.showMessage("Приложение свернуто в трей")
        else:
            event.accept()
