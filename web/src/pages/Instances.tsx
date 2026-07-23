import { useEffect, useState } from 'react';
import { useNavigate, useLocation, useParams } from 'react-router-dom';
import type { Container, ContainerDetail, Preset } from '../types';
import { api } from '../api';
import { Gallery } from '../components/Gallery';
import { Instances } from '../components/Instances';
import { InstanceDetail } from '../components/InstanceDetail';
import { LaunchModal } from '../components/LaunchModal';

interface Props {
  containers: Container[];
  presets: Preset[];
  busy: boolean;
  onChanged: () => void;
}

export function InstancesPage({ containers, presets, busy, onChanged }: Props) {
  const navigate = useNavigate();
  const location = useLocation();
  const { id } = useParams<{ id: string }>();
  const isNew = location.pathname === '/containers/new';

  const [launchPreset, setLaunchPreset] = useState<Preset | null>(null);
  const [relaunch, setRelaunch] = useState<{
    preset: Preset;
    prefill: { name: string; description?: string; ports: { container: string; host: number; label?: string }[]; env: { key: string; value: string }[] };
    replaceId: string;
  } | null>(null);

  if (isNew) {
    return (
      <div>
        <Gallery presets={presets} onLaunch={setLaunchPreset} />
        {launchPreset && (
          <LaunchModal
            preset={launchPreset}
            onClose={() => setLaunchPreset(null)}
            onLaunched={() => { setLaunchPreset(null); navigate('/containers'); onChanged(); }}
          />
        )}
      </div>
    );
  }

  // Detail view — /containers/:id
  if (id) {
    return (
      <>
        <ContainerDetail
          id={id}
          containers={containers}
          onChanged={onChanged}
          onBack={() => navigate('/containers')}
          onRelaunch={(detail: ContainerDetail) => {
            const preset = presets.find(
              (p) => p.image === detail.image || p.id === detail.labels?.['iaas.preset'],
            );
            if (preset) {
              setRelaunch({
                preset,
                prefill: {
                  name: detail.name,
                  description: detail.description,
                  ports: detail.ports
                    .filter((p) => p.publicPort)
                    .map((p) => ({
                      container: `${p.privatePort}/${p.type}`,
                      host: p.publicPort!,
                    })),
                  env: detail.env.map((e) => {
                    const [key, ...rest] = e.split('=');
                    return { key, value: rest.join('=') };
                  }),
                },
                replaceId: detail.id,
              });
            } else {
              alert('No matching preset found for this container. Remove and re-launch manually.');
            }
          }}
        />

        {relaunch && (
          <LaunchModal
            preset={relaunch.preset}
            prefill={relaunch.prefill}
            replaceId={relaunch.replaceId}
            onClose={() => setRelaunch(null)}
            onLaunched={() => {
              setRelaunch(null);
              onChanged();
              navigate('/containers');
            }}
          />
        )}
      </>
    );
  }

  // List view — /containers
  return (
    <div>
      <Instances
        containers={containers}
        busy={busy}
        onChanged={onChanged}
        onSelect={(c) => navigate(`/containers/${c.id}`)}
        onNewInstance={() => navigate('/containers/new')}
      />

      {relaunch && (
        <LaunchModal
          preset={relaunch.preset}
          prefill={relaunch.prefill}
          replaceId={relaunch.replaceId}
          onClose={() => setRelaunch(null)}
          onLaunched={() => {
            setRelaunch(null);
            onChanged();
          }}
        />
      )}
    </div>
  );
}

interface DetailProps {
  id: string;
  containers: Container[];
  onChanged: () => void;
  onBack: () => void;
  onRelaunch: (detail: ContainerDetail) => void;
}

function ContainerDetail({ id, containers, onChanged, onBack, onRelaunch }: DetailProps) {
  const [resolved, setResolved] = useState<Container | null>(
    () => containers.find((c) => c.id === id) ?? null,
  );

  // Resolve the container from the prop list; if it's missing (cold refresh
  // before the App-level list has loaded), fetch once as a fallback.
  useEffect(() => {
    const fromProps = containers.find((c) => c.id === id);
    if (fromProps) {
      setResolved(fromProps);
      return;
    }
    let cancelled = false;
    api
      .containers()
      .then((list) => {
        if (!cancelled) setResolved(list.find((c) => c.id === id) ?? null);
      })
      .catch(() => {
        if (!cancelled) setResolved(null);
      });
    return () => {
      cancelled = true;
    };
  }, [id, containers]);

  if (!resolved) {
    return <section className="panel"><p className="muted empty">Loading…</p></section>;
  }

  return (
    <InstanceDetail
      container={resolved}
      embedded
      onClose={onBack}
      onChanged={onChanged}
      onRelaunch={onRelaunch}
    />
  );
}