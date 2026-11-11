-- ============================================================================
-- Миграция: 008_rpc_functions.sql
-- Назначение: Защищённые транзакционные RPC-функции бизнес-логики:
--             1. sync_orders_batch (пакетный импорт до 50 заказов, First-Write-Wins,
--                строгая валидация формата Numeric, детекция расхождений сумм и времени)
--             2. reassign_order_operator (ручное переназначение с блокировкой строк и аудитом)
--             3. recalculate_shift_attributions (пересчёт атрибуции с поддержкой укорочения смен,
--                без использования MAX(UUID), с защитой от расширения чужих диапазонов)
-- Архитектура: FanPay Team Dashboard v2.4 (Single-Team Architecture)
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. RPC: sync_orders_batch
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.sync_orders_batch(
    p_seller_account_id TEXT,
    p_orders JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_caller_id UUID := auth.uid();
    v_result JSONB := '[]'::JSONB;
    v_order JSONB;
    v_order_id TEXT;
    v_raw_amount TEXT;
    v_amount NUMERIC(12, 2);
    v_currency TEXT;
    v_status TEXT;
    v_created_at TIMESTAMPTZ;
    v_buyer_id TEXT;
    v_buyer_username TEXT;
    v_title TEXT;
    v_desc TEXT;
    v_subcategory TEXT;
    v_existing public.orders%ROWTYPE;
    
    -- Переменные для автоматической атрибуции (без MAX(UUID))
    v_matched_shift_id UUID;
    v_matched_operator_id UUID;
    v_active_shifts_count INTEGER;
    v_attr_status TEXT;
    v_attr_source TEXT;
BEGIN
    -- 1. Авторизация вызывающего оператора
    IF v_caller_id IS NULL OR NOT public.is_active_team_member() THEN
        RAISE EXCEPTION 'Доступ запрещён: пользователь не авторизован или деактивирован';
    END IF;

    -- 2. Валидация аккаунта продавца
    IF p_seller_account_id IS NULL OR TRIM(p_seller_account_id) = '' THEN
        RAISE EXCEPTION 'Не указан идентификатор аккаунта продавца (seller_account_id)';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM public.team_seller_accounts 
        WHERE seller_account_id = p_seller_account_id AND is_active = true
    ) THEN
        RAISE EXCEPTION 'Аккаунт продавца (%) не зарегистрирован для команды или деактивирован', p_seller_account_id;
    END IF;

    -- 3. Проверка типа входных данных
    IF p_orders IS NULL OR jsonb_typeof(p_orders) != 'array' THEN
        RAISE EXCEPTION 'Параметр p_orders должен быть JSON-массивом заказов';
    END IF;

    -- 4. Строгое ограничение размера батча (не более 50 заказов)
    IF jsonb_array_length(p_orders) > 50 THEN
        RAISE EXCEPTION 'Размер пакета превышает допустимый лимит в 50 заказов (передано: %)', jsonb_array_length(p_orders);
    END IF;

    IF jsonb_array_length(p_orders) = 0 THEN
        RETURN v_result;
    END IF;

    -- 5. Итерация по заказам в пакете
    FOR v_order IN SELECT * FROM jsonb_array_elements(p_orders)
    LOOP
        BEGIN
            v_order_id := TRIM(v_order->>'order_id');
            v_raw_amount := TRIM(v_order->>'amount');
            v_currency := UPPER(TRIM(v_order->>'currency'));
            v_status := LOWER(TRIM(v_order->>'status'));
            v_created_at := (v_order->>'funpay_created_at')::TIMESTAMPTZ;
            v_buyer_id := TRIM(v_order->>'buyer_id');
            v_buyer_username := TRIM(v_order->>'buyer_username');
            v_title := TRIM(v_order->>'title');
            v_desc := TRIM(v_order->>'description');
            v_subcategory := TRIM(v_order->>'subcategory');

            -- Валидация order_id
            IF v_order_id IS NULL OR v_order_id = '' OR LENGTH(v_order_id) > 64 THEN
                v_result := v_result || jsonb_build_object(
                    'order_id', COALESCE(v_order_id, 'UNKNOWN'),
                    'action', 'error',
                    'message', 'Некорректный или отсутствующий order_id (макс. 64 символа)'
                );
                CONTINUE;
            END IF;

            -- Строгая валидация формата суммы ДО приведения типа (защита от неявного округления NUMERIC)
            IF v_raw_amount IS NULL OR v_raw_amount !~ '^[0-9]+(\.[0-9]{1,2})?$' THEN
                v_result := v_result || jsonb_build_object(
                    'order_id', v_order_id,
                    'action', 'error',
                    'message', 'Сумма заказа должна быть положительным числом максимум с 2 знаками после запятой'
                );
                CONTINUE;
            END IF;

            v_amount := v_raw_amount::NUMERIC(12, 2);
            IF v_amount <= 0 OR v_amount > 99999999.99 THEN
                v_result := v_result || jsonb_build_object(
                    'order_id', v_order_id,
                    'action', 'error',
                    'message', 'Сумма заказа выходит за допустимые границы (0 .. 99999999.99)'
                );
                CONTINUE;
            END IF;

            -- Валидация валюты (явная проверка на NULL и допустимый список)
            IF v_currency IS NULL OR v_currency NOT IN ('RUB', 'USD', 'EUR', 'KZT') THEN
                v_result := v_result || jsonb_build_object(
                    'order_id', v_order_id,
                    'action', 'error',
                    'message', 'Недопустимая или отсутствующая валюта: ' || COALESCE(v_currency, 'NULL')
                );
                CONTINUE;
            END IF;

            -- Валидация статуса (явная проверка на NULL)
            IF v_status IS NULL OR v_status NOT IN ('paid', 'closed', 'refunded') THEN
                v_result := v_result || jsonb_build_object(
                    'order_id', v_order_id,
                    'action', 'error',
                    'message', 'Недопустимый или отсутствующий статус: ' || COALESCE(v_status, 'NULL')
                );
                CONTINUE;
            END IF;

            -- Валидация даты funpay_created_at
            IF v_created_at IS NULL OR v_created_at > (NOW() + INTERVAL '15 minutes') OR v_created_at < '2020-01-01'::TIMESTAMPTZ THEN
                v_result := v_result || jsonb_build_object(
                    'order_id', v_order_id,
                    'action', 'error',
                    'message', 'Некорректная дата funpay_created_at'
                );
                CONTINUE;
            END IF;

            -- Валидация строковых длин метаданных
            IF LENGTH(v_buyer_id) > 64 THEN
                v_buyer_id := SUBSTRING(v_buyer_id FROM 1 FOR 64);
            END IF;
            IF LENGTH(v_buyer_username) > 100 THEN
                v_buyer_username := SUBSTRING(v_buyer_username FROM 1 FOR 100);
            END IF;
            IF LENGTH(v_title) > 255 THEN
                v_title := SUBSTRING(v_title FROM 1 FOR 255);
            END IF;
            IF LENGTH(v_subcategory) > 100 THEN
                v_subcategory := SUBSTRING(v_subcategory FROM 1 FOR 100);
            END IF;
            IF LENGTH(v_desc) > 1000 THEN
                v_desc := SUBSTRING(v_desc FROM 1 FOR 1000);
            END IF;

            -- ----------------------------------------------------------------
            -- Вычисляем автоматическую атрибуцию на случай нового заказа (БЕЗ MAX(UUID))
            -- ----------------------------------------------------------------
            SELECT COUNT(*) INTO v_active_shifts_count
            FROM public.shifts
            WHERE seller_account_id = p_seller_account_id
              AND start_time <= v_created_at
              AND (end_time IS NULL OR end_time >= v_created_at);

            IF v_active_shifts_count = 1 THEN
                SELECT id, user_id INTO v_matched_shift_id, v_matched_operator_id
                FROM public.shifts
                WHERE seller_account_id = p_seller_account_id
                  AND start_time <= v_created_at
                  AND (end_time IS NULL OR end_time >= v_created_at)
                LIMIT 1;
                v_attr_status := 'assigned';
                v_attr_source := 'automatic';
            ELSIF v_active_shifts_count > 1 THEN
                v_attr_status := 'ambiguous';
                v_attr_source := 'none';
                v_matched_shift_id := NULL;
                v_matched_operator_id := NULL;
            ELSE
                v_attr_status := 'unassigned';
                v_attr_source := 'none';
                v_matched_shift_id := NULL;
                v_matched_operator_id := NULL;
            END IF;

            -- ----------------------------------------------------------------
            -- АТОМАРНАЯ ВСТАВКА (First-Write-Wins при гонках параллельных клиентов)
            -- ----------------------------------------------------------------
            INSERT INTO public.orders (
                seller_account_id, order_id, buyer_id, buyer_username,
                title, description, subcategory, amount, currency, status,
                funpay_created_at, operator_id, shift_id,
                attribution_status, attribution_source,
                synced_by_user_id, last_synced_at, created_at, updated_at
            ) VALUES (
                p_seller_account_id, v_order_id, v_buyer_id, v_buyer_username,
                v_title, v_desc, v_subcategory, v_amount, v_currency, v_status,
                v_created_at, v_matched_operator_id, v_matched_shift_id,
                v_attr_status, v_attr_source,
                v_caller_id, NOW(), NOW(), NOW()
            )
            ON CONFLICT (seller_account_id, order_id) DO NOTHING;

            -- ----------------------------------------------------------------
            -- ЕСЛИ ЗАКАЗ УЖЕ СУЩЕСТВОВАЛ (или вставлен параллельно)
            -- ----------------------------------------------------------------
            IF NOT FOUND THEN
                SELECT * INTO v_existing
                FROM public.orders
                WHERE seller_account_id = p_seller_account_id AND order_id = v_order_id
                FOR UPDATE;

                -- 1. ПЕРЕКРЁСТНАЯ ПРОВЕРКА ФИНАНСОВЫХ ДАННЫХ (СУММА И ВАЛЮТА)
                IF v_existing.amount IS DISTINCT FROM v_amount OR v_existing.currency IS DISTINCT FROM v_currency THEN
                    INSERT INTO public.order_financial_discrepancies (
                        seller_account_id, order_id,
                        existing_amount, existing_currency,
                        incoming_amount, incoming_currency,
                        discrepancy_type,
                        existing_funpay_created_at, incoming_funpay_created_at,
                        initial_synced_by_user_id, incoming_synced_by_user_id,
                        detected_at
                    ) VALUES (
                        p_seller_account_id, v_order_id,
                        v_existing.amount, v_existing.currency,
                        v_amount, v_currency,
                        'amount_currency',
                        v_existing.funpay_created_at, v_created_at,
                        v_existing.synced_by_user_id, v_caller_id,
                        NOW()
                    )
                    ON CONFLICT ON CONSTRAINT uq_order_discrepancy DO NOTHING;

                    v_result := v_result || jsonb_build_object(
                        'order_id', v_order_id,
                        'action', 'financial_discrepancy_logged',
                        'message', format('Зафиксировано финансовое расхождение! В базе: %s %s, пришло: %s %s',
                                          v_existing.amount, v_existing.currency, v_amount, v_currency)
                    );
                    CONTINUE;
                END IF;

                -- 2. ПЕРЕКРЁСТНАЯ ПРОВЕРКА ВРЕМЕНИ СОЗДАНИЯ (funpay_created_at)
                IF v_existing.funpay_created_at IS DISTINCT FROM v_created_at THEN
                    INSERT INTO public.order_financial_discrepancies (
                        seller_account_id, order_id,
                        existing_amount, existing_currency,
                        incoming_amount, incoming_currency,
                        discrepancy_type,
                        existing_funpay_created_at, incoming_funpay_created_at,
                        initial_synced_by_user_id, incoming_synced_by_user_id,
                        detected_at
                    ) VALUES (
                        p_seller_account_id, v_order_id,
                        v_existing.amount, v_existing.currency,
                        v_amount, v_currency,
                        'created_at_mismatch',
                        v_existing.funpay_created_at, v_created_at,
                        v_existing.synced_by_user_id, v_caller_id,
                        NOW()
                    )
                    ON CONFLICT ON CONSTRAINT uq_order_discrepancy DO NOTHING;

                    v_result := v_result || jsonb_build_object(
                        'order_id', v_order_id,
                        'action', 'created_at_discrepancy_logged',
                        'message', format('Зафиксировано несовпадение funpay_created_at! В базе: %s, пришло: %s',
                                          v_existing.funpay_created_at, v_created_at)
                    );
                    -- First-Write-Wins: сохраняем первоначальное время funpay_created_at
                END IF;

                -- 3. ИЕРАРХИЯ СТАТУСОВ: refunded (3) > closed (2) > paid (1)
                -- Строгий запрет на понижение статуса из-за сетевых задержек
                IF (v_existing.status = 'refunded' AND v_status != 'refunded') OR
                   (v_existing.status = 'closed' AND v_status = 'paid') THEN
                    -- Обновляем только метаданные, не трогая статус и атрибуцию
                    UPDATE public.orders
                    SET buyer_username = COALESCE(v_buyer_username, buyer_username),
                        title = COALESCE(v_title, title),
                        description = COALESCE(v_desc, description),
                        subcategory = COALESCE(v_subcategory, subcategory),
                        last_synced_at = NOW(),
                        updated_at = NOW()
                    WHERE seller_account_id = p_seller_account_id AND order_id = v_order_id;

                    v_result := v_result || jsonb_build_object(
                        'order_id', v_order_id,
                        'action', 'ignored_status_downgrade',
                        'current_status', v_existing.status
                    );
                ELSE
                    -- Обновляем статус и метаданные (атрибуция НЕ сбрасывается)
                    UPDATE public.orders
                    SET status = v_status,
                        buyer_username = COALESCE(v_buyer_username, buyer_username),
                        title = COALESCE(v_title, title),
                        description = COALESCE(v_desc, description),
                        subcategory = COALESCE(v_subcategory, subcategory),
                        last_synced_at = NOW(),
                        updated_at = NOW()
                    WHERE seller_account_id = p_seller_account_id AND order_id = v_order_id;

                    v_result := v_result || jsonb_build_object(
                        'order_id', v_order_id,
                        'action', 'updated',
                        'status', v_status
                    );
                END IF;

            ELSE
                -- Заказ успешно вставлен как новый
                v_result := v_result || jsonb_build_object(
                    'order_id', v_order_id,
                    'action', 'inserted',
                    'attribution', v_attr_status
                );
            END IF;

        EXCEPTION WHEN OTHERS THEN
            v_result := v_result || jsonb_build_object(
                'order_id', COALESCE(v_order_id, 'UNKNOWN'),
                'action', 'error',
                'message', SQLERRM
            );
        END;
    END LOOP;

    RETURN v_result;
