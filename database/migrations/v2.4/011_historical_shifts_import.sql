-- ============================================================================
-- Миграция: 011_historical_shifts_import.sql
-- Назначение: Безопасный и идемпотентный импорт исторических смен оператора «Алекс»
--             из локального хранилища старых версий Chrome Extension (fphk_shift_history).
--             Исторические смены привязываются строго к Создателю команды (Creator)
--             через проверенный JWT (auth.uid()).
-- Безопасность:
--   1. Вызывать функцию имеет право ТОЛЬКО действующий Создатель (is_creator = true).
--   2. user_id определяется строго по auth.uid(), клиентская подмена невозможна.
--   3. legacy_id сохраняется в public.shifts с частичным UNIQUE-индексом для исключения дублей.
--   4. UUID смены вычисляется детерминированно через uuid_generate_v5.
--   5. Повторный вызов полностью идемпотентен (ON CONFLICT DO NOTHING).
-- Архитектура: FunPay Team Dashboard v2.4 (Single-Team Architecture)
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Добавление поля legacy_id для сохранения старого ID смены
-- ----------------------------------------------------------------------------
ALTER TABLE public.shifts 
    ADD COLUMN IF NOT EXISTS legacy_id TEXT;

COMMENT ON COLUMN public.shifts.legacy_id IS 
    'Исходный строковый идентификатор смены из старых версий Chrome Extension (v1.0-v2.1)';

-- Уникальный частичный индекс для предотвращения повторного импорта одной и той же смены
CREATE UNIQUE INDEX IF NOT EXISTS idx_shifts_legacy_id 
    ON public.shifts (legacy_id) 
    WHERE legacy_id IS NOT NULL;

