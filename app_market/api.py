"""HTTP interface for the same collector used by the CLI."""

from __future__ import annotations

from threading import BoundedSemaphore

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from .scanner import MarketScanError, ScanOptions, scan_category

app = FastAPI(
    title="App Market Scanner", version="0.1.0",
    description="Category input → live Google Play evidence → ranked top-five app list.",
)
_scan_slots = BoundedSemaphore(2)


class TopAppsRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    category: str = Field(min_length=1, max_length=120, examples=["notes"])
    country: str = "us"
    language: str = "en"
    max_candidates: int = Field(default=60, ge=5, le=200)
    days: int = Field(default=10, ge=1, le=90)
    workers: int = Field(default=4, ge=1, le=16)
    genre_id: str | None = None
    queries: list[str] = Field(default_factory=list, max_length=8)


@app.get("/health")
def health() -> dict[str, str]:
    """Process health only; does not make Google Play requests."""
    return {"status": "ok"}


@app.post("/top-apps")
def top_apps(request: TopAppsRequest) -> dict:
    try:
        options = ScanOptions(**request.model_dump())
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    if not _scan_slots.acquire(blocking=False):
        raise HTTPException(status_code=429, detail="Two scans are already running. Retry later.", headers={"Retry-After": "10"})
    try:
        report = scan_category(options)
        # The CLI's --report also includes the full ranking. HTTP callers need
        # the top five and enough metadata to assess collection completeness.
        return {key: value for key, value in report.items() if key != "ranking"}
    except MarketScanError as exc:
        raise HTTPException(status_code=502, detail={
            "message": str(exc),
            "report": {key: value for key, value in exc.report.items() if key != "ranking"},
        }) from exc
    finally:
        _scan_slots.release()
