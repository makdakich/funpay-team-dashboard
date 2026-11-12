-- ============================================================================
-- Миграция: 004_orders.sql
-- Назначение: Реестр заказов FunPay с составным первичным ключом, индексами,
--             защитой неизменяемых финансовых полей и идентификаторов
--             и строгим ограничением прямого доступа (запись только через RPC).
-- Архитектура: FunPay Team Dashboard v2.4 (Single-Team Architecture)
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Таблица заказов FunPay (orders)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.orders (
    seller_account_id TEXT NOT NULL REFERENCES public.team_seller_accounts(seller_account_id) ON DELETE RESTRICT,
    order_id TEXT NOT NULL,
    buyer_id TEXT,
    buyer_username TEXT,
    title TEXT,
    description TEXT,
    subcategory TEXT,
    amount NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
    currency TEXT NOT NULL CHECK (currency IN ('RUB', 'USD', 'EUR', 'KZT')),
    status TEXT NOT NULL CHECK (status IN ('paid', 'closed', 'refunded')),
    funpay_created_at TIMESTAMPTZ NOT NULL,
    operator_id UUID REFERENCES public.profiles(user_id) ON DELETE SET NULL,
    shift_id UUID REFERENCES public.shifts(id) ON DELETE SET NULL,
    attribution_status TEXT NOT NULL DEFAULT 'unassigned' 
        CHECK (attribution_status IN ('unassigned', 'assigned', 'ambiguous')),
    attribution_source TEXT NOT NULL DEFAULT 'none' 
        CHECK (attribution_source IN ('none', 'automatic', 'manual')),
    synced_by_user_id UUID NOT NULL REFERENCES public.profiles(user_id) ON DELETE RESTRICT,
    last_synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (seller_account_id, order_id)
);

-- ----------------------------------------------------------------------------
-- 2. Индексы для высокопроизводительной аналитики и синхронизации
-- ----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_orders_attribution 
    ON public.orders (operator_id, funpay_created_at) 
    WHERE operator_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_orders_status_currency 
    ON public.orders (seller_account_id, currency, status);

CREATE INDEX IF NOT EXISTS idx_orders_funpay_time 
    ON public.orders (seller_account_id, funpay_created_at DESC);

CREATE INDEX IF NOT EXISTS idx_orders_shift 
    ON public.orders (shift_id) 
    WHERE shift_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_orders_synced_by 
    ON public.orders (synced_by_user_id);

-- ----------------------------------------------------------------------------
-- 3. Защитный триггер иммутабельности ключевых финансовых полей и идентификаторов
-- ----------------------------------------------------------------------------
-- Дополнительный эшелон защиты на уровне ядра СУБД: запрещает изменение суммы,
-- валюты, даты создания FunPay, buyer_id, created_at и создателя заказа при любых UPDATE.
CREATE OR REPLACE FUNCTION public.trg_fn_protect_order_immutable_fields()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF NEW.seller_account_id IS DISTINCT FROM OLD.seller_account_id THEN
        RAISE EXCEPTION 'Запрещено изменять seller_account_id заказа';
    END IF;
    IF NEW.order_id IS DISTINCT FROM OLD.order_id THEN
        RAISE EXCEPTION 'Запрещено изменять order_id заказа';
    END IF;
    IF NEW.amount IS DISTINCT FROM OLD.amount THEN
        RAISE EXCEPTION 'Запрещено изменять сумму (amount) существующего заказа';
    END IF;
    IF NEW.currency IS DISTINCT FROM OLD.currency THEN
        RAISE EXCEPTION 'Запрещено изменять валюту (currency) существующего заказа';
    END IF;
    IF NEW.funpay_created_at IS DISTINCT FROM OLD.funpay_created_at THEN
        RAISE EXCEPTION 'Запрещено изменять дату создания заказа на FunPay';
    END IF;
    IF NEW.synced_by_user_id IS DISTINCT FROM OLD.synced_by_user_id THEN
        RAISE EXCEPTION 'Запрещено изменять автора первой синхронизации (synced_by_user_id)';
    END IF;
    IF NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'Запрещено изменять дату первичного сохранения (created_at)';
    END IF;
    IF OLD.buyer_id IS NOT NULL AND NEW.buyer_id IS DISTINCT FROM OLD.buyer_id THEN
        RAISE EXCEPTION 'Запрещено изменять buyer_id зафиксированного покупателя';
    END IF;

    NEW.updated_at := NOW();
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_protect_order_fields ON public.orders;
CREATE TRIGGER trg_protect_order_fields
    BEFORE UPDATE ON public.orders
    FOR EACH ROW
    EXECUTE FUNCTION public.trg_fn_protect_order_immutable_fields();

-- ----------------------------------------------------------------------------
-- 4. Политики Row Level Security (RLS) и отзыв прямых прав на запись
-- ----------------------------------------------------------------------------
ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;

-- Чтение: доступно всей активной команде
DROP POLICY IF EXISTS "orders_select_policy" ON public.orders;
CREATE POLICY "orders_select_policy" ON public.orders
    FOR SELECT TO authenticated
    USING (public.is_active_team_member());

-- КРИТИЧЕСКАЯ БЕЗОПАСНОСТЬ: прямой INSERT, UPDATE и DELETE из клиентского API отозваны.
-- Любая запись в orders осуществляется исключительно через безопасные RPC-функции:
-- sync_orders_batch и reassign_order_operator.
REVOKE INSERT, UPDATE, DELETE ON public.orders FROM authenticated, anon, PUBLIC;
GRANT SELECT ON public.orders TO authenticated;
