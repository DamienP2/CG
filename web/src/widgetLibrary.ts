import { create } from 'zustand';
import type { Layer, WidgetDef } from './engine/types';
import { api, changeEvents, useApp } from './store';

/*
 * Library › Widgets: the widgets built with the Builder that every project shares (crates/cg-server
 * widgets.rs), next to each project's own (`project.widgets`).
 */

interface Widgets {
  shared: WidgetDef[];
  /** Widget id → the number of projects using it. */
  uses: Record<string, number>;
  loaded: boolean;
  load: () => Promise<void>;
  /** Saves a shared widget (a new version). */
  saveShared: (def: WidgetDef) => Promise<boolean>;
  removeShared: (id: string) => Promise<boolean>;
}

export const useWidgets = create<Widgets>((set, get) => ({
  shared: [],
  uses: {},
  loaded: false,
  async load() {
    try {
      const r = await api<{ widgets: WidgetDef[]; uses: Record<string, number> }>('GET', '/api/widgets');
      set({ shared: r.widgets, uses: r.uses, loaded: true });
    } catch {
      set({ loaded: true });
    }
  },
  async saveShared(def) {
    const before = get().shared;
    set({ shared: [...before.filter((d) => d.id !== def.id), def] });
    try {
      await api('PUT', `/api/widgets/${encodeURIComponent(def.id)}`, def);
      return true;
    } catch (e) {
      set({ shared: before });
      useApp.getState().toast((e as Error).message, 'error');
      return false;
    }
  },
  async removeShared(id) {
    try {
      await api('DELETE', `/api/widgets/${encodeURIComponent(id)}`);
      set({ shared: get().shared.filter((d) => d.id !== id) });
      return true;
    } catch (e) {
      useApp.getState().toast((e as Error).message, 'error');
      return false;
    }
  },
}));

// Changed elsewhere (another page, another user): read again.
changeEvents.addEventListener('widgets', () => void useWidgets.getState().load());

/** The project where the Builder of a shared widget opens from the main page (in no list). */
export const HOST_PROJECT = 'widgets';

/** Opens (makes at first use) the project shared widgets are built in. */
export const hostProject = () => api<{ id: string }>('POST', '/api/widgets/host').then((r) => r.id);

/** A widget by its id: the open project's, else a shared one. */
export function findDef(id: string): WidgetDef | undefined {
  return useApp.getState().project?.widgets?.find((d) => d.id === id) ?? useWidgets.getState().shared.find((d) => d.id === id);
}

/** The widget is the project's own (not shared). */
export const isProjectWidget = (id: string) => !!useApp.getState().project?.widgets?.some((d) => d.id === id);

/** Saves a widget where it is kept: the project's own, else the shared ones. Its version goes up. */
export async function saveDef(def: WidgetDef, where?: 'project' | 'shared'): Promise<boolean> {
  const next = { ...def, rev: (def.rev ?? 0) + 1 };
  const shared = where ? where === 'shared' : !isProjectWidget(def.id);
  return shared ? useWidgets.getState().saveShared(next) : useApp.getState().saveWidget(next);
}

/** The widget used by this layer (a placed widget's folder). */
export function useDefOf(layer: Layer | undefined): WidgetDef | undefined {
  const id = layer?.widget?.def;
  const own = useApp((s) => (id ? s.project?.widgets?.find((d) => d.id === id) : undefined));
  const shared = useWidgets((s) => (id ? s.shared.find((d) => d.id === id) : undefined));
  return own ?? shared;
}

/** Moves the open project's widget `id` to the shared ones (its templates keep it). */
export async function shareWidget(id: string): Promise<boolean> {
  const pid = useApp.getState().projectId;
  if (!pid) return false;
  try {
    await api('POST', `/api/projects/${encodeURIComponent(pid)}/widgets/${encodeURIComponent(id)}/share`);
    await useWidgets.getState().load();
    return true;
  } catch (e) {
    useApp.getState().toast((e as Error).message, 'error');
    return false;
  }
}
