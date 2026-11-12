/**
 * Shared Type Definitions for FunPay Hotkeys Extension
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
  panelEnabled?: boolean; // whether on-page floating hotkey panel is enabled (default true)
  panelVisible: boolean; // whether on-page floating panel is expanded (true) or collapsed into pill (false)
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
  shiftOverrunAlertHours?: number; // Alert threshold in hours (e.g. 8; 0 = disabled)
  shiftWidgetVisible?: boolean; // Whether floating shift HUD widget on FunPay is visible
  shiftWidgetPosition?: {
    top?: number;
    left?: number;
    minimized?: boolean;
  };
  supabaseUrl?: string; // Supabase project REST URL
  supabaseKey?: string; // Supabase public anon key
  cloudSyncEnabled?: boolean; // Real-time team cloud reporting
  sellerAccountId?: string; // FunPay seller account ID registered in team_seller_accounts (e.g. '1084291')
  soundEnabled?: boolean; // Audio cue when a template is inserted
  notificationsEnabled?: boolean; // Chrome push notifications for shift reminders
  cloudAutoPushOrders?: boolean; // Push locally cached orders to the team backend right after each FunPay sync
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

/**
 * Supabase Auth session of the operator (v2.4 team backend).
 * Every write RPC requires a valid access token, because the database derives
 * the caller identity strictly from auth.uid().
 */
export interface CloudAuthSession {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // Unix timestamp in ms
  userId: string; // auth.users.id / public.profiles.user_id
  email?: string;
  savedAt: number; // Unix timestamp in ms
}

/** Sanitized auth state safe to hand to the UI (no tokens). */
export interface CloudAuthState {
  signedIn: boolean;
  userId?: string;
  email?: string;
  expiresAt?: number;
  expired?: boolean;
}

/** Authorized FunPay shop registered by the owner in team_seller_accounts. */
export interface CloudShop {
  sellerAccountId: string;
  accountName: string;
}

/** Live team presence row from public.operator_status joined with profiles. */
export interface TeamMemberStatus {
  userId: string;
  displayName: string;
  role: 'owner' | 'operator' | string;
  status: 'offline' | 'online' | 'on_shift' | 'break';
  activeShiftId: string | null;
  sellerAccountId: string | null;
  appVersion: string | null;
  lastHeartbeatAt: string | null;
}

/** Aggregated response from sync_orders_batch across all chunks. */
export interface OrderSyncReport {
  sellerAccountId: string;
  totalOrders: number;
  sentOrders: number;
  inserted: number;
  updated: number;
  financialDiscrepancies: number;
  createdTimeDiscrepancies: number;
  ignoredStatusDowngrades: number;
  rejected: number; // rows the RPC answered with action = 'error'
  skippedLocally: number; // rows the adapter dropped before sending
  skippedDetails: { orderId: string; reason: string }[];
  errors: string[];
  chunks: number;
  finishedAt: number; // Unix timestamp in ms
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
  legacyId?: string;    // Original legacy ID from Chrome Extension (if imported)
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
  currentShiftId?: string;       // Unique UUID/id of current shift in cloud
  note?: string;
}

export interface SyncProgress {
  inProgress: boolean;
  page: number;
  totalOrdersFetched: number;
  newOrdersFetched: number;
  oldestOrderDate?: string;
  stage: string;
  error?: string | null;
  complete?: boolean;
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
  | { type: 'FETCH_ALL_HISTORY' }
  | { type: 'GET_SYNC_PROGRESS' }
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
  | { type: 'RECALCULATE_SHIFTS_EARNINGS' }
  | { type: 'TEST_SUPABASE_CONNECTION'; payload?: { url?: string; key?: string } }
  | { type: 'FETCH_TEAM_STATUS' }
  | { type: 'GET_CLOUD_AUTH_STATE' }
  | { type: 'SIGN_IN_CLOUD'; payload: { email: string; password: string } }
  | { type: 'SIGN_OUT_CLOUD' }
  | { type: 'FETCH_CLOUD_SHOPS' }
  | { type: 'SYNC_ORDERS_TO_CLOUD'; payload?: { sellerAccountId?: string } };

export interface FunPayContext {
  onFunPay: boolean;
  username: string | null;
  orderId: string | null;
  product: string | null;
  amount: string | null;
  buyer: string | null;
  isChatOpen: boolean;
}
