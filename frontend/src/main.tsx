import React from "react";
import ReactDOM from "react-dom/client";
import ProjectWorkspace from "./ProjectWorkspace";
import "@fontsource-variable/inter";
import "./styles.css";
const LegacyApp = React.lazy(() => import("./App"));
const legacy = new URLSearchParams(location.search).has("legacy") || new URLSearchParams(location.search).has("design") || (window as typeof window & { __MELD_LEGACY__?: boolean }).__MELD_LEGACY__;
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <React.Suspense fallback={<p role="status">Loading your workspace…</p>}>{legacy ? <LegacyApp /> : <ProjectWorkspace />}</React.Suspense>
  </React.StrictMode>,
);
