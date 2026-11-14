-- ============================================================================
-- Миграция: 012_seller_account_balance_and_realtime.sql
-- Назначение:
--   1. Расширение таблицы team_seller_accounts балансовыми полями (total_balance, balances, balance_currency, balance_updated_at).
--   2. Защищённая RPC-функция update_seller_account_balance (SECURITY DEFINER, валидация прав и магазина).
--   3. Публикация таблиц в supabase_realtime с REPLICA IDENTITY FULL (operator_status, shifts, orders, team_seller_accounts, profiles).
--   4. Миграция исторических смен из placeholder 'SELLER_MAIN' в реальный магазин '4473774' с автоматическим пересчётом атрибуции и безопасным удалением 176 дубликатов.
-- Архитектура: FunPay Team Dashboard v2.4 (Single-Team Architecture)
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Балансовые поля в team_seller_accounts
-- ----------------------------------------------------------------------------
ALTER TABLE public.team_seller_accounts
    ADD COLUMN IF NOT EXISTS total_balance NUMERIC(12, 2) DEFAULT 0.00,
    ADD COLUMN IF NOT EXISTS balance_currency TEXT DEFAULT 'RUB',
    ADD COLUMN IF NOT EXISTS balances JSONB DEFAULT '{}'::jsonb,
    ADD COLUMN IF NOT EXISTS balance_updated_at TIMESTAMPTZ DEFAULT NOW();

-- ----------------------------------------------------------------------------
-- 2. RPC: update_seller_account_balance
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.update_seller_account_balance(
    p_seller_account_id TEXT,
    p_total_balance NUMERIC,
    p_balances JSONB,
    p_currency TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_caller_id UUID := auth.uid();
BEGIN
    -- 1. Проверка авторизации: только активные участники команды
    IF v_caller_id IS NULL OR NOT public.is_active_team_member() THEN
        RAISE EXCEPTION 'Доступ запрещён: пользователь не авторизован или деактивирован';
    END IF;

    -- 2. Проверка существования и активности магазина
    IF NOT EXISTS (
        SELECT 1 FROM public.team_seller_accounts
        WHERE seller_account_id = p_seller_account_id AND is_active = true
    ) THEN
        RAISE EXCEPTION 'Магазин продавца (%) не зарегистрирован для команды или деактивирован', p_seller_account_id;
    END IF;

    -- 3. Атомарное обновление баланса
    UPDATE public.team_seller_accounts
    SET total_balance = p_total_balance,
        balances = COALESCE(p_balances, '{}'::jsonb),
        balance_currency = COALESCE(p_currency, 'RUB'),
        balance_updated_at = NOW(),
        updated_at = NOW()
    WHERE seller_account_id = p_seller_account_id;

    RETURN jsonb_build_object('success', true);
END;
$$;

REVOKE ALL ON FUNCTION public.update_seller_account_balance(TEXT, NUMERIC, JSONB, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_seller_account_balance(TEXT, NUMERIC, JSONB, TEXT) TO authenticated;

-- ----------------------------------------------------------------------------
-- 3. Публикация таблиц в supabase_realtime с REPLICA IDENTITY FULL
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    v_tbl TEXT;
    v_tables TEXT[] := ARRAY[
        'operator_status',
        'shifts',
        'orders',
        'team_seller_accounts',
        'profiles'
    ];
BEGIN
    FOREACH v_tbl IN ARRAY v_tables
    LOOP
        -- Добавление в публикацию, если ещё не добавлено
        IF NOT EXISTS (
            SELECT 1 
            FROM pg_publication_tables 
            WHERE pubname = 'supabase_realtime' 
              AND schemaname = 'public' 
              AND tablename = v_tbl
        ) THEN
            EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I;', v_tbl);
            RAISE NOTICE 'Таблица public.% успешно добавлена в публикацию supabase_realtime', v_tbl;
        ELSE
            RAISE NOTICE 'Таблица public.% уже включена в публикацию supabase_realtime', v_tbl;
        END IF;

        -- Включение полного снимка строки при UPDATE/DELETE для Realtime
        EXECUTE format('ALTER TABLE public.%I REPLICA IDENTITY FULL;', v_tbl);
    END LOOP;
END;
$$;

-- ----------------------------------------------------------------------------
-- 4. Перенос исторических смен и дедупликация 176 заказов SELLER_MAIN -> 4473774
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    v_shift RECORD;
    v_target_seller TEXT := '4473774';
BEGIN
    -- Выполняем миграцию, если в системе зарегистрирован магазин Hopeoflove
    IF EXISTS (SELECT 1 FROM public.team_seller_accounts WHERE seller_account_id = v_target_seller AND is_active = true) THEN
        -- 1. Переводим 9 исторических смен на целевой аккаунт продавца
        UPDATE public.shifts
        SET seller_account_id = v_target_seller,
            updated_at = NOW()
        WHERE seller_account_id = 'SELLER_MAIN';

        -- 2. Запускаем автоматический пересчёт атрибуции для всех перенесённых смен
        FOR v_shift IN SELECT id FROM public.shifts WHERE seller_account_id = v_target_seller
        LOOP
            PERFORM public.recalculate_shift_attributions(v_shift.id);
        END LOOP;

        -- 3. Удаляем дубликаты заказов из устаревшего SELLER_MAIN (176 заказов уже присутствуют в 4473774)
        DELETE FROM public.orders WHERE seller_account_id = 'SELLER_MAIN';

        RAISE NOTICE 'Миграция смен и удаление дубликатов SELLER_MAIN успешно завершены.';
    END IF;
END;
$$;
