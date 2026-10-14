from __future__ import annotations

import unittest
from datetime import date, datetime, timedelta, timezone

from app_market.scanner import MarketScanError, ScanOptions, _review_days, scan_category
from app_market.scoring import score_listing


class FakeProvider:
    def __init__(self, count: int = 8):
        self.rows = {
            f"example.notes{i}": {
                "title": f"Notes {i}", "genreId": "PRODUCTIVITY", "genre": "Productivity",
                "score": 4.5, "ratings": 1000, "realInstalls": 100_000,
                "developer": "Example", "offersIAP": True,
            } for i in range(count)
        }
        self.search_calls = []
        self.listing_calls = []
        self.review_calls = []
        self.failures = set()

    def search(self, query, *, country, language):
        self.search_calls.append((query, country, language))
        return [{"appId": key} for key in reversed(self.rows)] + [{"appId": "example.notes0"}]

    def listing(self, app_id, *, country, language):
        self.listing_calls.append(app_id)
        if app_id in self.failures:
            raise RuntimeError("Sensitive upstream exception text should not be copied")
        return self.rows[app_id]

    def reviews(self, app_id, *, country, language):
        self.review_calls.append(app_id)
        return [{"at": datetime(2026, 10, 12)}, {"at": datetime(2026, 10, 3)}, {"at": datetime(2026, 10, 2)}]


def scan(provider, **options):
    return scan_category(ScanOptions(category="notes", **options), provider=provider, today=date(2026, 10, 12))


