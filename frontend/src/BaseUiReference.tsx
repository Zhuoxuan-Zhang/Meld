import type { BaseUiReferenceT, BaseUiMappingT } from '../../pipeline/src/base-ui';

export default function BaseUiReference({ reference, mapping }: { reference?: BaseUiReferenceT; mapping?: BaseUiMappingT }) {
  if (!reference) return null;
  return <section className="studio-card studio-base-ui" aria-label="Base app UI reference">
    <p className="studio-eyebrow">UI FOUNDATION</p>
    <h2>Based on {reference.title}’s layout</h2>
    <p>{reference.visual.summary}</p>
    <p className="studio-note">{reference.source === 'runtime_capture' ? 'Original app screen captures' : 'Google Play screenshots · hidden screens and runtime behavior are unverified'}. Selected features fit into this visual structure. You can request changes below.</p>
    <div className="studio-base-ui-images">{reference.screenshots.map(screen => <figure key={screen.id}><a href={screen.url} target="_blank" rel="noreferrer"><img src={screen.url} alt={screen.label} loading="lazy" /></a><figcaption>{reference.visual.screens.find(item => item.screenshotId === screen.id)?.name || screen.label}</figcaption></figure>)}</div>
    <details className="studio-details"><summary>What the design follows</summary>
      <p><strong>Navigation: </strong>{reference.visual.navigation}</p><p><strong>Layout: </strong>{reference.visual.hierarchy}</p><p><strong>Controls: </strong>{reference.visual.controls}</p><p><strong>Type and spacing: </strong>{reference.visual.typography} {reference.visual.spacing}</p><p><strong>Colors: </strong>{reference.visual.colors}</p>
      {reference.visual.screens.map(screen => <div key={screen.screenshotId}><h3>{screen.name}</h3><p>{screen.layout}</p><ul>{screen.preserve.map(rule => <li key={rule}>{rule}</li>)}</ul>{screen.adapt.map(rule => <p key={rule}>{rule}</p>)}</div>)}
      {mapping && <><h3>Your screen adaptations</h3>{mapping.map(screen => <p key={screen.screenId}><strong>{screen.screenId}: </strong>{screen.referenceScreenIds.map(id => reference.visual.screens.find(item => item.screenshotId === id)?.name || id).join(" / ") || "New screen"}. {screen.preserved.join("; ")} {screen.adaptations.join("; ")} {screen.proposedReason}</p>)}</>}
      <ul>{reference.visual.limitations.map(item => <li key={item}>{item}</li>)}</ul>
    </details>
  </section>;
}