-- ----------------------------------------------------------------------------
-- 2. Защищённая RPC-функция импорта исторических смен Создателя
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.import_legacy_shifts(p_shifts JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    v_caller_id UUID := auth.uid();
    v_is_creator BOOLEAN := false;
    v_default_seller TEXT := 'SELLER_MAIN';
    v_item JSONB;
    v_legacy_id TEXT;
    v_start_time TIMESTAMPTZ;
    v_end_time TIMESTAMPTZ;
    v_duration_seconds INTEGER;
    v_imported_count INTEGER := 0;
    v_skipped_count INTEGER := 0;
    v_total_count INTEGER := 0;
    v_start_ms BIGINT;
    v_end_ms BIGINT;
    v_shift_uuid UUID;
BEGIN
    -- 1. Аутентификация вызывающего:
    IF v_caller_id IS NULL THEN
        RAISE EXCEPTION 'Требуется аутентификация через JWT';
    END IF;

    -- 2. Проверка прав: вызывать имеет право ТОЛЬКО действующий Создатель (Creator)
    SELECT (is_creator = true AND is_active = true) INTO v_is_creator
    FROM public.profiles
    WHERE user_id = v_caller_id;

    IF v_is_creator IS NOT TRUE THEN
        RAISE EXCEPTION 'Только Создатель (Creator) имеет право импортировать исторические смены';
    END IF;

    -- 3. Проверка активного магазина продавца:
    IF NOT EXISTS (
        SELECT 1 FROM public.team_seller_accounts
        WHERE seller_account_id = v_default_seller AND is_active = true
    ) THEN
        SELECT seller_account_id INTO v_default_seller
        FROM public.team_seller_accounts
        WHERE is_active = true
        ORDER BY created_at ASC
        LIMIT 1;
    END IF;

    IF v_default_seller IS NULL THEN
        RAISE EXCEPTION 'Отсутствует активный магазин продавца (team_seller_accounts)';
    END IF;

    -- 4. Проверка входных данных:
    IF p_shifts IS NULL OR jsonb_typeof(p_shifts) <> 'array' THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', 'Параметр p_shifts должен быть валидным JSON-массивом'
        );
    END IF;

    -- 5. Итерация по историческим сменам:
    FOR v_item IN SELECT * FROM jsonb_array_elements(p_shifts)
    LOOP
        v_total_count := v_total_count + 1;
        v_legacy_id := NULLIF(TRIM(v_item->>'id'), '');

        -- Парсинг start_time (число в миллисекундах или ISO-строка):
        BEGIN
            IF (v_item->>'startTime') ~ '^[0-9]+$' THEN
                v_start_ms := (v_item->>'startTime')::BIGINT;
                v_start_time := to_timestamp(v_start_ms / 1000.0);
            ELSE
                v_start_time := (v_item->>'startTime')::TIMESTAMPTZ;
            END IF;
        EXCEPTION WHEN OTHERS THEN
            v_start_time := NULL;
        END;

        -- Парсинг end_time (число в миллисекундах или ISO-строка):
        BEGIN
            IF (v_item->>'endTime') ~ '^[0-9]+$' THEN
                v_end_ms := (v_item->>'endTime')::BIGINT;
                v_end_time := to_timestamp(v_end_ms / 1000.0);
            ELSE
                v_end_time := (v_item->>'endTime')::TIMESTAMPTZ;
            END IF;
        EXCEPTION WHEN OTHERS THEN
            v_end_time := NULL;
        END;

        -- Проверка корректности временных границ
        IF v_start_time IS NULL OR v_end_time IS NULL OR v_end_time < v_start_time THEN
            v_skipped_count := v_skipped_count + 1;
            CONTINUE;
        END IF;

        -- Расчёт длительности в секундах:
        IF (v_item->>'duration') ~ '^[0-9]+$' THEN
            -- В CompletedShift duration хранится в миллисекундах
            v_duration_seconds := GREATEST(0, ROUND((v_item->>'duration')::NUMERIC / 1000.0)::INTEGER);
        ELSE
            v_duration_seconds := GREATEST(0, EXTRACT(EPOCH FROM (v_end_time - v_start_time))::INTEGER);
        END IF;

        -- Детерминированный UUID на основе исходного legacy_id:
        IF v_legacy_id IS NOT NULL THEN
            v_shift_uuid := extensions.uuid_generate_v5(extensions.uuid_ns_url(), 'funpay:shift:' || v_legacy_id);
        ELSE
            v_shift_uuid := extensions.uuid_generate_v5(extensions.uuid_ns_url(), 'funpay:shift:' || v_caller_id || ':' || v_start_time::text);
        END IF;

        -- Проверяем, не существует ли уже смена с таким ID или legacy_id
        IF EXISTS (SELECT 1 FROM public.shifts WHERE id = v_shift_uuid OR (legacy_id IS NOT NULL AND legacy_id = v_legacy_id)) THEN
            v_skipped_count := v_skipped_count + 1;
            CONTINUE;
        END IF;

        -- Безопасная вставка строго завершённой смены для Создателя:
        INSERT INTO public.shifts (
            id,
            user_id,
            seller_account_id,
            start_time,
            end_time,
            duration_seconds,
            status,
            legacy_id,
            created_at,
            updated_at
        ) VALUES (
            v_shift_uuid,
            v_caller_id, -- Исключительно текущий Создатель
            v_default_seller,
            v_start_time,
            v_end_time,
            v_duration_seconds,
            'completed',
            v_legacy_id,
            v_start_time,
            NOW()
        )
        ON CONFLICT (id) DO NOTHING;

        IF FOUND THEN
            v_imported_count := v_imported_count + 1;
        ELSE
            v_skipped_count := v_skipped_count + 1;
        END IF;
    END LOOP;

    RETURN jsonb_build_object(
        'success', true,
        'total_received', v_total_count,
        'imported_count', v_imported_count,
        'skipped_count', v_skipped_count
    );
END;
$$;

-- ----------------------------------------------------------------------------
-- 3. Назначение прав доступа
-- ----------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.import_legacy_shifts(JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.import_legacy_shifts(JSONB) TO authenticated;
