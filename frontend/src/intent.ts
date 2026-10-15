export type SearchTopic = { domain: string; queries: string[] };
export type SearchPlan = {
  summary: string;
  audience: string;
  features: { name: string; terms: string[] }[];
  exclusions: string[];
  assumptions: string[];
  topics: SearchTopic[];
};
export type IntentReply = {
  message: string;
  questions: { id: string; question: string; options: string[] }[];
  plan: SearchPlan | null;
};
export type IntentTurn = { question: string; answer: string };
export type Intent = { idea: string; turns: IntentTurn[]; answers?: Record<string, string>; reply?: IntentReply; approved: boolean };

// Saved browser input is untrusted. Keep malformed or older intent state out
// of the scan scheduler; the server separately validates every model result.
export function parseIntent(value: unknown): Intent | undefined {
  if (!value || typeof value !== "object") return undefined;
  const v = value as Intent;
  if (typeof v.idea !== "string" || v.idea.length > 3000 || !Array.isArray(v.turns) || v.turns.length > 9 || v.turns.some(t => typeof t?.question !== "string" || typeof t.answer !== "string" || t.answer.length > 1200)) return undefined;
  if (v.answers && (typeof v.answers !== "object" || Array.isArray(v.answers) || Object.keys(v.answers).length > 3 || Object.values(v.answers).some(a => typeof a !== "string" || a.length > 1200))) return undefined;
  if (v.reply) {
    if (typeof v.reply.message !== "string" || !Array.isArray(v.reply.questions) || v.reply.questions.length > 3 || v.reply.questions.some(q => typeof q?.id !== "string" || typeof q.question !== "string" || !Array.isArray(q.options) || q.options.some(o => typeof o !== "string"))) return undefined;
    const p = v.reply.plan;
    if (p && (typeof p.summary !== "string" || typeof p.audience !== "string" || !Array.isArray(p.topics) || !p.topics.length || p.topics.length > 2 || p.topics.some(t => !t || typeof t.domain !== "string" || t.domain.length > 48 || !Array.isArray(t.queries) || !t.queries.length || t.queries.length > 4 || t.queries.some(q => typeof q !== "string" || q.length > 120)) || !Array.isArray(p.features) || !p.features.length || p.features.length > 5 || p.features.some(f => !f || typeof f.name !== "string" || !Array.isArray(f.terms) || f.terms.some(t => typeof t !== "string")) || !Array.isArray(p.exclusions) || p.exclusions.some(t => typeof t !== "string") || !Array.isArray(p.assumptions) || p.assumptions.some(t => typeof t !== "string"))) return undefined;
  }
  return { ...v, approved: v.approved === true && !!v.reply?.plan && !v.reply.questions.length };
}

export function intentBrief(intent?: Intent) {
  if (!intent?.approved || !intent.reply?.plan) return "";
  const p = intent.reply.plan;
  // Keep the confirmed limits even when the earlier conversation is long.
  return [`Confirmed scope: ${p.summary}`, `Desired features: ${p.features.map(f => f.name).join("; ")}`, `Excluded: ${p.exclusions.join("; ")}`, `Agreed assumptions: ${p.assumptions.join("; ")}`, `Original idea: ${intent.idea}`, ...intent.turns.map(t => `${t.question} ${t.answer}`)].join("\n").slice(0, 6000);
}
