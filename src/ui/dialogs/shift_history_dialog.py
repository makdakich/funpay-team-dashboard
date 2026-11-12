"""Dialog displaying work shift history, duration analytics, and real-time team monitor.
Synchronized with Supabase Cloud for live multi-operator tracking across 3 team members.
"""

import json
import datetime
from typing import Optional, List, Dict, Any
from PySide6.QtWidgets import (
    QDialog,
    QVBoxLayout,
    QHBoxLayout,
    QLabel,
    QPushButton,
    QTableWidget,
    QTableWidgetItem,
    QHeaderView,
    QFrame,
    QTabWidget,
    QWidget,
    QComboBox,
    QLineEdit,
)
from PySide6.QtCore import Qt, QTimer
from ...core.shift_manager import ShiftManager
from ...core.cloud_sync import cloud_client
from ..components.activity_chart import ActivityChartWidget
from ..icons import get_vector_icon


def _format_currency_totals(values: Dict[str, float]) -> str:
    symbols = {"RUB": "₽", "USD": "$", "EUR": "€", "KZT": "₸"}
    return ", ".join(
        f"{values[currency]:,.2f} {symbols[currency]}".replace(",", " ")
        for currency in ("RUB", "USD", "EUR", "KZT")
        if currency in values and values[currency]
    ) or "0"


