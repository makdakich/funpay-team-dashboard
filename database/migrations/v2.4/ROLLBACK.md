# Протокол безопасного отката миграций (ROLLBACK) — v2.4

Данный регламент описывает 3-уровневую модель безопасного отката изменений схемы базы данных FanPay Team Dashboard v2.4.

```
                           УРОВНИ ОТКАТА (ROLLBACK TIERS)
 ┌─────────────────────────────────────────────────────────────────────────────┐
 │ УРОВЕНЬ 1: Тестовый стенд / Полный сброс (Clean Staging / Dev Wipe)         │
 │ • Удаление всех объектов v2.4 в обратном порядке зависимостей               │
 │ • Очистка триггеров на auth.users и системных RPC                           │
 ├─────────────────────────────────────────────────────────────────────────────┤
 │ УРОВЕНЬ 2: Восстановление при частичном сбое миграции (Mid-Migration)       │
 │ • Точечный откат конкретного упавшего шага (001–008)                        │
 │ • Использование идемпотентности миграций для безопасного перезапуска        │
 ├─────────────────────────────────────────────────────────────────────────────┤
 │ УРОВЕНЬ 3: Производственная среда (Production Data Safety Protocol)         │
 │ • КАТЕГОРИЧЕСКИЙ ЗАПРЕТ на DROP TABLE CASCADE при наличии боевых данных     │
 │ • Предварительные бэкапы (pg_dump, Supabase PITR) и неразрушающие действия  │
 └─────────────────────────────────────────────────────────────────────────────┘
```

---

## 1. Уровень 1: Полный сброс тестового контура (Staging / Dev Clean Wipe)

Применяется **только** на изолированных тестовых базах данных (staging / local development) для возврата схемы в исходное чистое состояние до применения миграций v2.4.

Скрипт удаляет объекты в строгом обратном порядке внешних ключей и зависимостей, предотвращая ошибки `foreign_key_violation` и `dependent_objects_still_exist`.

### Исполняемый SQL-скрипт полного отката:

```sql
-- ============================================================================
-- СКРИПТ ПОЛНОГО ОТКАТА СХЕМЫ FANPAY TEAM DASHBOARD v2.4 (DEV / STAGING ONLY)
-- ============================================================================

-- ШАГ 1: Удаление RPC-функций и процедур bootstrap
DROP FUNCTION IF EXISTS public.recalculate_shift_attributions(UUID, TIMESTAMPTZ, TIMESTAMPTZ);
DROP FUNCTION IF EXISTS public.recalculate_shift_attributions(UUID);
DROP FUNCTION IF EXISTS public.reassign_order_operator(TEXT, TEXT, UUID, TEXT);
DROP FUNCTION IF EXISTS public.sync_orders_batch(TEXT, JSONB);
DROP FUNCTION IF EXISTS public.bootstrap_initial_owner(UUID);

-- ШАГ 2: Удаление триггеров и функций регистрации auth.users
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
DROP FUNCTION IF EXISTS public.handle_new_user();

-- ШАГ 3: Удаление прикладных триггеров и их триггерных функций
DROP TRIGGER IF EXISTS trg_shared_templates_audit ON public.shared_templates;
DROP FUNCTION IF EXISTS public.trg_fn_shared_templates_audit();

DROP TRIGGER IF EXISTS trg_protect_order_fields ON public.orders;
DROP FUNCTION IF EXISTS public.trg_fn_protect_order_immutable_fields();

DROP TRIGGER IF EXISTS trg_validate_operator_status ON public.operator_status;
DROP FUNCTION IF EXISTS public.trg_fn_validate_operator_status();

DROP TRIGGER IF EXISTS trg_protect_shift_fields ON public.shifts;
DROP FUNCTION IF EXISTS public.trg_fn_protect_shift_fields();

DROP TRIGGER IF EXISTS trg_protect_profile_fields ON public.profiles;
DROP FUNCTION IF EXISTS public.trg_fn_protect_profile_fields();

-- ШАГ 4: Удаление таблиц в строгом обратном порядке зависимостей FK
DROP TABLE IF EXISTS public.order_financial_discrepancies CASCADE;
DROP TABLE IF EXISTS public.order_audit_logs CASCADE;
DROP TABLE IF EXISTS public.orders CASCADE;
DROP TABLE IF EXISTS public.operator_status CASCADE;
DROP TABLE IF EXISTS public.shifts CASCADE;
DROP TABLE IF EXISTS public.team_seller_accounts CASCADE;
DROP TABLE IF EXISTS public.shared_templates CASCADE;
DROP TABLE IF EXISTS public.profiles CASCADE;

-- ШАГ 5: Удаление вспомогательных функций верификации доступа (RLS helpers)
DROP FUNCTION IF EXISTS public.is_team_owner();
DROP FUNCTION IF EXISTS public.is_team_owner(UUID);
DROP FUNCTION IF EXISTS public.is_active_team_member();
DROP FUNCTION IF EXISTS public.is_active_team_member(UUID);

-- ============================================================================
-- ПОЛНЫЙ СБРОС ЗАВЕРШЁН. СХЕМА PUBLIC ОЧИЩЕНА ОТ ОБЪЕКТОВ v2.4
-- ============================================================================
```

