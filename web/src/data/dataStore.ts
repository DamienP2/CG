import { useEffect, useState } from 'react';
import { create } from 'zustand';
import type { Data, DataFilter, DataSourceInfo, DataStatus, Template } from '../engine/types';
import { api } from '../store';

/** Data sources, their status (pushed live) and a version per source. */
interface DataState {
  sources: DataSourceInfo[];
  loaded: boolean;
  /** Bumped when a source's value changes, to refresh lookups. */
  versions: Record<string, number>;
  load: () => Promise<void>;
  onStatus: (id: string, status: DataStatus) => void;
}

export const useData = create<DataState>((set, get) => ({
  sources: [],
  loaded: false,
  versions: {},
  async load() {
    const sources = await api<DataSourceInfo[]>('GET', '/api/data/sources');
    set({ sources, loaded: true });
  },
  onStatus(id, status) {
    const prev = get().sources.find((s) => s.id === id);
    const changed = prev?.updatedAt !== status.updatedAt;
    set({
      sources: get().sources.map((s) => (s.id === id ? { ...s, ...status } : s)),
      versions: changed ? { ...get().versions, [id]: (get().versions[id] ?? 0) + 1 } : get().versions,
    });
    if (!prev) void get().load();
  },
}));

/** Sources, loaded on first use. */
export function useSources() {
  const { sources, loaded, load } = useData();
  useEffect(() => {
    if (!loaded) void load().catch(() => {});
  }, [loaded, load]);
  return sources;
}

export async function lookup(source: string, path: string, data: Data, filters?: DataFilter[]): Promise<string | null> {
  try {
    const r = await api<{ value: string | null }>('POST', '/api/data/lookup', { source, path, data, filters: filters ?? [] });
    return r.value;
  } catch {
    return null;
  }
}

/**
 * `data` with the template's bound fields filled from their sources, like the
 * server does on air (previews in the designer and the operator).
 */
export function useBoundData(template: Template | null | undefined, data: Data): Data {
  const versions = useData((s) => s.versions);
  const bound = template?.fields.filter((f) => f.binding?.source && f.binding.path) ?? [];
  const key = JSON.stringify([bound.map((f) => [f.key, f.binding]), data, bound.map((f) => versions[f.binding!.source] ?? 0)]);
  const [values, setValues] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!bound.length) {
      setValues({});
      return;
    }
    let live = true;
    const h = setTimeout(async () => {
      const out: Record<string, string> = {};
      await Promise.all(
        bound.map(async (f) => {
          const v = await lookup(f.binding!.source, f.binding!.path, data, f.binding!.filters);
          if (v !== null) out[f.key] = v;
        }),
      );
      if (live) setValues(out);
    }, 150);
    return () => {
      live = false;
      clearTimeout(h);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return Object.keys(values).length ? { ...data, ...values } : data;
}
