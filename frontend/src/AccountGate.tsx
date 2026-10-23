import { createContext, useContext, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { api, ApiError } from "./api";
import { Icon } from "./icons";
import { modelChoices, recommendedModel } from "../../shared/model-selection";
import type { AccountStatus, ModelSelection } from "../../shared/model-selection";
import "./account.css";

const AccountContext = createContext<{ selection: ModelSelection; edit: () => void } | null>(null);
export function AccountControl() {
  const account = useContext(AccountContext);
  if (!account) return null;
  const name = modelChoices.find(model => model.id === account.selection.model)?.name || account.selection.model;
  return <button className="account-control" onClick={account.edit} aria-label="Account and model settings"><Icon name="Settings2" size={16} /><span>{name} <small>· {account.selection.effort}</small></span></button>;
}
export default function AccountGate({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AccountStatus | null>(null), [error, setError] = useState("");
  const [legacy, setLegacy] = useState(false), [editing, setEditing] = useState(false), [busy, setBusy] = useState(false);
  const [choice, setChoice] = useState<ModelSelection>(recommendedModel), [authCode, setAuthCode] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);
  const refresh = async () => {
    const next = await api<AccountStatus>("/api/account/status");
    setStatus(next); return next;
  };
  useEffect(() => {
    let active = true;
    api<AccountStatus>("/api/account/status").then(next => { if (!active) return; setStatus(next); if (next.selection) setChoice(next.selection); else if (next.login && ["starting", "waiting"].includes(next.login.status)) setChoice({ provider: next.login.provider, model: next.login.provider === "codex_cli" ? recommendedModel.model : "claude-sonnet-5-5", effort: "medium" }); if (!next.enabled) setLegacy(true); }).catch(err => {
      if (!active) return;
      // Older project-only API fixtures do not expose local account connections.
      if (err instanceof ApiError && err.status === 404) setLegacy(true);
      else setError((err as Error).message);
    });
    return () => { active = false; };
  }, []);
  const loginActive = status?.login && ["starting", "waiting"].includes(status.login.status);
  useEffect(() => {
    if (!loginActive) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try { await refresh(); } catch { if (!stopped) setError("Could not check sign-in. Check your connection and try again."); }
      if (!stopped) timer = setTimeout(poll, 2000);
    };
    timer = setTimeout(poll, 1000);
    return () => { stopped = true; clearTimeout(timer); };
  }, [Boolean(loginActive)]);
  useEffect(() => {
    if (editing) dialog.current?.showModal(); else dialog.current?.close();
  }, [editing]);
  const perform = async (work: () => Promise<void>) => {
    setBusy(true); setError("");
    try { await work(); } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };
  const chooseProvider = (provider: ModelSelection["provider"]) => {
    setChoice({ provider, model: provider === "codex_cli" ? recommendedModel.model : "claude-sonnet-5-5", effort: "medium" });
    setError(""); setAuthCode("");
  };
  const connect = () => perform(async () => {
    await api("/api/account/login", { provider: choice.provider }); await refresh();
  });
  const save = () => perform(async () => {
    await api("/api/account/model", choice); await refresh(); setEditing(false);
  });
  const providerName = choice.provider === "codex_cli" ? "OpenAI" : "Anthropic";
  const connection = status?.connections?.[choice.provider];
  const connected = connection?.loggedIn && !loginActive;
  const panel = <div className="account-panel">
    <div className="account-panel-heading"><span className="account-kicker">YOUR MODEL, YOUR CHOICE</span>{editing && <button className="account-icon-button" aria-label="Close account settings" onClick={() => setEditing(false)}><Icon name="X" size={20} /></button>}</div>
    <h2>{editing ? "Account & model" : "Connect your account"}</h2>
    <p>Use your OpenAI or Anthropic account to bring your app to life.</p>
    <div className="account-provider-picker" role="group" aria-label="Model provider">
      <button aria-pressed={choice.provider === "codex_cli"} disabled={busy || Boolean(loginActive)} onClick={() => chooseProvider("codex_cli")}><span className="account-provider-mark">O</span><span>OpenAI<small>via Codex</small></span>{choice.provider === "codex_cli" && <Icon name="CircleCheck" size={18} />}</button>
      <button aria-pressed={choice.provider === "claude_cli"} disabled={busy || Boolean(loginActive)} onClick={() => chooseProvider("claude_cli")}><span className="account-provider-mark">A</span><span>Anthropic<small>via Claude Code</small></span>{choice.provider === "claude_cli" && <Icon name="CircleCheck" size={18} />}</button>
    </div>
    <div className="account-recommendation"><Icon name="Sparkles" size={19} /><div><strong>GPT-6.1 Sol · Medium</strong><p>Recommended for a balance of performance and cost.</p></div></div>
    {error && <div className="account-error" role="alert">{error}</div>}
    {status?.login?.status === "failed" && <p className="account-error" role="alert">{status.login.message}</p>}
    {loginActive ? <div className="account-login-progress" role="status"><strong>{status?.login?.url ? "Finish signing in with your provider" : "Preparing secure sign-in…"}</strong>
      {status?.login?.url && <a className="account-primary" href={status.login.url} target="_blank" rel="noreferrer">Open {providerName} sign-in <Icon name="ExternalLink" size={16} /></a>}
      {status?.login?.code && <p>Enter this code on OpenAI’s page: <code>{status.login.code}</code></p>}
      {choice.provider === "claude_cli" && status?.login?.url && <form onSubmit={event => { event.preventDefault(); void perform(async () => { await api("/api/account/code", { id: status.login!.id, code: authCode }); setAuthCode(""); }); }}><label htmlFor="provider-code">If Anthropic shows an authorization code, paste it here</label><input id="provider-code" autoComplete="off" type="password" value={authCode} onChange={event => setAuthCode(event.target.value)} /><button type="submit" className="account-secondary" disabled={busy || !authCode.trim()}>Submit code</button></form>}
      <p className="account-note">This page updates when sign-in completes.</p><button className="account-link" disabled={busy} onClick={() => { void perform(async () => { await api("/api/account/cancel", {}); await refresh(); }); }}>Cancel sign-in</button>
    </div> : <>
      <div className="account-connection-status"><span className={connected ? "account-connected-dot" : "account-empty-dot"} /><span>{connected ? `${providerName} is signed in on this computer` : `Connect ${providerName} to continue`}</span>{connected && <button className="account-link" disabled={busy} onClick={() => { void connect(); }}>Change account</button>}</div>
      {!connected && <button className="account-primary" disabled={busy || !status} onClick={() => { void connect(); }}>Sign in with {providerName} <Icon name="ArrowRight" size={17} /></button>}
      <div className="account-model-fields">
        <div><label htmlFor="account-model">Model</label><select id="account-model" disabled={busy || !connected} value={choice.model} onChange={event => setChoice(current => ({ ...current, model: event.target.value }))}>{modelChoices.filter(model => model.provider === choice.provider).map(model => <option value={model.id} key={model.id}>{model.name}{model.id === recommendedModel.model ? " · Recommended" : ""}</option>)}</select></div>
        <div><label htmlFor="account-effort">Reasoning</label><select id="account-effort" disabled={busy || !connected} value={choice.effort} onChange={event => setChoice(current => ({ ...current, effort: event.target.value as ModelSelection["effort"] }))}><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option></select></div>
      </div>
      <button className="account-primary" disabled={busy || !connected} onClick={() => { void save(); }}>{busy ? "Connecting…" : editing ? "Save model choice" : "Continue to Meld"}<Icon name="ArrowRight" size={17} /></button>
      <p className="account-note">Your choice applies to new work. Access and usage limits depend on your provider account.</p>
    </>}
    <details className="account-terminal"><summary>Prefer signing in from the terminal?</summary><p>Run on the computer serving Meld:</p><code>{choice.provider === "codex_cli" ? "codex login --device-auth" : "claude auth login"}</code><button className="account-secondary" disabled={busy} onClick={() => { void perform(async () => { await refresh(); }); }}>Check connection again</button><p>Install the <a href={choice.provider === "codex_cli" ? "https://developers.openai.com/codex/cli" : "https://code.claude.com/docs/en/quickstart"} target="_blank" rel="noreferrer">official CLI</a> first if needed.</p></details>
    <p className="account-privacy"><Icon name="ShieldCheck" size={14} /><span>Sign-in is handled by the official CLI on this computer. Meld never asks for your account password. This connection is shared by this local workspace.</span></p>
    {editing && <button className="account-link account-disconnect" disabled={busy} onClick={() => { void perform(async () => { await api("/api/account/disconnect", {}); await refresh(); setEditing(false); }); }}>Disconnect from Meld</button>}
  </div>;
  if (legacy) return <>{children}</>;
  if (!status) return <div className="account-loading" role="status">{error ? <><p>{error}</p><button className="account-secondary" onClick={() => { void perform(async () => { await refresh(); }); }}>Try again</button></> : "Checking your model connection…"}</div>;
  if (!status.selection) return <div className="account-page"><div className="account-intro"><a className="account-logo" href="/">meld<span>.</span></a><div><span className="account-kicker">A LITTLE IDEA. A USEFUL APP.</span><h1>Your next app <br />starts here.</h1><p>Keep what works.<br />Bring good ideas together.<br />Make something of your own.</p><a href="/demos/index.html" className="account-demo-link">See what Meld can build <Icon name="ArrowRight" size={18} /></a></div><span className="account-intro-footer">Your idea → Your design → Your Android app</span></div><main className="account-main">{panel}</main></div>;
  return <AccountContext.Provider value={{ selection: status.selection, edit: () => { setChoice(status.selection!); setEditing(true); } }}>{children}<dialog aria-label="Account and model settings" className="account-dialog" ref={dialog} onCancel={() => setEditing(false)}>{panel}</dialog></AccountContext.Provider>;
}