---

## 2. Уровень 2: Восстановление при частичном сбое (Mid-Migration Recovery)

Если применение пакета миграций прервалось на шаге `N` (например, из-за сетевого сбоя или недостатка прав), **не запускайте последующие миграции**.

### Алгоритм локализации:
1. Зафиксируйте точный номер файла и текст ошибки в консоли Supabase.
2. Определите, какие объекты из упавшего файла успели создаться.
3. Выполните точечный откат только для упавшего файла по таблице ниже:

| Упавший файл | Создаваемые объекты | Команды точечного отката для повтора шага |
| :--- | :--- | :--- |
| **001_profiles_and_auth.sql** | `profiles`, триггер `on_auth_user_created`, `is_active_team_member`, `is_team_owner`, `bootstrap_initial_owner` | ```sql DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users; DROP FUNCTION IF EXISTS public.handle_new_user(); DROP TABLE IF EXISTS public.profiles CASCADE; DROP FUNCTION IF EXISTS public.is_team_owner(); DROP FUNCTION IF EXISTS public.is_active_team_member(); DROP FUNCTION IF EXISTS public.bootstrap_initial_owner(UUID);``` |
| **002_team_seller_accounts.sql** | Таблица `team_seller_accounts` и RLS | ```sql DROP TABLE IF EXISTS public.team_seller_accounts CASCADE;``` |
| **003_shifts_and_status.sql** | `shifts`, `operator_status`, триггеры смен и статуса | ```sql DROP TABLE IF EXISTS public.operator_status CASCADE; DROP TABLE IF EXISTS public.shifts CASCADE; DROP FUNCTION IF EXISTS public.trg_fn_validate_operator_status(); DROP FUNCTION IF EXISTS public.trg_fn_protect_shift_fields();``` |
| **004_orders.sql** | Таблица `orders`, составной PK, триггер неизменяемости | ```sql DROP TABLE IF EXISTS public.orders CASCADE; DROP FUNCTION IF EXISTS public.trg_fn_protect_order_immutable_fields();``` |
| **005_order_audit_logs.sql** | Таблица `order_audit_logs` и RLS | ```sql DROP TABLE IF EXISTS public.order_audit_logs CASCADE;``` |
| **006_financial_discrepancies.sql**| Таблица `order_financial_discrepancies` | ```sql DROP TABLE IF EXISTS public.order_financial_discrepancies CASCADE;``` |
| **007_shared_templates.sql** | `shared_templates`, начальный сид F1–F8 | ```sql DROP TABLE IF EXISTS public.shared_templates CASCADE; DROP FUNCTION IF EXISTS public.trg_fn_shared_templates_audit();``` |
| **008_rpc_functions.sql** | 3 RPC: `sync_orders_batch`, `reassign_order_operator`, `recalculate_shift_attributions` | ```sql DROP FUNCTION IF EXISTS public.recalculate_shift_attributions(UUID, TIMESTAMPTZ, TIMESTAMPTZ); DROP FUNCTION IF EXISTS public.reassign_order_operator(TEXT, TEXT, UUID, TEXT); DROP FUNCTION IF EXISTS public.sync_orders_batch(TEXT, JSONB);``` |

