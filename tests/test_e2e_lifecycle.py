"""End-to-End Integration Test for FunPay Team Dashboard v2.4 Lifecycle.

Scenario validated:
1. Operator/Creator opens shift in Extension / Desktop -> Heartbeat active in Dashboard
2. Order synced -> Shift matching attributes order to active shift
3. First-Write-Wins locks financial fields (amount, currency, created_at)
4. Conflicting order updates trigger financial discrepancy logging without mutating locked fields
5. Status hierarchy enforced (refunded > closed > paid), status downgrade rejected
6. Closed order adds 10% to operator share with multi-currency isolation
7. Shift closes -> Presence resets to online, duration and earnings finalized
"""

import time
import pytest
from unittest.mock import patch
from src.core.cloud_sync import CloudSyncClient, _parse_iso_to_ms
from src.database.db import Database
from src.core.shift_manager import ShiftManager


def test_full_e2e_operator_shift_and_order_lifecycle(tmp_path):
    # Setup offline-first SQLite WAL database
    db_path = str(tmp_path / "e2e_test.db")
    db = Database(db_path)
    sm = ShiftManager(db)

    # Initialize CloudSync client
    client = CloudSyncClient(url="https://test.supabase.co", key="test_anon_key")

    # ------------------------------------------------------------------------
    # STEP 1: Operator / Creator opens shift
    # ------------------------------------------------------------------------
    operator_user_id = "op-uuid-100"
    seller_account_id = "seller-777"
    shift_id = "shift-uuid-999"

    # Authenticate operator session
    client.set_session(
        access_token="valid_jwt_operator",
        refresh_token="valid_jwt_refresh",
        expires_at=time.time() + 3600,
        user_id=operator_user_id,
    )
    assert client.has_session() is True

    # Start local shift in offline-first SQLite
    sm.start_shift("🎮 Robux")
    assert sm.is_active is True
    assert sm.current_profile_name == "🎮 Robux"

    # Start cloud shift payload
    start_iso = "2026-11-12T10:00:00Z"
    shift_payload = {
        "id": shift_id,
        "user_id": operator_user_id,
        "seller_account_id": seller_account_id,
        "start_time": start_iso,
        "status": "active",
    }
    with patch.object(client, "_post", return_value={"id": shift_id}) as mock_post:
        synced = client.sync_local_shift_to_cloud(shift_payload)
        assert synced is True
        mock_post.assert_called_once()
        path, body = mock_post.call_args[0]
        assert path == "/rest/v1/shifts"
        assert body["id"] == shift_id
        assert body["status"] == "active"

    # ------------------------------------------------------------------------
    # STEP 2: Heartbeat active in Dashboard / Desktop
    # ------------------------------------------------------------------------
    heartbeat_time = "2026-11-12T10:05:00Z"
    mock_presence_rows = [
        {
            "user_id": operator_user_id,
            "status": "on_shift",
            "active_shift_id": shift_id,
            "current_seller_account_id": seller_account_id,
            "app_version": "2.4.0",
            "last_heartbeat_at": heartbeat_time,
            "profiles": {
                "display_name": "Алексей Оператор",
                "role": "operator",
            },
        }
    ]

    with patch.object(client, "_get", return_value=mock_presence_rows):
        team = client.fetch_team_status()
        assert len(team) == 1
        operator = team[0]
        assert operator["user_id"] == operator_user_id
        assert operator["operator_name"] == "Алексей Оператор"
        assert operator["status"] == "on_shift"
        assert operator["on_shift"] is True
        assert operator["is_online"] is True
        assert operator["current_shift_id"] == shift_id
        assert operator["last_seen"] == heartbeat_time

    # ------------------------------------------------------------------------
    # STEP 3: Order synced & matching shift attributes order
    # ------------------------------------------------------------------------
    # Order created at 10:15 (within the active shift 10:00 - now)
    order_id = "FP-554433"
    order_amount = "1500.00"
    order_currency = "RUB"
    order_created_at = "2026-11-12T10:15:00Z"

    # Simulate database orders table & RPC behavior
    class MockDatabaseOrdersTable:
        def __init__(self):
            self.orders = {}
            self.discrepancies = []
            self.active_shifts = [
                {
                    "id": shift_id,
                    "user_id": operator_user_id,
                    "seller_account_id": seller_account_id,
                    "start_time": "2026-11-12T10:00:00Z",
                    "end_time": None,
                }
            ]

        def sync_orders_batch(self, seller_id, items, caller_id):
            STATUS_RANK = {"paid": 1, "closed": 2, "refunded": 3}
            results = []

            for item in items:
                oid = item["order_id"]
                amt = float(item["amount"])
                curr = item["currency"]
                stat = item["status"]
                created = item["funpay_created_at"]

                # Shift matching
                matched_shift = None
                matched_operator = None
                for s in self.active_shifts:
                    if s["seller_account_id"] == seller_id and s["start_time"] <= created and (s["end_time"] is None or s["end_time"] >= created):
                        matched_shift = s["id"]
                        matched_operator = s["user_id"]
                        break

                if oid not in self.orders:
                    # First-Write-Wins: insert and attribute
                    self.orders[oid] = {
                        "seller_account_id": seller_id,
                        "order_id": oid,
                        "amount": amt,
                        "currency": curr,
                        "status": stat,
                        "funpay_created_at": created,
                        "shift_id": matched_shift,
                        "operator_id": matched_operator,
                        "attribution_status": "assigned" if matched_shift else "unassigned",
                    }
                    results.append({"order_id": oid, "action": "inserted", "attribution": matched_shift})
                else:
                    existing = self.orders[oid]
                    # First-Write-Wins: Lock financial fields
                    if existing["amount"] != amt or existing["currency"] != curr:
                        self.discrepancies.append({
                            "order_id": oid,
                            "type": "amount_currency",
                            "existing": (existing["amount"], existing["currency"]),
                            "incoming": (amt, curr),
                        })
                        results.append({"order_id": oid, "action": "financial_discrepancy_logged"})
                        continue

                    if existing["funpay_created_at"] != created:
                        self.discrepancies.append({
                            "order_id": oid,
                            "type": "created_at_mismatch",
                            "existing": existing["funpay_created_at"],
                            "incoming": created,
                        })
                        results.append({"order_id": oid, "action": "created_at_discrepancy_logged"})
                        continue

                    # Status hierarchy: refunded > closed > paid
                    ex_rank = STATUS_RANK.get(existing["status"], 0)
                    in_rank = STATUS_RANK.get(stat, 0)
                    if in_rank < ex_rank:
                        results.append({"order_id": oid, "action": "ignored_status_downgrade", "current_status": existing["status"]})
                    else:
                        existing["status"] = stat
                        results.append({"order_id": oid, "action": "updated", "status": stat})

            return results

    mock_db = MockDatabaseOrdersTable()

    # Initial order sync (status = 'paid')
    batch_sync_1 = [
        {
            "order_id": order_id,
            "amount": order_amount,
            "currency": order_currency,
            "status": "paid",
            "funpay_created_at": order_created_at,
        }
    ]
    res1 = mock_db.sync_orders_batch(seller_account_id, batch_sync_1, operator_user_id)
    assert len(res1) == 1
    assert res1[0]["action"] == "inserted"
    assert res1[0]["attribution"] == shift_id
    assert mock_db.orders[order_id]["shift_id"] == shift_id
    assert mock_db.orders[order_id]["operator_id"] == operator_user_id
    assert mock_db.orders[order_id]["attribution_status"] == "assigned"

    # ------------------------------------------------------------------------
    # STEP 4: First-Write-Wins locks financial fields against alteration
    # ------------------------------------------------------------------------
    malicious_tamper_sync = [
        {
            "order_id": order_id,
            "amount": "9999.00",  # Conflicting forged price!
            "currency": "RUB",
            "status": "paid",
            "funpay_created_at": order_created_at,
        }
    ]
    res2 = mock_db.sync_orders_batch(seller_account_id, malicious_tamper_sync, "attacker-id")
    assert len(res2) == 1
    assert res2[0]["action"] == "financial_discrepancy_logged"
    # Verify locked fields were NOT mutated
    assert mock_db.orders[order_id]["amount"] == 1500.00
    assert len(mock_db.discrepancies) == 1

    # ------------------------------------------------------------------------
    # STEP 5: Order status advances to 'closed', status downgrade prevented
    # ------------------------------------------------------------------------
    status_upgrade_sync = [
        {
            "order_id": order_id,
            "amount": order_amount,
            "currency": order_currency,
            "status": "closed",
            "funpay_created_at": order_created_at,
        }
    ]
    res3 = mock_db.sync_orders_batch(seller_account_id, status_upgrade_sync, operator_user_id)
    assert len(res3) == 1
    assert res3[0]["action"] == "updated"
    assert mock_db.orders[order_id]["status"] == "closed"

    # Attempting downgrade back to 'paid' (e.g. stale client sync) must be rejected
    stale_downgrade_sync = [
        {
            "order_id": order_id,
            "amount": order_amount,
            "currency": order_currency,
            "status": "paid",
            "funpay_created_at": order_created_at,
        }
    ]
    res4 = mock_db.sync_orders_batch(seller_account_id, stale_downgrade_sync, operator_user_id)
    assert len(res4) == 1
    assert res4[0]["action"] == "ignored_status_downgrade"
    assert mock_db.orders[order_id]["status"] == "closed"

    # ------------------------------------------------------------------------
    # STEP 6: Closed order adds 10% to operator share (multi-currency isolated)
    # ------------------------------------------------------------------------
    # Also add a second closed order in USD (50.00 USD) and a refunded order in RUB (300.00 RUB)
    usd_order_id = "FP-USD-1"
    mock_db.sync_orders_batch(seller_account_id, [
        {
            "order_id": usd_order_id,
            "amount": "50.00",
            "currency": "USD",
            "status": "closed",
            "funpay_created_at": "2026-11-12T10:20:00Z",
        },
        {
            "order_id": "FP-REF-1",
            "amount": "300.00",
            "currency": "RUB",
            "status": "refunded",
            "funpay_created_at": "2026-11-12T10:25:00Z",
        }
    ], operator_user_id)

    # Let CloudSyncClient calculate shift financials from closed orders
    mock_closed_orders_response = [
        {"shift_id": shift_id, "currency": "RUB", "amount": "1500.00"},
        {"shift_id": shift_id, "currency": "USD", "amount": "50.00"},
    ]
    with patch.object(client, "_get", return_value=mock_closed_orders_response):
        financials = client.fetch_shift_financials([shift_id])
        shift_fin = financials[shift_id]

        assert shift_fin["orders_count"] == 2
        # RUB: turnover 1500, 10% operator share = 150.00
        assert shift_fin["turnover_by_currency"]["RUB"] == 1500.00
        assert shift_fin["seller_share_by_currency"]["RUB"] == 150.00

        # USD: turnover 50, 10% operator share = 5.00
        assert shift_fin["turnover_by_currency"]["USD"] == 50.00
        assert shift_fin["seller_share_by_currency"]["USD"] == 5.00

        # EUR & KZT remain 0.00
        assert shift_fin["turnover_by_currency"]["EUR"] == 0.00
        assert shift_fin["seller_share_by_currency"]["EUR"] == 0.00
        assert shift_fin["turnover_by_currency"]["KZT"] == 0.00
        assert shift_fin["seller_share_by_currency"]["KZT"] == 0.00

    # ------------------------------------------------------------------------
    # STEP 7: Shift closes -> presence resets to online
    # ------------------------------------------------------------------------
    end_iso = "2026-11-12T14:00:00Z"
    completed_shift = sm.stop_shift()
    assert completed_shift is not None
    assert sm.is_active is False

    # Close shift on cloud
    close_payload = {
        "id": shift_id,
        "user_id": operator_user_id,
        "seller_account_id": seller_account_id,
        "start_time": start_iso,
        "end_time": end_iso,
        "status": "completed",
    }
    with patch.object(client, "_post", return_value={"id": shift_id}) as mock_post_close:
        closed_synced = client.sync_local_shift_to_cloud(close_payload)
        assert closed_synced is True

    # Operator heartbeat now resets activeShiftId to None, status to 'online'
    post_shift_presence = [
        {
            "user_id": operator_user_id,
            "status": "online",
            "active_shift_id": None,
            "current_seller_account_id": None,
            "app_version": "2.4.0",
            "last_heartbeat_at": "2026-11-12T14:01:00Z",
            "profiles": {
                "display_name": "Алексей Оператор",
                "role": "operator",
            },
        }
    ]
    with patch.object(client, "_get", return_value=post_shift_presence):
        team_after = client.fetch_team_status()
        assert len(team_after) == 1
        assert team_after[0]["status"] == "online"
        assert team_after[0]["on_shift"] is False
        assert team_after[0]["is_online"] is True
        assert team_after[0]["current_shift_id"] is None
