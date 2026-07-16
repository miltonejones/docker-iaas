import { useCallback, useEffect, useRef, useState } from 'react';
import { BrowserRouter, Link, NavLink, Route, Routes, useLocation } from 'react-router-dom';
import type { Container, Preset, UsageSnapshot } from './types';
import { api, subscribeUsage } from './api';
import { bytes } from './format';
import { HomePage } from './pages/Home';
import { ContainersPage } from './pages/Containers';
import { FunctionsPage } from './pages/Functions';
import { BucketsPage } from './pages/Buckets';
import { GatewayPage } from './pages/Gateway';

const SERVICES = [
  { path: '/', label: '◈ Home' },
  { path: '/containers', label: '📦 Containers' },
  { path: '/functions', label: '⚡ Functions' },
  { path: '/buckets', label: '🪣 Buckets' },
  { path: '/gateway', label: '🌉 Gateway' },
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
          {s.label}
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
  const currentLabel = current ? current.label.replace(/^\S+\s/, '') : null;

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
  const gatewayName = pathname.match(/^\/gateway\/(.+)$/)?.[1];

  const detailLabel = functionId
    ? (functionId === 'new' ? 'New function' : functionName ?? 'Function')
    : isNewContainer
      ? 'New instance'
      : gatewayName
        ? `/gw/${gatewayName}`
        : null;

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
  const lastBeat = useRef<number>(0);

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

  const running = containers.filter((c) => c.state === 'running').length;

  return (
    <BrowserRouter>
      <div className="app">
        <header className="topbar">
          <div className="topbar__left">
            <Link to="/" className="brand">
              <span className="brand__mark">◈</span>
              <div>
                <h1>Dockyard</h1>
                <p className="brand__sub">Personal container management, EC2-style.</p>
              </div>
            </Link>
            <ServiceNav />
          </div>
          <div className="topbar__stats">
            <span>
              <strong>{running}</strong> running
            </span>
            <span>
              <strong>{containers.length}</strong> total
            </span>
          </div>
        </header>

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
              <Route path="/buckets" element={<BucketsPage />} />
              <Route path="/gateway/:name" element={<GatewayPage />} />
              <Route path="/gateway" element={<GatewayPage />} />
            </Routes>
          </main>
      </div>
    </BrowserRouter>
  );
}
