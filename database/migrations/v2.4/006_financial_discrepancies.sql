-- ============================================================================
-- Миграция: 006_financial_discrepancies.sql
-- Назначение: Реестр финансовых расхождений и аномалий времени, обнаруженных
--             при перекрёстной синхронизации заказов.
--             Защищает от скрытой подмены данных и фиксирует инциденты для владельца.
--             Защищён от удаления через ON DELETE RESTRICT и дедуплицирован.
-- Архитектура: FunPay Team Dashboard v2.4 (Single-Team Architecture)
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Таблица финансовых расхождений (order_financial_discrepancies)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.order_financial_discrepancies (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    seller_account_id TEXT NOT NULL,
    order_id TEXT NOT NULL,
    existing_amount NUMERIC(12, 2) NOT NULL,
    existing_currency TEXT NOT NULL,
    incoming_amount NUMERIC(12, 2) NOT NULL,
    incoming_currency TEXT NOT NULL,
    discrepancy_type TEXT NOT NULL DEFAULT 'amount_currency' 
        CHECK (discrepancy_type IN ('amount_currency', 'created_at_mismatch')),
    existing_funpay_created_at TIMESTAMPTZ,
    incoming_funpay_created_at TIMESTAMPTZ,
    initial_synced_by_user_id UUID NOT NULL REFERENCES public.profiles(user_id) ON DELETE RESTRICT,
    incoming_synced_by_user_id UUID NOT NULL REFERENCES public.profiles(user_id) ON DELETE RESTRICT,
    detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- Связь с заказом защищена RESTRICT: улика расхождения не может быть уничтожена
    FOREIGN KEY (seller_account_id, order_id) 
        REFERENCES public.orders(seller_account_id, order_id) ON DELETE RESTRICT,
    -- Дедупликация: исключает накопление идентичных записей инцидента при повторной синхронизации
    CONSTRAINT uq_order_discrepancy UNIQUE (
        seller_account_id, order_id, incoming_synced_by_user_id, incoming_amount, incoming_currency, discrepancy_type
    )
);

CREATE INDEX IF NOT EXISTS idx_discrepancies_order 
    ON public.order_financial_discrepancies (seller_account_id, order_id);

CREATE INDEX IF NOT EXISTS idx_discrepancies_time 
    ON public.order_financial_discrepancies (detected_at DESC);

-- ----------------------------------------------------------------------------
-- 2. Политики Row Level Security (RLS) и отзыв прав
-- ----------------------------------------------------------------------------
ALTER TABLE public.order_financial_discrepancies ENABLE ROW LEVEL SECURITY;

-- Просмотр инцидентов расхождений доступен только руководителю команды (owner)
DROP POLICY IF EXISTS "order_discrepancies_select_owner" ON public.order_financial_discrepancies;
CREATE POLICY "order_discrepancies_select_owner" ON public.order_financial_discrepancies
    FOR SELECT TO authenticated
    USING (public.is_team_owner());

-- Прямая запись запрещена для всех клиентов (только через RPC sync_orders_batch)
REVOKE INSERT, UPDATE, DELETE ON public.order_financial_discrepancies FROM authenticated, anon, PUBLIC;
GRANT SELECT ON public.order_financial_discrepancies TO authenticated;
