"""Unit tests for CloudSyncClient and Supabase v2.4 compatibility."""

import json
import pytest
from unittest.mock import patch, MagicMock
from src.core.cloud_sync import CloudSyncClient, _parse_iso_to_ms


def test_parse_iso_to_ms():
    """Verify ISO-8601 parsing into millisecond epoch timestamps."""
    assert _parse_iso_to_ms(None) == 0
    assert _parse_iso_to_ms("") == 0
    assert _parse_iso_to_ms(123) == 0
    assert _parse_iso_to_ms("invalid-date") == 0

    # 2026-01-01T00:00:00Z = 1767225600000 ms
    ms = _parse_iso_to_ms("2026-01-01T00:00:00Z")
    assert ms == 1767225600000

    # Explicit +00:00 offset
    ms_offset = _parse_iso_to_ms("2026-01-01T00:00:00+00:00")
    assert ms_offset == 1767225600000


def test_session_management():
    """Verify session storage, token assignment, and clearance."""
    client = CloudSyncClient()
    assert client.has_session() is False
    assert client.user_id is None

    client.set_session(
        access_token="test_jwt_access",
        refresh_token="test_jwt_refresh",
        expires_at=9999999999.0,
        user_id="user_12345",
    )
    assert client.has_session() is True
    assert client.user_id == "user_12345"

    client.clear_session()
    assert client.has_session() is False
    assert client.user_id is None
    assert client._access_token is None
    assert client._refresh_token is None


def test_headers_and_auth_headers():
    """Verify standard headers and bearer token inclusion."""
    client = CloudSyncClient(url="https://test.supabase.co", key="test_anon_key")
    headers = client._headers()
    assert headers["apikey"] == "test_anon_key"
    assert headers["Authorization"] == "Bearer test_anon_key"
    assert headers["User-Agent"] == "FunPayHotkeysDesktop/2.4"
    assert headers["Prefer"] == "return=representation"

    # With authenticated session
    client.set_session("operator_jwt", user_id="op_1")
    auth_headers = client._headers(prefer="resolution=merge-duplicates")
    assert auth_headers["apikey"] == "test_anon_key"
    assert auth_headers["Authorization"] == "Bearer operator_jwt"
    assert auth_headers["Prefer"] == "resolution=merge-duplicates"


def test_humanize_auth_error():
    """Verify human-readable translation of Supabase GoTrue errors."""
    assert "Неверный email или пароль" in CloudSyncClient._humanize_auth_error(400, "invalid login credentials")
    assert "Email не подтверждён" in CloudSyncClient._humanize_auth_error(400, "Email not confirmed")
    assert "Сессия истекла" in CloudSyncClient._humanize_auth_error(401, "Token has expired")
    assert "HTTP 403" in CloudSyncClient._humanize_auth_error(403, "Access restricted")


def test_fetch_team_status_normalization():
    """Verify operator_status query parsing with 3-tier profiles roles and 4-state presence."""
    client = CloudSyncClient()
    mock_rows = [
        {
            "user_id": "creator-uuid-1",
            "status": "on_shift",
            "active_shift_id": "shift-100",
            "current_seller_account_id": "1084291",
            "app_version": "2.4.0",
            "last_heartbeat_at": "2026-11-12T00:00:00Z",
            "profiles": {
                "display_name": "Главный Администратор",
                "role": "owner",
            },
        },
        {
            "user_id": "operator-uuid-2",
            "status": "break",
            "active_shift_id": "shift-101",
            "current_seller_account_id": "1084291",
            "app_version": "2.4.0",
            "last_heartbeat_at": "2026-11-12T00:01:00Z",
            "profiles": {
                "display_name": "Сменщик 1",
                "role": "operator",
            },
        },
        {
            "user_id": "operator-uuid-3",
            "status": "offline",
            "active_shift_id": None,
            "current_seller_account_id": None,
            "app_version": "2.3.9",
            "last_heartbeat_at": "2026-11-11T20:00:00Z",
            "profiles": None,
        },
    ]

    with patch.object(client, "_get", return_value=mock_rows):
        team = client.fetch_team_status()
        assert len(team) == 3

        # First member (owner on shift)
        assert team[0]["user_id"] == "creator-uuid-1"
        assert team[0]["operator_name"] == "Главный Администратор"
        assert team[0]["role"] == "owner"
        assert team[0]["status"] == "on_shift"
        assert team[0]["is_online"] is True
        assert team[0]["on_shift"] is True
        assert team[0]["current_shift_id"] == "shift-100"

        # Second member (operator on break)
        assert team[1]["user_id"] == "operator-uuid-2"
        assert team[1]["operator_name"] == "Сменщик 1"
        assert team[1]["role"] == "operator"
        assert team[1]["status"] == "break"
        assert team[1]["is_online"] is True
        assert team[1]["on_shift"] is False

        # Third member (offline with fallback display_name)
        assert team[2]["user_id"] == "operator-uuid-3"
        assert team[2]["operator_name"] == "Оператор"
        assert team[2]["role"] == "operator"
        assert team[2]["status"] == "offline"
        assert team[2]["is_online"] is False
        assert team[2]["on_shift"] is False


