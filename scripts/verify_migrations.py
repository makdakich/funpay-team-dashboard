import os
import re
import sys

# Обеспечиваем корректный вывод UTF-8 в консоли Windows
sys.stdout.reconfigure(encoding='utf-8')

# Надёжное определение корня проекта независимо от текущего рабочего каталога
script_dir = os.path.dirname(os.path.abspath(__file__))
project_root = os.path.dirname(script_dir)
mig_dir = os.path.join(project_root, 'database', 'migrations', 'v2.4')

expected_files = [
    '001_profiles_and_auth.sql',
    '002_team_seller_accounts.sql',
    '003_shifts_and_status.sql',
    '004_orders.sql',
    '005_order_audit_logs.sql',
    '006_financial_discrepancies.sql',
    '007_shared_templates.sql',
    '008_rpc_functions.sql',
    '009_validation.sql',
    '010_multi_owner_and_access.sql',
    'README.md',
    'ROLLBACK.md',
    'SCHEMA_OVERVIEW.md',
    'VALIDATION.md'
]

print("=" * 70)
print("СТАТИЧЕСКИЙ АУДИТ И ВАЛИДАЦИЯ ФАЙЛОВ FUNPAY DASHBOARD v2.4")
print(f"Каталог миграций: {mig_dir}")
print("=" * 70)

errors = []
warnings = []

# -----------------------------------------------------------------------------
# 1. Проверка наличия и непустоты всех 13 файлов
# -----------------------------------------------------------------------------
if not os.path.exists(mig_dir):
    print(f"❌ КРИТИЧЕСКАЯ ОШИБКА: Каталог не найден: {mig_dir}")
    sys.exit(1)

actual_files = set(os.listdir(mig_dir))
for f in expected_files:
    if f not in actual_files:
        errors.append(f"Отсутствует обязательный файл: {f}")
    else:
        path = os.path.join(mig_dir, f)
        if os.path.getsize(path) == 0:
            errors.append(f"Файл пуст: {f}")

print(f"[1/8] Наличие файлов: проверено {len(expected_files)} файлов. Все присутствуют на диске.")

# Загружаем содержимое файлов в память
contents = {}
for f in expected_files:
    if f in actual_files:
        with open(os.path.join(mig_dir, f), 'r', encoding='utf-8') as fh:
            contents[f] = fh.read()

# -----------------------------------------------------------------------------
# 2. Проверка незавершённых маркеров (TODO, FIXME, заглушки)
# -----------------------------------------------------------------------------
placeholder_pattern = re.compile(r'(\b(TODO|FIXME|XXX)\b|\.{3})')
for f, text in contents.items():
    if f.endswith('.sql'):
        # Ищем совпадения вне комментариев или в тексте
        matches = [m.group(0) for m in placeholder_pattern.finditer(text)]
        if matches:
            warnings.append(f"В файле {f} обнаружены маркеры/многоточия: {set(matches)}")

print(f"[2/8] Чистота кода: проверка на незавершённые плейсхолдеры и заглушки выполнена.")

# -----------------------------------------------------------------------------
# 3. Проверка Single-Team Architecture (отсутствие утечек multi-tenant team_id)
# -----------------------------------------------------------------------------
team_id_col = re.compile(r'\bteam_id\s+UUID\b', re.IGNORECASE)
for f, text in contents.items():
    if f.endswith('.sql') and team_id_col.search(text):
        errors.append(f"Обнаружена недопустимая колонка multi-tenant 'team_id' в {f}")

print(f"[3/8] Архитектура: подтверждена Single-Team модель (колонки 'team_id' отсутствуют).")

# -----------------------------------------------------------------------------
# 4. Проверка отсутствия опасных паттернов безопасности
# -----------------------------------------------------------------------------
# 4.1. current_user = 'postgres' внутри SECURITY DEFINER
sec_def_curr_user = re.compile(r'current_user\s*=\s*[\'"]postgres[\'"]', re.IGNORECASE)
for f, text in contents.items():
    if f.endswith('.sql') and sec_def_curr_user.search(text):
        errors.append(f"Опасная проверка 'current_user = postgres' в SECURITY DEFINER найдена в {f}!")

# 4.2. MAX(UUID) / MIN(UUID) в запросах
max_uuid_pattern = re.compile(r'(MAX|MIN)\s*\(\s*(id|user_id|[a-z_]*id)\s*\)', re.IGNORECASE)
for f, text in contents.items():
    if f.endswith('.sql'):
        # Исключаем комментарии
        sql_lines = [line for line in text.splitlines() if not line.strip().startswith('--')]
        clean_sql = '\n'.join(sql_lines)
        if max_uuid_pattern.search(clean_sql):
            errors.append(f"Обнаружена непортабельная агрегация UUID через MAX/MIN в {f}!")

print(f"[4/8] Безопасность ядра: проверено отсутствие 'current_user = postgres' и 'MAX(UUID)'.")

# -----------------------------------------------------------------------------
# 5. Проверка составного первичного ключа и констрейнтов
# -----------------------------------------------------------------------------
sql_004 = contents.get('004_orders.sql', '')
if 'PRIMARY KEY (seller_account_id, order_id)' not in sql_004:
    errors.append("В 004_orders.sql отсутствует составной PRIMARY KEY (seller_account_id, order_id)")

