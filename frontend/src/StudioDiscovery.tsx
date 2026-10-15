import { useEffect, useState } from "react";
import IntentPanel from "./IntentPanel";
import ReferenceApps, { FeatureMix } from "./ReferenceApps";
import { Icon } from "./icons";
import { domains, canonicalDomain } from "./data";
import { emptyDraft, loadDraft, storageKey, catalog, startDiscovery, withMarketResult, withListedFeatures } from "./state";
import type { Draft } from "./state";
import { buildCatalog, referenceFit } from "./market";
import { featureMatches, rankForIntent } from "./relevance";
import { useMarket } from "./useMarket";
import { useListedFeatures } from "./useFeatures";
import type { Brief } from "../../shared/contracts";

type Props = { initialBrief?: Brief; projectId?: string; busy: boolean; confirm: (draft: Draft) => Promise<void> };
export default function StudioDiscovery({ initialBrief, projectId, busy, confirm }: Props) {
  const [draft, setDraft] = useState<Draft>(() => {
    const saved = loadDraft();
    if (!initialBrief) return saved;
    if (saved.projectId === projectId) return { ...saved, discoveryStarted: false };
    return { ...emptyDraft(), name: initialBrief.name, audience: initialBrief.audience, description: initialBrief.purpose, goal: initialBrief.goal, style: initialBrief.style, domains: initialBrief.domains.slice(0, 2), intent: initialBrief.input ? { idea: initialBrief.input.slice(0, 3000), turns: [], approved: false } : undefined };
  });
  const [domain, setDomain] = useState(""), [query, setQuery] = useState(""), [feature, setFeature] = useState(""), [error, setError] = useState("");
  const source = draft.discoverySource || (draft.intent?.approved ? "idea" : "domains");
  const searching = draft.discoveryStarted && (source === "domains" || draft.intent?.approved);
  const plan = source === "idea" && draft.intent?.approved ? draft.intent.reply?.plan : undefined;
  const activeDomains = searching ? draft.domains : [];
  const market = useMarket(activeDomains, draft.market, (name, result) => setDraft(d => withMarketResult(d, name, result)), plan?.topics);
  const listing = useListedFeatures(activeDomains, draft.market, features => setDraft(d => withListedFeatures(d, features)), draft.complexity === "review");
  useEffect(() => { try { localStorage.setItem(storageKey, JSON.stringify(draft)); } catch { setError("This browser could not save your choices. Keep this page open while you continue."); } }, [draft]);
  function update(patch: Partial<Draft>) {
    setDraft(d => ({ ...d, ...patch,
      ...(patch.domains || Object.hasOwn(patch, "intent") ? { customFeatures: [], selected: {} } : {}),
      ...(patch.domains && !Object.hasOwn(patch, "intent") ? { market: {}, selected: {}, discoveryStarted: false } : {}),
      ...(Object.hasOwn(patch, "intent") && !patch.intent?.approved ? {
        discoveryStarted: false,
        ...(d.intent?.reply?.plan ? {
          goal: d.goal === d.intent.reply.plan.summary ? "" : d.goal,
          description: d.description === d.intent.reply.plan.summary ? "" : d.description,
          audience: d.audience === d.intent.reply.plan.audience ? "" : d.audience,
        } : {}),
      } : {}),
      ...(Object.hasOwn(patch, "intent") && !patch.intent ? { market: {} } : {}),
    }));
    setError("");
  }
  function addDomain(raw: string) {
    const name = canonicalDomain(raw);
    if (!name || name.length > 48) { setError("Enter a domain with 1 to 48 characters."); return; }
    if (draft.domains.some(d => d.toLowerCase() === name.toLowerCase())) { setDomain(""); return; }
    if (draft.domains.length >= 2) { setError("Choose up to two domains. Remove one before adding another."); return; }
    update({ domains: [...draft.domains, name] }); setDomain("");
  }
  const all = buildCatalog(draft.domains, draft.market);
  const eligible = catalog(draft);
  const visibleIds = new Set(eligible.map(a => a.id));
  const hidden = all.filter(a => !visibleIds.has(a.id));
  const shown = rankForIntent(eligible, plan).filter(a => `${a.name} ${a.tagline} ${a.features.map(f => `${f.name} ${f.description}`).join(" ")}`.toLowerCase().includes(query.trim().toLowerCase()));
  const custom = draft.customFeatures || [];
  const selectedCount = Object.values(draft.selected).filter(ids => ids.length).length;
  const selectedFeatureIds = new Set(Object.values(draft.selected).flat());
  const own = custom.filter(f => !all.some(a => a.features.some(item => item.id === f.id)));
  function selectAll(appId: string, ids: string[]) {
    update({ selected: { ...draft.selected, [appId]: ids }, customFeatures: custom.filter(f => !all.find(a => a.id === appId)?.features.some(item => item.id === f.id) || ids.includes(f.id)) });
  }
  function select(appId: string, id: string, checked: boolean) {
    selectAll(appId, checked ? [...new Set([...(draft.selected[appId] || []), id])] : (draft.selected[appId] || []).filter(f => f !== id));
  }
  async function submit() {
    if (!selectedCount || selectedCount > 5) { setError("Choose one to five reference apps."); return; }
    if (selectedFeatureIds.size + own.length > 20) { setError("Choose up to 20 features for this first version."); return; }
    if (custom.some(f => !f.name.trim() || !f.description.trim())) { setError("Give each custom feature a name and description."); return; }
    await confirm({ ...draft, name: draft.name.trim() || `${draft.domains[0] || "My"} app`.slice(0, 60) });
  }
  return <div className="studio-discovery">
    {!searching ? <>
      <IntentPanel draft={draft} update={update} onApproved={() => setDraft(d => startDiscovery(d, "idea"))} />
      <section id="studio-domains" tabIndex={-1} className="studio-card" aria-label="Select your domains"><h2>Select your domains</h2><p className="studio-note">Choose up to two. You can also enter your own.</p>
        <div className="studio-domain-grid">{domains.slice(0, 6).map(item => <button key={item.name} type="button" aria-pressed={draft.domains.includes(item.name)} disabled={busy} onClick={() => draft.domains.includes(item.name) ? update({ domains: draft.domains.filter(d => d !== item.name) }) : addDomain(item.name)}><Icon name={item.icon} size={23} /><strong>{item.name}</strong><span>{item.description}</span></button>)}</div>
        <form className="studio-domain-entry" onSubmit={event => { event.preventDefault(); addDomain(domain); }}><label htmlFor="studio-domain">Enter a domain</label><div className="studio-inline"><input id="studio-domain" value={domain} maxLength={48} onChange={e => setDomain(e.target.value)} placeholder="For example: simple puzzle games" /><button className="studio-button secondary" disabled={busy || !domain.trim()}>Add domain</button></div></form>
        <div className="studio-domain-chips">{draft.domains.map(name => <button key={name} aria-label={`Remove ${name}`} onClick={() => update({ domains: draft.domains.filter(d => d !== name) })}>{name}<Icon name="X" size={14} /></button>)}</div>
        <button className="studio-button primary" disabled={busy || !draft.domains.length || draft.domains.length > 2} onClick={() => { setDraft(d => startDiscovery(d, "domains")); setError(""); }}>Explore selected domains <Icon name="ArrowRight" size={17} /></button>
      </section>
    </> : <>
      <button className="studio-text-button" onClick={() => update({ discoveryStarted: false })}><Icon name="ArrowLeft" size={15} />Edit idea or domains</button>
      {plan && <div className="studio-card"><h2>Your confirmed search</h2><p>{plan.summary}</p><p className="studio-note">{plan.features.map(f => f.name).join(" · ")}</p></div>}
      <div className="studio-selection-layout">
      <section className="studio-card studio-reference-panel" aria-label="Market signals"><h2>Explore reference apps</h2><p>Click a card to select its features. Use its arrow to explore and customize them.</p>
        {!market.connection?.available && <p role="status" className="studio-note">{market.connection?.reason || "Connecting to the app store…"} <button className="studio-text-button" onClick={() => void market.check()}>Check connection</button></p>}
        {draft.domains.map(name => {
          const scan = draft.market?.[name], pending = market.scans[name], summaries = listing.states[name];
          const fits = scan?.apps.filter(a => eligible.some(e => e.id === a.appId)).length || 0;
          return <div className="studio-scan-row" key={name}><div><strong>{name}</strong><p className="studio-note" role="status">{pending?.phase === "scanning" ? "Searching Google Play…" : pending?.phase === "error" ? pending.message : scan ? `${fits} shown · ${scan.ranked} ranked${scan.failedRequests ? " · some requests failed" : ""}` : "Waiting for app search"}</p>{summaries?.phase === "running" && <p role="status" className="studio-note">Reading store listings… Feature summaries are still processing.</p>}{summaries?.phase === "error" && <p role="alert" className="studio-note">{summaries.message} <button className="studio-text-button" onClick={() => void listing.retry(name)}>Retry feature summaries</button></p>}{scan?.warnings.map(warning => <p key={warning} className="studio-note">{warning}</p>)}</div><button className="studio-text-button" disabled={pending?.phase === "scanning"} onClick={() => void market.scan(name, true)}>{pending?.phase === "error" ? "Retry search" : "Rescan"}</button></div>;
        })}
        <div className="studio-form-grid"><label>Find an app or feature<input value={query} onChange={e => setQuery(e.target.value)} /></label><label>App complexity<select value={draft.complexity || "simple"} onChange={e => update({ complexity: e.target.value as Draft['complexity'] })}><option value="simple">Simple apps only</option><option value="review">Include apps needing review</option></select></label></div>
        {hidden.length > 0 && <details className="studio-details"><summary>See what was filtered out ({hidden.length})</summary>{hidden.map(a => <p key={a.id}><strong>{a.name}</strong> — {referenceFit(a).reason}</p>)}</details>}
        {!shown.length && draft.domains.every(name => draft.market?.[name] && market.scans[name]?.phase !== "scanning") && <p role="status">{all.length ? "Apps were found, but none match these filters. Adjust the filter or your search." : "No apps were found for this search. Try another domain or rescan."}</p>}
        {!listing.connection?.available && eligible.some(a => !a.market?.listedFeatures) && <p className="studio-note">{listing.connection?.reason || "Connecting to feature summaries…"} <button className="studio-text-button" onClick={() => void listing.check()}>Retry summary connection</button></p>}
        <ReferenceApps apps={shown} selections={draft.selected} custom={custom} disabled={busy} select={select} selectAll={selectAll} customize={(appId, f) => update({ selected: { ...draft.selected, [appId]: [...new Set([...(draft.selected[appId] || []), f.id])] }, customFeatures: [...custom.filter(x => x.id !== f.id), f] })} matches={a => featureMatches(a, plan)} />
      </section>
      <aside className="studio-card studio-mix-panel" aria-label="Feature mixer"><FeatureMix apps={all} selections={draft.selected} custom={custom} disabled={busy} remove={select} removeCustom={id => update({ customFeatures: custom.filter(f => f.id !== id) })} />
        <label className="studio-input-label" htmlFor="studio-custom-feature">Your own feature idea</label><div className="studio-inline"><input id="studio-custom-feature" maxLength={120} value={feature} onChange={e => setFeature(e.target.value)} placeholder="Describe a feature you’d like to add" /><button className="studio-button secondary" disabled={busy || !feature.trim() || custom.length >= 20} onClick={() => { update({ customFeatures: [...custom, { id: `custom-${crypto.randomUUID()}`, name: feature.trim(), description: feature.trim() }] }); setFeature(""); }}>Add</button></div>
        <details className="studio-details"><summary>A few preferences, if you have them</summary><div className="studio-form-grid"><label>App name<input maxLength={60} value={draft.name} onChange={e => update({ name: e.target.value })} placeholder="We can start with your domain" /></label><label>Who is it for?<input maxLength={600} value={draft.audience} onChange={e => update({ audience: e.target.value })} /></label><label>Starting style<select value={draft.style} onChange={e => update({ style: e.target.value as Draft['style'] })}><option value="warm">Warm and welcoming</option><option value="sage">Calm and natural</option><option value="ink">Simple and focused</option></select></label></div></details>
        <p className="studio-note">Choose one to five apps. Only your selected and custom features go into the design.</p>
        <button className="studio-button primary" disabled={busy || !selectedCount} onClick={() => void submit()}>Confirm features and generate design <Icon name="Sparkles" size={17} /></button>
      </aside>
      </div>
    </>}
    {error && <p className="studio-error" role="alert">{error}</p>}
  </div>;
}
