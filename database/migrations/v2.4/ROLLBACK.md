# Протокол безопасного отката миграций (ROLLBACK) — v2.4

Данный регламент описывает 3-уровневую модель безопасного отката изменений схемы базы данных FunPay Team Dashboard v2.4.

```
                           УРОВНИ ОТКАТА (ROLLBACK TIERS)
 ┌─────────────────────────────────────────────────────────────────────────────┐
 │ УРОВЕНЬ 1: Тестовый стенд / Полный сброс (Clean Staging / Dev Wipe)         │
 │ • Удаление всех объектов v2.4 в обратном порядке зависимостей               │
 │ • Очистка триггеров на auth.users и системных RPC                           │
 ├─────────────────────────────────────────────────────────────────────────────┤
 │ УРОВЕНЬ 2: Восстановление при частичном сбое миграции (Mid-Migration)       │
 │ • Точечный откат конкретного упавшего шага (001–010)                        │
 │ • Использование идемпотентности миграций для безопасного перезапуска        │
 ├─────────────────────────────────────────────────────────────────────────────┤
 │ УРОВЕНЬ 3: Производственная среда (Production Data Safety Protocol)         │
 │ • КАТЕГОРИЧЕСКИЙ ЗАПРЕТ на DROP TABLE CASCADE при наличии боевых данных     │
 │ • Предварительные бэкапы (pg_dump, Supabase PITR) и неразрушающие действия  │
 ├─────────────────────────────────────────────────────────────────────────────┤
 │ УРОВЕНЬ 4: Целевой откат миграции 010 (Multi-Owner & Access Architecture)   │
 │ • Точный порядок: Lock RPC -> BEGIN -> LOCK TABLE -> Snapshot -> DROP table │
 │   -> Restore Functions -> Drop Columns -> COMMIT (СТРОГО БЕЗ CASCADE!)      │
 │ • Сохранение юридического аудита прав и защита от сбоев аутентификации      │
 └─────────────────────────────────────────────────────────────────────────────┘
```

---

## 1. Уровень 1: Полный сброс тестового контура (Staging / Dev Clean Wipe)

Применяется **только** на изолированных тестовых базах данных (staging / local development) для возврата схемы в исходное чистое состояние до применения миграций v2.4.

Скрипт удаляет объекты в строгом обратном порядке внешних ключей и зависимостей, предотвращая ошибки `foreign_key_violation` и `dependent_objects_still_exist`.

### Исполняемый SQL-скрипт полного отката:

