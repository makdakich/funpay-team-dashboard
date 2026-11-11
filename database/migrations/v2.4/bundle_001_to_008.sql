-- ============================================================================
-- FANPAY TEAM DASHBOARD v2.4 - UNIFIED MIGRATION BUNDLE (001-008)
-- Idempotent transactional deployment for Staging / Production
-- ============================================================================

BEGIN;

-- >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
-- START: 001_profiles_and_auth.sql
-- >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>

-- ============================================================================
-- Миграция: 001_profiles_and_auth.sql
-- Назначение: Создание таблицы профилей команды, автоматического триггера создания
--             профилей при регистрации в auth.users, безопасного одноразового
--             bootstrap-механизма первого owner, некурсивных функций проверки прав
--             и триггера защиты системных полей от несанкционированного изменения.
-- Архитектура: FanPay Team Dashboard v2.4 (Single-Team Architecture)
-- ============================================================================

-- Включаем расширение для генерации UUID, если оно ещё не включено
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ----------------------------------------------------------------------------
-- 1. Таблица профилей участников команды (profiles)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.profiles (
    user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    display_name TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'operator' CHECK (role IN ('owner', 'operator')),
    is_active BOOLEAN NOT NULL DEFAULT true,
    avatar_url TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Индекс для ускорения проверок активных участников
CREATE INDEX IF NOT EXISTS idx_profiles_active_role 
    ON public.profiles(user_id, role, is_active);

-- ----------------------------------------------------------------------------
-- 2. Вспомогательная функция проверки активности участника (БЕЗ РЕКУРСИИ RLS)
-- ----------------------------------------------------------------------------
-- Привязана строго к auth.uid(), исключая Boolean side-channel зондирования чужих UUID.
-- Выполняется с правами владельца схемы (SECURITY DEFINER) и обходит RLS,
-- предотвращая зацикливание политик при подзапросах к таблице profiles.
CREATE OR REPLACE FUNCTION public.is_active_team_member()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.profiles
        WHERE user_id = auth.uid() AND is_active = true
    );
$$;

REVOKE ALL ON FUNCTION public.is_active_team_member() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_active_team_member() TO authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 3. Вспомогательная функция проверки прав руководителя (owner)
-- ----------------------------------------------------------------------------
-- Привязана строго к auth.uid(), исключая Boolean side-channel зондирования чужих UUID.
CREATE OR REPLACE FUNCTION public.is_team_owner()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.profiles
        WHERE user_id = auth.uid() AND role = 'owner' AND is_active = true
    );
$$;

REVOKE ALL ON FUNCTION public.is_team_owner() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_team_owner() TO authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 4. Автоматическое создание профиля при регистрации в auth.users
-- ----------------------------------------------------------------------------
-- Гарантирует, что каждый пользователь Supabase Auth получает профиль в public.profiles.
-- Роль ВСЕГДА принудительно выставляется как 'operator', исключая клиентские манипуляции.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    INSERT INTO public.profiles (user_id, display_name, role, is_active, avatar_url)
    VALUES (
        NEW.id,
        COALESCE(
            NEW.raw_user_meta_data->>'display_name',
            NEW.raw_user_meta_data->>'full_name',
            split_part(NEW.email, '@', 1),
            'Оператор'
        ),
        'operator', -- Клиент никогда не может назначить себе роль owner
        true,
        NEW.raw_user_meta_data->>'avatar_url'
    )
    ON CONFLICT (user_id) DO NOTHING;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
    AFTER INSERT ON auth.users
    FOR EACH ROW
    EXECUTE FUNCTION public.handle_new_user();

