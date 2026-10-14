import { fromScannerReport } from "../src/market";

// Scanner-shaped fixtures (snake_case, as third_parties/new_app_agent writes
// them), so tests exercise the same conversion as the real server.
const listings = [
  ["com.example.calendar", "Calendar Pro", "Plan your day with tasks, reminders and a focus timer.", 4.64, 4_864_771, 10_322_980_403, 13],
  ["com.example.notes", "Notes Daily", "Write quick notes and keep a daily journal.", 4.78, 15_269_706, 2_177_981_084, 13],
  ["com.example.colornote", "Color Notes", "Take a quick note and manage to-do lists with color.", 4.88, 3_969_127, 207_047_120, 12],
  ["com.example.todo", "Todo Planner", "To-do list, daily planner and habit tracker.", 4.7, 715_771, 45_291_004, 12],
  ["com.example.focus", "Focus Flow", "Pomodoro focus sessions with progress stats.", 4.63, 958_138, 43_867_876, 11],
  ["com.example.extra", "Extra Budget", "Budget planner and expense tracker.", 4.5, 120_000, 5_000_000, 10],
] as const;

export function scannerApp(index: number, rank = index + 1, prefix = "") {
  const [id, title, summary, rating, ratings, installs, score] = listings[index];
  return {
    app_id: prefix ? id.replace("com.example", `com.${prefix}`) : id,
    title: prefix ? `${title} (${prefix})` : title,
    category: "Productivity",
    genre_id: "PRODUCTIVITY",
    developer: "Example Labs",
    store_summary: summary,
    store_description: `${summary}\n\nFeatures:\n• ${title} widgets\n• Sync across devices\n• Reminders`,
    // Focus Flow has no icon; the off-site screenshot link must be dropped.
    icon_url: index === 4 ? "" : `https://play-lh.googleusercontent.com/icon${index}`,
    screenshot_urls: [
      `https://play-lh.googleusercontent.com/shot${index}a`,
      `https://play-lh.googleusercontent.com/shot${index}b`,
      "https://images.example/shot.png",
    ],
    rating,
    ratings,
    installs,
    offers_iap: index === 1,
    contains_ads: index === 1,
    price: 0,
    currency: "USD",
    recent_review_sample_count: 100,
    review_sample_by_day: { "2026-10-12": 100 },
    profitability_proxy_1_15: score,
    score_components: {
      market_scale: 1,
      quality: 0.91,
      rating_depth: 0.74,
      monetization_surface: 0.45,
      recent_review_activity: 1,
    },
    store_url: `https://play.google.com/store/apps/details?id=${prefix ? id.replace("com.example", `com.${prefix}`) : id}&hl=en&gl=us`,
    rank,
  };
}
export function scannerReport(
  category: string,
  {
    status = "complete",
    count = 5,
    indexes,
    prefix = "",
  }: { status?: string; count?: number; indexes?: number[]; prefix?: string } = {},
) {
  const apps = (indexes || [...Array(count).keys()]).map((i, rank) =>
    scannerApp(i, rank + 1, prefix),
  );
  return {
    schema_version: "1.0",
    status,
    generated_at: new Date().toISOString(),
    category,
    genre_id: category === "Productivity" ? "PRODUCTIVITY" : null,
    country: "us",
    language: "en",
    top_five: apps,
    ranking: apps,
    collection: {
      max_candidates: 30,
      candidates_discovered: 30,
      apps_ranked: 28,
      failed_requests: 0,
    },
    observation_window: { start: "2026-10-03", end: "2026-10-12", days: 10 },
    warnings: [],
    errors: [],
  };
}
// The normalized result the local API returns for a domain.
export function marketResult(
  domain: string,
  options?: Parameters<typeof scannerReport>[1],
) {
  return fromScannerReport(domain, scannerReport(domain, options));
}
