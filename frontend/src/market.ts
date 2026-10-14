import { apps as sampleApps, domains, featureById } from "./data";
import type { Feature, ReferenceApp } from "./data";

// One ranked app from the local market-signal scanner (third_parties/new_app_agent),
// normalized by the local server. Values are public Google Play snapshots.
export type MarketApp = {
  appId: string;
  rank: number;
  title: string;
  developer: string;
  storeCategory: string;
  genreId: string | null;
  summary: string;
  rating: number | null;
  ratings: number;
  installs: number;
  offersIap: boolean;
  containsAds: boolean;
  price: number;
  currency: string | null;
  score: number;
  components: Record<string, number>;
  recentReviews: number;
  storeUrl: string;
  // Kept from an earlier scan because the user selected its features.
  retained?: boolean;
};
export type MarketStatus = "complete" | "partial" | "insufficient_results";
export type MarketResult = {
  scanId?: string;
  domain: string;
  category: string;
  genreId: string | null;
  queries: string[];
  country: string;
  language: string;
  status: MarketStatus;
  generatedAt: string;
  apps: MarketApp[];
  warnings: string[];
  candidates: number;
  ranked: number;
  failedRequests: number;
  windowDays: number;
};

// How each suggested domain becomes a scanner request. Custom domains are
// sent as a plain Google Play search topic.
export const domainScans: Record<string, { genreId: string; queries: string[] }> =
  {
    Productivity: {
      genreId: "PRODUCTIVITY",
      queries: ["to do list", "notes", "focus timer"],
    },
    Wellness: {
      genreId: "HEALTH_AND_FITNESS",
      queries: ["meditation", "mindfulness", "mood tracker"],
    },
    Learning: {
      genreId: "EDUCATION",
      queries: ["language learning", "flashcards", "learn"],
    },
    Finance: {
      genreId: "FINANCE",
      queries: ["budget planner", "expense tracker", "personal finance"],
    },
    Fitness: {
      genreId: "HEALTH_AND_FITNESS",
      queries: ["workout", "fitness tracker", "running"],
    },
    Creativity: {
      genreId: "ART_AND_DESIGN",
      queries: ["drawing", "graphic design", "mood board"],
    },
  };
export function scanPlan(domain: string) {
  const known = domainScans[domain];
  return {
    category: domain,
    genreId: known?.genreId ?? null,
    queries: known?.queries ?? [],
  };
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown, max: number) =>
  typeof v === "string" ? v.trim().slice(0, max) : "";
const count = (v: unknown) =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0;
const packageId = /^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)+$/;
const statuses: MarketStatus[] = ["complete", "partial", "insufficient_results"];

function marketApp(v: unknown): MarketApp {
  if (!isRecord(v)) throw new Error("Invalid market app");
  const appId = text(v.appId, 160);
  const title = text(v.title, 120);
  const storeUrl = text(v.storeUrl, 400);
  const rank = v.rank;
  const score = v.score;
  if (
    !packageId.test(appId) ||
    !title ||
    !storeUrl.startsWith("https://play.google.com/") ||
    typeof rank !== "number" ||
    !Number.isInteger(rank) ||
    rank < 1 ||
    typeof score !== "number" ||
    !Number.isInteger(score) ||
    score < 1 ||
    score > 15
  )
    throw new Error("Invalid market app");
  const components = isRecord(v.components)
    ? Object.fromEntries(
        Object.entries(v.components)
          .filter(([, n]) => typeof n === "number" && Number.isFinite(n))
          .slice(0, 8)
          .map(([k, n]) => [k.slice(0, 40), Math.min(1, Math.max(0, n as number))]),
      )
    : {};
  return {
    appId,
    rank,
    title,
    developer: text(v.developer, 120) || "Unknown",
    storeCategory: text(v.storeCategory, 80) || "Unknown",
    genreId: text(v.genreId, 80) || null,
    summary: text(v.summary, 1000),
    rating:
      typeof v.rating === "number" && v.rating >= 0 && v.rating <= 5
        ? v.rating
        : null,
    ratings: count(v.ratings),
    installs: count(v.installs),
    offersIap: v.offersIap === true,
    containsAds: v.containsAds === true,
    price: count(v.price),
    currency: text(v.currency, 8) || null,
    score,
    components,
    recentReviews: count(v.recentReviews),
    storeUrl,
    ...(v.retained === true ? { retained: true } : {}),
  };
}

