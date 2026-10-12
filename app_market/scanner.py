"""Discover category candidates, collect evidence, and rank the best five."""

from __future__ import annotations

import math
import re
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from typing import Any

from .provider import GooglePlayProvider, MarketProvider
from .scoring import score_listing


# Recognized store genres use an exact listing genreId check. Other strings are
# search topics, which may span genres (for example, "notes" or "video editor").
STORE_GENRES = set("""
ART_AND_DESIGN AUTO_AND_VEHICLES BEAUTY BOOKS_AND_REFERENCE BUSINESS COMICS
COMMUNICATION DATING EDUCATION ENTERTAINMENT EVENTS FINANCE FOOD_AND_DRINK
HEALTH_AND_FITNESS HOUSE_AND_HOME LIBRARIES_AND_DEMO LIFESTYLE MAPS_AND_NAVIGATION
MEDICAL MUSIC_AND_AUDIO NEWS_AND_MAGAZINES PARENTING PERSONALIZATION PHOTOGRAPHY
PRODUCTIVITY SHOPPING SOCIAL SPORTS TOOLS TRAVEL_AND_LOCAL VIDEO_PLAYERS
WEATHER GAME_ACTION GAME_ADVENTURE GAME_ARCADE GAME_BOARD GAME_CARD GAME_CASINO
GAME_CASUAL GAME_EDUCATIONAL GAME_MUSIC GAME_PUZZLE GAME_RACING GAME_ROLE_PLAYING
GAME_SIMULATION GAME_SPORTS GAME_STRATEGY GAME_TRIVIA GAME_WORD
""".split())


def _genre_key(value: str) -> str:
    return re.sub(r"[\s-]+", "_", value.strip().replace("&", "and")).upper()


@dataclass(frozen=True)
class ScanOptions:
    category: str
    country: str = "us"
    language: str = "en"
    max_candidates: int = 60
    days: int = 10
    workers: int = 4
    genre_id: str | None = None
    queries: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        if not isinstance(self.category, str) or not 1 <= len(self.category.strip()) <= 120:
            raise ValueError("category must contain 1–120 characters")
        object.__setattr__(self, "category", self.category.strip())
        for name, lower, upper in (("max_candidates", 5, 200), ("days", 1, 90), ("workers", 1, 16)):
            value = getattr(self, name)
            if type(value) is not int or not lower <= value <= upper:
                raise ValueError(f"{name} must be an integer between {lower} and {upper}")
        if not isinstance(self.country, str) or not re.fullmatch(r"[a-zA-Z]{2}", self.country):
            raise ValueError("country must be a two-letter country code, such as us")
        if not isinstance(self.language, str) or not re.fullmatch(r"[a-zA-Z]{2,3}(?:[-_][a-zA-Z]{2,4})?", self.language):
            raise ValueError("language must be a language code, such as en or zh-CN")
        object.__setattr__(self, "country", self.country.lower())
        if self.genre_id is not None:
            if not isinstance(self.genre_id, str):
                raise ValueError("genre_id must be a string")
            genre = _genre_key(self.genre_id)
            if not re.fullmatch(r"[A-Z][A-Z0-9_]{1,79}", genre):
                raise ValueError("genre_id must be a Google Play genre ID, such as PRODUCTIVITY")
            object.__setattr__(self, "genre_id", genre)
        if isinstance(self.queries, str) or not isinstance(self.queries, (list, tuple)) or len(self.queries) > 8:
            raise ValueError("queries must be a list of at most eight search phrases")
        if any(not isinstance(q, str) or not 1 <= len(q.strip()) <= 120 for q in self.queries):
            raise ValueError("each query must contain 1–120 characters")
        object.__setattr__(self, "queries", tuple(dict.fromkeys(q.strip() for q in self.queries)))

    @property
    def effective_genre(self) -> str | None:
        key = _genre_key(self.category)
        return self.genre_id or (key if key in STORE_GENRES else None)

    @property
    def search_queries(self) -> tuple[str, ...]:
        if self.queries:
            return self.queries
        topic = self.category
        if _genre_key(topic) in STORE_GENRES:
            topic = _genre_key(topic).removeprefix("GAME_").replace("_", " ").lower()
        return tuple(dict.fromkeys((topic, f"{topic} app", f"best {topic}")))


class MarketScanError(RuntimeError):
    """No usable market evidence; never substitute a demo or cached ranking."""

    def __init__(self, message: str, report: dict[str, Any]):
        super().__init__(message)
        self.report = report


def _review_days(rows: list[dict[str, Any]], start: date, end: date) -> dict[str, int]:
    daily = {(start + timedelta(days=i)).isoformat(): 0 for i in range((end - start).days + 1)}
    for row in rows:
        at = row.get("at")
        if not isinstance(at, datetime):
            continue
        # The scraper returns naive dates. Treat those as UTC consistently.
        if at.tzinfo is not None:
            at = at.astimezone(timezone.utc)
        day = at.date()
        if start <= day <= end:
            daily[day.isoformat()] += 1
    return daily


