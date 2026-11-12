"""Cloud Sync Engine for FunPay Hotkeys Desktop (team backend v2.4).

Talks to the shared Supabase backend over PostgREST and GoTrue using only the
standard library (urllib + json).

Schema v2.4 notes that shape this client:
  * public.shifts is relational: it references profiles.user_id and
    team_seller_accounts.seller_account_id, and stores ISO timestamps. It holds no
    financial aggregates at all, because money is derived from public.orders
    (status = 'closed') by the dashboard.
  * public.operator_status tracks presence through status + last_heartbeat_at.
  * Every read is filtered by RLS policies that call is_active_team_member(), which
    resolves the caller through auth.uid(). The publishable key alone therefore returns
    HTTP 200 with zero rows, so team data requires an authenticated operator session.
"""

import json
import urllib.request
import urllib.error
from typing import List, Dict, Any, Optional, Tuple

DEFAULT_SUPABASE_URL = "https://zlpbywengymnvrpbcxvh.supabase.co"
DEFAULT_SUPABASE_KEY = "sb_publishable_bNZgLYmEol6FzzqvfXOHtA_d-mzoaKR"

REQUEST_TIMEOUT = 6

# Upper bound used by the extension when refreshing a token early.
_EXPIRY_SKEW_SECONDS = 60


def _parse_iso_to_ms(value: Optional[Any]) -> int:
    """Convert a Postgres ISO timestamp into Unix milliseconds (0 when unavailable)."""
    if not value or not isinstance(value, str):
        return 0
    import datetime as _dt

    text = value.replace("Z", "+00:00")
    try:
        parsed = _dt.datetime.fromisoformat(text)
    except ValueError:
        return 0
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=_dt.timezone.utc)
    return int(parsed.timestamp() * 1000)


