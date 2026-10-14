import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { appById as sampleById, canonicalDomain, domains } from "./data";
import type { ReferenceApp } from "./data";
import {
  catalog,
  catalogById,
  emptyDraft,
  loadDraft,
  mergedFeatures,
  selectedApps,
  storageKey,
  withListedFeatures,
  withMarketResult,
} from "./state";
import { formatInstalls, inDomain, monetization, sizedImage } from "./market";
import type { MarketApp, MarketResult } from "./market";
import { useMarket } from "./useMarket";
import type { MarketConnection, ScanState } from "./useMarket";
import { useListedFeatures } from "./useFeatures";
import type { FeatureConnection, FeatureState } from "./useFeatures";
import type { Draft, Style } from "./state";
import { Icon } from "./icons";
import SuggestionPanel, { PlanSummary } from "./SuggestionPanel";
import { suggestionSelection } from "./suggestions";
import type { Suggestion } from "./suggestions";
import {
  demoHtml,
  designDoc,
  downloadProject,
  readme,
  saveFile,
  slug,
} from "./artifacts";

const stepRoutes = ["/domains", "/apps", "/review", "/result"];
const stepLabels = [
  "Choose domains",
  "Plan your app",
  "Review & build",
  "Your app",
];
function routeNow() {
  return location.hash.slice(1) || "/domains";
}
function go(path: string) {
  if (routeNow() === path) window.scrollTo({ top: 0, behavior: "smooth" });
  else location.hash = path;
}
function appStyle(a: ReferenceApp): CSSProperties {
  return { "--app-color": a.color, "--app-bg": a.bg } as CSSProperties;
}
// A live app shows its Google Play icon, and its first letter when there is
// no icon or the image does not load.
function AppIcon({
  app,
  small = false,
}: {
  app: ReferenceApp;
  small?: boolean;
}) {
  const [failed, setFailed] = useState("");
  const image = app.market?.iconUrl;
  const showImage = !!image && failed !== image;
  return (
    <span
      className={`app-icon ${small ? "small" : ""} ${app.market ? "market-initial" : ""} ${showImage ? "has-image" : ""}`}
      style={appStyle(app)}
    >
      {showImage ? (
        <img
          src={sizedImage(image, "s128")}
          alt=""
          referrerPolicy="no-referrer"
          decoding="async"
          onError={() => setFailed(image)}
        />
      ) : app.market ? (
        <span aria-hidden="true">{[...app.name.trim()][0]?.toUpperCase()}</span>
      ) : (
        <Icon name={app.icon} size={small ? 19 : 29} />
      )}
    </span>
  );
}
// The listing's first screenshots, loaded from Google's image server. Images
// that do not load are left out.
function Screenshots({ app }: { app: MarketApp }) {
  const [failed, setFailed] = useState<string[]>([]);
  const shots = (app.screenshots || []).filter((u) => !failed.includes(u));
  if (!shots.length) return null;
  return (
    <section
      className="app-screenshots"
      aria-label={`${app.title} screenshots from Google Play`}
      tabIndex={0}
    >
      {shots.map((u, i) => (
        <img
          key={u}
          src={sizedImage(u, "h560")}
          alt={`${app.title} screenshot ${i + 1}`}
          referrerPolicy="no-referrer"
          loading="lazy"
          decoding="async"
          onError={() => setFailed((f) => [...f, u])}
        />
      ))}
    </section>
  );
}
function Brand() {
  return (
    <span className="brand">
      <span className="brand-mark">
        <i />
        <i />
      </span>
      <span>
        meld<span className="brand-dot">.</span>
      </span>
    </span>
  );
}
function Button({
  children,
  onClick,
  disabled = false,
  kind = "primary",
  className = "",
  type = "button",
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  kind?: "primary" | "secondary" | "text";
  className?: string;
  type?: "button" | "submit";
}) {
  return (
    <button
      type={type}
      className={`button ${kind} ${className}`}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}
function Empty({
  icon = "Search",
  title,
  description,
  children,
}: {
  icon?: string;
  title: string;
  description: string;
  children?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <span className="empty-icon">
        <Icon name={icon} size={26} />
      </span>
      <h3>{title}</h3>
      <p>{description}</p>
      {children}
    </div>
  );
}
function Modal({
  title,
  children,
  onClose,
  wide = false,
  dismissible = true,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
  dismissible?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    const previous = document.activeElement as HTMLElement | null;
    dialog?.showModal();
    return () => {
      dialog?.close();
      previous?.focus();
    };
  }, []);
  return (
    <dialog
      className={`modal ${wide ? "wide" : ""}`}
      ref={ref}
      onCancel={(e) => {
        e.preventDefault();
        if (dismissible) onClose();
      }}
      onClick={(e) => {
        if (dismissible && e.target === e.currentTarget) onClose();
      }}
      aria-labelledby="modal-title"
    >
      <div className="modal-head">
        <h2 id="modal-title">{title}</h2>
        {dismissible && (
          <button
            className="icon-button"
            aria-label="Close dialog"
            onClick={onClose}
          >
            <Icon name="X" />
          </button>
        )}
      </div>
      {children}
    </dialog>
  );
}
export default function App() {
  const [draft, setDraft] = useState<Draft>(loadDraft);
  const [route, setRoute] = useState(routeNow);
  const [toast, setToast] = useState("");
  const [storageError, setStorageError] = useState(false);
  const [dialog, setDialog] = useState<
    "reset" | "help" | "readme" | "design" | null
  >(null);
  const [building, setBuilding] = useState(false);
  const [buildPhase, setBuildPhase] = useState(0);
  const [downloadBusy, setDownloadBusy] = useState(false);
  const [mobileNav, setMobileNav] = useState(false);
  const [catalogView, setCatalogView] = useState({
    filter: "All interests",
    query: "",
  });
  const [undoDraft, setUndoDraft] = useState<Draft | null>(null);
  const catalogScroll = useRef(0);
  const buildTimeouts = useRef<number[]>([]);
  const mainRef = useRef<HTMLElement>(null);
  const selected = useMemo(() => selectedApps(draft), [draft]);
  const merged = useMemo(() => mergedFeatures(draft), [draft]);
  const shown = useMemo(
    () => catalog(draft),
    [draft.domains, draft.market, draft.selected],
  );
  const market = useMarket(draft.domains, draft.market, (domain, result) =>
    setDraft((d) => withMarketResult(d, domain, result)),
  );
  const listing = useListedFeatures(draft.domains, draft.market, (features) =>
    setDraft((d) => withListedFeatures(d, features)),
  );
  const count = Object.values(draft.selected).reduce((s, a) => s + a.length, 0);
  const routeAppId = route.startsWith("/apps/")
    ? decodeURIComponent(route.split("/")[2] || "")
    : "";
  const currentApp = shown.find((a) => a.id === routeAppId);
  const step =
    route === "/domains"
      ? 0
      : route.startsWith("/apps")
        ? 1
        : route === "/review"
          ? 2
          : 3;
  const notify = (message: string) => setToast(message);
  const update = (patch: Partial<Draft>) => {
    if (
      patch.selected ||
      patch.domains ||
      patch.name !== undefined ||
      patch.audience !== undefined ||
      patch.description !== undefined ||
      patch.style
    )
      setUndoDraft(null);
    setDraft((d) => ({
      ...d,
      ...patch,
      built: false,
      ...(patch.selected ? { plan: undefined } : {}),
      ...(patch.domains ? { plan: undefined, suggestion: undefined } : {}),
    }));
  };
  const applyPlan = (plan: Suggestion) => {
    setUndoDraft(draft);
    setDraft((d) => ({
      ...d,
      plan,
      selected: suggestionSelection(plan),
      built: false,
      name: !d.name || d.name === d.plan?.name ? plan.name : d.name,
      audience:
        !d.audience || d.audience === d.plan?.audience
          ? plan.audience
          : d.audience,
      description:
        !d.description || d.description === d.plan?.summary
          ? plan.summary
          : d.description,
    }));
    notify("Plan applied. Review your features or continue to your app brief.");
  };
  const undoPlan = () => {
    if (!undoDraft) return;
    setDraft((d) => ({
      ...d,
      selected: undoDraft.selected,
      name: undoDraft.name,
      audience: undoDraft.audience,
      description: undoDraft.description,
      plan: undoDraft.plan,
      built: false,
    }));
    setUndoDraft(null);
    notify("Your previous feature mix is restored.");
  };
  useLayoutEffect(() => {
    window.scrollTo(0, route === "/apps" ? catalogScroll.current : 0);
    if (route !== "/apps") return;
    const remember = () => {
      catalogScroll.current = window.scrollY;
    };
    window.addEventListener("scroll", remember);
    return () => window.removeEventListener("scroll", remember);
  }, [route]);
  useEffect(() => {
    const handler = () => {
      setRoute(routeNow());
      setMobileNav(false);
    };
    window.addEventListener("hashchange", handler);
    return () => window.removeEventListener("hashchange", handler);
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(draft));
      setStorageError(false);
    } catch {
      setStorageError(true);
    }
  }, [draft]);
  useEffect(() => {
    if (!toast) return;
    const id = window.setTimeout(() => setToast(""), 4000);
    return () => clearTimeout(id);
  }, [toast]);
  useEffect(() => {
    mainRef.current?.focus({ preventScroll: true });
  }, [route]);
  useEffect(() => {
    const valid = stepRoutes.includes(route) || !!currentApp;
    let destination = "";
    // An app that left the catalog after a scan returns to the app list.
    const known =
      !!sampleById[routeAppId] ||
      Object.values(draft.market || {}).some((r) =>
        r.apps.some((a) => a.appId === routeAppId),
      );
    if (!valid)
      destination = routeAppId && known && draft.domains.length ? "/apps" : "/domains";
    else if (route !== "/domains" && !draft.domains.length)
      destination = "/domains";
    else if (currentApp && !draft.domains.includes(currentApp.domain))
      destination = "/apps";
    else if ((route === "/review" || route === "/result") && !merged.length)
      destination = "/apps";
    else if (route === "/result" && !draft.built) destination = "/review";
    if (destination) location.replace("#" + destination);
  }, [
    route,
    routeAppId,
    currentApp,
    draft.domains,
    draft.market,
    draft.built,
    merged.length,
  ]);
  useEffect(() => () => buildTimeouts.current.forEach(clearTimeout), []);
  useEffect(() => {
    if (!mobileNav) return;
    const previous = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const sidebar = document.querySelector<HTMLElement>(".sidebar");
    const nodes = () =>
      [
        ...(sidebar?.querySelectorAll<HTMLElement>(
          "a[href],button:not(:disabled)",
        ) || []),
      ].filter((el) => el.getClientRects().length > 0);
    sidebar?.querySelector<HTMLElement>(".sidebar-close")?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setMobileNav(false);
      }
      if (event.key === "Tab") {
        const focusable = nodes();
        const first = focusable[0],
          last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    const onResize = () => {
      if (window.innerWidth > 760) setMobileNav(false);
    };
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", onResize);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onResize);
      previous?.focus();
    };
  }, [mobileNav]);
  const toggleFeature = (appId: string, id: string) => {
    setUndoDraft(null);
    setDraft((d) => {
      const list = d.selected[appId] || [];
      return {
        ...d,
        built: false,
        plan: undefined,
        selected: {
          ...d.selected,
          [appId]: list.includes(id)
            ? list.filter((x) => x !== id)
            : [...list, id],
        },
      };
    });
  };
  const removeFeature = (appId: string, id: string) => {
    setUndoDraft(null);
    setDraft((d) => ({
      ...d,
      built: false,
      plan: undefined,
      selected: {
        ...d.selected,
        [appId]: (d.selected[appId] || []).filter((x) => x !== id),
      },
    }));
  };
  const removeDomain = (name: string) => {
    setUndoDraft(null);
    setDraft((d) => {
      const { [name]: _removed, ...rest } = d.market || {};
      const market = Object.keys(rest).length ? rest : undefined;
      const domains = d.domains.filter((v) => v !== name);
      // Keep choices whose app is still shown through another domain.
      const remaining = catalogById({ domains, market, selected: {} });
      return {
        ...d,
        built: false,
        plan: undefined,
        suggestion: undefined,
        domains,
        selected: Object.fromEntries(
          Object.entries(d.selected).filter(([id]) => remaining[id]),
        ),
        market,
      };
    });
  };
  const build = () => {
    if (!draft.name.trim() || !merged.length) return;
    setBuilding(true);
    setBuildPhase(0);
    buildTimeouts.current = [
      window.setTimeout(() => setBuildPhase(1), 650),
      window.setTimeout(() => setBuildPhase(2), 1300),
      window.setTimeout(() => {
        setDraft((d) => ({ ...d, name: d.name.trim(), built: true }));
        setBuilding(false);
        go("/result");
      }, 2000),
    ];
  };
  const download = async () => {
    setDownloadBusy(true);
    try {
      await downloadProject(draft);
      notify("Your demo and design documents are ready.");
    } catch {
      notify("The download could not be prepared. Please try again.");
    } finally {
      setDownloadBusy(false);
    }
  };
  const openDemo = () => {
    const url = URL.createObjectURL(
      new Blob([demoHtml(draft)], { type: "text/html" }),
    );
    const win = window.open(url, "_blank");
    if (!win) notify("Allow pop-ups to open your app, or download the demo.");
    else win.opener = null;
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  };
  const reset = () => {
    setDraft(emptyDraft());
    setUndoDraft(null);
    setCatalogView({ filter: "All interests", query: "" });
    catalogScroll.current = 0;
    setDialog(null);
    go("/domains");
    notify("A fresh start. What will you make?");
  };
  return (
    <div className="app-shell">
      <a
        className="skip-link"
        href="#main-content"
        onClick={(e) => {
          e.preventDefault();
          mainRef.current?.focus();
        }}
      >
        Skip to main content
      </a>
      <aside
        className={`sidebar ${mobileNav ? "mobile-open" : ""}`}
        role={mobileNav ? "dialog" : undefined}
        aria-modal={mobileNav || undefined}
        aria-label={mobileNav ? "Project navigation" : undefined}
      >
        <a href="#/domains" className="brand-link" aria-label="Meld home">
          <Brand />
        </a>
        <button
          className="icon-button sidebar-close"
          aria-label="Close navigation"
          onClick={() => setMobileNav(false)}
        >
          <Icon name="X" />
        </button>
        <div className="workspace-label">YOUR WORKSPACE</div>
        <nav aria-label="Build your app" className="steps">
          {stepLabels.map((label, i) => {
            const canGo =
              i === 0 ||
              (i === 1 && draft.domains.length > 0) ||
              (i === 2 && merged.length > 0) ||
              (i === 3 && draft.built);
            return (
              <button
                key={label}
                className={`step-link ${step === i ? "active" : ""} ${step > i ? "done" : ""}`}
                onClick={() => go(stepRoutes[i])}
                disabled={!canGo || building}
                aria-current={step === i ? "step" : undefined}
              >
                <span className="step-number">
                  {step > i ? (
                    <Icon name="Check" size={15} />
                  ) : (
                    String(i + 1).padStart(2, "0")
                  )}
                </span>
                <span>{label}</span>
                {step === i && <span className="active-dot" />}
              </button>
            );
          })}
        </nav>
        <div className="sidebar-note">
          <Icon name="Layers" size={22} />
          <p>
            Good features.
            <br />
            One useful app.
          </p>
          <span>Choose, combine, and make it yours.</span>
        </div>
        <div className="sidebar-bottom">
          <button className="side-action" onClick={() => setDialog("help")}>
            <Icon name="CircleHelp" size={18} />
            How Meld works
            <Icon name="ArrowRight" size={15} />
          </button>
          <div className="local-badge">
            <span />
            <div>
              Local workspace<small>Saved on this device</small>
            </div>
            <Icon name="Monitor" size={17} />
          </div>
        </div>
      </aside>
      {mobileNav && (
        <button
          className="nav-backdrop"
          aria-label="Close menu backdrop"
          onClick={() => setMobileNav(false)}
        />
      )}
      <div className="workspace" inert={mobileNav}>
        <header className="topbar">
          <div className="crumbs">
            <button
              className="icon-button mobile-menu"
              onClick={() => setMobileNav(!mobileNav)}
              aria-label="Toggle navigation"
              aria-expanded={mobileNav}
            >
              <Icon name="Menu" />
            </button>
            <Icon name="Layers" size={17} />
            <span>Workspace</span>
            <Icon name="ChevronRight" size={14} />
            <span className="crumb-current">
              {draft.name.trim() || "Untitled project"}
            </span>
          </div>
          <div className="topbar-right">
            <span className="demo-pill">
              <span />
              Interactive demo
            </span>
            <button
              className="new-project"
              aria-label="New project"
              onClick={() => setDialog("reset")}
              disabled={building}
            >
              <Icon name="Plus" size={16} />
              <span>New project</span>
            </button>
          </div>
        </header>
        {storageError && (
          <div className="storage-warning" role="status">
            Browser storage is unavailable. You can use the demo, but your
            choices will not survive a reload.
          </div>
        )}
        <main
          id="main-content"
          ref={mainRef}
          tabIndex={-1}
          className={`main-content step-${step}`}
        >
          {route === "/domains" && (
            <DomainsPage
              draft={draft}
              shown={shown}
              scanning={Object.values(market.scans).some(
                (s) => s.phase === "scanning",
              )}
              update={update}
              removeDomain={removeDomain}
              notify={notify}
            />
          )}
          {route === "/apps" && (
            <AppsPage
              draft={draft}
              shown={shown}
              connection={market.connection}
              scans={market.scans}
              scan={market.scan}
              checkMarket={market.check}
              listing={listing}
              selected={selected}
              count={count}
              mergedCount={merged.length}
              removeFeature={removeFeature}
              update={update}
              catalogView={catalogView}
              setCatalogView={setCatalogView}
              applyPlan={applyPlan}
              undoPlan={undoPlan}
              canUndo={!!undoDraft}
            />
          )}
          {currentApp && (
            <FeaturePage
              app={currentApp}
              result={draft.market?.[currentApp.domain]}
              listing={listing}
              draft={draft}
              toggle={toggleFeature}
              update={update}
              notify={notify}
            />
          )}
          {route === "/review" && (
            <ReviewPage
              draft={draft}
              selected={selected}
              mergedCount={merged.length}
              count={count}
              update={update}
              removeFeature={removeFeature}
              build={build}
              showDesign={() => setDialog("design")}
            />
          )}
          {route === "/result" && draft.built && (
            <ResultPage
              draft={draft}
              count={merged.length}
              sources={selected.length}
              openDemo={openDemo}
              download={download}
              busy={downloadBusy}
              showReadme={() => setDialog("readme")}
              showDesign={() => setDialog("design")}
            />
          )}
          <footer className="workspace-footer">
            <span>
              <span className="tiny-mark">m</span> Thoughtfully combined.
              Uniquely yours.
            </span>
            <span>Made with a little inspiration.</span>
          </footer>
        </main>
      </div>
      <div
        className={`toast ${toast ? "visible" : ""}`}
        role="status"
        aria-live="polite"
      >
        {toast && (
          <>
            <Icon name="CircleCheck" size={18} />
            {toast}
          </>
        )}
      </div>
      {dialog === "reset" && (
        <Modal title="A fresh page?" onClose={() => setDialog(null)}>
          <p className="modal-copy">
            Starting a new project clears this workspace. Download your current
            demo first if you want to keep it.
          </p>
          <div className="modal-actions">
            <Button kind="secondary" onClick={() => setDialog(null)}>
              Keep working
            </Button>
            <Button onClick={reset}>
              Start new project
              <Icon name="Plus" size={17} />
            </Button>
          </div>
        </Modal>
      )}
      {dialog === "help" && (
        <Modal
          title="A little inspiration goes a long way."
          onClose={() => setDialog(null)}
        >
          <div className="help-steps">
            {[
              {
                title: "Start with what interests you",
                text: "Choose a few domains, or add your own as a tag.",
              },
              {
                title: "Borrow the good ideas",
                text: "Ask AI for a combined app plan, or choose features from the reference apps yourself.",
              },
              {
                title: "Bring it all together",
                text: "Name your app, review your choices, and create a browser demo.",
              },
            ].map((s, i) => (
              <div key={s.title}>
                <span>{i + 1}</span>
                <div>
                  <h3>{s.title}</h3>
                  <p>{s.text}</p>
                </div>
              </div>
            ))}
          </div>
          <div className="info-note">
            <Icon name="Info" />
            <p>
              Reference apps come from a live Google Play market scan run on
              this computer, or from a fixed sample catalog when the scanner is
              not set up. Their features are sample briefs: REA analysis and
              the coding agent are not connected. AI suggestions send your goal
              and the shown catalog to OpenRouter when you request them.
            </p>
          </div>
        </Modal>
      )}
      {(dialog === "readme" || dialog === "design") && (
        <Modal
          title={
            dialog === "readme" ? "Your app’s README" : "Your combined design"
          }
          onClose={() => setDialog(null)}
          wide
        >
          <div className="document-meta">
            <span>
              <Icon name="FileText" size={17} />
              {dialog === "readme" ? "README.md" : "DESIGN.md"}
            </span>
            <Button
              kind="secondary"
              onClick={() =>
                saveFile(
                  dialog === "readme" ? readme(draft) : designDoc(draft),
                  dialog === "readme" ? "README.md" : "DESIGN.md",
                  "text/markdown",
                )
              }
            >
              Download
              <Icon name="Download" size={16} />
            </Button>
          </div>
          <MarkdownDocument
            text={dialog === "readme" ? readme(draft) : designDoc(draft)}
          />
        </Modal>
      )}
      {building && (
        <Modal
          title="Your ideas are coming together"
          onClose={() => {}}
          dismissible={false}
        >
          <div className="building">
            <span className="build-emblem">
              <Icon name="Layers" size={34} />
            </span>
            <h3>
              {
                [
                  "Gathering your choices…",
                  "Combining the feature briefs…",
                  "Preparing your demo…",
                ][buildPhase]
              }
            </h3>
            <p>A small preview of what’s possible.</p>
            <div className="build-track">
              <span style={{ width: `${(buildPhase + 1) * 33.333}%` }} />
            </div>
            <span className="fine-print">
              Template-based demo · No coding agent is running
            </span>
          </div>
        </Modal>
      )}
    </div>
  );
}
function DomainsPage({
  draft,
  shown,
  scanning,
  update,
  removeDomain,
  notify,
}: {
  draft: Draft;
  shown: ReferenceApp[];
  scanning: boolean;
  update: (p: Partial<Draft>) => void;
  removeDomain: (s: string) => void;
  notify: (s: string) => void;
}) {
  const [value, setValue] = useState("");
  const [error, setError] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const add = (raw: string) => {
    const domain = canonicalDomain(raw);
    if (!domain) {
      setError("Type a domain, or choose an example below.");
      inputRef.current?.focus();
      return;
    }
    if (domain.length > 48) {
      setError("Keep each domain to 48 characters or fewer.");
      return;
    }
    if (draft.domains.some((d) => d.toLowerCase() === domain.toLowerCase())) {
      setError(`${domain} is already on your list.`);
      setValue("");
      return;
    }
    if (draft.domains.length >= 8) {
      setError("Choose up to 8 domains. Remove one to add another.");
      return;
    }
    update({ domains: [...draft.domains, domain] });
    setValue("");
    setError("");
    notify(`${domain} added to your inspiration.`);
  };
  const toggle = (name: string) => {
    if (draft.domains.includes(name)) {
      removeDomain(name);
      setError("");
    } else add(name);
  };
  const available = shown.length;
  const live = shown.filter((a) => a.market).length;
  return (
    <>
      <div className="home-hero">
        <div>
          <div className="eyebrow">YOUR NEXT APP STARTS HERE</div>
          <h1>What do you want to build?</h1>
          <p>
            Combine useful features from familiar apps.
            <br className="desktop-break" /> Start with a few domains that
            interest you.
          </p>
        </div>
        <IngredientArt />
      </div>
      <section className="domain-card">
        <div className="section-title">
          <div>
            <span className="section-kicker">STEP 1 OF 4</span>
            <h2>Choose your domains</h2>
            <p>Choose an example below, or add your own domain.</p>
          </div>
          <span className="soft-label">Mix & match</span>
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            add(value);
          }}
          className="domain-form"
        >
          <label className="field-label" htmlFor="domain-input">
            Your domains
          </label>
          <div
            className={`tag-field ${error ? "has-error" : ""}`}
            onClick={() => inputRef.current?.focus()}
          >
            {draft.domains.map((d) => (
              <span className="domain-tag" key={d}>
                {d}
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    removeDomain(d);
                    setError("");
                  }}
                  aria-label={`Remove ${d}`}
                >
                  <Icon name="X" size={13} />
                </button>
              </span>
            ))}
            <input
              id="domain-input"
              ref={inputRef}
              value={value}
              onChange={(e) => {
                setValue(e.target.value);
                setError("");
              }}
              placeholder={
                draft.domains.length
                  ? "Add another interest…"
                  : "Try “productivity” or “a calmer morning”…"
              }
              aria-describedby={error ? "domain-error" : "domain-hint"}
              aria-invalid={!!error}
            />
            <button
              type="submit"
              className="add-domain"
              aria-label="Add domain"
            >
              <Icon name="Plus" size={18} />
            </button>
          </div>
          <div className="input-caption">
            <span
              id={error ? "domain-error" : "domain-hint"}
              className={error ? "field-error" : ""}
              role={error ? "alert" : undefined}
            >
              {error || (
                <>
                  Add one at a time with <kbd>Enter ↵</kbd>, or choose below.
                </>
              )}
            </span>
            <span>{draft.domains.length}/8 domains</span>
          </div>
        </form>
        <div className="suggestion-label">
          <span>SUGGESTED DOMAINS</span>
          <span>Select one or more</span>
        </div>
        <div className="domain-grid">
          {domains.map((d) => {
            const active = draft.domains.includes(d.name);
            return (
              <button
                key={d.name}
                className={`domain-option ${active ? "selected" : ""}`}
                aria-pressed={active}
                onClick={() => toggle(d.name)}
              >
                <span
                  className="domain-symbol"
                  style={{ background: d.bg, color: d.color }}
                >
                  <Icon name={d.icon} size={24} />
                </span>
                <span className="domain-word">
                  <strong>{d.name}</strong>
                  <small>{d.description}</small>
                </span>
                <span className="domain-check">
                  {active ? (
                    <Icon name="Check" size={13} />
                  ) : (
                    <Icon name="Plus" size={14} />
                  )}
                </span>
              </button>
            );
          })}
        </div>
        <div className="domain-bottom">
          <p>
            <Icon name="Sparkles" size={17} />
            {draft.domains.length ? (
              <>
                <b>
                  {draft.domains.length}{" "}
                  {draft.domains.length === 1 ? "interest" : "interests"}
                </b>{" "}
                ·{" "}
                {live
                  ? `${live} hot apps from Google Play${scanning ? " · scanning more…" : ""}`
                  : scanning
                    ? "Finding hot apps on Google Play…"
                    : available
                      ? `${available} sample apps to explore`
                      : "Your own direction"}
              </>
            ) : (
              "A focus timer + a journal? Why not both."
            )}
          </p>
          <Button
            disabled={!draft.domains.length}
            onClick={() => {
              if (value.trim()) {
                setError(
                  "Add this domain first, or clear the text to continue.",
                );
                inputRef.current?.focus();
                return;
              }
              go("/apps");
            }}
          >
            Explore apps
            <Icon name="ArrowRight" size={18} />
          </Button>
        </div>
      </section>
      <div className="trust-row">
        <span>
          <Icon name="ShieldCheck" size={16} />
          Your workspace saves locally
        </span>
        <i />
        <span>
          <Icon name="Layers" size={16} />
          Inspired by real apps
        </span>
        <i />
        <span>
          <Icon name="Heart" size={16} />
          Built around you
        </span>
      </div>
    </>
  );
}
function IngredientArt() {
  return (
    <div className="workflow-overview">
      <span className="section-kicker">FROM IDEA TO A WORKING DEMO</span>
      {[
        [
          "Compass",
          "Choose your interests",
          "Find reference apps in your domains.",
        ],
        [
          "Sparkles",
          "Combine the best features",
          "Start with a suggested app plan.",
        ],
        ["Layers", "Try your new app", "Open a demo and download the brief."],
      ].map(([icon, title, detail]) => (
        <div key={title}>
          <span>
            <Icon name={icon} size={20} />
          </span>
          <div>
            <strong>{title}</strong>
            <p>{detail}</p>
          </div>
        </div>
      ))}
    </div>
  );
}
function PageHead({
  eyebrow,
  title,
  accent,
  description,
  children,
}: {
  eyebrow: string;
  title: string;
  accent?: string;
  description: string;
  children?: ReactNode;
}) {
  return (
    <div className="page-head">
      <div>
        <div className="eyebrow">{eyebrow}</div>
        <h1>
          {title}
          {accent && (
            <>
              {" "}
              <em>{accent}</em>
            </>
          )}
        </h1>
        <p>{description}</p>
      </div>
      {children}
    </div>
  );
}
function AppsPage({
  draft,
  shown,
  connection,
  scans,
  scan,
  checkMarket,
  listing,
  selected,
  count,
  mergedCount,
  removeFeature,
  update,
  catalogView,
  setCatalogView,
  applyPlan,
  undoPlan,
  canUndo,
}: {
  draft: Draft;
  shown: ReferenceApp[];
  connection: MarketConnection | null;
  scans: Record<string, ScanState>;
  scan: (domain: string, refresh?: boolean) => void;
  checkMarket: () => void;
  listing: Listing;
  selected: ReferenceApp[];
  count: number;
  mergedCount: number;
  removeFeature: (a: string, f: string) => void;
  update: (p: Partial<Draft>) => void;
  catalogView: { filter: string; query: string };
  setCatalogView: (v: { filter: string; query: string }) => void;
  applyPlan: (plan: Suggestion) => void;
  undoPlan: () => void;
  canUndo: boolean;
}) {
  const filter = draft.domains.includes(catalogView.filter)
    ? catalogView.filter
    : "All interests";
  const query = catalogView.query;
  const setFilter = (filter: string) =>
    setCatalogView({ ...catalogView, filter });
  const setQuery = (query: string) => setCatalogView({ ...catalogView, query });
  const filtered = shown.filter(
    (a) =>
      (filter === "All interests" || inDomain(a, filter)) &&
      `${a.name} ${a.tagline} ${a.market?.developer || ""} ${a.features.map((f) => f.name).join(" ")} ${a.market?.listedFeatures?.items.map((f) => `${f.name} ${f.detail}`).join(" ") || ""}`
        .toLowerCase()
        .includes(query.trim().toLowerCase()),
  );
  const live = shown.some((a) => a.market);
  const summarized = shown.some((a) => a.market?.listedFeatures?.items.length);
  const unknown = draft.domains.filter(
    (d) =>
      !domains.some((x) => x.name === d) &&
      !shown.some((a) => inDomain(a, d)) &&
      scans[d]?.phase !== "scanning",
  );
  const pending = draft.domains.filter(
    (d) => scans[d]?.phase === "scanning" && !shown.some((a) => inDomain(a, d)),
  );
  return (
    <>
      <PageHead
        eyebrow="STEP 2 OF 4"
        title="Plan your app"
        description="Start with a suggested combination, or explore the reference apps below."
      />
      <SuggestionPanel
        draft={draft}
        shown={shown}
        update={update}
        apply={applyPlan}
        undo={undoPlan}
        canUndo={canUndo}
        onContinue={() => go("/review")}
      />
      <div className="browse-layout">
        <div className="browse-main">
          <div className="catalog-title">
            <div>
              <h2>{live ? "Explore hot apps" : "Explore reference apps"}</h2>
              <p>Open an app to see its features and user journeys.</p>
            </div>
          </div>
          <MarketSignals
            draft={draft}
            shown={shown}
            connection={connection}
            scans={scans}
            scan={scan}
            check={checkMarket}
            listing={listing}
          />
          <div className="catalog-tools">
            <div
              className="filter-tabs"
              role="group"
              aria-label="Filter by domain"
            >
              {["All interests", ...draft.domains].map((d) => (
                <button
                  key={d}
                  className={filter === d ? "active" : ""}
                  aria-pressed={filter === d}
                  onClick={() => setFilter(d)}
                >
                  {d}
                </button>
              ))}
            </div>
            <label className="search-field">
              <Icon name="Search" size={17} />
              <input
                aria-label="Search apps and features"
                placeholder="Find an app or feature"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              {query && (
                <button
                  className="icon-button"
                  aria-label="Clear search"
                  onClick={() => setQuery("")}
                >
                  <Icon name="X" size={14} />
                </button>
              )}
            </label>
          </div>
          <div className="catalog-caption">
            <span>{filtered.length} reference apps</span>
            <span>
              <Icon name={live ? "TrendingUp" : "Info"} size={13} />
              {summarized
                ? "Live Google Play signals · features from store listings"
                : live
                  ? "Live Google Play signals · sample features"
                  : "Curated demo collection"}
            </span>
          </div>
          {pending.length > 0 && !query && (
            <div className="custom-domain-note">
              <Icon name="LoaderCircle" size={17} className="spin" />
              <p>
                Finding hot apps for <strong>{pending.join(", ")}</strong> on
                Google Play…
              </p>
            </div>
          )}
          {unknown.length > 0 && !query && (
            <div className="custom-domain-note">
              <Icon name="Info" size={17} />
              <p>
                No apps yet for <strong>{unknown.join(", ")}</strong>.{" "}
                {connection?.available
                  ? "Check the market signals above, or try other words."
                  : "Market signals are off, so only the six suggested domains have sample apps."}
                <button onClick={() => go("/domains")}>
                  Edit interests <Icon name="ArrowRight" size={13} />
                </button>
              </p>
            </div>
          )}
          <div
            className="catalog-bulk"
            role="group"
            aria-label="Features in shown apps"
          >
            <span>Features in shown apps</span>
            <div className="bulk-actions">
              <button
                className="text-button"
                disabled={
                  !filtered.length ||
                  filtered.every(
                    (a) => draft.selected[a.id]?.length === a.features.length,
                  )
                }
                onClick={() =>
                  update({
                    selected: {
                      ...draft.selected,
                      ...Object.fromEntries(
                        filtered.map((a) => [
                          a.id,
                          a.features.map((f) => f.id),
                        ]),
                      ),
                    },
                  })
                }
              >
                Select all
              </button>
              <span aria-hidden="true">/</span>
              <button
                className="text-button"
                disabled={!filtered.some((a) => draft.selected[a.id]?.length)}
                onClick={() =>
                  update({
                    selected: {
                      ...draft.selected,
                      ...Object.fromEntries(filtered.map((a) => [a.id, []])),
                    },
                  })
                }
              >
                Deselect all
              </button>
            </div>
          </div>
          <div className="app-grid">
            {filtered.map((a) => {
              const n = draft.selected[a.id]?.length || 0;
              const tags = a.features.map((f) => f.name);
              return (
                <button
                  className={`reference-card ${n ? "has-selection" : ""}`}
                  key={a.id}
                  onClick={() => go("/apps/" + a.id)}
                  style={appStyle(a)}
                >
                  <div className="reference-art">
                    <AppIcon app={a} />
                    {a.market ? (
                      <span className="rank-label">
                        {a.market.retained
                          ? "Earlier scan"
                          : `#${a.market.rank} · ${a.domain}`}
                      </span>
                    ) : (
                      <span>{a.domain}</span>
                    )}
                    {n > 0 && <Icon name="CircleCheck" size={19} />}
                  </div>
                  <div className="reference-body">
                    <div className="reference-name">
                      <h3>{a.name}</h3>
                      <Icon name="ArrowRight" size={18} />
                    </div>
                    <p className={a.market ? "clamped" : ""}>{a.tagline}</p>
                    {a.market && <MarketMetrics app={a.market} />}
                    <div className="card-feature-tags">
                      {tags.slice(0, 2).map((t, i) => (
                        <span key={i}>{t}</span>
                      ))}
                      {tags.length > 2 && <span>+{tags.length - 2}</span>}
                    </div>
                    <div className="reference-footer">
                      <span>{a.domain}</span>
                      <span className={n ? "chosen-label" : ""}>
                        {n ? (
                          <>
                            <Icon name="CircleCheck" size={14} />
                            {n} selected
                          </>
                        ) : (
                          <>
                            {a.features.length
                              ? `${a.features.length} feature${a.features.length === 1 ? "" : "s"}`
                              : "No features yet"}
                            <Icon name="ChevronRight" size={14} />
                          </>
                        )}
                      </span>
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
          {!filtered.length && (
            <Empty
              title={
                query
                  ? "No apps found"
                  : pending.length
                    ? "Scanning Google Play…"
                    : "A new direction"
              }
              description={
                query
                  ? "Try a different app name or feature, such as “notes”."
                  : pending.length
                    ? "Market signals are on their way. Hot apps appear here when the scan finishes."
                    : connection?.available
                      ? "No apps were found for these domains yet. Try other words, or add a suggested domain."
                      : "Your interest is saved. Add a suggested domain to explore the sample catalog."
              }
            >
              {query ? (
                <Button
                  kind="secondary"
                  onClick={() => {
                    setCatalogView({ query: "", filter: "All interests" });
                  }}
                >
                  Clear filters
                </Button>
              ) : (
                <Button kind="secondary" onClick={() => go("/domains")}>
                  Choose example domains
                  <Icon name="ArrowRight" size={16} />
                </Button>
              )}
            </Empty>
          )}
          <button className="back-link" onClick={() => go("/domains")}>
            <Icon name="ArrowLeft" size={15} />
            Edit your interests
          </button>
        </div>
        <SelectionPanel
          draft={draft}
          selected={selected}
          count={count}
          mergedCount={mergedCount}
          removeFeature={removeFeature}
          clearAll={() => update({ selected: {} })}
        />
      </div>
      {count > 0 && (
        <div className="mobile-mix-bar" role="region" aria-label="Your mix">
          <span className="mobile-mix-count">
            <Icon name="Layers" size={20} />
            <span>
              <strong>
                {mergedCount} {mergedCount === 1 ? "feature" : "features"}
              </strong>
              <small>Your selected features</small>
            </span>
          </span>
          <Button onClick={() => go("/review")}>
            Review mix <Icon name="ArrowRight" size={16} />
          </Button>
        </div>
      )}
    </>
  );
}
function SelectionPanel({
  draft,
  selected,
  count,
  mergedCount,
  removeFeature,
  clearAll,
}: {
  draft: Draft;
  selected: ReferenceApp[];
  count: number;
  mergedCount: number;
  removeFeature: (a: string, f: string) => void;
  clearAll: () => void;
}) {
  return (
    <aside className="selection-panel">
      <div className="selection-heading">
        <span className="blend-icon">
          <Icon name="Layers" size={23} />
        </span>
        <span className="soft-label">YOUR APP</span>
      </div>
      <h2>Your feature mix</h2>
      <p>Review your selected features here.</p>
      {!count ? (
        <div className="selection-empty">
          <span className="empty-circles">
            <i />
            <i />
            <i />
          </span>
          <p>
            No features selected yet.
            <br />
            Use a suggested plan or explore an app below.
          </p>
        </div>
      ) : (
        <div className="selection-groups">
          {selected.map((a) => (
            <div className="selection-group" key={a.id}>
              <button
                className="group-title"
                onClick={() => go("/apps/" + a.id)}
              >
                <AppIcon app={a} small />
                <strong>{a.name}</strong>
                <Icon name="ChevronRight" size={14} />
              </button>
              {a.features
                .filter((f) => draft.selected[a.id]?.includes(f.id))
                .map((f) => (
                  <div className="selected-feature" key={f.id}>
                    <Icon name="Check" size={13} />
                    <span>{f.name}</span>
                    <button
                      className="icon-button"
                      aria-label={`Remove ${f.name} from ${a.name}`}
                      onClick={() => removeFeature(a.id, f.id)}
                    >
                      <Icon name="X" size={13} />
                    </button>
                  </div>
                ))}
            </div>
          ))}
        </div>
      )}
      {!!count && (
        <button
          className="text-button clear-selection"
          onClick={clearAll}
          aria-label="Deselect all selected features"
        >
          Deselect all
        </button>
      )}
      <div className="selection-summary">
        <span>
          {mergedCount} {mergedCount === 1 ? "feature" : "features"}
        </span>
        <span>
          {selected.length} {selected.length === 1 ? "app" : "apps"}
        </span>
      </div>
      {count > mergedCount && (
        <p className="duplicate-note">
          Shared features become one. Both inspirations stay.
        </p>
      )}
      <Button disabled={!count} onClick={() => go("/review")}>
        Continue
        <Icon name="ArrowRight" size={17} />
      </Button>
      <span className="panel-footnote">You can always change your mind.</span>
    </aside>
  );
}
function FeaturePage({
  app,
  result,
  listing,
  draft,
  toggle,
  update,
  notify,
}: {
  app: ReferenceApp;
  result?: MarketResult;
  listing: Listing;
  draft: Draft;
  toggle: (a: string, f: string) => void;
  update: (p: Partial<Draft>) => void;
  notify: (s: string) => void;
}) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const ids = draft.selected[app.id] || [];
  const listed = app.features.some((f) => f.listed);
  useEffect(() => setExpanded(null), [app.id]);
  return (
    <>
      <button className="back-link top-back" onClick={() => go("/apps")}>
        <Icon name="ArrowLeft" size={16} />
        Back to app plan
      </button>
      <section className="app-detail-hero" style={appStyle(app)}>
        <div className="detail-title">
          <AppIcon app={app} />
          <div>
            <span className="section-kicker">
              {app.domain} /{" "}
              {app.market && !app.market.retained
                ? `#${app.market.rank} ON GOOGLE PLAY`
                : "FEATURE COLLECTION"}
            </span>
            <h1>{app.name} features</h1>
            <p>{app.description}</p>
            {app.market && (
              <p className="detail-developer">by {app.market.developer}</p>
            )}
          </div>
        </div>
        <div className="detail-art" aria-hidden="true">
          <Icon name={app.icon} size={105} />
          <span>{app.label}</span>
        </div>
      </section>
      {app.market && <Screenshots app={app.market} />}
      <div className="detail-layout">
        <section>
          <div className="features-heading">
            <div>
              <h2>Choose features</h2>
              <p>
                {listed
                  ? `From ${app.name}’s Google Play listing, summarized by Claude Code. Pick the parts that belong in your new app.`
                  : app.market && app.features.length
                    ? "Meld sample features that match words in this listing. Pick the parts that belong in your new app."
                    : app.market
                      ? "Features appear here once Claude Code summarizes the store listing."
                      : "Pick the parts that belong in your new app."}
              </p>
            </div>
            {app.features.length > 0 && (
              <div
                className="bulk-actions"
                role="group"
                aria-label="All app features"
              >
                <button
                  className="text-button"
                  disabled={ids.length === app.features.length}
                  onClick={() =>
                    update({
                      selected: {
                        ...draft.selected,
                        [app.id]: app.features.map((f) => f.id),
                      },
                    })
                  }
                >
                  Select all
                </button>
                <span aria-hidden="true">/</span>
                <button
                  className="text-button"
                  disabled={!ids.length}
                  onClick={() =>
                    update({ selected: { ...draft.selected, [app.id]: [] } })
                  }
                >
                  Deselect all
                </button>
              </div>
            )}
          </div>
          {app.market && <ListingStatus app={app.market} listing={listing} />}
          <div className="feature-list">
            {app.features.map((f, i) => {
              const active = ids.includes(f.id);
              return (
                <div
                  className={`feature-card ${active ? "selected" : ""}`}
                  key={f.id}
                >
                  <label className="feature-main">
                    <input
                      type="checkbox"
                      checked={active}
                      onChange={() => toggle(app.id, f.id)}
                    />
                    <span className="feature-icon">
                      <Icon name={f.icon} size={23} />
                    </span>
                    <span className="feature-copy">
                      <span className="feature-title">
                        {f.name}
                        {i === 0 && (
                          <span className="feature-badge">Core feature</span>
                        )}
                      </span>
                      <span className="feature-description">
                        {f.description}
                      </span>
                    </span>
                    <span className="feature-checkbox">
                      {active && <Icon name="Check" size={14} />}
                    </span>
                  </label>
                  {f.flow && (
                    <button
                      className="feature-expand"
                      aria-expanded={expanded === f.id}
                      onClick={() => setExpanded(expanded === f.id ? null : f.id)}
                    >
                      See the user journey
                      <Icon name="ChevronDown" size={14} />
                    </button>
                  )}
                  {expanded === f.id && f.flow && (
                    <div className="feature-journey">
                      <Icon name="ArrowRight" size={16} />
                      <p>{f.flow}</p>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          {listed && app.market?.listedFeatures && (
            <p className="listed-source">
              {app.market.listedFeatures.model} · prompt{" "}
              {app.market.listedFeatures.template} ·{" "}
              {app.market.listedFeatures.generatedAt.slice(0, 10)}. What the
              developer says, not verified analysis.
            </p>
          )}
          <div className="feature-bottom">
            <span>
              <Icon name="CircleCheck" size={16} />
              {ids.length} of {app.features.length} features selected
            </span>
            <Button
              onClick={() => {
                notify(
                  ids.length
                    ? `${app.name} features saved to your mix.`
                    : `No features selected from ${app.name}.`,
                );
                go("/apps");
              }}
            >
              Save & return
              <Icon name="ArrowRight" size={17} />
            </Button>
          </div>
        </section>
        <aside className="detail-aside">
          {app.market && <MarketFacts app={app.market} result={result} />}
          <div className="little-note">
            <span>
              <Icon name="Sparkles" size={22} />
            </span>
            <h3>
              Take the idea.
              <br />
              Make it your own.
            </h3>
            <p>
              You’re choosing what your app should do. The final mix gets its
              own name, look, and feel.
            </p>
            <div className="note-divider" />
            <p className="small">
              {listed
                ? `These features are what ${app.name}’s developer describes in its store listing, not verified analysis. The browser demo describes them but cannot build them. Live REA analysis is not connected yet.`
                : app.market
                  ? `These are sample features for ${app.name}, matched to words in its store listing. Live REA analysis is not connected yet.`
                  : `These are sample feature briefs inspired by ${app.name}. Live app analysis is not connected in this demo.`}
            </p>
          </div>
          <div className="saved-hint">
            <Icon name="ShieldCheck" size={16} />
            <span>Choices save as you go.</span>
          </div>
        </aside>
      </div>
    </>
  );
}
function ReviewPage({
  draft,
  selected,
  mergedCount,
  count,
  update,
  removeFeature,
  build,
  showDesign,
}: {
  draft: Draft;
  selected: ReferenceApp[];
  mergedCount: number;
  count: number;
  update: (p: Partial<Draft>) => void;
  removeFeature: (a: string, f: string) => void;
  build: () => void;
  showDesign: () => void;
}) {
  const [error, setError] = useState("");
  const nameRef = useRef<HTMLInputElement>(null);
  const submit = () => {
    if (!draft.name.trim()) {
      setError("Give your app a name before continuing.");
      nameRef.current?.focus();
      return;
    }
    setError("");
    build();
  };
  return (
    <>
      <PageHead
        eyebrow="STEP 3 OF 4"
        title="Review your app"
        description="Check your app brief and feature mix, then create your browser demo."
      />
      <div className="review-layout">
        <div className="review-main">
          {draft.plan && (
            <section className="surface accepted-plan">
              <details>
                <summary className="approved-summary">
                  <div>
                    <span className="section-kicker">APPROVED COMBINATION</span>
                    <h2>{draft.plan.name}</h2>
                    <p>
                      {draft.plan.features.length} features ·{" "}
                      {draft.plan.source === "ai"
                        ? "AI suggestion"
                        : "Example plan"}
                    </p>
                  </div>
                  <span className="approved-expand">
                    View plan <Icon name="ChevronDown" size={17} />
                  </span>
                </summary>
                <PlanSummary plan={draft.plan} catalog={catalog(draft)} />
              </details>
            </section>
          )}
          <section className="surface review-basics">
            <div className="section-title">
              <div>
                <h2>Your app brief</h2>
                <p>Give your app a name, audience, and purpose.</p>
              </div>
              <Icon name="NotebookPen" size={22} />
            </div>
            <label className="form-label" htmlFor="app-name">
              What will you call it? <span>Required</span>
            </label>
            <input
              id="app-name"
              className={`text-input ${error ? "invalid" : ""}`}
              ref={nameRef}
              value={draft.name}
              placeholder="e.g. Little by Little"
              maxLength={60}
              onChange={(e) => {
                update({ name: e.target.value });
                setError("");
              }}
              aria-invalid={!!error}
              aria-describedby={error ? "name-error" : undefined}
            />
            {error && (
              <p id="name-error" className="field-error" role="alert">
                {error}
              </p>
            )}
            <div className="field-counter">{draft.name.length}/60</div>
            <label className="form-label" htmlFor="app-audience">
              Who is it for? <span>Optional</span>
            </label>
            <input
              id="app-audience"
              className="text-input"
              value={draft.audience}
              placeholder="e.g. Students who want a calmer study routine"
              maxLength={600}
              onChange={(e) => update({ audience: e.target.value })}
            />
            <label className="form-label" htmlFor="app-description">
              What should it help them do? <span>Optional</span>
            </label>
            <textarea
              id="app-description"
              className="text-input"
              value={draft.description}
              placeholder="A quiet place to focus, keep a journal, and build better habits…"
              maxLength={600}
              rows={3}
              onChange={(e) => update({ description: e.target.value })}
            />
            <fieldset className="style-fieldset">
              <legend>Visual style</legend>
              <div className="style-options">
                {(
                  [
                    {
                      id: "warm",
                      name: "Warm & clear",
                      colors: ["#f5efe5", "#c7533b", "#deb993"],
                    },
                    {
                      id: "sage",
                      name: "Calm & natural",
                      colors: ["#edf2e7", "#53765e", "#bacbaa"],
                    },
                    {
                      id: "ink",
                      name: "Clean & crisp",
                      colors: ["#f0f3f7", "#48627e", "#a8bed2"],
                    },
                  ] as const
                ).map((s) => (
                  <label
                    key={s.id}
                    className={`style-choice ${draft.style === s.id ? "selected" : ""}`}
                  >
                    <input
                      type="radio"
                      name="style"
                      value={s.id}
                      checked={draft.style === s.id}
                      onChange={() => update({ style: s.id as Style })}
                    />
                    <span className="color-swatches">
                      {s.colors.map((c) => (
                        <i key={c} style={{ background: c }} />
                      ))}
                    </span>
                    <span>{s.name}</span>
                    {draft.style === s.id && <Icon name="Check" size={13} />}
                  </label>
                ))}
              </div>
            </fieldset>
          </section>
          <section className="surface review-features">
            <div className="section-title">
              <div>
                <h2>Your selected features</h2>
                <p>
                  {mergedCount} {mergedCount === 1 ? "feature" : "features"},
                  inspired by {selected.length}{" "}
                  {selected.length === 1 ? "app" : "apps"}.
                </p>
              </div>
              <button className="text-button" onClick={() => go("/apps")}>
                Add more
                <Icon name="Plus" size={15} />
              </button>
            </div>
            {selected.map((a) => (
              <div className="review-app" key={a.id}>
                <div className="review-app-head">
                  <AppIcon app={a} small />
                  <h3>{a.name}</h3>
                  {a.market && !a.market.retained && (
                    <span className="market-chip">
                      #{a.market.rank} {a.domain}
                    </span>
                  )}
                  <button
                    className="text-button"
                    onClick={() => go("/apps/" + a.id)}
                  >
                    Edit
                    <Icon name="ArrowRight" size={13} />
                  </button>
                </div>
                <div className="review-tags">
                  {a.features
                    .filter((f) => draft.selected[a.id]?.includes(f.id))
                    .map((f) => (
                      <span key={f.id}>
                        <Icon name={f.icon} size={14} />
                        {f.name}
                        <button
                          aria-label={`Remove ${f.name} from ${a.name}`}
                          onClick={() => removeFeature(a.id, f.id)}
                        >
                          <Icon name="X" size={13} />
                        </button>
                      </span>
                    ))}
                </div>
              </div>
            ))}
            {count > mergedCount && (
              <div className="merge-note">
                <Icon name="Layers" size={16} />
                {count - mergedCount} repeated{" "}
                {count - mergedCount === 1
                  ? "choice becomes"
                  : "choices become"}{" "}
                part of a shared feature.
              </div>
            )}
          </section>
        </div>
        <aside className="create-panel">
          <div className="create-illustration" aria-hidden="true">
            <span>
              <Icon name="Layers" size={27} />
            </span>
            <i />
            <b>
              <Icon name="Sparkles" size={18} />
            </b>
          </div>
          <h2>Ready to try it?</h2>
          <p>Create a working demo and download the design documents.</p>
          <ul className="included-list">
            <li>
              <Icon name="Check" size={16} />
              An interactive browser demo
            </li>
            <li>
              <Icon name="Check" size={16} />
              Your combined design document
            </li>
            <li>
              <Icon name="Check" size={16} />A feature brief for each app
            </li>
            <li>
              <Icon name="Check" size={16} />
              Source files and a README
            </li>
          </ul>
          <Button onClick={submit}>
            Create my app
            <Icon name="Sparkles" size={17} />
          </Button>
          <button className="design-link" onClick={showDesign}>
            <Icon name="FileText" size={15} />
            Preview the design brief
          </button>
          <p className="fine-print">
            This demo uses a template. Live coding and Android builds come
            later.
          </p>
        </aside>
      </div>
      <button className="back-link" onClick={() => go("/apps")}>
        <Icon name="ArrowLeft" size={15} />
        Back to app plan
      </button>
    </>
  );
}
function ResultPage({
  draft,
  count,
  sources,
  openDemo,
  download,
  busy,
  showReadme,
  showDesign,
}: {
  draft: Draft;
  count: number;
  sources: number;
  openDemo: () => void;
  download: () => void;
  busy: boolean;
  showReadme: () => void;
  showDesign: () => void;
}) {
  const html = useMemo(() => demoHtml(draft), [draft]);
  return (
    <>
      <div className="result-head">
        <span className="ready-badge">
          <Icon name="Check" size={14} />
          YOUR DEMO IS READY
        </span>
        <h1>Your app is ready to try.</h1>
        <p>
          Meet <strong>{draft.name}</strong>. Your favorite ideas, brought
          together.
        </p>
      </div>
      <div className="result-layout">
        <section className="preview-window">
          <div className="preview-toolbar">
            <span className="window-dots">
              <i />
              <i />
              <i />
            </span>
            <span>{slug(draft)} / preview</span>
            <button
              className="icon-button"
              aria-label="Open demo in a new tab"
              onClick={openDemo}
            >
              <Icon name="ExternalLink" size={15} />
            </button>
          </div>
          <iframe
            title={`${draft.name} interactive preview`}
            srcDoc={html}
            sandbox="allow-scripts allow-forms allow-popups"
          />
        </section>
        <aside className="result-info">
          <span className="result-app-icon" data-style={draft.style}>
            <Icon name="Layers" size={35} />
          </span>
          <h2>{draft.name}</h2>
          <p>
            {draft.description ||
              "Your selected features. A space to call your own."}
          </p>
          <div className="result-numbers">
            <span>
              <b>{count}</b>features
            </span>
            <span>
              <b>{sources}</b>inspirations
            </span>
            <span>
              <b>01</b>your app
            </span>
          </div>
          <Button onClick={openDemo}>
            Open my demo
            <Icon name="ExternalLink" size={17} />
          </Button>
          <Button kind="secondary" onClick={download} disabled={busy}>
            <Icon
              name={busy ? "LoaderCircle" : "Download"}
              size={17}
              className={busy ? "spin" : ""}
            />
            {busy ? "Preparing download…" : "Download project"}
          </Button>
          <div className="result-files">
            <button onClick={showReadme}>
              <span className="file-icon">
                <Icon name="FileText" size={20} />
              </span>
              <span>
                <strong>README.md</strong>
                <small>Setup and usage instructions</small>
              </span>
              <Icon name="ArrowRight" size={16} />
            </button>
            <button onClick={showDesign}>
              <span className="file-icon">
                <Icon name="Layers" size={20} />
              </span>
              <span>
                <strong>Design & feature briefs</strong>
                <small>Combined plan and source features</small>
              </span>
              <Icon name="ArrowRight" size={16} />
            </button>
          </div>
          <div className="demo-boundary">
            <Icon name="Info" size={16} />
            <p>
              A working browser demo, made from a template. This is not an
              Android APK or a live agent build.
            </p>
          </div>
        </aside>
      </div>
      <div className="result-again">
        <Icon name="Settings2" size={18} />
        <span>Want to try a different mix?</span>
        <button className="text-button" onClick={() => go("/review")}>
          Refine your app
          <Icon name="ArrowRight" size={15} />
        </button>
      </div>
    </>
  );
}
function timeAgo(iso: string, now: number) {
  const minutes = Math.round((now - Date.parse(iso)) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)} h ago`;
  return iso.slice(0, 10);
}
function MarketSignals({
  draft,
  shown,
  connection,
  scans,
  scan,
  check,
  listing,
}: {
  draft: Draft;
  shown: ReferenceApp[];
  connection: MarketConnection | null;
  scans: Record<string, ScanState>;
  scan: (domain: string, refresh?: boolean) => void;
  check: () => void;
  listing: Listing;
}) {
  // Apps this domain shares with a domain listed earlier.
  const sharedWith = (domain: string, result: MarketResult) => {
    const others = result.apps
      .map((a) => shown.find((s) => s.id === a.appId)?.domain)
      .filter((d): d is string => !!d && d !== domain);
    return others.length
      ? ` · ${others.length} also under ${[...new Set(others)].join(", ")}`
      : "";
  };
  const [now, setNow] = useState(Date.now);
  const scanning = Object.values(scans).some((s) => s.phase === "scanning");
  useEffect(() => {
    setNow(Date.now());
    if (!scanning) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [scanning]);
  if (!connection) return null;
  if (!connection.available)
    return (
      <div className="market-panel offline" role="status">
        <Icon name="CircleAlert" size={18} />
        <div>
          <strong>Market signals are not connected</strong>
          <p>
            Showing the curated sample apps.{" "}
            {connection.reason ||
              "Run npm run setup:market in the frontend folder."}
          </p>
        </div>
        <button className="text-button" onClick={check}>
          Check again
        </button>
      </div>
    );
  return (
    <section className="market-panel" aria-labelledby="market-title">
      <div className="market-head">
        <Icon name="TrendingUp" size={18} />
        <div>
          <strong id="market-title">Market signals</strong>
          <p>
            Top apps per domain from a live Google Play scan, ranked by an
            opportunity score from 1 to 15.
            {listing.connection?.available &&
              " Claude Code summarizes the features in each store listing."}
          </p>
          {listing.connection && !listing.connection.available && (
            <p className="feature-off">
              Feature summaries are off. {listing.connection.reason}{" "}
              <button className="text-button" onClick={listing.check}>
                Check again
              </button>
            </p>
          )}
        </div>
      </div>
      <ul className="market-rows" aria-live="polite">
        {draft.domains.map((domain) => {
          const state = scans[domain];
          const result = draft.market?.[domain];
          const busy = state?.phase === "scanning";
          const summary = listing.states[domain];
          return (
            <li key={domain} data-domain={domain}>
              <span className="market-domain">{domain}</span>
              <span
                className={`market-state ${state?.phase === "error" ? "failed" : ""}`}
              >
                {busy && state.queued ? (
                  <>
                    <Icon name="LoaderCircle" size={14} className="spin" />
                    Waiting for another scan to finish…
                  </>
                ) : busy ? (
                  <>
                    <Icon name="LoaderCircle" size={14} className="spin" />
                    Scanning Google Play…{" "}
                    {Math.max(0, Math.round((now - state.startedAt) / 1000))}s
                  </>
                ) : state?.phase === "error" ? (
                  <>
                    <Icon name="CircleAlert" size={14} />
                    {state.message}
                  </>
                ) : result ? (
                  <>
                    <Icon
                      name={result.apps.length ? "CircleCheck" : "Info"}
                      size={14}
                    />
                    {result.apps.length
                      ? `Top ${result.apps.filter((a) => !a.retained).length} of ${result.ranked} ranked`
                      : domains.some((d) => d.name === domain)
                        ? "No apps found · showing samples"
                        : "No apps found"}
                    {sharedWith(domain, result)}
                    {result.status === "partial" && " · some requests failed"}
                    {result.status === "insufficient_results" &&
                      result.apps.length > 0 &&
                      " · fewer than five matches"}
                    <small>{timeAgo(result.generatedAt, now)}</small>
                    {summary && (
                      <span
                        className={`feature-status ${summary.phase === "error" ? "failed" : ""}`}
                      >
                        <Icon
                          name={summary.phase === "error" ? "CircleAlert" : "LoaderCircle"}
                          size={13}
                          className={summary.phase === "error" ? undefined : "spin"}
                        />
                        {summary.phase === "error"
                          ? summary.message
                          : summary.queued
                            ? "Features: waiting for Claude Code…"
                            : "Summarizing features with Claude Code…"}
                      </span>
                    )}
                  </>
                ) : (
                  "Waiting to scan…"
                )}
              </span>
              {summary?.phase === "error" && !busy && (
                <button
                  className="text-button"
                  onClick={() => listing.retry(domain)}
                  aria-label={`Retry features for ${domain}`}
                >
                  <Icon name="RefreshCw" size={13} />
                  Retry features
                </button>
              )}
              <button
                className="text-button"
                onClick={() => scan(domain, true)}
                disabled={busy}
                aria-label={`${state?.phase === "error" ? "Retry" : "Rescan"} ${domain}`}
              >
                <Icon name="RefreshCw" size={13} />
                {state?.phase === "error" ? "Retry" : "Rescan"}
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
type Listing = {
  connection: FeatureConnection | null;
  states: Record<string, FeatureState>;
  retry: (domain: string) => void;
  check: () => void;
};
// Why an app's store-listing features are not shown yet: Claude Code is
// summarizing, failed, is off, or the listing names no features.
function ListingStatus({ app, listing }: { app: MarketApp; listing: Listing }) {
  const listed = app.listedFeatures;
  const [domain, state] =
    Object.entries(listing.states).find(([, s]) => s.appIds.includes(app.appId)) || [];
  let status: ReactNode = null;
  if (listed?.items.length) return null;
  if (listed) status = "The store listing does not describe specific features.";
  else if (state?.phase === "running")
    status = (
      <>
        <Icon name="LoaderCircle" size={15} className="spin" />
        Summarizing the store listing with Claude Code…
      </>
    );
  else if (state?.phase === "error")
    status = (
      <>
        <Icon name="CircleAlert" size={15} />
        {state.message}
        <button className="text-button" onClick={() => listing.retry(domain!)}>
          Retry
        </button>
      </>
    );
  else if (listing.connection && !listing.connection.available)
    status = `Feature summaries are off. ${listing.connection.reason || ""}`;
  else if (app.retained)
    status = "This app is from an earlier scan; its listing was not summarized.";
  else if (app.description === undefined)
    status = "This scan predates store listings. Rescan the domain to see them.";
  else status = "Waiting for Claude Code…";
  return (
    <p className={`listed-status ${state?.phase === "error" ? "failed" : ""}`} role="status">
      {status}
    </p>
  );
}
function MarketMetrics({ app }: { app: MarketApp }) {
  return (
    <div className="market-metrics">
      <span>
        <Icon name="Star" size={13} />
        {app.rating === null ? "No rating" : app.rating.toFixed(1)}
      </span>
      <span>{formatInstalls(app.installs)} installs</span>
      <span className="market-score">Score {app.score}/15</span>
    </div>
  );
}
const componentLabels: Record<string, string> = {
  market_scale: "Install scale",
  quality: "Rating quality",
  rating_depth: "Rating depth",
  monetization_surface: "Monetization",
  recent_review_activity: "Recent reviews",
};
function MarketFacts({ app, result }: { app: MarketApp; result?: MarketResult }) {
  return (
    <section className="market-facts" aria-labelledby="market-facts-title">
      <h3 id="market-facts-title">
        <Icon name="TrendingUp" size={18} />
        Market signals
      </h3>
      <dl>
        <div>
          <dt>Rank</dt>
          <dd>
            {app.retained
              ? "Earlier scan"
              : `#${app.rank}${result ? ` of ${result.ranked}` : ""}`}
          </dd>
        </div>
        <div>
          <dt>Opportunity</dt>
          <dd>{app.score}/15</dd>
        </div>
        <div>
          <dt>Rating</dt>
          <dd>
            {app.rating === null ? "No rating" : `${app.rating.toFixed(1)} ★`}
            <small>{app.ratings.toLocaleString("en-US")} ratings</small>
          </dd>
        </div>
        <div>
          <dt>Installs</dt>
          <dd>{formatInstalls(app.installs)}</dd>
        </div>
        <div>
          <dt>Business model</dt>
          <dd>{monetization(app)}</dd>
        </div>
        <div>
          <dt>Recent reviews</dt>
          <dd>
            {app.recentReviews}
            <small>
              of the newest 100, last {result?.windowDays || "few"} days
            </small>
          </dd>
        </div>
      </dl>
      {Object.keys(app.components).length > 0 && (
        <div
          className="score-bars"
          role="group"
          aria-label="Opportunity score components"
        >
          {Object.entries(app.components).map(([key, value]) => (
            <div key={key}>
              <span>{componentLabels[key] || key.replace(/_/g, " ")}</span>
              <i>
                <b style={{ width: `${Math.round(value * 100)}%` }} />
              </i>
            </div>
          ))}
        </div>
      )}
      <a
        className="store-link"
        href={app.storeUrl}
        target="_blank"
        rel="noopener noreferrer"
      >
        View on Google Play
        <Icon name="ExternalLink" size={14} />
      </a>
      <p className="small">
        {app.developer} · {app.storeCategory}
        {result ? ` · scanned ${result.generatedAt.slice(0, 10)}` : ""}. The
        opportunity score is a proxy from public listing data, not revenue.
      </p>
    </section>
  );
}
function MarkdownDocument({ text }: { text: string }) {
  return (
    <article className="document-body">
      {text
        .split("\n")
        .filter(Boolean)
        .map((line, i) =>
          line.startsWith("# ") ? (
            <h2 key={i}>{line.slice(2)}</h2>
          ) : line.startsWith("## ") ? (
            <h3 key={i}>{line.slice(3)}</h3>
          ) : line.startsWith("### ") ? (
            <h4 key={i}>{line.slice(4)}</h4>
          ) : line.startsWith("- ") ? (
            <p className="document-bullet" key={i}>
              • {line.slice(2)}
            </p>
          ) : line.startsWith("> ") ? (
            <blockquote key={i}>{line.slice(2)}</blockquote>
          ) : (
            <p key={i}>{line}</p>
          ),
        )}
    </article>
  );
}
