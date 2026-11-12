-- ============================================================================
-- Скрипт валидации: 009_validation.sql
-- Назначение: Автоматизированная проверка целостности схемы v2.4, RLS-политик,
--             индексов, прав доступа, сигнатур RPC и интеграционных тестов.
-- Архитектура: FunPay Team Dashboard v2.4 (Single-Team Architecture)
-- ============================================================================

-- ============================================================================
-- ЧАСТЬ 1: СТАТИЧЕСКАЯ ПРОВЕРКА СТРУКТУРЫ, БЕЗОПАСНОСТИ И RLS (READ-ONLY)
-- ============================================================================

DO $$
DECLARE
    v_missing_tables TEXT[] := ARRAY[]::TEXT[];
    v_expected_tables TEXT[] := ARRAY[
        'profiles',
        'team_seller_accounts',
        'shifts',
        'operator_status',
        'orders',
        'order_audit_logs',
        'order_financial_discrepancies',
        'shared_templates'
    ];
    t TEXT;
    v_rls_disabled TEXT[] := ARRAY[]::TEXT[];
    v_missing_funcs TEXT[] := ARRAY[]::TEXT[];
    v_expected_funcs RECORD;
    v_missing_triggers TEXT[] := ARRAY[]::TEXT[];
    v_expected_triggers TEXT[] := ARRAY[
        'trg_protect_profile_fields',
        'trg_protect_shift_fields',
        'trg_validate_operator_status',
        'trg_protect_order_fields',
        'trg_shared_templates_audit'
    ];
    trg TEXT;
    v_missing_policies TEXT[] := ARRAY[]::TEXT[];
    v_expected_policies RECORD;
