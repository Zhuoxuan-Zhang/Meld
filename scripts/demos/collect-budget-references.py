#!/usr/bin/env python3
"""Save public listing evidence for the explicitly selected budget demo apps."""
import concurrent.futures
import datetime
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from app_market.provider import GooglePlayProvider
from app_market.scanner import ScanOptions, _fetch
from google_play_scraper import app

OUTPUT = Path("outputs/budget-example")
APP_IDS = ["com.budget.tracker_app", "com.realbyteapps.moneymanagerfree", "com.droid4you.application.wallet"]


def collect(package):
    listing = app(package, lang="en", country="us")
    (OUTPUT / "listings" / f"{package}.json").write_text(json.dumps(listing, ensure_ascii=False, indent=2))
    end = datetime.date.today()
    return _fetch(package, GooglePlayProvider(), ScanOptions(category="Budget & expenses"), end - datetime.timedelta(days=10), end)


if __name__ == "__main__":
    (OUTPUT / "listings").mkdir(parents=True, exist_ok=True)
    rows = list(concurrent.futures.ThreadPoolExecutor(max_workers=3).map(collect, APP_IDS))
    rows.sort(key=lambda row: (-row["profitability_proxy_1_15"], row["app_id"]))
    for rank, row in enumerate(rows, 1):
        row["rank"] = rank
    report = {
        "category": "Budget & expenses", "country": "us", "language": "en",
        "status": "insufficient_results", "generated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "ranking": rows, "top_five": rows,
        "collection": {"candidates_discovered": 3, "apps_ranked": 3, "failed_requests": 0, "query_result_counts": {"Explicitly selected demo references": 3}},
        "observation_window": {"days": 10},
        "warnings": ["Three intentionally selected references, not a top-five market search. Budgeting, calendars and upcoming transactions already exist in Cashew; their reference attribution does not establish novelty."],
    }
    (OUTPUT / "selected-reference-report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2))
    print(json.dumps([{"package": row["app_id"], "title": row["title"]} for row in rows]))
