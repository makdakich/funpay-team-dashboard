/** Списки колонок для PostgREST: единая точка правды для всех разделов. */
export const PROFILE_COLUMNS = 'user_id,display_name,role,is_active';

export const SHIFT_COLUMNS = 'id,user_id,seller_account_id,start_time,end_time,duration_seconds,status';

export const ORDER_COLUMNS = [
  'seller_account_id',
  'order_id',
  'buyer_id',
  'buyer_username',
  'title',
  'description',
  'subcategory',
  'amount',
  'currency',
  'status',
  'funpay_created_at',
  'operator_id',
  'shift_id',
  'attribution_status',
  'attribution_source',
  'synced_by_user_id',
  'last_synced_at',
  'created_at',
  'updated_at'
].join(',');

export const AUDIT_COLUMNS = [
  'id',
  'seller_account_id',
  'order_id',
  'old_operator_id',
  'new_operator_id',
  'old_operator_display_name',
  'new_operator_display_name',
  'old_attribution_status',
  'new_attribution_status',
  'old_attribution_source',
  'new_attribution_source',
  'changed_by_user_id',
  'changed_by_display_name',
  'reason',
  'created_at'
].join(',');

export const SELLER_ACCOUNT_COLUMNS = 'seller_account_id,account_name,is_active,created_at,updated_at';
