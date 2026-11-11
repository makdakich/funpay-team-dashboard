import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

const env = Object.fromEntries(
  readFileSync(new URL('../.env', import.meta.url), 'utf8')
    .split(/\r?\n/)
    .filter(line => line.includes('=') && !line.trim().startsWith('#'))
    .map(line => [line.slice(0, line.indexOf('=')).trim(), line.slice(line.indexOf('=') + 1).trim()])
);

const py = readFileSync(new URL('../../scripts/test_e2e_live.py', import.meta.url), 'utf8');
const email = py.match(/EMAIL\s*=\s*"([^"]+)"/)[1];
const password = py.match(/PASSWORD\s*=\s*"([^"]+)"/)[1];

const client = createClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_ANON_KEY, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
});

const log = (...parts) => process.stdout.write(parts.join(' ') + '\n');
const fails = [];

function check(name, ok, detail = '') {
  log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' :: ' + detail : ''));
  if (!ok) fails.push(name);
}

const auth = await client.auth.signInWithPassword({ email, password });
check('signInWithPassword', !auth.error && Boolean(auth.data.user), auth.error ? auth.error.message : 'user=' + auth.data.user.id.slice(0, 8) + '...');

const uid = auth.data.user?.id;
const profile = await client.from('profiles').select('user_id,display_name,role,is_active').eq('user_id', uid).maybeSingle();
check('profiles read (own row)', !profile.error && Boolean(profile.data), profile.error ? profile.error.message : JSON.stringify(profile.data));

const shops = await client.from('team_seller_accounts').select('seller_account_id,account_name,is_active').order('account_name');
check('team_seller_accounts read', !shops.error, shops.error ? shops.error.message : 'rows=' + shops.data.length);

const teams = await client.from('profiles').select('user_id,display_name,role,is_active').eq('is_active', true);
check('profiles read (active team)', !teams.error, teams.error ? teams.error.message : 'rows=' + teams.data.length);

const from = new Date(Date.now() - 30 * 86400000).toISOString();
const to = new Date(Date.now() + 86400000).toISOString();
const shifts = await client.from('shifts')
  .select('id,user_id,seller_account_id,start_time,end_time,duration_seconds,status')
  .gte('start_time', from).lt('start_time', to)
  .order('start_time', { ascending: false }).limit(201);
check('shifts read (30d window)', !shifts.error, shifts.error ? shifts.error.message : 'rows=' + shifts.data.length +
  ' statuses=' + JSON.stringify(shifts.data.map(s => s.status)));

const shiftIds = shifts.data.slice(0, 50).map(s => s.id);
const closedByShift = await client.from('orders').select('shift_id,amount,currency,status')
  .in('shift_id', shiftIds).eq('status', 'closed').order('order_id', { ascending: true }).range(0, 999);
check('orders read by shift_id (closed)', !closedByShift.error, closedByShift.error ? closedByShift.error.message :
  'rows=' + closedByShift.data.length + ' ' + JSON.stringify(closedByShift.data.map(o => o.shift_id.slice(0, 8) + '/' + o.amount + o.currency)));

const unlinked = await client.from('orders').select('shift_id,amount,currency,status,attribution_status')
  .eq('status', 'closed').is('shift_id', null).gte('funpay_created_at', from).lt('funpay_created_at', to)
  .order('funpay_created_at', { ascending: true }).range(0, 999);
check('orders read (closed, unlinked)', !unlinked.error, unlinked.error ? unlinked.error.message : 'rows=' + unlinked.data.length);

const finance = await client.from('orders')
  .select('seller_account_id,order_id,amount,currency,status,operator_id,attribution_status,funpay_created_at')
  .eq('status', 'closed').gte('funpay_created_at', from).lt('funpay_created_at', to)
  .order('funpay_created_at', { ascending: true }).range(0, 999);
check('orders read (finance window)', !finance.error, finance.error ? finance.error.message :
  'rows=' + finance.data.length + ' ' + JSON.stringify(finance.data.map(o => o.order_id + '=' + o.amount + o.currency + '/' + o.status)));

for (const status of ['paid', 'refunded']) {
  const head = await client.from('orders').select('order_id', { count: 'exact', head: true })
    .eq('status', status).gte('funpay_created_at', from).lt('funpay_created_at', to);
  check('orders count ' + status + ' (head:true)', !head.error, head.error ? head.error.message : 'count=' + head.count);
}

const page = await client.from('orders')
  .select('seller_account_id,order_id,buyer_id,buyer_username,amount,currency,status,funpay_created_at,operator_id,shift_id,attribution_status,attribution_source', { count: 'exact' })
  .order('funpay_created_at', { ascending: false }).range(0, 24);
check('orders paged list (count exact)', !page.error, page.error ? page.error.message :
  'page=' + page.data.length + ' total=' + page.count);

const search = await client.from('orders')
  .select('order_id,buyer_username,buyer_id', { count: 'exact' })
  .or('order_id.ilike.%TEST_ORD_001%,buyer_username.ilike.%TEST_ORD_001%,buyer_id.ilike.%TEST_ORD_001%')
  .range(0, 24);
check('orders search via .or(ilike)', !search.error, search.error ? search.error.message : 'matches=' + search.data.length);

const shopId = shops.data[0]?.seller_account_id ?? 'SELLER_MAIN';
const detail = await client.from('orders')
  .select('seller_account_id,order_id,amount,currency,status,funpay_created_at,buyer_id,operator_id,shift_id,attribution_status,attribution_source,last_synced_at')
  .eq('seller_account_id', shopId).eq('order_id', 'TEST_ORD_001').maybeSingle();
check('order detail by composite key', !detail.error && Boolean(detail.data), detail.error ? detail.error.message : JSON.stringify(detail.data));

const audit = await client.from('order_audit_logs')
  .select('id,created_at,changed_by_display_name,reason')
  .eq('seller_account_id', shopId).eq('order_id', 'TEST_ORD_001')
  .order('created_at', { ascending: false }).limit(50);
check('order_audit_logs read', !audit.error, audit.error ? audit.error.message : 'rows=' + audit.data.length);

const status = await client.from('operator_status').select('*').limit(5);
check('operator_status read', !status.error, status.error ? status.error.message : 'rows=' + status.data.length);

log('');
log(fails.length === 0 ? 'ALL LIVE READ CHECKS PASSED' : 'FAILURES: ' + fails.join(', '));
await client.auth.signOut();
process.exit(fails.length === 0 ? 0 : 1);
