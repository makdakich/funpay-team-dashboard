import os
import sys
import ssl
import json
import pg8000.native

HOST = "aws-0-eu-west-1.pooler.supabase.com"
PORT = 5432
USER = "postgres.zlpbywengymnvrpbcxvh"
DATABASE = "postgres"
PASSWORD = "NRWq9%U_z2e9T/b"

def run_query(conn, query, params=None):
    if params:
        return conn.run(query, **params)
    return conn.run(query)

def main():
    ssl_context = ssl.create_default_context()
    ssl_context.check_hostname = False
    ssl_context.verify_mode = ssl.CERT_NONE

    print("Connecting to Supabase PostgreSQL...")
    conn = pg8000.native.Connection(
        user=USER,
        password=PASSWORD,
        host=HOST,
        port=PORT,
        database=DATABASE,
        ssl_context=ssl_context,
        timeout=60
    )
    print("Connected successfully!\n")

    # 1. Tables and RLS
    print("=== 1. TABLES & RLS STATUS ===")
    tables = conn.run("""
        SELECT tablename, rowsecurity 
        FROM pg_tables 
        WHERE schemaname = 'public' 
        ORDER BY tablename;
    """)
    for t in tables:
        print(f"Table: {t[0]:<35} RLS: {t[1]}")

    print("\n=== RLS POLICIES ===")
    policies = conn.run("""
        SELECT tablename, policyname, permissive, roles, cmd, qual, with_check
        FROM pg_policies
        WHERE schemaname = 'public'
        ORDER BY tablename, policyname;
    """)
    for p in policies:
        print(f"[{p[0]}] {p[1]} | cmd: {p[4]} | roles: {p[3]}")

    # Foreign keys
    print("\n=== FOREIGN KEYS ===")
    fks = conn.run("""
        SELECT
            tc.table_name, kcu.column_name,
            ccu.table_name AS foreign_table_name,
            ccu.column_name AS foreign_column_name,
            rc.update_rule, rc.delete_rule
        FROM information_schema.table_constraints AS tc
        JOIN information_schema.key_column_usage AS kcu
            ON tc.constraint_name = kcu.constraint_name
            AND tc.table_schema = kcu.table_schema
        JOIN information_schema.constraint_column_usage AS ccu
            ON ccu.constraint_name = tc.constraint_name
            AND ccu.table_schema = tc.table_schema
        JOIN information_schema.referential_constraints AS rc
            ON rc.constraint_name = tc.constraint_name
        WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public'
        ORDER BY tc.table_name;
    """)
    for fk in fks:
        print(f"{fk[0]}.{fk[1]} -> {fk[2]}.{fk[3]} (ON UPDATE {fk[4]}, ON DELETE {fk[5]})")

    # Indexes
    print("\n=== INDEXES ===")
    indexes = conn.run("""
        SELECT tablename, indexname, indexdef
        FROM pg_indexes
        WHERE schemaname = 'public'
        ORDER BY tablename, indexname;
    """)
    for idx in indexes:
        print(f"[{idx[0]}] {idx[1]}: {idx[2]}")

    # 2. RPC Functions
    print("\n=== 2. RPC FUNCTIONS AUDIT ===")
    target_functions = [
        'sync_orders_batch',
        'reassign_order_operator',
        'import_legacy_shifts',
        'update_profile_display_name',
        'update_seller_account_balance'
    ]
    funcs = conn.run("""
        SELECT p.proname, pg_get_function_identity_arguments(p.oid) as args,
               pg_get_function_result(p.oid) as return_type,
               p.prosecdef, p.prosrc
        FROM pg_proc p
        JOIN pg_namespace n ON p.pronamespace = n.oid
        WHERE n.nspname = 'public'
        ORDER BY p.proname;
    """)
    found_funcs = {}
    for f in funcs:
        found_funcs[f[0]] = {
            'args': f[1],
            'return_type': f[2],
            'secdef': f[3],
            'src': f[4]
        }
    for tf in target_functions:
        if tf in found_funcs:
            print(f"Function {tf}: FOUND")
            print(f"  Args: {found_funcs[tf]['args']}")
            print(f"  Returns: {found_funcs[tf]['return_type']}")
            print(f"  Security Definer: {found_funcs[tf]['secdef']}")
        else:
            print(f"Function {tf}: MISSING!")

    # 3. Analyze public.orders data & team_seller_accounts
    print("\n=== 3. DATA ANALYSIS: ORDERS & SELLER ACCOUNTS ===")
    tsa_cols = conn.run("""
        SELECT column_name, data_type 
        FROM information_schema.columns 
        WHERE table_schema = 'public' AND table_name = 'team_seller_accounts'
        ORDER BY ordinal_position;
    """)
    print("team_seller_accounts columns:", [c[0] for c in tsa_cols])
    
    seller_accs = conn.run("SELECT * FROM public.team_seller_accounts;")
    print("Team Seller Accounts:")
    for sa in seller_accs:
        print(f"  {sa}")

    order_cols = conn.run("""
        SELECT column_name, data_type 
        FROM information_schema.columns 
        WHERE table_schema = 'public' AND table_name = 'orders'
        ORDER BY ordinal_position;
    """)
    print("\norders columns:", [c[0] for c in order_cols])

    order_counts_by_seller = conn.run("""
        SELECT seller_account_id, count(*), 
               min(funpay_created_at), max(funpay_created_at),
               count(DISTINCT currency) as currencies,
               array_agg(DISTINCT currency) as currency_list
        FROM public.orders
        GROUP BY seller_account_id;
    """)
    print("\nOrders count grouped by seller_account_id:")
    for row in order_counts_by_seller:
        print(f"  seller_account_id={row[0]} -> count={row[1]}, min_date={row[2]}, max_date={row[3]}, currencies={row[5]}")

    total_orders = conn.run("SELECT count(*) FROM public.orders;")[0][0]
    print(f"\nTotal orders in public.orders: {total_orders}")

    # 4. User Profiles & Roles
    print("\n=== 4. PROFILES & ROLES ===")
    prof_cols = conn.run("""
        SELECT column_name, data_type 
        FROM information_schema.columns 
        WHERE table_schema = 'public' AND table_name = 'profiles'
        ORDER BY ordinal_position;
    """)
    print("profiles columns:", [c[0] for c in prof_cols])

    profiles = conn.run("SELECT * FROM public.profiles;")
    print(f"Total profiles: {len(profiles)}")
    for prof in profiles:
        print(f"  {prof}")

    # Check constraints on profiles
    prof_constraints = conn.run("""
        SELECT conname, pg_get_constraintdef(oid) 
        FROM pg_constraint 
        WHERE conrelid = 'public.profiles'::regclass;
    """)
    print("\nProfiles constraints:")
    for pc in prof_constraints:
        print(f"  {pc[0]}: {pc[1]}")

    # 5. Order attribution status
    print("\n=== 5. ORDER ATTRIBUTION DISTRIBUTION ===")
    attr_dist = conn.run("""
        SELECT attribution_status, count(*), count(operator_id) as with_operator
        FROM public.orders
        GROUP BY attribution_status;
    """)
    for ad in attr_dist:
        print(f"  Attribution: {ad[0]} -> {ad[1]} orders (with operator_id: {ad[2]})")

    # 6. Monetary columns precision and types
    print("\n=== 6. MONETARY COLUMNS DATA TYPES ===")
    monetary_cols = conn.run("""
        SELECT table_name, column_name, data_type, numeric_precision, numeric_scale
        FROM information_schema.columns
        WHERE table_schema = 'public' 
          AND column_name IN ('price', 'amount', 'balance', 'total_balance_rub', 'total_balance_usd', 'total_balance_eur', 'revenue', 'commission')
        ORDER BY table_name, column_name;
    """)
    for mc in monetary_cols:
        print(f"  {mc[0]}.{mc[1]}: {mc[2]}({mc[3]},{mc[4]})")

    conn.close()
    print("\nAudit completed.")

if __name__ == '__main__':
    main()
