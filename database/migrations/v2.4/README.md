# FanPay Team Dashboard v2.4 — SQL Миграции базы данных

Данный каталог содержит полный, согласованный комплект SQL-миграций для развёртывания облачной инфраструктуры **FanPay Team Dashboard v2.4** в среде Supabase.

---

## 1. Архитектурные принципы v2.4

* **Single-Team Architecture:** База данных обслуживает одну команду с динамическим количеством участников (текущий состав — 4 участника: 3 сменных оператора и 1 руководитель/owner).
* **Равноправие операционной работы:** Все активные участники команды могут выходить на смены, синхронизировать заказы с FunPay, просматривать общую финансовую аналитику и редактировать общие шаблоны.
* **Техническая роль `owner`:** Административное управление аккаунтами продавца и профилями команды изолировано за ролью руководителя. Руководитель также может вести смены и принимать заказы как оператор.
* **Некурсивная модель RLS без side-channels:** Функции `is_active_team_member()` и `is_team_owner()` выполняются с `SECURITY DEFINER`, фиксированным `search_path = public, pg_temp` и не принимают внешних аргументов, проверяя строго `auth.uid()`. Это полностью исключает рекурсию политик (ошибка 42P17) и возможность зондирования статуса чужих UUID.
* **Составной первичный ключ заказов:** `PRIMARY KEY (seller_account_id, order_id)` обеспечивает надёжное масштабирование и изоляцию торговых аккаунтов.
* **Принцип First-Write-Wins:** Первоначальные финансовые данные (`amount`, `currency`, `funpay_created_at`), а также `buyer_id` и `created_at` защищены триггером `trg_protect_order_fields` и RPC-логикой.
* **Реестр расхождений:** При несовпадении сумм, валют или `funpay_created_at` в повторных пакетах синхронизации инцидент дедуплицированно фиксируется в таблице `order_financial_discrepancies` для ручного аудита руководителем.
* **Финансовая формула:** Доля оператора составляет **10% от подтверждённого оборота** его закрытых заказов (`status = 'closed'`). Возвраты (`status = 'refunded'`) автоматически исключены из подтверждённого оборота (без двойного вычета). Валюты (RUB, USD, EUR, KZT) учитываются строго раздельно. Заказы без оператора (`unassigned`) на 100% зачисляются в фонд команды.
* **Авторизационная модель RPC (Вариант A):** Интерактивные RPC `sync_orders_batch`, `reassign_order_operator` и `recalculate_shift_attributions` доступны исключительно аутентифицированным операторам (`TO authenticated`) с явным `auth.uid()`. Прямые права для `service_role` и `anon` отозваны.

---

## 2. Порядок выполнения миграций

Выполняйте файлы строго в указанной последовательности в **Supabase SQL Editor**:

| Порядок | Файл | Описание |
|:---:|---|---|
| **1** | [`001_profiles_and_auth.sql`](./001_profiles_and_auth.sql) | Таблица `profiles`, функции `is_active_team_member()` и `is_team_owner()`, триггер `on_auth_user_created`, защищённая процедура `bootstrap_initial_owner`, RLS. |
| **2** | [`002_team_seller_accounts.sql`](./002_team_seller_accounts.sql) | Реестр подтверждённых аккаунтов продавца `team_seller_accounts`, RLS-политики управления для owner. |
| **3** | [`003_shifts_and_status.sql`](./003_shifts_and_status.sql) | Таблицы `shifts` и `operator_status`, триггеры валидации жизненного цикла смен и heartbeat, индекс активных смен, RLS. |
| **4** | [`004_orders.sql`](./004_orders.sql) | Таблица `orders`, индексы аналитики, триггер иммутабельности финансовых полей и buyer_id, отзыв прямого INSERT/UPDATE/DELETE. |
| **5** | [`005_order_audit_logs.sql`](./005_order_audit_logs.sql) | Журнал аудита ручных изменений атрибуции `order_audit_logs`, FK с `ON DELETE RESTRICT` к заказам, снимки имён, RLS. |
| **6** | [`006_financial_discrepancies.sql`](./006_financial_discrepancies.sql) | Журнал расхождений `order_financial_discrepancies` (суммы и время), дедупликация инцидентов, RLS (owner-only). |
| **7** | [`007_shared_templates.sql`](./007_shared_templates.sql) | Общие шаблоны `shared_templates`, уникальность shortcut, серверный триггер аудита, защита `created_at`, начальный сид F1–F8. |
| **8** | [`008_rpc_functions.sql`](./008_rpc_functions.sql) | Транзакционные функции без `MAX(UUID)`: `sync_orders_batch` (лимит 50, строгий regex Numeric), `reassign_order_operator`, `recalculate_shift_attributions`. |
| **9** | [`009_validation.sql`](./009_validation.sql) | Комплексная статическая валидация схемы, прав и RLS, а также безопасные динамические тесты с моком JWT claims. |

---

## 3. Требования к среде Supabase и процедура первичной настройки

### Требования к окружению:
1. **СУБД:** PostgreSQL 15+ (стандартная среда Supabase Cloud).
2. **Аутентификация:** Модуль Supabase Auth (`auth.users`) включён.

### Процедура первичной настройки (Bootstrap):
1. **Применение миграций 001–008:** Запустите файлы по порядку в Supabase SQL Editor.
2. **Регистрация участников:** Все 4 участника команды регистрируются через стандартный механизм Supabase Auth (Email / Password или Magic Link).  
   *Триггер `on_auth_user_created` автоматически создаёт запись в `public.profiles` с ролью `'operator'` и `is_active = true`.*
3. **Безопасное назначение первого руководителя (Owner):**  
   Выполните в Supabase SQL Editor (контекст superuser/postgres) процедуру одноразового назначения:
   ```sql
   -- Подставьте UUID вашего пользователя из auth.users
   SELECT public.bootstrap_initial_owner('YOUR-USER-UUID-HERE'::UUID);
   ```
   *Процедура защищена транзакционной блокировкой `pg_advisory_xact_lock`, атомарно проверяет отсутствие владельцев в системе и назначает роль `'owner'`. Повторный вызов блокируется.*
4. **Регистрация магазина FunPay:**  
   Руководитель (`owner`) добавляет цифровой идентификатор магазина команды в `team_seller_accounts`:
   ```sql
   INSERT INTO public.team_seller_accounts (seller_account_id, account_name, is_active)
   VALUES ('1084291', 'Основной магазин FunPay', true);
   ```
5. **Запуск валидации:** Выполните [`009_validation.sql`](./009_validation.sql) для подтверждения 100% готовности базы.

---

## 4. Замечания по идемпотентности и повторному запуску

* Все DDL-файлы используют конструкции `CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS` и `DROP TRIGGER / DROP POLICY IF EXISTS`.
* **Однако повторный запуск миграций на рабочей базе требует внимания:** изменения структуры таблиц или ограничений на работающей системе могут затронуть активные транзакции. Перед любыми повторными применениями в production обязательно ознакомьтесь с [ROLLBACK.md](./ROLLBACK.md).

---

## 5. Дополнительная документация

* 📖 **[SCHEMA_OVERVIEW.md](./SCHEMA_OVERVIEW.md)** — Каталог таблиц, ER-диаграмма, типы данных, триггеры и матрица прав.
* 🧪 **[VALIDATION.md](./VALIDATION.md)** — Подробное описание проверок, фикстур и 5-уровневого протокола контрольной сверки.
* 🔄 **[ROLLBACK.md](./ROLLBACK.md)** — Трёхуровневый регламент отката изменений (тестовый, частичный сбой, production).
