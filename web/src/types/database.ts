export type TeamRole = 'owner' | 'operator';
export type InvitationStatus = 'invited' | 'pending_confirmation' | 'active' | 'inactive';
export type PresenceStatus = 'offline' | 'online' | 'on_shift' | 'break';
export type ShiftStatus = 'active' | 'completed';
export type CurrencyCode = 'RUB' | 'USD' | 'EUR' | 'KZT';
export type OrderStatus = 'paid' | 'closed' | 'refunded';
export type AttributionStatus = 'unassigned' | 'assigned' | 'ambiguous';
export type AttributionSource = 'none' | 'automatic' | 'manual';

export interface Profile {
  user_id: string;
  display_name: string;
  role: TeamRole;
  is_active: boolean;
  is_creator?: boolean;
  invitation_status?: InvitationStatus;
  invited_by_user_id?: string | null;
}

export interface OperatorStatus {
  user_id: string;
  status: PresenceStatus;
  active_shift_id: string | null;
  current_seller_account_id: string | null;
  last_heartbeat_at: string;
  app_version: string;
}

export interface Shift {
  id: string;
  user_id: string;
  seller_account_id: string;
  start_time: string;
  end_time: string | null;
  duration_seconds: number;
  status: ShiftStatus;
}

export interface SellerAccount {
  seller_account_id: string;
  account_name: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface Order {
  seller_account_id: string;
  order_id: string;
  buyer_id: string | null;
  buyer_username: string | null;
  title: string | null;
  description: string | null;
  subcategory: string | null;
  amount: string;
  currency: CurrencyCode;
  status: OrderStatus;
  funpay_created_at: string;
  operator_id: string | null;
  shift_id: string | null;
  attribution_status: AttributionStatus;
  attribution_source: AttributionSource;
  synced_by_user_id: string;
  last_synced_at: string;
  created_at: string;
  updated_at: string;
}

export interface OrderAuditLog {
  id: string;
  seller_account_id: string;
  order_id: string;
  old_operator_id: string | null;
  new_operator_id: string | null;
  old_operator_display_name: string | null;
  new_operator_display_name: string | null;
  old_attribution_status: AttributionStatus;
  new_attribution_status: AttributionStatus;
  old_attribution_source: AttributionSource;
  new_attribution_source: AttributionSource;
  changed_by_user_id: string | null;
  changed_by_display_name: string;
  reason: string;
  created_at: string;
}

export interface ProfileAuditLog {
  id: string;
  target_user_id: string;
  target_display_name: string;
  changed_by_user_id: string | null;
  changed_by_display_name: string;
  action: 'invite_created' | 'invite_resent' | 'role_changed' | 'member_activated' | 'member_deactivated';
  old_role?: string | null;
  new_role?: string | null;
  old_active_status?: boolean | null;
  new_active_status?: boolean | null;
  reason?: string | null;
  created_at: string;
}

export interface ClosedOrderAmount {
  amount: string;
  currency: CurrencyCode;
}

export interface CurrencyTotals {
  RUB: number;
  USD: number;
  EUR: number;
  KZT: number;
}

export interface TeamMemberRow {
  profile: Profile;
  presence: OperatorStatus | null;
  activeShift: Shift | null;
}

export interface RecentActivity {
  shift: Shift;
  displayName: string;
}

export interface OverviewOrderPoint {
  orderId: string;
  amount: number;
  currency: CurrencyCode;
  status: OrderStatus;
  timestamp: number;
  funpayCreatedAt: string;
}

export interface OverviewData {
  activeMembers: number;
  activeShifts: number;
  totalOrders: number;
  closedOrders: number;
  turnoverByCurrency: CurrencyTotals;
  operatorShareByCurrency: CurrencyTotals;
  recentActivity: RecentActivity[];
  orders: OverviewOrderPoint[];
  sellerAccountId?: string;
  storeName?: string;
  balancesByCurrency?: Record<string, number>;
  totalBalance?: number;
  balanceCurrency?: string;
}
