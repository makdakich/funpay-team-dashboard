/**
 * Chats Adapter
 * Documents verified chat operations and ensures no fake implementations.
 */

export type ChatFeatureStatus = 'SUPPORTED' | 'DISABLED_BY_DESIGN' | 'UNSUPPORTED_IN_MVP';

export interface ChatFeatureCapability {
  name: string;
  status: ChatFeatureStatus;
  description: string;
}

export class FunPayChatsAdapter {
  public static readonly CAPABILITIES: Record<string, ChatFeatureCapability> = {
    insertDraftMessage: {
      name: 'Вставка черновика в поле ввода',
      status: 'SUPPORTED',
      description: 'Безопасная вставка сообщения в поле ввода чата FunPay без автоотправки.'
    },
    autoSendMessage: {
      name: 'Автоматическая отправка сообщений',
      status: 'DISABLED_BY_DESIGN',
      description: 'Автоотправка сообщений покупателям намеренно отключена, решение об отправке всегда принимает продавец.'
    },
    runnerLongPolling: {
      name: 'Фоновый long-polling чатов через /runner/',
      status: 'UNSUPPORTED_IN_MVP',
      description: 'Внутренний механизм runner не активирован в расширении ради предотвращения блокировок и rate-limit.'
    }
  };

  /**
   * Get verification status for a chat feature
   */
  public static getCapability(featureKey: string): ChatFeatureCapability | null {
    return this.CAPABILITIES[featureKey] || null;
  }
}
