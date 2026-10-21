# New App Agent

Meld follows **Describe your app → Review and customize → Get your app**, with one saved app profile throughout. Its [project workflow](docs/project-workflow.md) connects market research, APK analysis, user conflict choices, readable/versioned designs and an Android build worker. Fresh analysis requires reference APKs; builds require SDK 35 and JDK 17+.

## Workspace and development

Develop directly from this repository root; there is no nested `repo/` checkout.

| Folder | Responsibility |
| --- | --- |
| `frontend/` | Three-step React studio and typed API client |
| `backend/` | Project API, saved state, jobs, research and Android builds |
| `shared/` | Public contracts and reference/catalog normalization |
| `pipeline/` | TypeScript APK analysis, model calls, design validation and revision storage |
| [`minefield-plus-android/`](minefield-plus-android/README.md) | Standalone offline Minesweeper app with undo, pencil marks and durable saves |
| `app_market/` | Independent Python market collector |
| `docs/` | Design interaction, setup and API contracts |
| `md/` | Original APK-analysis implementation specification |

With Node 24, run `npm run dev`, then open http://127.0.0.1:4173. The script installs dependencies, prepares the scanner, compiles the pipeline and starts the integrated studio and API on that address. See [frontend setup](frontend/README.md), [workflow contracts](docs/project-workflow.md) and [pipeline setup](pipeline/README.md). Credentials, local caches, dependencies and prior experiment directories remain outside version control.

See [UI design and coding skills](docs/ui-coding-skills.md) for stage boundaries, pinned sources and build provenance, and the [Focus Grove example](docs/focus-grove-example.md) for the five-reference tree-focus run.

## Standalone market scanner

A standalone market-research component: **input an app category, receive a ranked list of up to five Android apps** with public Google Play evidence.

