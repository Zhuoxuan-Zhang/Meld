import React from "react";
import ReactDOM from "react-dom/client";
import AccountGate from "./AccountGate";
import ProjectWorkspace from "./ProjectWorkspace";
import "@fontsource-variable/inter";
import "./styles.css";

// Old bookmarks use hash routes. Keep their saved draft and project, but always
// open the current studio. There is no second discovery or demo workflow.
if (location.hash.startsWith("#/") || location.pathname === "/legacy") {
  const url = new URL(location.href);
  url.pathname = "/";
  url.hash = "";
  window.history.replaceState(window.history.state, "", url);
}
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <AccountGate><ProjectWorkspace /></AccountGate>
  </React.StrictMode>,
);
