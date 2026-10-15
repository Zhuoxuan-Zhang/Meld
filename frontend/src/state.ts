import { parseIntent } from "./intent";
import type { Intent } from "./intent";
import { fitsFilter } from "./feasibility";
import type { ComplexityFilter } from "./feasibility";
import { canonicalDomain } from "./data";
import { buildCatalog, parseMarketResult, referenceFit } from "./market";
import type { ListedFeatures, MarketApp, MarketResult } from "./market";
export type Style = "warm" | "sage" | "ink";
export type Draft = {
  version: 1;
  workspaceId?: string;
  complexity?: ComplexityFilter;
  discoveryStarted?: boolean;
  discoverySource?: "idea" | "domains";
  customFeatures?: { id: string; name: string; description: string }[];
  intent?: Intent;
  projectId?: string;
  designId?: string;
  designJobId?: string;
  designProposalId?: string;
  domains: string[];
  selected: Record<string, string[]>;
  name: string;
  audience: string;
  description: string;
  style: Style;
  built: boolean;
  goal: string;
  // Latest market-signal scan per domain.
  market?: Record<string, MarketResult>;
};
export const storageKey = "meld.workspace.v1";
export const emptyDraft = (): Draft => ({
  version: 1,
  workspaceId: crypto.randomUUID(),
  domains: [],
  selected: {},
  name: "",
  audience: "",
  description: "",
  style: "warm",
  built: false,
  goal: "",
});

