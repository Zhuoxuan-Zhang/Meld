"""Small Google Play adapter; no model, APK, account, or emulator dependencies."""

from __future__ import annotations

import ssl
from typing import Any, Protocol
from urllib.request import urlopen


class MarketProvider(Protocol):
    def search(self, query: str, *, country: str, language: str) -> list[dict[str, Any]]: ...

    def listing(self, app_id: str, *, country: str, language: str) -> dict[str, Any]: ...

    def reviews(self, app_id: str, *, country: str, language: str) -> list[dict[str, Any]]: ...


# Version 1.2.7 changes ssl's process-wide default on import. Restore the caller's
# default and give this adapter its own verified TLS context and socket timeout.
_previous_context = ssl._create_default_https_context
try:
    import google_play_scraper as scraper
    from google_play_scraper.utils import request as scraper_request
finally:
    ssl._create_default_https_context = _previous_context

_tls_context = ssl.create_default_context()


def _bounded_urlopen(request: Any) -> Any:
    return urlopen(request, timeout=20, context=_tls_context)


scraper_request.urlopen = _bounded_urlopen


class GooglePlayProvider:
    """Fetch live public listings and at most 100 newest reviews per app."""

    def search(self, query: str, *, country: str, language: str) -> list[dict[str, Any]]:
        return scraper.search(query, n_hits=30, country=country, lang=language)

    def listing(self, app_id: str, *, country: str, language: str) -> dict[str, Any]:
        return scraper.app(app_id, country=country, lang=language)

    def reviews(self, app_id: str, *, country: str, language: str) -> list[dict[str, Any]]:
        rows, _ = scraper.reviews(
            app_id, country=country, lang=language, sort=scraper.Sort.NEWEST, count=100,
        )
        return rows[:100]
