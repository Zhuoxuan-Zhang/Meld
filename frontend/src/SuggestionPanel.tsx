import { useEffect, useRef, useState } from "react";
import type { ReferenceApp } from "./data";
import { Icon } from "./icons";
import type { Draft } from "./state";
import { exampleSuggestion, validateSuggestion } from "./suggestions";
import type { Suggestion } from "./suggestions";

export function PlanSummary({
  plan,
  catalog,
}: {
  plan: Suggestion;
  catalog: ReferenceApp[];
}) {
  return (
    <div className="plan-summary">
      <div className="plan-concept">
        <span className="section-kicker">
          {plan.source === "ai" ? "AI SUGGESTION" : "EXAMPLE PLAN"}
        </span>
        <h3>{plan.name}</h3>
        <p>{plan.summary}</p>
      </div>
      <div className="plan-feature-grid">
        {plan.features.map((f) => {
          const app = catalog.find((a) => a.id === f.appId);
          const feature = app?.features.find((x) => x.id === f.featureId);
          if (!app || !feature) return null;
          return (
            <div className="plan-feature" key={f.featureId}>
              <span className="plan-feature-icon">
                <Icon name={feature.icon} size={20} />
              </span>
              <div>
                <h4>
                  {feature.name}
                  <span>from {app.name}</span>
                </h4>
                <p>{f.reason}</p>
              </div>
            </div>
          );
        })}
      </div>
      <div className="plan-journey">
        <h4>How it works together</h4>
        <ol>
          {plan.journey.map((step, i) => (
            <li key={i}>
              <span>{i + 1}</span>
              <p>{step}</p>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}

export default function SuggestionPanel({
  draft,
  shown,
  update,
  apply,
  undo,
  canUndo,
  onContinue,
}: {
  draft: Draft;
  shown: ReferenceApp[];
  update: (patch: Partial<Draft>) => void;
  apply: (plan: Suggestion) => void;
  undo: () => void;
  canUndo: boolean;
  onContinue: () => void;
}) {
  const [status, setStatus] = useState<{
    available: boolean;
    provider: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const request = useRef<AbortController | null>(null);
  const resultRef = useRef<HTMLDivElement>(null);
  const hasCatalog = shown.length > 0;
  const plan = draft.suggestion;
  const applied =
    !!draft.plan && JSON.stringify(draft.plan) === JSON.stringify(plan);
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/ai/status", { signal: controller.signal })
      .then((r) => r.json())
      .then((s) =>
        setStatus({ available: s.available === true, provider: "OpenRouter" }),
      )
      .catch(() => {
        if (!controller.signal.aborted)
          setStatus({ available: false, provider: "OpenRouter" });
      });
    return () => {
      controller.abort();
      request.current?.abort();
    };
  }, []);
  const suggest = async () => {
    const controller = new AbortController();
    request.current?.abort();
    request.current = controller;
    setBusy(true);
    setError("");
    const timeout = setTimeout(() => controller.abort("timeout"), 55_000);
    try {
      const res = await fetch("/api/ai/suggest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          domains: draft.domains,
          goal: draft.goal,
          // Live market apps are not in the server's sample catalog, so the
          // shown catalog travels with the request. Store-listing features
          // carry their text; sample features are sent by id.
          ...(shown.some((a) => a.market)
            ? {
                catalog: shown
                  .filter((a) => a.features.length)
                  .map((a) => ({
                    id: a.id,
                    name: a.name,
                    domain: a.domain,
                    features: a.features.map((f) =>
                      f.listed
                        ? { id: f.id, name: f.name, description: f.description }
                        : f.id,
                    ),
                  })),
              }
            : {}),
        }),
        signal: controller.signal,
      });
      const data = await res.json();
      if (!res.ok)
        throw new Error(
          typeof data.error === "string"
            ? data.error
            : "Could not get a suggestion. Please try again.",
        );
      let suggestion: Suggestion;
      try {
        suggestion = validateSuggestion(data.plan, draft.domains, shown);
      } catch {
        throw new Error(
          "The AI returned a plan we could not use. Your choices are unchanged. Please try again.",
        );
      }
      if (controller.signal.aborted) return;
      update({ suggestion });
      setTimeout(() => resultRef.current?.focus({ preventScroll: true }), 0);
    } catch (e) {
      if (!controller.signal.aborted || controller.signal.reason === "timeout")
        setError(
          controller.signal.reason === "timeout"
            ? "The suggestion took too long. Please try again."
            : e instanceof Error
              ? e.message
              : "Could not get a suggestion. Try again.",
        );
    } finally {
      clearTimeout(timeout);
      if (request.current === controller) {
        setBusy(false);
        request.current = null;
      }
    }
  };
  const showExample = () => {
    const suggestion = exampleSuggestion(draft.domains, shown);
    if (suggestion) {
      update({ suggestion });
      setError("");
    } else
      setError(
        "An example needs three different features from at least two apps. Wait for Claude Code to summarize the store listings, or choose features from the apps below.",
      );
  };
  return (
    <section
      className="suggestion-panel"
      aria-labelledby="suggestion-title"
      aria-busy={busy}
    >
      <div className="suggestion-heading">
        <span className="ai-mark">
          <Icon name="Sparkles" size={22} />
        </span>
        <div>
          <h2 id="suggestion-title">Start with a smarter combination</h2>
          <p>
            Describe your idea. Get one focused app plan, with features that
            work together.
          </p>
        </div>
        <span className={`ai-status ${status?.available ? "connected" : ""}`}>
          {status === null
            ? "Connecting…"
            : status.available
              ? "AI configured"
              : "AI not connected"}
        </span>
      </div>
      <label className="form-label" htmlFor="app-goal">
        What would you like to build? <span>Optional</span>
      </label>
      <textarea
        id="app-goal"
        className="text-input"
        rows={2}
        maxLength={600}
        disabled={busy}
        value={draft.goal}
        onChange={(e) => update({ goal: e.target.value })}
        placeholder="For example: help students plan their work, stay focused, and unwind afterward."
      />
      <div className="suggestion-actions">
        <div className="action-buttons">
          <button
            className="button primary"
            onClick={suggest}
            disabled={busy || !hasCatalog || !status?.available}
          >
            <Icon
              name={busy ? "LoaderCircle" : "Sparkles"}
              size={18}
              className={busy ? "spin" : ""}
            />
            {busy
              ? "Finding a useful combination…"
              : plan
                ? "Suggest another plan"
                : "Suggest a combination"}
          </button>
          {busy ? (
            <button
              className="text-button"
              onClick={() => {
                request.current?.abort();
                request.current = null;
                setBusy(false);
              }}
            >
              Cancel
            </button>
          ) : (
            <button
              className="text-button"
              onClick={showExample}
              disabled={!hasCatalog}
            >
              Try an example
            </button>
          )}
        </div>
        <span className="suggestion-disclosure">
          {status?.available
            ? "Your goal and reference catalog are sent to OpenRouter."
            : "Examples work without an AI connection."}
        </span>
      </div>
      {!hasCatalog && (
        <p className="info-note">
          Suggestions need apps to combine. Wait for market signals to find
          apps for your domains, or add a suggested domain.
        </p>
      )}
      {status && !status.available && (
        <details className="connection-help">
          <summary>Connect AI suggestions</summary>
          <p>
            Add your OpenRouter key as <code>OPENROUTER_API_KEY</code> in{" "}
            <code>frontend/.env.local</code>, then restart Meld. The key stays
            on your local server.
          </p>
        </details>
      )}
      {error && (
        <div className="suggestion-error" role="alert">
          <Icon name="Info" size={18} />
          <p>{error}</p>
          <button
            className="text-button"
            onClick={suggest}
            disabled={busy || !status?.available}
          >
            Try again
          </button>
        </div>
      )}
      {plan && (
        <div
          className="suggestion-result"
          ref={resultRef}
          tabIndex={-1}
          aria-label="Suggested app plan"
        >
          <PlanSummary plan={plan} catalog={shown} />
          <div className="plan-apply">
            <div>
              <strong>
                {applied
                  ? "This is your current app plan"
                  : `${plan.features.length} features. One clear starting point.`}
              </strong>
              <p>
                {applied
                  ? "Continue to your app brief, or adjust features below."
                  : "Applies the full feature mix. You can undo or edit it afterward."}
              </p>
            </div>
            <div className="action-buttons">
              {canUndo && (
                <button className="button secondary" onClick={undo}>
                  Undo
                </button>
              )}
              {applied ? (
                <button className="button primary" onClick={onContinue}>
                  Review app
                  <Icon name="ArrowRight" size={18} />
                </button>
              ) : (
                <button
                  className="button primary"
                  onClick={() => apply(plan)}
                  disabled={busy}
                >
                  <Icon name="Plus" size={18} />
                  Use this plan
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
