import { apps as sampleApps } from "./data";
import { inDomain } from "./market";

export type Suggestion = {
  name: string;
  summary: string;
  audience: string;
  features: { appId: string; featureId: string; reason: string }[];
  journey: string[];
  source: "ai" | "example";
  model?: string;
};
// The part of a catalog app that a plan refers to.
export type CatalogApp = {
  id: string;
  name: string;
  domain: string;
  features: { id: string; name: string; description: string }[];
  alsoIn?: string[];
};

export function validateSuggestion(
  value: unknown,
  domains: string[],
  catalog: CatalogApp[] = sampleApps,
): Suggestion {
  if (!value || typeof value !== "object")
    throw new Error("Invalid suggestion");
  const p = value as Suggestion;
  const text = (v: unknown, max: number): v is string =>
    typeof v === "string" && !!v.trim() && v.length <= max;
  if (
    !text(p.name, 60) ||
    !text(p.summary, 600) ||
    !text(p.audience, 600) ||
    !Array.isArray(p.features) ||
    p.features.length < 3 ||
    p.features.length > 6 ||
    !Array.isArray(p.journey) ||
    p.journey.length < 3 ||
    p.journey.length > 5 ||
    p.journey.some((s) => !text(s, 350))
  )
    throw new Error("Invalid suggestion");
  const ids = new Set<string>();
  const features = p.features.map((f) => {
    const app = f && catalog.find((a) => a.id === f.appId);
    if (
      !app ||
      !domains.includes(app.domain) ||
      !app.features.some((x) => x.id === f.featureId) ||
      ids.has(f.featureId) ||
      !text(f.reason, 280)
    )
      throw new Error("Invalid feature suggestion");
    ids.add(f.featureId);
    return { appId: app.id, featureId: f.featureId, reason: f.reason.trim() };
  });
  if (new Set(features.map((f) => f.appId)).size < 2)
    throw new Error("A combination needs at least two apps");
  return {
    name: p.name.trim(),
    summary: p.summary.trim(),
    audience: p.audience.trim(),
    features,
    journey: p.journey.map((s) => s.trim()),
    source: p.source === "ai" ? "ai" : "example",
    ...(text(p.model, 120) ? { model: p.model } : {}),
  };
}

export function suggestionSelection(
  plan: Suggestion,
): Record<string, string[]> {
  const selected: Record<string, string[]> = {};
  for (const f of plan.features) (selected[f.appId] ||= []).push(f.featureId);
  return selected;
}

export function selectionMatches(
  plan: Suggestion,
  selected: Record<string, string[]>,
) {
  const entries = Object.entries(selected)
    .flatMap(([a, ids]) => ids.map((id) => a + ":" + id))
    .sort();
  return (
    JSON.stringify(entries) ===
    JSON.stringify(plan.features.map((f) => f.appId + ":" + f.featureId).sort())
  );
}