def test_fetch_shift_financials_aggregation():
    """Verify multi-currency financial aggregation and 10% operator share computation."""
    client = CloudSyncClient()
    mock_orders = [
        {"shift_id": "shift-1", "currency": "RUB", "amount": "1000.00"},
        {"shift_id": "shift-1", "currency": "RUB", "amount": "500.00"},
        {"shift_id": "shift-1", "currency": "USD", "amount": "50.00"},
        {"shift_id": "shift-1", "currency": "EUR", "amount": "20.00"},
        {"shift_id": "shift-1", "currency": "KZT", "amount": "5000.00"},
        {"shift_id": "shift-1", "currency": "GBP", "amount": "100.00"},  # Unsupported currency
        {"shift_id": "shift-1", "currency": "RUB", "amount": "invalid"},  # Malformed amount
        {"shift_id": "shift-2", "currency": "RUB", "amount": "2000.00"},
    ]

    with patch.object(client, "_get", return_value=mock_orders):
        financials = client.fetch_shift_financials(["shift-1", "shift-2"])

        # Shift 1 verification
        s1 = financials["shift-1"]
        assert s1["orders_count"] == 5
        assert s1["turnover_by_currency"]["RUB"] == 1500.00
        assert s1["seller_share_by_currency"]["RUB"] == 150.00
        assert s1["turnover_by_currency"]["USD"] == 50.00
        assert s1["seller_share_by_currency"]["USD"] == 5.00
        assert s1["turnover_by_currency"]["EUR"] == 20.00
        assert s1["seller_share_by_currency"]["EUR"] == 2.00
        assert s1["turnover_by_currency"]["KZT"] == 5000.00
        assert s1["seller_share_by_currency"]["KZT"] == 500.00

        # Shift 2 verification
        s2 = financials["shift-2"]
        assert s2["orders_count"] == 1
        assert s2["turnover_by_currency"]["RUB"] == 2000.00
        assert s2["seller_share_by_currency"]["RUB"] == 200.00


def test_fetch_all_shifts_normalization():
    """Verify shifts listing merged with financial aggregates."""
    client = CloudSyncClient()
    mock_shifts = [
        {
            "id": "shift-10",
            "user_id": "usr-1",
            "seller_account_id": "1084291",
            "start_time": "2026-11-12T10:00:00Z",
            "end_time": "2026-11-12T14:00:00Z",
            "duration_seconds": 14400,
            "status": "completed",
            "profiles": {"display_name": "Алексей"},
        }
    ]
    mock_financials = {
        "shift-10": {
            "orders_count": 8,
            "turnover_by_currency": {"RUB": 8000.0, "USD": 0.0, "EUR": 0.0, "KZT": 0.0},
            "seller_share_by_currency": {"RUB": 800.0, "USD": 0.0, "EUR": 0.0, "KZT": 0.0},
        }
    }

    with patch.object(client, "_get", return_value=mock_shifts), \
         patch.object(client, "fetch_shift_financials", return_value=mock_financials):
        shifts = client.fetch_all_shifts(limit=50)
        assert len(shifts) == 1
        s = shifts[0]
        assert s["id"] == "shift-10"
        assert s["operator_name"] == "Алексей"
        assert s["seller_account_id"] == "1084291"
        assert s["duration_seconds"] == 14400
        assert s["status"] == "completed"
        assert s["orders_count"] == 8
        assert s["turnover_by_currency"]["RUB"] == 8000.0
        assert s["seller_share_by_currency"]["RUB"] == 800.0
        assert s["has_financials"] is True
        assert s["_is_cloud"] is True


def test_sync_local_shift_to_cloud():
    """Verify local shift upload requires session and cleanses payload keys."""
    client = CloudSyncClient()
    payload = {
        "id": "loc-shift-1",
        "user_id": "usr-1",
        "seller_account_id": "1084291",
        "start_time": "2026-11-12T00:00:00Z",
        "end_time": "2026-11-12T04:00:00Z",
        "duration_seconds": 14400,  # Should NOT be sent (recomputed by DB trigger)
        "status": "completed",
    }

    # 1. Without session -> should reject
    assert client.sync_local_shift_to_cloud(payload) is False
    assert "Требуется вход оператора" in client.last_error

    # 2. With session -> should call _post with filtered payload
    client.set_session("valid_token", user_id="usr-1")
    with patch.object(client, "_post", return_value={"id": "loc-shift-1"}) as mock_post:
        result = client.sync_local_shift_to_cloud(payload)
        assert result is True
        mock_post.assert_called_once()
        sent_path, sent_body = mock_post.call_args[0]
        assert sent_path == "/rest/v1/shifts"
        assert "duration_seconds" not in sent_body
        assert sent_body["id"] == "loc-shift-1"
        assert sent_body["seller_account_id"] == "1084291"
        assert sent_body["status"] == "completed"
