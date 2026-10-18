import { useState } from "react";
import { Icon } from "./icons";

export default function BuildRepair({ busy, submit }: { busy: boolean; submit: (description: string) => void }) {
  const [description, setDescription] = useState("");
  return <div className="studio-card studio-customize">
    <h2>Found a problem?</h2>
    <p>Tell us what you did, what happened, and what you expected. We’ll repair this app and build it again.</p>
    <label className="studio-input-label" htmlFor="app-repair">What needs fixing?</label>
    <textarea id="app-repair" value={description} onChange={event => setDescription(event.target.value)} maxLength={3000} rows={4} disabled={busy} placeholder="For example: locking the screen ends my focus session. The timer should keep running." />
    <button className="studio-button secondary" disabled={busy || !description.trim()} onClick={() => submit(description.trim())}>Repair and rebuild <Icon name="Sparkles" size={16} /></button>
    <p className="studio-note">To add features or change how the app should work, go back to your design.</p>
  </div>;
}
