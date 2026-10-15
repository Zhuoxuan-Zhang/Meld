import type { SearchTopic } from "./intent";
import { useCallback, useEffect, useRef, useState } from "react";
import { parseMarketResult } from "./market";
import type { MarketResult } from "./market";

export type MarketConnection = { available: boolean; reason?: string };
export type ScanState =
  | { phase: "scanning"; startedAt: number; queued?: boolean }
  | { phase: "error"; message: string };
// Scans are slow; sending at most two at once leaves the browser's few
// connections to the local server free for everything else.
const MAX_ACTIVE = 2;

// Requests market signals from the local server for every chosen domain that
// has no saved scan yet. Results are handed to `onResult`; failures stay
// visible per domain until the user retries.
export function useMarket(
  domains: string[],
  market: Record<string, MarketResult> | undefined,
  onResult: (domain: string, result: MarketResult) => void,
  topics?: SearchTopic[],
) {
  const topicKey = JSON.stringify(topics || []);
  const queryPlans = useRef(topics);
  queryPlans.current = topics;
  const context = useRef(topicKey);
  context.current = topicKey;
  const [connection, setConnection] = useState<MarketConnection | null>(null);
  const [scans, setScans] = useState<Record<string, ScanState>>({});
  const requests = useRef(new Map<string, AbortController>());
  // Domains rescanned this session because their saved scan predates store
  // descriptions or image links.
  const upgraded = useRef(new Set<string>());
  const slots = useRef({ active: 0, waiting: [] as (() => void)[] });
  const deliver = useRef(onResult);
  deliver.current = onResult;
  const settle = useCallback((domain: string, state?: ScanState) => {
    setScans((s) => {
      const next = { ...s };
      if (state) next[domain] = state;
      else delete next[domain];
      return next;
    });
  }, []);
  const check = useCallback(async () => {
    try {
      const res = await fetch("/api/market/status");
      const data = await res.json();
      setConnection({
        available: data.available === true,
        reason: typeof data.reason === "string" ? data.reason : undefined,
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
        s.waiting.splice(s.waiting.indexOf(start), 1);
        reject(new Error("canceled"));
      };
      s.waiting.push(start);
      signal.addEventListener("abort", cancel, { once: true });
    });
  const release = () => {
    slots.current.active--;
    slots.current.waiting.shift()?.();
  };
  const scan = useCallback(async (domain: string, refresh = false) => {
    requests.current.get(domain)?.abort();
    const requestContext = context.current;
    const controller = new AbortController();
    requests.current.set(domain, controller);
    settle(domain, { phase: "scanning", startedAt: Date.now(), queued: true });
    // Generous: the time includes waiting for other scans to finish.
    const timeout = setTimeout(() => controller.abort("timeout"), 300_000);
    let failure = "";
    let acquired = false;
    try {
      await acquire(controller.signal);
      acquired = true;
      if (requests.current.get(domain) === controller)
        settle(domain, { phase: "scanning", startedAt: Date.now() });
      const res = await fetch("/api/market/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ domain, refresh, queries: queryPlans.current?.find(t => t.domain === domain)?.queries }),
        signal: controller.signal,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok)
        failure =
          typeof data.error === "string"
            ? data.error
            : "The market scan failed. Please try again.";
      else {
        const result = parseMarketResult(data.result);
        if (!controller.signal.aborted && requestContext === context.current && requests.current.get(domain) === controller) deliver.current(domain, result);
      }
    } catch {
      failure =
        controller.signal.reason === "timeout"
          ? "The market scan took too long. Please try again."
          : controller.signal.aborted
            ? ""
            : "The market scan returned data Meld could not use. Please try again.";
    } finally {
      clearTimeout(timeout);
      if (acquired) release();
    }
    if (requests.current.get(domain) !== controller) return;
    requests.current.delete(domain);
    settle(domain, failure ? { phase: "error", message: failure } : undefined);
  }, [settle]);
  useEffect(() => {
    requests.current.forEach(c => c.abort()); requests.current.clear();
    upgraded.current.clear(); setScans({});
  }, [topicKey]);
  // Start scans for new domains; stop scans for removed ones.
  useEffect(() => {
    if (!connection?.available) return;
    for (const domain of domains) {
      const result = market?.[domain];
      const outdated =
        !!result &&
        !upgraded.current.has(domain) &&
        (!result.scanId || result.apps.some(
          (a) =>
            !a.retained &&
            (a.description === undefined || a.iconUrl === undefined),
        ));
      if ((!result || outdated) && !scans[domain] && !requests.current.has(domain)) {
        if (outdated) upgraded.current.add(domain);
        scan(domain);
      }
    }
    for (const [domain, controller] of requests.current)
      if (!domains.includes(domain)) {
        controller.abort();
        requests.current.delete(domain);
      }
    for (const domain of Object.keys(scans))
      if (!domains.includes(domain)) settle(domain);
  }, [connection, domains, market, scans, scan, settle]);
  return { connection, scans, scan, check };
}
