// ============================================================================
// Supabase Edge Function: invite-member
// Назначение: Защищённое серверное приглашение участников в команду FunPay
//             через Supabase Auth Admin API (без утечки service_role на клиент).
// Авторизация: Доступно только активным пользователям с ролью 'owner'.
//              Приглашать с ролью 'owner' имеет право ТОЛЬКО Создатель (Creator).
// ============================================================================

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.0';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// Строгий белый список допустимых Origin для перенаправления после принятия приглашения
const ALLOWED_ORIGINS = new Set([
  'https://makdakich.github.io',
  'http://localhost:5173',
  'http://localhost:4173',
  'http://127.0.0.1:5173',
]);
const DEFAULT_ORIGIN = 'https://makdakich.github.io/funpay-team-dashboard';
const ACCEPT_INVITE_PATH = '/#/auth/accept-invite';

// Соответствие Origin базовому URL приложения (с учётом подпути на GitHub Pages)
const ORIGIN_APP_BASES: Record<string, string> = {
  'https://makdakich.github.io': 'https://makdakich.github.io/funpay-team-dashboard',
  'http://localhost:5173': 'http://localhost:5173',
  'http://localhost:4173': 'http://localhost:4173',
  'http://127.0.0.1:5173': 'http://127.0.0.1:5173',
};

/**
 * Валидация заголовка Origin против строгого белого списка.
 * Защищает от Open Redirect атак при принятии приглашений.
 * На GitHub Pages приложение развёрнуто в подпапке /funpay-team-dashboard.
 * На localhost приложение развёрнуто в корне /.
 * При любых несовпадениях или отсутствии заголовка используется безопасный fallback на продакшен GitHub Pages.
 */
function resolveRedirectTo(originHeader: string | null): string {
  if (originHeader) {
    try {
      const parsed = new URL(originHeader);
      if (ALLOWED_ORIGINS.has(parsed.origin)) {
        const appBase = ORIGIN_APP_BASES[parsed.origin] || parsed.origin;
        return `${appBase}${ACCEPT_INVITE_PATH}`;
      }
    } catch {
      // Игнорируем ошибки парсинга невалидного URL и используем fallback
    }
  }
  return `${DEFAULT_ORIGIN}${ACCEPT_INVITE_PATH}`;
}

interface InviteRequestBody {
  email: string;
  displayName?: string;
  role: 'owner' | 'operator';
  resend?: boolean;
}

