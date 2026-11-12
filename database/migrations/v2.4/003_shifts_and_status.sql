-- ============================================================================
-- Миграция: 003_shifts_and_status.sql
-- Назначение: Учёт рабочих смен операторов и мониторинг живого присутствия (heartbeat).
--             Реализует строгую защиту жизненного цикла смен и валидацию статусов:
--             1. Оператор не может подделывать историю, время или параметры смен.
--             2. Статус on_shift жёстко валидируется против реальной активной смены.
--             3. Частичный уникальный индекс исключает две активные смены одного пользователя.
--             4. При переходе в offline/online/break очищаются связанные поля статуса.
-- Архитектура: FunPay Team Dashboard v2.4 (Single-Team Architecture)
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Таблица рабочих смен (shifts)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.shifts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES public.profiles(user_id) ON DELETE RESTRICT,
    seller_account_id TEXT NOT NULL REFERENCES public.team_seller_accounts(seller_account_id) ON DELETE RESTRICT,
    start_time TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    end_time TIMESTAMPTZ,
    duration_seconds INTEGER NOT NULL DEFAULT 0 CHECK (duration_seconds >= 0),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- КРИТИЧЕСКОЕ ОГРАНИЧЕНИЕ: оператор не может открыть вторую активную смену, пока не закрыта текущая
CREATE UNIQUE INDEX IF NOT EXISTS idx_shifts_one_active_per_user 
    ON public.shifts (user_id) 
    WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_shifts_seller_time 
    ON public.shifts (seller_account_id, start_time, end_time);

CREATE INDEX IF NOT EXISTS idx_shifts_user_status 
    ON public.shifts (user_id, status);