// A domain search and a confirmed idea use different queries. Keep the chat,
// but never reuse one route's results or selections for the other route.
export function startDiscovery(d: Draft, source: "idea" | "domains"): Draft {
  const plan = d.intent?.approved ? d.intent.reply?.plan : undefined;
  if (source === "idea" && !plan) return d;
  const domains = source === "idea" ? plan!.topics.map(t => t.domain) : d.domains;
  if (!domains.length || domains.length > 2) return d;
  const previous = d.discoverySource || (d.intent?.approved ? "idea" : "domains");
  const changed = previous !== source || JSON.stringify(domains) !== JSON.stringify(d.domains);
  const brief = source === "idea"
    ? { goal: plan!.summary, description: plan!.summary, audience: plan!.audience }
    : plan ? {
      goal: d.goal === plan.summary ? "" : d.goal,
      description: d.description === plan.summary ? "" : d.description,
      audience: d.audience === plan.audience ? "" : d.audience,
    } : {};
  return { ...d, ...brief, domains, discoverySource: source, discoveryStarted: true,
    ...(changed ? { market: {}, selected: {}, customFeatures: [] } : {}),
  };
}
export function catalog(d: Pick<Draft, "domains" | "market" | "selected" | "complexity">) {
  return buildCatalog(d.domains, d.market).filter((app) => {
    const fit = referenceFit(app);
    return fitsFilter(fit, d.complexity) || (fit.level !== "complex" && !!d.selected[app.id]?.length);
  });
}
export function catalogById(d: Pick<Draft, "domains" | "market" | "selected" | "complexity">) {
  return Object.fromEntries(catalog(d).map((a) => [a.id, a]));
}
export function loadDraft(): Draft {
  try {
    const raw = JSON.parse(localStorage.getItem(storageKey) || "null");
    if (!raw || raw.version !== 1) return emptyDraft();
    const d = emptyDraft();
    if (typeof raw.workspaceId === "string" && /^[a-f\d-]{36}$/.test(raw.workspaceId)) d.workspaceId = raw.workspaceId;
    d.intent = parseIntent(raw.intent);
    d.discoveryStarted = raw.discoveryStarted === true;
    d.discoverySource = raw.discoverySource === "domains" ? "domains" : raw.discoverySource === "idea" ? "idea" : d.intent?.approved ? "idea" : "domains";
    if (Array.isArray(raw.customFeatures)) d.customFeatures = raw.customFeatures.filter((f: unknown): f is NonNullable<Draft['customFeatures']>[number] => {
      if (!f || typeof f !== 'object') return false;
      const value = f as Record<string, unknown>;
      return typeof value.id === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,239}$/.test(value.id) && typeof value.name === 'string' && value.name.length <= 120 && typeof value.description === 'string' && value.description.length <= 1000;
    }).slice(0, 20);
    if (typeof raw.projectId === "string" && /^project-[a-f\d-]{36}$/.test(raw.projectId)) d.projectId = raw.projectId;
    d.complexity = raw.complexity === "review" ? "review" : "simple";
    for (const key of ["designId", "designJobId", "designProposalId"] as const)
      if (typeof raw[key] === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/.test(raw[key])) d[key] = raw[key];
    d.domains = Array.isArray(raw.domains)
      ? [
          ...new Set<string>(
            raw.domains
              .filter(
                (v: unknown) =>
                  typeof v === "string" && v.trim() && v.trim().length <= 48,
              )
              .map(canonicalDomain),
          ),
        ].slice(0, 8)
      : [];
    const market: Record<string, MarketResult> = {};
    for (const domain of d.domains) {
      try {
        if (raw.market?.[domain])
          market[domain] = parseMarketResult(raw.market[domain]);
      } catch {
        /* A damaged scan is rescanned; it must not discard other work. */
      }
    }
    if (Object.keys(market).length) d.market = market;
    // Resume older discovery drafts in the current studio, never in demo pages.
    if (!Object.hasOwn(raw, "discoveryStarted")) d.discoveryStarted = Boolean(d.intent?.approved || d.market);

    const rawSelected =
      raw.selected && typeof raw.selected === "object" ? raw.selected : {};
    d.selected = Object.fromEntries(
      catalog({ ...d, selected: rawSelected })
        .filter((a) => Array.isArray(rawSelected[a.id]))
        .map((a) => [
          a.id,
          [
            ...new Set<string>(
              rawSelected[a.id].filter((f: unknown) =>
                a.features.some((x) => x.id === f),
              ),
            ),
          ],
        ]),
    );
    for (const key of ["name", "audience", "description", "goal"] as const)
      if (typeof raw[key] === "string")
        d[key] = raw[key].slice(0, key === "name" ? 60 : 600);
    if (["warm", "sage", "ink"].includes(raw.style)) d.style = raw.style;
    d.built =
      raw.built === true &&
      Object.values(d.selected).some((v) => v.length) &&
      !!d.name.trim();
    return d;
  } catch {
    return emptyDraft();
  }
}
// Stores a finished scan. Apps from the previous scan that still carry
// selections are kept.
// Features already summarized are reused when the listing is unchanged, or
// when the user chose some of them.
export function withMarketResult(
  d: Draft,
  domain: string,
  result: MarketResult,
): Draft {
  if (!d.domains.includes(domain)) return d;
  const summarized = new Map<string, MarketApp>();
  for (const r of Object.values(d.market || {}))
    for (const a of r.apps) if (a.listedFeatures) summarized.set(a.appId, a);
  result = {
    ...result,
    apps: result.apps.map((a) => {
      const known = summarized.get(a.appId);
      const chosen = d.selected[a.appId]?.some((id) =>
        id.startsWith(a.appId + ":"),
      );
      return known &&
        !a.listedFeatures &&
        (known.description === a.description || chosen)
        ? { ...a, listedFeatures: known.listedFeatures }
        : a;
    }),
  };
  const kept = (d.market?.[domain]?.apps || [])
    .filter(
      (a) =>
        d.selected[a.appId]?.length &&
        !result.apps.some((b) => b.appId === a.appId),
    )
    .map((a) => ({ ...a, retained: true }));
  return {
    ...d,
    market: {
      ...d.market,
      [domain]: { ...result, apps: [...result.apps, ...kept] },
    },
  };
}
// Adds completed summaries to every saved copy of those apps and removes
// obsolete choices. No keyword or template features fill missing summaries.
export function withListedFeatures(
  d: Draft,
  features: Record<string, ListedFeatures>,
): Draft {
  if (!d.market) return d;
  let changed = false;
  const market = Object.fromEntries(
    Object.entries(d.market).map(([domain, r]) => [
      domain,
      {
        ...r,
        apps: r.apps.map((a) => {
          const f = features[a.appId];
          if (!f || a.listedFeatures) return a;
          changed = true;
          return { ...a, listedFeatures: f };
        }),
      },
    ]),
  );
  if (!changed) return d;
  const next = { ...d, market, selected: { ...d.selected } };
  const nextApps = catalogById(next);
  for (const id of Object.keys(features)) {
    // Drop legacy guesses; only choices present in a completed summary survive.
    if (next.selected[id]) next.selected[id] = next.selected[id].filter(featureId => nextApps[id]?.features.some(f => f.id === featureId));
  }
  return next;
}
export function selectedApps(d: Draft) {
  return catalog(d).filter((a) => a.features.some(f => d.selected[a.id]?.includes(f.id)));
}
