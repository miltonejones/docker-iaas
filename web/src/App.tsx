import { useCallback, useEffect, useRef, useState } from 'react';
import { BrowserRouter, Link, NavLink, Route, Routes, useLocation } from 'react-router-dom';
import type { AssistantSessionSummary, Container, Preset, UsageSnapshot } from './types';
import { api, subscribeUsage } from './api';
import { bytes, timeAgo } from './format';
import { HomePage } from './pages/Home';
import { InstancesPage } from './pages/Instances';
import { FunctionsPage } from './pages/Functions';
import { BucketsPage } from './pages/Buckets';
import { GatewayPage } from './pages/Gateway';
import { DatabasesPage } from './pages/Databases';
import { AssistantBar } from './components/AssistantBar';
import { CreateIssueModal } from './components/CreateIssueModal';
import { LoginPage } from './components/LoginPage';
import { useAuth } from './AuthContext';
import { emitRefresh } from './refresh';
import { onOpenAssistant } from './assistant';
import { AppIcon } from './icons';
import { ToastViewport } from './components/ToastViewport';
import { useToast } from './ToastContext';

const SERVICES = [
  { path: '/', label: 'Home', icon: 'home' },
  { path: '/containers', label: 'Instances', icon: 'container' },
  { path: '/functions', label: 'Functions', icon: 'function' },
  { path: '/buckets', label: 'Buckets', icon: 'bucket' },
  { path: '/databases', label: 'Databases', icon: 'database' },
  { path: '/gateway', label: 'Gateway', icon: 'gateway' },
] as const;

function ServiceNav() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const location = useLocation();
  const current = SERVICES.find((s) => location.pathname === s.path || (s.path !== '/' && location.pathname.startsWith(s.path)));

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  return (
    <div className="service-dropdown" ref={ref}>
      <button className="service-dropdown__btn" onClick={() => setOpen(!open)}>
        <AppIcon name={current?.icon || 'menu'} /> {current?.label || 'Menu'} <span className="service-dropdown__chevron">{open ? '▴' : '▾'}</span>
      </button>
      {open && (
        <div className="service-dropdown__menu">
          {SERVICES.map((s) => (
            <NavLink
              key={s.path}
              to={s.path}
              end={s.path === '/'}
              className={({ isActive }) => `service-dropdown__item${isActive ? ' service-dropdown__item--active' : ''}`}
              onClick={() => setOpen(false)}
            >
              <AppIcon name={s.icon} /> {s.label}
            </NavLink>
          ))}
        </div>
      )}
    </div>
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
          ? `gw/${gatewayName}`
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
          <span className="breadcrumbs__sep">&gt;</span>
          {detailLabel ? (
            <Link to={current!.path} className="breadcrumbs__link">{currentLabel}</Link>
          ) : (
            <span className="breadcrumbs__current">{currentLabel}</span>
          )}
        </>
      )}
      {detailLabel && (
        <>
          <span className="breadcrumbs__sep">&gt;</span>
          <span className="breadcrumbs__current">{detailLabel}</span>
        </>
      )}
    </nav>
  );
}

