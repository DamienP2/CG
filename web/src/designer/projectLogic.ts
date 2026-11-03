import { create } from 'zustand';
import { api, useApp } from '../store';
import type { Logic, Project, Template } from '../engine/types';
import { newTemplate } from './designerStore';
import { PROJECT_LOGIC } from './logicNodes';
import { t } from '../i18n';

/**
 * The project's Logic in the Logic canvas: a stand-in template (no layers)
 * whose logic is the project's, edited like a graphic's and saved to the
 * project (PUT /logic) a moment after each change.
 */
interface ProjectLogicStore {
  template: Template | null;
  frame: number;
  previewData: Record<string, string>;
  lastCoalesce: null;
  open: (p: Project) => void;
  update: (recipe: (t: Template) => void, coalesceKey?: string) => void;
}

let timer: ReturnType<typeof setTimeout> | undefined;

function save(projectId: string, logic: Logic) {
  // The project as the app knows it follows at once (palettes, names).
  useApp.setState((s) => (s.project?.id === projectId ? { project: { ...s.project, logic } } : {}));
  clearTimeout(timer);
  timer = setTimeout(() => {
    api('PUT', `/api/projects/${encodeURIComponent(projectId)}/logic`, logic).catch((e) => useApp.getState().toast(t('Save failed: {error}', { error: (e as Error).message }), 'error'));
  }, 400);
}

export const useProjectLogic = create<ProjectLogicStore>((set, get) => ({
  template: null,
  frame: 0,
  previewData: {},
  lastCoalesce: null,
  open(p) {
    const tpl = newTemplate(p.name, '');
    tpl.id = PROJECT_LOGIC;
    tpl.layers = [];
    tpl.logic = structuredClone(p.logic ?? { nodes: [], edges: [] });
    set({ template: tpl });
  },
  update(recipe) {
    const cur = get().template;
    const projectId = useApp.getState().project?.id;
    if (!cur || !projectId) return;
    const next = structuredClone(cur);
    recipe(next);
    set({ template: next });
    save(projectId, next.logic ?? { nodes: [], edges: [] });
  },
}));