serve(async (req: Request) => {
  // 1. CORS Preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Метод не поддерживается' }), {
      status: 405,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

    if (!supabaseUrl || !serviceRoleKey) {
      console.error('Missing server environment variables: SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
      return new Response(JSON.stringify({ error: 'Внутренняя ошибка конфигурации сервера' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // 2. Аутентификация вызывающего пользователя через JWT
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return new Response(JSON.stringify({ error: 'Требуется авторизация' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const token = authHeader.replace(/^Bearer\s+/i, '').trim();
    if (!token) {
      return new Response(JSON.stringify({ error: 'Требуется токен авторизации' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const userClient = createClient(supabaseUrl, Deno.env.get('SUPABASE_ANON_KEY') || serviceRoleKey, {
      global: { headers: { Authorization: `Bearer ${token}` } },
      auth: { persistSession: false },
    });

    const { data: { user: callerUser }, error: userError } = await userClient.auth.getUser();
    if (userError || !callerUser) {
      return new Response(JSON.stringify({ error: 'Недействительный токен авторизации' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // 3. Серверный клиент с правами service_role
    const adminClient = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    // 4. Проверка полномочий вызывающего в profiles
    const { data: callerProfile, error: profileError } = await adminClient
      .from('profiles')
      .select('user_id, display_name, role, is_active, is_creator')
      .eq('user_id', callerUser.id)
      .single();

    if (profileError || !callerProfile) {
      return new Response(JSON.stringify({ error: 'Профиль инициатора не найден в базе данных' }), {
        status: 403,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (!callerProfile.is_active || callerProfile.role !== 'owner') {
      return new Response(JSON.stringify({ error: 'Доступ запрещён: приглашать участников могут только активные руководители' }), {
        status: 403,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // 5. Парсинг и валидация тела запроса
    let body: InviteRequestBody;
    try {
      body = await req.json();
    } catch {
      return new Response(JSON.stringify({ error: 'Некорректный JSON в теле запроса' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const email = body.email ? body.email.trim().toLowerCase() : '';
    const displayName = body.displayName ? body.displayName.trim() : splitEmail(email);
    const targetRole = body.role === 'owner' ? 'owner' : 'operator';
    const isResend = Boolean(body.resend);

    if (!email || !email.includes('@')) {
      return new Response(JSON.stringify({ error: 'Укажите корректный email адрес' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // 6. КРИТИЧЕСКОЕ ОГРАНИЧЕНИЕ: Назначать роль Owner может ТОЛЬКО Creator
    if (targetRole === 'owner' && !callerProfile.is_creator) {
      return new Response(
        JSON.stringify({ error: 'Только Создатель системы (Creator) имеет право приглашать или назначать руководителей (owner)' }),
        { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // 7. Формирование строго проверенного redirectTo с защитой Origin
    const originHeader = req.headers.get('origin') || req.headers.get('referer');
    const redirectTo = resolveRedirectTo(originHeader);

    const userMetadata = {
      display_name: displayName,
      initial_role: targetRole,
      invited_by: callerUser.id,
    };

    let invitedUserId: string;
    let actionLink: string | null = null;
    let effectiveIsResend = isResend;

    if (effectiveIsResend) {
      // 7a. Повторное приглашение: используем generateLink, чтобы корректно обработать существующего пользователя
      const { data: linkData, error: linkError } = await adminClient.auth.admin.generateLink({
        type: 'invite',
        email,
        options: {
          data: {
            display_name: displayName,
          },
          redirectTo,
        },
      });

      if (linkError) {
        console.error('generateLink error during resend:', linkError);
        let clientMsg = `Ошибка повторной отправки приглашения: ${linkError.message}`;
        let statusCode = linkError.status === 429 ? 429 : (linkError.status || 400);
        if (linkError.message?.toLowerCase().includes('confirmed')) {
          clientMsg = 'Пользователь с таким email уже зарегистрирован и подтвердил аккаунт в системе';
          statusCode = 400;
        } else if (linkError.status === 429) {
          clientMsg = 'Превышен лимит отправки писем. Подождите несколько минут перед следующей попыткой';
          statusCode = 429;
        }
        return new Response(JSON.stringify({ error: clientMsg }), {
          status: statusCode,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      if (!linkData?.user?.id) {
        return new Response(JSON.stringify({ error: 'Не удалось получить идентификатор пользователя' }), {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      invitedUserId = linkData.user.id;
      actionLink = linkData.properties?.action_link ?? null;
    } else {
      // 7b. Первичное приглашение через inviteUserByEmail
      const { data: inviteData, error: inviteError } = await adminClient.auth.admin.inviteUserByEmail(email, {
        data: userMetadata,
        redirectTo,
      });

      if (inviteError) {
        console.warn('inviteUserByEmail error, checking if user already registered:', inviteError);
        const isAlreadyRegistered =
          inviteError.message?.toLowerCase().includes('already been registered') ||
          inviteError.message?.toLowerCase().includes('already registered');

        if (isAlreadyRegistered) {
          // Пользователь уже зарегистрирован/приглашён в auth.users, переключаемся на чистый resend flow
          effectiveIsResend = true;
          const { data: linkData, error: linkError } = await adminClient.auth.admin.generateLink({
            type: 'invite',
            email,
            options: {
              data: {
                display_name: displayName,
              },
              redirectTo,
            },
          });

          if (linkError) {
            console.error('generateLink fallback error:', linkError);
            let clientMsg = `Ошибка формирования приглашения: ${linkError.message}`;
            let statusCode = linkError.status === 429 ? 429 : (linkError.status || 400);
            if (linkError.message?.toLowerCase().includes('confirmed')) {
              clientMsg = 'Пользователь с таким email уже зарегистрирован и подтвердил аккаунт в системе';
              statusCode = 400;
            } else if (linkError.status === 429) {
              clientMsg = 'Превышен лимит отправки писем. Подождите несколько минут перед следующей попыткой';
              statusCode = 429;
            }
            return new Response(JSON.stringify({ error: clientMsg }), {
              status: statusCode,
              headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
          }

          if (!linkData?.user?.id) {
            return new Response(JSON.stringify({ error: 'Не удалось получить идентификатор пользователя' }), {
              status: 500,
              headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
          }

          invitedUserId = linkData.user.id;
          actionLink = linkData.properties?.action_link ?? null;
        } else {
          let clientMsg = `Ошибка отправки приглашения: ${inviteError.message}`;
          const statusCode = inviteError.status === 429 ? 429 : (inviteError.status || 400);
          if (inviteError.status === 429) {
            clientMsg = 'Превышен лимит отправки писем. Подождите несколько минут перед следующей попыткой';
          }
          return new Response(JSON.stringify({ error: clientMsg }), {
            status: statusCode,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
      } else {
        if (!inviteData?.user?.id) {
          return new Response(JSON.stringify({ error: 'Не удалось получить идентификатор пользователя' }), {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
        invitedUserId = inviteData.user.id;
      }
    }

    // 8. Проверка существующего профиля и сохранение ролевой авторизации
    const { data: existingProfile, error: profileFetchError } = await adminClient
      .from('profiles')
      .select('user_id, display_name, role, is_active, is_creator, invitation_status, invited_by_user_id')
      .eq('user_id', invitedUserId)
      .maybeSingle();

    if (profileFetchError) {
      console.error('Error fetching existing profile:', profileFetchError);
      return new Response(
        JSON.stringify({ error: `Ошибка проверки существующего профиля: ${profileFetchError.message}` }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    if (existingProfile) {
      // Защита Создателя: Создатель системы никогда не может быть переприглашён или изменён через инвайты
      if (existingProfile.is_creator) {
        return new Response(
          JSON.stringify({ error: 'Запрещено изменять профиль Создателя системы' }),
          { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      // Защита ролей: Только Создатель (Creator) может приглашать или изменять руководителей (owner)
      if (existingProfile.role === 'owner' && !callerProfile.is_creator) {
        return new Response(
          JSON.stringify({ error: 'Только Создатель системы (Creator) имеет право изменять или повторно приглашать руководителей (owner)' }),
          { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      // Если пользователь уже активен в команде, повторный инвайт отклоняется
      if (existingProfile.is_active || existingProfile.invitation_status === 'active') {
        return new Response(
          JSON.stringify({ error: 'Пользователь с таким email уже является активным участником команды' }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
    }

    const effectiveRole = existingProfile?.role ?? targetRole;
    const effectiveInvitedBy = existingProfile?.invited_by_user_id ?? callerUser.id;

    // 9. Сохраняем/обновляем статус в public.profiles без создания дубликатов и без автоактивации (is_active = false)
    const { error: profileUpsertError } = await adminClient
      .from('profiles')
      .upsert(
        {
          user_id: invitedUserId,
          display_name: displayName,
          role: effectiveRole,
          invitation_status: 'invited',
          invited_by_user_id: effectiveInvitedBy,
          is_active: false, // КРИТИЧЕСКАЯ БЕЗОПАСНОСТЬ: неактивен до подтверждения и явной активации
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'user_id' }
      );

    if (profileUpsertError) {
      console.error('Error saving profile for invited user:', profileUpsertError);
      return new Response(
        JSON.stringify({ error: `Ошибка сохранения профиля участника: ${profileUpsertError.message}` }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // 10. Фиксация в постоянном журнале аудита profile_audit_logs
    const { error: auditError } = await adminClient.from('profile_audit_logs').insert({
      target_user_id: invitedUserId,
      target_display_name: displayName,
      changed_by_user_id: callerUser.id,
      changed_by_display_name: callerProfile.display_name,
      action: effectiveIsResend ? 'invite_resent' : 'invite_created',
      old_role: existingProfile?.role ?? null,
      new_role: effectiveRole,
      old_active_status: existingProfile ? existingProfile.is_active : null,
      new_active_status: false,
      reason: effectiveIsResend
        ? `Повторное приглашение отправлено на ${email} (роль: ${effectiveRole})`
        : `Приглашение отправлено на ${email} (роль: ${effectiveRole})`,
    });

    if (auditError) {
      console.error('Error recording audit log for invitation:', auditError);
      return new Response(
        JSON.stringify({ error: `Ошибка записи в журнал аудита: ${auditError.message}` }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    return new Response(
      JSON.stringify({
        success: true,
        message: effectiveIsResend ? 'Приглашение отправлено повторно' : 'Приглашение успешно отправлено на почту',
        user_id: invitedUserId,
        email,
        role: effectiveRole,
        ...(actionLink ? { action_link: actionLink } : {}),
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (err: any) {
    console.error('Unhandled exception in invite-member:', err);
    return new Response(
      JSON.stringify({ error: `Внутренняя ошибка сервера: ${err?.message || 'Неизвестная ошибка'}` }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});

function splitEmail(email: string): string {
  const name = email.split('@')[0] || 'Участник';
  return name.charAt(0).toUpperCase() + name.slice(1);
}
