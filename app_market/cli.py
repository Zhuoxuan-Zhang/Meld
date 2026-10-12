"""CLI and local HTTP server entry points."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from .scanner import MarketScanError, ScanOptions, scan_category


def _write(path: str | None, value: object) -> None:
    if path:
        target = Path(path)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n", encoding="utf-8")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="app-market", description="Collect public market evidence and return five apps for a category.")
    commands = parser.add_subparsers(dest="command", required=True)
    scan = commands.add_parser("scan", help="print a ranked top-five JSON list to stdout")
    scan.add_argument("--category", required=True, help="search topic or store genre, e.g. notes or PRODUCTIVITY")
    scan.add_argument("--country", default="us")
    scan.add_argument("--language", default="en")
    scan.add_argument("--max-candidates", type=int, default=60)
    scan.add_argument("--days", type=int, default=10)
    scan.add_argument("--workers", type=int, default=4)
    scan.add_argument("--genre-id", help="optional exact listing genreId filter")
    scan.add_argument("--query", action="append", default=[], help="override discovery phrases; repeat up to eight times")
    scan.add_argument("--out", help="also save the top-five JSON list")
    scan.add_argument("--report", help="save the full ranking, request errors, and collection metadata")
    serve = commands.add_parser("serve", help="start the HTTP interface (interactive docs at /docs)")
    serve.add_argument("--host", default="127.0.0.1")
    serve.add_argument("--port", type=int, default=8000)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.command == "serve":
        import uvicorn

        uvicorn.run("app_market.api:app", host=args.host, port=args.port)
        return 0
    try:
        if args.out and args.report and Path(args.out).resolve() == Path(args.report).resolve():
            raise ValueError("--out and --report must be different files")
        options = ScanOptions(
            category=args.category, country=args.country, language=args.language,
            max_candidates=args.max_candidates, days=args.days, workers=args.workers,
            genre_id=args.genre_id, queries=tuple(args.query),
        )
        report = scan_category(options)
        _write(args.out, report["top_five"])
        _write(args.report, report)
        print(json.dumps(report["top_five"], ensure_ascii=False, indent=2, allow_nan=False))
        for warning in report["warnings"]:
            print(warning, file=sys.stderr)
        return 0 if report["status"] == "complete" else 2
    except MarketScanError as exc:
        try:
            _write(args.report, exc.report)
        except OSError as write_error:
            print(f"Could not save failure report: {write_error}", file=sys.stderr)
        print(str(exc), file=sys.stderr)
        return 1
    except (OSError, ValueError) as exc:
        print(str(exc), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
