import { create } from 'zustand';
import type { Layer, WidgetDef, WidgetDraft } from './engine/types';
import { api, changeEvents, useApp } from './store';

/*
 * Library › Widgets: the widgets built with the Builder that every project shares (crates/cg-server
 * widgets.rs), next to each project's own (`project.widgets`).
 */

/** The widgets of a project the user sees (the Widget Builder's gallery). */
export interface ProjectWidgets {
  id: string;
  name: string;
  widgets: WidgetDef[];
  /** Widget id → the number of the project's templates using it. */
  uses: Record<string, number>;
  canEdit: boolean;
}

interface Widgets {
  shared: WidgetDef[];
  /** Widget id → the number of projects using it. */
  uses: Record<string, number>;
  projects: ProjectWidgets[];
  loaded: boolean;
  load: () => Promise<void>;
  /** Saves a shared widget (a new version). */
  saveShared: (def: WidgetDef) => Promise<boolean>;
  removeShared: (id: string) => Promise<boolean>;
}

export const useWidgets = create<Widgets>((set, get) => ({
  shared: [],
  uses: {},
  projects: [],
  loaded: false,
  async load() {
    try {
      const r = await api<{ widgets: WidgetDef[]; uses: Record<string, number>; projects?: ProjectWidgets[] }>('GET', '/api/widgets');
      set({ shared: r.widgets, uses: r.uses, projects: r.projects ?? [], loaded: true });
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

/** A widget by its id: the open project's, else a shared one, else another project's (the gallery). */
export function findDef(id: string): WidgetDef | undefined {
  return (
    useApp.getState().project?.widgets?.find((d) => d.id === id) ??
    useWidgets.getState().shared.find((d) => d.id === id) ??
    useWidgets
      .getState()
      .projects.flatMap((p) => p.widgets)
      .find((d) => d.id === id)
  );
}

/** The widget is the project's own (not shared). */
export const isProjectWidget = (id: string) => !!useApp.getState().project?.widgets?.some((d) => d.id === id);

/** Where a widget is kept: the shared ones, or a project's own. */
export type WidgetHome = 'shared' | 'project' | { project: string };

/** The project keeping the widget `id` (none: shared, or unknown). */
export function projectOf(id: string): string | undefined {
  if (isProjectWidget(id)) return useApp.getState().projectId ?? undefined;
  return useWidgets.getState().projects.find((p) => p.widgets.some((d) => d.id === id))?.id;
}

/** Saves a widget where it is kept (the project's own, else the shared ones), as it is: its version stays. */
export async function saveDef(def: WidgetDef, where?: WidgetHome): Promise<boolean> {
  const next = { ...def, at: Date.now() };
  const home = where ?? (isProjectWidget(def.id) ? 'project' : (projectOf(def.id) ? { project: projectOf(def.id)! } : 'shared'));
  if (home === 'shared') return useWidgets.getState().saveShared(next);
  const pid = home === 'project' ? undefined : home.project;
  const ok = await useApp.getState().saveWidget(next, pid);
  // The gallery's list of the project's widgets.
  if (ok)
    useWidgets.setState((st) => ({ projects: st.projects.map((p) => (p.id === (pid ?? useApp.getState().projectId) ? { ...p, widgets: [...p.widgets.filter((d) => d.id !== next.id), next] } : p)) }));
  return ok;
}

// ------------------------------------------------------------------ drafts and versions

/** The part of a widget its Builder edits. */
export function draftOf(def: WidgetDef): WidgetDraft {
  const { id: _id, rev: _rev, draft: _draft, at: _at, ...rest } = def;
  return rest;
}

/** The widget as its Builder edits it: its draft over what is published. */
export function workingCopy(def: WidgetDef): WidgetDef {
  return def.draft ? { ...def, ...def.draft, id: def.id, rev: def.rev, draft: def.draft } : def;
}

/** JSON with its keys in order (two drafts compared). */
export function canon(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  if (v && typeof v === 'object')
    return `{${Object.keys(v)
      .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canon((v as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  return JSON.stringify(v);
}

/** The widget was never published: templates cannot use it yet. */
export const neverPublished = (def: WidgetDef) => !(def.rev ?? 0) && !def.layers.length;

/** Keeps the Builder's work as the widget's draft (what is published does not change). */
export function saveDraft(def: WidgetDef, draft: WidgetDraft, where?: WidgetHome): Promise<boolean> {
  return saveDef({ ...def, draft }, where);
}

/** Publishes the widget's draft: its version goes up, its templates get it (the open project's at once, the others' when they open). */
export async function publishDef(def: WidgetDef, where?: WidgetHome): Promise<WidgetDef | null> {
  const next: WidgetDef = { ...def, ...(def.draft ?? {}), id: def.id, rev: (def.rev ?? 0) + 1, draft: undefined };
  return (await saveDef(next, where)) ? next : null;
}

/** A version kept by the server (crates/cg-server/src/widgets.rs). */
export interface WidgetVersion {
  rev: number;
  /** Unix ms (0: before versions were kept). */
  at: number;
  by: string;
  def?: WidgetDef;
}

export const listVersions = (id: string) => api<WidgetVersion[]>('GET', `/api/widgets/${encodeURIComponent(id)}/versions`);
export const getVersion = (id: string, rev: number) => api<WidgetVersion>('GET', `/api/widgets/${encodeURIComponent(id)}/versions/${rev}`);

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
