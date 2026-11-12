import { createButton, createNotice, element, icon } from '@/components/ui';
import type { AuthService } from '@/lib/auth';
import { getErrorMessage } from '@/lib/errors';
import { supabaseConfigured } from '@/lib/supabase';

export function renderLogin(root: HTMLElement, auth: AuthService): void {
  const page = element('main', 'login-page');
  const ambient = element('div', 'login-ambient');
  ambient.setAttribute('aria-hidden', 'true');
  const card = element('section', 'login-card');
  const brand = element('div', 'login-brand');
  const brandMark = element('span', 'brand-mark');
  brandMark.append(icon('bolt'));
  brand.append(brandMark, element('span', 'brand-wordmark', ['FUNPAY']), element('span', 'brand-chip', ['TEAM CLOUD']));

  const intro = element('div', 'login-intro');
  intro.append(element('div', 'eyebrow', ['КОМАНДНЫЙ ПРОСТРАНСТВО']), element('h1', '', ['Войдите в рабочее пространство']), element('p', '', ['Мониторинг команды и смен в одном защищённом месте.']));

  const form = element('form', 'login-form');
  const emailLabel = element('label', 'field-label', ['Рабочая почта']);
  const email = element('input', 'text-input');
  email.type = 'email';
  email.name = 'email';
  email.autocomplete = 'username';
  email.placeholder = 'name@example.com';
  email.required = true;
  emailLabel.append(email);

  const passwordLabel = element('label', 'field-label', ['Пароль']);
  const passwordWrap = element('div', 'password-field');
  const password = element('input', 'text-input');
  password.type = 'password';
  password.name = 'password';
  password.autocomplete = 'current-password';
  password.placeholder = 'Введите пароль';
  password.required = true;
  const reveal = createButton('Показать', 'password-toggle');
  reveal.addEventListener('click', () => {
    const showing = password.type === 'text';
    password.type = showing ? 'password' : 'text';
    reveal.textContent = showing ? 'Показать' : 'Скрыть';
  });
  passwordWrap.append(password, reveal);
  passwordLabel.append(passwordWrap);

  const formError = element('div', 'form-message');
  formError.setAttribute('aria-live', 'polite');
  const submit = createButton('Войти в Dashboard', 'button button-primary');
  submit.type = 'submit';
  const securityNote = element('div', 'login-security');
  securityNote.append(element('span', 'security-dot'), element('span', '', ['Авторизация Supabase · доступ ограничен RLS']));

  form.append(emailLabel, passwordLabel, formError, submit, securityNote);
  form.addEventListener('submit', async event => {
    event.preventDefault();
    formError.replaceChildren();
    submit.disabled = true;
    submit.textContent = 'Проверяем доступ…';
    try {
      await auth.signIn(email.value, password.value);
      password.value = '';
      window.location.hash = '#/overview';
    } catch (error) {
      formError.append(createNotice('error', getErrorMessage(error)));
    } finally {
      submit.disabled = false;
      submit.textContent = 'Войти в Dashboard';
    }
  });

  card.append(brand, intro);
  if (!supabaseConfigured) {
    card.append(createNotice('info', 'Для подключения создайте web/.env по образцу web/.env.example. В файле используются только публичные параметры Supabase.'));
  }
  card.append(form, element('div', 'login-footer', ['Доступ предоставляется участникам активной команды.']));
  page.append(ambient, card, element('div', 'login-copyright', ['FUNPAY TEAM DASHBOARD · V2.4']));
  root.replaceChildren(page);
  email.focus();
}
