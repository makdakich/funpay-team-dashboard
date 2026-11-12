-- ============================================================================
-- Миграция: 001_profiles_and_auth.sql
-- Назначение: Создание таблицы профилей команды, автоматического триггера создания
--             профилей при регистрации в auth.users, безопасного одноразового
--             bootstrap-механизма первого owner, некурсивных функций проверки прав
--             и триггера защиты системных полей от несанкционированного изменения.
-- Архитектура: FunPay Team Dashboard v2.4 (Single-Team Architecture)
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
