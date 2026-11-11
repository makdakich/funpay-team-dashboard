-- ============================================================================
-- Миграция: 005_order_audit_logs.sql
-- Назначение: Журнал аудита ручных изменений атрибуции заказов.
--             Фиксирует историю, причину, старое/новое состояние и снимки имён.
--             Внешний ключ к orders использует ON DELETE RESTRICT (нельзя стереть
--             заказ, по которому ведётся аудит). Связи с profiles используют
--             ON DELETE SET NULL, сохраняя читаемость через *_display_name снимки.
-- Архитектура: FanPay Team Dashboard v2.4 (Single-Team Architecture)
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Таблица журнала аудита изменений заказов (order_audit_logs)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.order_audit_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    seller_account_id TEXT NOT NULL,
    order_id TEXT NOT NULL,
    old_operator_id UUID REFERENCES public.profiles(user_id) ON DELETE SET NULL,
    new_operator_id UUID REFERENCES public.profiles(user_id) ON DELETE SET NULL,
    old_operator_display_name TEXT,
    new_operator_display_name TEXT,
    old_attribution_status TEXT NOT NULL,
    new_attribution_status TEXT NOT NULL,
    old_attribution_source TEXT NOT NULL,
    new_attribution_source TEXT NOT NULL,
    changed_by_user_id UUID REFERENCES public.profiles(user_id) ON DELETE SET NULL,
    changed_by_display_name TEXT NOT NULL,
    reason TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- Связь с заказом защищена RESTRICT (аудит не может быть уничтожен удалением заказа)
    FOREIGN KEY (seller_account_id, order_id) 
        REFERENCES public.orders(seller_account_id, order_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_order_audit_order 
    ON public.order_audit_logs (seller_account_id, order_id);

CREATE INDEX IF NOT EXISTS idx_order_audit_changed_by 
    ON public.order_audit_logs (changed_by_user_id, created_at DESC);

-- ----------------------------------------------------------------------------
-- 2. Политики Row Level Security (RLS) и отзыв прав
-- ----------------------------------------------------------------------------
ALTER TABLE public.order_audit_logs ENABLE ROW LEVEL SECURITY;

-- Чтение аудита: доступно всей активной команде для прозрачности
DROP POLICY IF EXISTS "order_audit_logs_select" ON public.order_audit_logs;
CREATE POLICY "order_audit_logs_select" ON public.order_audit_logs
    FOR SELECT TO authenticated
    USING (public.is_active_team_member());

-- Прямая запись запрещена для всех клиентов (только через RPC reassign_order_operator)
REVOKE INSERT, UPDATE, DELETE ON public.order_audit_logs FROM authenticated, anon, PUBLIC;
GRANT SELECT ON public.order_audit_logs TO authenticated;
