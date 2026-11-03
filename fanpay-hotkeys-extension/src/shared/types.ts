/**
 * Shared Type Definitions for FanPay Hotkeys Extension
 */

export interface Profile {
  id: string;
  name: string;
  isDefault?: boolean;
  createdAt: number;
}

export interface Template {
  id: string;
  profileId: string;
  name: string;
  text: string;
  hotkey: string; // e.g. "F1", "F2", "Ctrl+1", etc. Empty string if disabled
  enabled: boolean;
  sortOrder: number;
}

export type ThemeMode = 'light' | 'dark' | 'system';

export interface AppSettings {
  selectedProfileId: string;
  hotkeysEnabled: boolean;
  panelVisible: boolean;
  panelPosition?: {
    top?: number;
    left?: number;
    bottom?: number;
    right?: number;
  };
  panelDocked: boolean;
  theme: ThemeMode;
  developerMode: boolean;
  sellerSharePercent: number; // e.g. 10.0 (User defined percentage, NOT FunPay data)
  autoSyncIntervalMinutes: number; // e.g. 15
  goldenKey?: string; // Manual user credential token (golden_key cookie value)
  operatorsList?: string[]; // Saved list of worker/operator names for easy selection
  lastOperator?: string; // Last selected worker/operator name
}

export type OrderStatus = 'paid' | 'closed' | 'refunded' | 'unknown';

/**
 * Real order fields extracted from FunPay orders/trade
 */
export interface FunPayOrder {
  id: string; // e.g. "ABCDEF12"
  description: string; // Item name / description
  price: number | null; // Numeric amount, or null if cannot be parsed
  currency: string; // 'RUB' | 'USD' | 'EUR' or symbol
  buyerUsername: string; // Display name
  buyerId: number; // Primary unique client identifier
  chatId: string; // "users-{id1}-{id2}"
  status: OrderStatus; // paid, closed, refunded
  dateStr: string; // Raw date string from FunPay
  timestamp: number; // Parsed UTC timestamp in ms
  category?: string; // Subcategory / game if available
  priceParseError?: string; // Diagnostic error if price could not be extracted
}

/**
 * Account information obtained via web interface parsing
 */
export interface FunPayAccountInfo {
  userId: number;
  username: string;
  totalBalance: number;
  currency: string;
  balancesByCurrency?: Record<string, number>;
  activeSales: number;
  activePurchases: number;
  csrfToken?: string;
  locale?: string;
  lastUpdated: number;
}

/**
 * Single currency metrics block.
 * Currencies are NEVER mixed or summed together without conversion!
 */
export interface CurrencyStats {
  currency: string;
  turnover: number; // Sum of paid and closed orders
  sellerShare: number; // turnover * (sellerSharePercent / 100)
  ordersCount: number; // Count of paid and closed orders
  refundedCount: number; // Count of refunded orders
  refundedSum: number; // Total amount refunded
  uniqueClientsCount: number; // Unique buyer IDs for this currency
  averageOrderSum: number; // turnover / ordersCount
}

/**
 * Multi-currency period statistics
 */
export interface PeriodMultiCurrencyStats {
  currencies: Record<string, CurrencyStats>;
  totalOrdersCount: number; // Total transactions in this period
  totalRefundedCount: number;
  uniqueClientsCount: number;
}

/**
 * Complete Dashboard Statistics with isolated periods
 */
export interface DashboardStats {
  today: PeriodMultiCurrencyStats;
  last7Days: PeriodMultiCurrencyStats;
  last30Days: PeriodMultiCurrencyStats;
  last90Days: PeriodMultiCurrencyStats;
  allTime: PeriodMultiCurrencyStats;
  sellerSharePercent: number;
  balances: Record<string, number>; // Directly from FunPay, separate from turnover
  primaryCurrency: string;
  lastSync: number | null;
}

/**
 * Client summary grouped strictly by buyerId
 */
export interface ClientSummary {
  buyerId: number; // Primary unique client identifier
  buyerUsername: string; // Display name (can change on FunPay)
  ordersCount: number;
  spentByCurrency: Record<string, number>;
  refundedCount: number;
  lastOrderDate: string;
  lastOrderTimestamp: number;
  orderIds: string[];
}

export interface SyncCache {
  lastSyncTimestamp: number | null;
  accountInfo: FunPayAccountInfo | null;
  orders: FunPayOrder[];
  error: string | null;
  diagnosticReport?: string;
}

export interface ExtensionState {
  settings: AppSettings;
  profiles: Profile[];
  templates: Template[];
  cache: SyncCache;
}

export interface BackupData {
  version: string;
  exportDate: string;
  settings: Omit<AppSettings, 'goldenKey'>;
  profiles: Profile[];
  templates: Template[];
  shifts?: CompletedShift[];
}

export interface ShiftEarnings {
  ordersCount: number;
  turnoverByCurrency: Record<string, number>;
  sellerShareByCurrency: Record<string, number>;
  refundedCount: number;
  refundedSumByCurrency: Record<string, number>;
  orderIds: string[];
}

export interface CompletedShift {
  id: string;
  operatorName: string; // Worker/operator name
  startTime: number;    // Unix timestamp in ms
  endTime: number;      // Unix timestamp in ms
  duration: number;     // duration in ms
  sellerSharePercent?: number; // Snapshot of share % at shift time
  earnings: ShiftEarnings; // Turnover, seller share, orders count by currency
  note?: string;        // Optional operator note
}

export interface ShiftState {
  shiftActive: boolean;
  shiftStartTime: number | null; // Unix timestamp in ms
  currentOperator?: string;      // Active worker/operator name
  note?: string;
}

export type ExtensionMessage =
  | { type: 'GET_STATE' }
  | { type: 'UPDATE_SETTINGS'; payload: Partial<AppSettings> }
  | { type: 'SET_SELECTED_PROFILE'; payload: { profileId: string } }
  | { type: 'SAVE_PROFILE'; payload: Profile }
  | { type: 'DELETE_PROFILE'; payload: { profileId: string } }
  | { type: 'SAVE_TEMPLATE'; payload: Template }
  | { type: 'DELETE_TEMPLATE'; payload: { templateId: string } }
  | { type: 'REORDER_TEMPLATES'; payload: { templateIds: string[] } }
  | { type: 'TEST_API_CONNECTION'; payload?: { goldenKey?: string } }
  | { type: 'SYNC_DATA'; payload?: { force?: boolean } }
  | { type: 'CLEAR_API_CREDENTIALS' }
  | { type: 'INSERT_MESSAGE'; payload: { text: string } }
  | { type: 'EXPORT_BACKUP' }
  | { type: 'IMPORT_BACKUP'; payload: { backup: BackupData; overwrite: boolean } }
  | { type: 'OPEN_OPTIONS'; payload?: { tab?: string } }
  | { type: 'GET_FUNPAY_CONTEXT' }
  | { type: 'GET_SHIFT_STATE' }
  | { type: 'START_SHIFT'; payload?: { operatorName?: string; note?: string } }
  | { type: 'STOP_SHIFT'; payload?: { note?: string } }
  | { type: 'GET_SHIFT_HISTORY' }
  | { type: 'SAVE_SHIFT'; payload: { shift: CompletedShift } }
  | { type: 'DELETE_SHIFT'; payload: { shiftId: string } }
  | { type: 'RECALCULATE_SHIFTS_EARNINGS' };

export interface FunPayContext {
  onFunPay: boolean;
  username: string | null;
  orderId: string | null;
  product: string | null;
  amount: string | null;
  buyer: string | null;
  isChatOpen: boolean;
}