class ShiftHistoryDialog(QDialog):
    def __init__(self, shift_mgr: ShiftManager, parent=None):
        super().__init__(parent)
        self.shift_mgr = shift_mgr
        self.cloud_shifts: List[Dict[str, Any]] = []
        self.team_status: List[Dict[str, Any]] = []
        self.is_cloud_available: bool = False

        self.setWindowTitle("Центр управления сменами и монитор команды (Supabase)")
        self.resize(880, 640)
        self.setMinimumSize(780, 560)

        self._init_ui()

        # Auto-refresh timer (every 10 seconds)
        self.refresh_timer = QTimer(self)
        self.refresh_timer.setInterval(10000)
        self.refresh_timer.timeout.connect(self._load_data)
        self.refresh_timer.start()

        self._load_data()

    def closeEvent(self, event):
        self.refresh_timer.stop()
        super().closeEvent(event)

    def _init_ui(self):
        layout = QVBoxLayout(self)
        layout.setContentsMargins(18, 16, 18, 16)
        layout.setSpacing(12)

        # 1. Header with Cloud Indicator and Refresh button
        header_row = QHBoxLayout()
        header_row.setSpacing(10)

        title_vbox = QVBoxLayout()
        title_vbox.setSpacing(2)
        title = QLabel("👥 Монитор команды и история смен")
        title.setStyleSheet("font-size: 17px; font-weight: bold; color: #ffffff;")
        title_vbox.addWidget(title)

        self.cloud_badge = QLabel("⚡ Подключение к облаку...")
        self.cloud_badge.setStyleSheet("font-size: 11px; color: #94a3b8; font-weight: 500;")
        title_vbox.addWidget(self.cloud_badge)
        header_row.addLayout(title_vbox)

        header_row.addStretch()

        # Operator filter dropdown
        self.filter_combo = QComboBox()
        self.filter_combo.setFixedHeight(30)
        self.filter_combo.addItems(["Все сменщики", "Оператор 1", "Оператор 2", "Оператор 3"])
        self.filter_combo.currentIndexChanged.connect(self._apply_filter)
        self.filter_combo.setStyleSheet("""
            QComboBox {
                background-color: #131B2E;
                color: #F8FAFC;
                border: 1px solid #1B2436;
                border-radius: 6px;
                padding: 4px 10px;
                font-weight: 500;
            }
        """)
        header_row.addWidget(self.filter_combo)

        # Manual Refresh button
        self.refresh_btn = QPushButton("🔄 Обновить")
        self.refresh_btn.setFixedHeight(30)
        self.refresh_btn.setStyleSheet("""
            QPushButton {
                background-color: #1E293B;
                color: #38BDF8;
                border: 1px solid #334155;
                border-radius: 6px;
                padding: 4px 12px;
                font-weight: 600;
            }
            QPushButton:hover {
                background-color: #334155;
            }
        """)
        self.refresh_btn.clicked.connect(self._load_data)
        header_row.addWidget(self.refresh_btn)

        layout.addLayout(header_row)

        # 1b. Operator sign-in (schema v2.4 enforces RLS through auth.uid(), so team data
        #     is only readable while an authenticated session is attached)
        auth_row = QHBoxLayout()
        auth_row.setSpacing(8)

        self.auth_email_input = QLineEdit()
        self.auth_email_input.setPlaceholderText("email оператора")
        self.auth_email_input.setFixedHeight(30)
        self.auth_email_input.setMaximumWidth(220)

        self.auth_password_input = QLineEdit()
        self.auth_password_input.setPlaceholderText("пароль")
        self.auth_password_input.setEchoMode(QLineEdit.Password)
        self.auth_password_input.setFixedHeight(30)
        self.auth_password_input.setMaximumWidth(170)

        auth_input_style = """
            QLineEdit {
                background-color: #131B2E;
                color: #F8FAFC;
                border: 1px solid #1B2436;
                border-radius: 6px;
                padding: 4px 10px;
            }
        """
        self.auth_email_input.setStyleSheet(auth_input_style)
        self.auth_password_input.setStyleSheet(auth_input_style)

        self.auth_btn = QPushButton("Войти в облако")
        self.auth_btn.setFixedHeight(30)
        self.auth_btn.setStyleSheet("""
            QPushButton {
                background-color: #1E293B;
                color: #38BDF8;
                border: 1px solid #334155;
                border-radius: 6px;
                padding: 4px 12px;
                font-weight: 600;
            }
            QPushButton:hover {
                background-color: #334155;
            }
        """)
        self.auth_btn.clicked.connect(self._sign_in)
        self.auth_password_input.returnPressed.connect(self._sign_in)

        self.auth_status_lbl = QLabel("Вход в облако команды не выполнен")
        self.auth_status_lbl.setStyleSheet("font-size: 11px; color: #94A3B8; font-weight: 500;")

        auth_row.addWidget(self.auth_email_input)
        auth_row.addWidget(self.auth_password_input)
        auth_row.addWidget(self.auth_btn)
        auth_row.addWidget(self.auth_status_lbl)
        auth_row.addStretch()
        layout.addLayout(auth_row)

        # 2. Team Member Live Cards (3 operators)
        team_section_lbl = QLabel("Текущий статус команды (в реальном времени):")
        team_section_lbl.setStyleSheet("font-weight: 600; color: #94A3B8; font-size: 12px; margin-top: 2px;")
        layout.addWidget(team_section_lbl)

        self.cards_row = QHBoxLayout()
        self.cards_row.setSpacing(10)

        self.op_card_1 = self._create_operator_card("Оператор 1")
        self.op_card_2 = self._create_operator_card("Оператор 2")
        self.op_card_3 = self._create_operator_card("Оператор 3")

        self.cards_row.addWidget(self.op_card_1)
        self.cards_row.addWidget(self.op_card_2)
        self.cards_row.addWidget(self.op_card_3)
        layout.addLayout(self.cards_row)

        # 3. Summary Metric Cards
        metrics_row = QHBoxLayout()
        metrics_row.setSpacing(10)

        self.metric_turnover = self._create_metric_card("Общий оборот смен", "0 ₽", "#10b981")
        self.metric_seller_share = self._create_metric_card("Доля сменщиков", "0 ₽", "#6366f1")
        self.metric_orders = self._create_metric_card("Всего заказов", "0", "#f59e0b")
        self.metric_shifts_count = self._create_metric_card("Количество смен", "0", "#06b6d4")

        metrics_row.addWidget(self.metric_turnover)
        metrics_row.addWidget(self.metric_seller_share)
        metrics_row.addWidget(self.metric_orders)
        metrics_row.addWidget(self.metric_shifts_count)
        layout.addLayout(metrics_row)

        # 4. Tabs: Cloud Shifts Table & Activity Chart
        self.tabs = QTabWidget()
        self.tabs.setStyleSheet("""
            QTabWidget::pane {
                border: 1px solid #1B2436;
                border-radius: 8px;
                background-color: #0E131F;
            }
            QTabBar::tab {
                background: #131B2E;
                color: #94A3B8;
                padding: 6px 14px;
                margin-right: 4px;
                border-top-left-radius: 6px;
                border-top-right-radius: 6px;
                font-weight: 600;
            }
            QTabBar::tab:selected {
                background: #0E131F;
                color: #38BDF8;
                border-bottom: 2px solid #38BDF8;
            }
        """)

        # Tab 1: Cloud Shifts Table
        tab_table = QWidget()
        tab_table_layout = QVBoxLayout(tab_table)
        tab_table_layout.setContentsMargins(8, 8, 8, 8)

        self.table = QTableWidget()
        self.table.setColumnCount(7)
        self.table.setHorizontalHeaderLabels([
            "Оператор", "Дата и время", "Длительность", "Заказов", "Оборот", "Доля продавца", "Статус"
        ])
        self.table.horizontalHeader().setSectionResizeMode(0, QHeaderView.ResizeToContents)
        self.table.horizontalHeader().setSectionResizeMode(1, QHeaderView.Stretch)
        self.table.horizontalHeader().setSectionResizeMode(2, QHeaderView.ResizeToContents)
        self.table.horizontalHeader().setSectionResizeMode(3, QHeaderView.ResizeToContents)
        self.table.horizontalHeader().setSectionResizeMode(4, QHeaderView.ResizeToContents)
        self.table.horizontalHeader().setSectionResizeMode(5, QHeaderView.ResizeToContents)
        self.table.horizontalHeader().setSectionResizeMode(6, QHeaderView.ResizeToContents)
        self.table.verticalHeader().setVisible(False)
        self.table.setSelectionBehavior(QTableWidget.SelectRows)
        self.table.setEditTriggers(QTableWidget.NoEditTriggers)
        self.table.setStyleSheet("""
            QTableWidget {
                background-color: #0E131F;
                border: none;
                gridline-color: #1B2436;
                color: #F8FAFC;
                selection-background-color: #1E293B;
            }
            QHeaderView::section {
                background-color: #131B2E;
                color: #94A3B8;
                padding: 6px;
                border: none;
                border-bottom: 1px solid #1B2436;
                font-weight: 600;
            }
        """)
        tab_table_layout.addWidget(self.table)
        self.tabs.addTab(tab_table, "📋 Журнал смен (Облако)")

        # Tab 2: Activity Chart
        tab_chart = QWidget()
        tab_chart_layout = QVBoxLayout(tab_chart)
        tab_chart_layout.setContentsMargins(12, 12, 12, 12)
        chart_info = QLabel("График активности сообщений за последние 7 дней:")
        chart_info.setStyleSheet("color: #94A3B8; font-weight: 500; font-size: 12px;")
        tab_chart_layout.addWidget(chart_info)
        self.chart = ActivityChartWidget(parent=self)
        self.chart.setFixedHeight(160)
        tab_chart_layout.addWidget(self.chart)
        tab_chart_layout.addStretch()
        self.tabs.addTab(tab_chart, "📈 График сообщений")

        layout.addWidget(self.tabs)

        # Bottom buttons
        btn_row = QHBoxLayout()
        self.footer_info = QLabel("⏱️ Авто-обновление каждые 10 секунд")
        self.footer_info.setStyleSheet("color: #64748B; font-size: 11px;")
        btn_row.addWidget(self.footer_info)
        btn_row.addStretch()

        close_btn = QPushButton("Закрыть")
        close_btn.setFixedWidth(100)
        close_btn.setStyleSheet("""
            QPushButton {
                background-color: #1E293B;
                color: #E2E8F0;
                border: 1px solid #334155;
                border-radius: 6px;
                padding: 6px 12px;
                font-weight: 600;
            }
            QPushButton:hover {
                background-color: #334155;
            }
        """)
        close_btn.clicked.connect(self.accept)
        btn_row.addWidget(close_btn)

        layout.addLayout(btn_row)

    def _create_operator_card(self, op_name: str) -> QFrame:
        card = QFrame()
        card.setObjectName(f"Card_{op_name}")
        card.setStyleSheet("""
            QFrame {
                background-color: #0E131F;
                border: 1px solid #1B2436;
                border-radius: 8px;
                padding: 8px 10px;
            }
        """)
        card_layout = QVBoxLayout(card)
        card_layout.setContentsMargins(6, 6, 6, 6)
        card_layout.setSpacing(3)

        top_h = QHBoxLayout()
        name_lbl = QLabel(op_name)
        name_lbl.setStyleSheet("font-size: 13px; font-weight: bold; color: #F8FAFC;")
        top_h.addWidget(name_lbl)
        top_h.addStretch()

        status_dot = QLabel("⚪ Оффлайн")
        status_dot.setObjectName("StatusLabel")
        status_dot.setStyleSheet("font-size: 11px; color: #94A3B8; font-weight: 600;")
        top_h.addWidget(status_dot)
        card_layout.addLayout(top_h)

        stats_lbl = QLabel("Смена не активна")
        stats_lbl.setObjectName("DetailsLabel")
        stats_lbl.setStyleSheet("font-size: 11px; color: #64748B;")
        card_layout.addWidget(stats_lbl)

        return card

    def _create_metric_card(self, label_text: str, val_text: str, accent_color: str) -> QFrame:
        card = QFrame()
        card.setStyleSheet("""
            QFrame {
                background-color: #0E131F;
                border: 1px solid #1B2436;
                border-radius: 8px;
                padding: 8px;
            }
        """)
        card_layout = QVBoxLayout(card)
        card_layout.setContentsMargins(6, 4, 6, 4)
        card_layout.setSpacing(2)

        lbl = QLabel(label_text)
        lbl.setStyleSheet("font-size: 11px; color: #94A3B8; font-weight: 500;")
        card_layout.addWidget(lbl)

        val = QLabel(val_text)
        val.setObjectName("MetricValue")
        val.setStyleSheet(f"font-size: 16px; font-weight: bold; color: {accent_color};")
        card_layout.addWidget(val)

        return card

    def _load_data(self):
        """Fetch real-time data from Supabase Cloud and local database."""
        # 1. Test cloud connection
        self.is_cloud_available = cloud_client.test_connection()

        if self.is_cloud_available and cloud_client.has_session():
            self.cloud_badge.setText("🟢 Облако Supabase подключено (команда синхронизирована)")
            self.cloud_badge.setStyleSheet("font-size: 11px; color: #22C55E; font-weight: 600;")
            self.team_status = cloud_client.fetch_team_status()
            self.cloud_shifts = cloud_client.fetch_all_shifts(limit=150)
        elif self.is_cloud_available:
            self.cloud_badge.setText("🟡 Облако доступно, но оператор не вошёл (RLS вернёт 0 строк)")
            self.cloud_badge.setStyleSheet("font-size: 11px; color: #F59E0B; font-weight: 600;")
            self.team_status = []
            self.cloud_shifts = []
        else:
            self.cloud_badge.setText("⚪ Локальный режим (облако недоступно)")
            self.cloud_badge.setStyleSheet("font-size: 11px; color: #F59E0B; font-weight: 600;")
            self.team_status = []
            self.cloud_shifts = []

        self._update_auth_status()
        self._update_filter_options()

        # 2. Update Team Operator Cards
        self._update_operator_cards()

    def _sign_in(self):
        """Authenticate the operator against the team backend (schema v2.4 RLS needs a JWT)."""
        email = self.auth_email_input.text().strip()
        password = self.auth_password_input.text()

        self.auth_btn.setEnabled(False)
        self.auth_btn.setText("Вход...")
        try:
            success, message = cloud_client.sign_in(email, password)
        finally:
            self.auth_btn.setEnabled(True)
            self.auth_btn.setText("Войти в облако")

        if success:
            self.auth_password_input.clear()
        else:
            self.auth_status_lbl.setText(f"❌ {message}")
            self.auth_status_lbl.setStyleSheet("font-size: 11px; color: #F87171; font-weight: 600;")

        self._load_data()

    def _update_auth_status(self):
        """Reflect the current cloud session in the header."""
        if cloud_client.has_session():
            user_id = (cloud_client.user_id or "")[:8]
            self.auth_status_lbl.setText(f"✅ Вход выполнен (ID {user_id}…)")
            self.auth_status_lbl.setStyleSheet("font-size: 11px; color: #22C55E; font-weight: 600;")
        else:
            self.auth_status_lbl.setText("Вход в облако команды не выполнен")
            self.auth_status_lbl.setStyleSheet("font-size: 11px; color: #94A3B8; font-weight: 500;")

    def _update_filter_options(self):
        """Repopulate the operator filter, then refresh the chart and the shifts table.

        The combo is only rebuilt when the cloud roster actually changes, but the chart and
        the table must be refreshed on every poll: returning early here used to freeze them
        after the first successful load.
        """
        names = sorted({item.get("operator_name") for item in self.team_status if item.get("operator_name")})

        if names:
            current = self.filter_combo.currentText()
            options = ["Все сменщики"] + names
            if list(options) != [self.filter_combo.itemText(i) for i in range(self.filter_combo.count())]:
                self.filter_combo.blockSignals(True)
                self.filter_combo.clear()
                self.filter_combo.addItems(options)
                if current in options:
                    self.filter_combo.setCurrentText(current)
                self.filter_combo.blockSignals(False)

        # 3. Update Activity Chart
        daily_activity = self.shift_mgr.db.get_daily_activity_last_7_days()
        self.chart.set_data(daily_activity)

        # 4. Render Shifts Table
        self._apply_filter()

    def _update_operator_cards(self):
        """Update live cards for the 3 operators."""
        cards = {
            "Оператор 1": self.op_card_1,
            "Оператор 2": self.op_card_2,
            "Оператор 3": self.op_card_3,
        }

        # Index remote records by profile display name
        status_map = {item.get("operator_name"): item for item in self.team_status}

        # Prefer the real roster reported by the cloud; otherwise keep positional placeholders
        roster: List[Optional[str]] = [
            item.get("operator_name") or f"Оператор {index + 1}"
            for index, item in enumerate(self.team_status[:3])
        ] or ["Оператор 1", "Оператор 2", "Оператор 3"]
        while len(roster) < 3:
            roster.append(None)

        for slot_index, (name, card) in enumerate(zip(roster, cards.values())):
            status_lbl = card.findChild(QLabel, "StatusLabel")
            details_lbl = card.findChild(QLabel, "DetailsLabel")
            record = status_map.get(name) if name else None

            name_labels = card.findChildren(QLabel)
            if name_labels:
                name_labels[0].setText(name or f"Оператор {slot_index + 1}")

            if record and record.get("on_shift"):
                status_lbl.setText("🟢 На смене")
                status_lbl.setStyleSheet("font-size: 11px; color: #22C55E; font-weight: bold;")
                shop = record.get("current_seller_account_id") or "—"
                details_lbl.setText(f"Магазин {shop} • клиент v{record.get('app_version') or '—'}")
                details_lbl.setStyleSheet("font-size: 11px; color: #38BDF8; font-weight: 500;")
                card.setStyleSheet("""
                    QFrame {
                        background-color: #0E131F;
                        border: 1px solid #10B981;
                        border-radius: 8px;
                        padding: 8px 10px;
                    }
                """)
            elif record and record.get("is_online"):
                status_lbl.setText("🟡 В сети")
                status_lbl.setStyleSheet("font-size: 11px; color: #F59E0B; font-weight: bold;")
                details_lbl.setText("Готов к открытию смены")
                details_lbl.setStyleSheet("font-size: 11px; color: #38BDF8; font-weight: 500;")
                card.setStyleSheet("""
                    QFrame {
                        background-color: #0E131F;
                        border: 1px solid #1B2436;
                        border-radius: 8px;
                        padding: 8px 10px;
                    }
                """)
            else:
                last_seen_str = ""
                if record and record.get("last_seen"):
                    try:
                        dt = datetime.datetime.fromisoformat(record["last_seen"].replace("Z", "+00:00"))
                        last_seen_str = dt.strftime("%H:%M")
                    except Exception:
                        pass
                status_lbl.setText("⚪ Оффлайн")
                status_lbl.setStyleSheet("font-size: 11px; color: #94A3B8; font-weight: 500;")
                details_lbl.setText(f"Был в сети: {last_seen_str}" if last_seen_str else "Смена не активна")
                details_lbl.setStyleSheet("font-size: 11px; color: #64748B;")
                card.setStyleSheet("""
                    QFrame {
                        background-color: #0E131F;
                        border: 1px solid #1B2436;
                        border-radius: 8px;
                        padding: 8px 10px;
                    }
                """)

    def _apply_filter(self):
        """Filter shifts by selected operator name."""
        filter_text = self.filter_combo.currentText()

        # Combine cloud shifts or local shifts
        rows_to_display: List[Dict[str, Any]] = []

        if self.cloud_shifts:
            for s in self.cloud_shifts:
                op_name = s.get("operator_name") or "Оператор 1"
                if filter_text != "Все сменщики" and op_name != filter_text:
                    continue
                rows_to_display.append(s)
        else:
            # Fallback to local SQLite shifts
            local_shifts = self.shift_mgr.get_shift_history(limit=50)
            for ls in local_shifts:
                prof = ls.profile_name or "Оператор 1"
                if filter_text != "Все сменщики" and prof != filter_text:
                    continue
                rows_to_display.append({
                    "operator_name": prof,
                    "start_time": int(datetime.datetime.fromisoformat(ls.start_time).timestamp() * 1000) if "T" in ls.start_time else 0,
                    "duration_seconds": ls.duration_seconds,
                    "orders_count": ls.messages_count,
                    "turnover_by_currency": {},
                    "seller_share_by_currency": {},
                    "status": "completed",
                    "has_financials": False,
                    "_is_local": True
                })

        # Calculate metrics
        tot_turnover_by_currency: Dict[str, float] = {}
        tot_share_by_currency: Dict[str, float] = {}
        tot_orders = 0
        financials_available = False
        orders_known = False

        for r in rows_to_display:
            if r.get("has_financials") is True:
                financials_available = True
            orders_value = r.get("orders_count")
            if orders_value is not None:
                orders_known = True
                tot_orders += orders_value
            turnover_dict = r.get("turnover_by_currency") or {}
            share_dict = r.get("seller_share_by_currency") or {}
            for currency, amount in turnover_dict.items():
                tot_turnover_by_currency[currency] = tot_turnover_by_currency.get(currency, 0.0) + amount
            for currency, amount in share_dict.items():
                tot_share_by_currency[currency] = tot_share_by_currency.get(currency, 0.0) + amount

        # v2.4 stores no per-shift money aggregates, so unknown values render as a dash
        # instead of a fabricated zero.
        self.metric_turnover.findChild(QLabel, "MetricValue").setText(
            _format_currency_totals(tot_turnover_by_currency) if financials_available else "—"
        )
        self.metric_seller_share.findChild(QLabel, "MetricValue").setText(
            _format_currency_totals(tot_share_by_currency) if financials_available else "—"
        )
        self.metric_orders.findChild(QLabel, "MetricValue").setText(str(tot_orders) if orders_known else "—")
        self.metric_shifts_count.findChild(QLabel, "MetricValue").setText(str(len(rows_to_display)))

        # Fill table
        self.table.setRowCount(len(rows_to_display))

        for row, s in enumerate(rows_to_display):
            op_name = s.get("operator_name") or "Оператор 1"

            # Start time formatting
            start_ms = s.get("start_time", 0)
            if start_ms > 0:
                dt = datetime.datetime.fromtimestamp(start_ms / 1000.0)
                start_str = dt.strftime("%d.%m %H:%M")
            else:
                start_str = "—"

            # Duration formatting
            dur_sec = s.get("duration_seconds", 0)
            dh = dur_sec // 3600
            dm = (dur_sec % 3600) // 60
            dur_str = f"{dh}ч {dm:02d}м"

            # Orders: None means the backend exposes no per-shift aggregate
            orders_value = s.get("orders_count")
            orders_str = "—" if orders_value is None else str(orders_value)

            financials_known = s.get("has_financials") is True

            # Turnover
            turnover_dict = s.get("turnover_by_currency") or {}
            if not financials_known:
                turnover_str = "—"
            else:
                turnover_str = _format_currency_totals(turnover_dict)

            # Seller Share
            share_dict = s.get("seller_share_by_currency") or {}
            if not financials_known:
                share_str = "—"
            else:
                share_str = _format_currency_totals(share_dict)

            # Status
            status = s.get("status", "completed")
            status_text = "🟢 В процессе" if status == "active" else "✔ Завершена"

            item_op = QTableWidgetItem(op_name)
            item_op.setTextAlignment(Qt.AlignLeft | Qt.AlignVCenter)

            item_start = QTableWidgetItem(start_str)
            item_start.setTextAlignment(Qt.AlignCenter)

            item_dur = QTableWidgetItem(dur_str)
            item_dur.setTextAlignment(Qt.AlignCenter)

            item_ord = QTableWidgetItem(orders_str)
            item_ord.setTextAlignment(Qt.AlignCenter)

            item_turn = QTableWidgetItem(turnover_str)
            item_turn.setTextAlignment(Qt.AlignRight | Qt.AlignVCenter)

            item_share = QTableWidgetItem(share_str)
            item_share.setTextAlignment(Qt.AlignRight | Qt.AlignVCenter)

            item_st = QTableWidgetItem(status_text)
            item_st.setTextAlignment(Qt.AlignCenter)
            if status == "active":
                item_st.setForeground(Qt.green)

            self.table.setItem(row, 0, item_op)
            self.table.setItem(row, 1, item_start)
            self.table.setItem(row, 2, item_dur)
            self.table.setItem(row, 3, item_ord)
            self.table.setItem(row, 4, item_turn)
            self.table.setItem(row, 5, item_share)
            self.table.setItem(row, 6, item_st)
