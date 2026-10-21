import { useCallback, useEffect, useRef, useState } from "react";
import BrowserEmulator from "./BrowserEmulator";
import BuildRepair from "./BuildRepair";
import StudioDiscovery from "./StudioDiscovery";
import { handoffBody, handoffKey } from "./workflow";
import { loadDraft, storageKey } from "./state";
import type { Draft } from "./state";
import HighLevelReview from "./HighLevelReview";
import ReferenceApps, { FeatureMix } from "./ReferenceApps";
import { Icon } from "./icons";
import { api, action, projectUrl } from "./api";
import type { Availability, ProjectList, Project, Job } from "./api";
import type { Brief, Reference, FeatureRequest, Conflict, PipelineProgress } from "../../shared/contracts";
import { buildCatalog, referenceFit } from "./market";
import "./workspace.css";

const blank: Brief = { name: "", input: "", audience: "", purpose: "", goal: "", style: "warm", domains: [] };
type Step = "describe" | "review" | "app";
const steps: { id: Step; label: string }[] = [{ id: "describe", label: "Describe your app" }, { id: "review", label: "Review and customize" }, { id: "app", label: "Get your app" }];
function Evidence({ project, refs }: { project: Project; refs: Reference[] }) {
  const [data, setData] = useState<unknown[]>([]), [error, setError] = useState("");
  useEffect(() => { setData([]); setError(""); }, [project.currentDesignRevision]);
  return <details className="studio-evidence" onToggle={async event => { if (!event.currentTarget.open || data.length) return; try { const results = await Promise.all(refs.map(ref => api<{ references: unknown[] }>(`${projectUrl(project.id)}/references/${encodeURIComponent(ref.id)}?kind=${ref.kind}&revision=${project.currentDesignRevision}`))); setData(results.flatMap(value => value.references)); } catch { setError("The supporting detail could not be loaded."); } }}><summary>Developer details</summary>{error && <p>{error}</p>}{data.map((value, index) => <pre key={index}>{JSON.stringify(value, null, 2)}</pre>)}</details>;
}
function ProductChoice({ conflict, value, choose }: { conflict: Conflict; value?: string; choose: (value: string) => void }) {
  const content = <fieldset className="studio-conflict"><legend>{conflict.question}</legend>{conflict.options.map(option => <label key={option.id}><input type="radio" name={conflict.id} checked={value === option.id} onChange={() => choose(option.id)} /><span><strong>{option.behavior}</strong>{option.benefits.map(benefit => <small key={benefit}>{benefit}</small>)}{option.costs.map(cost => <small className="studio-tradeoff" key={cost}>Tradeoff: {cost}</small>)}</span></label>)}</fieldset>;
  return conflict.advanced ? <details className="studio-details"><summary>Implementation preference: {conflict.question}</summary>{content}</details> : content;
}
function PipelineStatus({ progress }: { progress: PipelineProgress }) {
  const labels = { pending: "Not started", running: "In progress", completed: "Complete", failed: "Needs attention", waiting: "Your choice needed" };
  return <div className="studio-card studio-pipeline" aria-label="Design generation progress">
    <h2>{progress.steps.some(step => step.status === "failed") ? "Design preparation stopped" : "Preparing your design"}</h2><ol className="studio-pipeline-steps">{progress.steps.map(step => <li key={step.id} data-status={step.status}><strong>{step.label}</strong><span>{labels[step.status]}</span></li>)}</ol>
  </div>;
}
export default function ProjectWorkspace() {
  const [project, setProject] = useState<Project | null>(null), [job, setJob] = useState<Job | null>(null), [availability, setAvailability] = useState<Availability | null>(null);
  const [step, setStep] = useState<Step>("describe"), [projects, setProjects] = useState<ProjectList["projects"]>([]);
  const [error, setError] = useState(""), [loading, setLoading] = useState(true), [posting, setPosting] = useState(false), [profileOpen, setProfileOpen] = useState(false);
  const [baseAppId, setBaseAppId] = useState<string | undefined>();
  const [selections, setSelections] = useState<Record<string, string[]>>({}), [custom, setCustom] = useState<FeatureRequest[]>([]), [featureInput, setFeatureInput] = useState("");
  const [request, setRequest] = useState(""), [edits, setEdits] = useState<Record<string, string>>({}), [selectedChanges, setSelectedChanges] = useState<string[]>([]), [choices, setChoices] = useState<Record<string, string>>({});
  const [history, setHistory] = useState<{ id: string; version: number; created_at: string; authorship: { request: string } }[] | null>(null);
  const [pollTick, setPollTick] = useState(0), [discoveryEpoch, setDiscoveryEpoch] = useState(0);
  const lock = useRef(false), projectId = useRef<string | null>(null), main = useRef<HTMLElement>(null);
  const busy = posting || job?.status === "queued" || job?.status === "running";
  const visibleError = error || (!posting && job?.status === "failed" ? job.error?.message || "This step could not finish. Your saved project is preserved." : "");
  const pollingJobId = project?.activeJobId || (job?.projectId === project?.id && ["queued", "running"].includes(job?.status || "") ? job?.id : null);
  const catalog = project ? buildCatalog(project.brief.domains, project.references) : [];
  const referenceApps = [...catalog].filter(app => app.market && !app.market.retained).sort((a, b) => (b.market?.score || 0) - (a.market?.score || 0) || (a.market?.rank || 0) - (b.market?.rank || 0) || a.id.localeCompare(b.id)).filter(app => referenceFit(app).level !== "complex");

  const outline = project?.needsResearch ? undefined : project?.highLevelDesign;
  const design = project?.needsDesign ? undefined : project?.design, decision = project?.pendingDecision;
  const candidate = project?.latestBuild?.status === "succeeded" ? project.latestBuild : project?.lastDeliveredBuild;
  const delivered = candidate?.revision === project?.currentDesignRevision && !project?.needsDesign ? candidate : null;
  const previousDelivery = Boolean(delivered && project?.latestBuild?.id !== delivered.id);
  const choosingFeatures = Boolean(project && !project.needsResearch && project.needsDesign && !outline && !project.activeJobId);
  const navigate = (next: Step) => { setStep(next); setHistory(null); main.current?.focus(); window.scrollTo({ top: 0, behavior: "smooth" }); };
  const load = useCallback(async (id: string) => {
    const value = await api<Project>(projectUrl(id)); if (projectId.current && projectId.current !== value.id) return value; setProject(current => current?.id === value.id && current.version > value.version ? current : value); projectId.current = value.id;
    return value;
  }, []);
  const openProject = useCallback(async (id: string) => {
    projectId.current = id; setLoading(true); setError(""); setJob(null);
    try { const value = await load(id); setBaseAppId(value.featurePreferences.baseAppId); setSelections(value.featurePreferences.selections); setCustom(value.featurePreferences.customRequests); localStorage.setItem("meld.project-id", id); historyReplace(id); setStep(value.latestBuild?.revision === value.currentDesignRevision && !value.needsDesign ? "app" : value.needsResearch ? "describe" : "review"); const latest = await api<{ job: Job | null }>(`${projectUrl(id)}/latest-job`); setJob(latest.job); if (latest.job?.status === "failed") setError(latest.job.error?.message || "This step stopped. Your saved progress is preserved."); }
    catch (error) { setError((error as Error).message); localStorage.removeItem("meld.project-id"); }
    finally { setLoading(false); }
  }, [load]);
  useEffect(() => {
    api<Availability>("/api/status").then(setAvailability).catch(() => setError("The app server is unavailable. Start the frontend and backend, then reload."));
    api<ProjectList>("/api/projects").then(value => setProjects(value.projects)).catch(() => undefined);
    let saved: string | null = new URLSearchParams(location.search).get("project"); try { saved ||= localStorage.getItem("meld.project-id") || loadDraft().projectId || null; } catch { /* The URL still identifies the saved project. */ }
    if (saved && /^project-[a-f\d-]{36}$/.test(saved)) void openProject(saved); else setLoading(false);
  }, [openProject]);
  useEffect(() => {
    if (!pollingJobId) return;
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const value = await api<Job>(`/api/jobs/${pollingJobId}`, undefined, "GET", controller.signal); if (controller.signal.aborted) return;
        setJob(value);
        if (value.status === "failed") setError(value.error?.message || "This step could not finish. Your saved project is preserved.");
        const current = await load(value.projectId); if (controller.signal.aborted) return;
        if (value.type === "research" && value.status === "succeeded") { setBaseAppId(current.featurePreferences.baseAppId); setSelections(current.featurePreferences.selections); setCustom(current.featurePreferences.customRequests); }
        if (value.status === "failed") { setError(value.error?.message || "This step could not finish. Your saved project is preserved."); return; }
        if (["queued", "running"].includes(value.status)) timer = setTimeout(poll, 1200);
      } catch (error) { if (!controller.signal.aborted) { setError((error as Error).message); timer = setTimeout(poll, 3000); } }
    };
    void poll(); return () => { controller.abort(); clearTimeout(timer); };
  }, [pollingJobId, load, pollTick]);
  useEffect(() => {
    if (!availability?.backgroundReferencesAvailable || !project || project.needsResearch || !project.needsDesign || project.referencePreparationId || !Object.keys(project.references).length) return;
    const controller = new AbortController();
    void api<Project>(`${projectUrl(project.id)}/reference-preparation`, {}, "POST", controller.signal).then(saved => {
      if (!controller.signal.aborted) setProject(current => current?.id === saved.id && saved.version >= current.version ? saved : current);
    }).catch(() => undefined);
    return () => controller.abort();
  }, [availability?.backgroundReferencesAvailable, project?.id, project?.needsResearch, project?.needsDesign, project?.referencePreparationId]);
  useEffect(() => {
    if (!project?.referencePreparation || !["queued", "running"].includes(project.referencePreparation.status) || pollingJobId) return;
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const current = await api<Project>(projectUrl(project.id), undefined, "GET", controller.signal);
        if (controller.signal.aborted || projectId.current !== current.id) return;
        setProject(current);
        if (["queued", "running"].includes(current.referencePreparation?.status || "")) timer = setTimeout(poll, 2500);
      } catch { if (!controller.signal.aborted) timer = setTimeout(poll, 5000); }
    };
    timer = setTimeout(poll, 1200);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [project?.id, project?.referencePreparation?.id, project?.referencePreparation?.status, pollingJobId]);
  useEffect(() => { if (job?.type === "detail" || job?.type === "build") setStep("app"); }, [job?.id]);
  useEffect(() => {
    setEdits({});
  }, [project?.currentDesignRevision]);
  useEffect(() => { if (decision?.kind === "design_changes") setSelectedChanges(decision.proposal.plan.changes.map(change => change.id)); setChoices(decision?.kind === "merge_choices" ? Object.fromEntries(decision.conflicts.map(conflict => [conflict.id, conflict.options[0]?.id || ""])) : {}); }, [decision?.id]);
  async function perform(work: () => Promise<void>) {
    if (lock.current) return; lock.current = true; setPosting(true); setError("");
    try { await work(); } catch (error) { setError((error as Error).message); if (projectId.current) await load(projectId.current).catch(() => undefined); }
    finally { lock.current = false; setPosting(false); }
  }
  async function startJob(path: string, body: unknown) {
    const task = await api<Job>(path, body); setJob(task); const current = await load(task.projectId);
    if (!current.activeJobId) { const finished = await api<Job>(`/api/jobs/${task.id}`); setJob(finished); if (finished.status === "failed") setError(finished.error?.message || "This step could not finish."); }
    setPollTick(value => value + 1); navigate(["build", "detail"].includes(task.type) ? "app" : "review");
  }
  async function discover(draft: Draft) {
    await perform(async () => {
      const body = handoffBody(draft), custom = draft.customFeatures || [];
      const selected = new Set(body.references.flatMap(app => app.features.map(f => f.id)));
      const handoff = { ...body, ...(project ? { projectId: project.id, expectedVersion: project.version } : {}), references: body.references.map(app => ({ ...app, features: app.features.map(f => custom.find(c => c.id === f.id) || f) })), customFeatures: custom.filter(f => !selected.has(f.id)) };
      const requestKey = await handoffKey({ workspace: draft.workspaceId, ...handoff });
      const saved = await api<Project>("/api/workflow/import", { requestKey, ...handoff });
      projectId.current = saved.id; setProject(saved); setBaseAppId(saved.featurePreferences.baseAppId); setSelections(saved.featurePreferences.selections); setCustom(saved.featurePreferences.customRequests);
      localStorage.setItem("meld.project-id", saved.id); localStorage.setItem(storageKey, JSON.stringify({ ...draft, projectId: saved.id })); historyReplace(saved.id);
      if (saved.activeJobId) { setJob(await api<Job>(`/api/jobs/${saved.activeJobId}`)); navigate("review"); }
      else if (saved.highLevelDesign || !saved.needsDesign) navigate("review");
      else await startJob(`${projectUrl(saved.id)}/design`, action(saved));
    });
  }
  async function example() {
    await perform(async () => {
      const saved = await api<Project>("/api/projects", { requestKey: crypto.randomUUID(), brief: { ...blank, input: "A personal offline notes app for writing, finding and organizing notes." }, exampleId: availability?.exampleId });
      await openProject(saved.id);
    });
  }
  async function generate() {
    if (!project) return;
    await perform(async () => {
      const preferences = { baseAppId, selections, customRequests: custom };
      const saved = JSON.stringify(preferences) === JSON.stringify(project.featurePreferences) ? project : await api<Project>(projectUrl(project.id), { expectedVersion: project.version, featurePreferences: preferences }, "PATCH"); setProject(saved);
      await startJob(`${projectUrl(saved.id)}/design`, action(saved));
    });
  }
  async function suggest() {
    if (!project || !design) return;
    await perform(() => startJob(`${projectUrl(project.id)}/changes`, { ...action(project), baseRevision: design.revision, text: request, edits: Object.entries(edits).map(([control_id, value]) => ({ control_id, value })) }));
  }
  async function confirm() {
    if (!project || !decision) return;
    await perform(() => startJob(`${projectUrl(project.id)}/decisions/${decision.id}/confirm`, decision.kind === "high_level_changes" ? { ...action(project), baseRevision: decision.baseRevision } : decision.kind === "merge_choices" ? { ...action(project), selections: decision.conflicts.map(conflict => ({ conflict_id: conflict.id, option_id: choices[conflict.id] })) } : { ...action(project), baseRevision: decision.proposal.base_revision, selectedChangeIds: selectedChanges }));
  }
  function selectFeature(appId: string, featureId: string, checked: boolean) {
    setSelections(current => ({ ...current, [appId]: checked ? [...new Set([...(current[appId] || []), featureId])] : (current[appId] || []).filter(id => id !== featureId) }));
    if (!checked) setCustom(current => current.filter(feature => feature.id !== featureId));
  }
  function customizeFeature(appId: string, feature: FeatureRequest) {
    selectFeature(appId, feature.id, true);
    setCustom(current => [...current.filter(item => item.id !== feature.id), feature]);
  }
  const baseApp = catalog.find(app => app.id === baseAppId);
  const featureNames = outline?.document.features.map(f => f.title) || design?.document.features.map(f => f.title) || [...new Map([...catalog.flatMap(app => app.features.filter(f => selections[app.id]?.includes(f.id))), ...custom].map(feature => [feature.id, feature.name])).values()];
  return <div className="studio"><a className="studio-skip" href="#studio-main">Skip to main content</a>
    <aside className={`studio-sidebar ${profileOpen ? "is-open" : ""}`} aria-label="Your app profile">
      <a className="studio-logo" href="/" onClick={event => { event.preventDefault(); navigate("describe"); }}><span><Icon name="Layers" size={24} /></span>meld<span className="studio-dot">.</span></a>
      <button className="studio-mobile-profile" aria-expanded={profileOpen} onClick={() => setProfileOpen(!profileOpen)}>Your app <Icon name="ChevronDown" size={18} /></button>
      <div className="studio-profile"><p className="studio-eyebrow">YOUR APP</p><h2>{outline?.document.title || design?.document.title || project?.brief.name || "An idea worth making"}</h2><p>{project?.brief.goal || project?.brief.purpose || project?.brief.input || "Describe an idea. Make it yours. Bring it to life."}</p>
        {project?.brief.audience && <p className="studio-audience"><Icon name="Heart" size={15} /><span>{project.brief.audience}</span></p>}
        {baseApp && <div className="studio-base-summary"><p className="studio-eyebrow">BASE APP</p><strong>{baseApp.name}</strong><p>Its UI layout and core purpose guide the design. Your selected features enhance it.</p></div>}
        {!choosingFeatures && featureNames.length > 0 && <><p className="studio-eyebrow">WHAT IT WILL DO</p><ul className="studio-profile-features">{[...new Set(featureNames)].slice(0, 8).map(name => <li key={name}><Icon name="Check" size={14} />{name}</li>)}</ul></>}
        {design && <span className="studio-pill">Design v{design.version}{project?.approvedRevision === design.revision ? " · approved" : " · ready to review"}</span>}
        {project && <button className="studio-text-button" disabled={busy} onClick={() => { navigate("describe"); }}>Edit app profile <Icon name="NotebookPen" size={14} /></button>}
      </div>
      <div className="studio-sidebar-bottom"><p><Icon name="ShieldCheck" size={16} />{project ? "Saved to your workspace" : "Your choices stay in your control"}</p><button className="studio-text-button" disabled={busy} onClick={() => { setProject(null); setBaseAppId(undefined); projectId.current = null; setJob(null); setError(""); localStorage.removeItem("meld.project-id"); localStorage.removeItem(storageKey); setDiscoveryEpoch(value => value + 1); historyReplace(null); navigate("describe"); }}>New app <Icon name="Plus" size={16} /></button></div>
    </aside>
    <div className="studio-body"><header className="studio-header"><span>Workspace <Icon name="ChevronRight" size={15} />{project?.brief.name || "Your next app"}</span><span className="studio-autosave"><i />{project ? "Saved" : "A little idea, a useful app"}</span></header>
      <main id="studio-main" ref={main} tabIndex={-1} className="studio-main">
        <nav className="studio-steps" aria-label="App creation steps">{steps.map((item, index) => <button key={item.id} aria-current={step === item.id ? "step" : undefined} disabled={(item.id !== "describe" && !project) || (item.id === "app" && (job?.type !== "detail" && (!project?.latestBuild || project.latestBuild.revision !== project.currentDesignRevision || project.needsDesign)))} onClick={() => navigate(item.id)}><span>{index + 1}</span>{item.label}</button>)}</nav>
        {visibleError && <div className="studio-error" role="alert"><Icon name="CircleAlert" size={18} /><div>{visibleError}{job?.status === "failed" && (job.type === "detail" || job.type === "design" && job.progress) && <button className="studio-text-button" disabled={busy} onClick={() => { void perform(() => startJob(`/api/jobs/${job.id}/resume`, {})); }}>Continue from saved progress <Icon name="ArrowRight" size={16} /></button>}{project && job?.status === "failed" && job.type === "design" && !job.progress && !job.resumable && <button className="studio-text-button" disabled={busy} onClick={() => { void perform(() => startJob(`${projectUrl(project.id)}/design`, action(project))); }}>Retry outline</button>}<button className="studio-text-button" onClick={() => { setError(""); if (project) void load(project.id); }}>Refresh project</button></div></div>}
        {loading ? <p role="status">Loading your app…</p> : <>
          {step === "describe" && <section className="studio-describe"><p className="studio-eyebrow">START WITH AN IDEA</p><h1>What would you love<br />your app to do?</h1><p className="studio-lead">Tell us what you need. We’ll find useful ideas, help you shape the experience, and turn your design into an Android app.</p>
            <StudioDiscovery key={`${project?.id || "new"}-${discoveryEpoch}`} initialBrief={project?.brief} projectId={project?.id} busy={busy} confirm={discover} />
            {availability?.featuredProject && <div className="studio-example" aria-label="Featured app example"><Icon name="Flower2" size={26} /><div><strong>{availability.featuredProject.name}</strong><p>{availability.featuredProject.baseAppName ? `Built around ${availability.featuredProject.baseAppName}. ` : ""}{availability.featuredProject.summary}</p></div><button className="studio-text-button" disabled={busy} onClick={() => { void openProject(availability.featuredProject!.id); }}>Open app example <Icon name="ArrowRight" size={16} /></button></div>}
            {availability?.exampleId && <div className="studio-example"><Icon name="NotebookPen" size={24} /><div><strong>See how a notes app comes together</strong><p>Explore our existing Notes design in your own project.</p></div><button className="studio-text-button" disabled={busy} onClick={() => { void example(); }}>Try the Notes example <Icon name="ArrowRight" size={16} /></button></div>}
            {projects.length > 0 && <details className="studio-details studio-project-list"><summary>Continue a saved app</summary>{projects.slice(0, 8).map(p => <button className="studio-project-row" key={p.id} onClick={() => { void openProject(p.id); }}><strong>{p.name}</strong><span>{p.input}</span><Icon name="ArrowRight" size={16} /></button>)}</details>}
          </section>}
          {step === "review" && project && <section><p className="studio-eyebrow">MAKE IT YOURS</p><h1>{outline || design ? "Your app, in plain language." : "Choose features from reference apps."}</h1><p className="studio-lead">{outline || design ? "Review what it will do, adjust the details, then approve the version you want to build." : "Explore the eligible apps found from market signals. Choose or customize their features, add your own, then confirm to generate your design document."}</p>
            {baseApp && (outline || design) && <div className="studio-foundation-banner"><strong>Built around {baseApp.name}</strong><p>Keep its core experience; adapt selected enhancements to fit.</p><button className="studio-text-button" disabled={busy} onClick={() => { void perform(async () => { const saved = await api<Project>(projectUrl(project.id), { expectedVersion: project.version, featurePreferences: project.featurePreferences }, "PATCH"); setProject(saved); setJob(null); navigate("review"); }); }}>Change base or features</button></div>}
            {busy && <div className="studio-progress" role="status"><Icon name="LoaderCircle" size={21} /><div><strong>{job?.phase || "Working on your app…"}</strong><p>Your project is saved. You can come back to this page.</p></div></div>}
            {job?.progress && <PipelineStatus progress={job.progress} />}
            {project.referencePreparation && !busy && <div className="studio-reference-preparation" role="status"><Icon name={["queued", "running"].includes(project.referencePreparation.status) ? "LoaderCircle" : "CircleCheck"} size={18} /><div><strong>{["queued", "running"].includes(project.referencePreparation.status) ? "Preparing references in the background" : "Reference preparation finished"}</strong><p>{["queued", "running"].includes(project.referencePreparation.status) ? `${project.referencePreparation.phase} Keep shaping your app while we work.` : "Available reference results will be reused after you approve your design."}</p></div></div>}

            {job?.status === "waiting_inputs" && <div className="studio-card studio-waiting"><h2>Continue preparing your design.</h2><p>We can use available references and market information to continue.</p><button className="studio-button secondary" disabled={busy} onClick={() => { void perform(() => startJob(`/api/jobs/${job.id}/resume`, {})); }}>Continue generating design <Icon name="ArrowRight" size={16} /></button></div>}
            {project.needsResearch && !busy && <div className="studio-card"><h2>Start with a little research.</h2><p>We’ll look for relevant apps and useful feature ideas.</p><button className="studio-button primary" onClick={() => navigate("describe")}>Explore ideas <Icon name="ArrowRight" size={16} /></button></div>}
            {!project.needsResearch && project.needsDesign && !outline && !project.activeJobId && <div className="studio-selection-layout">
              <div className="studio-card studio-reference-panel">
              <h2>What would you like to keep?</h2><p>Choose a base app to keep its core purpose, then select features to add or customize. Listing features are ideas, not verified APK behavior.</p>
              <ReferenceApps baseAppId={baseAppId} chooseBase={setBaseAppId} apps={referenceApps} selections={selections} custom={custom} disabled={busy} select={selectFeature} customize={customizeFeature} selectAll={(appId, ids) => { setSelections(current => ({ ...current, [appId]: ids })); if (!ids.length) setCustom(current => current.filter(feature => !catalog.find(app => app.id === appId)?.features.some(item => item.id === feature.id))); }} />
              {!referenceApps.length && <p className="studio-note">No ranked reference apps are available. Try another search topic.</p>}
              {Object.values(project.references).flatMap(scan => scan.warnings.map(warning => <p className="studio-note" key={`${scan.domain}:${warning}`}>{warning}</p>))}
              </div>
              <aside className="studio-card studio-mix-panel" aria-label="Feature mixer">
              <FeatureMix apps={catalog} selections={selections} custom={custom} disabled={busy} remove={selectFeature} removeCustom={id => setCustom(current => current.filter(feature => feature.id !== id))} />
              <label className="studio-input-label">Your own feature idea<div className="studio-inline"><input value={featureInput} maxLength={120} onChange={event => setFeatureInput(event.target.value)} placeholder="Describe a feature you’d like to add" /><button className="studio-button secondary" disabled={!featureInput.trim() || custom.length >= 20} onClick={() => { setCustom(current => [...current, { id: `custom-${crypto.randomUUID()}`, name: featureInput.trim(), description: featureInput.trim() }]); setFeatureInput(""); }}>Add</button></div></label>
              {custom.filter(feature => !catalog.some(app => app.features.some(item => item.id === feature.id))).map(feature => <div className="studio-custom-feature" key={feature.id}><label>Custom feature<textarea rows={2} value={feature.description} maxLength={1000} onChange={event => setCustom(current => current.map(item => item.id === feature.id ? { ...item, description: event.target.value } : item))} /></label><button aria-label={`Remove ${feature.name}`} onClick={() => setCustom(current => current.filter(f => f.id !== feature.id))}><Icon name="X" size={16} /></button></div>)}
              <p className="studio-note">Your base supplies the core experience. Selected and custom features enhance it; other apps are not included in full.</p>
              <button className="studio-button primary" disabled={busy || (!baseAppId && !Object.values(selections).some(ids => ids.length)) || custom.some(feature => !feature.name.trim())} onClick={() => { void generate(); }}>Confirm features and generate design <Icon name="Sparkles" size={17} /></button>
              </aside>
            </div>}
            {outline && <HighLevelReview project={project} busy={busy} save={document => { void perform(async () => { setProject(await api<Project>(`${projectUrl(project.id)}/high-level`, { expectedVersion: project.version, baseRevision: outline.revision, document }, "PATCH")); }); }} request={text => { void perform(() => startJob(`${projectUrl(project.id)}/changes`, { ...action(project), baseRevision: outline.revision, text, edits: [] })); }} confirm={() => { void confirm(); }} dismiss={() => { if (decision) void perform(async () => { setProject(await api<Project>(`${projectUrl(project.id)}/decisions/${decision.id}/dismiss`, { expectedVersion: project.version })); }); }} approve={() => { void perform(() => startJob(`${projectUrl(project.id)}/approve-outline`, { ...action(project), revision: outline.revision })); }} />}
            {decision?.kind === "merge_choices" && <div className="studio-card"><h2>A few choices shape your app.</h2><p>These reference apps take different approaches. Choose the experience you prefer.</p>{decision.conflicts.map(conflict => <ProductChoice key={conflict.id} conflict={conflict} value={choices[conflict.id]} choose={value => setChoices(current => ({ ...current, [conflict.id]: value }))} />)}{decision.conflicts.some(c => c.advanced) && <p className="studio-note">Implementation preferences have starting choices. Expand them to review or change those choices before confirming.</p>}<button className="studio-button primary" disabled={busy || decision.conflicts.some(c => !choices[c.id])} onClick={() => { void confirm(); }}>Use these choices <Icon name="Check" size={17} /></button></div>}
            {design && !project.needsDesign && !outline && <>
              <div className="studio-card studio-design"><div className="studio-section-head"><div><h2>{design.document.title}</h2><p>{design.document.summary}</p></div><span className="studio-pill">Version {design.version}</span></div><div className="studio-feature-grid">{design.document.features.map(feature => <article key={feature.id}><span className="studio-feature-icon"><Icon name="CircleCheck" size={21} /></span><h3>{feature.title}</h3><p>{feature.summary}</p><details className="studio-details"><summary>How it works</summary><ol>{feature.steps.map((text, index) => <li key={index}>{text}</li>)}</ol>{feature.examples.map(text => <p key={text}>For example: {text}</p>)}{feature.caveats.map(text => <p key={text}>{text}</p>)}</details><Evidence project={project} refs={feature.refs} /></article>)}</div>
                <details className="studio-details"><summary>Pages and appearance</summary><p>{design.document.appearance}</p><div className="studio-screen-grid">{design.document.screens.map(screen => <article key={screen.id}><Icon name="Monitor" size={22} /><h3>{screen.title}</h3><p>{screen.purpose}</p></article>)}</div></details><details className="studio-details"><summary>Product choices and boundaries</summary>{design.document.choices.map(choice => <p key={choice.id}><strong>{choice.title}: </strong>{choice.selected} {choice.reason}</p>)}<ul>{design.document.boundaries.map(text => <li key={text}>{text}</li>)}</ul></details>
              </div>
              <div className="studio-card studio-customize"><div className="studio-section-head"><div><h2>Make a small change. Or a big one.</h2><p>Choose a setting or tell us what you’d like. We’ll explain the proposed changes before saving them.</p></div><Icon name="Palette" size={24} /></div><div className="studio-form-grid">{design.controls.map(control => <label key={control.id}>{control.label}{control.type === "color" ? <input type="color" value={edits[control.id] || control.value} disabled={busy} onChange={event => setEdits(current => ({ ...current, [control.id]: event.target.value }))} /> : <select value={edits[control.id] || control.value} disabled={busy} onChange={event => setEdits(current => ({ ...current, [control.id]: event.target.value }))}>{control.options?.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select>}</label>)}</div><label className="studio-input-label" htmlFor="design-request">What would you like to change?</label><textarea id="design-request" value={request} onChange={event => setRequest(event.target.value)} rows={3} maxLength={6000} placeholder="For example, change the colors or make an action easier to use." /><button className="studio-button secondary" disabled={busy || (!request.trim() && !Object.keys(edits).length)} onClick={() => { void suggest(); }}>Review suggested changes <Icon name="Sparkles" size={16} /></button></div>
              {decision?.kind === "design_changes" && <div className="studio-card studio-proposal"><h2>{decision.proposal.plan.disposition === "proposal" ? "Choose what to keep." : decision.proposal.plan.disposition === "clarification" ? "Let’s clarify one thing." : "Your design is unchanged."}</h2><p>{decision.proposal.plan.response}</p>{decision.proposal.plan.questions.map(question => <div key={question.id}><h3>{question.question}</h3>{question.options.map(option => <button className="studio-button secondary" key={option} onClick={() => setRequest(`${decision.proposal.request_text}\n${question.question} My choice: ${option}`)}>{option}</button>)}</div>)}{decision.proposal.plan.changes.map(change => <article className="studio-change" key={change.id}><label><input type="checkbox" checked={selectedChanges.includes(change.id)} onChange={event => setSelectedChanges(current => event.target.checked ? [...current, change.id] : current.filter(id => id !== change.id))} /><strong>{change.title}</strong></label><div className="studio-before-after"><p><small>NOW</small>{change.before}</p><p><small>AFTER</small>{change.after}</p></div><p>{change.reason}</p><ul>{change.impacts.map(impact => <li key={impact}>{impact}</li>)}</ul>{change.depends_on.length > 0 && <p>Keep together with: {change.depends_on.join(", ")}</p>}</article>)}<div className="studio-actions">{decision.proposal.plan.disposition === "proposal" && <button className="studio-button primary" disabled={busy || !selectedChanges.length} onClick={() => { void confirm(); }}>Confirm selected changes <Icon name="Check" size={16} /></button>}<button className="studio-text-button" disabled={busy} onClick={() => { void perform(async () => { setProject(await api<Project>(`${projectUrl(project.id)}/decisions/${decision.id}/dismiss`, { expectedVersion: project.version })); setEdits({}); }); }}>Dismiss suggestions</button></div></div>}
              <div className="studio-build-bar"><div><strong>Happy with how your app will work?</strong><p>This exact design version will be used for the Android build.</p></div><button className="studio-button primary" disabled={busy || Boolean(decision)} onClick={() => { void perform(() => startJob(`${projectUrl(project.id)}/builds`, { ...action(project), revision: design.revision })); }}>Approve and build <Icon name="ArrowRight" size={17} /></button></div>
              <details className="studio-details"><summary>Design history and development files</summary><div className="studio-actions">{design.artifacts.filter(artifact => ["user-doc.md", "developer.html", "final-design.json"].includes(artifact.name)).map(artifact => <a className="studio-text-button" href={artifact.url} target="_blank" rel="noreferrer" key={artifact.name}>{artifact.name === "user-doc.md" ? "Readable design" : artifact.name === "developer.html" ? "Developer details" : "Detailed JSON"}<Icon name="ExternalLink" size={13} /></a>)}<button className="studio-text-button" onClick={() => { void api<{ revisions: NonNullable<typeof history> }>(`${projectUrl(project.id)}/revisions`).then(result => setHistory(result.revisions)); }}>Version history</button></div>{history?.map(revision => <div className="studio-history-row" key={revision.id}><span>Version {revision.version} · {revision.authorship.request}</span>{revision.id !== project.currentDesignRevision && <button className="studio-text-button" disabled={busy} onClick={() => { if (window.confirm(`Restore version ${revision.version} as a new design version?`)) void perform(() => startJob(`${projectUrl(project.id)}/restore`, { ...action(project), baseRevision: design.revision, targetRevision: revision.id })); }}>Restore</button>}</div>)}</details>
            </>}
            {Object.values(project.references).length > 0 && <details className="studio-details studio-research"><summary>Explore the research behind these ideas</summary><p>Store listings and reviews are market signals. Verified behavior comes from analyzing the reference APKs.</p>{Object.values(project.references).map(scan => <div key={scan.domain}><h3>{scan.domain}</h3><p>{scan.status === "complete" ? "Top reference apps" : "Partial research results"} · {scan.generatedAt.slice(0, 10)}</p>{scan.apps.filter(app => !app.retained).map(app => <a className="studio-reference" href={app.storeUrl} target="_blank" rel="noreferrer" key={app.appId}><span className="studio-reference-rank">{app.rank}</span><div><strong>{app.title}</strong><p>{app.summary}</p><small>{app.rating === null ? "Not rated" : `${app.rating.toFixed(1)} stars`} · Opportunity {app.score}/15</small></div><Icon name="ExternalLink" size={16} /></a>)}{scan.warnings.map(warning => <p className="studio-note" key={warning}>{warning}</p>)}</div>)}</details>}
          </section>}
          {step === "app" && project && <section><p className="studio-eyebrow">FROM IDEA TO APP</p><h1>{busy ? delivered ? "Updating your Android app." : "Bringing your app to life." : job?.status === "failed" ? "Your app preparation stopped." : delivered?.status === "succeeded" ? "Your Android app is ready." : "Bringing your app to life."}</h1><p className="studio-lead">{project.brief.name || design?.document.title} · {delivered?.revision || project.currentDesignRevision}</p>{busy && <div className="studio-progress" role="status"><Icon name="LoaderCircle" size={22} /><div><strong>{job?.phase || "Building your approved design…"}</strong><p>Implementation, build and checks all belong to this saved design version.</p></div></div>}{job?.progress && <PipelineStatus progress={job.progress} />}
            <div className="studio-card studio-delivery"><div className="studio-delivery-icon"><Icon name="Monitor" size={38} /></div><h2>{previousDelivery ? "Your previous build is available." : delivered?.status === "succeeded" ? "A real app, ready for your phone." : "Your approved design is saved."}</h2><p>{previousDelivery ? "This is the earlier APK. The latest build has not passed its checks yet." : delivered?.status === "succeeded" ? "Download the APK and install it on your Android device." : "We’ll show the download here once the implementation and build checks pass."}</p>{delivered?.status === "succeeded" && delivered.artifacts.filter(artifact => artifact.name.endsWith(".apk")).map(artifact => <a className="studio-button primary" href={artifact.url} key={artifact.name}>{previousDelivery ? "Download previous build" : "Download Android app"} <Icon name="Download" size={17} /></a>)}{delivered?.validation && <p className="studio-note">Build, unit tests and lint passed. {delivered.validation.runtimeVerified ? "Device checks passed." : "Device workflow checks are pending."} {delivered.validation.visualVerified ? "Reference screen comparison passed." : "Reference runtime comparison is pending."}</p>}{delivered?.artifacts.filter(artifact => artifact.name === "ui-comparison.html").map(artifact => <a className="studio-text-button" href={artifact.url} key={artifact.name}>Download screen comparison <Icon name="Download" size={15} /></a>)}{!busy && delivered?.status !== "succeeded" && design && <button className="studio-button primary" onClick={() => { void perform(() => startJob(`${projectUrl(project.id)}/builds`, { ...action(project), revision: design.revision })); }}>Retry build</button>}<button className="studio-text-button" onClick={() => navigate("review")}>Back to your design <Icon name="ArrowLeft" size={15} /></button></div>
            {delivered?.status === "succeeded" && project.latestBuild?.id === delivered.id && delivered.revision === project.currentDesignRevision && !project.needsDesign && <BrowserEmulator key={`emulator-${delivered.id}`} projectId={project.id} buildId={delivered.id} available={Boolean(availability?.emulatorAvailable)} />}
            {delivered?.status === "succeeded" && !project.pendingDecision && <BuildRepair key={`repair-${delivered.id}`} busy={Boolean(busy)} submit={description => { void perform(() => startJob(`${projectUrl(project.id)}/builds`, { ...action(project), revision: delivered.revision, feedback: { buildId: delivered.id, description } })); }} />}
            {!busy && delivered?.status === "succeeded" && job?.type === "build" && job.status === "failed" && design && <button className="studio-button secondary" onClick={() => { void perform(() => startJob(`${projectUrl(project.id)}/builds`, { ...action(project), revision: design.revision })); }}>Retry build</button>}
            {delivered?.artifacts.length ? <details className="studio-details"><summary>Build files and verification</summary>{delivered.artifacts.filter(a => !a.name.endsWith(".apk")).map(artifact => <a className="studio-project-row" href={artifact.url} key={artifact.name}>{artifact.name}<Icon name="Download" size={15} /></a>)}</details> : null}
          </section>}
        </>}
        <footer className="studio-footer"><span>meld<span>.</span></span><p>Good ideas. Your choices. One useful app.</p></footer>
      </main>
    </div>
  </div>;
}
function historyReplace(id: string | null) { const url = new URL(location.href); url.search = id ? `?project=${encodeURIComponent(id)}` : ""; url.hash = ""; window.history.replaceState({}, "", url); }
