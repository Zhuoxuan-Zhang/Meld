import type { ReferenceApp } from "./data";
import type { SearchPlan } from "./intent";

const normalize = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
export function featureMatches(app: ReferenceApp, plan?: SearchPlan | null) {
  if (!plan || !app.market) return [];
  const listing = ` ${normalize(`${app.name} ${app.market.summary} ${app.market.description || ""}`)} `;
  return plan.features.filter(f => f.terms.some(term => {
    const words = normalize(term);
    return words.length >= 2 && listing.includes(` ${words} `);
  })).map(f => f.name);
}
export function rankForIntent(apps: ReferenceApp[], plan?: SearchPlan | null) {
  if (!plan) return apps;
  return [...apps].sort((a, b) => featureMatches(b, plan).length - featureMatches(a, plan).length || (b.market?.score || 0) - (a.market?.score || 0));
}
