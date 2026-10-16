import { useState } from "react";
import { Icon } from "./icons";
import { formatInstalls, referenceFit, sizedImage } from "./market";
import type { ReferenceApp } from "./data";
import type { FeatureRequest } from "../../shared/contracts";

export function ReferenceIcon({ app, small = false }: { app: ReferenceApp; small?: boolean }) {
  const [failed, setFailed] = useState("");
  const url = app.market?.iconUrl;
  return <span className={`studio-reference-icon${small ? " small" : ""}`} aria-hidden="true">{url && failed !== url ? <img src={sizedImage(url, "s128")} alt="" referrerPolicy="no-referrer" decoding="async" onError={() => setFailed(url)} /> : app.name.trim().slice(0, 1).toUpperCase()}</span>;
}
function ReferenceScreenshots({ app }: { app: ReferenceApp }) {
  const [failed, setFailed] = useState<string[]>([]);
  const screenshots = (app.market?.screenshots || []).filter(url => !failed.includes(url));
  if (!screenshots.length) return <p className="studio-note">Screenshots aren’t available for this app.</p>;
  return <div className="studio-reference-screenshots" role="region" aria-label={`${app.name} store screenshots`} tabIndex={0}>{screenshots.map((url, index) => <img key={url} src={sizedImage(url, "h560")} alt={`${app.name} screenshot ${index + 1}`} loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setFailed(current => [...current, url])} />)}</div>;
}
export type FeatureSummaryStatus = { phase: "loading" | "queued" | "paused" | "unavailable" | "pending"; retry?: () => void };
const summaryMessages = {
  loading: { title: "Reading features…", detail: "Reading this app’s store listing. Features will appear here.", icon: "LoaderCircle" },
  queued: { title: "Queued for feature summary", detail: "Waiting for an earlier batch. Features will appear automatically.", icon: "Timer" },
  paused: { title: "Feature summaries paused", detail: "The summary request stopped. Retry to continue.", icon: "CircleAlert" },
  unavailable: { title: "Feature summaries unavailable", detail: "Reconnect to start reading this app’s features.", icon: "CircleAlert" },
  pending: { title: "Feature summary pending", detail: "Features are not ready to select yet.", icon: "Timer" },
};
function SummaryNotice({ app, status }: { app: ReferenceApp; status: FeatureSummaryStatus }) {
  const message = summaryMessages[status.phase];
  return <div className="studio-summary-notice" data-phase={status.phase}>
    <div role="status" aria-label={`Feature summary for ${app.name}`}>
      <Icon name={message.icon} size={19} className={status.phase === "loading" ? "studio-loading-spinner" : ""} />
      <div><strong>{message.title}</strong><p>{message.detail}</p></div>
    </div>
    {status.retry && <button type="button" className="studio-text-button" aria-label={`Retry feature summary for ${app.name}`} onClick={status.retry}>{status.phase === "unavailable" ? "Retry connection" : "Retry feature summary"}<Icon name="RefreshCw" size={14} /></button>}
  </div>;
}
type Props = { baseAppId?: string; chooseBase?: (id: string) => void; apps: ReferenceApp[]; selections: Record<string, string[]>; custom: FeatureRequest[]; disabled: boolean; select: (app: string, feature: string, checked: boolean) => void; customize: (app: string, feature: FeatureRequest) => void; selectAll: (app: string, ids: string[]) => void; matches?: (app: ReferenceApp) => string[]; summaryStatus?: (app: ReferenceApp) => FeatureSummaryStatus };
export default function ReferenceApps({ baseAppId, chooseBase, apps, selections, custom, disabled, select, customize, selectAll, matches, summaryStatus }: Props) {
  const [expanded, setExpanded] = useState<string | null>(null);
  return <div className="studio-reference-grid">{apps.map((app, index) => {
    const fit = referenceFit(app);
    const open = expanded === app.id, selected = selections[app.id] || [], summarized = Boolean(app.market?.listedFeatures), ready = summarized && app.features.length > 0, allSelected = ready && app.features.every(f => selected.includes(f.id));
    return <article className={`studio-market-app studio-reference-card${open ? " is-open" : ""}${selected.length ? " has-selection" : ""}${baseAppId === app.id ? " is-base" : ""}`} key={app.id} aria-label={`Reference app: ${app.name}`}>
      <button className="studio-reference-toggle" aria-label={`${allSelected ? "Clear" : "Select"} all features from ${app.name}`} aria-pressed={allSelected} disabled={disabled || !ready} onClick={() => selectAll(app.id, allSelected ? [] : app.features.map(f => f.id))}>
        <span className="studio-reference-top"><ReferenceIcon app={app} /><span className="studio-reference-rank">Reference {String(index + 1).padStart(2, "0")}</span>{selected.length > 0 && <span className="studio-reference-selected"><Icon name="Check" size={12} />{selected.length} selected</span>}</span>
        <span className="studio-reference-name"><h3>{app.name}</h3>{ready && <Icon name={allSelected ? "CircleCheck" : "CirclePlus"} size={18} />}</span>
        <span className="studio-reference-description">{app.tagline}</span>
        <span className="studio-reference-metrics"><span><Icon name="Star" size={12} />{app.market?.rating == null ? "Not rated" : app.market.rating.toFixed(1)}</span><span>{formatInstalls(app.market?.installs || 0)} installs</span><span>Signal {app.market?.score}/15</span></span>
        <span className="studio-reference-tags">{app.features.slice(0, 2).map(feature => <span key={feature.id}>{custom.find(item => item.id === feature.id)?.name || feature.name}</span>)}{app.features.length > 2 && <span>+{app.features.length - 2}</span>}</span>
        {summarized && <span className="studio-reference-footer"><span>{app.features.length} features to explore</span><span>{ready ? (allSelected ? "Clear selection" : "Select all features") : "No eligible features"}<Icon name={open ? "ChevronUp" : "ChevronDown"} size={14} /></span></span>}
      </button>
      {!summarized && <SummaryNotice app={app} status={summaryStatus?.(app) || { phase: "pending" }} />}
      <button className="studio-reference-explore" aria-label={`Explore ${app.name}`} aria-expanded={open} aria-controls={`reference-${app.id}`} onClick={() => setExpanded(open ? null : app.id)}>{open ? "Close details" : "Explore features"}<Icon name={open ? "ChevronUp" : "ArrowUpRight"} size={18} /></button>
      {fit.level === "review" && <p className="studio-note">Needs review: {fit.reason}</p>}
      {matches?.(app).length ? <p className="studio-note studio-feature-match">Listing mentions: {matches(app).join(" · ")}</p> : null}
      {chooseBase && <label className="studio-base-choice"><input type="radio" name="base-app" aria-label={`Use ${app.name} as base`} checked={baseAppId === app.id} disabled={disabled || !!app.market?.retained} onChange={() => chooseBase(app.id)} /><span><strong>{baseAppId === app.id ? "Your base app" : "Use as base"}</strong><small>{baseAppId === app.id ? "Keep its core purpose. Add your selected improvements." : "Build around this app’s main functionality."}</small></span></label>}
      {open && <div id={`reference-${app.id}`} className="studio-reference-detail">
        <div className="studio-reference-detail-head"><div><h4>A closer look</h4><p>Screenshots from Google Play</p></div><a className="studio-text-button" href={app.market?.storeUrl} target="_blank" rel="noreferrer">View listing <Icon name="ExternalLink" size={13} /></a></div>
        <ReferenceScreenshots app={app} />
        <div className="studio-reference-detail-head"><div><h4>Choose what belongs in your app</h4><p>{app.market?.listedFeatures ? "Ideas from the store description" : "Waiting for a completed listing summary"}</p></div><div className="studio-reference-bulk"><button disabled={disabled || !app.features.length || app.features.every(feature => selected.includes(feature.id))} onClick={() => selectAll(app.id, app.features.map(feature => feature.id))}>Select all</button><button disabled={disabled || !selected.length} onClick={() => selectAll(app.id, [])}>Clear</button></div></div>
        <div className="studio-feature-picks">{app.features.map(feature => {
          const override = custom.find(item => item.id === feature.id), value = override || feature;
          return <div className={`studio-feature-choice${selected.includes(feature.id) ? " is-selected" : ""}`} key={feature.id}><label><input type="checkbox" checked={selected.includes(feature.id)} disabled={disabled} onChange={event => select(app.id, feature.id, event.target.checked)} /><span><strong>{value.name}</strong><small>{value.description}</small>{override && <em>Customized for your app</em>}</span></label><details className="studio-feature-edit"><summary>Customize {feature.name}</summary><label>Feature name<input value={value.name} maxLength={120} disabled={disabled} onChange={event => customize(app.id, { id: feature.id, name: event.target.value, description: value.description })} /></label><label>How should it work?<textarea aria-label="How should it work?" value={value.description} rows={3} maxLength={1000} disabled={disabled} onChange={event => customize(app.id, { id: feature.id, name: value.name, description: event.target.value })} /></label></details>{feature.flow && <details className="studio-feature-journey"><summary>See the user journey</summary><p>{feature.flow}</p></details>}</div>;
        })}</div>
        {!app.features.length && <p className="studio-note">{summarized ? "The completed summary contains no features within this app’s scope." : "Features are not ready yet. Check the summary status above or retry the summary."}</p>}
        <p className="studio-note">Store descriptions suggest ideas; they don’t establish verified app behavior.</p>
      </div>}
    </article>;
  })}</div>;
}
export function FeatureMix({ apps, selections, custom, disabled, remove, removeCustom }: { apps: ReferenceApp[]; selections: Record<string, string[]>; custom: FeatureRequest[]; disabled: boolean; remove: Props['select']; removeCustom: (id: string) => void }) {
  const own = custom.filter(feature => !apps.some(app => app.features.some(item => item.id === feature.id)));
  const chosen = apps.filter(app => app.features.some(feature => selections[app.id]?.includes(feature.id)));
  const count = chosen.reduce((sum, app) => sum + app.features.filter(feature => selections[app.id]?.includes(feature.id)).length, 0) + own.length;
  return <section className="studio-feature-mix" aria-label="Your feature mix"><div className="studio-mix-heading"><p className="studio-eyebrow">YOUR FEATURE MIX</p><span>{count}</span></div>{!count && <p className="studio-mix-empty">Pick the ideas you like. They’ll come together here.</p>}{chosen.map(app => <div className="studio-mix-group" key={app.id}><div><ReferenceIcon app={app} small /><strong>{app.name}</strong></div><ul>{app.features.filter(feature => selections[app.id]?.includes(feature.id)).map(feature => <li key={feature.id}><Icon name="Check" size={12} /><span>{custom.find(item => item.id === feature.id)?.name || feature.name}</span><button disabled={disabled} aria-label={`Remove ${feature.name} from ${app.name}`} onClick={() => remove(app.id, feature.id, false)}><Icon name="X" size={13} /></button></li>)}</ul></div>)}{own.length > 0 && <div className="studio-mix-group"><div><Icon name="Sparkles" size={17} /><strong>Your own ideas</strong></div><ul>{own.map(feature => <li key={feature.id}><Icon name="Check" size={12} /><span>{feature.name}</span><button disabled={disabled} aria-label={`Remove custom feature ${feature.name}`} onClick={() => removeCustom(feature.id)}><Icon name="X" size={13} /></button></li>)}</ul></div>}</section>;
}
