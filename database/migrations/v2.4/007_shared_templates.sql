-- ============================================================================
-- Миграция: 007_shared_templates.sql
-- Назначение: Общие шаблоны сообщений и горячих клавиш для всей команды.
--             Серверный контроль уникальности shortcut, аудит авторства правок,
--             защита created_at от перезаписи клиентом и начальный перенос F1-F8.
-- Архитектура: FunPay Team Dashboard v2.4 (Single-Team Architecture)
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
