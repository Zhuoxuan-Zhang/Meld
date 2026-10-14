import { useEffect, useRef, useState } from "react";
import type { Draft } from "./state";
import { mergedFeatures } from "./state";
import { Icon } from "./icons";
import { designRequest, designUrl, jobFailure } from "./design";
import type { DesignConnection, DesignJob, DesignView, DesignProposal } from "./design";
import type { UserDocument as UserDocumentT } from "../../shared/contracts";
import { saveFile } from "./artifacts";
import { parseMarketResult } from "./market";
import type { MarketResult } from "./market";

type Props = { draft: Draft; update: (patch: Partial<Draft>) => void; receiveMarket: (domain: string, result: MarketResult) => void };
type Reference = UserDocumentT["features"][number]["refs"][number];
type HistoryItem = { id: string; version: number; created_at: string; authorship: { request: string }; changed_features: string[] };
function ReferenceDetails({ refs, design }: { refs: Reference[]; design: DesignView }) {
  const [values, setValues] = useState<unknown[]>([]), [error, setError] = useState("");
  const element = useRef<HTMLDetailsElement>(null), generation = useRef(0);
  function loadReferences() {
    const current = ++generation.current;
    Promise.all(refs.map(ref => designRequest<{ references: unknown[] }>(`${designUrl(design.id)}/references/${encodeURIComponent(ref.id)}?kind=${ref.kind}&revision=${design.revision}`)))
      .then(results => { if (generation.current === current) setValues(results.flatMap(r => r.references)); }).catch(() => { if (generation.current === current) setError("The developer reference could not be loaded."); });
  }
  useEffect(() => { setValues([]); setError(""); generation.current++; if (element.current?.open) loadReferences(); return () => { generation.current++; }; }, [design.id, design.revision]);
  return <details ref={element} className="design-evidence" onToggle={event => {
    if (!event.currentTarget.open || values.length) return;
    loadReferences();
  }}><summary>Developer details <Icon name="ChevronDown" size={14} /></summary>{error && <p>{error}</p>}{values.map((value, index) => <pre key={index}>{JSON.stringify(value, null, 2)}</pre>)}</details>;
}
export default function DesignPanel({ draft, update, receiveMarket }: Props) {
  const [connection, setConnection] = useState<DesignConnection | null>(null), [design, setDesign] = useState<DesignView | null>(null);
  const [proposal, setProposal] = useState<DesignProposal | null>(null), [selected, setSelected] = useState<string[]>([]);
  const [job, setJob] = useState<DesignJob | null>(null), [posting, setPosting] = useState(false);
  const [message, setMessage] = useState(""), [error, setError] = useState("");
  const [request, setRequest] = useState(() => { try { return sessionStorage.getItem(`meld.design-input.${draft.designId || "new"}`) || ""; } catch { return ""; } });
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [history, setHistory] = useState<HistoryItem[] | null>(null), [restoreTarget, setRestoreTarget] = useState<HistoryItem | null>(null);
  const postLock = useRef(false), textarea = useRef<HTMLTextAreaElement>(null);
  const callbacks = useRef({ update, receiveMarket }); callbacks.current = { update, receiveMarket };
  const busy = posting || job?.status === "queued" || job?.status === "running";
  const historical = design && design.revision !== design.current_revision;
  const resetMessage = () => { setError(""); setMessage(""); };
  async function refresh(id = draft.designId, revision?: string) {
    if (!id) return;
    const value = await designRequest<DesignView>(`${designUrl(id)}${revision ? `?revision=${revision}` : ""}`); setDesign(value); setEdits({}); return value;
  }
  useEffect(() => { designRequest<DesignConnection>("/api/design/status").then(setConnection).catch(() => setConnection(null)); }, []);
  useEffect(() => {
    if (!draft.designId) { setDesign(null); setProposal(null); return; }
    const controller = new AbortController();
    designRequest<DesignView>(designUrl(draft.designId), undefined, controller.signal).then(setDesign).catch(error => { if (!controller.signal.aborted) setError(error.message); });
    return () => controller.abort();
  }, [draft.designId]);
  useEffect(() => {
    if (!draft.designId || !draft.designProposalId) { setProposal(null); return; }
    const controller = new AbortController();
    designRequest<DesignProposal>(`${designUrl(draft.designId)}/changes/${draft.designProposalId}`, undefined, controller.signal).then(value => {
      setProposal(value); setSelected(value.plan.changes.map(change => change.id));
    }).catch(error => { if (!controller.signal.aborted) setError(error.message); }); return () => controller.abort();
  }, [draft.designId, draft.designProposalId]);
  useEffect(() => {
    try { sessionStorage.setItem(`meld.design-input.${draft.designId || "new"}`, request); } catch { /* Input remains in memory when storage is unavailable. */ }
  }, [request, draft.designId]);
  useEffect(() => {
    if (!draft.designJobId) return;
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    const check = async () => {
      try {
        const value = await designRequest<DesignJob>(`/api/design/jobs/${draft.designJobId}`, undefined, controller.signal);
        if (controller.signal.aborted) return; setJob(value);
        if (value.status === "queued" || value.status === "running") { timer = setTimeout(check, 1400); return; }
        if (value.status === "waiting_inputs") return;
        if (value.status === "failed") { setError(jobFailure(value)); callbacks.current.update({ designJobId: undefined }); return; }
        if (!value.result) throw new Error("The design request returned no result.");
        if ("document" in value.result) {
          setDesign(value.result); setProposal(null); setEdits({}); setHistory(null); setRestoreTarget(null);
          callbacks.current.update({ designId: value.result.id, designJobId: undefined, designProposalId: undefined });
          setMessage(value.result.implementation.status === "pending_update" ? "Design updated. The Android app still needs these changes implemented." : "Your readable design is ready.");
        } else {
          setProposal(value.result); setSelected(value.result.plan.changes.map(change => change.id));
          callbacks.current.update({ designJobId: undefined, designProposalId: value.result.id });
          setMessage(value.result.plan.disposition === "proposal" ? "Nothing has changed yet. Choose the suggestions you want to keep." : "Your saved design is unchanged.");
        }
      } catch (error) { if (!controller.signal.aborted) setError((error as Error).message); }
    };
    void check(); return () => { controller.abort(); clearTimeout(timer); };
  }, [draft.designJobId]);
  async function submit(url: string, body: unknown) {
    if (postLock.current) return; postLock.current = true; setPosting(true); resetMessage();
    try { const value = await designRequest<DesignJob>(url, body); setJob(value); callbacks.current.update({ designJobId: value.id }); }
    catch (error) { setError((error as Error).message); }
    finally { postLock.current = false; setPosting(false); }
  }
  async function generate() {
    if (postLock.current) return; postLock.current = true; setPosting(true); resetMessage();
    try {
      if (!draft.name.trim()) throw new Error("Give your app a name first.");
      const scans: MarketResult[] = [];
      for (const domain of draft.domains) {
        let scan = draft.market?.[domain];
        if (!scan?.scanId) {
          const output = await designRequest<{ result: unknown }>("/api/market/scan", { domain, refresh: false });
          scan = parseMarketResult(output.result); callbacks.current.receiveMarket(domain, scan);
        }
        if (!scan.scanId) throw new Error("Refresh your market signals before creating the design."); scans.push(scan);
      }
      const value = await designRequest<DesignJob>("/api/design/pipeline", {
        request_key: crypto.randomUUID(), scan_ids: scans.map(scan => scan.scanId),
        brief: { name: draft.name, audience: draft.audience, purpose: draft.description, goal: draft.goal, style: draft.style },
        preferences: Object.entries(draft.selected).filter(([id, features]) => features.length && scans.some(scan => scan.apps.some(app => app.appId === id))).map(([app_id, feature_ids]) => ({ app_id, feature_ids })),
        requested_features: [...new Set(Object.values(draft.selected).flat())],
        feature_requests: mergedFeatures(draft).map(({ id, name, description }) => ({ id, name, description })),
      });
      setJob(value); callbacks.current.update({ designJobId: value.id, designProposalId: undefined });
    } catch (error) { setError((error as Error).message); }
    finally { postLock.current = false; setPosting(false); }
  }
  function editFeature(title: string) { setRequest(`For “${title}”, I would like to `); textarea.current?.focus(); textarea.current?.scrollIntoView({ block: "center", behavior: "smooth" }); }
  async function exportInput() {
    if (!design) return;
    try { const input = await designRequest<unknown>(`${designUrl(design.id)}/build-input?revision=${design.revision}`); saveFile(JSON.stringify(input, null, 2), `${draft.name.trim() || "app"}-build-input.json`, "application/json"); }
    catch (error) { setError((error as Error).message); }
  }
  return <section className="surface design-panel" aria-label="Interactive design document">
    <div className="section-title"><div><span className="section-kicker">YOUR DESIGN, IN PLAIN LANGUAGE</span><h2>What your app will do</h2><p>Review the experience, make it yours, then pass the approved design to the coding pipeline.</p></div><Icon name="FileText" size={23} /></div>
    {message && <p className="design-feedback" role="status">{message}</p>}{error && <p className="design-error" role="alert">{error} <button className="design-link" onClick={() => { void refresh().catch(error => setError(error.message)); }}>Refresh design</button></p>}
    {busy && <div className="design-working" role="status"><Icon name="LoaderCircle" size={19} /><span>{job?.phase || (job?.kind === "propose" ? "Understanding your request and checking the details…" : "Reviewing the design and preparing a clear explanation…")}</span><p>You can leave this page. Your request is saved.</p></div>}
    {job?.status === "waiting_inputs" && <div className="design-waiting"><h3>Your references are saved</h3><p>{job.phase}</p><ul>{job.reference_apps?.map(app => <li key={app.appId}>{app.title}</li>)}</ul><button className="button secondary" disabled={busy} onClick={() => { void submit(`/api/design/pipeline/${job.id}/resume`, {}); }}>Check again</button><details><summary>Integration details</summary><p>The server needs reference APKs for: {job.missing_apps?.join(", ")}.</p><p>Store descriptions are market signals; they are not results of APK analysis.</p></details></div>}
    {!design && <div className="design-start"><p>Up to five ranked apps will become reference inputs for analysis. Your selected features express what you want; the detailed design will be based on the analyzed source files.</p><div className="design-actions"><button className="button primary" disabled={busy || !connection?.available} onClick={() => { void generate(); }}>Generate design <Icon name="Sparkles" size={16} /></button>{connection?.exampleId && <button className="button secondary" disabled={busy} onClick={() => { resetMessage(); callbacks.current.update({ designId: connection.exampleId!, designJobId: undefined, designProposalId: undefined }); }}>Open Notes example</button>}</div>{connection && !connection.available && <p className="fine-print">Connect the design model on the local server to generate or change a design.</p>}</div>}
    {design && <>
      <div className="design-doc-head"><div>{design.id === connection?.exampleId && <p className="design-caption">Notes example · based on our existing Android app, separately from the current market selection.</p>}<h3>{design.document.title}</h3><p>{design.document.summary}</p><span className="design-audience">For {design.document.audience}</span></div><div><span className="design-version">Design v{design.version}</span><p className="design-app-status">{design.implementation.status === "in_sync" ? "Matches the recorded Android app design." : design.implementation.status === "pending_update" ? "Design updated · Android app awaiting implementation." : "Ready for implementation."}</p></div></div>
      <div className="design-features">{design.document.features.map(feature => <article className="design-feature" key={feature.id}><h4>{feature.title}</h4><p>{feature.summary}</p><details className="design-journey"><summary>How it works</summary><ol>{feature.steps.map((step, index) => <li key={index}>{step}</li>)}</ol></details>{feature.examples.map((example, index) => <p className="design-caption" key={index}>For example: {example}</p>)}{feature.caveats.map((caveat, index) => <p className="design-caption" key={index}>{caveat}</p>)}<button className="design-link" disabled={busy || Boolean(historical)} onClick={() => editFeature(feature.title)}>Change this feature <Icon name="NotebookPen" size={13} /></button><ReferenceDetails refs={feature.refs} design={design} /></article>)}</div>
      <details className="design-section"><summary>Pages & appearance</summary><p>{design.document.appearance}</p><div className="design-screens">{design.document.screens.map(screen => <article key={screen.id}><h4>{screen.title}</h4><p>{screen.purpose}</p><ReferenceDetails refs={screen.refs} design={design} /></article>)}</div></details>
      <details className="design-section"><summary>Product choices & boundaries</summary>{design.document.choices.map(choice => <article key={choice.id}><h4>{choice.title}</h4><p>{choice.selected}</p><p className="design-caption">{choice.reason}</p><ReferenceDetails refs={choice.refs} design={design} /></article>)}<ul>{design.document.boundaries.map((boundary, index) => <li key={index}>{boundary}</li>)}</ul></details>
      <div className="design-links">{design.artifacts.filter(artifact => ["user-doc.md", "developer.html"].includes(artifact.name)).map(artifact => <a key={artifact.name} href={artifact.url} target="_blank" rel="noreferrer">{artifact.name === "user-doc.md" ? "Readable document" : "Full developer design"}<Icon name="ExternalLink" size={13} /></a>)}<button className="design-link" onClick={() => { void exportInput(); }}>Export approved build input <Icon name="Download" size={13} /></button><button className="design-link" onClick={async () => { try { if (history) setHistory(null); else setHistory((await designRequest<{ revisions: HistoryItem[] }>(`${designUrl(design.id)}/revisions`)).revisions); } catch (error) { setError((error as Error).message); } }}>Version history <Icon name="RotateCcw" size={14} /></button></div>
      {history && <div className="design-history"><p>Restoring saves a new version and keeps all previous versions.</p>{[...history].reverse().map(revision => <div key={revision.id}><span>v{revision.version}{revision.id === design.current_revision ? " · current" : ""}</span><p>{revision.authorship.request}</p><button className="design-link" disabled={busy} onClick={() => { void refresh(design.id, revision.id); }}>View</button>{revision.id !== design.current_revision && <button className="design-link" disabled={busy} onClick={() => setRestoreTarget(revision)}>Restore</button>}</div>)}</div>}
      {restoreTarget && <div className="design-confirm-restore"><p>Restore the content of v{restoreTarget.version} as a new design version? The Android app will stay as it is.</p><button className="button primary" disabled={busy} onClick={() => { void submit(`${designUrl(design.id)}/restore`, { base_revision: design.current_revision, target_revision: restoreTarget.id, idempotency_key: crypto.randomUUID() }); }}>Confirm restore</button><button className="button secondary" disabled={busy} onClick={() => setRestoreTarget(null)}>Cancel</button></div>}
      {historical ? <div className="design-readonly"><p>You are reading a historical version.</p><button className="button secondary" onClick={() => { void refresh(); }}>Back to current design</button></div> : <div className="design-customize"><h3>Make it yours</h3><p>Choose a setting or tell us what to change. You’ll review suggestions before anything is saved.</p><div className="design-controls">{design.controls.map(control => <label key={control.id}><span>{control.label}</span>{control.type === "color" ? <input aria-label={control.label} type="color" value={edits[control.id] ?? control.value} disabled={busy} onChange={event => setEdits(current => ({ ...current, [control.id]: event.target.value }))} /> : <select aria-label={control.label} value={edits[control.id] ?? control.value} disabled={busy} onChange={event => setEdits(current => ({ ...current, [control.id]: event.target.value }))}>{control.options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select>}</label>)}</div><label className="form-label" htmlFor="design-request">What would you like to change?</label><textarea ref={textarea} id="design-request" value={request} maxLength={6000} rows={3} onChange={event => setRequest(event.target.value)} placeholder="For example: pin important notes, and use a deep green accent." /><button className="button primary" disabled={busy || !connection?.available} onClick={() => {
        const changes = Object.entries(edits).filter(([id, value]) => { const current = design.controls.find(control => control.id === id)?.value; return id === "primary-color" ? value.toLowerCase() !== current?.toLowerCase() : value !== current; }).map(([control_id, value]) => ({ control_id, value }));
        if (!request.trim() && !changes.length) { setError("Choose a setting or describe a change first."); return; }
        void submit(`${designUrl(design.id)}/changes`, { base_revision: design.revision, idempotency_key: crypto.randomUUID(), text: request, edits: changes });
      }}>Suggest changes <Icon name="Sparkles" size={16} /></button></div>}
      {proposal && <section className="design-proposal" aria-label="Design change suggestions"><div className="design-proposal-head"><h3>{proposal.plan.disposition === "clarification" ? "A quick question" : proposal.plan.disposition === "no_change" ? "No design changes" : "Choose what to keep"}</h3><button className="design-link" disabled={busy} onClick={() => { callbacks.current.update({ designProposalId: undefined }); setProposal(null); setMessage("Suggestions canceled. Your saved design is unchanged."); }}>Cancel suggestions</button></div><p className="design-caption">Your request: {proposal.request_text}</p><p>{proposal.plan.response}</p>
        {proposal.plan.questions.map(question => <div className="design-question" key={question.id}><h4>{question.question}</h4>{question.options.map(option => <button className="button secondary" key={option} onClick={() => { setRequest(`${proposal.request_text}\n${question.question} My choice: ${option}`); textarea.current?.focus(); }}>{option}</button>)}</div>)}
        {proposal.plan.changes.map(change => <article className="design-change" key={change.id}><label><input type="checkbox" checked={selected.includes(change.id)} disabled={busy} onChange={event => setSelected(current => event.target.checked ? [...current, change.id] : current.filter(id => id !== change.id))} /><span>{change.title}</span></label><div className="design-before-after"><p><strong>Now</strong>{change.before}</p><p><strong>After</strong>{change.after}</p></div><p>{change.reason}</p><ul>{change.impacts.map((impact, index) => <li key={index}>{impact}</li>)}</ul>{change.depends_on.length > 0 && <p className="design-caption">Keep together with: {change.depends_on.map(id => proposal.plan.changes.find(item => item.id === id)?.title || id).join(", ")}</p>}<ReferenceDetails refs={change.refs} design={design} /></article>)}
        {proposal.plan.disposition === "proposal" && <><p className="design-caption">Only the selected suggestions will update the detailed design.</p><button className="button primary" disabled={busy || !selected.length || proposal.base_revision !== design.current_revision} onClick={() => { void submit(`${designUrl(design.id)}/changes/${proposal.id}/apply`, { base_revision: proposal.base_revision, idempotency_key: crypto.randomUUID(), selected_change_ids: selected }); }}>Confirm selected changes <Icon name="Check" size={16} /></button>{proposal.base_revision !== design.current_revision && <p className="design-error">These suggestions belong to an older design. Request new suggestions from the current version.</p>}</>}
      </section>}
    </>}
  </section>;
}
