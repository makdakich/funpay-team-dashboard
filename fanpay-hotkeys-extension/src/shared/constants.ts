import { Profile, Template, AppSettings } from './types';

export const COMMON_PROFILE_ID = 'profile-common';

export const DEFAULT_PROFILES: Profile[] = [
  {
    id: 'profile-1',
    name: '🎮 Robux',
    isDefault: true,
    createdAt: 1700000001000
  },
  {
    id: 'profile-2',
    name: '⛏ Minecraft',
    createdAt: 1700000002000
  },
  {
    id: 'profile-3',
    name: '🎮 Steam',
    createdAt: 1700000003000
  },
  {
    id: 'profile-4',
    name: '🧪 Тест',
    createdAt: 1700000004000
  }
];

export const DEFAULT_TEMPLATES: Template[] = [
  // --- Profile 1: 🎮 Robux (Ваши сохраненные хоткеи F1-F8) ---
  {
    id: 'tmpl-1-1',
    profileId: 'profile-1',
    name: '👋 Приветствие',
    text: `🌐 ОТКРЫТЫЙ ПРОФИЛЬ
Roblox → ⚙️ Settings → Privacy & content restrictions → Visibility & private servers → Visibility
🔹 Show current experience → Everyone
После этого зайдите в нужный плейс и я зайду к вам`,
    hotkey: 'F1',
    enabled: true,
    sortOrder: 1
  },
  {
    id: 'tmpl-1-2',
    profileId: 'profile-1',
    name: '📋 Правила',
    text: `📦 Передача:
1️⃣ Приватный сервер
2️⃣ Открытый профиль
⚠️ В друзья не добавляю.`,
    hotkey: 'F2',
    enabled: true,
    sortOrder: 2
  },
  {
    id: 'tmpl-1-3',
    profileId: 'profile-1',
    name: '📦 Заказ принят',
    text: 'Заказ принят в обработку! Начинаю выполнение, пожалуйста подождите пару минут.',
    hotkey: 'F3',
    enabled: true,
    sortOrder: 3
  },
  {
    id: 'tmpl-1-4',
    profileId: 'profile-1',
    name: '🎮 Game Pass',
    text: `🎮 Напишите:
1️⃣ Какой Gamepass покупаете?
2️⃣ В каком плейсе он находится?`,
    hotkey: 'F4',
    enabled: true,
    sortOrder: 4
  },
  {
    id: 'tmpl-1-5',
    profileId: 'profile-1',
    name: '⏳ Ожидание',
    text: 'Пожалуйста, ожидайте, процесс занимает несколько минут из-за нагрузки.',
    hotkey: 'F5',
    enabled: true,
    sortOrder: 5
  },
  {
    id: 'tmpl-1-6',
    profileId: 'profile-1',
    name: '💰 Оплата',
    text: 'Оплата успешно поступила. Приступаю к отправке.',
    hotkey: 'F6',
    enabled: true,
    sortOrder: 6
  },
  {
    id: 'tmpl-1-7',
    profileId: 'profile-1',
    name: '✅ Выдача',
    text: 'Товар успешно передан! Пожалуйста, проверьте получение и подтвердите заказ.',
    hotkey: 'F7',
    enabled: true,
    sortOrder: 7
  },
  {
    id: 'tmpl-1-8',
    profileId: 'profile-1',
    name: '⚠️ Проблема',
    text: 'Возникла небольшая задержка со стороны сервера. Не переживайте, ваш заказ в приоритете.',
    hotkey: 'F8',
    enabled: true,
    sortOrder: 8
  },

  // --- Profile 2: ⛏ Minecraft ---
  {
    id: 'tmpl-2-1',
    profileId: 'profile-2',
    name: 'Приветствие & Ник',
    text: 'Здравствуйте! Укажите ваш игровой никнейм на сервере.',
    hotkey: 'F1',
    enabled: true,
    sortOrder: 1
  },
  {
    id: 'tmpl-2-2',
    profileId: 'profile-2',
    name: 'Координаты встречи',
    text: 'Подходите на спавн или на точку передачи, я телепортируюсь к вам.',
    hotkey: 'F2',
    enabled: true,
    sortOrder: 2
  },
  {
    id: 'tmpl-2-3',
    profileId: 'profile-2',
    name: 'Выдача предметов',
    text: 'Предметы переданы в инвентарь/сундук. Проверьте количество и подтвердите заказ на FunPay!',
    hotkey: 'F3',
    enabled: true,
    sortOrder: 3
  },

  // --- Profile 3: 🎮 Steam ---
  {
    id: 'tmpl-3-1',
    profileId: 'profile-3',
    name: 'Ссылка на трейд',
    text: 'Здравствуйте! Отправьте вашу прямую ссылку на обмен (Trade URL) и убедитесь, что инвентарь открыт.',
    hotkey: 'F1',
    enabled: true,
    sortOrder: 1
  },
  {
    id: 'tmpl-3-2',
    profileId: 'profile-3',
    name: 'Принятие обмена',
    text: 'Предложение обмена отправлено! Пожалуйста, подтвердите его в мобильном приложении Steam Guard.',
    hotkey: 'F2',
    enabled: true,
    sortOrder: 2
  },
  {
    id: 'tmpl-3-3',
    profileId: 'profile-3',
    name: 'Благодарность',
    text: 'Обмен успешно завершен! Спасибо за покупку, приятной игры и буду признателен за отзыв! ⭐',
    hotkey: 'F3',
    enabled: true,
    sortOrder: 3
  }
];

export const DEFAULT_SETTINGS: AppSettings = {
  selectedProfileId: 'profile-1',
  hotkeysEnabled: true,
  panelVisible: true,
  panelDocked: true,
  panelPosition: {
    bottom: 20,
    right: 20
  },
  theme: 'system',
  developerMode: false,
  sellerSharePercent: 10.0,
  autoSyncIntervalMinutes: 15,
  goldenKey: '',
  operatorsList: ['Оператор 1'],
  lastOperator: 'Оператор 1',
  shiftOverrunAlertHours: 8,
  shiftWidgetVisible: true,
  shiftWidgetPosition: {
    top: 70,
    left: 20,
    minimized: false
  }
};
