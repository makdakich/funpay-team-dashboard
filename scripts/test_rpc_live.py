import ssl
import json
import pg8000.native

HOST = "aws-0-eu-west-1.pooler.supabase.com"
PORT = 5432
USER = "postgres.zlpbywengymnvrpbcxvh"
DATABASE = "postgres"
PASSWORD = "NRWq9%U_z2e9T/b"

ALEX_ID = "34a83ee3-dbc8-49c3-8982-c1ada97f094f"

def main():
    ssl_context = ssl.create_default_context()
    ssl_context.check_hostname = False
    ssl_context.verify_mode = ssl.CERT_NONE

    conn = pg8000.native.Connection(
        user=USER,
        password=PASSWORD,
        host=HOST,
        port=PORT,
        database=DATABASE,
        ssl_context=ssl_context,
        timeout=60
    )

    print("--- 1. Testing Auth Context ---")
    conn.run("BEGIN;")
    claims = json.dumps({"sub": ALEX_ID, "role": "authenticated"})
    conn.run(f"SET LOCAL request.jwt.claims = '{claims}';")
    conn.run("SET LOCAL ROLE authenticated;")
    uid_res = conn.run("SELECT auth.uid(), auth.role();")
    print(f"auth.uid: {uid_res[0][0]}, role: {uid_res[0][1]}")
    membership = conn.run("SELECT public.is_active_team_member(), public.is_team_owner();")
    print(f"is_active_team_member: {membership[0][0]}, is_team_owner: {membership[0][1]}")

    print("\n--- 2. Testing update_profile_display_name ---")
    res_rename = conn.run("SELECT public.update_profile_display_name('Алекс');")
    print(f"Renamed result: {res_rename[0][0]}")
    
    # Test invalid short name validation
    res_short = conn.run("SELECT public.update_profile_display_name('A');")
    print(f"Short name result (expected error): {res_short[0][0]}")

    print("\n--- 3. Testing update_seller_account_balance ---")
    balances = json.dumps({"RUB": 27242, "USD": 0, "EUR": 0, "KZT": 0})
    res_bal = conn.run(f"SELECT public.update_seller_account_balance('4473774', 27242.00, '{balances}'::jsonb, 'RUB');")
    print(f"Balance update result: {res_bal[0][0]}")

    print("\n--- 4. Testing sync_orders_batch (Dry-run / Rollback) ---")
    test_orders = json.dumps([{
        "order_id": "TEST_AUDIT_ORDER_9999",
        "amount": "150.00",
        "currency": "RUB",
        "status": "closed",
        "funpay_created_at": "2026-11-12T10:00:00Z",
        "buyer_id": "999999",
        "buyer_username": "TestBuyer",
        "title": "Test Title",
        "description": "Test Desc",
        "subcategory": "Test Subcat"
    }])
    res_sync = conn.run(f"SELECT public.sync_orders_batch('4473774', '{test_orders}'::jsonb);")
    print(f"Sync orders batch result: {res_sync[0][0]}")

    # Test bad amount format
    bad_orders = json.dumps([{
        "order_id": "TEST_AUDIT_ORDER_BAD",
        "amount": "150.001", # invalid decimal format
        "currency": "RUB",
        "status": "closed",
        "funpay_created_at": "2026-11-12T10:00:00Z"
    }])
    res_bad_sync = conn.run(f"SELECT public.sync_orders_batch('4473774', '{bad_orders}'::jsonb);")
    print(f"Bad amount format result (expected error): {res_bad_sync[0][0]}")

    print("\n--- 5. Testing reassign_order_operator ---")
    # Using the test order just synced in transaction
    conn.run(f"SELECT public.reassign_order_operator('4473774', 'TEST_AUDIT_ORDER_9999', '{ALEX_ID}'::uuid, 'Аудит системы backend_agent');")
    reassigned_order = conn.run(f"SELECT order_id, operator_id, attribution_status, attribution_source FROM public.orders WHERE seller_account_id = '4473774' AND order_id = 'TEST_AUDIT_ORDER_9999';")
    print(f"Reassigned order state: {reassigned_order[0]}")
    audit_log = conn.run(f"SELECT order_id, old_operator_id, new_operator_id, reason, changed_by_display_name FROM public.order_audit_logs WHERE order_id = 'TEST_AUDIT_ORDER_9999';")
    print(f"Order audit log entry: {audit_log[0]}")

    print("\n--- 6. Testing import_legacy_shifts idempotency ---")
    legacy_payload = json.dumps([{
        "id": "shift_1793598974895_mn16fe", # already exists in DB!
        "startTime": 1793598960000,
        "endTime": 1793615520000,
        "duration": 16560000
    }])
    res_import = conn.run(f"SELECT public.import_legacy_shifts('{legacy_payload}'::jsonb);")
    print(f"Import legacy shifts result (should skip existing): {res_import[0][0]}")

    # ALWAYS ROLLBACK test changes to leave database untouched!
    conn.run("ROLLBACK;")
    print("\nTransaction rolled back successfully. No test data persisted.")
    conn.close()

if __name__ == '__main__':
    main()
