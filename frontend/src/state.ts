import { canonicalDomain } from "./data";
import { buildCatalog, parseMarketResult } from "./market";
import type { MarketResult } from "./market";
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
  designId?: string;
  designJobId?: string;
  designProposalId?: string;
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
    if (typeof raw.designId === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/.test(raw.designId)) d.designId = raw.designId;
    if (typeof raw.designJobId === "string" && /^(job|pipeline)-[a-f\d-]{36}$/.test(raw.designJobId)) d.designJobId = raw.designJobId;
    if (typeof raw.designProposalId === "string" && /^change-[a-f\d-]{36}$/.test(raw.designProposalId)) d.designProposalId = raw.designProposalId;
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
// Stores a finished scan. Apps from the previous scan that still carry
// selections are kept, and plans that no longer fit the catalog are dropped.
export function withMarketResult(
  d: Draft,
  domain: string,
  result: MarketResult,
): Draft {
  if (!d.domains.includes(domain)) return d;
  const kept = (d.market?.[domain]?.apps || [])
    .filter(
      (a) =>
        d.selected[a.appId]?.length &&
        !result.apps.some((b) => b.appId === a.appId),
    )
    .map((a) => ({ ...a, retained: true }));
  const next: Draft = {
    ...d,
    market: {
      ...d.market,
      [domain]: { ...result, apps: [...result.apps, ...kept] },
    },
  };
  const apps = catalog(next);
  for (const key of ["suggestion", "plan"] as const) {
    try {
      if (next[key]) validateSuggestion(next[key], next.domains, apps);
    } catch {
      next[key] = undefined;
    }
  }
  return next;
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
