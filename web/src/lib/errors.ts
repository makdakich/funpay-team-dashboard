export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    const lower = error.message.toLowerCase();
    if (lower.includes('invalid login credentials')) return 'Неверный email или пароль.';
    if (lower.includes('email not confirmed')) return 'Подтвердите email, используя письмо от Supabase.';
    if (lower.includes('jwt expired') || lower.includes('refresh token')) {
      return 'Сессия истекла. Войдите в аккаунт ещё раз.';
    }
    if (lower.includes('failed to fetch') || lower.includes('network')) {
      return 'Не удалось связаться с Supabase. Проверьте интернет-соединение.';
    }
    return error.message;
  }
  return 'Произошла непредвиденная ошибка.';
}