def _fetch(
    app_id: str, provider: MarketProvider, options: ScanOptions, start: date, end: date,
) -> dict[str, Any] | None:
    listing = provider.listing(app_id, country=options.country, language=options.language)
    if not isinstance(listing, dict) or not listing.get("title"):
        raise ValueError("Upstream returned a listing without a title")
    if options.effective_genre and listing.get("genreId") != options.effective_genre:
        return None
    for key in ("realInstalls", "minInstalls", "ratings", "reviews", "score", "price"):
        value = listing.get(key)
        if value is not None and (type(value) not in (int, float) or not math.isfinite(value) or value < 0):
            raise ValueError(f"Upstream returned an invalid numeric field: {key}")
    reviews = provider.reviews(app_id, country=options.country, language=options.language)
    daily = _review_days(reviews[:100], start, end)
    recent = sum(daily.values())
    score, components = score_listing(listing, recent)
    return {
        "app_id": app_id,
        "title": listing["title"],
        "category": listing.get("genre") or "Unknown",
        "genre_id": listing.get("genreId"),
        "developer": listing.get("developer") or "Unknown",
        "store_summary": str(listing.get("summary") or "")[:1000],
        "rating": listing.get("score"),
        "ratings": listing.get("ratings") or listing.get("reviews") or 0,
        "installs": listing.get("realInstalls") or listing.get("minInstalls") or 0,
        "offers_iap": bool(listing.get("offersIAP") or listing.get("inAppProductPrice")),
        "contains_ads": bool(listing.get("adSupported") or listing.get("containsAds")),
        "price": listing.get("price") or 0,
        "currency": listing.get("currency"),
        "recent_review_sample_count": recent,
        "review_sample_by_day": daily,
        "profitability_proxy_1_15": score,
        "score_components": components,
        "store_url": f"https://play.google.com/store/apps/details?id={app_id}&hl={options.language}&gl={options.country}",
    }


def scan_category(
    options: ScanOptions, *, provider: MarketProvider | None = None,
    today: date | None = None,
) -> dict[str, Any]:
    """Return top_five plus ranking and collection evidence for this search pool."""
    provider = provider if provider is not None else GooglePlayProvider()
    end = today if today is not None else datetime.now(timezone.utc).date()
    start = end - timedelta(days=options.days - 1)
    packages: list[str] = []
    seen: set[str] = set()
    errors: list[dict[str, str]] = []
    query_counts: dict[str, int] = {}
    for query in options.search_queries:
        try:
            rows = provider.search(query, country=options.country, language=options.language)
            candidates = []
            for row in rows:
                app_id = str(row.get("appId") or "").strip()
                if re.fullmatch(r"[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)+", app_id):
                    candidates.append(app_id)
            query_counts[query] = len(set(candidates))
            for app_id in candidates:
                if app_id not in seen and len(packages) < options.max_candidates:
                    packages.append(app_id)
                    seen.add(app_id)
        except Exception as exc:
            errors.append({"stage": "search", "query": query, "error_type": type(exc).__name__})
        if len(packages) >= options.max_candidates:
            break
    apps: list[dict[str, Any]] = []
    excluded: list[str] = []
    with ThreadPoolExecutor(max_workers=options.workers) as executor:
        futures = {executor.submit(_fetch, app_id, provider, options, start, end): app_id for app_id in packages}
        for future in as_completed(futures):
            app_id = futures[future]
            try:
                row = future.result()
                if row is None:
                    excluded.append(app_id)
                else:
                    apps.append(row)
            except Exception as exc:
                # No exception text: upstream messages can contain arbitrary HTML/URLs.
                errors.append({"stage": "collection", "app_id": app_id, "error_type": type(exc).__name__})
    apps.sort(key=lambda row: (
        -row["profitability_proxy_1_15"], -float(row["installs"]),
        -float(row["rating"] or 0), row["app_id"],
    ))
    for rank, row in enumerate(apps, 1):
        row["rank"] = rank
    warnings = []
    if errors:
        warnings.append("Some upstream requests failed; the ranking covers only successfully collected apps.")
    if len(apps) < 5:
        warnings.append(f"Only {len(apps)} eligible apps were collected; no replacement apps were inserted.")
    report = {
        "schema_version": "1.0",
        "status": "complete" if len(apps) >= 5 and not errors else "partial" if len(apps) >= 5 else "insufficient_results",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "category": options.category,
        "genre_id": options.effective_genre,
        "country": options.country,
        "language": options.language,
        "top_five": apps[:5],
        "ranking": apps,
        "collection": {
            "max_candidates": options.max_candidates,
            "candidates_discovered": len(packages),
            "apps_ranked": len(apps),
            "query_result_counts": query_counts,
            "candidate_packages": packages,
            "excluded_by_genre": sorted(excluded),
            "failed_requests": len(errors),
        },
        "observation_window": {"start": start.isoformat(), "end": end.isoformat(), "days": options.days},
        "methodology": {
            "source": "live public Google Play listings and at most 100 newest public reviews per app",
            "selection": "search candidates with exact genreId filtering" if options.effective_genre else "topic search candidates; relevance follows Google Play search",
            "ranking": "original opportunity proxy descending, installs descending, rating descending, app_id ascending",
            "limitations": [
                "Top five within the discovered sample, not an official or exhaustive store chart.",
                "The 1–15 proxy is not measured revenue or profit.",
                "Review counts are bounded samples, not total review volume or download growth.",
                "Listing values are current snapshots, not historical observations.",
            ],
        },
        "warnings": warnings,
        "errors": sorted(errors, key=lambda row: (row["stage"], row.get("query", ""), row.get("app_id", ""))),
    }
    if not apps and errors:
        raise MarketScanError("No eligible apps could be collected. Check the category, genre filter, or upstream availability.", report)
    return report