Extracted from the market-collection stage of [`copy_agent`](https://github.com/Zhuoxuan-Zhang/copy_agent), this component preserves its transparent 1–15 scoring formula and can run independently of the downstream design and APK stages. The collector does not require an LLM, API key, Google account, or Android SDK.

## Quick start

Requires Python 3.10+ and network access to Google Play.

```bash
git clone https://github.com/Zhuoxuan-Zhang/new_app_agent.git
cd new_app_agent
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -e '.[test]'

app-market scan --category "notes"
```

The command prints only a JSON array to standard output. Each entry includes its rank, package ID, title, developer, store category, rating, install count, monetization signals, sampled recent-review activity, score components, and Google Play URL. Diagnostics go to standard error.

Save the list and its collection evidence separately:

```bash
app-market scan \
  --category "notes" \
  --genre-id PRODUCTIVITY \
  --country us --language en \
  --max-candidates 60 --days 10 \
  --out outputs/notes-top-five.json \
  --report outputs/notes-report.json
```

`python -m app_market` supports the same commands. Output files are optional; the collector does not write files unless requested.

## HTTP interface

```bash
app-market serve --host 127.0.0.1 --port 8000
```

Send a category to the independent endpoint:

```bash
curl --fail-with-body http://127.0.0.1:8000/top-apps \
  -H 'Content-Type: application/json' \
  -d '{"category":"notes","genre_id":"PRODUCTIVITY","country":"us","max_candidates":30}' \
  > response.json

# Extract only the requested app list.
python -c 'import json; print(json.dumps(json.load(open("response.json"))["top_five"], indent=2))'
```

`POST /top-apps` returns a JSON object containing `top_five`, `status`, the requested category/locale, collection counts, the observation window, methodology, warnings, and errors. It omits the full candidate ranking, which is available through the Python function and CLI `--report`.

- `GET /health`: process health; does not contact Google Play.
- `GET /docs`: interactive request documentation.
- `GET /openapi.json`: machine-readable request schema.

Scans run synchronously and can take tens of seconds or longer. Configure a suitable client timeout. The service allows two concurrent scans per process and returns HTTP 429 with `Retry-After` when busy. It binds to localhost by default; add your own authentication and deployment controls if exposing it externally.

## Input contract

| Field | Default | Meaning |
| --- | --- | --- |
| `category` | Required | Search topic, such as `notes`, `fitness`, or `video editor`; recognized store genre names/IDs also enable exact genre filtering. |
| `genre_id` | Auto for recognized genres; otherwise unset | Optional exact Google Play listing `genreId`, such as `PRODUCTIVITY` or `HEALTH_AND_FITNESS`. |
| `country` | `us` | Two-letter country code. |
| `language` | `en` | Listing/search language, such as `en` or `zh-CN`. |
| `max_candidates` | `60` | Maximum unique candidates to fetch, from 5 to 200; not a guarantee that this many apps exist. |
| `days` | `10` | Inclusive UTC review observation window, from 1 to 90 days, ending today. |
| `workers` | `4` | Parallel app-collection workers, from 1 to 16. |
| `queries` | Derived from category | Optional list of up to eight discovery phrases; CLI equivalent: repeated `--query`. |

For a topic, the default searches are the category itself, `<category> app`, and `best <category>`. Discovery stops at `max_candidates`, deduplicates package IDs, and never inserts fixed benchmark apps. Each query contributes at most 30 search results.

**Category semantics matter:** `PRODUCTIVITY`, `productivity`, and `Health & Fitness` are recognized store genres and are checked against each listing's `genreId`. A niche topic such as `notes` is a Google Play search request; topic relevance follows the store's search results and can cross official genres. Add `genre_id` to restrict those results further. An explicit genre ID overrides the inferred one. Custom `queries` replace the default phrases, so choose phrases relevant to the requested topic.

Broaden a niche search without scanning unrelated categories:

```bash
app-market scan --category "note taking" --genre-id PRODUCTIVITY \
  --query "note taking" --query "notepad" --query "notebook"
```

## Output and failure contract

The CLI's standard output and `--out` contain `list[App]`. The HTTP response and Python report contain that same list as `top_five`.

| App field | Meaning |
| --- | --- |
| `rank`, `app_id`, `title`, `developer` | Position within this scan and app identity. |
| `category`, `genre_id`, `store_summary`, `store_url` | Public listing context and source link. |
| `store_description` | The listing's full description as written by the developer, up to 4,000 characters. |
| `icon_url`, `screenshot_urls` | Links to the listing's icon and up to four screenshots on Google's image servers (https only); `""` and `[]` when missing. |
| `rating`, `ratings`, `installs` | Current listing metrics; missing rating is null, missing counts use zero in the inherited scoring formula. |
| `offers_iap`, `contains_ads`, `price`, `currency` | Visible monetization signals, not actual revenue. |
| `profitability_proxy_1_15` | Integer opportunity score, higher is better. |
| `score_components` | Five normalized components used by the scoring formula. |
| `recent_review_sample_count`, `review_sample_by_day` | Counts within the configured window from at most 100 newest reviews. |

The full report additionally includes `ranking` and candidate IDs, query counts, excluded packages, failed request types, warnings, and timestamps. No review text or reviewer identity is retained.

| Outcome | Report status | CLI exit | HTTP |
| --- | --- | --- | --- |
| Five results, no request failures | `complete` | `0` | `200` |
| Five results, some request failures | `partial` | `2` | `200` |
| Fewer than five matches, including zero clean matches | `insufficient_results` | `2` | `200` |
| No usable apps and upstream/collection errors | Failure report in `--report` / HTTP `detail.report` | `1` | `502` |
| Invalid options | Error message | `1` (`2` for CLI syntax errors) | `422` |

Always inspect `status`, `warnings`, and the list length. Insufficient results are returned honestly; the scanner never fills missing positions with unrelated, cached, or synthetic apps. Apps whose listing or review collection fails are excluded, with an error record. A clean status means collection succeeded for the discovered pool; it does not establish full-market coverage. On a hard failure, the CLI does not overwrite an existing `--out` file.

## How ranking works

The original `score_listing` formula is retained:

```text
scale        = clamp(log10(installs + 10) / 10)
quality      = clamp((rating - 1) / 4)
rating_depth = clamp(log10(ratings + 10) / 9)
monetization = clamp(0.45 + 0.25*IAP + 0.20*ads + 0.10*paid)
activity     = clamp(log(1 + recent_sample_count) / log(101))

raw = 0.35*scale + 0.20*quality + 0.15*rating_depth
    + 0.20*monetization + 0.10*activity
score = clamp_to_1_15(round(1 + 14*raw))
```

`clamp` bounds values to `[0, 1]`; `round` uses Python's rounding behavior. Apps are ordered by score descending, installs descending, rating descending, and package ID ascending. The last key makes ties deterministic regardless of parallel request completion order.

**“Top five” means the best scores within the successfully collected search sample.** This is not an official Google Play chart, a revenue ranking, or an exhaustive category census. Review activity is a bounded sample, not total review volume or download growth. Listing metrics are current snapshots, not a historical time series. Naive scraper review timestamps are treated as UTC.

## Python integration

```python
from app_market import ScanOptions, scan_category

report = scan_category(ScanOptions(
    category="notes",
    genre_id="PRODUCTIVITY",
    max_candidates=30,
))
for app in report["top_five"]:
    print(app["rank"], app["title"], app["profitability_proxy_1_15"], app["store_url"])
```

Catch `app_market.scanner.MarketScanError` for collection failures; its `report` contains the failure evidence. `ScanOptions` raises `ValueError` for invalid input. A custom provider implementing `MarketProvider` can be supplied to `scan_category` for offline tests or another data adapter.

## Development and verification

```bash
python -m pip install -e '.[test]'
python -m unittest discover -s tests -v
python -m compileall -q app_market
```

Tests use deterministic fixtures and mocked upstream calls; they do not contact Google Play. To check live collection independently:

```bash
app-market scan --category notes --genre-id PRODUCTIVITY --max-candidates 15 \
  --out outputs/smoke-top-five.json --report outputs/smoke-report.json
```

The collector uses [`google-play-scraper`](https://github.com/JoMingyu/google-play-scraper) 1.2.7 for public search, listing, and review retrieval. Google Play changes or rate limits can break scraping. The adapter uses verified TLS and a 20-second timeout per network operation; the library's internal retries mean a complete scan can take longer. Dependencies and generated outputs are kept out of Git.

Verified on **2026-10-12 with Python 3.12**: all 25 offline tests passed. A live CLI scan of `notes` with `PRODUCTIVITY` filtering collected 15 candidates, ranked 14 eligible apps, and returned five with zero collection failures. A live HTTP request for `Health & Fitness` ranked 15 eligible apps and returned five with zero failures. These are smoke checks of the current provider and interfaces, not proof of exhaustive market coverage; future rankings can change.

## Repository layout and extraction boundary

```text
app_market/
  scoring.py     # Original market opportunity scoring formula
  provider.py    # Google Play network adapter
  scanner.py     # Category discovery, filtering, evidence, ranking
  cli.py         # JSON CLI and server launcher
  api.py         # Independent HTTP interface
tests/           # Offline collector and interface regression tests
README.md
pyproject.toml
```

The source component is `copy_agent/pipeline_demo/market_scan.py`. Extraction preserves scoring weights and bounded newest-review sampling. Changes are category-specific discovery, optional exact genre filtering, stable tie-breaking, explicit partial-result behavior, bounded inputs, and independent CLI/HTTP/Python interfaces. The original pipeline is not modified. Its broad cross-category query list, pinned emulator-compatible app set, model calls, private credentials, APKs, and generated run artifacts are not part of this repository.
