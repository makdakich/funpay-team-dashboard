-- ============================================================================
-- Миграция: 002_team_seller_accounts.sql
-- Назначение: Реестр авторизованных аккаунтов продавца FunPay для команды.
--             Защищает от синхронизации заказов под произвольными или чужими ID.
-- Архитектура: FunPay Team Dashboard v2.4 (Single-Team Architecture)
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Таблица авторизованных аккаунтов продавца (team_seller_accounts)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.team_seller_accounts (
    seller_account_id TEXT PRIMARY KEY,
    account_name TEXT NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_team_seller_active 
    ON public.team_seller_accounts(seller_account_id, is_active);

-- ----------------------------------------------------------------------------
-- 2. Политики Row Level Security (RLS)
-- ----------------------------------------------------------------------------
ALTER TABLE public.team_seller_accounts ENABLE ROW LEVEL SECURITY;

-- Чтение: доступно любому активному участнику команды
DROP POLICY IF EXISTS "team_seller_accounts_select" ON public.team_seller_accounts;
CREATE POLICY "team_seller_accounts_select" ON public.team_seller_accounts
    FOR SELECT TO authenticated
    USING (public.is_active_team_member());

-- Управление (добавление, редактирование, деактивация): разрешено ТОЛЬКО руководителю (owner)
DROP POLICY IF EXISTS "team_seller_accounts_admin_all" ON public.team_seller_accounts;
CREATE POLICY "team_seller_accounts_admin_all" ON public.team_seller_accounts
    FOR ALL TO authenticated
    USING (public.is_team_owner())
    WITH CHECK (public.is_team_owner());

-- Предоставляем базовые права роли authenticated (фактические операции фильтруются RLS-политиками)
GRANT SELECT, INSERT, UPDATE, DELETE ON public.team_seller_accounts TO authenticated;
REVOKE ALL ON public.team_seller_accounts FROM anon;