BEGIN
    RAISE NOTICE '==================================================';
    RAISE NOTICE 'НАЧАЛО СТАТИЧЕСКОЙ ВАЛИДАЦИИ FUNPAY DASHBOARD v2.4';
    RAISE NOTICE '==================================================';

    -- 1. Проверка наличия всех 8 таблиц
    FOREACH t IN ARRAY v_expected_tables
    LOOP
        IF NOT EXISTS (
            SELECT 1 FROM information_schema.tables 
            WHERE table_schema = 'public' AND table_name = t
        ) THEN
            v_missing_tables := array_append(v_missing_tables, t);
        END IF;
    END LOOP;

    IF array_length(v_missing_tables, 1) > 0 THEN
        RAISE EXCEPTION 'ОШИБКА: Отсутствуют таблицы в схеме public: %', v_missing_tables;
    ELSE
        RAISE NOTICE '✅ [1/9] Все 8 таблиц присутствуют в public.';
    END IF;

    -- 2. Проверка включения RLS на всех 8 таблицах
    FOR t IN SELECT unnest(v_expected_tables)
    LOOP
        IF NOT EXISTS (
            SELECT 1 FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public' 
              AND c.relname = t 
              AND c.relrowsecurity = true
        ) THEN
            v_rls_disabled := array_append(v_rls_disabled, t);
        END IF;
    END LOOP;

    IF array_length(v_rls_disabled, 1) > 0 THEN
        RAISE EXCEPTION 'ОШИБКА: RLS отключён на таблицах: %', v_rls_disabled;
    ELSE
        RAISE NOTICE '✅ [2/9] Row Level Security (RLS) включён на всех 8 таблицах.';
    END IF;

    -- 3. Проверка существования критических RLS-политик
    FOR v_expected_policies IN
        SELECT 'profiles' AS tbl, 'profiles_select_policy' AS pol UNION ALL
        SELECT 'profiles', 'profiles_update_own' UNION ALL
        SELECT 'profiles', 'profiles_update_owner' UNION ALL
        SELECT 'team_seller_accounts', 'team_seller_accounts_select' UNION ALL
        SELECT 'team_seller_accounts', 'team_seller_accounts_admin_all' UNION ALL
        SELECT 'shifts', 'shifts_select_team' UNION ALL
        SELECT 'shifts', 'shifts_insert_own' UNION ALL
        SELECT 'shifts', 'shifts_update_own_active' UNION ALL
        SELECT 'shifts', 'shifts_update_owner' UNION ALL
        SELECT 'orders', 'orders_select_policy' UNION ALL
        SELECT 'order_audit_logs', 'order_audit_logs_select' UNION ALL
        SELECT 'order_financial_discrepancies', 'order_discrepancies_select_owner' UNION ALL
        SELECT 'shared_templates', 'shared_templates_select' UNION ALL
        SELECT 'shared_templates', 'shared_templates_write'
    LOOP
        IF NOT EXISTS (
            SELECT 1 FROM pg_policies 
            WHERE schemaname = 'public' 
              AND tablename = v_expected_policies.tbl 
              AND policyname = v_expected_policies.pol
        ) THEN
            v_missing_policies := array_append(v_missing_policies, v_expected_policies.tbl || '.' || v_expected_policies.pol);
        END IF;
    END LOOP;

    IF array_length(v_missing_policies, 1) > 0 THEN
        RAISE EXCEPTION 'ОШИБКА: Отсутствуют обязательные RLS-политики: %', v_missing_policies;
    ELSE
        RAISE NOTICE '✅ [3/9] Все обязательные RLS-политики зарегистрированы.';
    END IF;

    -- 4. Проверка уникальных индексов и констрейнтов
    IF NOT EXISTS (
        SELECT 1 FROM pg_indexes 
        WHERE schemaname = 'public' 
          AND tablename = 'shifts' 
          AND indexname = 'idx_shifts_one_active_per_user'
    ) THEN
        RAISE EXCEPTION 'ОШИБКА: Отсутствует индекс idx_shifts_one_active_per_user на shifts';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE table_schema = 'public' 
          AND table_name = 'shared_templates' 
          AND constraint_name = 'uq_shared_templates_shortcut'
    ) THEN
        RAISE EXCEPTION 'ОШИБКА: Отсутствует ограничение uq_shared_templates_shortcut на shared_templates';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE table_schema = 'public' 
          AND table_name = 'order_financial_discrepancies' 
          AND constraint_name = 'uq_order_discrepancy'
    ) THEN
        RAISE EXCEPTION 'ОШИБКА: Отсутствует ограничение uq_order_discrepancy на order_financial_discrepancies';
    END IF;

    RAISE NOTICE '✅ [4/9] Все критические уникальные индексы и ограничения активны.';

    -- 5. Проверка точных сигнатур функций и RPC (функции проверки прав без аргументов!)
    FOR v_expected_funcs IN
        SELECT 'is_active_team_member' AS name, '' AS args UNION ALL
        SELECT 'is_team_owner', '' UNION ALL
        SELECT 'bootstrap_initial_owner', 'uuid' UNION ALL
        SELECT 'sync_orders_batch', 'text, jsonb' UNION ALL
        SELECT 'reassign_order_operator', 'text, text, uuid, text' UNION ALL
        SELECT 'recalculate_shift_attributions', 'uuid, timestamp with time zone, timestamp with time zone'
    LOOP
        IF NOT EXISTS (
            SELECT 1 FROM pg_proc p
            JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = 'public' 
              AND p.proname = v_expected_funcs.name
              AND oidvectortypes(p.proargtypes) = v_expected_funcs.args
        ) THEN
            v_missing_funcs := array_append(v_missing_funcs, v_expected_funcs.name || '(' || v_expected_funcs.args || ')');
        END IF;
    END LOOP;

    IF array_length(v_missing_funcs, 1) > 0 THEN
        RAISE EXCEPTION 'ОШИБКА: Не найдены функции с ожидаемыми сигнатурами: %', v_missing_funcs;
    ELSE
        RAISE NOTICE '✅ [5/9] Сигнатуры всех 6 ключевых функций и RPC строго соответствуют спецификации.';
    END IF;

    -- 6. Проверка SECURITY DEFINER и search_path
    IF EXISTS (
        SELECT 1 FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' 
          AND p.proname IN ('sync_orders_batch', 'reassign_order_operator', 'recalculate_shift_attributions', 'bootstrap_initial_owner', 'is_active_team_member', 'is_team_owner')
          AND (p.prosecdef = false OR p.proconfig IS NULL OR NOT ('search_path=public, pg_temp' = ANY(p.proconfig)))
    ) THEN
        RAISE EXCEPTION 'ОШИБКА: Функции должны иметь SECURITY DEFINER и search_path = public, pg_temp!';
    ELSE
        RAISE NOTICE '✅ [6/9] Все привилегированные функции защищены через SECURITY DEFINER и search_path = public, pg_temp.';
    END IF;

    -- 7. Проверка запрета прямых прав на запись в orders, audit_logs и discrepancies
    IF EXISTS (
        SELECT 1 FROM information_schema.role_table_grants 
        WHERE table_schema = 'public' 
          AND table_name IN ('orders', 'order_audit_logs', 'order_financial_discrepancies')
          AND grantee IN ('authenticated', 'anon', 'PUBLIC')
          AND privilege_type IN ('INSERT', 'UPDATE', 'DELETE')
    ) THEN
        RAISE EXCEPTION 'ОШИБКА: Обнаружены небезопасные прямые права INSERT/UPDATE/DELETE для authenticated/anon/PUBLIC!';
    ELSE
        RAISE NOTICE '✅ [7/9] Прямой доступ к изменению таблиц заказов отозван (запись разрешена только через RPC).';
    END IF;

    -- 8. Проверка серверных триггеров
    FOREACH trg IN ARRAY v_expected_triggers
    LOOP
        IF NOT EXISTS (
            SELECT 1 FROM information_schema.triggers 
            WHERE trigger_schema = 'public' AND trigger_name = trg
        ) THEN
            v_missing_triggers := array_append(v_missing_triggers, trg);
        END IF;
    END LOOP;

    IF array_length(v_missing_triggers, 1) > 0 THEN
        RAISE EXCEPTION 'ОШИБКА: Отсутствуют триггеры: %', v_missing_triggers;
    ELSE
        RAISE NOTICE '✅ [8/9] Все 5 защитных триггеров успешно зарегистрированы.';
    END IF;

    -- 9. Проверка начального наполнения общих шаблонов (F1-F8)
    IF (SELECT COUNT(*) FROM public.shared_templates WHERE shortcut IN ('F1','F2','F3','F4','F5','F6','F7','F8')) != 8 THEN
        RAISE EXCEPTION 'ОШИБКА: В таблице shared_templates отсутствуют все 8 начальных шаблонов F1-F8!';
    ELSE
        RAISE NOTICE '✅ [9/9] Все 8 начальных шаблонов (F1-F8) присутствуют в shared_templates.';
    END IF;

    RAISE NOTICE '==================================================';
    RAISE NOTICE 'СТАТИЧЕСКАЯ ВАЛИДАЦИЯ УСПЕШНО ПРОЙДЕНА (100%%)';
    RAISE NOTICE '==================================================';
