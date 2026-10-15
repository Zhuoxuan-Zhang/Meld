import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "./api";
import { Icon } from "./icons";
import type { EmulatorSession } from "../../shared/contracts";

export default function BrowserEmulator({ projectId, buildId, available }: { projectId: string; buildId: string; available: boolean }) {
  const base = `/api/projects/${projectId}/builds/${buildId}/emulator`;
  const [session, setSession] = useState<EmulatorSession | null>(null), [opening, setOpening] = useState(false), [error, setError] = useState(""), [image, setImage] = useState(""), [text, setText] = useState("");
  const active = useRef<EmulatorSession | null>(null), imageUrl = useRef(""), pointer = useRef<{ x: number; y: number; time: number } | null>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; if (imageUrl.current) URL.revokeObjectURL(imageUrl.current); if (active.current) void fetch(`${base}/${active.current.id}`, { method: "DELETE", keepalive: true }).catch(() => undefined); }; }, [base]);
  useEffect(() => {
    if (!session) return;
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        if (document.hidden) { timer = setTimeout(poll, 3000); return; }
        if (session.status !== "ready") {
          const current = await api<EmulatorSession>(`${base}/${session.id}`, undefined, "GET", controller.signal);
          if (controller.signal.aborted) return;
          active.current = current; setSession(current);
          if (current.status === "failed") { setError(current.phase); return; }
          if (current.status === "starting") timer = setTimeout(poll, 1200);
          return;
        }
        const response = await fetch(`${base}/${session.id}/frame`, { signal: controller.signal, cache: "no-store" });
        if (!response.ok) { const result = await response.json(); throw new ApiError(result.error?.code || "emulator_frame", result.error?.message || "The Android screen could not be loaded.", response.status); }
        const frame = await response.blob(); if (controller.signal.aborted) return;
        const next = URL.createObjectURL(frame); if (imageUrl.current) URL.revokeObjectURL(imageUrl.current); imageUrl.current = next; setImage(next); setError("");
        timer = setTimeout(poll, document.hidden ? 3000 : 600);
      } catch (error) { if (!controller.signal.aborted) { setError((error as Error).message); if (error instanceof ApiError && error.status === 404) { active.current = null; setSession(null); setImage(""); if (imageUrl.current) URL.revokeObjectURL(imageUrl.current); imageUrl.current = ""; } else timer = setTimeout(poll, 2500); } }
    };
    void poll(); return () => { controller.abort(); clearTimeout(timer); };
  }, [session?.id, session?.status, base]);
  async function open() {
    setOpening(true); setError("");
    try {
      const result = await api<EmulatorSession>(base, {});
      if (!mounted.current) { void fetch(`${base}/${result.id}`, { method: "DELETE", keepalive: true }).catch(() => undefined); return; }
      active.current = result; setSession(result);
    } catch (error) { if (mounted.current) setError((error as Error).message); }
    finally { if (mounted.current) setOpening(false); }
  }
  async function close() {
    const current = active.current;
    if (!current) return;
    try { await api(`${base}/${current.id}`, undefined, "DELETE"); active.current = null; setSession(null); setImage(""); setError(""); if (imageUrl.current) URL.revokeObjectURL(imageUrl.current); imageUrl.current = ""; }
    catch (error) { setError((error as Error).message); }
  }
  async function input(value: unknown) {
    if (!session || session.status !== "ready") return false;
    try { await api(`${base}/${session.id}/input`, value); setError(""); return true; }
    catch (error) { if (mounted.current) setError((error as Error).message); return false; }
  }
  const point = (event: React.PointerEvent<HTMLImageElement>) => { const rect = event.currentTarget.getBoundingClientRect(); return { x: Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)), y: Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height)) }; };
  return <section className="studio-card studio-emulator" aria-label="Browser Android emulator"><div className="studio-emulator-heading"><div><p className="studio-eyebrow">TRY YOUR APP</p><h2>Open it right here.</h2><p>Run this APK on an Android phone in your browser.</p></div><span className="studio-pill">Android</span></div>
    {!session && <><button className="studio-button primary" disabled={!available || opening} onClick={() => { void open(); }}>{opening ? "Opening your Android phone…" : "Try app in browser"}<Icon name="Play" size={17} /></button>{!available && <p className="studio-note">Browser preview is unavailable on this server. You can still download the APK.</p>}</>}
    {session && <><div className="studio-emulator-toolbar"><span role="status">{session.phase}</span><button className="studio-text-button" onClick={() => { void close(); }}>Close preview <Icon name="X" size={15} /></button></div>{session.status === "starting" && <div className="studio-emulator-loading" role="status"><Icon name="LoaderCircle" size={24} /><p>Starting the phone and installing your app…</p><small>The first launch can take a little longer.</small></div>}
      {session.status === "ready" && <div className="studio-emulator-device"><div className="studio-emulator-phone">{image ? <img src={image} alt="Interactive Android screen" draggable={false} tabIndex={0} aria-label="Interactive Android screen. Click or swipe to use the app." onContextMenu={event => event.preventDefault()} onPointerDown={event => { event.currentTarget.setPointerCapture(event.pointerId); pointer.current = { ...point(event), time: Date.now() }; }} onPointerCancel={() => { pointer.current = null; }} onPointerUp={event => { const start = pointer.current; pointer.current = null; if (!start) return; const end = point(event); if (Math.hypot(end.x - start.x, end.y - start.y) > .025) void input({ type: "swipe", x: start.x, y: start.y, endX: end.x, endY: end.y, duration: Math.min(1500, Math.max(100, Date.now() - start.time)) }); else void input({ type: "tap", ...end }); }} onKeyDown={event => { const key = ({ Backspace: "delete", Enter: "enter", Escape: "back", ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right" } as Record<string, string>)[event.key]; if (key) { event.preventDefault(); void input({ type: "key", key }); } }} /> : <p role="status">Loading the Android screen…</p>}</div><div className="studio-emulator-controls"><button className="studio-button secondary" onClick={() => { void input({ type: "key", key: "back" }); }}><Icon name="ArrowLeft" size={15} />Back</button><button className="studio-button secondary" onClick={() => { void input({ type: "restart" }); }}><Icon name="RotateCcw" size={15} />Restart app</button></div><form className="studio-emulator-text" onSubmit={event => { event.preventDefault(); if (text.trim()) { if (!/^[\x20-\x7e]+$/.test(text) || text.includes("%s")) { setError("Use English letters, numbers and punctuation in this field."); return; } const submitted = text; void input({ type: "text", text }).then(accepted => { if (accepted && mounted.current) setText(current => current === submitted ? "" : current); }); } }}><label htmlFor={`emulator-text-${buildId}`}>Type into the app</label><div><input id={`emulator-text-${buildId}`} value={text} maxLength={300} onChange={event => setText(event.target.value)} placeholder="Tap a field, then type English text" /><button className="studio-button secondary" disabled={!text.trim()} type="submit">Send</button></div></form><p className="studio-note">Click or swipe the phone screen. Preview data stays on this test phone.</p></div>}</>}
    {error && <p className="studio-emulator-error" role="alert">{error}</p>}
  </section>;
}
