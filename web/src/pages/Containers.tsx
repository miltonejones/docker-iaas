import { useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import type { Container, ContainerDetail, Preset } from '../types';
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

export function ContainersPage({ containers, presets, busy, onChanged }: Props) {
  const navigate = useNavigate();
  const location = useLocation();
  const isNew = location.pathname === '/containers/new';

  const [launchPreset, setLaunchPreset] = useState<Preset | null>(null);
  const [selectedContainer, setSelectedContainer] = useState<Container | null>(null);
  const [relaunch, setRelaunch] = useState<{
    preset: Preset;
    prefill: { name: string; ports: { container: string; host: number; label?: string }[]; env: { key: string; value: string }[] };
    replaceId: string;
  } | null>(null);

  const visibleContainers = containers.filter((c) => !c.system);

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

  return (
    <div>
      <Instances
        containers={visibleContainers}
        busy={busy}
        onChanged={onChanged}
        onSelect={setSelectedContainer}
        onNewInstance={() => navigate('/containers/new')}
      />

      {selectedContainer && (
        <InstanceDetail
          container={selectedContainer}
          onClose={() => setSelectedContainer(null)}
          onChanged={onChanged}
          onRelaunch={(detail: ContainerDetail) => {
            const preset = presets.find(
              (p) => p.image === detail.image || p.id === detail.labels?.['iaas.preset'],
            );
            if (preset) {
              setSelectedContainer(null);
              setRelaunch({
                preset,
                prefill: {
                  name: detail.name,
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
      )}

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