-- ----------------------------------------------------------------------------
-- 5. Защищённый одноразовый bootstrap-механизм назначения первого owner
-- ----------------------------------------------------------------------------
-- Доступен ТОЛЬКО административному контексту: service_role или суперпользователю postgres.
-- Использует транзакционную рекомендательную блокировку (pg_advisory_xact_lock)
-- для исключения состояния гонки (race condition) при параллельных вызовах.
CREATE OR REPLACE FUNCTION public.bootstrap_initial_owner(p_target_user_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    -- 1. Доступ разрешён только доверенному контексту (проверка session_user и auth.role())
    IF NOT (auth.role() = 'service_role' OR (session_user = 'postgres' AND auth.role() IS NULL)) THEN
        RAISE EXCEPTION 'Доступ запрещён: вызов bootstrap_initial_owner разрешён только роли service_role или суперпользователю postgres';
    END IF;

    -- 2. Атомарная блокировка на уровне транзакции для предотвращения гонок
    PERFORM pg_advisory_xact_lock(hashtext('bootstrap_initial_owner_lock'));

    -- 3. Одноразовость: проверяем отсутствие владельцев в команде
    IF EXISTS (SELECT 1 FROM public.profiles WHERE role = 'owner') THEN
        RAISE EXCEPTION 'Инициализация отклонена: в системе уже назначен руководитель (owner)';
    END IF;

    -- 4. Проверяем существование и активность целевого профиля
    IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE user_id = p_target_user_id AND is_active = true) THEN
        RAISE EXCEPTION 'Пользователь с указанным ID (%) не найден в таблице profiles или деактивирован', p_target_user_id;
    END IF;

    -- 5. Атомарное назначение роли owner
    UPDATE public.profiles
    SET role = 'owner', is_active = true, updated_at = NOW()
    WHERE user_id = p_target_user_id;
END;
$$;