export function App() {
  const { token, email, logout } = useAuth();
  const toast = useToast();
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
  const PINNED_KEY = 'dockyard:assistant-pinned';
  const [assistantPinned, setAssistantPinned] = useState(() => localStorage.getItem(PINNED_KEY) === '1');
  const [assistantSessionId, setAssistantSessionId] = useState<string | undefined>(undefined);
  const [modalKey, setModalKey] = useState(0);
  const [createIssueOpen, setCreateIssueOpen] = useState(false);

  // Persist pinned preference whenever it changes.
  useEffect(() => {
    localStorage.setItem(PINNED_KEY, assistantPinned ? '1' : '0');
  }, [assistantPinned]);
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const [sessionsList, setSessionsList] = useState<AssistantSessionSummary[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [sessionsQuery, setSessionsQuery] = useState('');
  const lastBeat = useRef<number>(0);

  // First-ever visit to the console's root path also opens the marketing
  // site. Tracked in localStorage so it only fires once per browser, and
  // only on "/" — deep links (e.g. a saved /functions/:id bookmark) are
  // never hijacked. Gateway links always open in a new window rather than
  // replacing the console tab.
  useEffect(() => {
    if (window.location.pathname !== '/') return;
    if (localStorage.getItem('dockyard-visited')) return;
    localStorage.setItem('dockyard-visited', '1');
    window.open('/gw/dockyard-marketing/', '_blank', 'noopener,noreferrer');
  }, []);

  // Detail pages emit this when their info icon is clicked, asking the
  // assistant to open with a prompt explaining the object being viewed.
  useEffect(() => onOpenAssistant((prompt) => {
    setModalKey((k) => k + 1);
    setAssistantModal({ prompt });
  }), []);

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
    const session = sessionsList.find((s) => s.id === id);
    const label = session?.name ? `"${session.name}"` : 'this session';
    if (!confirm(`Delete ${label}? This cannot be undone.`)) return;
    try {
      await api.assistantDeleteSession(id);
      setSessionsList((list) => list.filter((s) => s.id !== id));
    } catch (err) {
      console.error('delete session', err);
    }
  }

  function toggleSessionsOffcanvas() {
    if (sessionsOpen) {
      setSessionsOpen(false);
      return;
    }
    setSessionsQuery('');
    setSessionsOpen(true);
  }

  // Fetches the saved sessions list whenever the panel opens or the search
  // box changes, debounced so typing doesn't fire a request per keystroke.
  // The server matches the query against both session names and their full
  // conversation content, so this doubles as a content search.
  useEffect(() => {
    if (!sessionsOpen) return;
    setSessionsLoading(true);
    const handle = setTimeout(async () => {
      try {
        setSessionsList(await api.assistantListSessions(sessionsQuery));
      } catch (err) {
        console.error('sessions', err);
      } finally {
        setSessionsLoading(false);
      }
    }, sessionsQuery ? 250 : 0);
    return () => clearTimeout(handle);
  }, [sessionsQuery, sessionsOpen]);

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
      toast.success(`Reclaimed ${bytes(reclaimedBytes)}.`);
      refreshContainers();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setPruning(false);
    }
  }

  const running = containers.filter((c) => c.state === 'running' && !c.system).length;

  if (!token) return <LoginPage />;

  return (
    <BrowserRouter>
      <div className="app">
        <ToastViewport />
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
          </div>
          <div className="topbar__center">
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
          <div className="topbar__right">
            <button
              className="btn btn--ghost btn--sm"
              onClick={() => {
                if (confirm('Sign out of Dockyard.ai?')) logout();
              }}
              title={`Sign out (${email})`}
            >
              <AppIcon name="logout" />
            </button>
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
              <div className="offcanvas__search">
                <input
                  type="search"
                  className="input"
                  placeholder="Search sessions…"
                  value={sessionsQuery}
                  onChange={(e) => setSessionsQuery(e.target.value)}
                  aria-label="Search saved sessions"
                  autoFocus
                />
              </div>
              <div className="offcanvas__body">
                {sessionsLoading && <p className="muted empty-sm">Loading…</p>}
                {!sessionsLoading && sessionsList.length === 0 && sessionsQuery.trim() && (
                  <p className="muted empty-sm">No sessions match "{sessionsQuery.trim()}".</p>
                )}
                {!sessionsLoading && sessionsList.length === 0 && !sessionsQuery.trim() && (
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

        {assistantModal && !assistantPinned && (
          <AssistantBar
            key={modalKey}
            initialPrompt={assistantModal.prompt}
            initialSessionId={assistantModal.sessionId}
            onClose={() => { setAssistantModal(null); setAssistantSessionId(undefined); }}
            onPin={() => setAssistantPinned(true)}
            onChanged={() => { refreshContainers(); emitRefresh(); }}
            onSessionId={(id) => setAssistantSessionId(id ?? undefined)}
          />
        )}

        <Breadcrumbs />

        <div className="workspace">
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
                  <InstancesPage
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
                  <InstancesPage
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
                  <InstancesPage
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
          {assistantModal && assistantPinned && (
            <aside className="assistant-pinned-panel">
              <div className="assistant-pinned-panel__head">
                <span>Ask Dockyard</span>
                <span>
                  <button className="btn btn--ghost btn--sm" onClick={() => setAssistantPinned(false)} title="Unpin to modal">
                    <AppIcon name="external" /> Unpin
                  </button>
                  <button className="btn btn--ghost btn--sm" onClick={() => { setAssistantModal(null); setAssistantPinned(false); }}>
                    <AppIcon name="close" /> Close
                  </button>
                </span>
              </div>
              <AssistantBar
                key={modalKey}
                embedded
                initialPrompt={assistantModal.prompt}
                initialSessionId={assistantModal.sessionId ?? assistantSessionId}
                onClose={() => { setAssistantModal(null); setAssistantPinned(false); }}
                onChanged={() => { refreshContainers(); emitRefresh(); }}
              />
            </aside>
          )}
        </div>

        <footer className="app-footer">
          <div className="app-footer__group">
            <span className="muted">Deploy anything. Ask for the rest.</span>
            <button
              type="button"
              className="app-footer__link app-footer__link--button"
              onClick={() => setCreateIssueOpen(true)}
            >
              Create an issue
            </button>
          </div>
          <a
            href="https://github.com/miltonejones/docker-iaas"
            target="_blank"
            rel="noreferrer"
            className="app-footer__link app-footer__link--github"
          >
            <AppIcon name="github" /> GitHub
          </a>
        </footer>
        {createIssueOpen && <CreateIssueModal onClose={() => setCreateIssueOpen(false)} />}
      </div>
    </BrowserRouter>
  );
}