END $$;


-- ============================================================================
-- ЧАСТЬ 2: ИНТЕГРАЦИОННЫЕ ДИНАМИЧЕСКИЕ ТЕСТЫ (БЕЗУСЛОВНЫЙ ROLLBACK)
-- ============================================================================
-- Выполняет строгие тесты ограничений бизнес-логики внутри изолированной транзакции.
-- Настраивает контекст auth.uid() через mock JWT claims, гарантируя работоспособность
-- тестов в Supabase SQL Editor без предварительной ручной авторизации.

BEGIN;

DO $$
DECLARE
    v_test_user_id UUID;
    v_seller_id TEXT := 'TEST_SELLER_VALIDATION';
    v_shift1_id UUID;
    v_test_orders JSONB;
BEGIN
    RAISE NOTICE 'Запуск блока динамических интеграционных тестов:';

    -- 1. Создание/поиск фикстуры тестового пользователя
    SELECT id INTO v_test_user_id FROM auth.users LIMIT 1;

    IF v_test_user_id IS NULL THEN
        v_test_user_id := gen_random_uuid();
        -- Если auth.users пуста, создаём временного пользователя в рамках транзакции
        INSERT INTO auth.users (id, email) 
        VALUES (v_test_user_id, 'validation_fixture@funpay-team.internal')
        ON CONFLICT DO NOTHING;
    END IF;

    -- Гарантируем наличие активного профиля для этого пользователя
    INSERT INTO public.profiles (user_id, display_name, role, is_active)
    VALUES (v_test_user_id, 'Тестовый Валидатор', 'operator', true)
    ON CONFLICT (user_id) DO UPDATE SET is_active = true;

    -- ЯВНАЯ УСТАНОВКА JWT CLAIMS для корректной работы auth.uid() и auth.role() в SQL Editor
    PERFORM set_config('request.jwt.claims', json_build_object(
        'sub', v_test_user_id::text,
        'role', 'authenticated'
    )::text, true);

    -- Проверяем, что контекст авторизации успешно инициализирован
    IF auth.uid() IS NULL OR NOT public.is_active_team_member() THEN
        RAISE EXCEPTION 'Не удалось инициализировать mock JWT claims для динамических тестов';
    END IF;

    -- Создаём тестовый магазин
    INSERT INTO public.team_seller_accounts (seller_account_id, account_name, is_active)
    VALUES (v_seller_id, 'Тестовый магазин для валидации', true)
    ON CONFLICT (seller_account_id) DO NOTHING;

    -- ------------------------------------------------------------------------
    -- Тест 1: Проверка лимита батча sync_orders_batch (>50 заказов должно падать)
    -- ------------------------------------------------------------------------
    SELECT jsonb_agg(
        jsonb_build_object(
            'order_id', 'ORDER_' || i,
            'amount', '100.00',
            'currency', 'RUB',
            'status', 'paid',
            'funpay_created_at', NOW()
        )
    ) INTO v_test_orders
    FROM generate_series(1, 51) AS i;

    BEGIN
        PERFORM public.sync_orders_batch(v_seller_id, v_test_orders);
        RAISE EXCEPTION 'ДИНАМИЧЕСКИЙ ТЕСТ ПРОВАЛЕН: sync_orders_batch пропустил пакет из 51 заказа!';
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM LIKE '%лимит в 50 заказов%' THEN
            RAISE NOTICE '✅ Динамический тест 1 пройден: пакет > 50 заказов успешно отклонён.';
        ELSE
            RAISE EXCEPTION 'Неожиданная ошибка в тесте лимита батча: %', SQLERRM;
        END IF;
    END;

    -- ------------------------------------------------------------------------
    -- Тест 2: Проверка строгой валидации формата суммы (защита от неявного округления)
    -- ------------------------------------------------------------------------
    SELECT jsonb_build_array(
        jsonb_build_object(
            'order_id', 'ORDER_INVALID_NUM',
            'amount', '100.555', -- 3 знака после запятой недопустимы
            'currency', 'RUB',
            'status', 'paid',
            'funpay_created_at', NOW()
        )
    ) INTO v_test_orders;

    BEGIN
        PERFORM public.sync_orders_batch(v_seller_id, v_test_orders);
        -- RPC возвращает статус error внутри JSON, проверяем его
        IF (public.sync_orders_batch(v_seller_id, v_test_orders)->0->>'action') != 'error' THEN
            RAISE EXCEPTION 'ДИНАМИЧЕСКИЙ ТЕСТ ПРОВАЛЕН: принята сумма с некорректным количеством знаков!';
        ELSE
            RAISE NOTICE '✅ Динамический тест 2 пройден: некорректный формат суммы отклонён.';
        END IF;
    END;

    -- ------------------------------------------------------------------------
    -- Тест 3: Попытка открыть 2 активные смены одному пользователю
    -- ------------------------------------------------------------------------
    INSERT INTO public.shifts (user_id, seller_account_id, status, start_time)
    VALUES (v_test_user_id, v_seller_id, 'active', NOW() - INTERVAL '1 hour')
    RETURNING id INTO v_shift1_id;

    BEGIN
        INSERT INTO public.shifts (user_id, seller_account_id, status, start_time)
        VALUES (v_test_user_id, v_seller_id, 'active', NOW());
        RAISE EXCEPTION 'ДИНАМИЧЕСКИЙ ТЕСТ ПРОВАЛЕН: база позволила открыть вторую активную смену!';
    EXCEPTION WHEN unique_violation THEN
        RAISE NOTICE '✅ Динамический тест 3 пройден: повторная активная смена заблокирована индексом.';
    END;

    -- ------------------------------------------------------------------------
    -- Тест 4: Проверка запрета неактивного магазина при открытии смены
    -- ------------------------------------------------------------------------
    INSERT INTO public.team_seller_accounts (seller_account_id, account_name, is_active)
    VALUES ('INACTIVE_SHOP', 'Неактивный', false)
    ON CONFLICT (seller_account_id) DO UPDATE SET is_active = false;

    BEGIN
        INSERT INTO public.shifts (user_id, seller_account_id, status, start_time)
        VALUES (v_test_user_id, 'INACTIVE_SHOP', 'active', NOW());
        RAISE EXCEPTION 'ДИНАМИЧЕСКИЙ ТЕСТ ПРОВАЛЕН: открыта смена на неактивном магазине!';
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM LIKE '%Нельзя открыть смену на неактивном%' THEN
            RAISE NOTICE '✅ Динамический тест 4 пройден: неактивный магазин отклонён триггером.';
        ELSE
            RAISE EXCEPTION 'Неожиданная ошибка в тесте неактивного магазина: %', SQLERRM;
        END IF;
    END;

    -- ------------------------------------------------------------------------
    -- Тест 5: Проверка триггера иммутабельности полей заказа (orders)
    -- ------------------------------------------------------------------------
    INSERT INTO public.orders (
        seller_account_id, order_id, amount, currency, status,
        funpay_created_at, synced_by_user_id, buyer_id
    ) VALUES (
        v_seller_id, 'ORDER_IMMUTABLE_TEST', 500.00, 'RUB', 'paid',
        NOW(), v_test_user_id, 'BUYER_1'
    ) ON CONFLICT (seller_account_id, order_id) DO NOTHING;

    BEGIN
        UPDATE public.orders
        SET amount = 999.00
        WHERE seller_account_id = v_seller_id AND order_id = 'ORDER_IMMUTABLE_TEST';
        RAISE EXCEPTION 'ДИНАМИЧЕСКИЙ ТЕСТ ПРОВАЛЕН: триггер позволил изменить сумму заказа!';
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM LIKE '%Запрещено изменять сумму%' THEN
            RAISE NOTICE '✅ Динамический тест 5 пройден: триггер иммутабельности защитил финансовые данные.';
        ELSE
            RAISE EXCEPTION 'Неожиданная ошибка в тесте иммутабельности: %', SQLERRM;
        END IF;
    END;

    RAISE NOTICE '==================================================';
    RAISE NOTICE 'ВСЕ ДИНАМИЧЕСКИЕ ИНТЕГРАЦИОННЫЕ ТЕСТЫ ПРОЙДЕНЫ (5/5)';
    RAISE NOTICE '==================================================';
END $$;

-- БЕЗУСЛОВНЫЙ ОТКАТ ВСЕХ ДИНАМИЧЕСКИХ ТЕСТОВ (БАЗА ОСТАЁТСЯ АБСОЛЮТНО ЧИСТОЙ)
ROLLBACK;