END;
$$;

-- Доступ только аутентифицированным операторам (Option A)
REVOKE ALL ON FUNCTION public.sync_orders_batch(TEXT, JSONB) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.sync_orders_batch(TEXT, JSONB) TO authenticated;

-- ----------------------------------------------------------------------------
-- 2. RPC: reassign_order_operator
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reassign_order_operator(
    p_seller_account_id TEXT,
    p_order_id TEXT,
    p_new_operator_id UUID,
    p_reason TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_caller_id UUID := auth.uid();
    v_order public.orders%ROWTYPE;
    v_caller_name TEXT;
    v_old_op_name TEXT;
    v_new_op_name TEXT;
BEGIN
    -- 1. Проверка полномочий инициатора
    IF v_caller_id IS NULL OR NOT public.is_active_team_member() THEN
        RAISE EXCEPTION 'Доступ запрещён: вызывающий пользователь не авторизован или деактивирован';
    END IF;

    -- 2. Проверка валидности аккаунта продавца
    IF NOT EXISTS (
        SELECT 1 FROM public.team_seller_accounts
        WHERE seller_account_id = p_seller_account_id AND is_active = true
    ) THEN
        RAISE EXCEPTION 'Аккаунт продавца (%) не зарегистрирован для команды или деактивирован', p_seller_account_id;
    END IF;

    -- 3. Валидация причины
    IF p_reason IS NULL OR TRIM(p_reason) = '' THEN
        RAISE EXCEPTION 'Необходимо указать причину переназначения заказа';
    END IF;

    -- 4. Проверка нового оператора (прямой запрос без side-channel функций)
    IF p_new_operator_id IS NOT NULL THEN
        IF NOT EXISTS (
            SELECT 1 FROM public.profiles 
            WHERE user_id = p_new_operator_id AND is_active = true
        ) THEN
            RAISE EXCEPTION 'Назначаемый оператор (%) не является активным участником команды', p_new_operator_id;
        END IF;
    END IF;

    -- 5. Блокировка строки заказа FOR UPDATE
    SELECT * INTO v_order
    FROM public.orders
    WHERE seller_account_id = p_seller_account_id AND order_id = p_order_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Заказ % для продавца % не найден', p_order_id, p_seller_account_id;
    END IF;

    -- Защита от холостого вызова (если оператор и статус не меняются)
    IF v_order.operator_id IS NOT DISTINCT FROM p_new_operator_id 
       AND v_order.attribution_source = 'manual' THEN
        RETURN;
    END IF;

    -- 6. Получение снимков имён для персистентного аудита
    SELECT display_name INTO v_caller_name FROM public.profiles WHERE user_id = v_caller_id;
    IF v_order.operator_id IS NOT NULL THEN
        SELECT display_name INTO v_old_op_name FROM public.profiles WHERE user_id = v_order.operator_id;
    END IF;
    IF p_new_operator_id IS NOT NULL THEN
        SELECT display_name INTO v_new_op_name FROM public.profiles WHERE user_id = p_new_operator_id;
    END IF;

    -- 7. Обновление заказа с фиксацией ручного источника
    UPDATE public.orders
    SET operator_id = p_new_operator_id,
        shift_id = NULL, -- ручная привязка отвязывает от конкретной автоматической смены
        attribution_status = CASE WHEN p_new_operator_id IS NOT NULL THEN 'assigned' ELSE 'unassigned' END,
        attribution_source = 'manual',
        updated_at = NOW()
    WHERE seller_account_id = p_seller_account_id AND order_id = p_order_id;

    -- 8. Фиксация в аудит-логе со снимком старого и нового состояния
    INSERT INTO public.order_audit_logs (
        seller_account_id,
        order_id,
        old_operator_id,
        new_operator_id,
        old_operator_display_name,
        new_operator_display_name,
        old_attribution_status,
        new_attribution_status,
        old_attribution_source,
        new_attribution_source,
        changed_by_user_id,
        changed_by_display_name,
        reason,
        created_at
    ) VALUES (
        p_seller_account_id,
        p_order_id,
        v_order.operator_id,
        p_new_operator_id,
        v_old_op_name,
        v_new_op_name,
        v_order.attribution_status,
        CASE WHEN p_new_operator_id IS NOT NULL THEN 'assigned' ELSE 'unassigned' END,
        v_order.attribution_source,
        'manual',
        v_caller_id,
        COALESCE(v_caller_name, 'Неизвестный оператор'),
        TRIM(p_reason),
        NOW()
    );
END;
$$;

REVOKE ALL ON FUNCTION public.reassign_order_operator(TEXT, TEXT, UUID, TEXT) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.reassign_order_operator(TEXT, TEXT, UUID, TEXT) TO authenticated;

-- ----------------------------------------------------------------------------
-- 3. RPC: recalculate_shift_attributions
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.recalculate_shift_attributions(
    p_shift_id UUID,
    p_window_start TIMESTAMPTZ DEFAULT NULL,
    p_window_end TIMESTAMPTZ DEFAULT NULL
)
RETURNS TABLE(updated_orders_count INTEGER)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_caller_id UUID := auth.uid();
    v_shift public.shifts%ROWTYPE;
    v_order RECORD;
    v_active_shifts_count INTEGER;
    v_matched_shift_id UUID;
    v_matched_operator_id UUID;
    v_count INTEGER := 0;
    v_win_start TIMESTAMPTZ;
    v_win_end TIMESTAMPTZ;
    v_order_min TIMESTAMPTZ;
    v_order_max TIMESTAMPTZ;
    v_is_owner BOOLEAN;
BEGIN
    -- 1. Авторизация
    IF v_caller_id IS NULL OR NOT public.is_active_team_member() THEN
        RAISE EXCEPTION 'Доступ запрещён: пользователь не авторизован или деактивирован';
    END IF;

    v_is_owner := public.is_team_owner();

    -- 2. Получение смены с блокировкой строки (FOR UPDATE) против конкурентных изменений
    SELECT * INTO v_shift FROM public.shifts WHERE id = p_shift_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Смена % не найдена', p_shift_id;
    END IF;

    -- 3. Проверка прав: оператор может пересчитывать только свои смены; руководитель — любые
    IF v_caller_id != v_shift.user_id AND NOT v_is_owner THEN
        RAISE EXCEPTION 'Вы можете пересчитывать только свои смены (для других требуются права руководителя)';
    END IF;

    -- 4. Определение границ временного окна пересчёта:
    -- Для обычного оператора окно строго ограничено реальными границами смены
    -- и ранее привязанными заказами (защита от пересчёта чужих смен)
    v_win_start := v_shift.start_time;
    v_win_end := COALESCE(v_shift.end_time, NOW());

    -- Включаем временной диапазон всех заказов, которые ранее были привязаны к этой смене
    -- (критически важно при сокращении смены, когда заказы выпадают за её новый end_time)
    SELECT MIN(funpay_created_at), MAX(funpay_created_at)
    INTO v_order_min, v_order_max
    FROM public.orders
    WHERE seller_account_id = v_shift.seller_account_id AND shift_id = p_shift_id;

    IF v_order_min IS NOT NULL AND v_order_min < v_win_start THEN
        v_win_start := v_order_min;
    END IF;
    IF v_order_max IS NOT NULL AND v_order_max > v_win_end THEN
        v_win_end := v_order_max;
    END IF;

    -- Руководитель (owner) может расширить окно, если передал явные параметры
    IF v_is_owner THEN
        IF p_window_start IS NOT NULL AND p_window_start < v_win_start THEN
            v_win_start := p_window_start;
        END IF;
        IF p_window_end IS NOT NULL AND p_window_end > v_win_end THEN
            v_win_end := p_window_end;
        END IF;
    END IF;

    -- 5. Выборка и блокировка всех потенциально затронутых заказов:
    --    - принадлежащих тому же seller_account_id
    --    - исключая ручные назначения (attribution_source = 'manual' НЕПРИКОСНОВЕННЫ)
    --    - попадающих в расширенное окно смены ЛИБО ранее привязанных к ней
    FOR v_order IN
        SELECT seller_account_id, order_id, funpay_created_at
        FROM public.orders
        WHERE seller_account_id = v_shift.seller_account_id
          AND COALESCE(attribution_source, 'none') != 'manual'
          AND (
              (funpay_created_at >= v_win_start AND funpay_created_at <= v_win_end)
              OR (shift_id = p_shift_id)
          )
        ORDER BY funpay_created_at ASC
        FOR UPDATE
    LOOP
        -- Считаем, сколько смен перекрывают момент создания заказа (БЕЗ MAX(UUID))
        SELECT COUNT(*) INTO v_active_shifts_count
        FROM public.shifts
        WHERE seller_account_id = v_shift.seller_account_id
          AND start_time <= v_order.funpay_created_at
          AND (end_time IS NULL OR end_time >= v_order.funpay_created_at);

        IF v_active_shifts_count = 1 THEN
            SELECT id, user_id INTO v_matched_shift_id, v_matched_operator_id
            FROM public.shifts
            WHERE seller_account_id = v_shift.seller_account_id
              AND start_time <= v_order.funpay_created_at
              AND (end_time IS NULL OR end_time >= v_order.funpay_created_at)
            LIMIT 1;

            UPDATE public.orders
            SET operator_id = v_matched_operator_id,
                shift_id = v_matched_shift_id,
                attribution_status = 'assigned',
                attribution_source = 'automatic',
                updated_at = NOW()
            WHERE seller_account_id = v_order.seller_account_id AND order_id = v_order.order_id;
        ELSIF v_active_shifts_count > 1 THEN
            UPDATE public.orders
            SET operator_id = NULL,
                shift_id = NULL,
                attribution_status = 'ambiguous',
                attribution_source = 'none',
                updated_at = NOW()
            WHERE seller_account_id = v_order.seller_account_id AND order_id = v_order.order_id;
        ELSE
            UPDATE public.orders
            SET operator_id = NULL,
                shift_id = NULL,
                attribution_status = 'unassigned',
                attribution_source = 'none',
                updated_at = NOW()
            WHERE seller_account_id = v_order.seller_account_id AND order_id = v_order.order_id;
        END IF;

        v_count := v_count + 1;
    END LOOP;

    RETURN QUERY SELECT v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.recalculate_shift_attributions(UUID, TIMESTAMPTZ, TIMESTAMPTZ) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.recalculate_shift_attributions(UUID, TIMESTAMPTZ, TIMESTAMPTZ) TO authenticated;