class ScannerTests(unittest.TestCase):
    def test_unique_top_five_and_stable_ties(self):
        provider = FakeProvider()
        result = scan(provider)
        self.assertEqual(result["status"], "complete")
        self.assertEqual([row["app_id"] for row in result["top_five"]], [f"example.notes{i}" for i in range(5)])
        self.assertEqual([row["rank"] for row in result["top_five"]], list(range(1, 6)))
        self.assertEqual(len(provider.listing_calls), 8)
        self.assertEqual(len(set(provider.listing_calls)), 8)
        self.assertEqual(result["collection"]["candidate_packages"], list(reversed(provider.rows)))

    def test_listing_text_is_kept_and_bounded(self):
        provider = FakeProvider()
        provider.rows["example.notes0"]["summary"] = "Quick notes"
        provider.rows["example.notes0"]["description"] = "• Offline notes\n" + "x" * 5000
        result = scan(provider)
        first, second = result["top_five"][0], result["top_five"][1]
        self.assertEqual(first["store_summary"], "Quick notes")
        self.assertTrue(first["store_description"].startswith("• Offline notes\n"))
        self.assertEqual(len(first["store_description"]), 4000)
        self.assertEqual(second["store_description"], "")

    def test_image_links_are_kept_and_checked(self):
        provider = FakeProvider()
        provider.rows["example.notes0"]["icon"] = "https://play-lh.googleusercontent.com/icon0"
        provider.rows["example.notes0"]["screenshots"] = [
            f"https://play-lh.googleusercontent.com/shot{i}" for i in range(6)
        ]
        provider.rows["example.notes1"]["icon"] = "http://insecure.example/icon"
        provider.rows["example.notes1"]["screenshots"] = ["javascript:alert(1)", 7, None]
        provider.rows["example.notes2"]["screenshots"] = "https://play-lh.googleusercontent.com/not-a-list"
        first, second, third = scan(provider)["top_five"][:3]
        self.assertEqual(first["icon_url"], "https://play-lh.googleusercontent.com/icon0")
        self.assertEqual(
            first["screenshot_urls"],
            [f"https://play-lh.googleusercontent.com/shot{i}" for i in range(4)],
        )
        self.assertEqual((second["icon_url"], second["screenshot_urls"]), ("", []))
        self.assertEqual((third["icon_url"], third["screenshot_urls"]), ("", []))

    def test_discovery_uses_only_requested_topic_and_locale(self):
        provider = FakeProvider()
        scan(provider, country="GB", language="fr")
        self.assertEqual(provider.search_calls, [(q, "gb", "fr") for q in ("notes", "notes app", "best notes")])

    def test_candidate_budget_is_enforced(self):
        provider = FakeProvider(20)
        result = scan(provider, max_candidates=5)
        self.assertEqual(len(provider.search_calls), 1)
        self.assertEqual(len(provider.listing_calls), 5)
        self.assertEqual(result["collection"]["candidates_discovered"], 5)

    def test_exact_genre_excludes_unrelated_high_scoring_app(self):
        provider = FakeProvider()
        provider.rows["example.notes0"].update(genreId="SOCIAL", realInstalls=1_000_000_000)
        result = scan(provider, genre_id="productivity")
        self.assertEqual(result["collection"]["excluded_by_genre"], ["example.notes0"])
        self.assertNotIn("example.notes0", provider.review_calls)
        self.assertNotIn("example.notes0", [row["app_id"] for row in result["top_five"]])

    def test_store_category_auto_filter_and_explicit_override(self):
        self.assertEqual(ScanOptions("Health & Fitness").effective_genre, "HEALTH_AND_FITNESS")
        self.assertEqual(ScanOptions("productivity").effective_genre, "PRODUCTIVITY")
        self.assertEqual(ScanOptions("GAME_PUZZLE").search_queries[0], "puzzle")
        self.assertIsNone(ScanOptions("notes").effective_genre)
        self.assertEqual(ScanOptions("productivity", genre_id="TOOLS").effective_genre, "TOOLS")
        provider = FakeProvider()
        provider.rows["example.notes0"]["genreId"] = "SOCIAL"
        result = scan_category(ScanOptions("productivity"), provider=provider)
        self.assertEqual(result["collection"]["excluded_by_genre"], ["example.notes0"])

    def test_custom_queries_are_deduplicated(self):
        provider = FakeProvider()
        scan(provider, queries=("notepad", " notebook ", "notepad"))
        self.assertEqual([row[0] for row in provider.search_calls], ["notepad", "notebook"])

    def test_fewer_than_five_are_not_padded(self):
        result = scan(FakeProvider(3))
        self.assertEqual(result["status"], "insufficient_results")
        self.assertEqual(len(result["top_five"]), 3)
        self.assertTrue(result["warnings"])

    def test_no_genre_matches_is_an_empty_result(self):
        result = scan(FakeProvider(), genre_id="SOCIAL")
        self.assertEqual(result["status"], "insufficient_results")
        self.assertEqual(result["top_five"], [])
        self.assertEqual(result["errors"], [])

    def test_partial_failure_preserves_evidence(self):
        provider = FakeProvider()
        provider.failures.add("example.notes0")
        result = scan(provider)
        self.assertEqual(result["status"], "partial")
        self.assertEqual(len(result["top_five"]), 5)
        self.assertEqual(result["errors"], [{"stage": "collection", "app_id": "example.notes0", "error_type": "RuntimeError"}])

    def test_total_failure_raises_with_report(self):
        provider = FakeProvider()
        provider.failures = set(provider.rows)
        with self.assertRaises(MarketScanError) as raised:
            scan(provider)
        self.assertEqual(raised.exception.report["top_five"], [])
        self.assertEqual(len(raised.exception.report["errors"]), 8)

    def test_invalid_listing_is_excluded_instead_of_emitting_nan(self):
        provider = FakeProvider()
        provider.rows["example.notes0"]["score"] = float("nan")
        result = scan(provider)
        self.assertEqual(result["status"], "partial")
        self.assertEqual(result["errors"][0]["error_type"], "ValueError")
        self.assertNotIn("example.notes0", provider.review_calls)

    def test_review_failure_is_not_scored_as_zero_activity(self):
        provider = FakeProvider()
        original = provider.reviews

        def reviews(app_id, **kwargs):
            if app_id == "example.notes0":
                raise TimeoutError()
            return original(app_id, **kwargs)

        provider.reviews = reviews
        result = scan(provider)
        self.assertEqual(result["status"], "partial")
        self.assertNotIn("example.notes0", [row["app_id"] for row in result["ranking"]])
        self.assertEqual(result["errors"][0]["error_type"], "TimeoutError")

    def test_failed_search_can_recover_on_next_query(self):
        provider = FakeProvider()
        original = provider.search

        def search_query(query, **kwargs):
            if query == "notes":
                raise TimeoutError()
            return original(query, **kwargs)

        provider.search = search_query
        result = scan(provider)
        self.assertEqual(result["status"], "partial")
        self.assertEqual(len(result["top_five"]), 5)
        self.assertEqual(result["errors"][0]["stage"], "search")

    def test_review_window_boundaries_and_utc(self):
        result = scan(FakeProvider())
        self.assertEqual(result["top_five"][0]["recent_review_sample_count"], 2)
        self.assertEqual(result["observation_window"], {"start": "2026-10-03", "end": "2026-10-12", "days": 10})
        rows = [
            {"at": datetime(2026, 10, 3)}, {"at": datetime(2026, 10, 12, 23, 59)},
            {"at": datetime(2026, 10, 13)}, {"at": "not a datetime"},
            {"at": datetime(2026, 10, 3, 0, 30, tzinfo=timezone(timedelta(hours=2)))},
        ]
        self.assertEqual(sum(_review_days(rows, date(2026, 10, 3), date(2026, 10, 12)).values()), 2)

    def test_invalid_options_fail_before_network(self):
        for kwargs in ({"category": " "}, {"category": "x" * 121}, {"max_candidates": 4},
                       {"days": 0}, {"workers": True}, {"country": "USA"}, {"language": ""},
                       {"queries": "notes"}, {"queries": [" "]}, {"queries": ["x"] * 9},
                       {"genre_id": "../../path"}):
            with self.subTest(kwargs=kwargs), self.assertRaises(ValueError):
                ScanOptions(**{"category": "notes", **kwargs})

    def test_original_scoring_bounds_and_scale(self):
        small, _ = score_listing({"realInstalls": 100, "ratings": 20, "score": 4.2}, 2)
        large, components = score_listing({"realInstalls": 1_000_000_000, "ratings": 20_000_000, "score": 4.7, "offersIAP": True, "adSupported": True}, 100)
        self.assertGreater(large, small)
        self.assertGreaterEqual(small, 1)
        self.assertLessEqual(large, 15)
        self.assertEqual(len(components), 5)
        # Golden cases also detect unintended changes to the inherited formula.
        self.assertEqual(score_listing({}, 0)[0], 3)
        self.assertEqual(large, 14)


if __name__ == "__main__":
    unittest.main()
