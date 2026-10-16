import { useEffect, useState } from "react";
import { Icon } from "./icons";
import type { ScanState } from "./useMarket";
import type { FeatureState } from "./useFeatures";

function ElapsedTime({ startedAt }: { startedAt: number }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [startedAt]);
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  return <span className="studio-loading-time" aria-hidden="true">{seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`} elapsed</span>;
}

export default function DiscoveryProgress({ domain, search, summaries, completed, total }: {
  domain: string;
  search?: ScanState;
  summaries?: FeatureState;
  completed: number;
  total: number;
}) {
  const scan = search?.phase === "scanning" ? search : undefined;
  const summary = summaries?.phase === "running" ? summaries : undefined;
  const active = scan || summary;
  if (!active) return null;
  return <div className="studio-loading-progress">
    <div className="studio-loading-heading">
      <Icon name={active.queued ? "Timer" : "LoaderCircle"} size={20} className={active.queued ? "" : "studio-loading-spinner"} />
      <strong>{scan ? (scan.queued ? "Search queued" : "Finding reference apps") : (summary?.queued ? "Feature summaries queued" : "Preparing app features")}</strong>
      <ElapsedTime startedAt={active.startedAt} />
    </div>
    {scan ? <>
      <div className={`studio-loading-track${scan.queued ? " is-queued" : ""}`} aria-hidden="true"><span /></div>
      <p>Waiting for {scan.queued ? "a search slot" : "Google Play results"}. This may take a few minutes. Results appear automatically.</p>
    </> : <>
      <progress value={completed} max={Math.max(1, total)} aria-label={`${domain} feature summaries completed`} />
      <p className="studio-loading-count">{completed} of {total} app summaries ready</p>
      <p role="status">{summary?.queued ? "Waiting for a summary slot. Features will appear automatically." : "Reading store listings… Feature summaries are still processing."}</p>
      <p>You can explore and select apps as their features become ready.</p>
    </>}
  </div>;
}