```sql
-- ============================================================================
-- СКРИПТ ПОЛНОГО ОТКАТА СХЕМЫ FUNPAY TEAM DASHBOARD v2.4 (DEV / STAGING ONLY)
-- ============================================================================

-- ШАГ 1: Удаление RPC-функций и процедур bootstrap
DROP FUNCTION IF EXISTS public.set_member_role(UUID, TEXT, TEXT);
DROP FUNCTION IF EXISTS public.set_member_active(UUID, BOOLEAN, TEXT);
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
DROP TABLE IF EXISTS public.profile_audit_logs CASCADE;
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
| **010_multi_owner_and_access.sql** | Таблица `profile_audit_logs`, RPC `set_member_role`, `set_member_active`, поля Creator в `profiles`, обновлённые триггеры | См. детальный протокол в **[Разделе 4](#4-протокол-целевого-отката-миграции-010-010_multi_owner_and_accesssql)**. Строгая атомарная цепочка: Maintenance mode → блокировка RPC-записи → `BEGIN;` → `LOCK TABLE` → snapshot (CTAS) → `DROP table` → восстановление функций (001, 008) → удаление полей `profiles` → `COMMIT;`. СТРОГО БЕЗ `CASCADE`! |

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

---

## 4. Протокол целевого отката миграции 010 (010_multi_owner_and_access.sql)

Миграция `010_multi_owner_and_access.sql` вводит трёхуровневую иерархию ролей (**Creator → Owner → Operator**), защиту Создателя системы, журнал аудита прав `profile_audit_logs`, новые RPC-функции (`set_member_role`, `set_member_active`) и ужесточает права переназначения заказов в `reassign_order_operator`.

Откат данной миграции возвращает систему к базовой модели v2.4 (миграции 001–008: единый уровень `owner`, без разделения на Создателя и Вторых руководителей).

---

### 4.1. Архитектурный контекст и риски: категорический запрет на слепой `DROP ... CASCADE`

> [!CAUTION]
> **КАТЕГОРИЧЕСКИЙ ЗАПРЕТ НА `DROP ... CASCADE` И `ALTER TABLE DROP COLUMN ... CASCADE`:**
> Применение каскадного удаления в PostgreSQL приводит к неконтролируемому удалению зависимых системных объектов, скрытым ошибкам и немедленному отказу сервиса (Downtime).

#### Почему обязателен строгий порядок зависимостей:
1. **Зависимость триггерных функций от структуры столбцов:**
   - Триггер `trg_protect_profile_fields` вызывает функцию `trg_fn_protect_profile_fields()`, которая в версии 010 обращается к полям `NEW.is_creator`, `OLD.is_creator`, `NEW.invitation_status`, `OLD.invitation_status`.
   - Триггер `on_auth_user_created` вызывает функцию `handle_new_user()`, которая вставляет записи с явным указанием столбцов `is_creator`, `invitation_status`, `invited_by_user_id`.
   - **Фатальный сценарий:** Если удалить столбцы из таблицы `profiles` ДО восстановления исходных версий триггеров, любая попытка обновления профиля оператора или регистрация нового пользователя в Supabase Auth немедленно завершится фатальной ошибкой `record "new" has no field "is_creator"`. Вся авторизация и работа команды будет парализована.
2. **Внешние ключи (Foreign Keys):**
   - Таблица `profile_audit_logs` содержит внешний ключ с защитой от удаления:  
     `target_user_id UUID NOT NULL REFERENCES public.profiles(user_id) ON DELETE RESTRICT`.
   - Колонка `invited_by_user_id` ссылается на `profiles(user_id) ON DELETE SET NULL`.
   - Попытка неосмысленного удаления таблиц или столбцов в произвольном порядке вызовет ошибки нарушения целостности внешних ключей.
3. **Зависимость RPC-функций от таблицы аудита:**
   - Функции `set_member_role` и `set_member_active` выполняют прямую вставку в `public.profile_audit_logs`. Если удалить таблицу аудита до удаления этих функций, вызовы RPC из клиентского приложения будут приводить к ошибкам отсутствия таблицы (`relation "profile_audit_logs" does not exist`).

---

### 4.2. Предварительные проверки перед началом отката (Pre-checks)

Перед выполнением отката подключитесь к базе данных под ролью с административными правами (`postgres` или контекст Supabase SQL Editor) и выполните диагностические запросы:

```sql
-- 1. Проверка наличия активных блокировок таблицы profiles и profile_audit_logs
SELECT pid, usename, state, age(clock_timestamp(), query_start) AS duration, query 
FROM pg_stat_activity 
WHERE query ILIKE '%profiles%' AND pid <> pg_backend_pid();

-- 2. Оценка объёма накопленных записей аудита прав
SELECT 
    COUNT(*) AS total_audit_entries,
    MIN(created_at) AS first_entry_at,
    MAX(created_at) AS last_entry_at
FROM public.profile_audit_logs;

-- 3. Анализ текущего состава руководителей и статусов участников
-- ВНИМАНИЕ: Зафиксируйте пользователей с role = 'owner', отличных от Creator!
SELECT 
    user_id, 
    display_name, 
    role, 
    is_active, 
    is_creator, 
    invitation_status,
    invited_by_user_id