### Принцип идемпотентности миграций:
Все файлы v2.4 спроектированы с поддержкой безопасного повторного применения:
- Таблицы создаются через `CREATE TABLE IF NOT EXISTS`.
- Индексы создаются через `CREATE INDEX IF NOT EXISTS`.
- Политики RLS безопасно обновляются конструкцией `DROP POLICY IF EXISTS ...; CREATE POLICY ...`.
- Функции объявляются через `CREATE OR REPLACE FUNCTION`.
- Начальные шаблоны вставляются через `INSERT ... ON CONFLICT (shortcut) DO NOTHING`.

После устранения причины ошибки вы можете безопасно перезапустить упавший файл миграции.

---

## 3. Уровень 3: Производственный протокол безопасности данных (Production Protocol)

> [!CAUTION]
> **КАТЕГОРИЧЕСКИЙ ЗАПРЕТ НА CASCADE DROP В PRODUCTION:**
> Если в базе данных уже сохранены реальные заказы, аудит или смены операторов, выполнение `DROP TABLE ... CASCADE` приведёт к **безвозвратной потере финансовых данных**.

### 3.1. Обязательные подготовительные требования (Pre-requisites)
Перед выполнением любых изменений схемы в рабочей базе:
1. **Создание физического снимка (Snapshot / PITR):**
   Убедитесь, что в Supabase активирован Point-in-Time Recovery (PITR) либо создан свежий ручной бэкап проекта.
2. **Логический экспорт таблиц через `pg_dump`:**
   ```bash
   pg_dump -h db.zlpbywengymnvrpbcxvh.supabase.co -U postgres -d postgres \
     -t public.orders -t public.shifts -t public.order_audit_logs \
     -f pre_migration_backup_$(date +%Y%m%d_%H%M%S).sql
   ```

### 3.2. Неразрушающий откат при сбое на проде (Non-Destructive Rollback)
Если после развёртывания обнаружена критическая логическая ошибка в RPC или триггере:

1. **Блокировка входящей синхронизации (Graceful Maintenance):**
   Вместо удаления таблиц отключите магазин продавца:
   ```sql
   UPDATE public.team_seller_accounts SET is_active = false WHERE seller_account_id = :seller_id;
   ```
   Это мгновенно заблокирует запуск новых смен и синхронизацию заказов на уровне RPC без повреждения истории.

2. **Откат конкретной RPC-функции к предыдущей версии:**
   Замените тело проблемной функции `CREATE OR REPLACE FUNCTION public.sync_orders_batch(...)` на предыдущую стабильную реализацию. Схема таблиц при этом остаётся нетронутой.

3. **Отключение защитного триггера при аварийной фиксации данных:**
   Если триггер блокирует критическое исправление администратором:
   ```sql
   ALTER TABLE public.orders DISABLE TRIGGER trg_protect_order_fields;
   -- Выполнение корректирующей транзакции владельцем команды...
   ALTER TABLE public.orders ENABLE TRIGGER trg_protect_order_fields;
   ```

4. **Полное восстановление из бэкапа (Disaster Recovery):**
   В случае неразрешимого повреждения данных выполните восстановление проекта через Supabase Dashboard (Settings -> Backups -> Restore) на временную отметку до начала миграции.
