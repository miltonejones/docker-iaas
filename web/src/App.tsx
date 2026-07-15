import { useCallback, useEffect, useRef, useState } from 'react';
import { BrowserRouter, NavLink, Route, Routes } from 'react-router-dom';
import type { Container, Preset, UsageSnapshot } from './types';
import { api, subscribeUsage } from './api';
import { bytes } from './format';
import { HomePage } from './pages/Home';
import { ContainersPage } from './pages/Containers';
import { FunctionsPage } from './pages/Functions';

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
          <div className="brand">
            <span className="brand__mark">◈</span>
            <div>
              <h1>Dockyard</h1>
              <p className="brand__sub">Personal container management, EC2-style.</p>
            </div>
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

        <div className="app-body">
          <nav className="sidebar">
            <NavLink to="/" end className={({ isActive }) => `sidebar__link${isActive ? ' sidebar__link--active' : ''}`}>
              <span className="sidebar__icon">◈</span>
              Home
            </NavLink>
            <NavLink to="/containers" className={({ isActive }) => `sidebar__link${isActive ? ' sidebar__link--active' : ''}`}>
              <span className="sidebar__icon">📦</span>
              Containers
            </NavLink>
            <NavLink to="/functions" className={({ isActive }) => `sidebar__link${isActive ? ' sidebar__link--active' : ''}`}>
              <span className="sidebar__icon">⚡</span>
              Functions
            </NavLink>
          </nav>

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
              <Route path="/functions" element={<FunctionsPage />} />
            </Routes>
          </main>
        </div>
      </div>
    </BrowserRouter>
  );
}
