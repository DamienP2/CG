import { create } from 'zustand';
import type { LogicFlow } from './engine/types';
import { api, changeEvents, useApp } from './store';

/* Library › Logic: the flows of logic shared by every project, and the open project's own. */

interface Flows {
  shared: LogicFlow[];
  loaded: boolean;
  load: () => Promise<void>;
  /** Saves the shared flows. */
  saveShared: (flows: LogicFlow[]) => Promise<boolean>;
  /** Saves a project's own flows. */
  saveProject: (projectId: string, flows: LogicFlow[]) => Promise<boolean>;
}

export const useLogicFlows = create<Flows>((set, get) => ({
  shared: [],
  loaded: false,
  async load() {
    try {
      set({ shared: await api<LogicFlow[]>('GET', '/api/logic-flows'), loaded: true });
    } catch {
      set({ loaded: true });
    }
  },
  async saveShared(flows) {
    const before = get().shared;
    set({ shared: flows });
    try {
      await api('PUT', '/api/logic-flows', flows);
      return true;
    } catch (e) {
      set({ shared: before });
      useApp.getState().toast((e as Error).message, 'error');
      return false;
    }
  },
  async saveProject(projectId, flows) {
    try {
      await api('PUT', `/api/projects/${projectId}/logic-flows`, { flows });
      return true;
    } catch (e) {
      useApp.getState().toast((e as Error).message, 'error');
      return false;
    }
  },
}));

// Changed elsewhere (another page, another user): read again.
changeEvents.addEventListener('logic-flows', () => void useLogicFlows.getState().load());