// Clearly labeled examples keep the walkthrough usable without a model connection.
export function exampleSuggestion(
  domains: string[],
  catalog: CatalogApp[] = sampleApps,
): Suggestion | null {
  const first = domains.find((d) => catalog.some((a) => inDomain(a, d)));
  const examples: Record<
    string,
    {
      name: string;
      summary: string;
      picks: [string, string][];
      journey: string[];
    }
  > = {
    Productivity: {
      name: "Focus & Flow",
      summary:
        "A simple daily workspace that turns a task list into focused work and a short reflection.",
      picks: [
        ["ticktick", "tasks"],
        ["forest", "timer"],
        ["notion", "notes"],
      ],
      journey: [
        "Choose one task to work on today.",
        "Start a focus session for that task.",
        "Save a short note about what you learned before moving on.",
      ],
    },
    Wellness: {
      name: "A Quiet Moment",
      summary:
        "A daily check-in that connects a breathing pause with a journal and a view of your patterns.",
      picks: [
        ["headspace", "breathing"],
        ["daylio", "journal"],
        ["daylio", "insights"],
      ],
      journey: [
        "Take a short breathing pause.",
        "Write how you feel and what shaped your day.",
        "Review your patterns over time.",
      ],
    },
    Learning: {
      name: "Learn a Little",
      summary:
        "Turn saved reading into focused learning sessions and a personal set of review cards.",
      picks: [
        ["readwise", "reading"],
        ["anki", "flashcards"],
        ["duolingo", "goals"],
      ],
      journey: [
        "Pick one item from your reading list.",
        "Turn its key ideas into review cards.",
        "Review the cards and check progress toward your learning goal.",
      ],
    },
    Finance: {
      name: "Money in View",
      summary:
        "Track everyday spending alongside a monthly budget and one clear savings goal.",
      picks: [
        ["ynab", "budget"],
        ["spendee", "expenses"],
        ["moneylover", "goals"],
      ],
      journey: [
        "Set a monthly budget and a savings goal.",
        "Log each expense in the same workspace.",
        "Compare spending with the budget and update your goal.",
      ],
    },
    Fitness: {
      name: "Keep Moving",
      summary:
        "Build a steady exercise routine with a workout log, small habits, and an achievable goal.",
      picks: [
        ["strong", "workouts"],
        ["habitica", "habits"],
        ["strava", "goals"],
      ],
      journey: [
        "Choose a fitness goal and a small daily habit.",
        "Log a workout after each session.",
        "Check off the habit and review your progress.",
      ],
    },
    Creativity: {
      name: "Idea to Page",
      summary:
        "Bring visual ideas, saved references, and working notes into one creative workspace.",
      picks: [
        ["pinterest", "boards"],
        ["milanote", "notes"],
        ["dayone", "journal"],
      ],
      journey: [
        "Collect references on an inspiration board.",
        "Develop the idea in a working note.",
        "Record your creative progress in a journal.",
      ],
    },
  };
  if (!first) return null;
  const shownHere = catalog.filter((a) => inDomain(a, first));
  const e = examples[first];
  // Map each example pick onto the shown catalog: the named sample app when it
  // is shown, otherwise a shown app with that feature, preferring unused apps.
  const used = new Set<string>();
  const picks = e?.picks.map(([appId, featureId]) => {
    const has = (a: CatalogApp) => a.features.some((f) => f.id === featureId);
    const app =
      shownHere.find((a) => a.id === appId && has(a)) ||
      shownHere.find((a) => has(a) && !used.has(a.id)) ||
      shownHere.find(has);
    if (app) used.add(app.id);
    return app && ([app, featureId] as const);
  });
  const mapped =
    picks?.every(Boolean) && used.size >= 2
      ? (picks as (readonly [CatalogApp, string])[])
      : genericPicks(shownHere, catalog);
  if (!mapped) return null;
  const name = (app: CatalogApp, featureId: string) =>
    app.features.find((f) => f.id === featureId)!.name.toLowerCase();
  const generic = mapped !== picks;
  return validateSuggestion(
    {
      name: !generic && e ? e.name : `${first} Essentials`.slice(0, 60),
      summary:
        !generic && e
          ? e.summary
          : `One focused app that combines ${mapped.map(([a, f]) => name(a, f)).join(", ")} from leading ${first} apps.`,
      journey:
        !generic && e
          ? e.journey
          : mapped.map(
              ([a, f], i) =>
                `${["Start with", "Continue with", "Finish with"][i] || "Use"} ${name(a, f)}, inspired by ${a.name}.`,
            ),
      audience: "People who want a simpler daily routine",
      source: "example",
      features: mapped.map(([app, featureId]) => ({
        appId: app.id,
        featureId,
        reason: `Use ${name(app, featureId)} as part of one shared daily routine.`,
      })),
    },
    domains,
    catalog,
  );
}
// Three different features from at least two apps, taking one from each app in turn.
function genericPicks(inDomain: CatalogApp[], catalog: CatalogApp[]) {
  const pool = inDomain.length > 1 ? inDomain : catalog;
  const picks: (readonly [CatalogApp, string])[] = [];
  for (let round = 0; round < 8 && picks.length < 3; round++)
    for (const app of pool) {
      const feature = app.features.find(
        (f) => !picks.some(([, id]) => id === f.id),
      );
      if (feature && picks.filter(([a]) => a.id === app.id).length === round)
        picks.push([app, feature.id]);
      if (picks.length === 3) break;
    }
  return picks.length === 3 && new Set(picks.map(([a]) => a.id)).size >= 2
    ? picks
    : null;
}