-- ----------------------------------------------------------------------------
-- 2. Таблица монитора статуса операторов (operator_status)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.operator_status (
    user_id UUID PRIMARY KEY REFERENCES public.profiles(user_id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'offline' CHECK (status IN ('offline', 'online', 'on_shift', 'break')),
    active_shift_id UUID REFERENCES public.shifts(id) ON DELETE SET NULL,
    current_seller_account_id TEXT REFERENCES public.team_seller_accounts(seller_account_id) ON DELETE SET NULL,
    app_version TEXT NOT NULL DEFAULT '2.1.0',
    last_heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_operator_status_heartbeat 
    ON public.operator_status (status, last_heartbeat_at DESC);

-- ----------------------------------------------------------------------------
-- 3. Триггеры защиты жизненного цикла смен (shifts)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.trg_fn_protect_shift_fields()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_is_admin BOOLEAN := (auth.role() = 'service_role' OR (session_user = 'postgres' AND auth.role() IS NULL));
    v_is_owner BOOLEAN := public.is_team_owner();
BEGIN
    -- При создании новой смены:
    IF TG_OP = 'INSERT' THEN
        -- Проверяем, что аккаунт продавца существует и активен
        IF NOT EXISTS (
            SELECT 1 FROM public.team_seller_accounts 
            WHERE seller_account_id = NEW.seller_account_id AND is_active = true
        ) THEN
            RAISE EXCEPTION 'Нельзя открыть смену на неактивном или несуществующем магазине продавца (%)', NEW.seller_account_id;
        END IF;

        -- Для обычного оператора: смена всегда стартует как active c текущим временем
        IF NOT v_is_owner AND NOT v_is_admin THEN
            NEW.status := 'active';
            NEW.end_time := NULL;
            NEW.duration_seconds := 0;
            -- Допустимая дельта времени старта от NOW — не более 5 минут
            IF NEW.start_time IS NULL OR ABS(EXTRACT(EPOCH FROM (NEW.start_time - NOW()))) > 300 THEN
                NEW.start_time := NOW();
            END IF;
        END IF;
        NEW.created_at := NOW();
        NEW.updated_at := NOW();
        RETURN NEW;
    END IF;

    -- При обновлении существующей смены:
    IF TG_OP = 'UPDATE' THEN
        -- user_id и created_at смены неизменяемы для всех
        IF NEW.user_id IS DISTINCT FROM OLD.user_id THEN
            RAISE EXCEPTION 'Запрещено изменять user_id смены';
        END IF;
        IF NEW.created_at IS DISTINCT FROM OLD.created_at THEN
            RAISE EXCEPTION 'Запрещено изменять created_at смены';
        END IF;

        -- Если обновление выполняет НЕ руководитель и НЕ доверенный админ:
        IF NOT v_is_owner AND NOT v_is_admin THEN
            -- Нельзя редактировать уже завершённую смену
            IF OLD.status = 'completed' THEN
                RAISE EXCEPTION 'Запрещено редактировать закрытую смену';
            END IF;

            -- Нельзя подменять магазин или время старта
            IF NEW.seller_account_id IS DISTINCT FROM OLD.seller_account_id THEN
                RAISE EXCEPTION 'Запрещено изменять seller_account_id смены';
            END IF;
            IF NEW.start_time IS DISTINCT FROM OLD.start_time THEN
                RAISE EXCEPTION 'Запрещено изменять start_time открытой смены';
            END IF;

            -- Единственная разрешённая операция для оператора: закрытие смены (active -> completed)
            IF OLD.status = 'active' AND NEW.status = 'completed' THEN
                -- end_time фиксируется текущим моментом закрытия (защита от произвольного манипулирования задним числом)
                IF NEW.end_time IS NULL OR ABS(EXTRACT(EPOCH FROM (NEW.end_time - NOW()))) > 300 THEN
                    NEW.end_time := NOW();
                END IF;

                IF NEW.end_time < OLD.start_time THEN
                    RAISE EXCEPTION 'end_time смены не может быть раньше start_time';
                END IF;

                -- Автоматический расчёт длительности в секундах
                NEW.duration_seconds := GREATEST(0, EXTRACT(EPOCH FROM (NEW.end_time - OLD.start_time))::INTEGER);
            ELSIF OLD.status = 'active' AND NEW.status = 'active' THEN
                -- Если смена остаётся активной, время окончания и длительность не могут быть изменены
                NEW.end_time := NULL;
                NEW.duration_seconds := 0;
            ELSE
                RAISE EXCEPTION 'Недопустимый переход статуса смены: % -> %', OLD.status, NEW.status;
            END IF;
        ELSE
            -- Руководитель (owner) или доверенный контекст могут корректировать границы: пересчитываем duration_seconds
            IF NEW.end_time IS NOT NULL AND NEW.end_time >= NEW.start_time THEN
                NEW.duration_seconds := GREATEST(0, EXTRACT(EPOCH FROM (NEW.end_time - NEW.start_time))::INTEGER);
            END IF;
        END IF;

        NEW.updated_at := NOW();
        RETURN NEW;
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_protect_shift_fields ON public.shifts;
CREATE TRIGGER trg_protect_shift_fields
    BEFORE INSERT OR UPDATE ON public.shifts
    FOR EACH ROW
    EXECUTE FUNCTION public.trg_fn_protect_shift_fields();

-- ----------------------------------------------------------------------------
-- 4. Триггер валидации и согласованности operator_status
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.trg_fn_validate_operator_status()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_shift public.shifts%ROWTYPE;
BEGIN
    -- user_id нельзя изменять
    IF TG_OP = 'UPDATE' AND NEW.user_id IS DISTINCT FROM OLD.user_id THEN
        RAISE EXCEPTION 'Запрещено изменять user_id в operator_status';
    END IF;

    -- Статус on_shift СТРОГО ТРЕБУЕТ реальной активной смены этого же пользователя
    IF NEW.status = 'on_shift' THEN
        IF NEW.active_shift_id IS NULL THEN
            RAISE EXCEPTION 'Для статуса on_shift необходимо передать active_shift_id';
        END IF;

        SELECT * INTO v_shift FROM public.shifts WHERE id = NEW.active_shift_id;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'Указанная смена (%) не существует', NEW.active_shift_id;
        END IF;

        IF v_shift.user_id != NEW.user_id THEN
            RAISE EXCEPTION 'Нельзя привязать чужую смену к своему статусу присутствия';
        END IF;

        IF v_shift.status != 'active' THEN
            RAISE EXCEPTION 'Смена (%) уже завершена; статус on_shift невозможен', NEW.active_shift_id;
        END IF;

        -- Автоматически согласовываем текущий магазин с активной сменой
        NEW.current_seller_account_id := v_shift.seller_account_id;

    ELSIF NEW.status IN ('offline', 'online') THEN
        -- Вне смены ссылка на активную смену и магазин полностью очищаются
        NEW.active_shift_id := NULL;
        NEW.current_seller_account_id := NULL;

    ELSIF NEW.status = 'break' THEN
        -- Во время перерыва активная смена сохраняется, только если она действительно активна
        IF NEW.active_shift_id IS NOT NULL THEN
            SELECT * INTO v_shift FROM public.shifts WHERE id = NEW.active_shift_id;
            IF NOT FOUND OR v_shift.user_id != NEW.user_id OR v_shift.status != 'active' THEN
                NEW.active_shift_id := NULL;
                NEW.current_seller_account_id := NULL;
            ELSE
                NEW.current_seller_account_id := v_shift.seller_account_id;
            END IF;
        ELSE
            NEW.current_seller_account_id := NULL;
        END IF;
    END IF;

    -- Защита от подделки времени heartbeat в будущее
    IF NEW.last_heartbeat_at > (NOW() + INTERVAL '1 minute') THEN
        NEW.last_heartbeat_at := NOW();
    END IF;

    NEW.updated_at := NOW();
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_validate_operator_status ON public.operator_status;
CREATE TRIGGER trg_validate_operator_status
    BEFORE INSERT OR UPDATE ON public.operator_status
    FOR EACH ROW
    EXECUTE FUNCTION public.trg_fn_validate_operator_status();

-- ----------------------------------------------------------------------------
-- 5. Политики Row Level Security (RLS) для shifts
-- ----------------------------------------------------------------------------
ALTER TABLE public.shifts ENABLE ROW LEVEL SECURITY;

-- Чтение: доступно всем активным участникам команды
DROP POLICY IF EXISTS "shifts_select_team" ON public.shifts;
CREATE POLICY "shifts_select_team" ON public.shifts
    FOR SELECT TO authenticated
    USING (public.is_active_team_member());

-- Открытие смены: оператор открывает смену только для себя
DROP POLICY IF EXISTS "shifts_insert_own" ON public.shifts;
CREATE POLICY "shifts_insert_own" ON public.shifts
    FOR INSERT TO authenticated
    WITH CHECK (
        user_id = auth.uid() 
        AND status = 'active' 
        AND public.is_active_team_member()
    );

-- Закрытие смены: оператор может обновлять только свою незакрытую смену
DROP POLICY IF EXISTS "shifts_update_own_active" ON public.shifts;
CREATE POLICY "shifts_update_own_active" ON public.shifts
    FOR UPDATE TO authenticated
    USING (
        user_id = auth.uid() 
        AND status = 'active' 
        AND public.is_active_team_member()
    )
    WITH CHECK (user_id = auth.uid());

-- Корректировка смен руководителем: разрешена владельцу (owner)
DROP POLICY IF EXISTS "shifts_update_owner" ON public.shifts;
CREATE POLICY "shifts_update_owner" ON public.shifts
    FOR UPDATE TO authenticated
    USING (public.is_team_owner())
    WITH CHECK (public.is_team_owner());

-- Удаление смен запрещено полностью (сохранение истории)
DROP POLICY IF EXISTS "shifts_delete_forbidden" ON public.shifts;
CREATE POLICY "shifts_delete_forbidden" ON public.shifts
    FOR DELETE TO authenticated
    USING (false);

GRANT SELECT, INSERT, UPDATE ON public.shifts TO authenticated;
REVOKE ALL ON public.shifts FROM anon;

-- ----------------------------------------------------------------------------
-- 6. Политики Row Level Security (RLS) для operator_status
-- ----------------------------------------------------------------------------
ALTER TABLE public.operator_status ENABLE ROW LEVEL SECURITY;

-- Чтение: доступно всей активной команде
DROP POLICY IF EXISTS "operator_status_select" ON public.operator_status;
CREATE POLICY "operator_status_select" ON public.operator_status
    FOR SELECT TO authenticated
    USING (public.is_active_team_member());

-- Обновление/вставка своего статуса (heartbeat): каждый участник пишет только за себя
DROP POLICY IF EXISTS "operator_status_upsert_own" ON public.operator_status;
CREATE POLICY "operator_status_upsert_own" ON public.operator_status
    FOR ALL TO authenticated
    USING (user_id = auth.uid() AND public.is_active_team_member())
    WITH CHECK (user_id = auth.uid());

GRANT SELECT, INSERT, UPDATE ON public.operator_status TO authenticated;
REVOKE ALL ON public.operator_status FROM anon;