FROM public.profiles 
ORDER BY role, created_at;
```

> [!WARNING]
> **Внимание к ролям при откате:**  
> Если после применения миграции 010 в системе был назначен Второй Руководитель (Second Owner), после отката миграции 010 поле `is_creator` исчезнет, и в системе останутся два равноправных владельца с `role = 'owner'`. Если перед откатом требуется вернуть Второго Руководителя к роли оператора, сделайте это до запуска процедуры:
> ```sql
> UPDATE public.profiles SET role = 'operator', updated_at = NOW() WHERE user_id = 'UUID_ВТОРОГО_РУКОВОДИТЕЛЯ';
> ```

---

### 4.3. Сохранение данных и регламент архивации (Data Preservation & Archival Protocol)

> [!CAUTION]
> **КРИТИЧЕСКОЕ ПРЕДУПРЕЖДЕНИЕ: РИСК БЕЗВОЗВРАТНОЙ ПОТЕРИ ЮРИДИЧЕСКОГО АУДИТА**
> Таблица `public.profile_audit_logs` содержит юридически значимую историю смены ролей, активаций, деактиваций и приглашений в команду. Удаление таблицы `profile_audit_logs` и колонок `is_creator`, `invitation_status`, `invited_by_user_id`, `last_activity_at` из `public.profiles` без предварительного экспорта приведёт к **безвозвратной потере всей доказательной базы** управления доступом.

#### 4.3.1. Устранение риска Race Condition (Maintenance Mode & Блокировка RPC-записи)

При выполнении отката существует критический временной зазор (**race condition window**) между моментом формирования снимка данных и моментом физического удаления таблицы `DROP TABLE public.profile_audit_logs`.

Если во время выгрузки или непосредственно после неё параллельный клиентский запрос либо фоновый процесс вызовет RPC `set_member_role` или `set_member_active`, в таблицу `profile_audit_logs` запишется новая строка. При последующем удалении таблицы эта запись **будет безвозвратно утеряна**, так как она не вошла в созданный снимок.

Для полного исключения риска потери данных обязателен следующий протокол изоляции:

1. **Активация регламентного окна (Maintenance Mode):**
   Приостановите работу веб-интерфейса или временно отключите входящий клиентский трафик к Supabase Edge Functions.
2. **Мгновенный отзыв прав на запись через RPC (до снятия бэкапа):**
   Отозовите права на выполнение процедур управления ролями и статусами, чтобы предотвратить создание новых записей во время процедуры:
   ```sql
   REVOKE EXECUTE ON FUNCTION public.set_member_role(UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
   REVOKE EXECUTE ON FUNCTION public.set_member_active(UUID, BOOLEAN, TEXT) FROM PUBLIC, anon, authenticated;
   ```
3. **Блокировка таблицы на время транзакции отката:**
   Внутри транзакции отката наложите эксклюзивную блокировку:
   ```sql
   LOCK TABLE public.profile_audit_logs IN ACCESS EXCLUSIVE MODE;
   ```
   Это гарантирует 100% отсутствие параллельных транзакций записи в журнал аудита вплоть до завершения процедуры отката.

---

#### 4.3.2. ПЕРВИЧНЫЙ АВТОРИТЕТНЫЙ МЕТОД: Внешний защищённый экспорт через `pg_dump` (Primary Authoritative Method)

> [!IMPORTANT]
> **Логический экспорт `pg_dump` во внешнее изолированное хранилище — ЕДИНСТВЕННЫЙ первичный авторитетный метод архивации аудита.**
> Физическая выгрузка данных за пределы базы данных в защищённое внешнее объектное хранилище (AWS S3, Google Cloud Storage с поддержкой Object Lock/WORM или шифрованный холодный архив) является первичным авторитетным методом сохранения юридической истории. Только внешний экспорт гарантирует выживание данных при любых авариях СУБД, аппаратных сбоях кластера, случайном `DROP SCHEMA` или компрометации инстанса базы данных.

Выполните команду первичного авторитетного экспорта в консоли администратора (строго после активации Maintenance Mode и отзыва прав на RPC из п. 4.3.1):

```bash
# Первичный авторитетный логический экспорт таблицы profile_audit_logs в формате plain SQL
pg_dump -h db.zlpbywengymnvrpbcxvh.supabase.co -U postgres -d postgres \
  --format=plain \
  --quote-all-identifiers \
  --no-owner \
  --no-privileges \
  -t public.profile_audit_logs \
  -f profile_audit_logs_authoritative_$(date +%Y%m%d_%H%M%S).sql
```

**Обязательная верификация экспорта перед началом DDL-операций отката:**
1. **Проверка ненулевого размера:** Убедитесь, что размер файла больше 0 байт: `ls -lh profile_audit_logs_authoritative_*.sql`.
2. **Верификация количества строк:** Сверьте число строк дампа с текущим значением в БД `SELECT COUNT(*) FROM public.profile_audit_logs;`:
   ```bash
   grep -c "^[0-9a-f-]" profile_audit_logs_authoritative_*.sql || grep -c "INSERT INTO" profile_audit_logs_authoritative_*.sql
   ```
3. **Перемещение во внешнее изолированное хранилище:** Загрузите полученный SQL-дамп в защищённое долговременное хранилище (AWS S3 / GCS бакет с политикой WORM/Object Lock) и зафиксируйте контрольную сумму SHA-256:
   ```bash
   sha256sum profile_audit_logs_authoritative_*.sql > profile_audit_logs_authoritative.sha256
   ```

---

#### 4.3.3. ВНУТРЕННИЙ ОПЕРАТИВНЫЙ СНИМОК: Временный буфер (`CREATE TABLE AS SELECT`) — НЕ является внешним бэкапом!

> [!WARNING]
> **ИЛЛЮЗИЯ БЕЗОПАСНОСТИ ТАБЛИЦ-СНИМКОВ ВНУТРИ БАЗЫ ДАННЫХ (False Sense of Security):**
> Создание снимка таблицы внутри той же самой базы данных через `CREATE TABLE AS SELECT` (CTAS) **НЕ ЯВЛЯЕТСЯ внешним или персистентным бэкапом**:
> 1. **Единая точка отказа (Single Point of Failure):** При аппаратном сбое кластера базы данных, повреждении файловой системы, сбое дискового тома, случайном удалении схемы (`DROP SCHEMA public`) или компрометации инстанса внутренняя таблица погибает вместе со всей БД.
> 2. **Уничтожение при очистке сред (Dev / Staging Clean Wipe):** Любые автоматические сценарии сброса схемы тестовых контуров безвозвратно удаляют все таблицы `_tmp_*` / `_archive_*`.
> 3. **Несоответствие нормативным требованиям (Regulatory Compliance):** Нормативные регламенты аудита безопасности предписывают хранение логов на независимых изолированных носителях с защитой от удаления и модификации (WORM). Внутренняя таблица мутабельна и не обладает юридической независимостью.
>
> Конструкция `CREATE TABLE AS SELECT` (CTAS) трактуется **СТРОГО как временный внутренний оперативный снимок (temporary internal operational snapshot)** для обеспечения быстрой транзитной подстраховки непосредственно внутри транзакции отката.

##### Критические технические ограничения `CREATE TABLE AS SELECT` (CTAS) в PostgreSQL:
Команда `CREATE TABLE AS SELECT` копирует **исключительно сырые данные и базовые типы колонок**. При этом **БЕЗВОЗВРАТНО ТЕРЯЮТСЯ**:
- ❌ **Первичные ключи (`PRIMARY KEY`):** Столбец `log_id` перестает быть первичным ключом; ограничение уникальности и системный индекс PK не создаются.
- ❌ **Внешние ключи (`FOREIGN KEY`):** Ограничение `target_user_id REFERENCES public.profiles(user_id) ON DELETE RESTRICT` не переносится.
- ❌ **Ограничения проверки (`CHECK`):** Ограничение допустимых действий `CHECK (action IN ('role_changed', 'activated', 'deactivated', 'invited'))` отбрасывается.
- ❌ **Значения столбцов по умолчанию (`DEFAULT`):** Значения `DEFAULT gen_random_uuid()` и `DEFAULT NOW()` не сохраняются в определении столбцов.
- ❌ **Индексы (`INDEX`):** Ни один вторичный индекс (по `target_user_id`, `created_at`) не создается.
- ❌ **Триггеры (`TRIGGERS`):** Системные и пользовательские триггеры не копируются.
- ❌ **Политики безопасности (`ROW LEVEL SECURITY` = OFF):** **Таблица создаётся с ВЫКЛЮЧЕННЫМ RLS (`ROW LEVEL SECURITY` = OFF)!** По умолчанию буферная таблица становится общедоступной для чтения любым подключенным клиентам, если немедленно явно не включить RLS (`ENABLE ROW LEVEL SECURITY`) и не отозвать привилегии!

##### Опасность повторного использования устаревших таблиц (`CREATE TABLE IF NOT EXISTS`):
> [!CAUTION]
> **КАТЕГОРИЧЕСКИЙ ЗАПРЕТ НА `CREATE TABLE IF NOT EXISTS` ДЛЯ СНИМКОВ:**
> Если в базе данных уже осталась таблица `_tmp_profile_audit_logs_buffer` от предыдущего прерванного выполнения, тестового запуска или сухого прогона (dry run), конструкция `CREATE TABLE IF NOT EXISTS` **молча пропустит создание таблицы** (`relation already exists, skipping`) и оставит **СТАРЫЕ, устаревшие данные**.
> В результате актуальный журнал аудита **НЕ попадёт в снимок**, а при последующем выполнении `DROP TABLE public.profile_audit_logs` самые свежие записи аудита будут **безвозвратно потеряны**!
> 
> **Требование:** Избегайте повторного использования старых таблиц. Используйте строго **явный сброс перед созданием** (`DROP TABLE IF EXISTS ...; CREATE TABLE ... AS SELECT ...;`) непосредственно внутри транзакции отката!

##### Скрипт создания и изоляции временного оперативного снимка:
```sql
-- 1. Явный сброс старого буфера и создание нового оперативного снимка (СТРОГО БЕЗ CASCADE)
DROP TABLE IF EXISTS public._tmp_profile_audit_logs_buffer;
CREATE TABLE public._tmp_profile_audit_logs_buffer AS 
SELECT * FROM public.profile_audit_logs;

DROP TABLE IF EXISTS public._tmp_profiles_extended_buffer;
CREATE TABLE public._tmp_profiles_extended_buffer AS 
SELECT 
    user_id, 
    display_name, 
    role, 
    is_active, 
    is_creator, 
    invitation_status, 
    invited_by_user_id, 
    last_activity_at, 
    NOW() AS buffered_at
FROM public.profiles;

-- 2. ОБЯЗАТЕЛЬНАЯ немедленная изоляция оперативного снимка (CTAS создаёт таблицу с RLS = OFF!)
ALTER TABLE public._tmp_profile_audit_logs_buffer ENABLE ROW LEVEL SECURITY;
ALTER TABLE public._tmp_profiles_extended_buffer ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public._tmp_profile_audit_logs_buffer FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public._tmp_profiles_extended_buffer FROM PUBLIC, anon, authenticated;

GRANT SELECT ON public._tmp_profile_audit_logs_buffer TO service_role;
GRANT SELECT ON public._tmp_profiles_extended_buffer TO service_role;
```

> [!NOTE]
> После успешного выполнения отката и подтверждения сохранности внешнего `pg_dump`, временные буферные таблицы удаляются командой `DROP TABLE IF EXISTS public._tmp_profile_audit_logs_buffer; DROP TABLE IF EXISTS public._tmp_profiles_extended_buffer;` (строго **БЕЗ** `CASCADE`).

---

### 4.4. Точная атомарная последовательность выполнения отката (Exact Atomic Dependency Order)

Откат миграции 010 должен производиться строго по следующей технологической цепочке:

```
                      ТОЧНАЯ АТОМАРНАЯ ЦЕПОЧКА ОТКАТА МИГРАЦИИ 010
 ┌─────────────────────────────────────────────────────────────────────────────┐
 │ 1. MAINTENANCE MODE                                                         │
 │ • Включение регламентных работ на уровне API Gateway / Edge Functions       │
 │ • Временная остановка внешнего клиентского трафика и фоновых воркеров       │
 ├─────────────────────────────────────────────────────────────────────────────┤
 │ 2. LOCK RPC WRITES                                                          │
 │ • REVOKE EXECUTE на RPC set_member_role, set_member_active                 │
 │ • Первичный авторитетный pg_dump на внешнее изолированное хранилище (WORM)  │
 │ • Обязательная верификация размера и числа строк экспортированного дампа    │
 ├─────────────────────────────────────────────────────────────────────────────┤
 │ 3. BEGIN;                                                                   │
 │ • Открытие единой неделимой DDL-транзакции отката в PostgreSQL              │
 ├─────────────────────────────────────────────────────────────────────────────┤
 │ 4. LOCK TABLE public.profile_audit_logs IN ACCESS EXCLUSIVE MODE;           │
 │ • Эксклюзивная блокировка таблицы аудита внутри транзакции                  │
 │ • 100% гарантия отсутствия конкурирующих операций чтения и записи           │
 ├─────────────────────────────────────────────────────────────────────────────┤
 │ 5. SNAPSHOT (Временный внутренний оперативный снимок CTAS)                  │
 │ • Явный DROP TABLE IF EXISTS перед созданием (защита от устаревших таблиц)  │
 │ • CREATE TABLE AS SELECT для profile_audit_logs и profiles                  │
 │ • Немедленная изоляция: ENABLE ROW LEVEL SECURITY и REVOKE ALL              │
 ├─────────────────────────────────────────────────────────────────────────────┤
 │ 6. DROP TABLE (Удаление таблицы аудита и функций 010, СТРОГО БЕЗ CASCADE)   │
 │ • DROP POLICY IF EXISTS profile_audit_select_owner                          │
 │ • DROP TABLE IF EXISTS public.profile_audit_logs                            │
 │ • DROP FUNCTION set_member_role, set_member_active                          │
 ├─────────────────────────────────────────────────────────────────────────────┤
 │ 7. RESTORE FUNCTIONS (Восстановление оригинальных функций и триггеров)      │
 │ • CREATE OR REPLACE FUNCTION public.reassign_order_operator [из 008]        │
 │ • CREATE OR REPLACE FUNCTION public.handle_new_user() [из 001]              │
 │ • CREATE OR REPLACE FUNCTION public.trg_fn_protect_profile_fields() [из 001]│
 ├─────────────────────────────────────────────────────────────────────────────┤
 │ 8. DROP COLUMNS (Удаление полей и ограничений 010 из profiles, БЕЗ CASCADE) │
 │ • DROP INDEX IF EXISTS public.uq_profiles_single_creator                    │
 │ • ALTER TABLE profiles DROP CONSTRAINT profiles_invited_by_user_id_fkey     │
 │ • ALTER TABLE profiles DROP COLUMN invited_by_user_id,                      │
 │                        DROP COLUMN invitation_status,                       │
 │                        DROP COLUMN last_activity_at,                        │
 │                        DROP COLUMN is_creator                               │
 ├─────────────────────────────────────────────────────────────────────────────┤
 │ 9. COMMIT;                                                                  │
 │ • Атомарная фиксация транзакции отката в базе данных                        │
 └─────────────────────────────────────────────────────────────────────────────┘
```

#### Обоснование строгого порядка шагов:
* **Шаги 1–2 (Maintenance Mode & Lock RPC writes):** Устраняют race condition до открытия транзакции. Отзыв прав `EXECUTE` исключает новые вставки через RPC во время снятия первичного авторитетного бэкапа `pg_dump` на внешнее изолированное хранилище.
* **Шаги 3–4 (`BEGIN;` и `LOCK TABLE ... IN ACCESS EXCLUSIVE MODE`):** Открывают транзакцию и накладывают наивысший уровень блокировки на таблицу `profile_audit_logs`. Ни одна другая транзакция не может получить доступ к таблице аудита.
* **Шаг 5 (`snapshot`):** Создаётся временный внутренний оперативный снимок (CTAS) с обязательным предварительным явным `DROP TABLE IF EXISTS`, исключающим повторное использование устаревших таблиц от предыдущих запусков. Снимок сразу защищается включением RLS и отзывом прав.
* **Шаг 6 (`DROP table`):** Таблица `profile_audit_logs` и ассоциированные RPC (`set_member_role`, `set_member_active`) удаляются строго **БЕЗ CASCADE**. Так как `profile_audit_logs` ссылается на `profiles`, её удаление разрывает внешний ключ `target_user_id -> profiles.user_id` без побочных эффектов.
* **Шаг 7 (`restore functions`):** Функции триггеров `trg_fn_protect_profile_fields()` и `handle_new_user()` восстанавливаются до базовых версий (001), в которых отсутствуют ссылки на поля `is_creator`, `invitation_status`, `invited_by_user_id`. **Этот шаг ОБЯЗАН выполняться ДО удаления столбцов из `profiles`**, иначе любая операция с профилем оператора или авторизацией вызовет ошибку отсутствия столбца (`record "new" has no field "is_creator"`).
* **Шаг 8 (`drop columns`):** После восстановления функций триггеров безопасно удаляются индекс `uq_profiles_single_creator`, внешний ключ `profiles_invited_by_user_id_fkey` и столбцы 010 через единый `ALTER TABLE` строго **БЕЗ CASCADE**.
* **Шаг 9 (`COMMIT;`):** Неделимая фиксация изменений. В случае сбоя происходит откат (`ROLLBACK`), возвращающий всю схему и данные в исходное состояние.

---

### 4.5. Исполняемый транзакционный SQL-скрипт отката миграции 010 (Production-Safe)

Скрипт полностью реализует описанную выше технологическую цепочку: от предварительной изоляции до атомарной транзакции `BEGIN; ... COMMIT;`. При возникновении любой ошибки транзакция откатывается целиком.

```sql
-- ============================================================================
-- СКРИПТ БЕЗОПАСНОГО ОТКАТА МИГРАЦИИ 010
-- FunPay Team Dashboard v2.4 (Single-Team Architecture)
-- ============================================================================

-- ----------------------------------------------------------------------------
-- ШАГ 1: Maintenance Mode (Активируется на уровне шлюза / Edge Functions)
-- Входящий клиентский веб-трафик перенаправлен на страницу техобслуживания.
-- ----------------------------------------------------------------------------

-- ----------------------------------------------------------------------------
-- ШАГ 2: Блокировка RPC-записи (Lock RPC writes)
-- Предотвращает появление новых записей в profile_audit_logs во время бэкапа
-- ----------------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION public.set_member_role(UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.set_member_active(UUID, BOOLEAN, TEXT) FROM PUBLIC, anon, authenticated;

-- ВАЖНО: На этом шаге выполните и верифицируйте первичный авторитетный pg_dump
-- на внешнее изолированное хранилище согласно регламенту Раздела 4.3.2!

-- ============================================================================
-- АТОМАРНАЯ ТРАНЗАКЦИЯ ОТКАТА DDL (BEGIN ... COMMIT)
-- ============================================================================
BEGIN;

-- ----------------------------------------------------------------------------
-- ШАГ 4: Эксклюзивная блокировка таблицы аудита (LOCK TABLE)
-- Исключает параллельный доступ к profile_audit_logs на время транзакции
-- ----------------------------------------------------------------------------
LOCK TABLE public.profile_audit_logs IN ACCESS EXCLUSIVE MODE;

-- ----------------------------------------------------------------------------
-- ШАГ 5: Временный внутренний оперативный снимок (snapshot via CTAS)
-- ВНИМАНИЕ: Во избежание переиспользования старых данных от предыдущих запусков
-- категорически запрещён CREATE TABLE IF NOT EXISTS. Используется явный DROP/CREATE:
-- ----------------------------------------------------------------------------
DROP TABLE IF EXISTS public._tmp_profile_audit_logs_buffer;
CREATE TABLE public._tmp_profile_audit_logs_buffer AS 
SELECT * FROM public.profile_audit_logs;

DROP TABLE IF EXISTS public._tmp_profiles_extended_buffer;
CREATE TABLE public._tmp_profiles_extended_buffer AS 
SELECT 
    user_id, 
    display_name, 
    role, 
    is_active, 
    is_creator, 
    invitation_status, 
    invited_by_user_id, 
    last_activity_at, 
    NOW() AS buffered_at
FROM public.profiles;

-- Защита снимка: CTAS создаёт таблицу с RLS = OFF, немедленно изолируем:
ALTER TABLE public._tmp_profile_audit_logs_buffer ENABLE ROW LEVEL SECURITY;
ALTER TABLE public._tmp_profiles_extended_buffer ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public._tmp_profile_audit_logs_buffer FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public._tmp_profiles_extended_buffer FROM PUBLIC, anon, authenticated;

GRANT SELECT ON public._tmp_profile_audit_logs_buffer TO service_role;
GRANT SELECT ON public._tmp_profiles_extended_buffer TO service_role;

-- ----------------------------------------------------------------------------
-- ШАГ 6: Удаление таблицы аудита и объектов доступа 010 (DROP table, СТРОГО БЕЗ CASCADE)
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS "profile_audit_select_owner" ON public.profile_audit_logs;
DROP TABLE IF EXISTS public.profile_audit_logs;

DROP FUNCTION IF EXISTS public.set_member_role(UUID, TEXT, TEXT);
DROP FUNCTION IF EXISTS public.set_member_active(UUID, BOOLEAN, TEXT);

-- ----------------------------------------------------------------------------
-- ШАГ 7: Восстановление оригинальных функций и триггеров (restore functions)
-- ----------------------------------------------------------------------------

-- 7.1. Восстановление оригинального reassign_order_operator из 008_rpc_functions.sql
-- (Возврат к проверке public.is_active_team_member() вместо is_team_owner())
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

-- 7.2. Восстановление оригинальной функции handle_new_user() из 001_profiles_and_auth.sql
-- (Удалены обращения к is_creator, invitation_status, invited_by_user_id)
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

-- 7.3. Восстановление оригинальной функции trg_fn_protect_profile_fields() из 001_profiles_and_auth.sql
-- (Удалена проверка иммунитета Creator и проверки Второго Руководителя)
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

-- ----------------------------------------------------------------------------
-- ШАГ 8: Удаление добавленных колонок и ограничений из profiles (drop columns, СТРОГО БЕЗ CASCADE)
-- ----------------------------------------------------------------------------
DROP INDEX IF EXISTS public.uq_profiles_single_creator;

ALTER TABLE public.profiles
    DROP CONSTRAINT IF EXISTS profiles_invited_by_user_id_fkey,
    DROP COLUMN IF EXISTS invited_by_user_id,
    DROP COLUMN IF EXISTS invitation_status,
    DROP COLUMN IF EXISTS last_activity_at,
    DROP COLUMN IF EXISTS is_creator;

-- ----------------------------------------------------------------------------
-- ШАГ 9: Фиксация неделимой транзакции (COMMIT)
-- ----------------------------------------------------------------------------
COMMIT;
-- ============================================================================
-- АТОМАРНЫЙ ОТКАТ МИГРАЦИИ 010 УСПЕШНО ЗАВЕРШЁН
-- ============================================================================
```

---

### 4.6. Протокол пост-валидации и очистки (Post-Rollback Verification & Cleanup)

После успешного выполнения транзакции отката выполните следующий контрольный блок запросов для подтверждения целостности схемы:

```sql
-- 1. Проверка структуры колонок public.profiles (должны отсутствовать поля 010)
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'profiles'
ORDER BY ordinal_position;
-- Ожидается строго 7 колонок: user_id, display_name, role, is_active, avatar_url, created_at, updated_at

-- 2. Проверка отсутствия удалённых объектов (все запросы должны вернуть 0 строк)
SELECT 'Table profile_audit_logs still exists!' AS issue
FROM information_schema.tables 
WHERE table_schema = 'public' AND table_name = 'profile_audit_logs'
UNION ALL
SELECT 'Index uq_profiles_single_creator still exists!' 
FROM pg_indexes 
WHERE schemaname = 'public' AND indexname = 'uq_profiles_single_creator'
UNION ALL
SELECT 'RPC ' || proname || ' still exists!' 
FROM pg_proc 
WHERE proname IN ('set_member_role', 'set_member_active')
  AND pronamespace = 'public'::regnamespace;

-- 3. Проверка работоспособности триггера profiles при обновлении
-- (Проверяем, что UPDATE не падает с ошибкой отсутствия is_creator)
DO $$
DECLARE
    v_test_user UUID;
BEGIN
    SELECT user_id INTO v_test_user FROM public.profiles LIMIT 1;
    IF v_test_user IS NOT NULL THEN
        UPDATE public.profiles SET updated_at = NOW() WHERE user_id = v_test_user;
        RAISE NOTICE 'Тест триггера profiles успешно пройден';
    END IF;
END;
$$;

-- 4. Проверка прав на выполнение восстановленного reassign_order_operator
SELECT grantee, privilege_type 
FROM information_schema.routine_privileges 
WHERE routine_schema = 'public' AND routine_name = 'reassign_order_operator';
-- Ожидается: authenticated -> EXECUTE

-- 5. Проверка состояния временных буферных снимков (CTAS)
SELECT 
    (SELECT COUNT(*) FROM public._tmp_profile_audit_logs_buffer) AS buffer_audit_count,
    (SELECT COUNT(*) FROM public._tmp_profiles_extended_buffer) AS buffer_profiles_count;
```

#### Очистка временных буферных снимков:
После подтверждения целостности схемы, успешной пост-валидации и проверки сохранности внешнего дампа `pg_dump` на внешнем объектном хранилище, выполните удаление временных буферных таблиц (строго **БЕЗ CASCADE**):

```sql
DROP TABLE IF EXISTS public._tmp_profile_audit_logs_buffer;
DROP TABLE IF EXISTS public._tmp_profiles_extended_buffer;
```
```