REVOKE ALL ON FUNCTION public.bootstrap_initial_owner(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bootstrap_initial_owner(UUID) TO service_role;

-- ----------------------------------------------------------------------------
-- 6. Триггер защиты системных полей (user_id, created_at, role, is_active)
-- ----------------------------------------------------------------------------
-- Блокирует попытку оператора самостоятельно повысить роль или активировать себя.
-- Руководитель (owner) и доверенный контекст имеют право изменять роли и активность участников.
-- Первичный ключ user_id и дата регистрации created_at защищены от изменения для ВСЕХ.
CREATE OR REPLACE FUNCTION public.trg_fn_protect_profile_fields()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_is_admin BOOLEAN := (auth.role() = 'service_role' OR (session_user = 'postgres' AND auth.role() IS NULL));
    v_is_owner BOOLEAN := public.is_team_owner();
BEGIN
    -- user_id (первичный ключ) нельзя менять никому
    IF NEW.user_id IS DISTINCT FROM OLD.user_id THEN
        RAISE EXCEPTION 'Запрещено изменять user_id профиля';
    END IF;

    -- created_at нельзя менять никому
    IF NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'Запрещено изменять дату создания профиля (created_at)';
    END IF;

    -- Рядовые участники (не owner и не доверенный админ) не могут изменять системные поля
    IF NOT v_is_owner AND NOT v_is_admin THEN
        IF NEW.role IS DISTINCT FROM OLD.role THEN
            RAISE EXCEPTION 'Запрещено самостоятельно изменять роль (role)';
        END IF;
        IF NEW.is_active IS DISTINCT FROM OLD.is_active THEN
            RAISE EXCEPTION 'Запрещено самостоятельно изменять статус активности (is_active)';
        END IF;
    END IF;

    NEW.updated_at := NOW();
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_protect_profile_fields ON public.profiles;
CREATE TRIGGER trg_protect_profile_fields
    BEFORE UPDATE ON public.profiles
    FOR EACH ROW
    EXECUTE FUNCTION public.trg_fn_protect_profile_fields();

-- ----------------------------------------------------------------------------
-- 7. Политики Row Level Security (RLS) для profiles
-- ----------------------------------------------------------------------------
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

-- Чтение: участник всегда видит свой профиль;
-- профили коллег активные участники видят только если коллега активен (is_active = true);
-- руководитель видит все профили команды, включая деактивированные.
DROP POLICY IF EXISTS "profiles_select_policy" ON public.profiles;
CREATE POLICY "profiles_select_policy" ON public.profiles
    FOR SELECT TO authenticated
    USING (
        user_id = auth.uid() 
        OR (public.is_active_team_member() AND is_active = true)
        OR public.is_team_owner()
    );

-- Обновление: обычный активный участник может обновлять только разрешённые поля своего профиля
DROP POLICY IF EXISTS "profiles_update_own" ON public.profiles;
CREATE POLICY "profiles_update_own" ON public.profiles
    FOR UPDATE TO authenticated
    USING (user_id = auth.uid() AND public.is_active_team_member())
    WITH CHECK (user_id = auth.uid());

-- Обновление: руководитель может изменять любые профили участников команды
DROP POLICY IF EXISTS "profiles_update_owner" ON public.profiles;
CREATE POLICY "profiles_update_owner" ON public.profiles
    FOR UPDATE TO authenticated
    USING (public.is_team_owner())
    WITH CHECK (public.is_team_owner());

-- Запрет на прямое удаление профилей (только мягкая деактивация is_active = false)
DROP POLICY IF EXISTS "profiles_delete_forbidden" ON public.profiles;
CREATE POLICY "profiles_delete_forbidden" ON public.profiles
    FOR DELETE TO authenticated
    USING (false);

GRANT SELECT, UPDATE ON public.profiles TO authenticated;


-- >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
-- START: 002_team_seller_accounts.sql
-- >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>

-- ============================================================================
-- Миграция: 002_team_seller_accounts.sql
-- Назначение: Реестр авторизованных аккаунтов продавца FunPay для команды.
--             Защищает от синхронизации заказов под произвольными или чужими ID.
-- Архитектура: FanPay Team Dashboard v2.4 (Single-Team Architecture)
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


-- >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
-- START: 003_shifts_and_status.sql
-- >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>

-- ============================================================================
-- Миграция: 003_shifts_and_status.sql
-- Назначение: Учёт рабочих смен операторов и мониторинг живого присутствия (heartbeat).
--             Реализует строгую защиту жизненного цикла смен и валидацию статусов:
--             1. Оператор не может подделывать историю, время или параметры смен.
--             2. Статус on_shift жёстко валидируется против реальной активной смены.
--             3. Частичный уникальный индекс исключает две активные смены одного пользователя.
--             4. При переходе в offline/online/break очищаются связанные поля статуса.
-- Архитектура: FanPay Team Dashboard v2.4 (Single-Team Architecture)
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


-- >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
-- START: 004_orders.sql
-- >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>

-- ============================================================================
-- Миграция: 004_orders.sql
-- Назначение: Реестр заказов FunPay с составным первичным ключом, индексами,
--             защитой неизменяемых финансовых полей и идентификаторов
--             и строгим ограничением прямого доступа (запись только через RPC).
-- Архитектура: FanPay Team Dashboard v2.4 (Single-Team Architecture)
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


-- >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
-- START: 005_order_audit_logs.sql
-- >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>

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


-- >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
-- START: 006_financial_discrepancies.sql
-- >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>

-- ============================================================================
-- Миграция: 006_financial_discrepancies.sql
-- Назначение: Реестр финансовых расхождений и аномалий времени, обнаруженных
--             при перекрёстной синхронизации заказов.
--             Защищает от скрытой подмены данных и фиксирует инциденты для владельца.
--             Защищён от удаления через ON DELETE RESTRICT и дедуплицирован.
-- Архитектура: FanPay Team Dashboard v2.4 (Single-Team Architecture)
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


-- >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
-- START: 007_shared_templates.sql
-- >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>

-- ============================================================================
-- Миграция: 007_shared_templates.sql
-- Назначение: Общие шаблоны сообщений и горячих клавиш для всей команды.
--             Серверный контроль уникальности shortcut, аудит авторства правок,
--             защита created_at от перезаписи клиентом и начальный перенос F1-F8.
-- Архитектура: FanPay Team Dashboard v2.4 (Single-Team Architecture)
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Таблица общих шаблонов команды (shared_templates)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.shared_templates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    shortcut TEXT NOT NULL,
    title TEXT NOT NULL,
    message TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'Общие',
    sort_order INTEGER NOT NULL DEFAULT 0,
    is_enabled BOOLEAN NOT NULL DEFAULT true,
    updated_by_user_id UUID REFERENCES public.profiles(user_id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- Серверная защита уникальности горячей клавиши (не более 1 шаблона на shortcut)
    CONSTRAINT uq_shared_templates_shortcut UNIQUE (shortcut)
);

CREATE INDEX IF NOT EXISTS idx_shared_templates_order 
    ON public.shared_templates (sort_order ASC, shortcut ASC);

-- ----------------------------------------------------------------------------
-- 2. Серверный триггер автоматического обновления updated_at и updated_by_user_id
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.trg_fn_shared_templates_audit()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF TG_OP = 'UPDATE' THEN
        -- Защита даты создания от подделки клиентом
        NEW.created_at := OLD.created_at;
    END IF;
    NEW.updated_at := NOW();
    -- Автор изменения всегда берётся из защищённого контекста auth.uid(), а не от клиента
    IF auth.uid() IS NOT NULL THEN
        NEW.updated_by_user_id := auth.uid();
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_shared_templates_audit ON public.shared_templates;
CREATE TRIGGER trg_shared_templates_audit
    BEFORE INSERT OR UPDATE ON public.shared_templates
    FOR EACH ROW
    EXECUTE FUNCTION public.trg_fn_shared_templates_audit();

-- ----------------------------------------------------------------------------
-- 3. Начальный перенос 8 шаблонов из локальной базы SQLite (F1–F8)
-- ----------------------------------------------------------------------------
-- Идемпотентная вставка: при повторном запуске конфликт по shortcut мягко пропускается
INSERT INTO public.shared_templates (shortcut, title, message, category, sort_order, is_enabled)
VALUES
    ('F1', '👋 Приветствие', '🌐 ОТКРЫТЫЙ ПРОФИЛЬ\nRoblox → ⚙️ Settings → Privacy & content restrictions → Visibility & private servers → Visibility\n🔹 Show current experience → Everyone\nПосле этого зайдите в нужный плейс и я зайду к вам', 'Roblox', 1, true),
    ('F2', '📋 Правила', '📦 Передача:\n1️⃣ Приватный сервер\n2️⃣ Открытый профиль\n⚠️ В друзья не добавляю.', 'Roblox', 2, true),
    ('F3', '📦 Заказ принят', 'Заказ принят в обработку! Начинаю выполнение, пожалуйста подождите пару минут.', 'Общие', 3, true),
    ('F4', '🎮 Game Pass', '🎮 Напишите:\n1️⃣ Какой Gamepass покупаете?\n2️⃣ В каком плейсе он находится?', 'Roblox', 6, true),
    ('F5', '⏳ Ожидание', 'Пожалуйста, ожидайте, процесс занимает несколько минут из-за нагрузки.', 'Общие', 4, false),
    ('F6', '💰 Оплата', 'Пожалуйста, проверьте статус оплаты заказа на FunPay.', 'Общие', 5, true),
    ('F7', '✅ Выдача', 'Товар успешно передан! Пожалуйста, проверьте получение и подтвердите заказ.', 'Общие', 7, true),
    ('F8', '⚠️ Проблема', 'Возникла непредвиденная ошибка при выдаче. Наш оператор уже решает проблему.', 'Общие', 8, true)
ON CONFLICT (shortcut) DO NOTHING;

-- ----------------------------------------------------------------------------
-- 4. Политики Row Level Security (RLS) для shared_templates
-- ----------------------------------------------------------------------------
ALTER TABLE public.shared_templates ENABLE ROW LEVEL SECURITY;

-- Чтение: доступно всей активной команде
DROP POLICY IF EXISTS "shared_templates_select" ON public.shared_templates;
CREATE POLICY "shared_templates_select" ON public.shared_templates
    FOR SELECT TO authenticated
    USING (public.is_active_team_member());

-- Создание, редактирование и удаление: доступно всей активной команде (совместная работа)
DROP POLICY IF EXISTS "shared_templates_write" ON public.shared_templates;
CREATE POLICY "shared_templates_write" ON public.shared_templates
    FOR ALL TO authenticated
    USING (public.is_active_team_member())
    WITH CHECK (public.is_active_team_member());

GRANT SELECT, INSERT, UPDATE, DELETE ON public.shared_templates TO authenticated;
REVOKE ALL ON public.shared_templates FROM anon;


-- >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
-- START: 008_rpc_functions.sql
-- >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>

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


-- ============================================================================
-- ALL MIGRATIONS 001-008 SUCCESSFULLY APPLIED - COMMIT TRANSACTION
-- ============================================================================
COMMIT;
