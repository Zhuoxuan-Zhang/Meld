import { assessFit } from "./feasibility";
import { useCallback, useEffect, useRef, useState } from "react";
import { parseListedFeatures } from "./market";
import type { ListedFeatures, MarketApp, MarketResult } from "./market";

export type FeatureConnection = {
  available: boolean;
  reason?: string;
  model?: string;
};
export type FeatureState =
  | { phase: "running"; appIds: string[]; generatedAt: string; queued?: boolean }
  | { phase: "error"; appIds: string[]; generatedAt: string; message: string };
const MAX_ACTIVE = 2;

// Apps in a scan whose listing has not been summarized yet. Scans saved before
// listings were collected have no description and are rescanned instead.
export const unsummarized = (result: MarketResult, includeReview = false) =>
  result.apps.filter(
    (a) => !a.retained && !a.listedFeatures && a.description !== undefined && (assessFit(a, result.domain).level === "simple" || includeReview && assessFit(a, result.domain).level === "review"),
  );
const request = (a: MarketApp) => ({
  appId: a.appId,
  title: a.title,
  summary: a.summary,
  description: a.description || "",
});

// Asks the local server to summarize each scanned domain's store listings
// with Claude Code, once per scan. Results go to `onFeatures`; failures stay
// visible per domain until the user retries.
export function useListedFeatures(
  domains: string[],
  market: Record<string, MarketResult> | undefined,
  onFeatures: (features: Record<string, ListedFeatures>) => void,
  includeReview = false,
) {
  const [connection, setConnection] = useState<FeatureConnection | null>(null);
  const [states, setStates] = useState<Record<string, FeatureState>>({});
  const requests = useRef(new Map<string, AbortController>());
  const sources = useRef(new Map<string, string>());
  const scanKey = (result?: MarketResult) => result ? `${result.scanId || ""}:${result.generatedAt}` : "";
  const slots = useRef({ active: 0, waiting: [] as (() => void)[] });
  const deliver = useRef(onFeatures);
  deliver.current = onFeatures;
  const settle = useCallback((domain: string, state?: FeatureState) => {
    setStates((s) => {
      const next = { ...s };
      if (state) next[domain] = state;
      else delete next[domain];
      return next;
    });
  }, []);
  const check = useCallback(async () => {
    try {
      const data = await (await fetch("/api/claude/status")).json();
      setConnection({
        available: data.available === true,
        reason: typeof data.reason === "string" ? data.reason : undefined,
        model: typeof data.model === "string" ? data.model : undefined,
      });
    } catch {
      setConnection({
        available: false,
        reason: "The local Meld server could not be reached.",
      });
    }
  }, []);
  useEffect(() => {
    check();
    const active = requests.current;
    return () => {
      active.forEach((c) => c.abort());
      active.clear();
    };
  }, [check]);
  const acquire = (signal: AbortSignal) =>
    new Promise<void>((resolve, reject) => {
      signal.throwIfAborted();
      const s = slots.current;
      if (s.active < MAX_ACTIVE) {
        s.active++;
        return resolve();
      }
      const start = () => {
        signal.removeEventListener("abort", cancel);
        s.active++;
        resolve();
      };
      const cancel = () => {
        const index = s.waiting.indexOf(start);
        if (index !== -1) s.waiting.splice(index, 1);
        reject(new Error("canceled"));
      };
      s.waiting.push(start);
      signal.addEventListener("abort", cancel, { once: true });
    });
  const release = () => {
    slots.current.active--;
    slots.current.waiting.shift()?.();
  };
  const summarize = useCallback(
    async (domain: string, result: MarketResult) => {
      const apps = unsummarized(result, includeReview).slice(0, 8);
      if (!apps.length) return;
      requests.current.get(domain)?.abort();
      const controller = new AbortController();
      requests.current.set(domain, controller);
      sources.current.set(domain, scanKey(result));
      const base = {
        appIds: apps.map((a) => a.appId),
        generatedAt: result.generatedAt,
      };
      settle(domain, { phase: "running", ...base, queued: true });
      const timeout = setTimeout(() => controller.abort("timeout"), 420_000);
      let failure = "";
      let acquired = false;
      try {
        await acquire(controller.signal);
        acquired = true;
        controller.signal.throwIfAborted();
        if (requests.current.get(domain) === controller)
          settle(domain, { phase: "running", ...base });
        const res = await fetch("/api/claude/features", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ domain, apps: apps.map(request) }),
          signal: controller.signal,
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok)
          failure =
            typeof data.error === "string"
              ? data.error
              : "Feature summaries failed. Please try again.";
        else {
          const features: Record<string, ListedFeatures> = {};
          for (const a of apps) {
            const parsed = parseListedFeatures(data.features?.[a.appId]);
            if (parsed) features[a.appId] = parsed;
          }
          // Partial answers are kept; the rest wait for a retry, not a loop.
          if (Object.keys(features).length < apps.length)
            failure = "Claude Code returned features Meld could not use.";
          if (Object.keys(features).length && !controller.signal.aborted && requests.current.get(domain) === controller)
            deliver.current(features);
        }
      } catch {
        failure =
          controller.signal.reason === "timeout"
            ? "Claude Code took too long. Please try again."
            : controller.signal.aborted
              ? ""
              : "Feature summaries failed. Please try again.";
      } finally {
        clearTimeout(timeout);
        if (acquired) release();
      }
      if (requests.current.get(domain) !== controller) return;
      requests.current.delete(domain);
      sources.current.delete(domain);
      settle(domain, failure ? { phase: "error", ...base, message: failure } : undefined);
    },
    [settle, includeReview],
  );
  // Summarize new scans; stop work for removed domains. A failure is retried
  // automatically only when a new scan replaces the one that failed.
  useEffect(() => {
    if (!connection?.available) return;
    for (const domain of domains) {
      const result = market?.[domain];
      const state = states[domain];
      if (
        result &&
        unsummarized(result, includeReview).length &&
        !requests.current.has(domain) &&
        (!state || state.generatedAt !== result.generatedAt)
      )
        summarize(domain, result);
    }
    for (const [domain, controller] of requests.current)
      if (!domains.includes(domain) || sources.current.get(domain) !== scanKey(market?.[domain])) {
        controller.abort();
        requests.current.delete(domain);
        sources.current.delete(domain);
        settle(domain);
      }
    for (const domain of Object.keys(states))
      if (!domains.includes(domain)) settle(domain);
  }, [connection, domains, market, states, summarize, settle, includeReview]);
  const retry = useCallback(
    (domain: string) => {
      const result = market?.[domain];
      if (result) summarize(domain, result);
    },
    [market, summarize],
  );
  return { connection, states, retry, check };
}
