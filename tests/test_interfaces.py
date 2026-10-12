from __future__ import annotations

import io
import json
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

from app_market.api import _scan_slots, app
from app_market.cli import main
from app_market.scanner import MarketScanError


def report(status="complete", count=5):
    rows = [{"rank": i + 1, "app_id": f"example.notes{i}"} for i in range(count)]
    return {"status": status, "top_five": rows, "ranking": rows, "warnings": []}


class InterfaceTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app)

    def test_cli_emits_json_list_and_separate_report(self):
        with tempfile.TemporaryDirectory() as root:
            output, details = Path(root) / "top.json", Path(root) / "report.json"
            stdout = io.StringIO()
            with patch("app_market.cli.scan_category", return_value=report()) as scan, redirect_stdout(stdout):
                code = main(["scan", "--category", "notes", "--out", str(output), "--report", str(details)])
            self.assertEqual(code, 0)
            self.assertEqual(len(json.loads(stdout.getvalue())), 5)
            self.assertEqual(json.loads(output.read_text()), report()["top_five"])
            self.assertEqual(json.loads(details.read_text())["status"], "complete")
            self.assertEqual(scan.call_args.args[0].category, "notes")

    def test_cli_returns_nonzero_for_partial_and_insufficient(self):
        for status, count in (("partial", 5), ("insufficient_results", 3)):
            with patch("app_market.cli.scan_category", return_value=report(status, count)), redirect_stdout(io.StringIO()):
                self.assertEqual(main(["scan", "--category", "notes"]), 2)

    def test_cli_failure_saves_report_but_does_not_overwrite_list(self):
        with tempfile.TemporaryDirectory() as root:
            output, details = Path(root) / "top.json", Path(root) / "report.json"
            output.write_text("previous output")
            error = MarketScanError("Upstream unavailable", report("insufficient_results", 0))
            with patch("app_market.cli.scan_category", side_effect=error), redirect_stderr(io.StringIO()):
                self.assertEqual(main(["scan", "--category", "notes", "--out", str(output), "--report", str(details)]), 1)
            self.assertEqual(output.read_text(), "previous output")
            self.assertEqual(json.loads(details.read_text())["top_five"], [])

    def test_cli_rejects_overlapping_output_paths(self):
        with patch("app_market.cli.scan_category") as scan, redirect_stderr(io.StringIO()):
            self.assertEqual(main(["scan", "--category", "notes", "--out", "same.json", "--report", "same.json"]), 1)
            scan.assert_not_called()

    def test_health_and_schema_do_not_collect(self):
        with patch("app_market.api.scan_category") as scan:
            self.assertEqual(self.client.get("/health").json(), {"status": "ok"})
            schema = self.client.get("/openapi.json").json()
            self.assertIn("/top-apps", schema["paths"])
            scan.assert_not_called()

    def test_http_category_request_returns_five_and_metadata(self):
        with patch("app_market.api.scan_category", return_value=report()) as scan:
            response = self.client.post("/top-apps", json={"category": "notes", "genre_id": "PRODUCTIVITY"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(response.json()["top_five"]), 5)
        self.assertNotIn("ranking", response.json())
        self.assertEqual(scan.call_args.args[0].effective_genre, "PRODUCTIVITY")

    def test_http_invalid_input_does_not_collect(self):
        with patch("app_market.api.scan_category") as scan:
            for value in ({}, {"category": " "}, {"category": "notes", "workers": True},
                          {"category": "notes", "max_candidates": 201}, {"category": "notes", "typo": 1}):
                with self.subTest(value=value):
                    self.assertEqual(self.client.post("/top-apps", json=value).status_code, 422)
            scan.assert_not_called()

    def test_http_failure_releases_capacity(self):
        with patch("app_market.api.scan_category", side_effect=MarketScanError("upstream", report("insufficient_results", 0))):
            for _ in range(3):
                response = self.client.post("/top-apps", json={"category": "notes"})
                self.assertEqual(response.status_code, 502)
                self.assertEqual(response.json()["detail"]["report"]["top_five"], [])

    def test_http_busy_returns_retry_after(self):
        _scan_slots.acquire()
        _scan_slots.acquire()
        try:
            with patch("app_market.api.scan_category") as scan:
                response = self.client.post("/top-apps", json={"category": "notes"})
                self.assertEqual(response.status_code, 429)
                self.assertEqual(response.headers["retry-after"], "10")
                scan.assert_not_called()
        finally:
            _scan_slots.release()
            _scan_slots.release()


if __name__ == "__main__":
    unittest.main()
