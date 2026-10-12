"""Scoring extracted from copy_agent/pipeline_demo/market_scan.py."""

from __future__ import annotations

import math
from typing import Any


def _clamp(value: float) -> float:
    return max(0.0, min(1.0, value))


def score_listing(row: dict[str, Any], recent_reviews: int) -> tuple[int, dict[str, float]]:
    """Return the original 1–15 opportunity proxy, never a revenue estimate."""
    installs = float(row.get("realInstalls") or row.get("minInstalls") or 0)
    ratings = float(row.get("ratings") or row.get("reviews") or 0)
    rating = float(row.get("score") or 0)
    quality = _clamp((rating - 1.0) / 4.0)
    scale = _clamp(math.log10(installs + 10.0) / 10.0)
    rating_depth = _clamp(math.log10(ratings + 10.0) / 9.0)
    monetization = 0.45
    if row.get("offersIAP") or row.get("inAppProductPrice"):
        monetization += 0.25
    if row.get("adSupported") or row.get("containsAds"):
        monetization += 0.20
    if float(row.get("price") or 0) > 0:
        monetization += 0.10
    activity = _clamp(math.log1p(max(0, recent_reviews)) / math.log(101.0))
    components = {
        "market_scale": scale,
        "quality": quality,
        "rating_depth": rating_depth,
        "monetization_surface": _clamp(monetization),
        "recent_review_activity": activity,
    }
    raw = (
        0.35 * scale
        + 0.20 * quality
        + 0.15 * rating_depth
        + 0.20 * components["monetization_surface"]
        + 0.10 * activity
    )
    return max(1, min(15, round(1 + raw * 14))), {
        key: round(value, 4) for key, value in components.items()
    }
