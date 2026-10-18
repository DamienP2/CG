import { useEffect, useState } from 'react';
import { create } from 'zustand';
import type { Data, DataFilter, DataSort, DataSourceInfo, DataStatus, DataStep, FieldBinding, Template } from '../engine/types';
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

export async function lookup(source: string, path: string, data: Data, filters?: DataFilter[], sort?: DataSort): Promise<string | null> {
  try {
    const r = await api<{ value: string | null }>('POST', '/api/data/lookup', { source, path, data, filters: filters ?? [], sort: sort?.by ? sort : undefined });
    return r.value;
  } catch {
    return null;
  }
}

/** A table: the source's rows, or the rows after a step. */
export interface Stage {
  columns: string[];
  rows: string[][];
  /** Rows before the cut to 200. */
  total: number;
}

/** Runs a table pipeline on a source's value: the table at each stage, and the text it gives. */
export async function pipeline(source: string, list: string, steps: DataStep[], data: Data): Promise<{ stages: Stage[]; text: string } | null> {
  try {
    return await api('POST', '/api/data/pipeline', { source, list, steps, data });
  } catch {
    return null;
  }
}

/** A table binding (list and steps), else a path. */
export const isTable = (b: FieldBinding) => b.list !== undefined || !!b.steps?.length;

/** A short description of where a binding reads. */
export const bindingLabel = (b: FieldBinding) => (isTable(b) ? `${b.list || 'root'}${b.steps?.length ? ` · ${b.steps.length} step${b.steps.length > 1 ? 's' : ''}` : ''}` : b.path || '(no path)');

/** What a binding gives now. */
export async function readBinding(b: FieldBinding, data: Data): Promise<string | null> {
  if (isTable(b)) return (await pipeline(b.source, b.list ?? '', b.steps ?? [], data))?.text ?? null;
  return lookup(b.source, b.path, data, b.filters, b.sort);
}

/**
 * `data` with the template's bound fields filled from their sources, like the
 * server does on air (previews in the designer and the operator).
 */
export function useBoundData(template: Template | null | undefined, data: Data): Data {
  const versions = useData((s) => s.versions);
  const bound = template?.fields.filter((f) => f.binding?.source && (f.binding.path || isTable(f.binding))) ?? [];
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
          const v = await readBinding(f.binding!, data);
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
