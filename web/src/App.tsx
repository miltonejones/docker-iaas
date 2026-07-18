import { useCallback, useEffect, useRef, useState } from 'react';
import { BrowserRouter, Link, NavLink, Route, Routes, useLocation } from 'react-router-dom';
import type { AssistantSessionSummary, Container, Preset, UsageSnapshot } from './types';
import { api, subscribeUsage } from './api';
import { bytes, timeAgo } from './format';
import { HomePage } from './pages/Home';
import { ContainersPage } from './pages/Containers';
import { FunctionsPage } from './pages/Functions';
import { BucketsPage } from './pages/Buckets';
import { GatewayPage } from './pages/Gateway';
import { DatabasesPage } from './pages/Databases';
import { AssistantBar } from './components/AssistantBar';
import { emitRefresh } from './refresh';
import { AppIcon } from './icons';

const SERVICES = [
  { path: '/', label: 'Home', icon: 'home' },
  { path: '/containers', label: 'Containers', icon: 'container' },
  { path: '/functions', label: 'Functions', icon: 'function' },
  { path: '/buckets', label: 'Buckets', icon: 'bucket' },
  { path: '/databases', label: 'Databases', icon: 'database' },
  { path: '/gateway', label: 'Gateway', icon: 'gateway' },
] as const;

function ServiceNav() {
  return (
    <nav className="service-nav">
      {SERVICES.map((s) => (
        <NavLink
          key={s.path}
          to={s.path}
          end={s.path === '/'}
          className={({ isActive }) => `service-nav__btn${isActive ? ' service-nav__btn--active' : ''}`}
        >
          <AppIcon name={s.icon} /> {s.label}
        </NavLink>
      ))}
    </nav>
  );
}

function Breadcrumbs() {
  const location = useLocation();
  const pathname = location.pathname;

  // Detail routes (e.g. /functions/:id) live one level under a service path —
  // match by prefix so the trail stays populated while drilled in.
  const current = SERVICES.find((s) => s.path !== '/' && pathname.startsWith(s.path));
  const currentLabel = current?.label ?? null;

  const functionId = pathname.match(/^\/functions\/(.+)$/)?.[1];
  const [functionName, setFunctionName] = useState<string | null>(null);

  useEffect(() => {
    if (!functionId || functionId === 'new') {
      setFunctionName(null);
      return;
    }
    api
      .lambdaListFunctions()
      .then((list) => setFunctionName(list.find((f) => f.id === functionId)?.name ?? null))
      .catch(() => setFunctionName(null));
  }, [functionId]);

  const isNewContainer = pathname === '/containers/new';
  const containerId = pathname.match(/^\/containers\/(.+)$/)?.[1];
  const [containerName, setContainerName] = useState<string | null>(null);

  useEffect(() => {
    if (!containerId || containerId === 'new') {
      setContainerName(null);
      return;
    }
    api
      .containers()
      .then((list) => setContainerName(list.find((c) => c.id === containerId)?.name ?? null))
      .catch(() => setContainerName(null));
  }, [containerId]);

  const gatewayName = pathname.match(/^\/gateway\/(.+)$/)?.[1];
  const bucketName = pathname.match(/^\/buckets\/(.+)$/)?.[1];
  const databaseId = pathname.match(/^\/databases\/(.+)$/)?.[1];
  const [databaseName, setDatabaseName] = useState<string | null>(null);

  useEffect(() => {
    if (!databaseId || databaseId === 'new') {
      setDatabaseName(null);
      return;
    }
    api
      .databaseConnections()
      .then((list) => setDatabaseName(list.find((connection) => connection.id === databaseId)?.name ?? null))
      .catch(() => setDatabaseName(null));
  }, [databaseId]);

  const detailLabel = functionId
    ? (functionId === 'new' ? 'New function' : functionName ?? 'Function')
    : isNewContainer
      ? 'New instance'
      : containerId && containerId !== 'new'
        ? (containerName ?? 'Instance')
        : gatewayName
          ? `/gw/${gatewayName}`
          : bucketName
            ? bucketName
            : databaseId
              ? (databaseId === 'new' ? 'New connection' : databaseName ?? 'Connection')
              : null;

  if (pathname === '/') return null;

  return (
    <nav className="breadcrumbs" aria-label="Breadcrumb">
      <Link to="/" className="breadcrumbs__link">Home</Link>
      {currentLabel && (
        <>
          <span className="breadcrumbs__sep">/</span>
          {detailLabel ? (
            <Link to={current!.path} className="breadcrumbs__link">{currentLabel}</Link>
          ) : (
            <span className="breadcrumbs__current">{currentLabel}</span>
          )}
        </>
      )}
      {detailLabel && (
        <>
          <span className="breadcrumbs__sep">/</span>
          <span className="breadcrumbs__current">{detailLabel}</span>
        </>
      )}
    </nav>
  );
}

