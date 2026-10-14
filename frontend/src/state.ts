import { canonicalDomain } from "./data";
import { buildCatalog, parseMarketResult } from "./market";
import type { ListedFeatures, MarketApp, MarketResult } from "./market";
import { validateSuggestion, selectionMatches } from "./suggestions";
import type { Suggestion } from "./suggestions";
export type Style = "warm" | "sage" | "ink";
export type Draft = {
  version: 1;
  domains: string[];
  selected: Record<string, string[]>;
  name: string;
  audience: string;
  description: string;
  style: Style;
  built: boolean;
  goal: string;
  suggestion?: Suggestion;
  plan?: Suggestion;
  // Latest market-signal scan per domain.
  market?: Record<string, MarketResult>;
};
export const storageKey = "meld.workspace.v1";
export const emptyDraft = (): Draft => ({
  version: 1,
  domains: [],
  selected: {},
  name: "",
  audience: "",
  description: "",
  style: "warm",
  built: false,
  goal: "",
});
export function catalog(d: Pick<Draft, "domains" | "market" | "selected">) {
  return buildCatalog(d.domains, d.market, d.selected);
}
export function catalogById(d: Pick<Draft, "domains" | "market" | "selected">) {
  return Object.fromEntries(catalog(d).map((a) => [a.id, a]));
}
export function loadDraft(): Draft {
  try {
    const raw = JSON.parse(localStorage.getItem(storageKey) || "null");
    if (!raw || raw.version !== 1) return emptyDraft();
    const d = emptyDraft();
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
    const rawSelected =
      raw.selected && typeof raw.selected === "object" ? raw.selected : {};
    d.selected = Object.fromEntries(
      buildCatalog(d.domains, d.market, rawSelected)
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
    for (const key of ["suggestion", "plan"] as const) {
      try {
        const plan = validateSuggestion(raw[key], d.domains, catalog(d));
        if (key === "suggestion" || selectionMatches(plan, d.selected))
          d[key] = plan;
      } catch {
        /* An invalid saved plan must not discard the user's other work. */
      }
    }
    d.built =
      raw.built === true &&
      Object.values(d.selected).some((v) => v.length) &&
      !!d.name.trim();
    return d;
  } catch {
    return emptyDraft();
  }
}
// Drops a suggestion or applied plan that no longer fits the catalog.
function withValidPlans(d: Draft): Draft {
  const apps = catalog(d);
  for (const key of ["suggestion", "plan"] as const) {
    try {
      if (d[key]) validateSuggestion(d[key], d.domains, apps);
    } catch {
      d[key] = undefined;
    }
  }
  return d;
}
// Stores a finished scan. Apps from the previous scan that still carry
// selections are kept, and plans that no longer fit the catalog are dropped.
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
  return withValidPlans({
    ...d,
    market: {
      ...d.market,
      [domain]: { ...result, apps: [...result.apps, ...kept] },
    },
  });
}
// Adds summarized features to every saved copy of those apps. They replace
// the apps' sample features, so plans built on those are dropped.
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
  return changed ? withValidPlans({ ...d, market }) : d;
}
export function selectedApps(d: Draft) {
  return catalog(d).filter((a) => (d.selected[a.id]?.length || 0) > 0);
}
export function mergedFeatures(d: Draft) {
  const result = new Map<
    string,
    {
      id: string;
      name: string;
      description: string;
      icon: string;
      flow: string;
      listed?: boolean;
      sources: string[];
    }
  >();
  const byId = catalogById(d);
  for (const [id, ids] of Object.entries(d.selected)) {
    const app = byId[id];
    if (!app) continue;
    for (const feature of app.features.filter((f) => ids.includes(f.id))) {
      const existing = result.get(feature.id);
      if (existing) existing.sources.push(app.name);
      else result.set(feature.id, { ...feature, sources: [app.name] });
    }
  }
  return [...result.values()];
}