// Validates a normalized result, both from the local API and from saved workspaces.
export function parseMarketResult(v: unknown): MarketResult {
  if (!isRecord(v) || !Array.isArray(v.apps) || v.apps.length > 20)
    throw new Error("Invalid market result");
  const domain = text(v.domain, 48);
  const status = statuses.find((s) => s === v.status);
  const generatedAt = text(v.generatedAt, 40);
  if (!domain || !status || Number.isNaN(Date.parse(generatedAt)))
    throw new Error("Invalid market result");
  const seen = new Set<string>();
  const apps = v.apps.map(marketApp).filter((a) => {
    const fresh = !seen.has(a.appId);
    seen.add(a.appId);
    return fresh;
  });
  return {
    domain,
    ...(typeof v.scanId === "string" && /^scan-[a-f\d]{64}$/.test(v.scanId) ? { scanId: v.scanId } : {}),
    category: text(v.category, 120) || domain,
    genreId: text(v.genreId, 80) || null,
    queries: Array.isArray(v.queries)
      ? v.queries.map((q) => text(q, 120)).filter(Boolean).slice(0, 8)
      : [],
    country: text(v.country, 8) || "us",
    language: text(v.language, 12) || "en",
    status,
    generatedAt,
    apps,
    warnings: Array.isArray(v.warnings)
      ? v.warnings.map((w) => text(w, 300)).filter(Boolean).slice(0, 6)
      : [],
    candidates: count(v.candidates),
    ranked: count(v.ranked),
    failedRequests: count(v.failedRequests),
    windowDays: count(v.windowDays),
  };
}

// Converts the scanner's own report (snake_case, see the scanner README) at the
// server boundary. Throws when the report does not match its contract.
export function fromScannerReport(
  domain: string,
  report: unknown,
): MarketResult {
  if (!isRecord(report) || !Array.isArray(report.top_five))
    throw new Error("Unexpected scanner report");
  const collection = isRecord(report.collection) ? report.collection : {};
  const window = isRecord(report.observation_window)
    ? report.observation_window
    : {};
  const plan = scanPlan(domain);
  return parseMarketResult({
    domain,
    category: report.category,
    genreId: report.genre_id,
    queries: plan.queries,
    country: report.country,
    language: report.language,
    status: report.status,
    generatedAt: report.generated_at,
    warnings: report.warnings,
    candidates: collection.candidates_discovered,
    ranked: collection.apps_ranked,
    failedRequests: collection.failed_requests,
    windowDays: window.days,
    apps: report.top_five.map((a) => {
      if (!isRecord(a)) throw new Error("Unexpected scanner app");
      return {
        appId: a.app_id,
        rank: a.rank,
        title: a.title,
        developer: a.developer,
        storeCategory: a.category,
        genreId: a.genre_id,
        summary: a.store_summary,
        rating: a.rating,
        ratings: a.ratings,
        installs: a.installs,
        offersIap: a.offers_iap,
        containsAds: a.contains_ads,
        price: a.price,
        currency: a.currency,
        score: a.profitability_proxy_1_15,
        components: a.score_components,
        recentReviews: a.recent_review_sample_count,
        storeUrl: a.store_url,
      };
    }),
  });
}

// Sample features until REA analysis is connected: words in the store listing
// pick matching feature briefs, and the domain's typical features fill the rest.
const keywordFeatures: [RegExp, string][] = [
  [/\b(to-?do|tasks?|checklists?|planner|reminders?|schedule)\b/i, "tasks"],
  [/\b(focus|pomodoro|timers?|concentrat\w*)\b/i, "timer"],
  [/\b(notes?|notepad|memos?|documents?)\b/i, "notes"],
  [/\b(habits?|routines?|streaks?)\b/i, "habits"],
  [/\b(meditat\w*|breath\w*|relax\w*|sleep|calm|mindful\w*)\b/i, "breathing"],
  [/\b(mood|journal\w*|diary|gratitude)\b/i, "journal"],
  [/\b(workouts?|exercises?|gym|training|running|steps?|walking)\b/i, "workouts"],
  [/\b(goals?|targets?|lose weight|challenges?)\b/i, "goals"],
  [/\b(flashcards?|vocabulary|quiz\w*|memori[sz]e|lessons?)\b/i, "flashcards"],
  [/\b(reading|books?|articles?|stories)\b/i, "reading"],
  [/\b(budgets?|budgeting)\b/i, "budget"],
  [/\b(expenses?|spending|bills?|money)\b/i, "expenses"],
  [/\b(boards?|ideas?|sketch\w*|draw\w*|design\w*|canvas)\b/i, "boards"],
  [/\b(bookmarks?|inspiration|collect\w*|identif\w*)\b/i, "bookmarks"],
  [/\b(progress|stats|statistics|insights?|reports?|charts?)\b/i, "insights"],
];
const domainFeatures: Record<string, string[]> = {
  Productivity: ["tasks", "timer", "notes", "habits", "insights"],
  Wellness: ["breathing", "journal", "habits", "insights"],
  Learning: ["flashcards", "goals", "reading", "habits"],
  Finance: ["budget", "expenses", "goals", "insights"],
  Fitness: ["workouts", "goals", "habits", "insights"],
  Creativity: ["boards", "bookmarks", "notes", "journal"],
};
const otherFeatures = ["notes", "tasks", "goals", "bookmarks", "insights"];
export function sampleFeatureIds(domain: string, app: MarketApp) {
  const listing = `${app.title} ${app.summary}`;
  const pool = domainFeatures[domain] || otherFeatures;
  const matched = keywordFeatures
    .filter(([pattern]) => pattern.test(listing))
    .map(([, id]) => id)
    .sort((a, b) => Number(!pool.includes(a)) - Number(!pool.includes(b)));
  // Rotate the fallback pool by rank so listings without keywords still differ.
  const shift = (app.rank - 1) % pool.length;
  const fill = [...pool.slice(shift), ...pool.slice(0, shift)];
  return [...new Set([...matched, ...fill])].slice(0, Math.max(3, Math.min(4, matched.length)));
}

