# FunPay Team Dashboard Web

Vite + TypeScript dashboard for the existing Supabase v2.4 project. All table access uses the signed-in user's JWT and the existing RLS policies; the browser build only ever ships the public publishable key.

## Stages

Stage 1: Auth, Overview, team presence, Realtime for `operator_status` and `shifts`, polling fallback.
Stage 2: shift history, orders (search, filters, sorting, server-side pagination, detail card, audit log, manual reassignment via RPC), finance analytics with period filters and per-currency charts.

## Local development

1. Install Node.js 20 or later.
2. Copy `.env.example` to `.env` in this directory. It contains only the public Supabase URL and publishable key; never add a `service_role` or `sb_secret_*` key.
3. Run `npm install` and `npm run dev`.
4. Use `npm run typecheck`, `npm test`, and `npm run build` for checks.
5. Optional read-only verification of the live project: `node scripts/live-read-check.mjs` (signs in with the same test account as `scripts/test_e2e_live.py`, performs reads only, and never writes).

## Routes

Hash-based routing, so any static host works: `#/login`, `#/overview`, `#/team`, `#/shifts`, `#/shifts/<shift-id>`, `#/orders`, `#/orders/<seller_account_id>/<order_id>`, `#/finance`.

Orders filters and the current page live in the query string (`#/orders?status=closed&page=2`). Filter changes use `history.replaceState`, so the list is not re-mounted; opening a detail card performs a real hash change and keeps the active filters as query parameters.

## Financial rules

Only `status = 'closed'` orders contribute to confirmed turnover and to the operator share, which is exactly 10% of that turnover. `paid` and `refunded` are excluded, so refunds are never subtracted twice. RUB, USD, EUR, and KZT are always displayed separately and never summed into one number. Orders without an operator count fully toward the team cash box with a zero operator share. `manual` attribution is never overwritten by synchronization or recalculation.

All aggregation happens client-side over paged PostgREST reads because the v2.4 schema defines tables, not SQL views; no request ever pulls an entire table at once.

## Realtime

Subscriptions cover `operator_status`, `shifts`, and `orders`; `orders` is already part of the project's Realtime publication. Each page owns at most one channel, removes it on teardown, and falls back to polling when the channel reports an error. If Realtime is unavailable, the interface says so instead of pretending it is live.

## Manual reassignment

Reassignment goes only through the `reassign_order_operator(seller_account_id, order_id, new_operator_id, reason)` RPC — never through a direct table update, which RLS forbids anyway. The RPC sets `orders.shift_id = NULL` and `attribution_source = 'manual'`, so a reassigned order stays in the team's confirmed turnover and in the new operator's share but leaves the turnover of the shift it was originally attributed to. The order detail card states this before the form.

## GitHub Pages

The root workflow (`.github/workflows/web-pages.yml`) runs `npm ci`, `npm run typecheck`, `npm test`, and `npm run build` on pull requests and default-branch pushes. It publishes only when started manually with `workflow_dispatch`. For a project site, Vite derives `base` from `GITHUB_REPOSITORY`; set `VITE_BASE_PATH` only for a custom Pages path. The deploy job reads `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` from repository variables.

The Supabase project must expose the existing v2.4 tables through its API schema, and the Realtime publication should include `operator_status`, `shifts`, and `orders`. No database migration is included in this web app.
