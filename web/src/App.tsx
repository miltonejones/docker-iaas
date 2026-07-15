import { useCallback, useEffect, useRef, useState } from 'react';
import type { Container, Preset, UsageSnapshot } from './types';
import { api, subscribeUsage } from './api';
import { UsageHeader } from './components/UsageHeader';
import { Gallery } from './components/Gallery';
import { Instances } from './components/Instances';
import { LaunchModal } from './components/LaunchModal';
import { bytes } from './format';

export function App() {
  const [presets, setPresets] = useState<Preset[]>([]);
  const [containers, setContainers] = useState<Container[]>([]);
  const [usage, setUsage] = useState<UsageSnapshot | null>(null);
  const [live, setLive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pruning, setPruning] = useState(false);
  const [launchPreset, setLaunchPreset] = useState<Preset | null>(null);
  const lastBeat = useRef<number>(0);

  const refreshContainers = useCallback(async () => {
    try {
      setContainers(await api.containers());
    } catch (err) {
      console.error('containers', err);
    }
  }, []);

  // Initial load of the static-ish data.
  useEffect(() => {
    api.presets().then(setPresets).catch(console.error);
    refreshContainers();
  }, [refreshContainers]);

  // Live disk/Docker usage over SSE; fall back to a "reconnecting" indicator if
  // the stream goes quiet for more than two poll intervals.
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

  // Refresh instance list on a slower cadence to catch state changes (a DB that
  // finished starting, a crash, sizes growing) without a full page reload.
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
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand__mark">◈</span>
          <div>
            <h1>Docker IaaS Console</h1>
            <p className="brand__sub">Personal infrastructure, EC2-style.</p>
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

      <main className="content">
        <UsageHeader snapshot={usage} live={live} onPrune={onPrune} pruning={pruning} />
        <Instances containers={containers} busy={busy} onChanged={onChanged} />
        <Gallery presets={presets} onLaunch={setLaunchPreset} />
      </main>

      {launchPreset && (
        <LaunchModal
          preset={launchPreset}
          onClose={() => setLaunchPreset(null)}
          onLaunched={onChanged}
        />
      )}
    </div>
  );
}
