// A conservative listing screen, not proof of a successful reconstruction.
// Keep this policy shared by the catalog and design handoff.
export const fitPolicy = "local-workflows-v3";
// A domain must match its own workflow; mentioning a timer must not qualify
// an unrelated app for a reading-list or flashcard scan.
const domainKeywords: Record<string, RegExp> = {
  "Notes & lists": /\b(notes?|notepad|notebook|memos?|to[ -]?do|tasks?|checklists?|shopping list)\b/i,
  "Focus & habits": /\b(pomodoro|focus|countdown|timers?|habits?|routines?|streaks?)\b/i,
  "Journals & diaries": /\b(journals?|journaling|diary|diaries|mood)\b/i,
  Flashcards: /\bflash[ -]?cards?\b/i,
  "Reading lists": /\b(reading (?:lists?|logs?|trackers?|journals?|records?)|books? (?:trackers?|logs?|lists?|catalog(?:ue)?s?)|track (?:your )?(?:books|reading)|tbr|bookshel(?:f|ves))\b/i,
  "Counters & tallies": /\b(tally|tallies|counters?)\b/i,
};
export const recommendedDomains = Object.keys(domainKeywords);
export type ComplexityFilter = "simple" | "review";
export type AppFit = {
  level: "simple" | "review" | "complex";
  reason: string;
  scope: string[];
  excluded: string[];
};
export const reaSources = [
  { title: "Notes: trace a CSV export", url: "https://rea.tools/guides/javascript/" },
  { title: "Notes: observe browser behavior", url: "https://rea.tools/guides/browser/" },
  { title: "Aegis: inspect a calculation in an APK", url: "https://rea.tools/showcase/aegis/" },
];
const localFeatures: [RegExp, string][] = [
  [/\b(notes?|notepad|notebook|memos?)\b/i, "Create, edit and find local notes"],
  [/\b(to[ -]?do|tasks?|checklists?|shopping list)\b/i, "Add and complete list items"],
  [/\b(pomodoro|focus|countdown|timers?)\b/i, "Start, pause and reset a timer"],
  [/\b(habits?|routines?|streaks?)\b/i, "Daily check-ins and a local history"],
  [domainKeywords["Journals & diaries"], "Save and review personal entries"],
  [domainKeywords.Flashcards, "Create and review local cards"],
  [domainKeywords["Reading lists"], "Keep a book list and mark reading progress"],
  [domainKeywords["Counters & tallies"], "Tap to adjust a count and save local tallies"],
];
const blockers: [RegExp, string][] = [
  [/\b(ai|artificial intelligence|chatgpt|generative|language model|handwriting recognition|ocr|speech recognition)\b/i, "AI service"],
  [/\b(collaborat\w*|team workspace|real[ -]time sharing|multiplayer|social network|video calls?|messaging platform|shared (?:journals?|journaling|diary|diaries)|social (?:reading|book tracker)|book clubs?)\b/i, "Shared or real-time service"],
  [/\b(bank sync|bank account|banking|trading|crypto|payments?|money transfer)\b/i, "Financial service"],
  [/\b(streaming|video editor|photo editor|3d|augmented reality|video courses?|content library|meditation library)\b/i, "Media library or advanced rendering"],
  [/\b(wear os|apple watch|smartwatch|bluetooth|gps tracking|health connect|medical|diagnos\w*)\b/i, "Hardware or health integration"],
  [/\b(e[ -]?book readers?|epub|pdf reader|read e[ -]?books?|listen to audiobooks?|online library|book recommendations?|personalized recommendations|shared (?:flashcards?|decks?))\b/i, "Reading service, content library or shared decks"],
  [/\b(pedometers?|step counters?|calorie counters?|object detection|auto(?:matic)?[ -](?:counting|tally)|camera counting|count(?:ing)? (?:things|objects) in photos|auto[ -]?clickers?|nfc|webhooks?|inventory management|point of sale)\b/i, "Sensor, automated counting or business system"],
];
export function assessFit(app: { title: string; summary: string; description?: string }, domain = ""): AppFit {
  const text = `${app.title} ${app.summary} ${app.description || ""}`;
  // Do not mistake an explicit absence ("no account required") for a dependency.
  const positive = text.replace(/\b(?:no|without)\s+(?:an?\s+)?(?:ai|ads?|accounts?|sign[ -]?in|registration|cloud sync|internet)(?:\s+(?:required|needed))?\b/gi, "");
  const scope = localFeatures.filter(([pattern]) => pattern.test(`${app.title} ${app.summary}`)).map(([, label]) => label);
  const excluded = ["Accounts and cloud sync", "Payments and ads", "Team or social features"];
  const hard = blockers.filter(([pattern]) => pattern.test(positive)).map(([, reason]) => reason);
  if (/\b(notion|evernote|asana|clickup|monday\.com|duolingo|headspace|calm|canva|strava|myfitnesspal|revolut|trello|quizlet|kahoot|ankidroid|goodreads|storygraph|kindle|libby)\b/i.test(app.title)) hard.push("Broad product scope");
  if (hard.length) return { level: "complex", reason: hard.join(" · "), scope, excluded };
  const relevant = domainKeywords[domain]?.test(`${app.title} ${app.summary}`) ?? scope.length > 0;
  if (!relevant || !scope.length) return { level: "review", reason: domainKeywords[domain]
    ? "The listing does not establish a small workflow in this domain."
    : "No simple-workflow rule matches this listing. Its scope needs review.", scope, excluded };
  if (domain === "Flashcards" && !/\b(create|make|add|edit|import)(?:\W+\w+){0,6}\W+(?:flash[ -]?cards?|cards?|decks?|sets?|lists?)\b|\b(?:your|my|own|custom)\s+(?:flash[ -]?cards?|cards?|decks?|sets?)\b/i.test(text))
    return { level: "review", reason: "Check whether users can make their own cards instead of relying on a fixed course or deck library.", scope, excluded };
  if (domain === "Reading lists" && !/\b(manual(?:ly)?|offline|local[ -](?:first|only)|no (?:account|login)|without (?:an? )?account)\b/i.test(text))
    return { level: "review", reason: "Check whether books can be entered manually or tracked offline without a reading service.", scope, excluded };
  if (domain === "Counters & tallies" && !/\b(tap|click|increment|decrement|manual(?:ly)?|count anything)\b/i.test(text))
    return { level: "review", reason: "Check whether counts are entered by hand rather than detected by a camera, sensor or external service.", scope, excluded };
  if (["Journals & diaries", "Flashcards", "Reading lists", "Counters & tallies"].includes(domain) && /\b(sign[ -]?in|registration|account required|account is required)\b/i.test(positive) && !/\b(no (?:login|account)|without (?:an? )?account)\b/i.test(text))
    return { level: "review", reason: "Offline support does not establish that the app works without signing in.", scope, excluded };
  if (/\b(sync|cloud|sign[ -]?in|registration|account required|account is required|internet required)\b/i.test(positive) && !/\b(offline|without (?:an? )?account|no (?:login|account)|local[ -](?:first|only))\b/i.test(text))
    return { level: "review", reason: "Check whether the core workflow works without an account or cloud service.", scope, excluded };
  return { level: "simple", reason: "Small local workflow candidate. APK behavior still needs verification.", scope, excluded };
}
export function fitsFilter(fit: AppFit, filter: ComplexityFilter = "simple") {
  return fit.level === "simple" || (filter === "review" && fit.level === "review");
}
export function featureFitsScope(name: string, detail: string) {
  const text = `${name} ${detail}`;
  return !blockers.some(([pattern]) => pattern.test(text)) && !/\b(sync|cloud|accounts?|sign[ -]?in|subscription|payments?|ads?|widgets?|wearables?)\b/i.test(text);
}