export function App() {
  const [presets, setPresets] = useState<Preset[]>([]);
  const [containers, setContainers] = useState<Container[]>([]);
  const [usage, setUsage] = useState<UsageSnapshot | null>(null);
  const [live, setLive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pruning, setPruning] = useState(false);
  const [assistantQuery, setAssistantQuery] = useState('');
  const [assistantModal, setAssistantModal] = useState<{
    prompt?: string;
    sessionId?: string;
  } | null>(null);
  const [modalKey, setModalKey] = useState(0);
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const [sessionsList, setSessionsList] = useState<AssistantSessionSummary[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const lastBeat = useRef<number>(0);

  // First-ever visit to the console's root path sends the browser to the
  // marketing site instead. Tracked in localStorage so it only fires once
  // per browser, and only on "/" — deep links (e.g. a saved /functions/:id
  // bookmark) are never hijacked.
  useEffect(() => {
    if (window.location.pathname !== '/') return;
    if (localStorage.getItem('dockyard-visited')) return;
    localStorage.setItem('dockyard-visited', '1');
    window.location.replace('/gw/dockyard-marketing/');
  }, []);

  function submitAssistantQuery() {
    const q = assistantQuery.trim();
    if (!q) return;
    setModalKey((k) => k + 1);
    setAssistantModal({ prompt: q });
    setAssistantQuery('');
  }

  function openSessionInAssistant(id: string) {
    setSessionsOpen(false);
    setModalKey((k) => k + 1);
    setAssistantModal({ sessionId: id });
  }

  async function deleteSavedSession(id: string) {
    try {
      await api.assistantDeleteSession(id);
      setSessionsList((list) => list.filter((s) => s.id !== id));
    } catch (err) {
      console.error('delete session', err);
    }
  }

  async function toggleSessionsOffcanvas() {
    if (sessionsOpen) {
      setSessionsOpen(false);
      return;
    }
    setSessionsOpen(true);
    setSessionsLoading(true);
    try {
      setSessionsList(await api.assistantListSessions());
    } catch (err) {
      console.error('sessions', err);
    } finally {
      setSessionsLoading(false);
    }
  }

  const refreshContainers = useCallback(async () => {
    try {
      setContainers(await api.containers());
    } catch (err) {
      console.error('containers', err);
    }
  }, []);

  // Initial load.
  useEffect(() => {
    api.presets().then(setPresets).catch(console.error);
    refreshContainers();
  }, [refreshContainers]);

  // Live disk/Docker usage over SSE.
  useEffect(() => {
    const unsub = subscribeUsage((snap) => {
      setUsage(snap);
      setLive(true);
      lastBeat.current = Date.now();
    });
    const watchdog = setInterval(() => {
      if (Date.now() - lastBeat.current > 12000) setLive(false);
    }, 4000);
    return () => {
      unsub();
      clearInterval(watchdog);
    };
  }, []);

  // Refresh instance list on a slower cadence.
  useEffect(() => {
    const t = setInterval(refreshContainers, 6000);
    return () => clearInterval(t);
  }, [refreshContainers]);

  const onChanged = useCallback(() => {
    setBusy(true);
    refreshContainers().finally(() => setBusy(false));
  }, [refreshContainers]);

  async function onPrune() {
    setPruning(true);
    try {
      const { reclaimedBytes } = await api.prune();
      alert(`Reclaimed ${bytes(reclaimedBytes)}.`);
      refreshContainers();
    } catch (err) {
      alert((err as Error).message);
    } finally {
      setPruning(false);
    }
  }

  const running = containers.filter((c) => c.state === 'running' && !c.system).length;

  return (
    <BrowserRouter>
      <div className="app">
        <header className="topbar">
          <div className="topbar__left">
            <button
              className="hamburger"
              onClick={toggleSessionsOffcanvas}
              title="Saved sessions"
              aria-label="Open saved sessions"
            >
              <AppIcon name="menu" />
            </button>
            <Link to="/" className="brand">
              <span className="brand__mark">◈</span>
              <div>
                <h1>Dockyard.ai</h1>
              </div>
            </Link>
            <ServiceNav />
            <label className="assistant-search">
              <span className="assistant-search__icon"><AppIcon name="assistant" /></span>
              <input
                value={assistantQuery}
                onChange={(e) => setAssistantQuery(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && submitAssistantQuery()}
                placeholder="Ask Dockyard.ai to do something..."
              />
            </label>
          </div>
        </header>

        {/* Saved sessions offcanvas */}
        {sessionsOpen && (
          <div className="offcanvas-backdrop" onClick={() => setSessionsOpen(false)}>
            <aside className="offcanvas offcanvas--left" onClick={(e) => e.stopPropagation()}>
              <div className="offcanvas__head">
                <h3>Saved sessions</h3>
                <button className="btn btn--ghost" onClick={() => setSessionsOpen(false)}>
                  Close
                </button>
              </div>
              <div className="offcanvas__body">
                {sessionsLoading && <p className="muted empty-sm">Loading…</p>}
                {!sessionsLoading && sessionsList.length === 0 && (
                  <p className="muted empty-sm">No saved sessions yet.</p>
                )}
                {sessionsList.map((s) => (
                  <div key={s.id} className="offcanvas-session-row-wrap">
                    <button className="offcanvas-session-row" onClick={() => openSessionInAssistant(s.id)}>
                      <span className="offcanvas-session-row__name">{s.name}</span>
                      <span className="offcanvas-session-row__time muted">
                        {timeAgo(new Date(s.updatedAt).getTime() / 1000)}
                      </span>
                    </button>
                    <button
                      className="btn btn--ghost btn--sm offcanvas-session-row__delete"
                      title="Delete session"
                      onClick={() => deleteSavedSession(s.id)}
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            </aside>
          </div>
        )}

        {assistantModal && (
          <AssistantBar
            key={modalKey}
            initialPrompt={assistantModal.prompt}
            initialSessionId={assistantModal.sessionId}
            onClose={() => setAssistantModal(null)}
            onChanged={() => {
              // App holds container state (header/Home/Containers all read it),
              // so refresh that here, then broadcast so whichever page is
              // mounted (Functions/Buckets/Gateway/Home) reloads its own data.
              refreshContainers();
              emitRefresh();
            }}
          />
        )}

        <Breadcrumbs />

        <main className="content">
          <Routes>
              <Route
                path="/"
                element={
                  <HomePage
                    snapshot={usage}
                    live={live}
                    onPrune={onPrune}
                    pruning={pruning}
                    runningCount={running}
                    totalCount={containers.length}
                  />
                }
              />
              <Route
                path="/containers/new"
                element={
                  <ContainersPage
                    containers={containers}
                    presets={presets}
                    busy={busy}
                    onChanged={onChanged}
                  />
                }
              />
              <Route
                path="/containers/:id"
                element={
                  <ContainersPage
                    containers={containers}
                    presets={presets}
                    busy={busy}
                    onChanged={onChanged}
                  />
                }
              />
              <Route
                path="/containers"
                element={
                  <ContainersPage
                    containers={containers}
                    presets={presets}
                    busy={busy}
                    onChanged={onChanged}
                  />
                }
              />
              <Route path="/functions/:id" element={<FunctionsPage />} />
              <Route path="/functions" element={<FunctionsPage />} />
              <Route path="/buckets/:name" element={<BucketsPage />} />
              <Route path="/buckets" element={<BucketsPage />} />
              <Route path="/databases/:id" element={<DatabasesPage />} />
              <Route path="/databases" element={<DatabasesPage />} />
              <Route path="/gateway/:name" element={<GatewayPage />} />
              <Route path="/gateway" element={<GatewayPage />} />
            </Routes>
          </main>

        <footer className="app-footer">
          <span className="muted">Deploy anything. Ask for the rest.</span>
          <a
            href="https://github.com/miltonejones/docker-iaas"
            target="_blank"
            rel="noreferrer"
            className="app-footer__link"
          >
            GitHub <AppIcon name="external" />
          </a>
        </footer>
      </div>
    </BrowserRouter>
  );
}