const palette = [
  ["#a85038", "#f8e8df"],
  ["#53745d", "#e9eee4"],
  ["#826342", "#f4eddd"],
  ["#536f87", "#e7edf2"],
  ["#816d97", "#eee8f3"],
];
function colorsFor(domain: string, appId: string) {
  const known = domains.find((d) => d.name === domain);
  if (known) return [known.color, known.bg];
  let hash = 0;
  for (const c of appId) hash = (hash * 31 + c.charCodeAt(0)) >>> 0;
  return palette[hash % palette.length];
}
export function marketReferenceApp(domain: string, app: MarketApp): ReferenceApp {
  const features: Feature[] = sampleFeatureIds(domain, app).map(
    (id) => featureById[id],
  );
  const [color, bg] = colorsFor(domain, app.appId);
  const summary = app.summary || `${app.title} by ${app.developer}.`;
  return {
    id: app.appId,
    name: app.title,
    domain,
    tagline: summary,
    description: summary,
    icon: features[0].icon,
    color,
    bg,
    label: app.retained
      ? "Selected from an earlier scan"
      : `#${app.rank} on Google Play`,
    features,
    market: app,
  };
}

// The catalog for chosen domains: live market apps where a scan returned apps,
// otherwise the curated sample apps. Sample apps that already have selected
// features stay visible so a finished scan never silently drops a choice.
export function buildCatalog(
  chosen: string[],
  market: Record<string, MarketResult> | undefined,
  selected: Record<string, unknown>,
): ReferenceApp[] {
  const seen = new Map<string, ReferenceApp>();
  const result: ReferenceApp[] = [];
  for (const domain of chosen) {
    const live = market?.[domain]?.apps || [];
    const samples = sampleApps.filter(
      (a) =>
        a.domain === domain &&
        (!live.length ||
          (Array.isArray(selected[a.id]) &&
            (selected[a.id] as unknown[]).length > 0)),
    );
    for (const app of [
      ...live.map((a) => marketReferenceApp(domain, a)),
      ...samples,
    ])
      if (!seen.has(app.id)) {
        seen.set(app.id, app);
        result.push(app);
      } else {
        // An app ranked in two domains is listed once, under the first, and
        // still appears when filtering by the other.
        const first = seen.get(app.id)!;
        if (first.market && first.domain !== domain)
          first.alsoIn = [...(first.alsoIn || []), domain];
      }
  }
  return result;
}
export function inDomain(
  app: { domain: string; alsoIn?: string[] },
  domain: string,
) {
  return app.domain === domain || !!app.alsoIn?.includes(domain);
}

export function formatInstalls(n: number) {
  const units: [number, string][] = [
    [1e9, "B"],
    [1e6, "M"],
    [1e3, "K"],
  ];
  for (const [size, unit] of units)
    if (n >= size) return `${Math.floor(n / size)}${unit}+`;
  return String(Math.floor(n));
}
export function monetization(app: MarketApp) {
  const parts = [
    app.price > 0 ? `Paid ${app.currency || ""} ${app.price}`.trim() : "Free",
  ];
  if (app.offersIap) parts.push("in-app purchases");
  if (app.containsAds) parts.push("ads");
  return parts.join(" · ");
}
export function evidenceLine(app: MarketApp, result?: MarketResult) {
  return `#${app.rank} in ${result?.domain || "its domain"} on Google Play · opportunity ${app.score}/15 · ${app.rating === null ? "no rating" : `rating ${app.rating.toFixed(1)} (${app.ratings.toLocaleString("en-US")} ratings)`} · ${formatInstalls(app.installs)} installs · ${monetization(app)}${result ? ` · scanned ${result.generatedAt.slice(0, 10)}` : ""} · ${app.storeUrl}`;
}