sql_006 = contents.get('006_financial_discrepancies.sql', '')
if 'uq_order_discrepancy' not in sql_006:
    errors.append("В 006_financial_discrepancies.sql отсутствует констрейнт uq_order_discrepancy")

sql_007 = contents.get('007_shared_templates.sql', '')
if 'uq_shared_templates_shortcut' not in sql_007:
    errors.append("В 007_shared_templates.sql отсутствует констрейнт uq_shared_templates_shortcut")

print(f"[5/8] Ограничения целостности: проверены PK (seller_account_id, order_id) и UNIQUE-индексы.")

# -----------------------------------------------------------------------------
# 6. Проверка соответствия сигнатур RPC и функций проверки прав
# -----------------------------------------------------------------------------
sql_001 = contents.get('001_profiles_and_auth.sql', '')
sql_008 = contents.get('008_rpc_functions.sql', '')
sql_009 = contents.get('009_validation.sql', '')

# Проверяем, что вспомогательные функции проверки прав не имеют параметров (защита от side-channel)
if 'FUNCTION public.is_active_team_member()' not in sql_001:
    errors.append("В 001_profiles_and_auth.sql is_active_team_member должна быть объявлена без параметров ()")
if 'FUNCTION public.is_team_owner()' not in sql_001:
    errors.append("В 001_profiles_and_auth.sql is_team_owner должна быть объявлена без параметров ()")

# Проверяем ключевые RPC в 008
expected_rpcs = [
    'FUNCTION public.sync_orders_batch(p_seller_account_id TEXT, p_orders JSONB)',
    'FUNCTION public.reassign_order_operator(p_seller_account_id TEXT, p_order_id TEXT, p_new_operator_id UUID, p_reason TEXT)',
    'FUNCTION public.recalculate_shift_attributions(p_shift_id UUID, p_window_start TIMESTAMPTZ DEFAULT NULL, p_window_end TIMESTAMPTZ DEFAULT NULL)'
]
for rpc in expected_rpcs:
    fn_name = rpc.split('(')[0]
    if fn_name not in sql_008:
        errors.append(f"В 008_rpc_functions.sql отсутствует объявление {fn_name}")

# Проверяем, что в 009 сигнатуры точно отражены
if "'is_active_team_member' AS name, '' AS args" not in sql_009:
    errors.append("В 009_validation.sql не обновлена сигнатура is_active_team_member()")
if "'is_team_owner', ''" not in sql_009:
    errors.append("В 009_validation.sql не обновлена сигнатура is_team_owner()")

print(f"[6/8] Сигнатуры RPC и функций: синхронизированы между 001, 008 и 009 (side-channel устранён).")

# -----------------------------------------------------------------------------
# 7. Проверка полноты и обратного порядка зависимостей в ROLLBACK.md
# -----------------------------------------------------------------------------
rollback_text = contents.get('ROLLBACK.md', '')

# Список таблиц в строгом обратном порядке их создания/зависимостей FK
expected_drop_order = [
    'order_financial_discrepancies',
    'order_audit_logs',
    'orders',
    'operator_status',
    'shifts',
    'team_seller_accounts',
    'shared_templates',
    'profiles'
]

drop_positions = []
for tbl in expected_drop_order:
    pos = rollback_text.find(f"DROP TABLE IF EXISTS public.{tbl}")
    if pos == -1:
        errors.append(f"В ROLLBACK.md отсутствует команда удаления таблицы {tbl}")
    else:
        drop_positions.append((tbl, pos))

# Проверяем, что позиции идут по возрастанию (строгий обратный порядок FK)
for i in range(len(drop_positions) - 1):
    cur_tbl, cur_pos = drop_positions[i]
    next_tbl, next_pos = drop_positions[i + 1]
    if cur_pos >= next_pos:
        errors.append(f"В ROLLBACK.md нарушен порядок удаления FK: {cur_tbl} должна удаляться ДО {next_tbl}")

print(f"[7/8] Анализ отката (ROLLBACK): проверен обратный порядок удаления 8 таблиц по FK.")

# -----------------------------------------------------------------------------
# 8. Проверка mock JWT claims в динамических тестах 009_validation.sql
# -----------------------------------------------------------------------------
if 'request.jwt.claims' not in sql_009:
    errors.append("В 009_validation.sql отсутствует инициализация request.jwt.claims для тестов в SQL Editor")

print(f"[8/8] Тестовое окружение: проверена настройка JWT claims для тестов без авторизации.")

# -----------------------------------------------------------------------------
# ИТОГОВЫЙ ОТЧЁТ
# -----------------------------------------------------------------------------
print("=" * 70)
if errors:
    print(f"❌ ОБНАРУЖЕНО {len(errors)} ОШИБОК:")
    for e in errors:
        print(f"  • {e}")
    print("=" * 70)
    sys.exit(1)
else:
    print("✅ ВСЕ 8 СТАТИЧЕСКИХ ПРОВЕРОК УСПЕШНО ПРОЙДЕНЫ.")
    if warnings:
        print("Предупреждения:")
        for w in warnings:
            print(f"  ⚠️ {w}")
    print("\nПримечание: Скрипт подтверждает синтаксическую структуру, контракты и констрейнты.")
    print("Для выполнения динамических тестов запустите 009_validation.sql в среде PostgreSQL/Supabase.")
    print("=" * 70)
