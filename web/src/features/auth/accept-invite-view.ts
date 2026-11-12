import { createButton, createNotice, element, icon } from '@/components/ui';
import type { AuthService } from '@/lib/auth';
import { getErrorMessage } from '@/lib/errors';
import { supabase, supabaseConfigured } from '@/lib/supabase';

export function renderAcceptInvite(root: HTMLElement, auth: AuthService): void {
  const page = element('main', 'login-page');
  const ambient = element('div', 'login-ambient');
  ambient.setAttribute('aria-hidden', 'true');
  const card = element('section', 'login-card');
  const brand = element('div', 'login-brand');
  const brandMark = element('span', 'brand-mark');
  brandMark.append(icon('bolt'));
  brand.append(brandMark, element('span', 'brand-wordmark', ['FUNPAY']), element('span', 'brand-chip', ['TEAM CLOUD']));

  const intro = element('div', 'login-intro');
  intro.append(
    element('div', 'eyebrow', ['КОМАНДНОЕ ПРИГЛАШЕНИЕ']),
    element('h1', '', ['Установка пароля']),
    element('p', '', ['Задайте пароль для доступа к рабочему пространству команды FunPay.'])
  );

  card.append(brand, intro);

  if (!supabaseConfigured) {
    card.append(createNotice('info', 'Для подключения создайте web/.env по образцу web/.env.example.'));
    page.append(ambient, card);
    root.replaceChildren(page);
    return;
  }

  const contentHost = element('div', 'invite-content');
  card.append(contentHost);
  page.append(ambient, card, element('div', 'login-copyright', ['FUNPAY TEAM DASHBOARD · V2.4']));
  root.replaceChildren(page);

  void checkInviteSession(contentHost, auth);
}

async function checkInviteSession(container: HTMLElement, auth: AuthService): Promise<void> {
  // Проверяем наличие ошибки в hash / search (например, ссылка устарела)
  const hashParams = new URLSearchParams(window.location.hash.split('#')[1] ?? '');
  const searchParams = new URLSearchParams(window.location.search);
  const errorDescription = hashParams.get('error_description') || searchParams.get('error_description');

  if (errorDescription) {
    container.append(
      createNotice('error', `Ошибка приглашения: ${decodeURIComponent(errorDescription.replace(/\+/g, ' '))}`),
      element('div', 'login-footer', [
        createLoginLink('Вернуться ко входу')
      ])
    );
    return;
  }

  // Получаем текущую сессию Supabase
  const { data: { session }, error: sessionError } = await supabase.auth.getSession();

  if (sessionError || !session) {
    container.append(
      createNotice('info', 'Ссылка приглашения не найдена, устарела или уже была использована. Если вы уже установили пароль, войдите в систему.'),
      element('div', 'login-footer', [
        createLoginLink('Перейти на страницу входа')
      ])
    );
    return;
  }

  // Сессия найдена — отображаем форму установки пароля
  const userEmail = session.user.email ?? 'участник команды';
  const emailBadge = element('div', 'notice notice-info text-xs');
  emailBadge.style.marginBottom = '14px';
  emailBadge.textContent = `Приглашение для аккаунта: ${userEmail}`;
  container.append(emailBadge);

  const form = element('form', 'login-form');

  const passwordLabel = element('label', 'field-label', ['Новый пароль']);
  const passwordWrap = element('div', 'password-field');
  const passwordInput = element('input', 'text-input');
  passwordInput.type = 'password';
  passwordInput.name = 'password';
  passwordInput.autocomplete = 'new-password';
  passwordInput.placeholder = 'Минимум 6 символов';
  passwordInput.required = true;
  passwordInput.minLength = 6;
  const revealPassword = createButton('Показать', 'password-toggle');
  revealPassword.type = 'button';
  revealPassword.addEventListener('click', () => {
    const showing = passwordInput.type === 'text';
    passwordInput.type = showing ? 'password' : 'text';
    revealPassword.textContent = showing ? 'Показать' : 'Скрыть';
  });
  passwordWrap.append(passwordInput, revealPassword);
  passwordLabel.append(passwordWrap);

  const confirmLabel = element('label', 'field-label', ['Повторите пароль']);
  const confirmWrap = element('div', 'password-field');
  const confirmInput = element('input', 'text-input');
  confirmInput.type = 'password';
  confirmInput.name = 'confirm_password';
  confirmInput.autocomplete = 'new-password';
  confirmInput.placeholder = 'Повторите новый пароль';
  confirmInput.required = true;
  confirmInput.minLength = 6;
  const revealConfirm = createButton('Показать', 'password-toggle');
  revealConfirm.type = 'button';
  revealConfirm.addEventListener('click', () => {
    const showing = confirmInput.type === 'text';
    confirmInput.type = showing ? 'password' : 'text';
    revealConfirm.textContent = showing ? 'Показать' : 'Скрыть';
  });
  confirmWrap.append(confirmInput, revealConfirm);
  confirmLabel.append(confirmWrap);

  const formError = element('div', 'form-message');
  formError.setAttribute('aria-live', 'polite');

  const submit = createButton('Установить пароль и продолжить', 'button button-primary');
  submit.type = 'submit';

  const securityNote = element('div', 'login-security');
  securityNote.append(element('span', 'security-dot'), element('span', '', ['Защищённое соединение · шифрование Supabase Auth']));

  form.append(passwordLabel, confirmLabel, formError, submit, securityNote);

  form.addEventListener('submit', async event => {
    event.preventDefault();
    formError.replaceChildren();

    const pwd = passwordInput.value;
    const confirmPwd = confirmInput.value;

    if (pwd.length < 6) {
      formError.append(createNotice('error', 'Пароль должен содержать не менее 6 символов.'));
      return;
    }

    if (pwd !== confirmPwd) {
      formError.append(createNotice('error', 'Введённые пароли не совпадают. Проверьте правильность ввода.'));
      return;
    }

    submit.disabled = true;
    submit.textContent = 'Сохраняем пароль…';

    try {
      const { data: updateData, error: updateError } = await supabase.auth.updateUser({
        password: pwd
      });

      if (updateError) throw updateError;

      // Проверяем статус профиля в базе
      const { data: profile } = await supabase
        .from('profiles')
        .select('is_active')
        .eq('user_id', updateData.user.id)
        .maybeSingle();

      if (profile?.is_active === true) {
        formError.append(createNotice('success', 'Пароль успешно установлен! Переходим в рабочее пространство…'));
        void auth.initialize();
        setTimeout(() => {
          window.location.hash = '#/overview';
        }, 800);
      } else {
        // Профиль не активирован (стандартная политика безопасности v2.4: закрытая регистрация)
        form.remove();
        container.replaceChildren(
          createNotice(
            'success',
            'Пароль успешно установлен! Ваша учётная запись подтверждена. Доступ к рабочему пространству откроется сразу после активации аккаунта руководителем команды.'
          ),
          element('div', 'login-footer', [
            createLoginLink('Перейти к экрану входа')
          ])
        );
      }
    } catch (error) {
      formError.append(createNotice('error', getErrorMessage(error)));
      submit.disabled = false;
      submit.textContent = 'Установить пароль и продолжить';
    }
  });

  container.append(form);
  passwordInput.focus();
}

function createLoginLink(text: string): HTMLElement {
  const link = createButton(text, 'button button-secondary');
  link.type = 'button';
  link.addEventListener('click', () => {
    window.location.hash = '#/login';
  });
  return link;
}