class CloudSyncClient:
    """REST client for shifts, team presence and order synchronisation (schema v2.4)."""

    def __init__(self, url: str = DEFAULT_SUPABASE_URL, key: str = DEFAULT_SUPABASE_KEY):
        self.url = (url or DEFAULT_SUPABASE_URL).rstrip("/")
        self.key = key or DEFAULT_SUPABASE_KEY
        self._access_token: Optional[str] = None
        self._refresh_token: Optional[str] = None
        self._expires_at: float = 0.0
        self._user_id: Optional[str] = None
        self.last_error: Optional[str] = None

    # ------------------------------------------------------------------
    # Session handling
    # ------------------------------------------------------------------
    @property
    def user_id(self) -> Optional[str]:
        return self._user_id

    def has_session(self) -> bool:
        return bool(self._access_token and self._user_id)

    def set_session(
        self,
        access_token: str,
        refresh_token: Optional[str] = None,
        expires_at: float = 0.0,
        user_id: Optional[str] = None,
    ) -> None:
        self._access_token = access_token or None
        if refresh_token:
            self._refresh_token = refresh_token
        self._expires_at = float(expires_at or 0.0)
        if user_id:
            self._user_id = user_id

    def clear_session(self) -> None:
        self._access_token = None
        self._refresh_token = None
        self._expires_at = 0.0
        self._user_id = None

    def _headers(self, prefer: Optional[str] = None) -> Dict[str, str]:
        headers = {
            "apikey": self.key,
            "Authorization": "Bearer " + (self._access_token or self.key),
            "Content-Type": "application/json",
            "Prefer": prefer or "return=representation",
            "User-Agent": "FunPayHotkeysDesktop/2.4",
        }
        return headers

    def _apply_auth_payload(self, payload: Dict[str, Any]) -> None:
        self._access_token = payload.get("access_token") or None
        if payload.get("refresh_token"):
            self._refresh_token = payload.get("refresh_token")
        self._expires_at = float(payload.get("expires_at") or 0.0)
        user = payload.get("user") or {}
        if user.get("id"):
            self._user_id = user["id"]

    def _auth_request(self, path: str, body: Dict[str, Any]) -> Tuple[bool, str]:
        request = urllib.request.Request(
            self.url + path,
            data=json.dumps(body).encode("utf-8"),
            headers={
                "apikey": self.key,
                "Content-Type": "application/json",
                "User-Agent": "FunPayHotkeysDesktop/2.4",
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=REQUEST_TIMEOUT) as response:
                payload = json.loads(response.read().decode("utf-8"))
            self._apply_auth_payload(payload)
            if not self._access_token:
                return False, "Supabase не вернул данные сессии"
            return True, ""
        except urllib.error.HTTPError as exc:
            detail = ""
            try:
                detail = exc.read().decode("utf-8")
            except Exception:
                detail = ""
            message = self._humanize_auth_error(exc.code, detail)
            self.last_error = message
            return False, message
        except Exception as exc:
            message = f"Нет связи с Supabase: {exc}"
            self.last_error = message
            return False, message

    @staticmethod
    def _humanize_auth_error(status: int, detail: str) -> str:
        lowered = (detail or "").lower()
        if "invalid login credentials" in lowered:
            return "Неверный email или пароль"
        if "email not confirmed" in lowered:
            return "Email не подтверждён в Supabase"
        if "refresh token" in lowered or "expired" in lowered:
            return "Сессия истекла, требуется повторный вход"
        if detail:
            return f"Ошибка авторизации (HTTP {status}): {detail}"
        return f"Ошибка авторизации (HTTP {status})"

    def sign_in(self, email: str, password: str) -> Tuple[bool, str]:
        """Sign the operator in through GoTrue (grant_type=password)."""
        email = (email or "").strip()
        if not email or not password:
            return False, "Укажите email и пароль оператора"
        return self._auth_request("/auth/v1/token?grant_type=password", {"email": email, "password": password})

    def refresh_session(self) -> Tuple[bool, str]:
        """Refresh the access token when it is close to expiry."""
        if not self._refresh_token:
            return False, "Отсутствует refresh token"
        return self._auth_request("/auth/v1/token?grant_type=refresh_token", {"refresh_token": self._refresh_token})

    def sign_out(self) -> None:
        """Drop the local session. The desktop keeps no persisted credentials."""
        if self._access_token:
            try:
                request = urllib.request.Request(
                    self.url + "/auth/v1/logout",
                    data=b"{}",
                    headers=self._headers(),
                    method="POST",
                )
                urllib.request.urlopen(request, timeout=REQUEST_TIMEOUT).close()
            except Exception:
                pass
        self.clear_session()

    def _ensure_fresh_session(self) -> None:
        import time

        if not self._access_token or not self._expires_at:
            return
        if self._expires_at - _EXPIRY_SKEW_SECONDS <= time.time():
            self.refresh_session()

    # ------------------------------------------------------------------
    # Generic transport
    # ------------------------------------------------------------------
    def _get(self, path: str) -> Optional[Any]:
        self._ensure_fresh_session()
        request = urllib.request.Request(self.url + path, headers=self._headers(), method="GET")
        try:
            with urllib.request.urlopen(request, timeout=REQUEST_TIMEOUT) as response:
                if response.status != 200:
                    self.last_error = f"HTTP {response.status}"
                    return None
                return json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            self.last_error = f"HTTP {exc.code}"
            print(f"[CloudSync] GET {path} failed: HTTP {exc.code}")
            return None
        except Exception as exc:
            self.last_error = str(exc)
            print(f"[CloudSync] GET {path} error: {exc}")
            return None

    def _post(self, path: str, body: Any, prefer: Optional[str] = None) -> Optional[Any]:
        self._ensure_fresh_session()
        request = urllib.request.Request(
            self.url + path,
            data=json.dumps(body).encode("utf-8"),
            headers=self._headers(prefer),
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=REQUEST_TIMEOUT) as response:
                raw = response.read().decode("utf-8")
                return json.loads(raw) if raw else None
        except urllib.error.HTTPError as exc:
            detail = ""
            try:
                detail = exc.read().decode("utf-8")
            except Exception:
                detail = ""
            self.last_error = f"HTTP {exc.code}: {detail}"
            print(f"[CloudSync] POST {path} failed: HTTP {exc.code}")
            return None
        except Exception as exc:
            self.last_error = str(exc)
            print(f"[CloudSync] POST {path} error: {exc}")
            return None

    def rpc(self, function_name: str, args: Dict[str, Any]) -> Optional[Any]:
        """Invoke a public SECURITY DEFINER RPC (e.g. sync_orders_batch)."""
        return self._post(f"/rest/v1/rpc/{function_name}", args)

    # ------------------------------------------------------------------
    # Read endpoints (schema v2.4)
    # ------------------------------------------------------------------
    def test_connection(self) -> bool:
        """Probe the REST endpoint. RLS returns zero rows anonymously, but HTTP 200 proves reachability."""
        return self._get("/rest/v1/profiles?select=user_id&limit=1") is not None

    def fetch_team_status(self) -> List[Dict[str, Any]]:
        """Presence of the team, normalized to the shape the desktop UI already consumes."""
        rows = self._get(
            "/rest/v1/operator_status"
            "?select=user_id,status,active_shift_id,current_seller_account_id,app_version,last_heartbeat_at,profiles(display_name,role)"
            "&order=last_heartbeat_at.desc"
        )
        if not isinstance(rows, list):
            return []

        normalized: List[Dict[str, Any]] = []
        for row in rows:
            profile = row.get("profiles") or {}
            status = row.get("status") or "offline"
            normalized.append(
                {
                    "user_id": row.get("user_id"),
                    "operator_name": profile.get("display_name") or "Оператор",
                    "role": profile.get("role") or "operator",
                    "status": status,
                    # v2.4 folds the old boolean into a four-state status field.
                    "is_online": status in ("online", "on_shift", "break"),
                    "on_shift": status == "on_shift",
                    "current_shift_id": row.get("active_shift_id"),
                    "current_seller_account_id": row.get("current_seller_account_id"),
                    "app_version": row.get("app_version"),
                    "last_seen": row.get("last_heartbeat_at"),
                }
            )
        return normalized

    def fetch_shift_financials(self, shift_ids: List[str]) -> Dict[str, Dict[str, Any]]:
        """Aggregate closed orders per shift without combining currencies."""
        valid_shift_ids = [value for value in shift_ids if value]
        if not valid_shift_ids:
            return {}

        currencies = ("RUB", "USD", "EUR", "KZT")
        aggregates: Dict[str, Dict[str, Any]] = {
            shift_id: {
                "orders_count": 0,
                "turnover_by_currency": {code: 0.0 for code in currencies},
                "seller_share_by_currency": {code: 0.0 for code in currencies},
            }
            for shift_id in valid_shift_ids
        }
        batch_size = 100
        for offset in range(0, len(valid_shift_ids), batch_size):
            batch = valid_shift_ids[offset:offset + batch_size]
            encoded_ids = ",".join(batch)
            # shift_id already pins the query to the shift (and therefore its shop),
            # so no seller_account_id filter is needed or wanted here.
            rows = self._get(
                "/rest/v1/orders"
                "?select=shift_id,currency,amount"
                "&status=eq.closed"
                f"&shift_id=in.({encoded_ids})"
            )
            if not isinstance(rows, list):
                return {}

            for row in rows:
                shift_id = row.get("shift_id")
                currency = row.get("currency")
                try:
                    amount = float(row.get("amount"))
                except (TypeError, ValueError):
                    continue
                if not shift_id or currency not in currencies:
                    continue

                aggregate = aggregates.get(shift_id)
                if aggregate is None:
                    continue
                aggregate["orders_count"] += 1
                aggregate["turnover_by_currency"][currency] += amount
                aggregate["seller_share_by_currency"][currency] += amount * 0.10

        return aggregates

    def fetch_all_shifts(self, limit: int = 150) -> List[Dict[str, Any]]:
        """Shift history across the team, normalized to the desktop row shape.

        v2.4 keeps no per-shift financial aggregates, so orders_count / turnover /
        seller share are reported as unavailable (None / empty) instead of a fake zero.
        """
        rows = self._get(
            "/rest/v1/shifts"
            "?select=id,user_id,seller_account_id,start_time,end_time,duration_seconds,status,profiles(display_name)"
            f"&order=start_time.desc&limit={int(limit)}"
        )
        if not isinstance(rows, list):
            return []

        financials = self.fetch_shift_financials(
            [row.get("id") for row in rows if isinstance(row, dict)]
        )
        normalized: List[Dict[str, Any]] = []
        for row in rows:
            profile = row.get("profiles") or {}
            shift_financials = financials.get(row.get("id"))
            normalized.append(
                {
                    "id": row.get("id"),
                    "user_id": row.get("user_id"),
                    "operator_name": profile.get("display_name") or "Оператор",
                    "seller_account_id": row.get("seller_account_id"),
                    "start_time": _parse_iso_to_ms(row.get("start_time")),
                    "end_time": _parse_iso_to_ms(row.get("end_time")) or None,
                    "duration_seconds": int(row.get("duration_seconds") or 0),
                    "status": row.get("status") or "completed",
                    "orders_count": shift_financials["orders_count"] if shift_financials else 0,
                    "turnover_by_currency": shift_financials["turnover_by_currency"] if shift_financials else {},
                    "seller_share_by_currency": shift_financials["seller_share_by_currency"] if shift_financials else {},
                    "has_financials": shift_financials is not None,
                    "_is_cloud": True,
                }
            )
        return normalized

    def get_authorized_shops(self) -> List[Dict[str, Any]]:
        """Active shops registered by the owner in team_seller_accounts."""
        rows = self._get(
            "/rest/v1/team_seller_accounts?select=seller_account_id,account_name,is_active"
            "&is_active=eq.true&order=account_name.asc"
        )
        if not isinstance(rows, list):
            return []
        return [
            {
                "seller_account_id": row.get("seller_account_id"),
                "account_name": row.get("account_name"),
            }
            for row in rows
        ]

    # ------------------------------------------------------------------
    # Write helper (requires an authenticated operator session)
    # ------------------------------------------------------------------
    def sync_local_shift_to_cloud(self, shift_payload: Dict[str, Any]) -> bool:
        """Upload a locally finished shift using the v2.4 column set.

        Expected payload keys: user_id, seller_account_id, start_time (ISO),
        end_time (ISO, optional), status ('active' | 'completed').
        duration_seconds is recomputed by the server trigger, so it is not sent.
        """
        if not self.has_session():
            self.last_error = "Требуется вход оператора в облако команды"
            print("[CloudSync] sync_local_shift_to_cloud: no authenticated session")
            return False

        allowed = {
            key: shift_payload.get(key)
            for key in ("id", "user_id", "seller_account_id", "start_time", "end_time", "status")
            if shift_payload.get(key) is not None
        }
        return self._post("/rest/v1/shifts", allowed, prefer="resolution=merge-duplicates") is not None


# Global default client instance
cloud_client = CloudSyncClient()

