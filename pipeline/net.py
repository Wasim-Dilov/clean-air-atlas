"""Small JSON-over-HTTP helper with retries and rate-limit pacing (stdlib only)."""

from __future__ import annotations

import json
import logging
import time
from typing import Any, Callable, Mapping
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

log = logging.getLogger(__name__)

USER_AGENT = "clean-air-atlas/0.1 (personal non-commercial project)"


class FetchError(RuntimeError):
    """Raised when a request fails for good (after retries)."""


def build_url(base: str, path: str, params: Mapping[str, Any] | None = None) -> str:
    url = base.rstrip("/") + "/" + path.lstrip("/")
    if params:
        url += "?" + urlencode({k: v for k, v in params.items() if v is not None})
    return url


def get_json(
    url: str,
    headers: Mapping[str, str] | None = None,
    *,
    opener: Callable[..., Any] = urlopen,
    sleep: Callable[[float], None] = time.sleep,
    max_retries: int = 5,
    timeout: float = 60,
) -> Any:
    """GET a URL and parse JSON. Retries 429 and 5xx with backoff, honouring rate-limit headers."""
    req = Request(url, headers={"Accept": "application/json", "User-Agent": USER_AGENT, **(headers or {})})
    for attempt in range(max_retries + 1):
        try:
            with opener(req, timeout=timeout) as resp:
                body = json.load(resp)
                _pace(resp.headers, sleep)
                return body
        except HTTPError as err:
            if err.code == 429 or 500 <= err.code < 600:
                if attempt == max_retries:
                    raise FetchError(f"HTTP {err.code} after {max_retries} retries: {url}") from err
                wait = _retry_after(err.headers, attempt)
                log.warning("HTTP %s, retrying in %.0fs: %s", err.code, wait, _redact(url))
                sleep(wait)
                continue
            raise FetchError(f"HTTP {err.code}: {_redact(url)}") from err
        except (URLError, TimeoutError) as err:
            if attempt == max_retries:
                raise FetchError(f"network error after {max_retries} retries: {_redact(url)}") from err
            wait = 2**attempt
            log.warning("network error (%s), retrying in %ss", err, wait)
            sleep(wait)
    raise FetchError(f"unreachable: {_redact(url)}")


def _retry_after(headers: Any, attempt: int) -> float:
    for name in ("retry-after", "x-ratelimit-reset"):
        value = headers.get(name) if headers else None
        if value:
            try:
                return max(1.0, min(float(value), 120.0))
            except ValueError:
                pass
    return float(min(2 ** (attempt + 1), 60))


def _pace(headers: Any, sleep: Callable[[float], None]) -> None:
    """If the rate-limit window is nearly used up, wait for it to reset."""
    remaining = headers.get("x-ratelimit-remaining") if headers else None
    reset = headers.get("x-ratelimit-reset") if headers else None
    try:
        if remaining is not None and int(remaining) <= 1 and reset is not None:
            sleep(max(1.0, min(float(reset), 120.0)))
    except ValueError:
        pass


def _redact(url: str) -> str:
    return url.split("?")[0]
