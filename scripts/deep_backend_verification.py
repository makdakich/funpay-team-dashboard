import ssl
import json
import pg8000.native

HOST = "aws-0-eu-west-1.pooler.supabase.com"
PORT = 5432
USER = "postgres.zlpbywengymnvrpbcxvh"
DATABASE = "postgres"
PASSWORD = "NRWq9%U_z2e9T/b"

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

    print("=== DEEP BACKEND VERIFICATION REPORT ===")

    # 1. Helper security functions
    print("\n--- Security Helper Functions ---")
    helpers = ['is_active_team_member', 'is_team_owner', 'is_team_creator']
    for h in helpers:
        res = conn.run(f"SELECT proname, prosrc, prosecdef FROM pg_proc WHERE proname = '{h}'")
        if res:
            print(f"Function {h}: secdef={res[0][2]}")
            print(f"  Source: {res[0][1].strip()}")
        else:
            print(f"Function {h}: NOT FOUND")

    # 2. Table row counts
    print("\n--- Public Table Row Counts ---")
    tables = [
        'profiles',
        'team_seller_accounts',
        'orders',
        'shifts',
        'operator_status',
        'order_audit_logs',
        'order_financial_discrepancies',
        'profile_audit_logs',
        'shared_templates',
        '_tmp_pre010_profiles_snapshot'
    ]
    for tbl in tables:
        cnt = conn.run(f"SELECT count(*) FROM public.{tbl}")[0][0]
        print(f"  {tbl:<32}: {cnt} rows")

    # 3. Shifts breakdown
    print("\n--- Shifts Breakdown ---")
    shifts = conn.run("""
        SELECT status, count(*), 
               count(legacy_id) as legacy_count,
               min(start_time), max(start_time)
        FROM public.shifts
        GROUP BY status;
    """)
    for s in shifts:
        print(f"  status={s[0]}: count={s[1]}, legacy_count={s[2]}, min_start={s[3]}, max_start={s[4]}")

    # 4. Orders detail breakdown by seller, status, currency
    print("\n--- Orders Detailed Breakdown ---")
    order_breakdown = conn.run("""
        SELECT seller_account_id, status, currency, attribution_status, attribution_source, count(*), sum(amount)
        FROM public.orders
        GROUP BY seller_account_id, status, currency, attribution_status, attribution_source
        ORDER BY seller_account_id, currency, status;
    """)
    for ob in order_breakdown:
        print(f"  Seller: {ob[0]:<12} | Status: {ob[1]:<10} | Curr: {ob[2]} | AttrStatus: {ob[3]:<10} | AttrSource: {ob[4]:<10} | Count: {ob[5]:<5} | Sum: {ob[6]}")

    # Check Nov 8 orders for seller 4473774 and SELLER_MAIN
    print("\n--- Nov 8, 2026 Orders Check ---")
    nov8_orders = conn.run("""
        SELECT seller_account_id, status, count(*), sum(amount)
        FROM public.orders
        WHERE funpay_created_at >= '2026-11-08 00:00:00+00' AND funpay_created_at < '2026-11-09 00:00:00+00'
        GROUP BY seller_account_id, status;
    """)
    for row in nov8_orders:
        print(f"  Seller: {row[0]}, Status: {row[1]}, Count: {row[2]}, Sum: {row[3]}")

    # Also check Nov 8 in MSK timezone (UTC+3)
    print("\n--- Nov 8, 2026 Orders Check (MSK: UTC+3) ---")
    nov8_msk = conn.run("""
        SELECT seller_account_id, status, count(*), sum(amount)
        FROM public.orders
        WHERE (funpay_created_at AT TIME ZONE 'Europe/Moscow')::date = '2026-11-08'
        GROUP BY seller_account_id, status;
    """)
    for row in nov8_msk:
        print(f"  [MSK] Seller: {row[0]}, Status: {row[1]}, Count: {row[2]}, Sum: {row[3]}")

    # 5. Financial Discrepancies check
    print("\n--- Financial Discrepancies Records ---")
    discrepancies = conn.run("SELECT * FROM public.order_financial_discrepancies LIMIT 10;")
    print(f"Discrepancies found: {len(discrepancies)}")
    for d in discrepancies:
        print(f"  {d}")

    # Check for any test prefixes
    test_orders = conn.run("SELECT count(*) FROM public.orders WHERE order_id LIKE 'TEST%';")[0][0]
    print(f"Orders with 'TEST%' prefix: {test_orders}")

    # 6. Check auth.users vs public.profiles
    print("\n--- auth.users vs public.profiles ---")
    auth_users = conn.run("SELECT id, email, created_at, last_sign_in_at FROM auth.users;")
    print(f"Auth users count: {len(auth_users)}")
    for au in auth_users:
        print(f"  auth.user: id={au[0]}, email={au[1]}, created={au[2]}, last_sign_in={au[3]}")

    # 7. Check update_seller_account_balance validation & execution
    print("\n--- team_seller_accounts status ---")
    tsa = conn.run("SELECT seller_account_id, account_name, is_active, total_balance, balance_currency, balances, balance_updated_at FROM public.team_seller_accounts;")
    for row in tsa:
        print(f"  Account: {row[0]} ({row[1]}), Active: {row[2]}, Total: {row[3]} {row[4]}, Balances: {row[5]}, Updated: {row[6]}")

    conn.close()

if __name__ == '__main__':
    main()
