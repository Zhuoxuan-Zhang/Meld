import JSZip from "jszip";
import { evidenceLine } from "./market";
import { catalogById, mergedFeatures, selectedApps } from "./state";
import type { Draft } from "./state";
import runtime from "./demo-runtime.js?raw";
import demoCss from "./demo.css?raw";

// Market evidence for the given source apps, one line per live app.
function marketEvidence(d: Draft, apps: ReturnType<typeof selectedApps>) {
  const live = apps.filter((a) => a.market);
  if (!live.length) return "";
  const listed = (a: (typeof live)[number]) => {
    const f = a.market!.listedFeatures;
    return f?.items.length
      ? `\n  - In the store listing (summarized by Claude Code, ${f.model}, prompt ${f.template}): ${f.items.map((x) => x.name).join("; ")}`
      : "";
  };
  return `## Market evidence\nPublic Google Play signals from the local market scanner. The 1–15 opportunity score is a proxy, not measured revenue. Store-listing features are what each developer describes, not verified analysis.\n\n${live.map((a) => `- ${a.name} (${a.market!.appId}): ${evidenceLine(a.market!, d.market?.[a.domain])}${listed(a)}`).join("\n")}\n\n`;
}
export function designDoc(d: Draft, appId?: string) {
  const appById = catalogById(d);
  const app = appId ? appById[appId] : undefined;
  const sources = app ? [app] : selectedApps(d);
  const live = sources.some((a) => a.market);
  const features = app
    ? app.features
        .filter((f) => d.selected[app.id]?.includes(f.id))
        .map((f) => ({ ...f, sources: [app.name] }))
    : mergedFeatures(d);
  return `# ${app ? app.name + " — feature brief" : (d.name.trim() || "Untitled app") + " — combined design"}\n\n> Demo specification. ${live ? "Reference apps include live Google Play market signals. Their features are summarized by Claude Code from each store listing, or are sample features matched to the listing where no summary exists" : "Reference features are curated examples"}, not results of live REA analysis.\n\n## Purpose\n${d.description.trim() || "Bring the selected features together in one simple personal app."}\n\n## Intended users\n${d.audience.trim() || "Personal use"}\n\n## Domains\n${d.domains.join(", ")}\n\n${marketEvidence(d, sources)}## Visual direction\n${{ warm: "Warm cream, coral accents, clear cards and generous spacing.", sage: "Soft green accents, a calm neutral background, and simple controls.", ink: "Deep blue accents, a crisp white surface, and clear type." }[d.style]}\n\n## Selected features\n${features.map((f) => (f.listed ? `### ${f.name}\n${f.description}\n\nReference: ${f.sources.join(", ")} (Google Play store listing, summarized by Claude Code)\n\nUser journey: to be designed. The listing says what the feature offers, not how it works, and the browser demo does not build it.\n` : `### ${f.name}\n${f.description}\n\nReference: ${f.sources.join(", ")}\n\nUser journey: ${f.flow}\n\nAcceptance: the user can complete this journey, see an empty state, and correct invalid input.\n`)).join("\n")}\n${!app && d.plan ? `## Combined app concept\n${d.plan.summary}\n\nSource: ${d.plan.source === "ai" ? "AI suggestion via OpenRouter" : "Curated example plan"}\n\n### How the features fit together\n${d.plan.features.map((f) => `- ${appById[f.appId]?.features.find((x) => x.id === f.featureId)?.name || f.featureId}: ${f.reason}`).join("\n")}\n\n### Shared user journey\n${d.plan.journey.map((step, i) => `${i + 1}. ${step}`).join("\n")}\n\n` : ""}## Combination rules\n- Repeated features become one shared feature; keep all source references.\n- Use one navigation system and one visual style.\n- Preserve user input and give clear feedback for actions.\n\n## Implementation boundary\nThis demo uses a local browser template. A future coding agent can use this specification to create a Kotlin/Compose project. REA, autonomous coding, Android compilation, authentication, and cloud sync are not connected. AI feature planning is a separate optional OpenRouter integration; an AI plan is a design proposal, not evidence of a generated implementation.\n`;
}
export function readme(d: Draft) {
  return `# ${d.name}\n\nAn interactive browser demo assembled with Meld.\n\n## Open the app\nUnzip the download, then double-click index.html in a modern browser. No install or internet connection is needed for the demo.\n\n## Your idea\n${d.description.trim() || "A personal app that brings your favorite features together."}\n\nFor: ${d.audience.trim() || "Personal use"}\n\n## Included features\n${mergedFeatures(
    d,
  )
    .map(
      (f) =>
        `- ${f.name} (inspired by ${f.sources.join(", ")}${f.listed ? "; from the store listing, described in DESIGN.md but not built in this demo" : ""})`,
    )
    .join(
      "\n",
    )}\n\n## Files\n- index.html — self-contained, interactive browser app\n- README.md — these instructions\n- DESIGN.md — combined design specification\n- designs/ — one approved feature brief per reference app\n- project.json — your selections and app settings\n\n## What is real in this demo\nFeature selection, combined specifications, downloads, and the browser controls work. Data is saved in this browser when local storage is available. Storage for file URLs can vary by browser.\n\n## What is simulated\n${selectedApps(d).some((a) => a.market) ? "Reference apps and their market signals come from a live Google Play scan. Features from a store listing are what the developer describes, summarized by Claude Code, not analysis of those apps; this demo does not build them. Other features are sample features." : "The app catalog and feature analysis are fixed examples."} The output comes from a template, not a live coding agent. This is not an Android APK. Live REA analysis and Kotlin/Compose builds are future integrations. The flashcards use a simple next-card cycle, not a spaced-repetition algorithm. The focus garden includes a manual log action for trying the demo.\n\n## Data\nEntries stay in this browser. Nothing is uploaded. Timers run while this page is open. Export or copy anything important before clearing browser storage.\n`;
}
export function demoHtml(d: Draft) {
  const config = {
    name: d.name,
    style: d.style,
    description: d.description,
    features: mergedFeatures(d),
  };
  const safe = (s: string) =>
    s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${safe(d.name)} · Meld demo</title><style>${demoCss}</style></head><body class="${d.style}"><div id="demo-root"></div><script id="demo-config" type="application/json">${JSON.stringify(config).replace(/</g, "\\u003c")}</script><script>${runtime.replace(/<\/script/gi, "<\\/script")}</script></body></html>`;
}
export function saveFile(
  content: Blob | string,
  filename: string,
  type = "text/plain",
) {
  const blob =
    typeof content === "string" ? new Blob([content], { type }) : content;
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
export function slug(d: Draft) {
  return (
    d.name
      .normalize("NFKD")
      .replace(/[^a-zA-Z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .toLowerCase()
      .slice(0, 70) || "my-meld-app"
  );
}
export async function downloadProject(d: Draft) {
  const zip = new JSZip();
  zip.file("index.html", demoHtml(d));
  zip.file("README.md", readme(d));
  zip.file("DESIGN.md", designDoc(d));
  zip.file("project.json", JSON.stringify(d, null, 2));
  selectedApps(d).forEach((a) =>
    zip.file(`designs/${a.id}.md`, designDoc(d, a.id)),
  );
  saveFile(await zip.generateAsync({ type: "blob" }), `${slug(d)}-demo.zip`);
}
