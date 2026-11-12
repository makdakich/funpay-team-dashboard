BEGIN;

-- ============================================================================
-- Миграция: 010_multi_owner_and_access.sql
-- Назначение: Трёхуровневая модель доступа (Creator -> Owner -> Operator),
--             защита создателя системы, безопасное управление участниками из Dashboard,
--             журнал аудита прав (profile_audit_logs) и усиление безопасности RPC.
-- Архитектура: FunPay Team Dashboard v2.4 (Single-Team Architecture)
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Расширение таблицы profiles полями Creator и статуса приглашения
-- ----------------------------------------------------------------------------
ALTER TABLE public.profiles
    ADD COLUMN IF NOT EXISTS is_creator BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS invitation_status TEXT NOT NULL DEFAULT 'active'
        CHECK (invitation_status IN ('invited', 'pending_confirmation', 'active', 'inactive')),
    ADD COLUMN IF NOT EXISTS invited_by_user_id UUID REFERENCES public.profiles(user_id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS last_activity_at TIMESTAMPTZ DEFAULT NOW();

-- Аппаратный индекс целостности: в команде может существовать не более одного Создателя (Creator)
CREATE UNIQUE INDEX IF NOT EXISTS uq_profiles_single_creator 
    ON public.profiles (is_creator) 
    WHERE is_creator = true;

-- ----------------------------------------------------------------------------
-- 2. Верифицированное назначение первоначального Создателя (Creator)
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    v_creator_id UUID := '34a83ee3-dbc8-49c3-8982-c1ada97f094f';
    v_exists BOOLEAN;
BEGIN
    SELECT EXISTS (
        SELECT 1 FROM public.profiles 
        WHERE user_id = v_creator_id AND role = 'owner' AND is_active = true
    ) INTO v_exists;

    IF NOT v_exists THEN
        RAISE EXCEPTION 'Верификация отклонена: целевой профиль Создателя (%) не найден в profiles или не имеет роли owner/active', v_creator_id;
    END IF;

    -- Назначение флага Creator в доверенном административном контексте миграции
    UPDATE public.profiles
    SET is_creator = true,
        invitation_status = 'active',
        updated_at = NOW()
    WHERE user_id = v_creator_id;
END;
$$;

-- ----------------------------------------------------------------------------
-- 3. Журнал аудита прав участников (profile_audit_logs)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.profile_audit_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    target_user_id UUID NOT NULL REFERENCES public.profiles(user_id) ON DELETE RESTRICT,
    target_display_name TEXT NOT NULL,
    changed_by_user_id UUID REFERENCES public.profiles(user_id) ON DELETE SET NULL,
    changed_by_display_name TEXT NOT NULL,
    action TEXT NOT NULL CHECK (action IN (
        'invite_created', 
        'invite_resent', 
        'role_changed', 
        'member_activated', 
        'member_deactivated'
    )),
    old_role TEXT,
    new_role TEXT,
    old_active_status BOOLEAN,
    new_active_status BOOLEAN,
    reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_profile_audit_target 
    ON public.profile_audit_logs (target_user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_profile_audit_changed_by 
    ON public.profile_audit_logs (changed_by_user_id, created_at DESC);

-- RLS для журнала аудита профилей
ALTER TABLE public.profile_audit_logs ENABLE ROW LEVEL SECURITY;

-- Просмотр журнала разрешён только руководителям команды (owner)
DROP POLICY IF EXISTS "profile_audit_select_owner" ON public.profile_audit_logs;
CREATE POLICY "profile_audit_select_owner" ON public.profile_audit_logs
    FOR SELECT TO authenticated
    USING (public.is_team_owner());

-- Прямая запись запрещена для всех клиентов (только через SECURITY DEFINER RPC)
REVOKE INSERT, UPDATE, DELETE ON public.profile_audit_logs FROM authenticated, anon, PUBLIC;
GRANT SELECT ON public.profile_audit_logs TO authenticated;

-- ----------------------------------------------------------------------------
-- 4. Обновление триггера регистрации handle_new_user() (закрытая регистрация)
-- ----------------------------------------------------------------------------
-- Новые пользователи по умолчанию НЕАКТИВНЫ и имеют статус ожидания подтверждения.
-- КРИТИЧЕСКАЯ БЕЗОПАСНОСТЬ: метаданные raw_user_meta_data полностью исключены
-- из присвоения каких-либо привилегированных системных полей.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    -- При любой регистрации через Auth (включая публичный signUp с поддельными options.data):
    -- 1. role = 'operator' (принудительно, исключает самовозвышение до owner)
    -- 2. is_creator = false (Создатель назначается только административной миграцией)
    -- 3. is_active = false (закрытая регистрация, аккаунт заблокирован до подтверждения)
    -- 4. invitation_status = 'pending_confirmation'
    -- 5. invited_by_user_id = NULL (исключает спуфинг автора приглашения)
    --
    -- Все привилегированные поля (invited_by_user_id, role = 'owner', invitation_status = 'invited')
    -- могут устанавливаться ИСКЛЮЧИТЕЛЬНО доверенной серверной Edge Function (invite-member)
    -- с использованием service_role после валидации JWT вызывающего руководителя и его прав!
    INSERT INTO public.profiles (
        user_id, 
        display_name, 
        role, 
        is_active, 
        is_creator,
        invitation_status,
        invited_by_user_id,
        avatar_url,
        created_at,
        updated_at
    ) VALUES (
        NEW.id,
        COALESCE(
            NULLIF(TRIM(NEW.raw_user_meta_data->>'display_name'), ''),
            NULLIF(TRIM(NEW.raw_user_meta_data->>'full_name'), ''),
            NULLIF(TRIM(split_part(NEW.email, '@', 1)), ''),
            'Оператор'
        ),
        'operator',
        false, -- КРИТИЧЕСКАЯ БЕЗОПАСНОСТЬ: закрытая регистрация, по умолчанию строго неактивен!
        false, -- Creator назначается только административной миграцией
        'pending_confirmation',
        NULL,  -- Защита от spoofing: invited_by_user_id устанавливается только Edge Function (service_role)
        NEW.raw_user_meta_data->>'avatar_url',
        NOW(),
        NOW()
    )
    ON CONFLICT (user_id) DO NOTHING;

    RETURN NEW;
END;
$$;

-- ----------------------------------------------------------------------------
-- 5. Защитный триггер профилей с иммунитетом Creator (trg_fn_protect_profile_fields)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.trg_fn_protect_profile_fields()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_caller_id UUID := auth.uid();
    v_is_admin BOOLEAN := (auth.role() = 'service_role' OR (session_user = 'postgres' AND auth.role() IS NULL));
    v_is_caller_owner BOOLEAN := public.is_team_owner();
    v_is_caller_creator BOOLEAN := false;
BEGIN
    -- 1. user_id и created_at неизменяемы абсолютно для всех
    IF NEW.user_id IS DISTINCT FROM OLD.user_id THEN
        RAISE EXCEPTION 'Запрещено изменять user_id профиля';
    END IF;
    IF NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'Запрещено изменять дату создания профиля (created_at)';
    END IF;

    -- 2. Защита флага is_creator от клиентских манипуляций
    IF NOT v_is_admin THEN
        IF NEW.is_creator IS DISTINCT FROM OLD.is_creator THEN
            RAISE EXCEPTION 'Запрещено изменять признак Создателя системы (is_creator)';
        END IF;
    END IF;

    -- 3. Запрет любых клиентских модификаций автора приглашения (invited_by_user_id)
    IF NOT v_is_admin THEN
        IF NEW.invited_by_user_id IS DISTINCT FROM OLD.invited_by_user_id THEN
            RAISE EXCEPTION 'Запрещено изменять автора приглашения (invited_by_user_id)';
        END IF;
    END IF;

    -- 4. Иммунитет Создателя системы:
    -- Никакой клиентский пользователь (даже другой Owner) не может понизить роль или деактивировать Creator
    IF OLD.is_creator = true AND NOT v_is_admin THEN
        IF NEW.role != 'owner' THEN
            RAISE EXCEPTION 'Запрещено изменять роль Создателя команды';
        END IF;
        IF NEW.is_active = false THEN
            RAISE EXCEPTION 'Запрещено деактивировать аккаунт Создателя команды';
        END IF;
    END IF;

    -- 5. Ограничения для обычных пользователей (не руководителей)
    IF NOT v_is_caller_owner AND NOT v_is_admin THEN
        IF NEW.role IS DISTINCT FROM OLD.role THEN
            RAISE EXCEPTION 'Запрещено самостоятельно изменять роль (role)';
        END IF;
        IF NEW.is_active IS DISTINCT FROM OLD.is_active THEN
            RAISE EXCEPTION 'Запрещено самостоятельно изменять статус активности (is_active)';
        END IF;
        IF NEW.invitation_status IS DISTINCT FROM OLD.invitation_status THEN
            RAISE EXCEPTION 'Запрещено самостоятельно изменять статус приглашения';
        END IF;
    END IF;

    -- 6. Ограничения между руководителями (если вызывающий — обычный Owner, а не Creator):
    IF v_is_caller_owner AND NOT v_is_admin THEN
        SELECT is_creator INTO v_is_caller_creator FROM public.profiles WHERE user_id = v_caller_id;
        v_is_caller_creator := COALESCE(v_is_caller_creator, false);

        -- Только Создатель системы может назначать роль руководителя (owner)
        IF NOT v_is_caller_creator AND NEW.role = 'owner' AND OLD.role IS DISTINCT FROM 'owner' THEN
            RAISE EXCEPTION 'Только Создатель системы может назначать роль руководителя (owner)';
        END IF;

        -- Обычный Owner не может менять роль или статус другого Owner
        IF NOT v_is_caller_creator AND OLD.role = 'owner' AND OLD.user_id != v_caller_id THEN
            IF NEW.role IS DISTINCT FROM OLD.role OR NEW.is_active IS DISTINCT FROM OLD.is_active THEN
                RAISE EXCEPTION 'Второй руководитель не имеет полномочий изменять роль или активность других руководителей';
            END IF;
        END IF;

        -- Запрещено снимать статус с себя, если в системе не останется активных руководителей
        IF OLD.role = 'owner' AND (NEW.role != 'owner' OR NEW.is_active = false) THEN
            IF (SELECT COUNT(*) FROM public.profiles WHERE role = 'owner' AND is_active = true AND user_id != OLD.user_id) < 1 THEN
                RAISE EXCEPTION 'Запрещено: в системе должен оставаться как минимум один активный руководитель команды';
            END IF;
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
-- 6. RPC: set_member_role (Назначение ролей с защитой Creator и аудитом)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_member_role(
    p_target_user_id UUID,
    p_new_role TEXT,
    p_reason TEXT DEFAULT 'Смена роли через панель управления'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_caller_id UUID := auth.uid();
    v_caller_profile public.profiles%ROWTYPE;
    v_target_profile public.profiles%ROWTYPE;
BEGIN
    -- 1. Проверка авторизации
    IF v_caller_id IS NULL OR NOT public.is_team_owner() THEN
        RAISE EXCEPTION 'Доступ запрещён: управлять ролями могут только руководители команды';
    END IF;

    SELECT * INTO v_caller_profile FROM public.profiles WHERE user_id = v_caller_id;
    SELECT * INTO v_target_profile FROM public.profiles WHERE user_id = p_target_user_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Целевой пользователь (%) не найден в profiles', p_target_user_id;
    END IF;

    -- 2. Валидация роли
    IF p_new_role NOT IN ('owner', 'operator') THEN
        RAISE EXCEPTION 'Недопустимая роль: %. Допустимы только owner и operator', p_new_role;
    END IF;

    -- 3. Иммунитет Creator: никто не может изменить роль Создателя
    IF v_target_profile.is_creator = true THEN
        RAISE EXCEPTION 'Запрещено изменять роль Создателя системы';
    END IF;

    -- 4. Только Creator может назначать или снимать роль Owner
    IF (p_new_role = 'owner' OR v_target_profile.role = 'owner') AND v_caller_profile.is_creator != true THEN
        RAISE EXCEPTION 'Только Создатель системы (Creator) может назначать или отзывать роль Руководителя (owner)';
    END IF;

    IF v_target_profile.role = p_new_role THEN
        RETURN jsonb_build_object('success', true, 'message', 'Роль уже назначена');
    END IF;

    -- 5. Обновление роли
    UPDATE public.profiles
    SET role = p_new_role, updated_at = NOW()
    WHERE user_id = p_target_user_id;

    -- 6. Запись в журнал аудита
    INSERT INTO public.profile_audit_logs (
        target_user_id,
        target_display_name,
        changed_by_user_id,
        changed_by_display_name,
        action,
        old_role,
        new_role,
        old_active_status,
        new_active_status,
        reason,
        created_at
    ) VALUES (
        p_target_user_id,
        v_target_profile.display_name,
        v_caller_id,
        v_caller_profile.display_name,
        'role_changed',
        v_target_profile.role,
        p_new_role,
        v_target_profile.is_active,
        v_target_profile.is_active,
        TRIM(p_reason),
        NOW()
    );

    RETURN jsonb_build_object('success', true, 'user_id', p_target_user_id, 'new_role', p_new_role);
END;
$$;

REVOKE ALL ON FUNCTION public.set_member_role(UUID, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_member_role(UUID, TEXT, TEXT) TO authenticated;

-- ----------------------------------------------------------------------------
-- 7. RPC: set_member_active (Активация и деактивация участников с аудитом)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_member_active(
    p_target_user_id UUID,
    p_is_active BOOLEAN,
    p_reason TEXT DEFAULT 'Изменение статуса активности через панель управления'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_caller_id UUID := auth.uid();
    v_caller_profile public.profiles%ROWTYPE;
    v_target_profile public.profiles%ROWTYPE;
    v_action TEXT;
BEGIN
    -- 1. Проверка прав
    IF v_caller_id IS NULL OR NOT public.is_team_owner() THEN
        RAISE EXCEPTION 'Доступ запрещён: изменять активность участников могут только руководители команды';
    END IF;

    SELECT * INTO v_caller_profile FROM public.profiles WHERE user_id = v_caller_id;
    SELECT * INTO v_target_profile FROM public.profiles WHERE user_id = p_target_user_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Целевой пользователь (%) не найден в profiles', p_target_user_id;
    END IF;

    -- 2. Иммунитет Creator: Создатель не может быть деактивирован никем
    IF v_target_profile.is_creator = true AND p_is_active = false THEN
        RAISE EXCEPTION 'Запрещено деактивировать аккаунт Создателя системы';
    END IF;

    -- 3. Второй Owner не может деактивировать другого Owner (только Creator может)
    IF v_target_profile.role = 'owner' AND p_is_active = false AND v_caller_profile.is_creator != true THEN
        RAISE EXCEPTION 'Второй руководитель не имеет полномочий деактивировать руководителей команды';
    END IF;

    -- 4. Защита от деактивации последнего руководителя
    IF v_target_profile.role = 'owner' AND p_is_active = false THEN
        IF (SELECT COUNT(*) FROM public.profiles WHERE role = 'owner' AND is_active = true AND user_id != p_target_user_id) < 1 THEN
            RAISE EXCEPTION 'Запрещено деактивировать единственного активного руководителя команды';
        END IF;
    END IF;

    IF v_target_profile.is_active = p_is_active THEN
        RETURN jsonb_build_object('success', true, 'message', 'Статус активности не изменился');
    END IF;

    -- 5. Обновление статуса
    UPDATE public.profiles
    SET is_active = p_is_active,
        invitation_status = CASE WHEN p_is_active THEN 'active' ELSE 'inactive' END,
        updated_at = NOW()
    WHERE user_id = p_target_user_id;

    v_action := CASE WHEN p_is_active THEN 'member_activated' ELSE 'member_deactivated' END;

    -- 6. Запись в журнал аудита
    INSERT INTO public.profile_audit_logs (
        target_user_id,
        target_display_name,
        changed_by_user_id,
        changed_by_display_name,
        action,
        old_role,
        new_role,
        old_active_status,
        new_active_status,
        reason,
        created_at
    ) VALUES (
        p_target_user_id,
        v_target_profile.display_name,
        v_caller_id,
        v_caller_profile.display_name,
        v_action,
        v_target_profile.role,
        v_target_profile.role,
        v_target_profile.is_active,
        p_is_active,
        TRIM(p_reason),
        NOW()
    );

    RETURN jsonb_build_object('success', true, 'user_id', p_target_user_id, 'is_active', p_is_active);
END;
$$;

REVOKE ALL ON FUNCTION public.set_member_active(UUID, BOOLEAN, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_member_active(UUID, BOOLEAN, TEXT) TO authenticated;

-- ----------------------------------------------------------------------------
-- 8. Усиление безопасности RPC reassign_order_operator
-- ----------------------------------------------------------------------------
-- Разрешаем ручное переназначение заказов ТОЛЬКО руководителям (is_team_owner)
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
    -- 1. УСИЛЕННАЯ ПРОВЕРКА: только руководитель (owner) имеет право переназначать заказы
    IF v_caller_id IS NULL OR NOT public.is_team_owner() THEN
        RAISE EXCEPTION 'Доступ запрещён: переназначать операторов на заказы могут только руководители команды';
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

    -- 4. Проверка нового оператора
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

    -- Защита от холостого вызова
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
        shift_id = NULL,
        attribution_status = CASE WHEN p_new_operator_id IS NOT NULL THEN 'assigned' ELSE 'unassigned' END,
        attribution_source = 'manual',
        updated_at = NOW()
    WHERE seller_account_id = p_seller_account_id AND order_id = p_order_id;

    -- 8. Фиксация в аудит-логе заказов
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
        COALESCE(v_caller_name, 'Руководитель'),
        TRIM(p_reason),
        NOW()
    );
END;
$$;

REVOKE ALL ON FUNCTION public.reassign_order_operator(TEXT, TEXT, UUID, TEXT) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.reassign_order_operator(TEXT, TEXT, UUID, TEXT) TO authenticated;

COMMIT;
