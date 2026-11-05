// « Play a sound » / « Stop a sound » of the Logic: a sound of the project's or the shared library,
// sent to the audio outputs of the channel (Flux sorties).
import { useEffect, useState } from 'react';
import type { LogicNode } from '../engine/types';
import type { AudioState } from '../outputs/types';
import { api, mediaUrl, useApp, type MediaFile } from '../store';
import { Dropdown } from '../ui/Dropdown';
import { NumberField, Segmented } from '../ui/fields';
import { t } from '../i18n';

type Opt = { value: string; label: string; group?: string };

/** Lists read once per page (the libraries change rarely while the Logic is edited). */
const cache = new Map<string, Promise<unknown>>();
function useList<T>(url: string, fallback: T): T {
  const [v, setV] = useState<T>(fallback);
  useEffect(() => {
    let live = true;
    if (!cache.has(url)) cache.set(url, api<T>('GET', url).catch(() => (cache.delete(url), fallback)));
    void (cache.get(url) as Promise<T>).then((x) => live && setV(x));
    return () => void (live = false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);
  return v;
}

/** The sounds of the project's library, then the shared one's. */
function useSounds(): Opt[] {
  const projectId = useApp((s) => s.project?.id ?? null);
  const own = useList<MediaFile[]>(mediaUrl(projectId), []);
  const shared = useList<MediaFile[]>(mediaUrl(null), []);
  const audio = (l: MediaFile[], group: string) => l.filter((m) => m.kind === 'audio').map((m) => ({ value: m.src, label: m.label ?? m.name, group }));
  return [...(projectId ? audio(own, t('Project')) : []), ...audio(shared, t('Shared'))];
}

/** The audio outputs of the channels ("" = every one of the channel the project plays on). */
function useOutputs(): Opt[] {
  const list = useList<AudioState[]>('/api/audio/status', []);
  const seen = new Map<string, string>();
  for (const a of list) if (!seen.has(a.id)) seen.set(a.id, a.name);
  return [{ value: '', label: t('Every audio output') }, ...[...seen].map(([value, label]) => ({ value, label }))];
}

/** The name of a sound (its file). */
const fileName = (src: string) => decodeURIComponent(src.split('/').pop() ?? src);

export function PlaySoundBody({ n, set }: { n: Extract<LogicNode, { type: 'playSound' }>; set: (patch: Partial<LogicNode>, key?: string) => void }) {
  const sounds = useSounds();
  const outputs = useOutputs();
  const opts = n.sound && !sounds.some((s) => s.value === n.sound) ? [{ value: n.sound, label: fileName(n.sound) }, ...sounds] : sounds;
  return (
    <>
      <Dropdown value={n.sound} placeholder={t('Choose a sound')} options={opts} onChange={(sound) => set({ sound } as Partial<LogicNode>)} />
      <label className="lx-field">
        <span>{t('Volume')}</span>
        <NumberField value={n.volume ?? 0} min={-60} max={12} step={1} suffix="dB" onChange={(volume) => set({ volume } as Partial<LogicNode>, `snd-${n.id}-v`)} />
      </label>
      <label className="lx-field">
        <span>{t('Output')}</span>
        <Dropdown value={n.output ?? ''} options={outputs} onChange={(output) => set({ output: output || undefined } as Partial<LogicNode>)} />
      </label>
      <label className="lx-field">
        <span>{t('Loop')}</span>
        <Segmented
          value={n.loop ? 'yes' : 'no'}
          onChange={(x) => set({ loop: x === 'yes' || undefined } as Partial<LogicNode>)}
          options={[
            { value: 'no', label: t('No') },
            { value: 'yes', label: t('Yes') },
          ]}
        />
      </label>
    </>
  );
}

export function StopSoundBody({ n, set }: { n: Extract<LogicNode, { type: 'stopSound' }>; set: (patch: Partial<LogicNode>, key?: string) => void }) {
  const sounds = useSounds();
  const opts = [{ value: '', label: t('Every sound') }, ...(n.sound && !sounds.some((s) => s.value === n.sound) ? [{ value: n.sound, label: fileName(n.sound) }] : []), ...sounds];
  return <Dropdown value={n.sound} options={opts} onChange={(sound) => set({ sound } as Partial<LogicNode>)} />;
}
