import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Минимальная структурная обёртка над Supabase клиентом.
 * Все загрузчики принимают её параметром с значением по умолчанию —
 * это позволяет подменять клиент в тестах, не трогая production-подключение.
 */
export type DbClient = SupabaseClient<any, any, any>;
