import { useEffect, useRef, useState } from "react";
import type { Draft } from "./state";
import { parseIntent } from "./intent";
import type { Intent } from "./intent";

function waitToRetry(signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    signal.throwIfAborted();
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, 2000);
    signal.addEventListener("abort", abort, { once: true });
  });
}

export default function IntentPanel({ draft, update, onApproved }: { draft: Draft; update: (patch: Partial<Draft>) => void; onApproved: () => void }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [waiting, setWaiting] = useState(false);
  const [answers, setAnswers] = useState<Record<string, string>>(draft.intent?.answers || {});
  const pending = useRef<AbortController | null>(null);
  const ideaInput = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => () => pending.current?.abort(), []);
  const domainKey = draft.domains.join("\n");
  useEffect(() => { pending.current?.abort(); setBusy(false); }, [domainKey]);
  const intent = draft.intent;
  function answer(id: string, value: string) {
    const next = { ...answers, [id]: value }; setAnswers(next);
    if (intent) update({ intent: { ...intent, answers: next } });
  }
  function edit(idea: string) {
    pending.current?.abort(); setBusy(false); setError(""); setAnswers({});
    update({ intent: { idea, turns: [], approved: false } });
  }
  function reset() {
    pending.current?.abort(); pending.current = null;
    setBusy(false); setError(""); setAnswers({});
    update({ intent: undefined, discoverySource: "domains" });
    ideaInput.current?.focus();
  }
  async function clarify() {
    if (!intent || busy || (pending.current && !pending.current.signal.aborted)) return;
    const turns = [...intent.turns, ...(intent.reply?.questions || []).map(q => ({ question: q.question, answer: answers[q.id]?.trim() || "" }))];
    if (turns.some(t => !t.answer)) { setError("Answer each question to continue."); return; }
    const controller = new AbortController(); pending.current = controller;
    setBusy(true); setWaiting(false); setError("");
    const timer = setTimeout(() => controller.abort("timeout"), 135000);
    try {
      const payload = JSON.stringify({ idea: intent.idea, domains: draft.domains.slice(0, 2), turns });
      let response: Response, body;
      do {
        response = await fetch("/api/intent/clarify", { method: "POST", headers: { "Content-Type": "application/json" }, body: payload, signal: controller.signal });
        body = await response.json();
        controller.signal.throwIfAborted();
        if (response.status !== 429 || body.error?.code !== "busy") break;
        setWaiting(true);
        await waitToRetry(controller.signal);
      } while (!controller.signal.aborted);
      setWaiting(false);
      if (!response.ok) throw new Error(body.error?.message || "The idea review failed. Retry your answers.");
      const next = parseIntent({ idea: intent.idea, turns, reply: body, approved: false });
      if (!next?.reply) throw new Error("The agent returned an incomplete reply. Please retry.");
      if (!controller.signal.aborted) { update({ intent: next }); setAnswers({}); }
    } catch (e) {
      if (!controller.signal.aborted || controller.signal.reason === "timeout") setError(controller.signal.reason === "timeout" ? "The agent took too long. Your answers are still here. Retry." : (e as Error).message);
    } finally { clearTimeout(timer); if (pending.current === controller) { pending.current = null; setBusy(false); setWaiting(false); } }
  }
  function approve(value: Intent) {
    // Returning from the results must keep the scan and feature selections.
    if (value.approved) { onApproved(); return; }
    const plan = value.reply!.plan!;
    update({ intent: { ...value, approved: true }, discoverySource: "idea", domains: plan.topics.map(t => t.domain), market: {}, selected: {}, goal: plan.summary, audience: plan.audience, description: plan.summary });
    onApproved();
  }
  return <section className="surface intent-panel" aria-label="Describe your idea">
    <div className="section-title"><div><h2>Start with an idea</h2><p>Describe what you want. We’ll clarify the details before searching.</p></div></div>
    <label className="form-label" htmlFor="intent-idea">What would you like to build?</label>
    <textarea ref={ideaInput} id="intent-idea" className="text-input" rows={3} maxLength={3000} value={intent?.idea || ""} placeholder="For example: an offline study timer that saves a note after each session." onChange={e => edit(e.target.value)} />
    {intent?.turns.length ? <details className="scope-evidence"><summary>Your answers</summary>{intent.turns.map((t, i) => <p key={i}><strong>{t.question}</strong><br />{t.answer}</p>)}</details> : null}
    {intent?.reply && <p className="intent-message">{intent.reply.message}</p>}
    {intent?.reply?.questions.map(q => <fieldset className="intent-question" key={q.id} disabled={busy}><legend>{q.question}</legend><div className="filter-tabs">{q.options.map(o => <button type="button" key={o} aria-pressed={answers[q.id] === o} onClick={() => answer(q.id, o)}>{o}</button>)}</div><label className="form-label" htmlFor={`answer-${q.id}`}>Your answer</label><input id={`answer-${q.id}`} className="text-input" maxLength={1200} value={answers[q.id] || ""} placeholder="Choose above or write your own answer" onChange={e => answer(q.id, e.target.value)} /></fieldset>)}
    {intent?.reply?.plan && <div className="intent-plan"><h3>{intent.approved ? "Your confirmed search plan" : "Check your search plan"}</h3><p>{intent.reply.plan.summary}</p><p><strong>For:</strong> {intent.reply.plan.audience}</p><ul>{intent.reply.plan.features.map(f => <li key={f.name}>{f.name}</li>)}</ul>{intent.reply.plan.exclusions.length > 0 && <p><strong>Outside this version:</strong> {intent.reply.plan.exclusions.join("; ")}</p>}{intent.reply.plan.assumptions.length > 0 && <p><strong>{intent.approved ? "Agreed assumptions:" : "Assumptions to confirm:"}</strong> {intent.reply.plan.assumptions.join("; ")}</p>}<details><summary>Search phrases</summary>{intent.reply.plan.topics.map(t => <p key={t.domain}><strong>{t.domain}</strong>: {t.queries.join(" · ")}</p>)}</details><p>We’ll use this plan to find reference apps for the Android app you’ll build. You don’t need to select domains.</p></div>}
    {error && <p role="alert" className="field-error">{error}</p>}
    {busy && <p role="status">{waiting ? "Waiting for an earlier idea check to finish… We’ll retry automatically." : "Clarifying your idea… App search starts after you confirm the plan."}</p>}
    <div className="intent-actions">{intent?.reply?.plan && <button className="button primary" onClick={() => approve(intent)}>{intent.approved ? "View app results" : "Confirm and find apps"}</button>}{!intent?.reply?.plan && <button className="button primary" disabled={busy || (intent?.idea.trim().length || 0) < 3} onClick={clarify}>{error ? "Retry clarification" : intent?.reply?.questions.length ? "Continue with answers" : "Clarify my idea"}</button>}<button type="button" className="button primary" disabled={!intent && !busy && !error} onClick={reset}>Reset</button>{intent && <button className="text-button" onClick={() => { pending.current?.abort(); setBusy(false); setError(""); const domains = document.getElementById("studio-domains"); domains?.focus({ preventScroll: true }); domains?.scrollIntoView({ behavior: "smooth", block: "start" }); }}>Use domains only</button>}</div>
  </section>;
}
